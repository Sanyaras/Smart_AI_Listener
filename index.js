import express from "express";
import bodyParser from "body-parser";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

/* -------------------- app -------------------- */
const app = express();

/* --- parsers --- */
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.text({ type: ["text/*", "application/octet-stream"] }));

/* --- env --- */
const TG_BOT_TOKEN   = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID     = process.env.TG_CHAT_ID;
const CRM_SHARED_KEY = process.env.CRM_SHARED_KEY || "boxfield-qa-2025";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ""; // для транскрибации

const MEGAPBX_PROXY  = process.env.MEGAPBX_PROXY || "";  // http://user:pass@host:port | https://... | socks5://...

/* --- proxy agent (optional) --- */
function makeAgent(url) {
  try {
    if (!url) return undefined;
    if (url.startsWith("http://"))  return new HttpProxyAgent(url);
    if (url.startsWith("https://")) return new HttpsProxyAgent(url);
    if (url.startsWith("socks5://") || url.startsWith("socks://")) return new SocksProxyAgent(url);
    return undefined;
  } catch { return undefined; }
}
const proxyAgent = makeAgent(MEGAPBX_PROXY);

/* -------------------- helpers -------------------- */
async function sendTG(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false
    })
  }).catch(() => {});
}

async function sendTGDocument(fileUrl, caption = "") {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendDocument`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      document: fileUrl, // Telegram умеет тянуть по URL
      caption,
      parse_mode: "HTML",
      disable_content_type_detection: false
    })
  }).catch(() => {});
}

function chunkText(str, max = 3500) {
  const out = [];
  let i = 0;
  while (i < str.length) {
    out.push(str.slice(i, i + max));
    i += max;
  }
  return out;
}

function safeStr(obj) {
  try {
    if (typeof obj === "string") return obj.slice(0, 3500);
    return JSON.stringify(obj, null, 2).slice(0, 3500);
  } catch {
    return "[unserializable]";
  }
}

/* -------------------- normalizer -------------------- */
function normalizeMegafon(body, headers = {}, query = {}) {
  let b = body;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch { b = { raw: b }; }
  }
  if (!b || typeof b !== "object") b = {};

  const rawType = b.type || b.event || b.command || b.status || query.type || query.event || "unknown";
  const cmd     = (b.cmd || query.cmd || "").toLowerCase();
  let type = rawType;
  if (cmd === "history") type = "HISTORY";

  const callId    = b.callid || b.call_id || b.uuid || b.id || query.callid || query.call_id || "-";
  const direction = (b.direction || query.direction || "-").toLowerCase();

  const telnum = b.telnum || b.to || query.telnum || query.to || "-";     // наш номер/линию
  const phone  = b.phone  || b.from || query.phone  || query.from || "-"; // номер абонента
  const ext    = b.ext || b.employee_ext || b.agent || query.ext || "-";

  let from = "-";
  let to   = "-";
  if (direction === "out") { from = telnum; to = phone; }
  else if (direction === "in") { from = phone; to = telnum; }
  else { from = b.from || phone || "-"; to = b.to || telnum || "-"; }

  const recordInfo = extractRecordInfo(b);

  const extra = {
    status: b.status || "-",
    duration: b.duration ? String(b.duration) : undefined,
    wait: b.wait ? String(b.wait) : undefined,
    start: b.start || b.ts_start || undefined
  };

  return { type, cmd, callId, direction, telnum, phone, ext, from, to, recordInfo, extra, raw: b, headers, query };
}

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
        if (/\b(record|rec|recording|audio|file|link)\b/i.test(key) || /\.(mp3|wav|ogg)(\?|$)/i.test(val)) {
          pushUrl(val);
        }
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

function prettyType(type) {
  const t = String(type).toUpperCase();
  return ({
    RINGING: "📳 RINGING (звонит)",
    INCOMING: "🔔 INCOMING",
    ACCEPTED: "✅ ACCEPTED (принят)",
    COMPLETED: "🔔 COMPLETED",
    HANGUP: "⛔️ HANGUP (завершён)",
    MISSED: "❌ MISSED (пропущен)",
    HISTORY: "🗂 HISTORY (итоги/запись)"
  }[t] || `🔔 ${type}`);
}

function formatTgMessage(n) {
  const lines = [
    "📞 <b>MegaPBX → Webhook</b>",
    `• Событие: <b>${prettyType(n.type)}</b>`,
    `• CallID: <code>${n.callId}</code>`,
    `• Направление: <code>${n.direction || "-"}</code>`,
    `• От: <code>${n.from}</code> → Кому: <code>${n.to}</code>`,
    `• Наш номер (telnum): <code>${n.telnum}</code>`,
    `• Внутр. (ext): <code>${n.ext}</code>`
  ];

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
    lines.push("", "🎧 <b>Идентификаторы записи:</b>");
    for (const id of n.recordInfo.ids.slice(0, 5)) lines.push(`• <code>${id}</code>`);
  }

  lines.push("", "<i>Raw:</i>", `<code>${safeStr(n.raw)}</code>`);
  return lines.join("\n");
}

/* -------------------- transcription -------------------- */
async function transcribeAudioFromUrl(fileUrl, meta = {}) {
  if (!OPENAI_API_KEY) {
    await sendTG("⚠️ <b>OPENAI_API_KEY не задан</b> — пропускаю транскрибацию.");
    return null;
  }
  try {
    const r = await fetch(fileUrl, { agent: proxyAgent });
    if (!r.ok) throw new Error(`download failed: ${r.status}`);
    const buf = await r.arrayBuffer();
    const bytes = buf.byteLength;

    const MAX = 60 * 1024 * 1024; // 60 MB
    if (bytes > MAX) {
      await sendTG(`⚠️ Запись <code>${(bytes/1024/1024).toFixed(1)}MB</code> слишком большая — пропустил транскрибацию.`);
      return null;
    }

    const fileName = (meta.callId ? `${meta.callId}.mp3` : "record.mp3");
    const form = new FormData();
    form.append("file", new Blob([buf]), fileName);
    form.append("model", "whisper-1");
    form.append("language", "ru");
    form.append("response_format", "text");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    if (!resp.ok) throw new Error(`whisper error: ${resp.status} ${await resp.text()}`);
    const text = await resp.text();
    return text.trim();
  } catch (e) {
    await sendTG(`❗️ Ошибка транскрибации: <code>${(e && e.message) || e}</code>`);
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
app.get("/version", (_, res) => res.json({ version: "qa+transcribe-rop-v1" }));

app.all(["/megafon", "/"], async (req, res, next) => {
  if (req.method === "GET") return next();
  try {
    const inKey = getIncomingKey(req);
    if (CRM_SHARED_KEY && inKey && String(inKey) !== String(CRM_SHARED_KEY)) {
      return res.status(401).send("bad key");
    }

    const normalized = normalizeMegafon(req.body, req.headers, req.query);
    const msg = formatTgMessage(normalized);
    await sendTG(msg);

    // если есть аудиоссылка — отправим «документ» и запустим транскрибацию + проф-оценку
    const firstAudio = normalized.recordInfo?.urls?.find(u => /\.(mp3|wav|ogg)(\?|$)/i.test(u));
    if (firstAudio) {
      const cap = `🎧 Запись по звонку <code>${normalized.callId}</code>\n` +
                  `От: <code>${normalized.from}</code> → Кому: <code>${normalized.to}</code>\n` +
                  `ext: <code>${normalized.ext}</code>`;
      await sendTGDocument(firstAudio, cap);

      // fire-and-forget: транскрибация -> проф-анализ
      (async () => {
        const text = await transcribeAudioFromUrl(firstAudio, { callId: normalized.callId });
        if (text && text.length) {
          const header = `📝 <b>Транскрипт</b> (CallID <code>${normalized.callId}</code>):`;
          for (const part of chunkText(text, 3500)) await sendTG(`<code>${part}</code>`);

          try {
            const qa = await analyzeTranscript(text, {
              callId: normalized.callId,
              ext: normalized.ext,
              direction: normalized.direction,
              from: normalized.from,
              to: normalized.to,
              brand: process.env.CALL_QA_BRAND || ""
            });
            const card = formatQaForTelegram(qa);
            await sendTG(card);
          } catch (e) {
            await sendTG("❗️ Ошибка анализа (РОП): <code>" + (e?.message || e) + "</code>");
          }
        }
      })();
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

/* -------------------- listen -------------------- */
app.listen(process.env.PORT || 3000, () => {
  console.log("listening on", process.env.PORT || 3000);
});
