// amo.js — Smart AI Listener / AmoCRM integration
// Версия: 3.0.0 (reverse-scan, spam-queue, robust audio link parser, safe cursors)

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

// Сколько часов считаем «свежими» звонки. 0 — выкл (берём всё).
const IGNORE_OLDER_HOURS = parseInt(process.env.AMO_IGNORE_OLDER_HOURS || "0", 10);
const IGNORE_MS = IGNORE_OLDER_HOURS > 0 ? IGNORE_OLDER_HOURS * 60 * 60 * 1000 : 0;

// Управление сканом
const PER_ENTITY_LIMIT   = parseInt(process.env.AMO_PER_ENTITY_LIMIT || "100", 10);
const MAX_PAGES_BACK     = parseInt(process.env.AMO_MAX_PAGES_BACK || "6", 10); // для lead; контакт/компания ниже
const AMO_TIMEZONE       = process.env.AMO_TIMEZONE || "Europe/Moscow";
const AMO_DEBUG_DUMP     = (process.env.AMO_DEBUG_DUMP || "1") === "1";

// Динамические списки из ENV
const ENV_SPAM = String(process.env.AMO_SPAM_KEYWORDS || "").trim();
const SPAM_KEYWORDS = ENV_SPAM
  ? ENV_SPAM.split(",").map(s => s.trim()).filter(Boolean)
  : ["автоответ", "не отвечает", "ошибка", "системное", "service", "system", "ivr", "robot", "auto", "бот", "ботом", "тест"];

// Доверенные телефонийные/хранилищные домены (можно расширять через ENV)
const ENV_TRUST = String(process.env.AMO_TRUSTED_AUDIO_HOSTS || "").trim();
const TRUSTED_AUDIO_HOSTS = new Set([
  "megapbx.ru", "mega-pbx.ru", "mangotele.com", "mango-office.ru",
  "uiscom.ru", "uiscom.net", "sipuni.com", "binotel.ua",
  "zadarma.com", "zaddarma.com",
  "voximplant.com", "voximplant.net",
  "yandexcloud.net", "storage.yandexcloud.net",
  "amazonaws.com", "s3.amazonaws.com",
  "cloudfront.net", "backblazeb2.com"
].concat(
  ENV_TRUST ? ENV_TRUST.split(",").map(s => s.trim()).filter(Boolean) : []
));

/* ==================== TOKENS store (Supabase app_secrets) ==================== */
const SECRET_KEY_ACCESS  = "amo_access_token";
const SECRET_KEY_REFRESH = "amo_refresh_token";

let TOKENS_LOADED_ONCE = false;

async function loadTokensFromStoreIfNeeded() {
  if (TOKENS_LOADED_ONCE) return;
  let acc = await getSecret(SECRET_KEY_ACCESS);
  let ref = await getSecret(SECRET_KEY_REFRESH);
  if (!acc) acc = await getSecret("AMO_ACCESS_TOKEN"); // backward compat
  if (!ref) ref = await getSecret("AMO_REFRESH_TOKEN");
  if (!AMO_ACCESS_TOKEN && acc) AMO_ACCESS_TOKEN = acc;
  if (!AMO_REFRESH_TOKEN && ref) AMO_REFRESH_TOKEN = ref;
  TOKENS_LOADED_ONCE = true;
}

async function persistTokens(access, refresh) {
  if (access) {
    AMO_ACCESS_TOKEN = access;
    await setSecret(SECRET_KEY_ACCESS, access);
    await setSecret("AMO_ACCESS_TOKEN", access); // backup
  }
  if (refresh) {
    AMO_REFRESH_TOKEN = refresh;
    await setSecret(SECRET_KEY_REFRESH, refresh);
    await setSecret("AMO_REFRESH_TOKEN", refresh); // backup
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

  let r = await doFetch(AMO_ACCESS_TOKEN);
  if (r.status === 401) {
    try {
      await amoRefresh();
    } catch (e) {
      const body = await r.text().catch(()=> "");
      throw new Error(`amo ${path} 401 and refresh failed: ${body || e?.message || e}`);
    }
    r = await doFetch(AMO_ACCESS_TOKEN);
  }

  if (r.status === 204) return { _embedded: { notes: [] } };
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`amo ${path} ${r.status}: ${t}`);
  }
  return await r.json();
}

/* ==================== Incremental fresh scan (reverse) ==================== */
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

async function fetchNotesSinceCursor(entity, pathBase, perPage, maxPagesBack, sinceCreatedAtSec){
  // Вытаскиваем lastPage и сканируем НАЗАД
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

    // идём по странице с конца к началу (последняя — самая свежая)
    for (let i = arr.length - 1; i >= 0; i--) {
      const n = arr[i];
      const ca = parseInt(n?.created_at || 0, 10) || 0;
      if (sinceCreatedAtSec && ca <= sinceCreatedAtSec) break outer;
      collected.push(n);
    }
  }

  // свежие первые
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
  const data = await amoFetch(`/api/v4/users?limit=250`);
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
function findRecordingLinksInNote(note) {
  const urls = new Set();
  const urlRe = /https?:\/\/[^\s"'<>]+/ig;

  const pushFromText = (txt) => {
    if (!txt) return;
    const m = String(txt).match(urlRe);
    if (m) m.forEach(u => urls.add(u));
  };

  const collectFromObj = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [, v] of Object.entries(obj)) {
      if (typeof v === "string") pushFromText(v);
      else if (Array.isArray(v)) v.forEach(collectFromObj);
      else if (typeof v === "object") collectFromObj(v);
    }
  };

  // текст + params
  if (note?.text) pushFromText(note.text);
  if (note?.params) collectFromObj(note.params);

  // прямой link
  if (note?.params?.link && typeof note.params.link === "string") {
    if (note.params.link.startsWith("http")) urls.add(note.params.link);
  }
  if (note?.params?.link?.href && typeof note.params.link.href === "string") {
    if (note.params.link.href.startsWith("http")) urls.add(note.params.link.href);
  }

  const candidates = Array.from(urls);

  // фильтруем изображения/видео – оставляем аудио/подозрительно-аудио
  const filtered = candidates.filter(u => {
    if (/\.(svg|png|jpg|jpeg|gif|webp|mp4|mov|mkv|avi)(\?|$)/i.test(u)) return false;
    if (/\.(mp3|wav|ogg|m4a|opus|webm|aac)(\?|$)/i.test(u)) return true;

    // ключевые слова
    if (/(record|recording|audio|call|voice|download|file|storage|rec|voip|records)/i.test(u)) return true;

    // доверенные домены телефонии/CDN
    try {
      const host = new URL(u).hostname.toLowerCase().replace(/^www\./,'');
      if (TRUSTED_AUDIO_HOSTS.has(host) ||
          TRUSTED_AUDIO_HOSTS.has(host.split('.').slice(-2).join('.')) || // *.domain.tld
          /pbx|sip|voip|call|tele|mango/i.test(host)) {
        return true;
      }
    } catch {}

    return false;
  });

  // эвристика: call_* + duration>0 — пропускаем любые некартинные
  const isCall = /^call_/i.test(String(note?.note_type || ""));
  const durSec = parseInt(note?.params?.duration || 0, 10) || 0;
  if (isCall && durSec > 0) {
    const more = candidates.filter(u =>
      !/\.(svg|png|jpg|jpeg|gif|webp|mp4|mov|mkv|avi)(\?|$)/i.test(u)
    );
    more.forEach(u => filtered.push(u));
  }

  return Array.from(new Set(filtered));
}

/* ==================== Spam scoring ==================== */
function scoreSpam(note, links) {
  // Чем больше — тем более «спам/мусор». Всё, что >= 3 — считаем спамом и не транскрибируем.
  let score = 0;
  const reasons = [];

  const type = String(note?.note_type || "").toLowerCase();
  const durSec = parseInt(note?.params?.duration || 0, 10) || 0;
  const text = (note?.text || note?.params?.text || "").toString().toLowerCase();

  // 1) Не звонок или длительность 0 — частый шум
  if (!/^call_/.test(type)) { score += 2; reasons.push("not_a_call"); }
  if (durSec <= 0) { score += 2; reasons.push("zero_duration"); }

  // 2) Явные стоп-слова
  for (const token of SPAM_KEYWORDS) {
    if (token && text.includes(token.toLowerCase())) { score += 2; reasons.push(`kw:${token}`); break; }
  }

  // 3) Нет годных ссылок (а это call) — подозрительно
  if (/^call_/.test(type) && durSec > 0 && (!links || links.length === 0)) {
    score += 1; reasons.push("call_no_links");
  }

  // 4) Слишком короткое примечание
  if (text && text.length <= 3) { score += 1; reasons.push("too_short_note"); }

  // 5) Слишком много ссылок (подозрительная разметка)
  if (links && links.length > 4) { score += 1; reasons.push("too_many_links"); }

  // Порог
  const isSpam = score >= 3;
  return { isSpam, score, reasons };
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
export async function processAmoCallNotes(perEntityLimit = PER_ENTITY_LIMIT, maxNewToProcessThisTick = Infinity) {
  // курсоры
  const [leadCursor, contactCursor, companyCursor] = await Promise.all([
    getCursor("lead"),
    getCursor("contact"),
    getCursor("company")
  ]);

  // тянем только свежее курсора, скан с конца (reverse)
  const [leadNotes, contactNotes, companyNotes] = await Promise.all([
    fetchNotesSinceCursor("lead",    "/api/v4/leads/notes",     perEntityLimit, MAX_PAGES_BACK, leadCursor),
    fetchNotesSinceCursor("contact", "/api/v4/contacts/notes",  perEntityLimit, Math.max(2, Math.floor(MAX_PAGES_BACK/1.5)), contactCursor),
    fetchNotesSinceCursor("company", "/api/v4/companies/notes", perEntityLimit, Math.max(2, Math.floor(MAX_PAGES_BACK/3)),   companyCursor),
  ]);

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

  // свежие первые
  picked.sort((a,b) => (b.created_at||0) - (a.created_at||0));

  const now = Date.now();
  let started = 0, skipped = 0, withLinks = 0, ignored = 0, seenOnly = 0;

  // локальные максимумы курсоров
  let maxLeadCA = leadCursor;
  let maxContactCA = contactCursor;
  let maxCompanyCA = companyCursor;

  // ——— двухочередная стратегия: сначала non-spam, затем spam ———
  const nonSpamQueue = [];
  const spamQueue = [];

  for (const note of picked) {
    const createdMs = (note.created_at || 0) * 1000;
    if (IGNORE_MS > 0 && (now - createdMs) > IGNORE_MS) {
      // слишком старо (если включена свежесть)
      await markSeenOnly("amo_note", String(note.note_id), "");
      ignored++;
      continue;
    }

    const links = findRecordingLinksInNote(note);
    const { isSpam } = scoreSpam(note, links);

    // Раскладываем по очередям: свежие non-spam вперед, спам — в "хвост"
    if (isSpam) spamQueue.push({ note, links });
    else nonSpamQueue.push({ note, links });
  }

  // Объединяем: сначала хорошие, потом мусор
  const processingQueue = nonSpamQueue.concat(spamQueue);

  for (const item of processingQueue) {
    if (started >= maxNewToProcessThisTick) break;

    const note = item.note;
    const links = item.links || [];
    const source_type = "amo_note";
    const source_id = String(note.note_id);
    const already = await isAlreadyProcessed(source_type, source_id);
    if (already) {
      const ca = note.created_at || 0;
      if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
      if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
      if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
      skipped++;
      continue;
    }

    // если нет ссылок — дампим (по желанию) и помечаем seenOnly
    if (!links.length) {
      if (AMO_DEBUG_DUMP) {
        const paramsKeys = Object.keys(note.params||{});
        const previewText = note.text ? mask(String(note.text)).slice(0, 700) : "—";
        await sendTG(
          [
            "🧪 <b>AMO DEBUG</b> — запись не найдена, дамп полей",
            `🔹 note_id: <code>${note.note_id}</code> • entity: <code>${note.entity}</code> • entity_id: <code>${note.entity_id}</code>`,
            `🔹 note_type: <code>${note.note_type || "—"}</code> • created_at: <code>${note.created_at || 0}</code>`,
            `🔹 params.keys: <code>${paramsKeys.join(", ") || "—"}</code>`,
            `📝 text: <code>${previewText}</code>`
          ].join("\n")
        );
      }
      await markSeenOnly(source_type, source_id, "no_links");
      seenOnly++;
      const ca = note.created_at || 0;
      if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
      if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
      if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
      continue;
    }
    withLinks++;

    // анти-спам: если это spamQueue часть — помечаем и не транскрибируем
    const { isSpam, reasons, score } = scoreSpam(note, links);
    if (isSpam) {
      await markSeenOnly(source_type, source_id, `spam:${score}:${reasons.join("+")}`);
      seenOnly++;
      const ca = note.created_at || 0;
      if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
      if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
      if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
      continue;
    }

    // ответственный
    const respInfo   = await amoGetResponsible(note.entity, note.entity_id);
    const managerTxt = respInfo.userName || "неизвестно";

    const durSec   = note?.params?.duration || 0;
    const phone    = note?.params?.phone || "—";
    const kindTxt  = note.note_type === "call_in" ? "📥 Входящий"
                   : note.note_type === "call_out" ? "📤 Исходящий"
                   : note.note_type || "—";
    const dealUrl  = entityCardUrl(note.entity, note.entity_id);
    const createdH = humanDate((note.created_at || 0) * 1000);

    // пред-репорт
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

    for (const origUrl of links) {
      let relayCdnUrl = origUrl;
      try {
        relayCdnUrl = await tgRelayAudio(origUrl, `🎧 Аудио (${note.note_type}) • ${managerTxt}`);
      } catch {}

      const text = await enqueueAsr(() =>
        transcribeAudioFromUrl(relayCdnUrl, { callId: `amo-${note.note_id}` })
      );

      if (text) {
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

        await sendTG(formatQaForTelegram(qa));
        started++;
        await markProcessed(source_type, source_id, origUrl);

        const ca = note.created_at || 0;
        if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
        if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
        if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
      } else {
        await sendTG("⚠️ ASR не удалось выполнить для ссылки из Amo.");
      }

      if (started >= maxNewToProcessThisTick) break;
    }
  }

  // Обновляем курсоры, если:
  // - были реальные обработки (started>0), или
  // - пометили заметки как seenOnly (без ссылок/спам), или
  // - проигнорировали устаревшие по времени (ignored>0).
  if (started > 0 || seenOnly > 0 || ignored > 0 || skipped > 0) {
    const upd = [];
    if (maxLeadCA    > leadCursor)    upd.push(setCursor("lead",    maxLeadCA));
    if (maxContactCA > contactCursor) upd.push(setCursor("contact", maxContactCA));
    if (maxCompanyCA > companyCursor) upd.push(setCursor("company", maxCompanyCA));
    if (upd.length) await Promise.all(upd);
  }

  return {
    scanned: picked.length,
    withLinks,
    started,
    skipped,
    ignored,
    seenOnly,
    cursors: {
      lead_prev: leadCursor,    lead_next: (started>0 || seenOnly>0 || ignored>0) ? maxLeadCA    : leadCursor,
      contact_prev: contactCursor, contact_next: (started>0 || seenOnly>0 || ignored>0) ? maxContactCA : contactCursor,
      company_prev: companyCursor, company_next: (started>0 || seenOnly>0 || ignored>0) ? maxCompanyCA : companyCursor
    }
  };
}
