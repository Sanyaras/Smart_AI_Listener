// index.js — Railway: MegaPBX → Telegram + Telegram relay ASR, non-blocking webhooks
// v1.5.0

import express from "express";
import bodyParser from "body-parser";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

/* -------------------- app -------------------- */
const app = express();

/* --- parsers --- */
app.use(bodyParser.json({ limit: "25mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(bodyParser.urlencoded({ extended: false, verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(bodyParser.text({ type: ["text/*", "application/octet-stream"], verify: (req, res, buf) => { req.rawBody = buf; } }));

/* --- env --- */
const TG_BOT_TOKEN            = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID              = process.env.TG_CHAT_ID || "";                           // чат для уведомлений
const TG_WEBHOOK_SECRET       = process.env.TG_WEBHOOK_SECRET || "";                    // секрет пути вебхука
const TG_SECRET               = (TG_WEBHOOK_SECRET || "hook12345").trim();              // фактический секрет
const CRM_SHARED_KEY          = process.env.CRM_SHARED_KEY || "boxfield-qa-2025";
const OPENAI_API_KEY          = process.env.OPENAI_API_KEY || "";                       // Whisper
const AUTO_TRANSCRIBE         = process.env.AUTO_TRANSCRIBE === "1";
const AUTO_TRANSCRIBE_VIA_TG  = process.env.AUTO_TRANSCRIBE_VIA_TG === "1";             // relay через Telegram
const SHOW_CONTACT_EVENTS     = process.env.SHOW_CONTACT_EVENTS === "1";
const RELAY_BASE_URL          = process.env.RELAY_BASE_URL || "";
const TG_DIRECT_FETCH         = process.env.TG_DIRECT_FETCH === "1";                    // Telegram сам скачает ссылку
const TG_UPLOAD_CHAT_ID       = process.env.TG_UPLOAD_CHAT_ID || TG_CHAT_ID;            // «тихий» чат для relay
const VERSION                 = "railway-1.5.0";

/* -------------------- utils -------------------- */
function chunkText(str, max = 3500) { const out=[]; for (let i=0;i<str.length;i+=max) out.push(str.slice(i,i+max)); return out; }
function cap(s, n = 2000) { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + "…[cut]" : t; }
function safeStr(obj, n = 3500) { try { if (typeof obj === "string") return cap(obj,n); return cap(JSON.stringify(obj,null,2),n); } catch { return "[unserializable]"; } }
function fmtPhone(p){ if(!p) return "-"; const s=String(p).trim(); return s.startsWith("+")?s:("+"+s); }
function prettyType(type){ const t=String(type).toUpperCase(); return ({RINGING:"📳 RINGING (звонит)",INCOMING:"🔔 INCOMING",ACCEPTED:"✅ ACCEPTED (принят)",COMPLETED:"🔔 COMPLETED",HANGUP:"⛔️ HANGUP (завершён)",MISSED:"❌ MISSED (пропущен)",HISTORY:"🗂 HISTORY (итоги/запись)",CANCELLED:"🚫 CANCELLED (отменён)"}[t]||`🔔 ${type}`); }

/* --- network helper with timeout --- */
async function fetchWithTimeout(url, opts = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), ms);
  try {
    const headers = { "user-agent": "SmartAIListener/1.5 (+railway)", ...opts.headers };
    return await fetch(url, { ...opts, headers, signal: ctrl.signal });
  } finally { clearTimeout(timer); }
}

/* --- Telegram helpers (server notifications) --- */
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
    body: JSON.stringify({ chat_id: TG_CHAT_ID, document: fileUrl, caption, parse_mode: "HTML", disable_content_type_detection: false })
  }, 15000);
  if (!resp.ok) { console.error("sendTGDocument error:", resp.status, await resp.text().catch(()=>'')); return false; }
  return true;
}

/* --- Telegram helpers (chat replies & relay) --- */
async function tgReply(chatId, text, extra = {}) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra };
  const r = await fetchWithTimeout(url, { method: "POST", headers: { "content-type":"application/json" }, body: JSON.stringify(body) }, 12000);
  return r.ok;
}
async function tgGetFileUrl(fileId) {
  const getFile = `https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile`;
  const r = await fetchWithTimeout(getFile, { method: "POST", headers: { "content-type":"application/json" }, body: JSON.stringify({ file_id: fileId }) }, 12000);
  if (!r.ok) throw new Error(`getFile http ${r.status}`);
  const j = await r.json();
  const path = j?.result?.file_path;
  if (!path) throw new Error("file_path missing");
  return `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${path}`;
}
async function tgSendUrlAndGetCdnUrl(fileUrl, caption = "") {
  if (!TG_UPLOAD_CHAT_ID) throw new Error("TG_UPLOAD_CHAT_ID not set");
  const api = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`;
  const payload = { chat_id: TG_UPLOAD_CHAT_ID, document: fileUrl, caption, parse_mode: "HTML", disable_content_type_detection: false };
  const r = await fetchWithTimeout(api, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, 20000);
  if (!r.ok) { const t = await r.text().catch(()=> ""); throw new Error(`sendDocument http ${r.status}: ${t}`); }
  const j = await r.json().catch(()=> ({}));
  const fileId = j?.result?.document?.file_id || j?.result?.audio?.file_id || j?.result?.voice?.file_id;
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

/* -------------------- транскрибация -------------------- */
async function transcribeAudioFromUrl(fileUrl, meta = {}) {
  if (!OPENAI_API_KEY) { await sendTG("⚠️ <b>OPENAI_API_KEY не задан</b> — пропускаю транскрибацию."); return null; }
  try {
    const r = await fetchWithTimeout(fileUrl, { redirect: "follow" }, 30000);
    if (!r.ok) { await sendTG(`❗️ Ошибка скачивания записи: HTTP <code>${r.status}</code>`); return null; }
    const buf = await r.arrayBuffer();
    const MAX = 60 * 1024 * 1024;
    if (buf.byteLength > MAX) { await sendTG(`⚠️ Запись ${(buf.byteLength/1024/1024).toFixed(1)}MB слишком большая — пропуск.`); return null; }

    const form = new FormData();
    form.append("file", new Blob([buf]), meta.fileName || (meta.callId ? `${meta.callId}.mp3` : "audio.mp3"));
    form.append("model", "whisper-1");
    form.append("language", "ru");
    form.append("response_format", "text");

    const resp = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form
    }, 60000);
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

/* ---- ring buffer for last webhook events (diagnostics) ---- */
const LAST_EVENTS = [];
function pushEvent(ev) {
  LAST_EVENTS.push({ ts: new Date().toISOString(), ...ev });
  if (LAST_EVENTS.length > 200) LAST_EVENTS.shift();
}
app.get("/diag/events", (_, res) => res.json({ count: LAST_EVENTS.length, items: LAST_EVENTS.slice().reverse() }));

/* -------------------- routes: diagnostics -------------------- */
app.get("/", (_, res) => res.send("OK"));
app.get("/version", (_, res) => res.json({ version: VERSION }));
app.get("/diag/env", (req, res) => {
  res.json({
    TG_BOT_TOKEN: !!process.env.TG_BOT_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID ? (String(process.env.TG_CHAT_ID).slice(0,4) + "...") : "",
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    CRM_SHARED_KEY: !!process.env.CRM_SHARED_KEY,
    AUTO_TRANSCRIBE, AUTO_TRANSCRIBE_VIA_TG, SHOW_CONTACT_EVENTS, TG_DIRECT_FETCH,
    RELAY_BASE_URL: !!RELAY_BASE_URL, TG_WEBHOOK_SECRET: !!TG_WEBHOOK_SECRET,
    TG_UPLOAD_CHAT_ID: !!TG_UPLOAD_CHAT_ID, ROUTE_SECRET: TG_SECRET
  });
});
app.get("/tg/ping", async (req, res) => { const text = req.query.msg || "ping-from-railway"; const ok = await sendTG("🔧 " + text); res.json({ ok }); });
app.get("/probe-url", async (req, res) => {
  const url = req.query.url; if (!url) return res.status(400).json({ ok: false, error: "no url" });
  try {
    let r = await fetchWithTimeout(url, { method: "HEAD", redirect: "manual" }, 8000);
    const head = {}; r.headers.forEach((v, k) => head[k] = v);
    let peekStatus = null, peekBytes = 0;
    try { const rr = await fetchWithTimeout(url, { method: "GET", headers: { Range: "bytes=0-0" } }, 8000); peekStatus = rr.status; const buf = await rr.arrayBuffer(); peekBytes = buf.byteLength || 0; } catch {}
    return res.json({ ok: true, status: r.status, headers: head, peek_status: peekStatus, peek_bytes: peekBytes });
  } catch (e) { return res.status(502).json({ ok: false, error: String(e) }); }
});

/* -------------------- manual ASR / file push -------------------- */
app.all("/asr", async (req, res) => {
  try {
    const inKey = getIncomingKey(req);
    if (CRM_SHARED_KEY && String(inKey) !== String(CRM_SHARED_KEY)) return res.status(401).json({ ok:false, error:"bad key" });
    const url = (req.method === "GET" ? req.query.url : (req.body?.url || req.query?.url));
    if (!url) return res.status(400).json({ ok:false, error:"no url" });
    const wrapped = wrapRecordingUrl(String(url));
    const cap = `🎧 Запись (manual)\n<code>${wrapped}</code>`;
    if (TG_DIRECT_FETCH) await sendTGDocument(wrapped, cap);
    const text = await transcribeAudioFromUrl(wrapped, { callId: "manual" });
    if (!text) return res.status(502).json({ ok:false, error:"asr failed" });
    await sendTG("📝 <b>Транскрипт</b> (manual):");
    for (const part of chunkText(text, 3500)) await sendTG(`<code>${part}</code>`);
    try { const qa = await analyzeTranscript(text, { callId: "manual", brand: process.env.CALL_QA_BRAND || "" }); await sendTG(formatQaForTelegram(qa)); }
    catch (e) { await sendTG("⚠️ Ошибка анализа QA: <code>"+(e?.message||e)+"</code>"); }
    res.json({ ok:true, chars: text.length });
  } catch (e) { await sendTG(`❗️ /asr error: <code>${e?.message||e}</code>`); res.status(500).json({ ok:false, error:String(e) }); }
});

/* -------------------- Telegram webhook: /tg/<secret> -------------------- */
app.post(`/tg/${TG_SECRET}`, async (req, res) => {
  try {
    const upd = req.body || {};
    const msg = upd.message || upd.edited_message || {};
    const chatId = msg.chat?.id;
    if (!chatId) return res.json({ ok:true });

    const txt = msg.text?.trim() || "";
    if (txt.startsWith("/start") || txt.startsWith("/help")) {
      await tgReply(chatId, "👋 Пришли мне аудиофайл (voice/audio/document) — я расшифрую и пришлю аналитику (РОП).\nСовместимо с .mp3/.ogg/.m4a/.wav. Максимум ~60 МБ.");
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
          const text = await transcribeAudioFromUrl(url, { callId: "tg-cmd", fileName: "audio.ext" });
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
    let fileUrl; try { fileUrl = await tgGetFileUrl(fileId); } catch { await tgReply(chatId, "❗️ Не удалось получить file_path из Telegram."); return res.json({ ok:true }); }
    const text = await transcribeAudioFromUrl(fileUrl, { callId: "tg-file", fileName });
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

    // мгновенный ответ
    res.json({ ok: true, type: normalized.type, callId: normalized.callId });

    // фоновая работа
    (async () => {
      try {
        if (normalized.cmd === "contact" && !SHOW_CONTACT_EVENTS) return;

        await sendTG(formatTgMessage(normalized));

        const firstAudio = normalized.recordInfo?.urls?.find(u => /\.(mp3|wav|ogg|m4a)(\?|$)/i.test(u));
        if (firstAudio && (normalized.type === "HISTORY" || normalized.type === "COMPLETED")) return; // safety guard
        if (firstAudio && (normalized.type === "HISTORY" || normalized.type === "COMPLETED")) {
          const wrapped = wrapRecordingUrl(firstAudio);
          const cap =
            `🎧 Запись по звонку <code>${normalized.callId}</code>\n` +
            `От: <code>${normalized.from}</code> → Кому: <code>${normalized.to}</code>\n` +
            `ext: <code>${normalized.ext}</code>`;

          await sendTGDocument(wrapped, cap); // для превью в чате

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

              const text = await transcribeAudioFromUrl(asrUrl, { callId: normalized.callId });
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
    // отвечаем 200 даже при ошибке, чтобы провайдер не дудосил ретраями
    res.status(200).json({ ok: false, error: String(e) });
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
async function setupTelegramWebhook() {
  try {
    if (!TG_BOT_TOKEN) { console.warn("❌ TG_BOT_TOKEN отсутствует, пропускаем setWebhook"); return; }
    const base = (process.env.RAILWAY_STATIC_URL || process.env.RAILWAY_URL || process.env.RAILWAY_PROJECT_URL || "").replace(/\/+$/,"");
    if (!base) { console.warn("⚠️ Не найден Railway URL, пропускаем установку вебхука"); return; }
    const webhookUrl = `${base}/tg/${TG_SECRET}`;
    const resp = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: webhookUrl, secret_token: TG_SECRET }),
    });
    const data = await resp.json();
    if (data.ok) console.log(`✅ Telegram webhook установлен: ${webhookUrl}`);
    else console.error("❌ Ошибка установки вебхука:", data);
  } catch (e) { console.error("❗ Ошибка setupTelegramWebhook:", e); }
}

setupTelegramWebhook();
app.listen(PORT, () => console.log(`Smart AI Listener (${VERSION}) on :${PORT}`));
