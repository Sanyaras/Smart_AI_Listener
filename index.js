// index.js — Railway: MegaPBX → Telegram (file upload or direct), no VPS

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
const TG_BOT_TOKEN        = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID          = process.env.TG_CHAT_ID || "";
const CRM_SHARED_KEY      = process.env.CRM_SHARED_KEY || "boxfield-qa-2025";
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY || "";  // опционально
const AUTO_TRANSCRIBE     = process.env.AUTO_TRANSCRIBE === "1";         // по умолчанию off
const SHOW_CONTACT_EVENTS = process.env.SHOW_CONTACT_EVENTS === "1";     // скрываем contact по умолчанию
const RELAY_BASE_URL      = process.env.RELAY_BASE_URL || "";            // если нужен РФ-прокси
const TG_DIRECT_FETCH     = process.env.TG_DIRECT_FETCH === "1";         // пусть Telegram сам скачивает URL
const VERSION             = "railway-1.2.0";

/* -------------------- utils -------------------- */
function chunkText(str, max = 3500) {
  const out = [];
  for (let i = 0; i < str.length; i += max) out.push(str.slice(i, i + max));
  return out;
}
function cap(s, n = 2000) {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…[cut]" : t;
}
function safeStr(obj, n = 3500) {
  try {
    if (typeof obj === "string") return cap(obj, n);
    return cap(JSON.stringify(obj, null, 2), n);
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

// --- network helpers ---
async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), ms);
  try {
    const headers = { "user-agent": "SmartAIListener/1.2 (+railway)", ...opts.headers };
    return await fetch(url, { ...opts, headers, signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}

/* --- Telegram helpers --- */
async function sendTG(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) { console.warn("sendTG skipped: no TG env"); return false; }
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true })
  }, 12000);
  if (!resp.ok) { console.error("sendTG error:", resp.status, await resp.text().catch(()=>'')); return false; }
  return true;
}
async function sendTGDocument(fileUrl, caption = "") {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return false;
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`;
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, document: fileUrl, caption, parse_mode: "HTML" })
  }, 15000);
  if (!resp.ok) { console.error("sendTGDocument error:", resp.status, await resp.text().catch(()=>'')); return false; }
  return true;
}

const TG_FILE_MAX = 50 * 1024 * 1024; // ~50MB лимит бота
async function sendTGDocumentFromUrl(fileUrl, caption = "", fileNameHint = "record.mp3") {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return false;

  // Режим обхода гео: пусть Telegram сам скачает по URL
  if (TG_DIRECT_FETCH) return sendTGDocument(fileUrl, caption);

  // Скачиваем на Railway и шлём multipart
  let resp;
  try {
    resp = await fetchWithTimeout(fileUrl, { redirect: "follow" }, 15000);
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
    await sendTG(`⚠️ Файл ${(buf.byteLength/1024/1024).toFixed(1)}MB > лимита (~50MB). Шлю ссылкой.`);
    return sendTGDocument(fileUrl, caption);
  }
  let filename = fileNameHint || "record.mp3";
  try {
    const u = new URL(fileUrl);
    const last = decodeURIComponent(u.pathname.split("/").pop() || "");
    if (last) filename = last;
  } catch {}
  const form = new FormData();
  form.append("chat_id", TG_CHAT_ID);
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("document", new Blob([buf]), filename);
  const api = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`;
  const send = await fetchWithTimeout(api, { method: "POST", body: form }, 15000);
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

/* -------------------- транскрибация (выключена по умолчанию) -------------------- */
async function transcribeAudioFromUrl(fileUrl, meta = {}) {
  if (!OPENAI_API_KEY) { await sendTG("⚠️ <b>OPENAI_API_KEY не задан</b> — пропускаю транскрибацию."); return null; }
  try {
    const r = await fetchWithTimeout(fileUrl, { redirect: "follow" }, 15000);
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
    const resp = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form
    }, 30000);
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
app.get("/version", (_, res) => res.json({ version: VERSION }));

app.get("/tg/ping", async (req, res) => {
  const text = req.query.msg || "ping-from-railway";
  const ok = await sendTG("🔧 " + text);
  res.json({ ok });
});

app.get("/probe-url", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "no url" });
  try {
    // HEAD проба
    let r = await fetchWithTimeout(url, { method: "HEAD", redirect: "manual" }, 8000);
    const head = {}; r.headers.forEach((v, k) => head[k] = v);
    // Range 1 байт
    let peekStatus = null, peekBytes = 0;
    try {
      const rr = await fetchWithTimeout(url, { method: "GET", headers: { Range: "bytes=0-0" } }, 8000);
      peekStatus = rr.status;
      const buf = await rr.arrayBuffer();
      peekBytes = buf.byteLength || 0;
    } catch {}
    return res.json({ ok: true, status: r.status, headers: head, peek_status: peekStatus, peek_bytes: peekBytes });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e) });
  }
});

app.get("/diag/openai", async (req, res) => {
  if (!OPENAI_API_KEY) return res.status(200).json({ ok:false, note:"OPENAI_API_KEY not set" });
  try {
    const r = await fetchWithTimeout("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
    }, 12000);
    const body = await r.text();
    res.status(r.status).send(body);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get("/diag/env", (req, res) => {
  res.json({
    TG_BOT_TOKEN: !!process.env.TG_BOT_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID ? (String(process.env.TG_CHAT_ID).slice(0,4) + "...") : "",
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    CRM_SHARED_KEY: !!process.env.CRM_SHARED_KEY,
    AUTO_TRANSCRIBE, SHOW_CONTACT_EVENTS, TG_DIRECT_FETCH: !!TG_DIRECT_FETCH, RELAY_BASE_URL: !!RELAY_BASE_URL
  });
});

/* --- manual ASR / file push --- */
app.all("/asr", async (req, res) => {
  try {
    const inKey = getIncomingKey(req);
    if (CRM_SHARED_KEY && String(inKey) !== String(CRM_SHARED_KEY)) return res.status(401).json({ ok:false, error:"bad key" });

    const url = (req.method === "GET" ? req.query.url : (req.body?.url || req.query?.url));
    if (!url) return res.status(400).json({ ok:false, error:"no url" });

    const wrapped = wrapRecordingUrl(String(url));
    const cap = `🎧 Запись (manual)\n<code>${wrapped}</code>`;

    const okUpload = await sendTGDocumentFromUrl(wrapped, cap, "manual.mp3");
    if (!okUpload) return res.status(502).json({ ok:false, error:"upload failed" });

    if (AUTO_TRANSCRIBE) {
      const text = await transcribeAudioFromUrl(wrapped, { callId: "manual" });
      if (text) {
        await sendTG("📝 <b>Транскрипт</b>:");
        for (const part of chunkText(text, 3500)) await sendTG(`<code>${part}</code>`);
        try {
          const qa = await analyzeTranscript(text, { callId: "manual", brand: process.env.CALL_QA_BRAND || "" });
          await sendTG(formatQaForTelegram(qa));
        } catch (e) { await sendTG("⚠️ Ошибка анализа QA: <code>"+(e?.message||e)+"</code>"); }
      }
    }

    res.json({ ok:true });
  } catch (e) {
    await sendTG(`❗️ /asr error: <code>${e?.message||e}</code>`);
    res.status(500).json({ ok:false, error:String(e) });
  }
});

/* --- main webhook --- */
app.all(["/megafon", "/"], async (req, res, next) => {
  if (req.method === "GET") return next();
  try {
    const inKey = getIncomingKey(req);
    if (CRM_SHARED_KEY && String(inKey) !== String(CRM_SHARED_KEY)) return res.status(401).send("bad key");

    const normalized = normalizeMegafon(req.body, req.headers, req.query);

    // скрываем контактные пинги, если не включено явно
    if (normalized.cmd === "contact" && !SHOW_CONTACT_EVENTS) {
      return res.json({ ok: true, skip: "contact" });
    }

    // карточка в ТГ
    await sendTG(formatTgMessage(normalized));

    // на HISTORY ссылка надёжнее всего; на COMPLETED попробуем тоже
    const firstAudio = normalized.recordInfo?.urls?.find(u => /\.(mp3|wav|ogg)(\?|$)/i.test(u));
    if (firstAudio && (normalized.type === "HISTORY" || normalized.type === "COMPLETED")) {
      const wrapped = wrapRecordingUrl(firstAudio);
      const cap =
        `🎧 Запись по звонку <code>${normalized.callId}</code>\n` +
        `От: <code>${normalized.from}</code> → Кому: <code>${normalized.to}</code>\n` +
        `ext: <code>${normalized.ext}</code>`;

      const okUpload = await sendTGDocumentFromUrl(wrapped, cap, `${normalized.callId || "record"}.mp3`);
      if (!okUpload) await sendTGDocument(wrapped, cap); // фоллбек — просто ссылкой

      if (AUTO_TRANSCRIBE) {
        const text = await transcribeAudioFromUrl(wrapped, { callId: normalized.callId });
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
        }
      }
    }

    res.json({ ok: true, type: normalized.type, callId: normalized.callId, hasAudio: !!firstAudio });
  } catch (e) {
    try { await sendTG(`❗️ <b>Webhook error</b>:\n<code>${(e && e.message) || e}</code>`); } catch {}
    res.status(500).send("server error");
  }
});

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
    await sendTG(lines.join("\n"));
    res.json({ ok: true, note: "fallback handler" });
  } catch (e) {
    try { await sendTG(`❗️ <b>Fallback error</b>:\n<code>${(e && e.message) || e}</code>`); } catch {}
    res.status(500).send("server error");
  }
});

/* -------------------- start server (Railway uses PORT) -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Smart AI Listener (${VERSION}) on :${PORT}`));
