// index.js — Railway edition: MegaPBX → TG (file upload), no VPS

import express from "express";
import bodyParser from "body-parser";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

/* -------------------- app -------------------- */
const app = express();

/* --- parsers --- */
app.use(bodyParser.json({
  limit: "3mb",
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(bodyParser.urlencoded({
  extended: false,
  verify: (req, res, buf) => { req.rawBody = buf; }
}));
app.use(bodyParser.text({
  type: ["text/*", "application/octet-stream"],
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

/* --- env --- */
const TG_BOT_TOKEN   = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID     = process.env.TG_CHAT_ID || "";
const CRM_SHARED_KEY = process.env.CRM_SHARED_KEY || "boxfield-qa-2025";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""; // для Whisper (опц.)
const AUTO_TRANSCRIBE = process.env.AUTO_TRANSCRIBE === "1"; // по умолчанию 0
const SHOW_CONTACT_EVENTS = process.env.SHOW_CONTACT_EVENTS === "1"; // скрываем contact по умолчанию
const RELAY_BASE_URL = process.env.RELAY_BASE_URL || ""; // если нужно проксировать запись через РФ

/* -------------------- utils -------------------- */
function chunkText(str, max = 3500) {
  const out = [];
  let i = 0;
  while (i < str.length) { out.push(str.slice(i, i + max)); i += max; }
  return out;
}
function cap(s, n = 2000) {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…[cut]" : t;
}
function safeStr(obj) {
  try {
    if (typeof obj === "string") return cap(obj, 3500);
    return cap(JSON.stringify(obj, null, 2), 3500);
  } catch { return "[unserializable]"; }
}
function fmtPhone(p) {
  if (!p) return "-";
  const s = String(p).trim();
  return s.startsWith("+") ? s : ("+" + s);
}
function prettyType(type) {
  const t = String(type).toUpperCase();
  return ({
    RINGING: "📳 RINGING (звонит)",
    INCOMING: "🔔 INCOMING",
    ACCEPTED: "✅ ACCEPTED (принят)",
    COMPLETED: "🔔 COMPLETED",
    HANGUP: "⛔️ HANGUP (завершён)",
    MISSED: "❌ MISSED (пропущен)",
    HISTORY: "🗂 HISTORY (итоги/запись)",
    CANCELLED: "🚫 CANCELLED (отменён)"
  }[t] || `🔔 ${type}`);
}
async function sendTG(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) { console.warn("sendTG skipped: no TG env"); return false; }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  if (!resp.ok) { console.error("sendTG error:", resp.status, await resp.text().catch(()=>'')); return false; }
  return true;
}
async function sendTGDocument(fileUrl, caption = "") {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return false;
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, document: fileUrl, caption, parse_mode: "HTML" })
  });
  if (!resp.ok) { console.error("sendTGDocument error:", resp.status, await resp.text().catch(()=>'')); return false; }
  return true;
}

const TG_FILE_MAX = 50 * 1024 * 1024; // ~50MB лимит бота

async function sendTGDocumentFromUrl(fileUrl, caption = "", fileNameHint = "record.mp3") {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return false;

  // 1) скачиваем запись на Railway
  let resp;
  try {
    resp = await fetch(fileUrl, { redirect: "follow" });
  } catch (e) {
    await sendTG(`❗️ Не удалось скачать запись:\n<code>${String(e)}</code>\n${fileUrl}`);
    return false;
  }
  if (!resp.ok) {
    const txt = await resp.text().catch(()=> "");
    await sendTG(`❗️ Ошибка скачивания записи: HTTP <code>${resp.status}</code>\n<code>${cap(txt,500)}</code>`);
    return false;
  }
  const buf = await resp.arrayBuffer();
  if (buf.byteLength > TG_FILE_MAX) {
    await sendTG(`⚠️ Файл ${(buf.byteLength/1024/1024).toFixed(1)}MB больше лимита (~50MB). Шлю ссылкой.`);
    return sendTGDocument(fileUrl, caption);
  }

  // 2) имя файла
  let filename = fileNameHint || "record.mp3";
  try {
    const u = new URL(fileUrl);
    const last = decodeURIComponent(u.pathname.split("/").pop() || "");
    if (last) filename = last;
  } catch {}

  // 3) загружаем в Telegram как multipart
  const form = new FormData();
  form.append("chat_id", TG_CHAT_ID);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("document", new Blob([buf]), filename);

  const api = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`;
  const send = await fetch(api, { method: "POST", body: form });
  if (!send.ok) {
    const t = await send.text().catch(()=> "");
    console.error("sendTGDocumentFromUrl error:", send.status, t);
    await sendTG(`❗️ Ошибка отправки файла в ТГ: HTTP <code>${send.status}</code>\n<code>${cap(t,500)}</code>`);
    return false;
  }
  return true;
}

/* --- relay wrapper (используем только если задан RELAY_BASE_URL) --- */
function wrapRecordingUrl(url) {
  if (!RELAY_BASE_URL) return url;
  try {
    const u = new URL(url);
    const rb = new URL(RELAY_BASE_URL);
    if (u.hostname === rb.hostname && u.port === rb.port) return url; // уже обёрнут
  } catch {}
  return RELAY_BASE_URL + encodeURIComponent(url);
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
        if (/\b(record|rec|recording|audio|file|link)\b/i.test(key) || /\.(mp3|wav|ogg)(\?|$)/i.test(val)) pushUrl(val);
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
  if (n.user && n.user !== "-")       lines.push(`• Оператор (user): <code>${n.user}</code>`);
  if (n.diversion && n.diversion !== "-") lines.push(`• Diversion: ${fmtPhone(n.diversion)}`);
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

/* -------------------- транскрибация (выключена по умолчанию) -------------------- */
async function transcribeAudioFromUrl(fileUrl, meta = {}) {
  if (!OPENAI_API_KEY) {
    await sendTG("⚠️ <b>OPENAI_API_KEY не задан</b> — пропускаю транскрибацию.");
    return null;
  }
  try {
    let r;
    try { r = await fetch(fileUrl, { redirect: "follow" }); }
    catch (e) { await sendTG(`❗️ Ошибка скачивания записи: <code>${e?.message || e}</code>`); return null; }
    if (!r.ok) { await sendTG(`❗️ Ошибка скачивания записи: HTTP <code>${r.status}</code>`); return null; }

    const buf = await r.arrayBuffer();
    const bytes = buf.byteLength;
    const MAX = 60 * 1024 * 1024;
    if (bytes > MAX) { await sendTG(`⚠️ Запись ${(bytes/1024/1024).toFixed(1)}MB слишком большая — пропуск.`); return null; }

    const fileName = (meta.callId ? `${meta.callId}.mp3` : "record.mp3");
    const form = new FormData();
    form.append("file", new Blob([buf]), fileName);
    form.append("model", "whisper-1");
    form.append("language", "ru");
    form.append("response_format", "text");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form
    });
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

/* -------------------- security -------------------- */
function getIncomingKey(req) {
  return (
    req.headers["x-api-key"] ||
    req.headers["x-crm-key"] ||
    req.headers["x-auth-token"] ||
    req.headers["authorization"] ||
    req.query?.key ||
    (typeof req.body === "object" ? req.body.crm_token : undefined)
  );
}

/* -------------------- routes -------------------- */
app.get("/", (_, res) => res.send("OK"));
app.get("/version", (_, res) => res.json({ version: "railway-1.1.0" }));

app.get("/tg/ping", async (req, res) => {
  const text = req.query.msg || "ping-from-railway";
  const ok = await sendTG("🔧 " + text);
  res.json({ ok });
});

app.get("/probe-url", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "no url" });
  try {
    const r = await fetch(url, { method: "GET", redirect: "manual" });
    const headers = {};
    r.headers.forEach((v, k) => headers[k] = v);
    let bytes = 0;
    try {
      const reader = r.body?.getReader?.();
      if (reader) { const { value } = await reader.read(); bytes = (value?.byteLength || 0); }
    } catch {}
    res.json({ ok: true, status: r.status, headers, peek_bytes: bytes });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/diag/openai", async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(200).
