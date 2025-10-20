// index.js — Railway: MegaPBX → Telegram + Telegram relay ASR + AmoCRM, non-blocking webhooks
// v1.6.0 -> refactor and fixes: security, concurrency, robustness, streaming checks, single-flight refresh, graceful shutdown
// Updated: 2025-10-20
/* eslint-disable no-console */

import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

/* -------------------- sanity / env -------------------- */
if (typeof fetch === "undefined") {
  throw new Error("Global fetch is required (Node >= 18) — install a polyfill or use Node >= 18");
}

const app = express();

/* --- parsers (keep verify to preserve rawBody) --- */
app.use(bodyParser.json({ limit: "25mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(bodyParser.urlencoded({ extended: false, verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(bodyParser.text({ type: ["text/*", "application/octet-stream"], verify: (req, res, buf) => { req.rawBody = buf; } }));

/* --- env: Telegram / MegaPBX --- */
const TG_BOT_TOKEN            = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID              = process.env.TG_CHAT_ID || "";
const TG_WEBHOOK_SECRET       = (process.env.TG_WEBHOOK_SECRET || "").trim();
let   TG_SECRET               = TG_WEBHOOK_SECRET || "";
const CRM_SHARED_KEY          = process.env.CRM_SHARED_KEY || "";
const OPENAI_API_KEY          = process.env.OPENAI_API_KEY || "";
const AUTO_TRANSCRIBE         = process.env.AUTO_TRANSCRIBE === "1";
const AUTO_TRANSCRIBE_VIA_TG  = process.env.AUTO_TRANSCRIBE_VIA_TG === "1";
const SHOW_CONTACT_EVENTS     = process.env.SHOW_CONTACT_EVENTS === "1";
const RELAY_BASE_URL          = process.env.RELAY_BASE_URL || "";
const TG_DIRECT_FETCH         = process.env.TG_DIRECT_FETCH === "1";
const TG_UPLOAD_CHAT_ID       = process.env.TG_UPLOAD_CHAT_ID || TG_CHAT_ID;
const NODE_ENV                = process.env.NODE_ENV || "development";

/* --- env: AmoCRM --- */
const AMO_BASE_URL       = (process.env.AMO_BASE_URL || "").replace(/\/+$/,"");
const AMO_CLIENT_ID      = process.env.AMO_CLIENT_ID || "";
const AMO_CLIENT_SECRET  = process.env.AMO_CLIENT_SECRET || "";
const AMO_REDIRECT_URI   = process.env.AMO_REDIRECT_URI || "";
const AMO_AUTH_CODE      = process.env.AMO_AUTH_CODE || "";
let   AMO_ACCESS_TOKEN   = process.env.AMO_ACCESS_TOKEN || "";
let   AMO_REFRESH_TOKEN  = process.env.AMO_REFRESH_TOKEN || "";

const VERSION = "railway-1.6.0-refactored";

/* -------------------- helpers -------------------- */
function debug(...args){ if (process.env.DEBUG) console.debug(...args); }
function cap(s, n = 2000) { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + "…[cut]" : t; }
function safeStr(obj, n = 3500) { try { if (typeof obj === "string") return cap(obj,n); return cap(JSON.stringify(obj,null,2),n); } catch { return "[unserializable]"; } }
function fmtPhone(p){ if(!p) return "-"; const s=String(p).trim(); return s.startsWith("+")?s:("+"+s); }
function mask(s){ if(!s) return ""; const t=String(s); return t.length<=8? t.replace(/.(?=.{2})/g,"*") : t.slice(0,4) + "…" + t.slice(-4); }
function prettyType(type) {
  const t = String(type || "").toUpperCase();
  const map = {
    RINGING: "📳 RINGING (звонит)",
    INCOMING: "🔔 INCOMING",
    ACCEPTED: "✅ ACCEPTED (принят)",
    COMPLETED: "🔔 COMPLETED",
    HANGUP: "⛔️ HANGUP (завершён)",
    MISSED: "❌ MISSED (пропущен)",
    HISTORY: "🗂 HISTORY (итоги/запись)",
    CANCELLED: "🚫 CANCELLED (отменён)",
    OUTGOING: "🔔 OUTGOING"
  };
  // ЗАМЕНА: использована конкатенация вместо шаблонной строки — чтобы избежать ошибок в окружениях с проблемной кодировкой
  return map[t] || ("🔔 " + type);
}

function chunkText(str, max = 3500) { const out=[]; for (let i=0;i<str.length;i+=max) out.push(str.slice(i,i+max)); return out; }

/* --- basic fetch with timeout and optional maxBytes check --- */
async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), ms);
  try {
    const headers = { "user-agent": "SmartAIListener/1.6 (+railway)", ...opts.headers };
    return await fetch(url, { ...opts, headers, signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}

/* -------------------- Telegram helpers with queue + retry -------------------- */
/* Small serialized queue for outbound Telegram messages to reduce chance of flooding.
   Concurrency 1, retries on transient network errors. */
const tgQueue = [];
let tgWorkerRunning = false;

function enqueueTGTask(fn) {
  return new Promise((resolve, reject) => {
    tgQueue.push({ fn, resolve, reject });
    if (!tgWorkerRunning) runTgWorker();
  });
}

async function runTgWorker() {
  tgWorkerRunning = true;
  while (tgQueue.length) {
    const item = tgQueue.shift();
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (e) {
      item.reject(e);
    }
    // small delay between messages to be polite (configurable)
    await new Promise(r => setTimeout(r, parseInt(process.env.TG_SEND_DELAY_MS || "150", 10)));
  }
  tgWorkerRunning = false;
}

async function tgRequest(apiPath, bodyObj, ms = 12000) {
  if (!TG_BOT_TOKEN) throw new Error("TG_BOT_TOKEN not set");
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/${apiPath}`;
  const payload = JSON.stringify(bodyObj);
  const attempt = async (triesLeft = 3, backoff = 250) => {
    try {
      const r = await fetchWithTimeout(url, { method: "POST", headers: { "content-type":"application/json" }, body: payload }, ms);
      if (!r.ok) {
        const text = await r.text().catch(()=>"");
        const err = new Error(`tg ${apiPath} http ${r.status}: ${text}`);
        if (r.status >= 500 && triesLeft > 1) {
          await new Promise(r=>setTimeout(r, backoff));
          return attempt(triesLeft - 1, backoff * 2);
        }
        throw err;
      }
      return await r.json().catch(()=>({ ok: true }));
    } catch (e) {
      if (triesLeft > 1 && (e.name === "FetchError" || String(e).includes("timeout"))) {
        await new Promise(r=>setTimeout(r, backoff));
        return attempt(triesLeft - 1, backoff * 2);
      }
      throw e;
    }
  };
  return enqueueTGTask(() => attempt());
}

async function sendTG(text) {
  try {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) { console.warn("sendTG skipped: no TG env"); return false; }
    const body = { chat_id: TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true };
    await tgRequest("sendMessage", body, 12000);
    return true;
  } catch (e) {
    console.error("sendTG error:", e?.message || e);
    return false;
  }
}

async function sendTGDocument(fileUrl, caption = "") {
  try {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return false;
    const body = { chat_id: TG_CHAT_ID, document: fileUrl, caption, parse_mode: "HTML", disable_content_type_detection: false };
    await tgRequest("sendDocument", body, 20000);
    return true;
  } catch (e) {
    console.error("sendTGDocument error:", e?.message || e);
    return false;
  }
}

async function tgReply(chatId, text, extra = {}) {
  try {
    const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra };
    await tgRequest("sendMessage", body, 12000);
    return true;
  } catch (e) {
    console.error("tgReply error:", e?.message || e);
    return false;
  }
}
async function tgGetFileUrl(fileId) {
  const getFile = `getFile`;
  const resp = await tgRequest(getFile, { file_id: fileId }, 12000);
  if (!resp || !resp.result || !resp.result.file_path) throw new Error(`getFile: file_path missing`);
  return `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${resp.result.file_path}`;
}
async function tgSendUrlAndGetCdnUrl(fileUrl, caption = "") {
  if (!TG_UPLOAD_CHAT_ID) throw new Error("TG_UPLOAD_CHAT_ID not set");
  const api = `sendDocument`;
  const payload = { chat_id: TG_UPLOAD_CHAT_ID, document: fileUrl, caption, parse_mode: "HTML", disable_content_type_detection: false };
  const r = await tgRequest(api, payload, 20000);
  const fileId = r?.result?.document?.file_id || r?.result?.audio?.file_id || r?.result?.voice?.file_id;
  if (!fileId) throw new Error("sendDocument: file_id not found");
  return await tgGetFileUrl(fileId);
}

/* --- recording URL wrapper (optional relay) --- */
function wrapRecordingUrl(url) {
  if (!RELAY_BASE_URL) return url;
  try {
    const u = new URL(url);
    const rb = new URL(RELAY_BASE_URL);
    if (u.hostname === rb.hostname && u.port === rb.port) return url;
  } catch {}
  return RELAY_BASE_URL + encodeURIComponent(url);
}

/* -------------------- AmoCRM helpers (single-flight refresh) -------------------- */
let amoRefreshPromise = null;

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

async function amoExchangeCode() {
  if (!AMO_AUTH_CODE) throw new Error("AMO_AUTH_CODE missing");
  const j = await amoOAuth({ grant_type: "authorization_code", code: AMO_AUTH_CODE });
  AMO_ACCESS_TOKEN = j.access_token || "";
  AMO_REFRESH_TOKEN = j.refresh_token || "";
  return j;
}

async function amoRefresh() {
  if (!AMO_REFRESH_TOKEN) throw new Error("AMO_REFRESH_TOKEN missing");
  // single-flight refresh
  if (amoRefreshPromise) return amoRefreshPromise;
  amoRefreshPromise = (async () => {
    try {
      const j = await amoOAuth({ grant_type: "refresh_token", refresh_token: AMO_REFRESH_TOKEN });
      AMO_ACCESS_TOKEN = j.access_token || "";
      AMO_REFRESH_TOKEN = j.refresh_token || "";
      return j;
    } finally {
      amoRefreshPromise = null;
    }
  })();
  return amoRefreshPromise;
}

async function amoFetch(path, opts = {}, ms = 15000) {
  ensureAmoEnv();
  if (!AMO_ACCESS_TOKEN) throw new Error("No AMO_ACCESS_TOKEN — run /amo/exchange first");
  const url = `${AMO_BASE_URL}${path}`;
  const r = await fetchWithTimeout(url, {
    ...opts,
    headers: { "authorization": `Bearer ${AMO_ACCESS_TOKEN}`, "content-type":"application/json", ...(opts.headers||{}) }
  }, ms);
  if (r.status === 401) { // try refresh once with single-flight
    await amoRefresh();
    const r2 = await fetchWithTimeout(url, {
      ...opts,
      headers: { "authorization": `Bearer ${AMO_ACCESS_TOKEN}`, "content-type":"application/json", ...(opts.headers||{}) }
    }, ms);
    if (!r2.ok) throw new Error(`amo ${path} ${r2.status}: ${await r2.text().catch(()=> "")}`);
    return await r2.json();
  }
  if (!r.ok) throw new Error(`amo ${path} ${r.status}: ${await r.text().catch(()=> "")}`);
  return await r.json();
}

/* -------------------- MegaPBX normalizer -------------------- */
function extractRecordInfo(obj) {
  const info = { urls: [], ids: [], hints: [] };
  const pushUrl = (u) => { if (u && /^https?:\/\//i.test(u)) info.urls.push(String(u)); };
  const pushId  = (x) => { if (x) info.ids.push(String(x)); };
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    for (const [k, v] of Object.entries(cur)) {
      const key = k.toLowerCase();
      if (v && typeof v === "object") { stack.push(v); continue; }
      const val = String(v ?? "");
      if (val.startsWith("http://") || val.startsWith("https://")) {
        if (/\b(record|rec|recording|audio|file|link)\b/i.test(key) || /\.(mp3|wav|ogg|m4a)(\?|$)/i.test(val)) pushUrl(val);
      }
      if (/\b(record(_?id)?|rec_id|file_id)\b/i.test(key)) pushId(val);
      if ((/link|url|file/i.test(key)) && val) info.hints.push(`${k}: ${val}`);
    }
  }
  info.urls  = Array.from(new Set(info.urls));
  info.ids   = Array.from(new Set(info.ids));
  info.hints = Array.from(new Set(info.hints));
  return info;
}
function normalizeMegafon(body, headers = {}, query = {}) {
  let b = body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch { b = { raw: b }; } }
  if (!b || typeof b !== "object") b = {};
  const rawType = b.type || b.event || b.command || b.status || query.type || query.event || "unknown";
  const cmd     = (b.cmd || query.cmd || "").toLowerCase();
  let type = rawType;
  if (cmd === "history") type = "HISTORY";
  const callId    = b.callid || b.call_id || b.uuid || b.id || query.callid || query.call_id || "-";
  const direction = (b.direction || query.direction || "-").toLowerCase();
  const telnum = b.telnum || b.to || query.telnum || query.to || "-";
  const phone  = b.phone  || b.from || query.phone  || query.from || "-";
  const ext    = b.ext || b.employee_ext || b.agent || query.ext || "-";
  const diversion = b.diversion || query.diversion || "-";
  const user = b.user || b.agent || b.employee || query.user || "-";
  let from = "-", to = "-";
  if (direction === "out")      { from = telnum; to = phone; }
  else if (direction === "in")  { from = phone; to = telnum; }
  else                          { from = b.from || phone || "-"; to = b.to || telnum || "-"; }
  const recordInfo = extractRecordInfo(b);
  const extra = {
    status: b.status || "-",
    duration: b.duration ? String(b.duration) : undefined,
    wait: b.wait ? String(b.wait) : undefined,
    start: b.start || b.ts_start || undefined
  };
  return { type, cmd, callId, direction, telnum, phone, ext, from, to, recordInfo, extra, user, diversion, raw: b, headers, query };
}
function formatTgMessage(n) {
  const lines = [
    "📞 <b>MegaPBX → Webhook</b>",
    `• Событие: <b>${prettyType(n.type)}</b>`,
    `• CallID: <code>${n.callId}</code>`,
    `• Направление: <code>${n.direction || "-"}</code>`,
    `• От: ${fmtPhone(n.from)} → Кому: ${fmtPhone(n.to)}`,
    `• Наш номер (telnum): ${fmtPhone(n.telnum)}`,
    `• Внутр. (ext): <code>${n.ext}</code>`
  ];
  if (n.user && n.user !== "-")            lines.push(`• Оператор (user): <code>${n.user}</code>`);
  if (n.diversion && n.diversion !== "-")  lines.push(`• Diversion: ${fmtPhone(n.diversion)}`);
  const extras = [];
  if (n.extra) {
    const { status, duration, wait, start } = n.extra;
    if (status && status !== "-") extras.push(`статус: <code>${status}</code>`);
    if (duration) extras.push(`длительность: <code>${duration}s</code>`);
    if (wait) extras.push(`ожидание: <code>${wait}s</code>`);
    if (start) extras.push(`начало: <code>${start}</code>`);
  }
  if (extras.length) lines.push("", "• " + extras.join(" · "));
  if (n.recordInfo?.urls?.length) {
    lines.push("", "🎧 <b>Запись:</b>");
    for (const u of n.recordInfo.urls.slice(0, 5)) lines.push(`• ${u}`);
  } else if (n.recordInfo?.ids?.length) {
    lines.push("", "🎧 <b>ID записи:</b>");
    for (const id of n.recordInfo.ids.slice(0, 5)) lines.push(`• <code>${id}</code>`);
  }
  lines.push("", "<i>Raw:</i>", `<code>${safeStr(n.raw)}</code>`);
  return lines.join("\n");
}

/* -------------------- транскрибация (with HEAD check) -------------------- */
async function transcribeAudioFromUrl(fileUrl, meta = {}) {
  if (!OPENAI_API_KEY) { await sendTG("⚠️ <b>OPENAI_API_KEY не задан</b> — пропускаю транскрибацию."); return null; }
  try {
    // Check content-length first (HEAD). Some hosts don't support HEAD; ignore failures.
    try {
      const head = await fetchWithTimeout(fileUrl, { method: "HEAD", redirect: "follow" }, 8000);
      const cl = head.headers.get("content-length");
      const MAX = 60 * 1024 * 1024;
      if (cl && parseInt(cl, 10) > MAX) { await sendTG(`⚠️ Запись указанного URL слишком большая (${(cl/1024/1024).toFixed(1)}MB) — пропуск.`); return null; }
    } catch (e) {
      debug("HEAD check failed:", e?.message || e);
    }

    const r = await fetchWithTimeout(fileUrl, { redirect: "follow" }, 30000);
    if (!r.ok) { await sendTG(`❗️ Ошибка скачивания записи: HTTP <code>${r.status}</code>`); return null; }
    const MAX = 60 * 1024 * 1024;
    const contentLength = r.headers.get("content-length");
    if (contentLength && parseInt(contentLength,10) > MAX) {
      await sendTG(`⚠️ Запись ${ (parseInt(contentLength,10)/1024/1024).toFixed(1)}MB слишком большая — пропуск.`);
      return null;
    }
    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX) { await sendTG(`⚠️ Запись ${(buf.byteLength/1024/1024).toFixed(1)}MB слишком большая — пропуск.`); return null; }

    const form = new FormData();
    const filename = meta.fileName || (meta.callId ? `${meta.callId}.mp3` : "audio.mp3");
    form.append("file", new Blob([buf]), filename);
    form.append("model", "whisper-1");
    if (meta.language) form.append("language", meta.language);
    form.append("language", "ru");
    form.append("response_format", "text");

    const resp = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form
    }, 120000);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      await sendTG(`❗️ Whisper ошибка: HTTP <code>${resp.status}</code>\n<code>${cap(errText,1000)}</code>`);
      return null;
    }
    const text = await resp.text();
    return text.trim();
  } catch (e) {
    await sendTG(`❗️ Общая ошибка транскрибации: <code>${e?.message || e}</code>`);
    return null;
  }
}

/* -------------------- security: incoming key parsing -------------------- */
function getIncomingKey(req) {
  const auth = req.headers["authorization"] || req.headers["Authorization"];
  if (auth) {
    const m = String(auth).match(/Bearer\s+(.+)/i);
    if (m) return m[1];
    // fallthrough return whole header
    return String(auth).trim();
  }
  return (
    req.headers["x-api-key"] ||
    req.headers["x-crm-key"] ||
    req.headers["x-auth-token"] ||
    req.query?.key ||
    (typeof req.body === "object" ? req.body.crm_token : undefined)
  );
}

/* ---- ring buffer for last webhook events (diagnostics) ---- */
const LAST_EVENTS = [];
function pushEvent(ev) {
  LAST_EVENTS.push({ ts: new Date().toISOString(), ...ev });
  if (LAST_EVENTS.length > 200) LAST_EVENTS.shift();
}
app.get("/diag/events", (_, res) => res.json({ count: LAST_EVENTS.length, items: LAST_EVENTS.slice().reverse() }));

/* ---- metrics / tracking ---- */
const STATS = {
  total: 0,
  byType: {},
  byCmd: {},
  withAudioUrl: 0,
  withoutAudioUrl: 0,
  errors: 0
};
const CALLS = new Map(); // callId -> slot

function trackEvent(n) {
  STATS.total++;
  STATS.byType[n.type] = (STATS.byType[n.type] || 0) + 1;
  const cmd = (n.cmd || "unknown");
  STATS.byCmd[cmd] = (STATS.byCmd[cmd] || 0) + 1;

  const hasAudio = (n.recordInfo?.urls?.length || 0) > 0;
  if (hasAudio) STATS.withAudioUrl++; else STATS.withoutAudioUrl++;

  const now = Date.now();
  const slot = CALLS.get(n.callId) || { firstTs: now, types: new Set(), hasAudio: false, awaitingHistory: false };
  slot.lastTs = now;
  slot.lastType = n.type;
  slot.types.add(n.type);
  slot.hasAudio = slot.hasAudio || hasAudio;

  if (String(n.type).toUpperCase() === "COMPLETED") slot.awaitingHistory = true;
  if (String(n.type).toUpperCase() === "HISTORY") slot.awaitingHistory = false;

  CALLS.set(n.callId, slot);
}

/* Cleanup old CALLS entries and prevent unbounded growth */
const HISTORY_TIMEOUT_MS = (parseInt(process.env.HISTORY_TIMEOUT_MIN || "7",10)) * 60 * 1000;
const CALL_TTL_MS = (parseInt(process.env.CALL_TTL_MIN || "60",10)) * 60 * 1000; // remove calls not updated for CALL_TTL_MS
setInterval(async () => {
  const now = Date.now();
  for (const [callId, slot] of CALLS.entries()) {
    if (slot.awaitingHistory && (now - slot.lastTs > HISTORY_TIMEOUT_MS)) {
      try {
        await sendTG(
          `⏰ <b>HISTORY не пришёл вовремя</b>\n` +
          `• CallID: <code>${callId}</code>\n` +
          `• Последнее событие: <code>${slot.lastType}</code>\n` +
          `• Прошло: ${(Math.round((now-slot.lastTs)/600)/100)} мин\n` +
          `• Была ссылка на запись: <code>${slot.hasAudio ? "да" : "нет"}</code>`
        );
      } catch (e) { debug("notify history timeout failed", e?.message || e); }
      slot.awaitingHistory = false;
      CALLS.set(callId, slot);
    }
    // cleanup old entries
    if (!slot.awaitingHistory && (now - slot.lastTs > CALL_TTL_MS)) {
      CALLS.delete(callId);
    }
  }
}, 60 * 1000);

/* -------------------- routes: diagnostics -------------------- */
app.get("/", (_, res) => res.send("OK"));
app.get("/version", (_, res) => res.json({ version: VERSION }));
app.get("/diag/env", (req, res) => {
  res.json({
    VERSION,
    TG_BOT_TOKEN: !!process.env.TG_BOT_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID ? (String(process.env.TG_CHAT_ID).slice(0,4) + "...") : "",
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    CRM_SHARED_KEY: !!process.env.CRM_SHARED_KEY,
    AUTO_TRANSCRIBE, AUTO_TRANSCRIBE_VIA_TG, SHOW_CONTACT_EVENTS, TG_DIRECT_FETCH,
    RELAY_BASE_URL: !!RELAY_BASE_URL, TG_WEBHOOK_SECRET: !!TG_WEBHOOK_SECRET,
    TG_UPLOAD_CHAT_ID: !!TG_UPLOAD_CHAT_ID, ROUTE_SECRET: !!TG_SECRET,
    AMO_BASE_URL: !!AMO_BASE_URL,
    AMO_CLIENT_ID: mask(AMO_CLIENT_ID),
    AMO_CLIENT_SECRET: mask(AMO_CLIENT_SECRET),
    AMO_REDIRECT_URI: !!AMO_REDIRECT_URI,
    AMO_ACCESS_TOKEN: AMO_ACCESS_TOKEN ? mask(AMO_ACCESS_TOKEN) : "",
    AMO_REFRESH_TOKEN: AMO_REFRESH_TOKEN ? mask(AMO_REFRESH_TOKEN) : ""
  });
});
app.get("/diag/stats", (_, res) => {
  res.json({ version: VERSION, totals: STATS, calls_tracked: CALLS.size });
});
app.get("/diag/calls", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "100",10), 500);
  const items = [];
  for (const [id, s] of CALLS.entries()) {
    items.push({
      callId: id,
      firstTs: s.firstTs,
      lastTs: s.lastTs,
      lastType: s.lastType,
      types: Array.from(s.types),
      hasAudio: s.hasAudio,
      awaitingHistory: s.awaitingHistory
    });
  }
  items.sort((a,b)=>b.lastTs - a.lastTs);
  res.json({ count: items.length, items: items.slice(0, limit) });
});
app.get("/tg/ping", async (req, res) => { const text = req.query.msg || "ping-from-railway"; const ok = await sendTG("🔧 " + text); res.json({ ok }); });

app.get("/probe-url", async (req, res) => {
  const url = req.query.url; if (!url) return res.status(400).json({ ok: false, error: "no url" });
  try {
    const r = await fetchWithTimeout(url, { method: "HEAD", redirect: "manual" }, 8000);
    const head = {}; r.headers.forEach((v, k) => head[k] = v);
    let peekStatus = null, peekBytes = 0;
    try {
      const rr = await fetchWithTimeout(url, { method: "GET", headers: { Range: "bytes=0-1023" } }, 8000);
      peekStatus = rr.status;
      const buf = await rr.arrayBuffer();
      peekBytes = buf.byteLength || 0;
    } catch (e) {
      debug("probe-url GET partial failed:", e?.message || e);
    }
    return res.json({ ok: true, status: r.status, headers: head, peek_status: peekStatus, peek_bytes: peekBytes });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e) }); }
});

/* -------------------- manual ASR / file push -------------------- */
const ASR_CONCURRENCY = parseInt(process.env.ASR_CONCURRENCY || "2", 10);
const asrQueue = [];
let asrActive = 0;

function enqueueAsr(taskFn) {
  return new Promise((resolve, reject) => {
    asrQueue.push({ taskFn, resolve, reject });
    processAsrQueue();
  });
}

async function processAsrQueue() {
  if (asrActive >= ASR_CONCURRENCY) return;
  const next = asrQueue.shift();
  if (!next) return;
  asrActive++;
  try {
    const out = await next.taskFn();
    next.resolve(out);
  } catch (e) {
    next.reject(e);
  } finally {
    asrActive--;
    processAsrQueue();
  }
}

app.all("/asr", async (req, res) => {
  try {
    const inKey = getIncomingKey(req);
    if (CRM_SHARED_KEY && String(inKey) !== String(CRM_SHARED_KEY)) return res.status(401).json({ ok:false, error:"bad key" });
    const url = (req.method === "GET" ? req.query.url : (req.body?.url || req.query?.url));
    if (!url) return res.status(400).json({ ok:false, error:"no url" });
    const wrapped = wrapRecordingUrl(String(url));
    const capText = `🎧 Запись (manual)\n<code>${wrapped}</code>`;
    if (TG_DIRECT_FETCH) await sendTGDocument(wrapped, capText);

    // run transcription via queue to limit concurrency
    const text = await enqueueAsr(() => transcribeAudioFromUrl(wrapped, { callId: "manual" }));
    if (!text) return res.status(502).json({ ok:false, error:"asr failed" });

    await sendTG("📝 <b>Транскрипт</b> (manual):");
    for (const part of chunkText(text, 3500)) await sendTG(`<code>${part}</code>`);
    try {
      const qa = await analyzeTranscript(text, { callId: "manual", brand: process.env.CALL_QA_BRAND || "" });
      await sendTG(formatQaForTelegram(qa));
    } catch (e) { await sendTG("⚠️ Ошибка анализа QA: <code>"+(e?.message||e)+"</code>"); }
    res.json({ ok:true, chars: text.length });
  } catch (e) { await sendTG(`❗️ /asr error: <code>${e?.message||e}</code>`); res.status(500).json({ ok:false, error:String(e) }); }
});

/* -------------------- Telegram webhook: /tg/<secret> -------------------- */
// Ensure a webhook secret — generate if missing (but fail in production)
if (!TG_SECRET) {
  if (NODE_ENV === "production") {
    throw new Error("TG_WEBHOOK_SECRET is required in production");
  } else {
    TG_SECRET = crypto.randomBytes(18).toString("hex");
    console.warn("TG_WEBHOOK_SECRET not set — using ephemeral secret:", TG_SECRET);
  }
}

app.post(`/tg/${TG_SECRET}`, async (req, res) => {
  try {
    const upd = req.body || {};
    const msg = upd.message || upd.edited_message || {};
    const chatId = msg.chat?.id;
    if (!chatId) return res.json({ ok:true });

    const txt = (msg.text || "").trim();
    if (txt.startsWith("/start") || txt.startsWith("/help")) {
      await tgReply(chatId,
        "👋 Пришли мне аудиофайл (voice/audio/document) — я расшифрую и пришлю аналитику (РОП).\n" +
        "Поддерживаемые форматы: .mp3, .m4a, .ogg, .opus, .wav. Можно также отправить ссылку через команду /asr <url>."
      );
      return res.json({ ok:true });
    }

    // Detect file_id
    let fileId = null;
    let fileName = "audio.mp3";
    if (msg.voice) { fileId = msg.voice.file_id; fileName = "voice.ogg"; }
    else if (msg.audio) { fileId = msg.audio.file_id; fileName = msg.audio.file_name || "audio.mp3"; }
    else if (msg.document) {
      const name = msg.document.file_name || "file.bin";
      const okExt = /\.(mp3|m4a|ogg|oga|opus|wav)$/i.test(name) || /^audio\//i.test(msg.document.mime_type || "");
      if (okExt) { fileId = msg.document.file_id; fileName = name; }
    }

    if (!fileId) {
      if (txt) {
        const m = txt.match(/^\/asr\s+(\S+)/i);
        if (m) {
          const url = m[1];
          await tgReply(chatId, "⏳ Беру по ссылке, расшифровываю…");
          const text = await enqueueAsr(() => transcribeAudioFromUrl(url, { callId: "tg-cmd", fileName: "audio.ext" }));
          if (!text) { await tgReply(chatId, "❗️ Не смог расшифровать по ссылке."); return res.json({ ok:true }); }
          await tgReply(chatId, "📝 <b>Транскрипт</b>:\n<code>" + cap(text, 3500) + "</code>");
          try { const qa = await analyzeTranscript(text, { callId: "tg-cmd", brand: process.env.CALL_QA_BRAND || "" }); await tgReply(chatId, formatQaForTelegram(qa)); }
          catch (e) { await tgReply(chatId, "⚠️ Ошибка анализа QA: <code>"+(e?.message||e)+"</code>"); }
          return res.json({ ok:true });
        }
      }
      await tgReply(chatId, "🧩 Пришли аудио (voice/audio/document) — я расшифрую и пришлю итоги.");
      return res.json({ ok:true });
    }

    await tgReply(chatId, "⏳ Скачиваю файл из Telegram, расшифровываю…");
    let fileUrl; try { fileUrl = await tgGetFileUrl(fileId); } catch (e) { await tgReply(chatId, "❗️ Не удалось получить file_path из Telegram."); return res.json({ ok:true }); }
    const text = await enqueueAsr(() => transcribeAudioFromUrl(fileUrl, { callId: "tg-file", fileName }));
    if (!text) { await tgReply(chatId, "❗️ Не удалось выполнить распознавание."); return res.json({ ok:true }); }
    for (const part of chunkText(text, 3500)) await tgReply(chatId, "📝 <b>Транскрипт</b>:\n<code>"+part+"</code>");
    try { const qa = await analyzeTranscript(text, { callId: "tg-file", brand: process.env.CALL_QA_BRAND || "" }); await tgReply(chatId, formatQaForTelegram(qa)); }
    catch (e) { await tgReply(chatId, "⚠️ Ошибка анализа QA: <code>"+(e?.message||e)+"</code>"); }
    res.json({ ok:true });
  } catch (e) {
    console.error("TG webhook error:", e);
    try { if (TG_CHAT_ID) await sendTG("❗️ TG webhook error:\n<code>"+(e?.message||e)+"</code>"); } catch {}
    res.status(200).json({ ok:true });
  }
});

/* -------------------- MegaPBX webhook (non-blocking) -------------------- */
app.all(["/megafon", "/"], async (req, res, next) => {
  if (req.method === "GET") return next();
  try {
    const inKey = getIncomingKey(req);
    if (CRM_SHARED_KEY && String(inKey) !== String(CRM_SHARED_KEY)) {
      pushEvent({ kind: "reject", reason: "bad key", headers: req.headers });
      return res.status(401).send("bad key");
    }

    const normalized = normalizeMegafon(req.body, req.headers, req.query);
    pushEvent({ kind: "megafon", callId: normalized.callId, type: normalized.type, cmd: normalized.cmd });
    trackEvent(normalized);

    // immediate response
    res.json({ ok: true, type: normalized.type, callId: normalized.callId });

    // background work — use limited concurrency for expensive ops (ASR handled by queue)
    (async () => {
      try {
        if (normalized.cmd === "contact" && !SHOW_CONTACT_EVENTS) return;

        await sendTG(formatTgMessage(normalized));

        if (String(normalized.type).toUpperCase() === "HISTORY" && (!normalized.recordInfo?.urls?.length)) {
          await sendTG(
            "⚠️ HISTORY без ссылки на запись\n" +
            `• CallID: <code>${normalized.callId}</code>\n` +
            `• От: <code>${normalized.from}</code> → Кому: <code>${normalized.to}</code>\n` +
            `• ext: <code>${normalized.ext}</code>`
          );
        }

        const firstAudio = normalized.recordInfo?.urls?.find(u => /\.(mp3|wav|ogg|m4a)(\?|$)/i.test(u));
        if (firstAudio && (String(normalized.type).toUpperCase() === "HISTORY" || String(normalized.type).toUpperCase() === "COMPLETED")) {
          const wrapped = wrapRecordingUrl(firstAudio);
          const cap =
            `🎧 Запись по звонку <code>${normalized.callId}</code>\n` +
            `От: <code>${normalized.from}</code> → Кому: <code>${normalized.to}</code>\n` +
            `ext: <code>${normalized.ext}</code>`;
          await sendTGDocument(wrapped, cap);

          if (AUTO_TRANSCRIBE) {
            try {
              let asrUrl = wrapped;
              if (AUTO_TRANSCRIBE_VIA_TG) {
                try {
                  asrUrl = await tgSendUrlAndGetCdnUrl(wrapped, `🎧 Авто-ASR (relay) CallID ${normalized.callId}`);
                } catch (e) {
                  await sendTG("⚠️ relay через Telegram не удался, пробую скачать напрямую.\n<code>" + (e?.message||e) + "</code>");
                  asrUrl = wrapped;
                }
              }
              // enqueue transcription
              const text = await enqueueAsr(() => transcribeAudioFromUrl(asrUrl, { callId: normalized.callId }));
              if (text) {
                await sendTG(`📝 <b>Транскрипт</b> (CallID <code>${normalized.callId}</code>):`);
                for (const part of chunkText(text, 3500)) await sendTG(`<code>${part}</code>`);
                try {
                  const qa = await analyzeTranscript(text, {
                    callId: normalized.callId, ext: normalized.ext, direction: normalized.direction,
                    from: normalized.from, to: normalized.to, brand: process.env.CALL_QA_BRAND || ""
                  });
                  await sendTG(formatQaForTelegram(qa));
                } catch (e) { await sendTG("❗️ Ошибка анализа (РОП): <code>" + (e?.message || e) + "</code>"); }
              } else {
                await sendTG("⚠️ ASR не удалось выполнить (после relay).");
              }
            } catch (e) {
              await sendTG("❗️ Ошибка авто-ASR: <code>" + (e?.message || e) + "</code>");
            }
          }
        }
      } catch (e) {
        await sendTG("❗️ Background task error: <code>" + (e?.message || e) + "</code>");
      }
    })();

  } catch (e) {
    try { await sendTG(`❗️ <b>Webhook error</b>:\n<code>${(e && e.message) || e}</code>`); } catch {}
    res.status(200).json({ ok: false, error: String(e) });
  }
});
// --- AmoCRM OAuth callback: принимает ?code=..., сразу меняет на токены и показывает результат
app.get("/amo/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res
        .status(400)
        .send("AmoCRM OAuth callback: параметр ?code не передан");
    }
    // сохраняем код в переменную процесса (на время жизни процесса)
    process.env.AMO_AUTH_CODE = code;
    // обновляем локальную переменную, чтобы amoExchangeCode увидел код
    // (она объявлена выше как const AMO_AUTH_CODE, потому создадим локальную)
    globalThis.__AMO_AUTH_CODE_OVERRIDE__ = code;

    // маленький хак: обернём amoExchangeCode так, чтобы он взял код из override
    const _origAmoExchangeCode = amoExchangeCode;
    const j = await (async () => {
      // временно подменим чтение кода
      const saved = AMO_AUTH_CODE;
      try {
        // @ts-ignore
        // eslint-disable-next-line no-undef
        AMO_AUTH_CODE = globalThis.__AMO_AUTH_CODE_OVERRIDE__ || AMO_AUTH_CODE;
        return await _origAmoExchangeCode();
      } finally {
        // @ts-ignore
        AMO_AUTH_CODE = saved;
      }
    })();

    // успех — покажем краткий ответ
    return res.status(200).send(
      `<pre>OK. Tokens saved in memory.
access_token: ${String(j.access_token || "").slice(0,4)}…${String(j.access_token || "").slice(-4)}
refresh_token: ${String(j.refresh_token || "").slice(0,4)}…${String(j.refresh_token || "").slice(-4)}
expires_in: ${j.expires_in}s
Вы можете проверить /amo/account</pre>`
    );
  } catch (e) {
    return res
      .status(500)
      .send(`AmoCRM OAuth error: ${e?.message || e}`);
  }
});

// AmoCRM OAuth callback — принимает ?code=... и сразу меняет его на access/refresh токены
app.get("/amo/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) {
      return res.status(400).send("AmoCRM OAuth callback: не передан ?code");
    }
    // прямой обмен кода на токены — без зависимостей от AMO_AUTH_CODE из env
    const j = await amoOAuth({
      grant_type: "authorization_code",
      code
    });
    AMO_ACCESS_TOKEN = j.access_token || "";
    AMO_REFRESH_TOKEN = j.refresh_token || "";

    // короткая страница-результат
    return res
      .status(200)
      .send(
        `<pre>OK — токены получены и сохранены в памяти процесса.
access_token: ${String(j.access_token || "").slice(0,4)}…${String(j.access_token || "").slice(-4)}
refresh_token: ${String(j.refresh_token || "").slice(0,4)}…${String(j.refresh_token || "").slice(-4)}
expires_in: ${j.expires_in}s

Теперь можно проверить /amo/account</pre>`
      );
  } catch (e) {
    return res.status(500).send(`AmoCRM OAuth error: ${e?.message || e}`);
  }
});
/* -------------------- AmoCRM routes -------------------- */
// --- OAuth callback: amoCRM -> наш сервер с ?code=... ---
app.get("/amo/oauth/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing ?code");

  try {
    // временно подставим код в env-переменную, чтобы переиспользовать amoExchangeCode()
    const prev = process.env.AMO_AUTH_CODE;
    process.env.AMO_AUTH_CODE = String(code);

    const j = await amoExchangeCode(); // получаем access/refresh токены
    await sendTG(
      "✅ <b>AmoCRM: авторизация завершена</b>\n" +
      `• access: <code>${(j.access_token||"").slice(0,6)}…</code>\n` +
      `• refresh: <code>${(j.refresh_token||"").slice(0,6)}…</code>\n` +
      `• expires_in: <code>${j.expires_in}</code>s`
    );

    if (prev !== undefined) process.env.AMO_AUTH_CODE = prev;

    res.send("AmoCRM connected. You can close this tab.");
  } catch (e) {
    await sendTG(`❗️ AmoCRM callback error: <code>${e?.message || e}</code>`);
    res.status(500).send("AmoCRM callback error");
  }
});
// 1) обмен разового кода на токены
app.get("/amo/exchange", async (req, res) => {
  try {
    const j = await amoExchangeCode();
    await sendTG(
      "✅ <b>AmoCRM: получены токены</b>\n" +
      `• access: <code>${mask(j.access_token)}</code>\n` +
      `• refresh: <code>${mask(j.refresh_token)}</code>\n` +
      `• expires_in: <code>${j.expires_in}</code>s`
    );
    res.json({ ok:true, access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in });
  } catch (e) {
    await sendTG(`❗️ AmoCRM exchange error: <code>${e?.message || e}</code>`);
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// 2) рефреш токена
app.get("/amo/refresh", async (req, res) => {
  try {
    const j = await amoRefresh();
    await sendTG(
      "🔄 <b>AmoCRM: refresh OK</b>\n" +
      `• access: <code>${mask(j.access_token)}</code>\n` +
      `• refresh: <code>${mask(j.refresh_token)}</code>`
    );
    res.json({ ok:true, access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in });
  } catch (e) {
    await sendTG(`❗️ AmoCRM refresh error: <code>${e?.message || e}</code>`);
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// 3) проверить аккаунт
app.get("/amo/account", async (req, res) => {
  try {
    const j = await amoFetch("/api/v4/account?with=users,amojo_id");
    res.json({ ok:true, account: j });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// 4) последние звонки (если включена сущность calls в аккаунте)
app.get("/amo/calls", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20",10), 250);
    const page = parseInt(req.query.page || "1",10);
    const j = await amoFetch(`/api/v4/calls?limit=${limit}&page=${page}`);
    res.json({ ok:true, ...j });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// 4.1) последние звонки из примечаний (call_in / call_out)
app.get("/amo/call-notes", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20",10), 100);
    const page  = parseInt(req.query.page || "1",10);

    // amoCRM не даёт общий список нот сразу по всем сущностям, поэтому возьмём по лидам и контактам
    const [leads, contacts] = await Promise.all([
      amoFetch(`/api/v4/leads/notes?filter[note_type]=call_in,call_out&limit=${limit}&page=${page}`),
      amoFetch(`/api/v4/contacts/notes?filter[note_type]=call_in,call_out&limit=${limit}&page=${page}`)
    ]);

    res.json({ ok: true, leads, contacts });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

/* -------------------- fallback dump -------------------- */
app.all("*", async (req, res) => {
  try {
    const body = typeof req.body === "undefined" ? {} : req.body;
    const lines = [
      "📞 <b>MegaPBX → CRM webhook</b>",
      `• Method: <code>${req.method}</code>`,
      `• Path: <code>${req.path || req.url || "/"}</code>`,
      "",
      "<b>Headers</b>:\n<code>" + safeStr(req.headers) + "</code>",
      "",
      "<b>Query</b>:\n<code>" + safeStr(req.query || {}) + "</code>",
      "",
      "<b>Body</b>:\n<code>" + safeStr(body) + "</code>"
    ];
    if (TG_CHAT_ID) await sendTG(lines.join("\n"));
    res.json({ ok: true, note: "fallback handler" });
  } catch (e) {
    try { await sendTG(`❗️ <b>Fallback error</b>:\n<code>${(e && e.message) || e}</code>`); } catch {}
    res.status(500).send("server error");
  }
});

/* -------------------- start server (Railway uses PORT) -------------------- */
const PORT = process.env.PORT || 3000;

/* -------------------- auto Telegram webhook setup -------------------- */
// Improved setup + protected manual endpoint: replace previous setupTelegramWebhook() and its call with this block

async function setupTelegramWebhook() {
  try {
    if (!TG_BOT_TOKEN) {
      console.warn("❌ TG_BOT_TOKEN отсутствует, пропускаем setWebhook");
      return;
    }

    // try several env names that platforms commonly set
    const base = (process.env.RAILWAY_STATIC_URL ||
                  process.env.RAILWAY_URL ||
                  process.env.RAILWAY_PROJECT_URL ||
                  process.env.PUBLIC_URL ||
                  process.env.APP_URL ||
                  "").replace(/\/+$/,"");

    if (!base) {
      console.warn("⚠️ Не найден публичный URL в окружении (RAILWAY_URL/RAILWAY_STATIC_URL/PUBLIC_URL).");
      console.warn("⚠️ Вызовите POST /tg/setup с TG_WEBHOOK_SECRET для ручной установки вебхука.");
      return;
    }

    const webhookUrl = `${base}/tg/${TG_SECRET}`;
    console.log(`🔧 Попытка установки Telegram webhook на ${webhookUrl}`);

    // retry logic with backoff
    const maxAttempts = 3;
    let attempt = 0;
    let lastErr = null;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const resp = await fetchWithTimeout(`https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: webhookUrl, secret_token: TG_SECRET })
        }, 15000);
        const data = await resp.json().catch(()=>({}));
        if (data && data.ok) {
          console.log(`✅ Telegram webhook установлен: ${webhookUrl}`);
          return;
        } else {
          lastErr = data || `http ${resp.status}`;
          console.warn(`⚠️ setWebhook попытка ${attempt} вернула ошибку:`, lastErr);
        }
      } catch (e) {
        lastErr = e;
        console.warn(`⚠️ setWebhook attempt ${attempt} failed:`, e?.message || e);
      }
      // exponential backoff
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
    console.error("❌ Не удалось установить Telegram webhook после попыток:", lastErr);
  } catch (e) {
    console.error("❗ Ошибка setupTelegramWebhook:", e);
  }
}

// Protected route to trigger webhook setup manually:
// POST /tg/setup  (requires TG_WEBHOOK_SECRET in header x-setup-key or body.key or query.key)
app.post("/tg/setup", async (req, res) => {
  try {
    const provided = req.headers["x-setup-key"] || req.body?.key || req.query?.key;
    if (!provided || !TG_WEBHOOK_SECRET || String(provided) !== String(TG_WEBHOOK_SECRET)) {
      return res.status(401).json({ ok: false, error: "bad key" });
    }
    await setupTelegramWebhook();
    return res.json({ ok: true, note: "setup attempted, check logs" });
  } catch (e) {
    console.error("tg/setup error:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Try to install webhook automatically on startup
setupTelegramWebhook();

const server = app.listen(PORT, () => console.log(`Smart AI Listener (${VERSION}) on :${PORT}`));

/* graceful shutdown: wait a short period for queues to drain */
async function gracefulShutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => console.log("HTTP server closed"));
  // wait for tgQueue and asrQueue to drain or until timeout
  const deadline = Date.now() + 15000;
  while ((tgWorkerRunning || asrActive || tgQueue.length || asrQueue.length) && Date.now() < deadline) {
    console.log("Waiting for background tasks to finish...", { tgQueue: tgQueue.length, asrQueue: asrQueue.length, asrActive });
    // small tick
    await new Promise(r => setTimeout(r, 500));
  }
  console.log("Shutdown complete.");
  process.exit(0);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
