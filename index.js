// index.js — Smart AI Listener
// Архитектура с модулями: telegram / asr / amo / megapbx / supabaseStore / utils
// v2.1.0 modular + bootstrap limiter
/* eslint-disable no-console */

import express from "express";
import bodyParser from "body-parser";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

import {
  initTelegramEnv,
  TELEGRAM,
  sendTG,
  sendTGDocument,
  tgReply,
  tgGetFileUrl,
  tgRelayAudio,
  formatTgMegapbxMessage,
  getTelegramQueuesState,
} from "./telegram.js";

import {
  enqueueAsr,
  transcribeAudioFromUrl,
  getAsrState,
} from "./asr.js";

import {
  processAmoCallNotes,
  amoFetch,
  amoExchangeCode,
  amoRefresh,
  getAmoTokensMask,
} from "./amo.js";

import {
  normalizeMegafon,
} from "./megapbx.js";

import {
  debug,
  cap,
  safeStr,
  mask,
  chunkText,
  fetchWithTimeout,
} from "./utils.js";

import {
  isAlreadyProcessed,
  markProcessed,
} from "./supabaseStore.js";

import crypto from "crypto";

/* -------------------- env -------------------- */
const VERSION                 = "railway-2.1.0";

const TG_BOT_TOKEN            = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID              = process.env.TG_CHAT_ID || "";
const TG_WEBHOOK_SECRET       = (process.env.TG_WEBHOOK_SECRET || "").trim();
const TG_UPLOAD_CHAT_ID       = process.env.TG_UPLOAD_CHAT_ID || TG_CHAT_ID;
const NODE_ENV                = process.env.NODE_ENV || "development";

const CRM_SHARED_KEY          = process.env.CRM_SHARED_KEY || "";
const OPENAI_API_KEY          = process.env.OPENAI_API_KEY || "";

const AUTO_TRANSCRIBE         = process.env.AUTO_TRANSCRIBE === "1";
const SHOW_CONTACT_EVENTS     = process.env.SHOW_CONTACT_EVENTS === "1";
const RELAY_BASE_URL          = process.env.RELAY_BASE_URL || "";
const TG_DIRECT_FETCH         = process.env.TG_DIRECT_FETCH === "1";

const AMO_POLL_MINUTES        = parseInt(process.env.AMO_POLL_MINUTES || "0", 10);
const AMO_POLL_LIMIT          = parseInt(process.env.AMO_POLL_LIMIT   || "30", 10);

// bootstrap limiter: сколько "старых" звонков можно сожрать на холодном старте,
// чтобы не залить чат историей.
// пример: 5
const AMO_BOOTSTRAP_LIMIT     = parseInt(process.env.AMO_BOOTSTRAP_LIMIT || "5", 10);
// живёт в памяти процесса. после нескольких тиков станет 0.
let   bootstrapRemaining      = AMO_BOOTSTRAP_LIMIT;

const HISTORY_TIMEOUT_MS      = (parseInt(process.env.HISTORY_TIMEOUT_MIN || "7",10)) * 60 * 1000;
const CALL_TTL_MS             = (parseInt(process.env.CALL_TTL_MIN || "60",10)) * 60 * 1000;

const PORT                    = process.env.PORT || 3000;

/* -------------------- sanity / fetch check -------------------- */
if (typeof fetch === "undefined") {
  throw new Error("Global fetch is required (Node >= 18).");
}

/* -------------------- init telegram config -------------------- */
initTelegramEnv({
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  TG_WEBHOOK_SECRET,
  TG_UPLOAD_CHAT_ID,
  NODE_ENV,
});

/* -------------------- express -------------------- */
const app = express();

/* keep raw body for diagnostics if needed */
app.use(bodyParser.json({ limit: "25mb", verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(bodyParser.urlencoded({ extended: false, verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(bodyParser.text({ type: ["text/*", "application/octet-stream"], verify: (req, res, buf) => { req.rawBody = buf; } }));

/* -------------------- helpers -------------------- */

// key from request (CRM phones / amo poll)
function getIncomingKey(req) {
  const auth = req.headers["authorization"] || req.headers["Authorization"];
  if (auth) {
    const m = String(auth).match(/Bearer\s+(.+)/i);
    if (m) return m[1];
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

// optional wrapper (если используем RELAY_BASE_URL как прокси для записи)
function wrapRecordingUrl(url) {
  if (!RELAY_BASE_URL) return url;
  try {
    const u = new URL(url);
    const rb = new URL(RELAY_BASE_URL);
    if (u.hostname === rb.hostname && u.port === rb.port) return url;
  } catch {}
  return RELAY_BASE_URL + encodeURIComponent(url);
}

// проверка ключа для /amo/poll
function assertKey(req) {
  const got = (req.headers["authorization"] || req.headers["x-api-key"] || req.query.key || "")
    .toString()
    .replace(/^Bearer\s+/i,"");
  if (CRM_SHARED_KEY && got !== CRM_SHARED_KEY) throw new Error("bad key");
}

/* ---- ring buffer for last webhook events (diagnostics) ---- */
const LAST_EVENTS = [];
function pushEvent(ev) {
  LAST_EVENTS.push({ ts: new Date().toISOString(), ...ev });
  if (LAST_EVENTS.length > 200) LAST_EVENTS.shift();
}

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

// Timer: следим за HISTORY и чистим старые
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
    if (!slot.awaitingHistory && (now - slot.lastTs > CALL_TTL_MS)) {
      CALLS.delete(callId);
    }
  }
}, 60 * 1000);


/* -------------------- ROUTES: diagnostics -------------------- */

app.get("/", (_, res) => res.send("OK"));
app.get("/version", (_, res) => res.json({ version: VERSION }));

app.get("/diag/events", (_, res) =>
  res.json({ count: LAST_EVENTS.length, items: LAST_EVENTS.slice().reverse() })
);

app.get("/diag/stats", (_, res) => {
  res.json({
    version: VERSION,
    totals: STATS,
    calls_tracked: CALLS.size,
    whisper_key_loaded: !!OPENAI_API_KEY,
    telegram: {
      chat_id_set: !!TG_CHAT_ID,
      bot_token_set: !!TG_BOT_TOKEN,
    },
    amo_tokens: getAmoTokensMask(),
    supabase_enabled: !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_KEY,
    asr_state: getAsrState(),
    tg_queue: getTelegramQueuesState(),
  });
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

app.get("/diag/env", (req, res) => {
  res.json({
    VERSION,
    TG_BOT_TOKEN: !!TG_BOT_TOKEN,
    TG_CHAT_ID: TG_CHAT_ID ? (String(TG_CHAT_ID).slice(0,4) + "...") : "",
    OPENAI_API_KEY: !!OPENAI_API_KEY,
    CRM_SHARED_KEY: !!CRM_SHARED_KEY,
    AUTO_TRANSCRIBE,
    SHOW_CONTACT_EVENTS,
    TG_DIRECT_FETCH,
    RELAY_BASE_URL: !!RELAY_BASE_URL,
    TG_WEBHOOK_SECRET: !!TG_WEBHOOK_SECRET,
    TG_UPLOAD_CHAT_ID: !!TG_UPLOAD_CHAT_ID,
    ROUTE_SECRET: !!TELEGRAM.TG_SECRET,
    AMO_TOKENS_MASK: getAmoTokensMask(),
    SUPABASE_URL: !!process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
    AMO_POLL_MINUTES,
    AMO_POLL_LIMIT,
    AMO_BOOTSTRAP_LIMIT,
    bootstrapRemaining,
  });
});

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


/* -------------------- manual ASR /asr -------------------- */

app.all("/asr", async (req, res) => {
  try {
    const inKey = getIncomingKey(req);
    if (CRM_SHARED_KEY && String(inKey) !== String(CRM_SHARED_KEY)) {
      return res.status(401).json({ ok:false, error:"bad key" });
    }

    const url = (req.method === "GET" ? req.query.url : (req.body?.url || req.query?.url));
    if (!url) return res.status(400).json({ ok:false, error:"no url" });

    // через telegram relay, чтобы Railway мог скачать приватный mp3
    let relayCdnUrl;
    try {
      relayCdnUrl = await tgRelayAudio(
        url,
        `🎧 manual ASR relay`
      );
    } catch (e) {
      await sendTG("⚠️ relay через Telegram не удался, пробую напрямую.\n<code>" + (e?.message || e) + "</code>");
      relayCdnUrl = wrapRecordingUrl(String(url));
    }

    const text = await enqueueAsr(() => transcribeAudioFromUrl(relayCdnUrl, { callId: "manual" }));
    if (!text) return res.status(502).json({ ok:false, error:"asr failed" });

    await sendTG("📝 <b>Транскрипт</b> (manual):");
    for (const part of chunkText(text, 3500)) await sendTG(`<code>${part}</code>`);

    try {
      const qa = await analyzeTranscript(text, { callId: "manual", brand: process.env.CALL_QA_BRAND || "" });
      await sendTG(formatQaForTelegram(qa));
    } catch (e) {
      await sendTG("⚠️ Ошибка анализа QA: <code>"+(e?.message||e)+"</code>");
    }

    res.json({ ok:true, chars: text.length });
  } catch (e) {
    await sendTG(`❗️ /asr error: <code>${e?.message||e}</code>`);
    res.status(500).json({ ok:false, error:String(e) });
  }
});


/* -------------------- Telegram webhook: /tg/<secret> -------------------- */

app.post(`/tg/${TELEGRAM.TG_SECRET}`, async (req, res) => {
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

    // ловим голос/аудио/док
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
      // вариант: /asr <url>
      if (txt) {
        const m = txt.match(/^\/asr\s+(\S+)/i);
        if (m) {
          const url = m[1];
          await tgReply(chatId, "⏳ Беру по ссылке, расшифровываю…");

          let relayCdnUrl;
          try {
            relayCdnUrl = await tgRelayAudio(url, `🎧 tg /asr relay`);
          } catch (e) {
            await tgReply(chatId, "⚠️ relay через Telegram не удался, качаю напрямую.");
            relayCdnUrl = url;
          }

          const text = await enqueueAsr(() => transcribeAudioFromUrl(relayCdnUrl, { callId: "tg-cmd", fileName: "audio.ext" }));
          if (!text) { await tgReply(chatId, "❗️ Не смог расшифровать по ссылке."); return res.json({ ok:true }); }

          await tgReply(chatId, "📝 <b>Транскрипт</b>:\n<code>" + cap(text, 3500) + "</code>");
          try {
            const qa = await analyzeTranscript(text, { callId: "tg-cmd", brand: process.env.CALL_QA_BRAND || "" });
            await tgReply(chatId, formatQaForTelegram(qa));
          } catch (e) {
            await tgReply(chatId, "⚠️ Ошибка анализа QA: <code>"+(e?.message||e)+"</code>");
          }
          return res.json({ ok:true });
        }
      }
      await tgReply(chatId, "🧩 Пришли аудио (voice/audio/document) — я расшифрую и пришлю итоги.");
      return res.json({ ok:true });
    }

    // если файл прилетел в телегу
    await tgReply(chatId, "⏳ Скачиваю файл из Telegram, расшифровываю…");
    let fileUrl;
    try { fileUrl = await tgGetFileUrl(fileId); }
    catch (e) { await tgReply(chatId, "❗️ Не удалось получить file_path из Telegram."); return res.json({ ok:true }); }

    const text = await enqueueAsr(() => transcribeAudioFromUrl(fileUrl, { callId: "tg-file", fileName }));
    if (!text) { await tgReply(chatId, "❗️ Не удалось выполнить распознавание."); return res.json({ ok:true }); }

    for (const part of chunkText(text, 3500)) {
      await tgReply(chatId, "📝 <b>Транскрипт</b>:\n<code>"+part+"</code>");
    }
    try {
      const qa = await analyzeTranscript(text, { callId: "tg-file", brand: process.env.CALL_QA_BRAND || "" });
      await tgReply(chatId, formatQaForTelegram(qa));
    } catch (e) {
      await tgReply(chatId, "⚠️ Ошибка анализа QA: <code>"+(e?.message||e)+"</code>");
    }

    res.json({ ok:true });
  } catch (e) {
    console.error("TG webhook error:", e);
    try { if (TG_CHAT_ID) await sendTG("❗️ TG webhook error:\n<code>"+(e?.message||e)+"</code>"); } catch {}
    res.status(200).json({ ok:true });
  }
});

// ping helper
app.get("/tg/ping", async (req, res) => {
  const text = req.query.msg || "ping-from-railway";
  const ok = await sendTG("🔧 " + text);
  res.json({ ok });
});


/* -------------------- MegaPBX webhook (non-blocking)
   (если у тебя АТС уже не шлёт сюда - можно позже выпилить полностью,
    но я оставляю как было, просто чтобы не сломать импорты) -------------------- */

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

    // моментальный ответ для АТС
    res.json({ ok: true, type: normalized.type, callId: normalized.callId });

    // фон
    (async () => {
      try {
        if (normalized.cmd === "contact" && !SHOW_CONTACT_EVENTS) return;

        // 1) отправить описание звонка
        await sendTG(formatTgMegapbxMessage(normalized));

        // 2) если HISTORY/COMPLETED и есть аудио
        const firstAudio = normalized.recordInfo?.urls?.find(u => /\.(mp3|wav|ogg|m4a|opus)(\?|$)/i.test(u));
        const eventTypeUp = String(normalized.type).toUpperCase();

        if (firstAudio && (eventTypeUp === "HISTORY" || eventTypeUp === "COMPLETED")) {
          // метка в Supabase чтоб не дублить этот callId
          const source_type = "megapbx_call";
          const source_id   = String(normalized.callId || "");
          const seen = await isAlreadyProcessed(source_type, source_id);

          if (seen) {
            // уже делали этот звонок — не спамим второй раз
            return;
          }

          // relay через телегу → ссылка, доступная Railway
          let relayCdnUrl;
          try {
            relayCdnUrl = await tgRelayAudio(
              wrapRecordingUrl(firstAudio),
              `🎧 Авто-ASR relay CallID ${normalized.callId}\next: ${normalized.ext}`
            );
          } catch (e) {
            await sendTG("⚠️ relay через Telegram не удался, пробую без relay.\n<code>" + (e?.message||e) + "</code>");
            relayCdnUrl = wrapRecordingUrl(firstAudio);
          }

          // отправим сам файл/ссылку людям
          const capMsg =
            `🎧 Запись по звонку <code>${normalized.callId}</code>\n` +
            `От: <code>${normalized.from}</code> → Кому: <code>${normalized.to}</code>\n` +
            `ext: <code>${normalized.ext}</code>`;
          try {
            await sendTGDocument(wrapRecordingUrl(firstAudio), capMsg);
          } catch {
            await sendTG(capMsg + "\n" + wrapRecordingUrl(firstAudio));
          }

          if (AUTO_TRANSCRIBE) {
            try {
              const text = await enqueueAsr(() => transcribeAudioFromUrl(relayCdnUrl, { callId: normalized.callId }));
              if (text) {
                await sendTG(`📝 <b>Транскрипт</b> (CallID <code>${normalized.callId}</code>):`);
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
                  await sendTG(formatQaForTelegram(qa));
                } catch (e) {
                  await sendTG("❗️ Ошибка анализа (РОП): <code>" + (e?.message || e) + "</code>");
                }

                // помечаем в базе, чтоб не делать повтор
                await markProcessed(source_type, source_id, firstAudio);
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


/* -------------------- AmoCRM routes -------------------- */

// 1) обмен одноразового кода AMO_AUTH_CODE -> сохранить токены в память процесса
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

// 2) рефреш токена вручную (форс)
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

// 3) проверить аккаунт из AmoCRM
app.get("/amo/account", async (req, res) => {
  try {
    const j = await amoFetch("/api/v4/account");
    res.json({ ok:true, account: j });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// 4) последние звонки через сущность calls (если включена в Amo)
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

// 5) аггрегатор заметок call_in / call_out (для человека)
app.get("/amo/call-notes", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || "20", 10), 100);
    const page  = parseInt(req.query.page || "1", 10);

    const qs = `limit=${limit}&page=${page}&filter[note_type][]=call_in&filter[note_type][]=call_out`;

    // safe fetch helper
    const safeGet = async (path) => {
      try {
        const j = await amoFetch(path);
        return j || { _embedded: { notes: [] } };
      } catch (e) {
        const msg = String(e || "");
        if (msg.includes("204") || msg.includes("Unexpected end of JSON")) {
          return { _embedded: { notes: [] } };
        }
        throw e;
      }
    };

    const [leads, contacts, companies] = await Promise.all([
      safeGet(`/api/v4/leads/notes?${qs}`),
      safeGet(`/api/v4/contacts/notes?${qs}`),
      safeGet(`/api/v4/companies/notes?${qs}`)
    ]);

    const pull = (obj, kind) =>
      (obj?._embedded?.notes || []).map(n => ({
        entity: kind,
        note_id: n.id,
        note_type: n.note_type,
        text: n.params?.text || "",
        created_at: n.created_at,
        created_by: n.created_by,
        entity_id: n.entity_id,
        duration: n.params?.duration,
        phone: n.params?.phone || n.params?.uniq,
        service: n.params?.service,
        link: n.params?.link || n.params?.file || n.params?.record_link || "",
      }));

    const items = [
      ...pull(leads, "lead"),
      ...pull(contacts, "contact"),
      ...pull(companies, "company"),
    ].sort((a,b) => (b.created_at || 0) - (a.created_at || 0));

    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

// 6) poller-роут (cron/healthcheck дергает)
app.get("/amo/poll", async (req, res) => {
  try {
    assertKey(req);

    // если кто-то вручную дёрнул этот роут — используем те же правила лимита,
    // что и авто-пуллер ниже
    const maxNewToProcessThisTick = (bootstrapRemaining > 0)
      ? bootstrapRemaining
      : Infinity;

    const limit = Math.min(parseInt(req.query.limit || String(AMO_POLL_LIMIT),10), 100);

    const out = await processAmoCallNotes(
      limit,
      maxNewToProcessThisTick
    );

    if (bootstrapRemaining > 0 && out && typeof out.started === "number") {
      bootstrapRemaining = Math.max(0, bootstrapRemaining - out.started);
    }

    res.json({
      ok:true,
      ...out,
      bootstrapRemaining,
    });
  } catch (e) {
    res.status(401).json({ ok:false, error: String(e) });
  }
});


/* -------------------- fallback dump (any other route) -------------------- */

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


/* -------------------- auto Telegram webhook setup -------------------- */

async function setupTelegramWebhook() {
  try {
    if (!TG_BOT_TOKEN) {
      console.warn("❌ TG_BOT_TOKEN отсутствует, пропускаем setWebhook");
      return;
    }

    const base = (process.env.RAILWAY_STATIC_URL ||
                  process.env.RAILWAY_URL ||
                  process.env.RAILWAY_PROJECT_URL ||
                  process.env.PUBLIC_URL ||
                  process.env.APP_URL ||
                  "").replace(/\/+$/,"");

    if (!base) {
      console.warn("⚠️ Нет публичного URL (RAILWAY_URL/etc). Для ручной установки дерни POST /tg/setup c TG_WEBHOOK_SECRET.");
      return;
    }

    const webhookUrl = `${base}/tg/${TELEGRAM.TG_SECRET}`;
    console.log(`🔧 Попытка установки Telegram webhook на ${webhookUrl}`);

    const maxAttempts = 3;
    let attempt = 0;
    let lastErr = null;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const resp = await fetchWithTimeout(`https://api.telegram.org/bot${TG_BOT_TOKEN}/setWebhook`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url: webhookUrl, secret_token: TELEGRAM.TG_SECRET })
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
      await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
    }
    console.error("❌ Не удалось установить Telegram webhook:", lastErr);
  } catch (e) {
    console.error("❗ Ошибка setupTelegramWebhook:", e);
  }
}

// ручной сетап вебхука
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

// Авто попытка поставить вебхук на старте
setupTelegramWebhook();

/* -------------------- auto poll scheduler (Amo auto-pull) -------------------- */

if (AMO_POLL_MINUTES > 0) {
  console.log(
    `⏰ Amo auto-poll enabled: каждые ${AMO_POLL_MINUTES} мин, limit=${AMO_POLL_LIMIT}, bootstrap=${AMO_BOOTSTRAP_LIMIT}`
  );

  setInterval(async () => {
    try {
      // safety: не дёргаем если нет ключа безопасности или токенов amo
      if (!CRM_SHARED_KEY) {
        console.warn("⚠️ AMO poll skipped: CRM_SHARED_KEY is missing");
        return;
      }

      // считаем локальный лимит для этого прохода
      // если bootstrapRemaining > 0, значит это ещё тёплый старт -> режем объём
      // если уже 0, значит мы в нормальном режиме и можем хавать без ограничения
      const maxNewToProcessThisTick = (bootstrapRemaining > 0)
        ? bootstrapRemaining
        : Infinity;

      // processAmoCallNotes делает:
      // - достаёт последние call_in / call_out
      // - проверяет через supabase isAlreadyProcessed
      // - relay аудио через Telegram
      // - Whisper
      // - QA
      // - markProcessed в supabase
      const out = await processAmoCallNotes(
        AMO_POLL_LIMIT,
        maxNewToProcessThisTick
      );

      console.log("✅ amo auto-poll result:", {
        ...out,
        bootstrapRemaining_before: bootstrapRemaining,
      });

      // уменьшаем остаток "холодного старта"
      if (bootstrapRemaining > 0 && out && typeof out.started === "number") {
        bootstrapRemaining = Math.max(
          0,
          bootstrapRemaining - out.started
        );
      }

      // маленький отчёт в тг, но только если реально что-то нашли
      if (out && out.started > 0) {
        await sendTG(
          "📡 Авто-пулл AmoCRM:\n" +
          `• просканировано: ${out.scanned}\n` +
          `• с ссылкой на аудио: ${out.withLinks}\n` +
          `• расшифровано/оценено: ${out.started}\n` +
          `• bootstrapRemaining → ${bootstrapRemaining}`
        );
      }
    } catch (e) {
      console.error("❗ amo auto-poll error:", e?.message || e);
      try {
        await sendTG(
          "❗ Ошибка авто-пула AmoCRM:\n<code>" +
          (e?.message || e) +
          "</code>"
        );
      } catch (_) {}
    }
  }, AMO_POLL_MINUTES * 60 * 1000);
} else {
  console.log("⏸ Amo auto-poll disabled (AMO_POLL_MINUTES=0 or not set)");
}


/* -------------------- start server -------------------- */
const server = app.listen(PORT, () => console.log(`Smart AI Listener (${VERSION}) on :${PORT}`));

/* graceful shutdown: дождаться очередей */
async function gracefulShutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => console.log("HTTP server closed"));

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { tgWorkerRunning, tgQueueLength } = getTelegramQueuesState();
    const { asrActive, asrQueueLength } = getAsrState();

    if (!tgWorkerRunning && tgQueueLength === 0 && asrActive === 0 && asrQueueLength === 0) {
      break;
    }

    console.log("Waiting for background tasks to finish...", {
      tgQueueLength,
      asrQueueLength,
      asrActive
    });
    await new Promise(r => setTimeout(r, 500));
  }

  console.log("Shutdown complete.");
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
