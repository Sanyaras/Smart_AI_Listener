// amo.js — Smart AI Listener / AmoCRM integration
// Версия: 2.8.0 (fresh-only cursors + robust link parser + soft mode + safe seen + stable OAuth)

// --- deps
import { fetchWithTimeout, mask } from "./utils.js";
import { sendTG, tgRelayAudio } from "./telegram.js";
import { enqueueAsr, transcribeAudioFromUrl } from "./asr.js";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";
import {
  isAlreadyProcessed,
  markProcessed,
  markSeenOnly,
  getSecret,
  setSecret
} from "./supabaseStore.js";

/* ==================== ENV ==================== */
const AMO_BASE_URL       = (process.env.AMO_BASE_URL || "").replace(/\/+$/,"");
const AMO_CLIENT_ID      = process.env.AMO_CLIENT_ID || "";
const AMO_CLIENT_SECRET  = process.env.AMO_CLIENT_SECRET || "";
const AMO_REDIRECT_URI   = process.env.AMO_REDIRECT_URI || "";
const AMO_AUTH_CODE      = process.env.AMO_AUTH_CODE || "";
let   AMO_ACCESS_TOKEN   = process.env.AMO_ACCESS_TOKEN || "";
let   AMO_REFRESH_TOKEN  = process.env.AMO_REFRESH_TOKEN || "";

// Сколько часов считаем «свежими» звонки; 0 — без ограничения
const IGNORE_OLDER_HOURS = parseInt(process.env.AMO_IGNORE_OLDER_HOURS || "3", 10);
const IGNORE_MS = IGNORE_OLDER_HOURS > 0 ? IGNORE_OLDER_HOURS * 60 * 60 * 1000 : 0;

// Часовой пояс для человекочитаемой даты
const AMO_TIMEZONE = process.env.AMO_TIMEZONE || "Europe/Moscow";

// Debug-дампы для заметок без ссылок
const AMO_DEBUG_DUMP = (process.env.AMO_DEBUG_DUMP || "0") === "1";

/* ==================== TOKENS store (Supabase app_secrets) ==================== */
const SECRET_KEY_ACCESS  = "amo_access_token";
const SECRET_KEY_REFRESH = "amo_refresh_token";

let TOKENS_LOADED_ONCE = false;

async function loadTokensFromStoreIfNeeded() {
  if (TOKENS_LOADED_ONCE) return;

  // основной источник правды — app_secrets
  let acc = await getSecret(SECRET_KEY_ACCESS);
  let ref = await getSecret(SECRET_KEY_REFRESH);

  // обратная совместимость со старыми ключами
  if (!acc) acc = await getSecret("AMO_ACCESS_TOKEN");
  if (!ref) ref = await getSecret("AMO_REFRESH_TOKEN");

  if (!AMO_ACCESS_TOKEN && acc) AMO_ACCESS_TOKEN = acc;
  if (!AMO_REFRESH_TOKEN && ref) AMO_REFRESH_TOKEN = ref;

  TOKENS_LOADED_ONCE = true;
}

async function persistTokens(access, refresh) {
  if (access) {
    AMO_ACCESS_TOKEN = access;
    await setSecret(SECRET_KEY_ACCESS, access);
    await setSecret("AMO_ACCESS_TOKEN", access); // бэкап
  }
  if (refresh) {
    AMO_REFRESH_TOKEN = refresh;
    await setSecret(SECRET_KEY_REFRESH, refresh);
    await setSecret("AMO_REFRESH_TOKEN", refresh); // бэкап
  }
}

/** Публичная точка для индекса — «подлить» токены (из OAuth callback) и сохранить их. */
export function injectAmoTokens(access, refresh) {
  return persistTokens(access, refresh);
}

export function getAmoTokensMask() {
  return {
    access: AMO_ACCESS_TOKEN ? mask(AMO_ACCESS_TOKEN) : "",
    refresh: AMO_REFRESH_TOKEN ? mask(AMO_REFRESH_TOKEN) : ""
  };
}

/* ==================== OAuth/FETCH ==================== */
function ensureAmoEnv() {
  if (!AMO_BASE_URL || !AMO_CLIENT_ID || !AMO_CLIENT_SECRET || !AMO_REDIRECT_URI) {
    throw new Error("AMO_* env incomplete");
  }
}

async function amoOAuth(body) {
  ensureAmoEnv();
  const url = `${AMO_BASE_URL}/oauth2/access_token`;
  const resp = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: AMO_CLIENT_ID,
        client_secret: AMO_CLIENT_SECRET,
        redirect_uri: AMO_REDIRECT_URI,
        ...body
      })
    },
    20000
  );
  if (!resp.ok) throw new Error(`amo oauth ${resp.status}: ${await resp.text().catch(()=> "")}`);
  return await resp.json();
}

export async function amoExchangeCode() {
  if (!AMO_AUTH_CODE) throw new Error("AMO_AUTH_CODE missing");
  const j = await amoOAuth({ grant_type: "authorization_code", code: AMO_AUTH_CODE });
  await persistTokens(j.access_token || "", j.refresh_token || "");
  return j;
}

let amoRefreshPromise = null;
export async function amoRefresh() {
  await loadTokensFromStoreIfNeeded();
  if (!AMO_REFRESH_TOKEN) throw new Error("AMO_REFRESH_TOKEN missing");
  if (amoRefreshPromise) return amoRefreshPromise;
  amoRefreshPromise = (async () => {
    try {
      const j = await amoOAuth({ grant_type: "refresh_token", refresh_token: AMO_REFRESH_TOKEN });
      await persistTokens(j.access_token || "", j.refresh_token || "");
      return j;
    } finally {
      amoRefreshPromise = null;
    }
  })();
  return amoRefreshPromise;
}

export async function amoFetch(path, opts = {}, ms = 15000) {
  ensureAmoEnv();
  await loadTokensFromStoreIfNeeded();

  if (!AMO_ACCESS_TOKEN) throw new Error("No AMO_ACCESS_TOKEN — do OAuth at /amo/oauth/start");

  const url = `${AMO_BASE_URL}${path}`;
  const doFetch = (token) =>
    fetchWithTimeout(
      url,
      { ...opts, headers: { "authorization": `Bearer ${token}`, "content-type":"application/json", ...(opts.headers||{}) } },
      ms
    );

  // первая попытка
  let r = await doFetch(AMO_ACCESS_TOKEN);
  if (r.status === 401) {
    // пробуем рефреш
    try {
      await amoRefresh();
    } catch (e) {
      const body = await r.text().catch(()=> "");
      throw new Error(`amo ${path} 401 and refresh failed: ${body || e?.message || e}`);
    }
    // вторая попытка уже с новым access
    r = await doFetch(AMO_ACCESS_TOKEN);
  }

  if (r.status === 204) return { _embedded: { notes: [] } };
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`amo ${path} ${r.status}: ${t}`);
  }
  return await r.json();
}

/* ==================== Incremental fresh scan ==================== */
/**
 * Ключи курсоров по сущностям.
 * Храним последний обработанный created_at (секунды UNIX).
 */
const CURSOR_KEYS = {
  lead:    "amo_cursor_lead_notes_created_at",
  contact: "amo_cursor_contact_notes_created_at",
  company: "amo_cursor_company_notes_created_at",
};

async function getCursor(entity){
  const raw = await getSecret(CURSOR_KEYS[entity]);
  const v = parseInt(raw || "0", 10);
  return Number.isFinite(v) ? v : 0;
}
async function setCursor(entity, sec){
  if (!sec || !Number.isFinite(sec)) return;
  await setSecret(CURSOR_KEYS[entity], String(sec));
}

/**
 * Тянем страницы с конца, но останавливаемся, когда достигли уже виденного created_at.
 *
 * @param {"lead"|"contact"|"company"} entity
 * @param {string} pathBase  - например "/api/v4/leads/notes"
 * @param {number} perPage
 * @param {number} maxPagesBack
 * @param {number} sinceCreatedAtSec
 * @returns {Array<object>} — элементы с created_at > cursor, по убыванию created_at
 */
async function fetchNotesSinceCursor(entity, pathBase, perPage, maxPagesBack, sinceCreatedAtSec){
  // узнаём последнюю страницу
  const first = await amoFetch(`${pathBase}?limit=${perPage}&page=1`);
  let lastPage = 1;
  const lastHref = first?._links?.last?.href;
  if (lastHref) {
    const m = String(lastHref).match(/(?:\?|&)page=(\d+)/i);
    if (m) lastPage = parseInt(m[1], 10) || 1;
  }

  const collected = [];
  const startPage = Math.max(1, lastPage - maxPagesBack + 1);

  outer:
  for (let page = lastPage; page >= startPage; page--) {
    const j = await amoFetch(`${pathBase}?limit=${perPage}&page=${page}`);
    const arr = Array.isArray(j?._embedded?.notes) ? j._embedded.notes : [];
    if (!arr.length) break;

    for (const n of arr) {
      const ca = parseInt(n?.created_at || 0, 10) || 0;
      if (sinceCreatedAtSec && ca <= sinceCreatedAtSec) {
        break outer;
      }
      collected.push(n);
    }
  }

  collected.sort((a,b) => (b.created_at||0) - (a.created_at||0));
  return collected;
}

/* ==================== USERS ==================== */
const AMO_USER_CACHE = new Map();
let AMO_USER_CACHE_TS = 0;

async function amoGetUsersMap() {
  const NOW = Date.now();
  if (NOW - AMO_USER_CACHE_TS < 10 * 60 * 1000 && AMO_USER_CACHE.size > 0) {
    return AMO_USER_CACHE;
  }
  const data = await amoFetch("/api/v4/users?limit=250");
  const arr = data?._embedded?.users || [];
  AMO_USER_CACHE.clear();
  for (const u of arr) {
    AMO_USER_CACHE.set(u.id, {
      name: (
        [u.name, u.last_name, u.first_name, u.middle_name]
          .filter(Boolean).join(" ").trim()
      ) || u.name || `user#${u.id}`
    });
  }
  AMO_USER_CACHE_TS = NOW;
  return AMO_USER_CACHE;
}

async function amoGetResponsible(entity, entityId) {
  try {
    let path = "";
    if (entity === "lead")        path = `/api/v4/leads/${entityId}`;
    else if (entity === "contact") path = `/api/v4/contacts/${entityId}`;
    else if (entity === "company") path = `/api/v4/companies/${entityId}`;
    else return { userId: null, userName: null };

    const card = await amoFetch(path);
    const respId = card.responsible_user_id || card.responsible_user || null;

    if (!respId) return { userId: null, userName: null };
    const usersMap = await amoGetUsersMap();
    const u = usersMap.get(respId);
    return { userId: respId, userName: u ? u.name : `user#${respId}` };
  } catch (e) {
    console.warn("amoGetResponsible error:", e?.message || e);
    return { userId: null, userName: null };
  }
}

/* ==================== Link parser ==================== */
function isCallNote(note) {
  const t = String(note?.note_type || "").toLowerCase();
  return t === "call_in" || t === "call_out";
}

function findRecordingLinksInNote(note) {
  const urls = new Set();
  const urlRe = /https?:\/\/[^\s"'<>]+/ig;

  // домены телефонии/CDN, где частo лежат записи без «говорящих» слов
  const TELEPHONY_HOSTS = [
    "megapbx.ru","mango-office.ru","uiscom.ru","uiscom.net",
    "yandexcloud.net","storage.yandexcloud.net","s3.amazonaws.com",
    "voximplant.com","sipuni.com","binotel.ua","zaddarma.com","zadarma.com"
  ];

  // общий сборщик строк
  const pushFromText = (txt) => {
    if (!txt) return;
    const m = String(txt).match(urlRe);
    if (m) m.forEach(u => urls.add(u));
  };
  const collectFromObj = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        pushFromText(v);
      } else if (Array.isArray(v)) {
        v.forEach(collectFromObj);
      } else if (typeof v === "object") {
        collectFromObj(v);
      }
    }
  };

  if (note?.text) pushFromText(note.text);
  if (note?.params) collectFromObj(note.params);

  // Явные поля Amo, которые часто содержат прямые URL
  const p = note?.params || {};
  const directCandidates = [];

  const maybePush = (v) => { if (v && typeof v === "string" && /^https?:\/\//i.test(v)) directCandidates.push(v); };
  const fromArray = (arr, keys) => {
    if (!Array.isArray(arr)) return;
    for (const it of arr) {
      for (const k of keys) {
        if (it && typeof it === "object" && typeof it[k] === "string" && /^https?:\/\//i.test(it[k])) {
          directCandidates.push(it[k]);
        }
      }
    }
  };

  // Популярные поля
  maybePush(p.file);
  maybePush(p.url);
  maybePush(p.download_link);
  maybePush(p.file_url);
  maybePush(p.record_url);
  fromArray(p.files, ["url","download_link","file_url"]);
  fromArray(p.attachments, ["url","download_link","file_url"]);
  fromArray(p.links, ["url"]);

  directCandidates.forEach(u => urls.add(u));

  // Нормальная фильтрация
  const candidates = Array.from(urls);
  let filtered = candidates.filter(u => {
    // явные аудио-расширения
    if (/\.(mp3|wav|ogg|m4a|opus)(\?|$)/i.test(u)) return true;
    // отбрасываем картинки
    if (/\.(svg|png|jpg|jpeg|gif|webp)(\?|$)/i.test(u)) return false;
    // ключевые слова
    if (/(record|recording|audio|call|voice|download|file|storage|rec)/i.test(u)) return true;
    // домены телефонии/CDN
    try {
      const host = new URL(u).hostname.replace(/^www\./,'');
      if (TELEPHONY_HOSTS.some(h => host.endsWith(h))) return true;
    } catch {}
    return false;
  });

  // «Мягкий режим»: это звонок с длительностью ≥5 c, но фильтр ничего не нашёл —
  // берём любые https-ссылки, кроме картинок и карточек Amo.
  const durationSec = parseInt(p?.duration || 0, 10) || 0;
  if (filtered.length === 0 && isCallNote(note) && durationSec >= 5) {
    filtered = candidates.filter(u => {
      if (!/^https:\/\//i.test(u)) return false;
      if (/\.(svg|png|jpg|jpeg|gif|webp)(\?|$)/i.test(u)) return false;
      // не тащим ссылки на карточки сущностей Amo
      try {
        const urlObj = new URL(u);
        const path = urlObj.pathname || "";
        if (/\/(leads|contacts|companies)\/detail\/\d+/.test(path)) return false;
      } catch {}
      return true;
    });
  }

  return Array.from(new Set(filtered));
}

/* ==================== Helpers ==================== */
function humanDate(ms) {
  if (!ms || Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString("ru-RU", {
    timeZone: AMO_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}
function pad2(n){ return String(n).padStart(2,"0"); }
function fmtDuration(sec=0){
  const s = Math.max(0, parseInt(sec,10) || 0);
  const m = Math.floor(s/60), r = s%60;
  return `${m}:${pad2(r)}`;
}
function entityCardUrl(entity, id){
  if (!id) return "";
  if (entity === "lead")     return `${AMO_BASE_URL}/leads/detail/${id}`;
  if (entity === "contact")  return `${AMO_BASE_URL}/contacts/detail/${id}`;
  if (entity === "company")  return `${AMO_BASE_URL}/companies/detail/${id}`;
  return `${AMO_BASE_URL}`;
}

/* ==================== Main ==================== */
/**
 * Сканирует заметки (lead/contact/company) **инкрементально**:
 * - тянем только то, что новее сохранённого курсора created_at;
 * - берём страницы от конца, но останавливаемся при достижении курсора;
 * - вытаскиваем аудиоссылки, шлём отчёт в TG, делаем ASR+QA;
 *
 * @param {number} perEntityLimit - limit/страница (до 250)
 * @param {number} maxNewToProcessThisTick - защитный максимум новых за тик
 */
export async function processAmoCallNotes(perEntityLimit = 100, maxNewToProcessThisTick = Infinity) {
  // читаем курсоры
  const [leadCursor, contactCursor, companyCursor] = await Promise.all([
    getCursor("lead"),
    getCursor("contact"),
    getCursor("company")
  ]);

  // Тянем только свежее курсора (и ограничиваем глубину страниц)
  const [leadNotes, contactNotes, companyNotes] = await Promise.all([
    fetchNotesSinceCursor("lead",    "/api/v4/leads/notes",     perEntityLimit, 6, leadCursor),
    fetchNotesSinceCursor("contact", "/api/v4/contacts/notes",  perEntityLimit, 4, contactCursor),
    fetchNotesSinceCursor("company", "/api/v4/companies/notes", perEntityLimit, 2, companyCursor),
  ]);

  // Собираем унифицированный список
  const picked = [];
  const pack = (entity, items) => {
    for (const n of items) {
      picked.push({
        entity,
        note_id: n.id,
        note_type: n.note_type,
        created_at: n.created_at,          // unix (sec)
        entity_id: n.entity_id,
        text: n.text || n.params?.text || "",
        params: n.params || n.payload || n.data || {}
      });
    }
  };
  pack("lead", leadNotes);
  pack("contact", contactNotes);
  pack("company", companyNotes);

  // финально сортируем по убыванию created_at (самые свежие первыми)
  picked.sort((a,b) => (b.created_at||0) - (a.created_at||0));

  const now = Date.now();
  let started = 0, skipped = 0, withLinks = 0, ignored = 0;

  // двигаем курсоры по факту «увиденных» заметок (даже если без ссылок)
  let maxLeadCA = leadCursor;
  let maxContactCA = contactCursor;
  let maxCompanyCA = companyCursor;

  for (const note of picked) {
    const source_type = "amo_note";
    const source_id = String(note.note_id);

    // свежесть по часам
    const createdMs = (note.created_at || 0) * 1000;
    if (IGNORE_MS > 0 && (now - createdMs) > IGNORE_MS) {
      // фиксируем как увиденную, но без URL — кладём "-"
      try { await markSeenOnly(source_type, source_id, "-"); } catch {}
      ignored++;
      // курсор двигаем, чтобы не возвращаться
      const ca = note.created_at || 0;
      if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
      if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
      if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
      continue;
    }

    // антидубль
    const already = await isAlreadyProcessed(source_type, source_id);
    if (already) {
      skipped++;
      // но курсор двигаем — мы уже это «прошли»
      const ca = note.created_at || 0;
      if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
      if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
      if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
      continue;
    }

    if (started >= maxNewToProcessThisTick) break;

    // линки записи
    const links = findRecordingLinksInNote(note);
    if (!links.length) {
      // лог-дамп для отладки по требованию
      if (AMO_DEBUG_DUMP) {
        try {
          await sendTG(
            [
              "🧪 <b>AMO DEBUG</b> — ссылка не найдена, показываю params/text",
              `📌 entity: ${note.entity} • id: ${note.entity_id} • note_id: ${note.note_id}`,
              note.text ? `📝 <b>text:</b> <code>${mask(note.text).slice(0, 800)}</code>` : "📝 text: —",
              `<b>params.keys:</b> <code>${Object.keys(note.params||{}).join(", ")}</code>`
            ].join("\n")
          );
        } catch {}
      }
      // помечаем как увиденную, чтобы не возвращаться
      try { await markSeenOnly(source_type, source_id, "-"); } catch {}
      skipped++;

      // курсор двигаем
      const ca = note.created_at || 0;
      if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
      if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
      if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
      continue;
    }
    withLinks++;

    // ответственный
    const respInfo   = await amoGetResponsible(note.entity, note.entity_id);
    const managerTxt = respInfo.userName || "неизвестно";

    // формат отчёта
    const durSec   = note?.params?.duration || 0;
    const phone    = note?.params?.phone || "—";
    const kindTxt  = note.note_type === "call_in" ? "📥 Входящий"
                   : note.note_type === "call_out" ? "📤 Исходящий"
                   : note.note_type || "—";
    const dealUrl  = entityCardUrl(note.entity, note.entity_id);
    const createdH = humanDate(createdMs);

    // пред-репорт в TG
    try {
      await sendTG(
        [
          "🎧 <b>Новый звонок из Amo</b>",
          `📅 <b>Время:</b> <code>${createdH}</code>`,
          `👤 <b>Менеджер:</b> ${managerTxt}`,
          `📞 <b>Телефон:</b> <code>${phone}</code>`,
          `⏱️ <b>Длительность:</b> ${fmtDuration(durSec)}`,
          `💬 <b>Тип:</b> ${kindTxt}`,
          dealUrl ? `🔗 <b>Карта:</b> <a href="${dealUrl}">${dealUrl}</a>` : null,
          links[0] ? `🔊 <b>Аудио:</b> <a href="${links[0]}">оригинал</a>` : null,
          note.text ? `📝 <b>Примечание:</b> ${note.text}` : null,
          `<i>note_id: ${note.note_id} • entity: ${note.entity} • entity_id: ${note.entity_id}</i>`
        ].filter(Boolean).join("\n")
      );
    } catch {}

    // прогоняем через relay (если получится), затем ASR
    for (const origUrl of links) {
      let relayCdnUrl = origUrl;
      try {
        relayCdnUrl = await tgRelayAudio(origUrl, `🎧 Аудио (${note.note_type}) • ${managerTxt}`);
      } catch {
        // оставляем как есть
      }

      const text = await enqueueAsr(() =>
        transcribeAudioFromUrl(relayCdnUrl, { callId: `amo-${note.note_id}` })
      );

      if (text) {
        // аналитика звонка (QA)
        const qa = await analyzeTranscript(text, {
          callId: `amo-${note.note_id}`,
          brand: process.env.CALL_QA_BRAND || "",
          manager: managerTxt,
          amo_entity: note.entity,
          amo_entity_id: note.entity_id,
          created_at: note.created_at || null,
          phone: phone || null,
          duration_sec: durSec || 0
        });

        try { await sendTG(formatQaForTelegram(qa)); } catch {}
        started++;
        try { await markProcessed(source_type, source_id, origUrl); } catch {}

        // двигаем курсор
        const ca = note.created_at || 0;
        if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
        if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
        if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
      } else {
        try { await sendTG("⚠️ ASR не удалось выполнить для ссылки из Amo."); } catch {}
        // даже в случае неудачи считаем элемент увиденным, двигаем курсор и отмечаем seen
        try { await markSeenOnly(source_type, source_id, origUrl || "-"); } catch {}
        const ca = note.created_at || 0;
        if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
        if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
        if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
      }
    }
  }

  // сохраняем обновлённые курсоры (только если увеличились)
  const cursorUpdates = [];
  if (maxLeadCA    > leadCursor)    cursorUpdates.push(setCursor("lead",    maxLeadCA));
  if (maxContactCA > contactCursor) cursorUpdates.push(setCursor("contact", maxContactCA));
  if (maxCompanyCA > companyCursor) cursorUpdates.push(setCursor("company", maxCompanyCA));
  if (cursorUpdates.length) await Promise.all(cursorUpdates);

  return {
    scanned: picked.length,
    withLinks,
    started,
    skipped,
    ignored,
    cursors: {
      lead_prev: leadCursor,    lead_next: maxLeadCA,
      contact_prev: contactCursor, contact_next: maxContactCA,
      company_prev: companyCursor, company_next: maxCompanyCA
    }
  };
}
