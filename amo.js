// amo.js — Smart AI Listener / AmoCRM integration
// Версия: 2.8.1 (no-cursor-drift + aggressive link finder + optional freshness + debug dumps)

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

// Сколько часов считаем «свежими» звонки. По умолчанию ВЫКЛ (0) — берём всё.
const IGNORE_OLDER_HOURS = parseInt(process.env.AMO_IGNORE_OLDER_HOURS || "0", 10);
const IGNORE_MS = IGNORE_OLDER_HOURS > 0 ? IGNORE_OLDER_HOURS * 60 * 60 * 1000 : 0;

// Часовой пояс для человекочитаемой даты
const AMO_TIMEZONE = process.env.AMO_TIMEZONE || "Europe/Moscow";

// Включить дампы заметок без ссылок (шлёт в TG короткий отчёт о полях)
const AMO_DEBUG_DUMP = (process.env.AMO_DEBUG_DUMP || "1") === "1";

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

/* ==================== Incremental fresh scan ==================== */
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
      if (sinceCreatedAtSec && ca <= sinceCreatedAtSec) break outer;
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
function findRecordingLinksInNote(note) {
  const urls = new Set();
  const urlRe = /https?:\/\/[^\s"'<>]+/ig;

  // телефонии/CDN/облака — частые хосты аудио, даже без ключевых слов
  const TELEPHONY_HOSTS = [
    "megapbx.ru","mega-pbx.ru","pbx.mega","mango-office.ru","mangotele.com",
    "uiscom.ru","uiscom.net","sipuni.com","binotel.ua","zadarma.com","zaddarma.com",
    "yandexcloud.net","storage.yandexcloud.net","s3.amazonaws.com","amazonaws.com",
    "voximplant.com","voximplant.net","ringcentral.com","cloudfront.net","backblazeb2.com",
    "cdn","storage","files","static"
  ];

  const pushFromText = (txt) => {
    if (!txt) return;
    const m = String(txt).match(urlRe);
    if (m) m.forEach(u => urls.add(u));
  };

  const collectFromObj = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        pushFromText(v);
      } else if (Array.isArray(v)) {
        v.forEach(collectFromObj);
      } else if (typeof v === "object") {
        collectFromObj(v);
      }
    }
  };

  if (note?.text)  pushFromText(note.text);
  if (note?.params) collectFromObj(note.params);

  const candidates = Array.from(urls);

  const filtered = candidates.filter(u => {
    // явные аудио
    if (/\.(mp3|wav|ogg|m4a|opus|webm|aac)(\?|$)/i.test(u)) return true;
    // отбрасываем картинки/очевидные медиа не-аудио
    if (/\.(svg|png|jpg|jpeg|gif|webp|mp4|mov|mkv|avi)(\?|$)/i.test(u)) return false;
    // ключевые слова
    if (/(record|recording|audio|call|voice|download|file|storage|rec|voip)/i.test(u)) return true;
    // домены телефонии / cdn
    try {
      const host = new URL(u).hostname.toLowerCase().replace(/^www\./,'');
      if (
        TELEPHONY_HOSTS.some(h => host.endsWith(h)) ||
        /pbx|sip|voip|call|tele/i.test(host)
      ) return true;
    } catch {}
    return false;
  });

  // Доп. эвристика: если это call_* заметка с длительностью > 0 — пропустим ЛЮБУЮ непикчурную ссылку
  const isCall = /^call_/i.test(String(note?.note_type || ""));
  const durSec = parseInt(note?.params?.duration || 0, 10) || 0;
  if (isCall && durSec > 0) {
    const more = candidates.filter(u =>
      !/\.(svg|png|jpg|jpeg|gif|webp)(\?|$)/i.test(u)
    );
    more.forEach(u => filtered.push(u));
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
export async function processAmoCallNotes(perEntityLimit = 100, maxNewToProcessThisTick = Infinity) {
  // курсоры
  const [leadCursor, contactCursor, companyCursor] = await Promise.all([
    getCursor("lead"),
    getCursor("contact"),
    getCursor("company")
  ]);

  // тянем только свежее курсора
  const [leadNotes, contactNotes, companyNotes] = await Promise.all([
    fetchNotesSinceCursor("lead",    "/api/v4/leads/notes",     perEntityLimit, 6, leadCursor),
    fetchNotesSinceCursor("contact", "/api/v4/contacts/notes",  perEntityLimit, 4, contactCursor),
    fetchNotesSinceCursor("company", "/api/v4/companies/notes", perEntityLimit, 2, companyCursor),
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

  // свежие первыми
  picked.sort((a,b) => (b.created_at||0) - (a.created_at||0));

  const now = Date.now();
  let started = 0, skipped = 0, withLinks = 0, ignored = 0, seenOnly = 0;

  // локальные максимумы курсоров — мы их сохраним ТОЛЬКО если реально что-то обработали/пометили
  let maxLeadCA = leadCursor;
  let maxContactCA = contactCursor;
  let maxCompanyCA = companyCursor;

  for (const note of picked) {
    const source_type = "amo_note";
    const source_id = String(note.note_id);

    const already = await isAlreadyProcessed(source_type, source_id);
    if (already) { skipped++; continue; }

    // freshness (опционально)
    const createdMs = (note.created_at || 0) * 1000;
    if (IGNORE_MS > 0 && (now - createdMs) > IGNORE_MS) {
      // не валим по NOT NULL — пишем пустую строку
      await markSeenOnly(source_type, source_id, "");
      ignored++;
      continue;
    }

    if (started >= maxNewToProcessThisTick) break;

    // ссылки
    const links = findRecordingLinksInNote(note);
    if (!links.length) {
      if (AMO_DEBUG_DUMP) {
        // дамп для быстрой диагностики где именно лежит ссылка
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
      // помечаем как «увидели без полезной ссылки», чтобы не застревать
      await markSeenOnly(source_type, source_id, "no_links");
      seenOnly++;
      // проталкиваем локальные курсоры вперёд, чтобы не зацикливаться
      const ca = note.created_at || 0;
      if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
      if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
      if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
      skipped++;
      continue;
    }
    withLinks++;

    // ответственный
    const respInfo   = await amoGetResponsible(note.entity, note.entity_id);
    const managerTxt = respInfo.userName || "неизвестно";

    const durSec   = note?.params?.duration || 0;
    const phone    = note?.params?.phone || "—";
    const kindTxt  = note.note_type === "call_in" ? "📥 Входящий"
                   : note.note_type === "call_out" ? "📤 Исходящий"
                   : note.note_type || "—";
    const dealUrl  = entityCardUrl(note.entity, note.entity_id);
    const createdH = humanDate(createdMs);

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
    }
  }

  // Обновляем курсоры, если:
  // - были реальные обработки (started>0), или
  // - мы пометили заметки как seenOnly (без ссылок), или
  // - мы проигнорировали устаревшие по времени (ignored>0).
  if (started > 0 || seenOnly > 0 || ignored > 0) {
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


