// amo.js — Smart AI Listener / AmoCRM integration (v3.2 overlap+healing)
// tail-scan + anti-spam + sales/service routing + alerts + supabase upsert

// --- deps
import crypto from "crypto";
import { fetchWithTimeout, mask } from "./utils.js";
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

// «свежее» окно (часы); 0 = выключено (фильтр слишком старых)
const IGNORE_OLDER_HOURS = parseInt(process.env.AMO_IGNORE_OLDER_HOURS || "0", 10);
const IGNORE_MS = IGNORE_OLDER_HOURS > 0 ? IGNORE_OLDER_HOURS * 60 * 60 * 1000 : 0;

const AMO_TIMEZONE = process.env.AMO_TIMEZONE || "Europe/Moscow";
const AMO_DEBUG_DUMP = (process.env.AMO_DEBUG_DUMP || "1") === "1";

// Alerts — отдельный Telegram чат
const TELEGRAM_ALERT_CHAT_ID = process.env.TELEGRAM_ALERT_CHAT_ID || "";
const TELEGRAM_BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN || "";
const ALERT_MIN_TOTAL        = parseInt(process.env.ALERT_MIN_TOTAL || "60", 10);
const ALERT_MIN_SENTIMENT    = parseInt(process.env.ALERT_MIN_SENTIMENT || "-2", 10);
const ALERT_IF_ESCALATE      = (process.env.ALERT_IF_ESCALATE || "1") === "1";

// Supabase (прямой REST upsert)
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_TABLE = process.env.SUPABASE_CALLS_QA_TABLE || "calls_qa";

// --- safety scan window / healing ---
const CURSOR_OVERLAP_MIN = parseInt(process.env.AMO_CURSOR_OVERLAP_MIN || "180", 10); // 3h overlap
const BACKFILL_MAX_HOURS = parseInt(process.env.AMO_BACKFILL_MAX_HOURS || "72", 10);  // heal back up to 72h

// ==================== TOKENS store (Supabase app_secrets-like) ====================
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
  let acc = await getSecret(SECRET_KEY_ACCESS);
  let ref = await getSecret(SECRET_KEY_REFRESH);
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
    await setSecret("AMO_ACCESS_TOKEN", access);
  }
  if (refresh) {
    AMO_REFRESH_TOKEN = refresh;
    await setSecret(SECRET_KEY_REFRESH, refresh);
    await setSecret("AMO_REFRESH_TOKEN", refresh);
  }
}
export function injectAmoTokens(access, refresh) { return persistTokens(access, refresh); }
export function getAmoTokensMask() {
  return {
    access: AMO_ACCESS_TOKEN ? mask(AMO_ACCESS_TOKEN) : "",
    refresh: AMO_REFRESH_TOKEN ? mask(AMO_REFRESH_TOKEN) : ""
  };
}

// ==================== OAuth/FETCH ====================
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
export async function amoExchangeCode() {
  if (!AMO_AUTH_CODE) throw new Error("AMO_AUTH_CODE missing");
  const j = await amoOAuth({ grant_type: "authorization_code", code: AMO_AUTH_CODE });
  await persistTokens(j.access_token || "", j.refresh_token || "");
  return j;
}
export async function amoFetch(path, opts = {}, ms = 15000) {
  ensureAmoEnv();
  await loadTokensFromStoreIfNeeded();
  if (!AMO_ACCESS_TOKEN) throw new Error("No AMO_ACCESS_TOKEN — do OAuth at /amo/oauth/start");

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
  const sinceSafe = Math.max(0, (sinceCreatedAtSec || 0) - overlapSec);

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

  // healing: курсор «улетел» вперёд
  if (!collected.length && newestSeenSec > 0 && sinceCreatedAtSec && sinceCreatedAtSec > newestSeenSec) {
    const healSince = Math.max(0, newestSeenSec - overlapSec);
    const oldestAllowed = Math.max(0, Math.floor(Date.now()/1000) - BACKFILL_MAX_HOURS*3600);
    const healStart = Math.max(oldestAllowed, healSince);

    // дёрнем хвост ещё раз и положим записи >= healStart
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
    "megapbx.ru","mega-pbx.ru","pbx.mega","mango-office.ru","mangotele.com",
    "uiscom.ru","uiscom.net","sipuni.com","binotel.ua","zadarma.com","zaddarma.com",
    "yandexcloud.net","storage.yandexcloud.net","s3.amazonaws.com","amazonaws.com",
    "voximplant.com","voximplant.net","ringcentral.com","cloudfront.net","backblazeb2.com",
    "cdn","storage","files","static"
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

  const isCall = /^call_/i.test(String(note?.note_type || ""));
  const durSec = parseInt(note?.params?.duration || 0, 10) || 0;
  if (isCall && durSec > 0) {
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

// ==================== Main ====================
export async function processAmoCallNotes(perEntityLimit = 100, maxNewToProcessThisTick = Infinity) {
  const [leadCursor, contactCursor, companyCursor] = await Promise.all([ getCursor("lead"), getCursor("contact"), getCursor("company") ]);

  const [leadNotesRaw, contactNotesRaw, companyNotesRaw] = await Promise.all([
    fetchNotesSinceCursor("lead",    "/api/v4/leads/notes",     perEntityLimit, 6, leadCursor),
    fetchNotesSinceCursor("contact", "/api/v4/contacts/notes",  perEntityLimit, 4, contactCursor),
    fetchNotesSinceCursor("company", "/api/v4/companies/notes", perEntityLimit, 2, companyCursor),
  ]);

  const filterSpam = (arr) => arr.filter(isLikelyCallNote);
  const leadNotes    = filterSpam(leadNotesRaw);
  const contactNotes = filterSpam(contactNotesRaw);
  const companyNotes = filterSpam(companyNotesRaw);

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

  const now = Date.now();
  let started = 0, skipped = 0, withLinks = 0, ignored = 0, seenOnly = 0;

  let maxLeadCA = leadCursor, maxContactCA = contactCursor, maxCompanyCA = companyCursor;

  for (const note of picked) {
    const source_type = "amo_note";
    const source_id = String(note.note_id);

    const already = await isAlreadyProcessed(source_type, source_id);
    if (already) { skipped++; continue; }

    const createdMs = (note.created_at || 0) * 1000;
    if (IGNORE_MS > 0 && (now - createdMs) > IGNORE_MS) {
      await markSeenOnly(source_type, source_id, "");
      ignored++; continue;
    }
    if (started >= maxNewToProcessThisTick) break;

    // ссылки
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
      seenOnly++;
      const ca = note.created_at || 0;
      if (note.entity === "lead")    { if (ca > maxLeadCA)    maxLeadCA = ca; }
      if (note.entity === "contact") { if (ca > maxContactCA) maxContactCA = ca; }
      if (note.entity === "company") { if (ca > maxCompanyCA) maxCompanyCA = ca; }
      skipped++; continue;
    }
    withLinks++;

    // ответственный / карточка
    const respInfo   = await amoGetResponsible(note.entity, note.entity_id);
    const managerTxt = respInfo.userName || "неизвестно";
    const durSec   = parseInt(note?.params?.duration || 0, 10) || 0;
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
        `💬 <b>Тип:</b> <code>${kindTxt}</code>`,
        dealUrl ? `🔗 <b>Карта:</b> <a href="${dealUrl}">${dealUrl}</a>` : null,
        links[0] ? `🔊 <b>Аудио:</b> <a href="${links[0]}">оригинал</a>` : null,
        note.text ? `📝 <b>Примечание:</b> ${note.text}` : null,
        `<i>note_id: ${note.note_id} • entity: ${note.entity} • entity_id: ${note.entity_id}</i>`
      ].filter(Boolean).join("\n")
    );

    // обработка всех найденных ссылок
    for (const origUrl of links) {
      let relayCdnUrl = origUrl;
      try { relayCdnUrl = await tgRelayAudio(origUrl, `🎧 Аудио (${note.note_type}) • ${managerTxt}`); } catch {}

      const text = await enqueueAsr(() =>
        transcribeAudioFromUrl(relayCdnUrl, { callId: `amo-${note.note_id}` })
      );

      const tHash = text ? sha256(text) : "";

      if (text) {
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

        // Спойлер-транскрипт (урезанный)
        const short = text.slice(0, 1600);
        const spoiler = tgSpoiler(short);

        // Отрисовка QA + спойлер
        const qaCard = formatQaForTelegram(qa);
        await sendTG(`${qaCard}\n\n<b>Транскрипт (свернуть):</b>\n${spoiler}`);

        // Alerts (в отдельный чат)
        try {
          const total = qa?.score?.total ?? 0;
          const sent  = (() => {
            const pe = qa?.psycho_emotional;
            if (typeof pe?.customer_sentiment === "number") return pe.customer_sentiment;
            return 0;
          })();
          const esc   = !!qa?.psycho?.escalate_flag || !!qa?.psycho_emotional?.escalate_flag;

          if ((total < ALERT_MIN_TOTAL) || (sent <= ALERT_MIN_SENTIMENT) || (ALERT_IF_ESCALATE && esc)) {
            const intent = qa?.intent || qa?.meta?.intent || "-";
            await sendAlert(
              [
                "🚨 <b>Алерт по звонку</b>",
                `• Intent: <b>${intent}</b> · Total: <b>${total}</b> · Sentiment: <b>${sent}</b> ${esc ? "· Escalate: <b>yes</b>" : ""}`,
                `• Менеджер: <b>${managerTxt}</b> · Длительность: <b>${fmtDuration(durSec)}</b>`,
                dealUrl ? `• Карта: ${dealUrl}` : null,
                `• note_id: ${note.note_id}`,
                "",
                "<i>Короткий транскрипт:</i>",
                text.slice(0, 700)
              ].filter(Boolean).join("\n")
            );
          }
        } catch {}

        // Supabase upsert
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
            intent: qa?.intent || qa?.meta?.intent || null,
            stage: qa?.meta?.stage || null,
            outcome: qa?.meta?.outcome || null,
            customer_sentiment: qa?.psycho_emotional?.customer_sentiment ?? null,
            manager_tone: qa?.psycho_emotional?.manager_tone ?? null,
            empathy: qa?.psycho_emotional?.manager_empathy ?? null,
            tension: qa?.psycho?.tension ?? null,
            escalate_flag: qa?.psycho?.escalate_flag ?? qa?.psycho_emotional?.escalate_flag ?? null,
            talk_ratio_manager: qa?.kpis?.estimated_talk_ratio_manager_percent ?? null,
            score_total: qa?.score?.total ?? null,
            score_per_dimension: qa?.score?.per_dimension || null,
            transcript: text,
            transcript_hash: tHash,
            qa_json: qa
          });
        } catch (e) {
          console.warn("upsertCallQaToSupabase error:", e?.message || e);
        }

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
