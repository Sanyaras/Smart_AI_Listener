// amo.js — AmoCRM интеграция + надёжный поллер (v3.4-IRAZBIL)
// Совместимо с index.js v2.6.x-IRAZBIL (processAmoCallNotes(limit, bootstrapRemaining, options))
// Фичи: tail-scan + overlap/healing, анти-спам, алерты (c гейтингом non-scoring), Supabase upsert (расширенный), токены из Supabase

import crypto from "crypto";
import { fetchWithTimeout, mask, cap } from "./utils.js";
import { sendTG, tgRelayAudio } from "./telegram.js";
import { enqueueAsr, transcribeAudioFromUrl } from "./asr.js";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

// ==================== ENV ====================
const AMO_BASE_URL       = (process.env.AMO_BASE_URL || "").replace(/\/+$/,"");
const AMO_CLIENT_ID      = process.env.AMO_CLIENT_ID || "";
const AMO_CLIENT_SECRET  = process.env.AMO_CLIENT_SECRET || "";
const AMO_REDIRECT_URI   = process.env.AMO_REDIRECT_URI || "";
const AMO_AUTH_CODE      = process.env.AMO_AUTH_CODE || "";

let   AMO_ACCESS_TOKEN   = process.env.AMO_ACCESS_TOKEN || "";
let   AMO_REFRESH_TOKEN  = process.env.AMO_REFRESH_TOKEN || "";

const AMO_TIMEZONE       = process.env.AMO_TIMEZONE || "Europe/Moscow";
const RELAY_BASE_URL     = process.env.RELAY_BASE_URL || "";

// Игнорировать слишком старые звонки (часы). 0 = выкл
const IGNORE_OLDER_HOURS = parseInt(process.env.AMO_IGNORE_OLDER_HOURS || "0", 10);
const IGNORE_MS          = IGNORE_OLDER_HOURS > 0 ? IGNORE_OLDER_HOURS * 3600 * 1000 : 0;

// Диагностический дамп, если запись не найдена
const AMO_DEBUG_DUMP     = (process.env.AMO_DEBUG_DUMP || "1") === "1";

// Alerts — отдельный Telegram чат
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || "";
const TELEGRAM_BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN || "";
const ALERT_MIN_TOTAL        = parseInt(process.env.ALERT_MIN_TOTAL || "60", 10);
const ALERT_MIN_SENTIMENT    = parseInt(process.env.ALERT_MIN_SENTIMENT || "-2", 10);
const ALERT_IF_ESCALATE      = (process.env.ALERT_IF_ESCALATE || "1") === "1";

// Supabase (REST upsert)
const SUPABASE_URL   = process.env.SUPABASE_URL || "";
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_TABLE = process.env.SUPABASE_CALLS_QA_TABLE || "calls_qa";

// --- safety scan window / healing ---
const CURSOR_OVERLAP_MIN = parseInt(process.env.AMO_CURSOR_OVERLAP_MIN || "180", 10); // 3h overlap
const BACKFILL_MAX_HOURS = parseInt(process.env.AMO_BACKFILL_MAX_HOURS || "72", 10);  // heal up to 72h

// Версия пайплайна QA (пишем в БД)
const QA_VERSION = "v4.3-IRAZBIL";

// ==================== Tokens & Secrets ====================
import {
  isAlreadyProcessed,
  markProcessed,
  markSeenOnly,
  getSecret,
  setSecret
} from "./supabaseStore.js";

const SECRET_KEY_ACCESS  = "amo_access_token";
const SECRET_KEY_REFRESH = "amo_refresh_token";
let TOKENS_LOADED_ONCE = false;

async function loadTokensFromStoreIfNeeded() {
  if (TOKENS_LOADED_ONCE) return;
  try {
    const acc = await getSecret(SECRET_KEY_ACCESS);
    const ref = await getSecret(SECRET_KEY_REFRESH);
    if (acc) AMO_ACCESS_TOKEN = acc;
    if (ref) AMO_REFRESH_TOKEN = ref;
  } catch {}
  TOKENS_LOADED_ONCE = true;
}
async function persistTokens(access, refresh) {
  if (access) {
    AMO_ACCESS_TOKEN = access;
    await setSecret(SECRET_KEY_ACCESS, access).catch(()=>{});
    await setSecret("AMO_ACCESS_TOKEN", access).catch(()=>{});
  }
  if (refresh) {
    AMO_REFRESH_TOKEN = refresh;
    await setSecret(SECRET_KEY_REFRESH, refresh).catch(()=>{});
    await setSecret("AMO_REFRESH_TOKEN", refresh).catch(()=>{});
  }
}
export function injectAmoTokens(access, refresh) { return persistTokens(access, refresh); }
export function getAmoTokensMask() {
  return {
    access: AMO_ACCESS_TOKEN ? mask(AMO_ACCESS_TOKEN) : "",
    refresh: AMO_REFRESH_TOKEN ? mask(AMO_REFRESH_TOKEN) : ""
  };
}

// ==================== OAuth & Fetch ====================
function ensureAmoEnv() {
  if (!AMO_BASE_URL || !AMO_CLIENT_ID || !AMO_CLIENT_SECRET || !AMO_REDIRECT_URI) {
    throw new Error("AMO_* env incomplete");
  }
}
async function amoOAuth(body) {
  ensureAmoEnv();
  const url = `${AMO_BASE_URL}/oauth2/access_token`;
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: AMO_CLIENT_ID,
      client_secret: AMO_CLIENT_SECRET,
      redirect_uri: AMO_REDIRECT_URI,
      ...body
    })
  }, 20000);
  if (!resp.ok) throw new Error(`amo oauth ${resp.status}: ${await resp.text().catch(()=> "")}`);
  return await resp.json();
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
// На случай первичного обмена кодом (не используется из index.js, но оставим)
export async function amoExchangeCode() {
  if (!AMO_AUTH_CODE) throw new Error("AMO_AUTH_CODE missing");
  const j = await amoOAuth({ grant_type: "authorization_code", code: AMO_AUTH_CODE });
  await persistTokens(j.access_token || "", j.refresh_token || "");
  return j;
}

export async function amoFetch(path, opts = {}, ms = 15000) {
  ensureAmoEnv();
  await loadTokensFromStoreIfNeeded();
  if (!AMO_ACCESS_TOKEN) throw new Error("No AMO_ACCESS_TOKEN — авторизуйся на /amo/oauth/start");

  const url = `${AMO_BASE_URL}${path}`;
  const doFetch = (token) => fetchWithTimeout(url, {
    ...opts,
    headers: { "authorization": `Bearer ${token}`, "content-type":"application/json", ...(opts.headers||{}) }
  }, ms);

  let r = await doFetch(AMO_ACCESS_TOKEN);
  if (r.status === 401) {
    try { await amoRefresh(); }
    catch (e) {
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

// ==================== Cursors ====================
const CURSOR_KEYS = {
  lead:    "amo_cursor_lead_notes_created_at",
  contact: "amo_cursor_contact_notes_created_at",
  company: "amo_cursor_company_notes_created_at",
};
async function getCursor(entity){ const v = parseInt(await getSecret(CURSOR_KEYS[entity]) || "0", 10); return Number.isFinite(v) ? v : 0; }
async function setCursor(entity, sec){ if (!sec || !Number.isFinite(sec)) return; await setSecret(CURSOR_KEYS[entity], String(sec)); }

// ==================== Tail probe ====================
async function probeLastPage(pathBase, perPage, maxPageCap = 2000){
  const first = await amoFetch(`${pathBase}?limit=${perPage}&page=1`);
  let lastPage = 1;
  const lastHref = first?._links?.last?.href;
  if (lastHref) {
    const m = String(lastHref).match(/(?:\?|&)page=(\d+)/i);
    if (m) { lastPage = parseInt(m[1], 10) || 1; if (lastPage > 1) return lastPage; }
  }
  let lo = 1, hi = 1;
  const loHas = Array.isArray(first?._embedded?.notes) && first._embedded.notes.length>0;
  if (!loHas) return 1;
  while (hi < maxPageCap) {
    hi *= 2;
    const j = await amoFetch(`${pathBase}?limit=${perPage}&page=${hi}`);
    const has = Array.isArray(j?._embedded?.notes) && j._embedded.notes.length>0;
    if (!has) break; lo = hi;
  }
  let L = lo, R = Math.min(hi, maxPageCap);
  while (L + 1 < R) {
    const mid = Math.floor((L+R)/2);
    const j = await amoFetch(`${pathBase}?limit=${perPage}&page=${mid}`);
    const has = Array.isArray(j?._embedded?.notes) && j._embedded.notes.length>0;
    if (has) L = mid; else R = mid;
  }
  return L;
}

// ==================== Safe fetch since cursor (overlap + healing) ====================
async function fetchNotesSinceCursor(entity, pathBase, perPage, maxPagesBack, sinceCreatedAtSec){
  const overlapSec = Math.max(0, CURSOR_OVERLAP_MIN * 60);
  const sinceSafe  = Math.max(0, (sinceCreatedAtSec || 0) - overlapSec);

  const lastPage = await probeLastPage(pathBase, perPage);
  const collected = [];
  let newestSeenSec = 0;

  const startPage = Math.max(1, lastPage - maxPagesBack + 1);
  outer:
  for (let page = lastPage; page >= startPage; page--) {
    const j = await amoFetch(`${pathBase}?limit=${perPage}&page=${page}`);
    const arr = Array.isArray(j?._embedded?.notes) ? j._embedded.notes : [];
    if (!arr.length) continue;
    for (const n of arr) {
      const ca = parseInt(n?.created_at || 0, 10) || 0;
      if (ca > newestSeenSec) newestSeenSec = ca;
      if (sinceSafe && ca <= sinceSafe) break outer;
      collected.push(n);
    }
  }

  // healing: если курсор впереди последнего
  if (!collected.length && newestSeenSec > 0 && sinceCreatedAtSec && sinceCreatedAtSec > newestSeenSec) {
    const healSince = Math.max(0, newestSeenSec - overlapSec);
    const oldestAllowed = Math.max(0, Math.floor(Date.now()/1000) - BACKFILL_MAX_HOURS*3600);
    const healStart = Math.max(oldestAllowed, healSince);

    const j2 = await amoFetch(`${pathBase}?limit=${perPage}&page=${lastPage}`);
    const arr2 = Array.isArray(j2?._embedded?.notes) ? j2._embedded.notes : [];
    for (const n of arr2) {
      const ca = parseInt(n?.created_at || 0, 10) || 0;
      if (ca >= healStart) collected.push(n);
    }
  }

  collected.sort((a,b) => (b.created_at||0) - (a.created_at||0));
  return collected;
}

// ==================== Users ====================
const AMO_USER_CACHE = new Map();
let AMO_USER_CACHE_TS = 0;
async function amoGetUsersMap() {
  const NOW = Date.now();
  if (NOW - AMO_USER_CACHE_TS < 10 * 60 * 1000 && AMO_USER_CACHE.size > 0) return AMO_USER_CACHE;
  const data = await amoFetch("/api/v4/users?limit=250");
  const arr = data?._embedded?.users || [];
  AMO_USER_CACHE.clear();
  for (const u of arr) {
    AMO_USER_CACHE.set(u.id, {
      name: ([u.name, u.last_name, u.first_name, u.middle_name].filter(Boolean).join(" ").trim()) || u.name || `user#${u.id}`
    });
  }
  AMO_USER_CACHE_TS = NOW;
  return AMO_USER_CACHE;
}
async function amoGetResponsible(entity, entityId) {
  try {
    let path = "";
    if (entity === "lead") path = `/api/v4/leads/${entityId}`;
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

// ==================== Link parser ====================
function findRecordingLinksInNote(note) {
  const urls = new Set();
  const urlRe = /https?:\/\/[^\s"'<>]+/ig;
  const TELEPHONY_HOSTS = [
    "megapbx.ru","mega-pbx.ru","ipapa.megapbx.ru","pbx.mega",
    "mango-office.ru","mangotele.com","uiscom.ru","uiscom.net",
    "sipuni.com","binotel.ua","zadarma.com","zaddarma.com",
    "yandexcloud.net","storage.yandexcloud.net","s3.amazonaws.com","amazonaws.com",
    "voximplant.com","voximplant.net","ringcentral.com","cloudfront.net","backblazeb2.com"
  ];
  const pushFromText = (txt) => { if (!txt) return; const m = String(txt).match(urlRe); if (m) m.forEach(u => urls.add(u)); };
  const collectFromObj = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [, v] of Object.entries(obj)) {
      if (typeof v === "string") pushFromText(v);
      else if (Array.isArray(v)) v.forEach(collectFromObj);
      else if (typeof v === "object") collectFromObj(v);
    }
  };
  if (note?.text)  pushFromText(note.text);
  if (note?.params) collectFromObj(note.params);
  if (note?.params?.link && typeof note.params.link === 'string' && note.params.link.startsWith('http')) urls.add(note.params.link);
  if (note?.params?.link?.href && typeof note.params.link.href === 'string' && note.params.link.href.startsWith('http')) urls.add(note.params.link.href);

  const candidates = Array.from(urls);
  const filtered = candidates.filter(u => {
    if (/\.(mp3|wav|ogg|m4a|opus|webm|aac)(\?|$)/i.test(u)) return true;
    if (/\.(svg|png|jpg|jpeg|gif|webp|mp4|mov|mkv|avi)(\?|$)/i.test(u)) return false;
    if (/(record|recording|audio|call|voice|download|file|storage|rec|voip)/i.test(u)) return true;
    try {
      const host = new URL(u).hostname.toLowerCase().replace(/^www\./,'');
      if (TELEPHONY_HOSTS.some(h => host.endsWith(h)) || /pbx|sip|voip|call|tele/i.test(host)) return true;
    } catch {}
    return false;
  });

  const durSec = parseInt(note?.params?.duration || 0, 10) || 0;
  if (durSec > 0) {
    const more = candidates.filter(u => !/\.(svg|png|jpg|jpeg|gif|webp)(\?|$)/i.test(u));
    more.forEach(u => filtered.push(u));
  }
  return Array.from(new Set(filtered));
}

// ==================== Helpers ====================
function humanDate(ms) {
  if (!ms || Number.isNaN(ms)) return "—";
  return new Date(ms).toLocaleString("ru-RU", {
    timeZone: AMO_TIMEZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}
function pad2(n){ return String(n).padStart(2,"0"); }
function fmtDuration(sec=0){ const s = Math.max(0, parseInt(sec,10) || 0); const m = Math.floor(s/60), r = s%60; return `${m}:${pad2(r)}`; }
function entityCardUrl(entity, id){
  if (!id) return "";
  if (entity === "lead")     return `${AMO_BASE_URL}/leads/detail/${id}`;
  if (entity === "contact")  return `${AMO_BASE_URL}/contacts/detail/${id}`;
  if (entity === "company")  return `${AMO_BASE_URL}/companies/detail/${id}`;
  return `${AMO_BASE_URL}`;
}
function isLikelyCallNote(note){
  const t = String(note?.note_type || "");
  const isCallType = /^call_/.test(t) || /call|звон/iu.test(t);
  const durSec = parseInt(note?.params?.duration || 0, 10) || 0;
  const hasPhone = !!note?.params?.phone;
  return isCallType || durSec > 0 || hasPhone;
}
function sha256(s){ return crypto.createHash("sha256").update(String(s)).digest("hex"); }
function tgSpoiler(s){ return `<span class="tg-spoiler">${s}</span>`; }

// non-scoring классификация на основании QA + длительности
function deriveCallTypeAndScored(qa, durSec) {
  const d = Number.isFinite(+durSec) ? +durSec : null;
  const summary = (qa?.summary || "").toLowerCase();
  const quotesStr = JSON.stringify(qa?.quotes || []).toLowerCase();

  // IVR-доминанта или совсем короткие
  const ivrHints = ["ivr", "автоинформатор", "оставайтесь на линии", "вам ответит первый"];
  const ivrDom = ivrHints.some(h => summary.includes(h) || quotesStr.includes(h));
  if (ivrDom || (d !== null && d < 15)) return { call_type_norm: "na", scored: false };

  // сервисные короткие (мало контента)
  if (d !== null && d < 60) return { call_type_norm: "service_short", scored: false };

  const intent = String(qa?.intent || "").toLowerCase();
  if (intent === "sales")   return { call_type_norm: "sales", scored: true };
  if (intent === "support") return { call_type_norm: "support", scored: true };

  return { call_type_norm: "support", scored: true };
}

// Alerts прямым вызовом Telegram API
async function sendAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ALERT_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_ALERT_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
  }, 15000).catch(()=>{});
}

// ==================== Supabase upsert ====================
async function upsertCallQaToSupabase(row){
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`;
  const body = Array.isArray(row) ? row : [row];
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type":"application/json",
      Prefer: "resolution=merge-duplicates"
    },
    body: JSON.stringify(body)
  }, 20000);
  if (!resp.ok) {
    const t = await resp.text().catch(()=> "");
    console.warn("supabase upsert failed:", resp.status, t);
  }
}

// ==================== Main Poller ====================
// signature: processAmoCallNotes(limit, bootstrapRemaining, options)
// options: { force?: boolean, sinceEpochSec?: number|null, bootstrapLimit?: number|null }
let _zeroScansStreak = 0;

export async function processAmoCallNotes(limit = 30, bootstrapRemaining = 0, options = {}) {
  const { force = false, sinceEpochSec = null, bootstrapLimit = null } = options || {};

  const perEntityLimit = Math.min(limit, 200);
  const maxPagesBack = 8; // сколько страниц назад смотреть «хвост»
  const [leadCursor, contactCursor, companyCursor] = await Promise.all([ getCursor("lead"), getCursor("contact"), getCursor("company") ]);

  const scanSinceLead    = force && sinceEpochSec ? sinceEpochSec : leadCursor;
  const scanSinceContact = force && sinceEpochSec ? sinceEpochSec : contactCursor;
  const scanSinceCompany = force && sinceEpochSec ? sinceEpochSec : companyCursor;

  const [leadNotesRaw, contactNotesRaw, companyNotesRaw] = await Promise.all([
    fetchNotesSinceCursor("lead",    "/api/v4/leads/notes",     perEntityLimit, maxPagesBack, scanSinceLead),
    fetchNotesSinceCursor("contact", "/api/v4/contacts/notes",  perEntityLimit, maxPagesBack, scanSinceContact),
    fetchNotesSinceCursor("company", "/api/v4/companies/notes", perEntityLimit, maxPagesBack, scanSinceCompany),
  ]);

  const filterSpam = (arr) => arr.filter(isLikelyCallNote);
  const leadNotes    = filterSpam(leadNotesRaw);
  const contactNotes = filterSpam(contactNotesRaw);
  const companyNotes = filterSpam(companyNotesRaw);

  // Сводим в один массив
  const picked = [];
  const pack = (entity, items) => {
    for (const n of items) {
      picked.push({
        entity,
        note_id: n.id,
        note_type: n.note_type,
        created_at: n.created_at, // unix sec
        entity_id: n.entity_id,
        text: n.text || n.params?.text || "",
        params: n.params || n.payload || n.data || {}
      });
    }
  };
  pack("lead", leadNotes);
  pack("contact", contactNotes);
  pack("company", companyNotes);
  picked.sort((a,b) => (b.created_at||0) - (a.created_at||0));

  const out = {
    scanned: picked.length,
    withLinks: 0,
    started: 0,
    skipped: 0,
    ignored: 0,
    seenOnly: 0,
    cursors: {
      lead_prev: leadCursor, contact_prev: contactCursor, company_prev: companyCursor,
      lead_next: leadCursor, contact_next: contactCursor, company_next: companyCursor
    }
  };

  if (out.scanned === 0) _zeroScansStreak++; else _zeroScansStreak = 0;

  // авто-перепроверка, если несколько пустых сканов подряд
  if (out.scanned === 0 && _zeroScansStreak >= 3 && !force) {
    const yesterday = Math.floor((Date.now() - 24*3600*1000) / 1000);
    await sendTG("🛠 Автоперепроверка Amo: скан пуст 3 раза подряд — делаю форс-скан со вчерашней даты.");
    return await processAmoCallNotes(limit, bootstrapRemaining, {
      force: true,
      sinceEpochSec: yesterday,
      bootstrapLimit: Math.max(200, limit),
    });
  }

  const now = Date.now();
  let maxLeadCA = leadCursor, maxContactCA = contactCursor, maxCompanyCA = companyCursor;

  const takeMax = Math.min(bootstrapLimit || picked.length, 500);
  for (const note of picked.slice(0, takeMax)) {
    const source_type = "amo_note";
    const source_id   = String(note.note_id);

    const createdMs = (note.created_at || 0) * 1000;
    if (IGNORE_MS > 0 && (now - createdMs) > IGNORE_MS && !force) {
      await markSeenOnly(source_type, source_id, "too_old");
      out.ignored++;
      continue;
    }

    const already = await isAlreadyProcessed(source_type, source_id).catch(()=>false);
    if (already && !force) { out.skipped++; continue; }

    // Ссылки на запись звонка
    const links = findRecordingLinksInNote(note);
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
      out.seenOnly++;
      const ca = note.created_at || 0;
      if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
      if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
      if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
      out.skipped++;
      continue;
    }

    out.withLinks++;

    // Ответственный / карточка
    const respInfo   = await amoGetResponsible(note.entity, note.entity_id);
    const managerTxt = respInfo.userName || "неизвестно";
    const durSec   = parseInt(note?.params?.duration || 0, 10) || 0;
    const phone    = note?.params?.phone || "—";
    const kindTxt  = note.note_type === "call_in" ? "📥 Входящий"
                   : note.note_type === "call_out" ? "📤 Исходящий"
                   : note.note_type || "—";
    const dealUrl  = entityCardUrl(note.entity, note.entity_id);
    const createdH = humanDate(createdMs);

    // Пред-репорт
    await sendTG(
      [
        "🎧 <b>Новый звонок из Amo</b>",
        `📅 <b>Время:</b> <code>${createdH}</code>`,
        `👤 <b>Менеджер:</b> ${managerTxt}`,
        `📞 <b>Телефон:</b> <code>${phone}</code>`,
        `⏱️ <b>Длительность:</b> ${fmtDuration(durSec)}`,
        `💬 <b>Тип:</b> <code>${kindTxt}</code>`,
        dealUrl ? `🔗 <b>Карта:</b> <a href="${dealUrl}">${dealUrl}</a>` : null,
        links[0] ? `🔊 <b>Аудио:</b> <a href="${links[0]}">оригинал</a>` : null,
        note.text ? `📝 <b>Примечание:</b> ${note.text}` : null,
        `<i>note_id: ${note.note_id} • entity: ${note.entity} • entity_id: ${note.entity_id}</i>`
      ].filter(Boolean).join("\n")
    );

    // Обработка ссылок (по первой валидной, остальные можно добавить по желанию)
    const origUrl = links[0];
    let relayCdnUrl = origUrl;
    try { relayCdnUrl = await tgRelayAudio(origUrl, `🎧 Аудио (${note.note_type}) • ${managerTxt}`); } catch {
      // локальный fallback
      try {
        const u = new URL(origUrl);
        if (RELAY_BASE_URL && !String(origUrl).startsWith(RELAY_BASE_URL)) {
          relayCdnUrl = RELAY_BASE_URL + encodeURIComponent(origUrl);
        }
      } catch {}
    }

    // Дедуп до тяжёлых операций
    await markProcessed(source_type, source_id, origUrl).catch(()=>{});

    await enqueueAsr(async () => {
      try {
        const text = await transcribeAudioFromUrl(relayCdnUrl, { callId: `amo-${note.note_id}`, fileName: "call.mp3" });
        if (!text) { await sendTG(`❗️ ASR пусто по note ${note.note_id} (<code>${cap(relayCdnUrl, 120)}</code>)`); return; }

        const tHash = sha256(text);
        const qa = await analyzeTranscript(text, {
          callId: `amo-${note.note_id}`,
          brand: "iRazbil",
          manager: managerTxt,
          amo_entity: note.entity,
          amo_entity_id: note.entity_id,
          created_at: note.created_at || null,
          phone: phone || null,
          duration_sec: durSec || 0
        });

        const qaCard = formatQaForTelegram(qa);
        const spoiler = tgSpoiler(text.slice(0, 1600));
        await sendTG(`${qaCard}\n\n<b>Транскрипт (свернуть):</b>\n${spoiler}`);

        // --- non-scoring классификация и версия
        const { call_type_norm, scored } = deriveCallTypeAndScored(qa, durSec);
        const qaVersion = QA_VERSION;

        // Alerts (только scored)
        try {
          const total = qa?.score?.total ?? 0;
          const pe    = qa?.psycho_emotional || {};
          const sent  = typeof pe.customer_sentiment === "number" ? pe.customer_sentiment : 0;
          const esc   = !!pe.escalate_flag;

          if (scored && ((total < ALERT_MIN_TOTAL) || (sent <= ALERT_MIN_SENTIMENT) || (ALERT_IF_ESCALATE && esc))) {
            const intent = qa?.intent || "-";
            await sendAlert(
              [
                "🚨 <b>Алерт по звонку</b>",
                `• Intent: <b>${intent}</b> · Total: <b>${total}</b> · Sentiment: <b>${sent}</b> ${esc ? "· Escalate: <b>yes</b>" : ""}`,
                `• Менеджер: <b>${managerTxt}</b> · Длительность: <b>${fmtDuration(durSec)}</b>`,
                dealUrl ? `• Карта: ${dealUrl}` : null,
                `• call_type: <b>${call_type_norm}</b> · scored: <b>${scored ? "yes" : "no"}</b>`,
                `• note_id: ${note.note_id}`,
                "",
                "<i>Короткий транскрипт:</i>",
                text.slice(0, 700)
              ].filter(Boolean).join("\n")
            );
          }
        } catch {}

        // Supabase upsert (расширенный)
        try {
          await upsertCallQaToSupabase({
            source_type: "amo_note",
            source_id: String(note.note_id),
            unique_key: sha256(`${note.note_id}:${tHash}`),

            amo_entity: note.entity,
            amo_entity_id: note.entity_id,
            note_type: note.note_type || null,
            phone: phone || null,

            duration_sec: durSec || 0,
            created_at_ts: note.created_at || null,
            created_at_iso: new Date(createdMs).toISOString(),
            manager_name: managerTxt,

            // Новые поля
            qa_version: qaVersion,
            intent: qa?.intent || null,
            call_type_norm,             // 'na' | 'service_short' | 'sales' | 'support'
            scored,                     // boolean
            score_total: qa?.score?.total ?? null,
            scores: qa?.score || null,  // jsonb
            techniques: qa?.techniques || null,
            psycho_emotional: qa?.psycho_emotional || null,

            // Совместимость/старые поля (если используются где-то)
            customer_sentiment: qa?.psycho_emotional?.customer_sentiment ?? null,
            manager_tone: qa?.psycho_emotional?.manager_tone ?? null,
            empathy: qa?.psycho_emotional?.manager_empathy ?? null,
            escalate_flag: qa?.psycho_emotional?.escalate_flag ?? null,

            transcript: text,
            transcript_hash: tHash,
            qa_json: qa
          });
        } catch (e) {
          console.warn("upsertCallQaToSupabase error:", e?.message || e);
        }

      } catch (e) {
        await sendTG(`⚠️ Ошибка пайплайна note ${note.note_id}: <code>${(e?.message || e)}</code>`);
      }
    });

    out.started++;
    const ca = note.created_at || 0;
    if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
    if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
    if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
  }

  // Обновим курсоры, если были изменения
  if (out.started > 0 || out.seenOnly > 0 || out.ignored > 0) {
    const upd = [];
    if (maxLeadCA    > leadCursor)    upd.push(setCursor("lead",    maxLeadCA));
    if (maxContactCA > contactCursor) upd.push(setCursor("contact", maxContactCA));
    if (maxCompanyCA > companyCursor) upd.push(setCursor("company", maxCompanyCA));
    if (upd.length) await Promise.all(upd);
    out.cursors.lead_next    = maxLeadCA;
    out.cursors.contact_next = maxContactCA;
    out.cursors.company_next = maxCompanyCA;
  }

  return out;
}
