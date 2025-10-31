// index.js — Smart AI Listener (v2.6.0-IRAZBIL)
// авто-поллер с автоспасателем: если withLinks=0 несколько тиков — форс-скан за последние RESCUE_SINCE_HOURS
// добавлен быстрый повтор при сетевых ошибках, прокидка force/since_epoch через /amo/poll

import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";

// ---- QA (аналитика звонков) ----
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

// ---- Telegram helpers ----
import {
  initTelegramEnv,
  TELEGRAM,
  sendTG,
  tgReply,
  tgGetFileUrl,
  tgRelayAudio,
} from "./telegram.js";

// ---- ASR ----
import { enqueueAsr, transcribeAudioFromUrl, getAsrState } from "./asr.js";

// ---- AmoCRM интеграция ----
import {
  processAmoCallNotes,
  amoFetch,
  amoRefresh,
  getAmoTokensMask,
  injectAmoTokens,
} from "./amo.js";

// ---- Утилиты ----
import { cap, fetchWithTimeout, mask } from "./utils.js";

// ---- Supabase flags/tokens ----
import { setSecret } from "./supabaseStore.js";

/* -------------------- ENV -------------------- */
const VERSION = "railway-2.6.0-irazbil";

const TG_BOT_TOKEN       = process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID         = process.env.TG_CHAT_ID || "";
const TG_WEBHOOK_SECRET  = (process.env.TG_WEBHOOK_SECRET || "").trim();
const TG_UPLOAD_CHAT_ID  = process.env.TG_UPLOAD_CHAT_ID || TG_CHAT_ID;
const NODE_ENV           = process.env.NODE_ENV || "development";

const CRM_SHARED_KEY     = process.env.CRM_SHARED_KEY || ""; // boxfield-qa-2025
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY || "";

const AMO_POLL_MINUTES   = parseInt(process.env.AMO_POLL_MINUTES || "10", 10);
const AMO_POLL_LIMIT     = parseInt(process.env.AMO_POLL_LIMIT   || "30", 10);

// rescue-настройки
const RESCUE_NO_LINKS_STREAK = parseInt(process.env.RESCUE_NO_LINKS_STREAK || "3", 10); // через сколько «пустых по ссылкам» тиков стартовать спасение
const RESCUE_SINCE_HOURS     = parseInt(process.env.RESCUE_SINCE_HOURS     || "24", 10); // глубина форс-скана
const RETRY_ON_ERROR_MS      = parseInt(process.env.RETRY_ON_ERROR_MS      || "30000", 10); // повтор через 30с при сетевой ошибке

// при старте ограничиваем, сколько "старых" звонков обработаем
const AMO_BOOTSTRAP_LIMIT = parseInt(process.env.AMO_BOOTSTRAP_LIMIT || "5", 10);
let bootstrapRemaining = AMO_BOOTSTRAP_LIMIT;

const PORT = process.env.PORT || 3000;

/* -------------------- INIT -------------------- */
initTelegramEnv({
  TG_BOT_TOKEN,
  TG_CHAT_ID,
  TG_WEBHOOK_SECRET,
  TG_UPLOAD_CHAT_ID,
  NODE_ENV,
});

const app = express();
app.use(bodyParser.json({ limit: "25mb" }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.text({ type: ["text/*", "application/octet-stream"] }));

/* -------------------- HELPERS -------------------- */
function assertKey(req) {
  const got =
    (req.headers["authorization"] ||
      req.headers["x-api-key"] ||
      req.query.key ||
      "") + "";
  const key = got.replace(/^Bearer\s+/i, "");
  if (CRM_SHARED_KEY && key !== CRM_SHARED_KEY) throw new Error("bad key");
}

/* -------------------- DIAG -------------------- */
app.get("/", (_ , res) => res.send("OK"));
app.get("/version", (_ , res) => res.json({ version: VERSION }));
app.get("/diag/env", (_ , res) =>
  res.json({
    version: VERSION,
    tg: !!TG_BOT_TOKEN,
    chat_id: TG_CHAT_ID,
    amo: getAmoTokensMask(),
    supabase: !!process.env.SUPABASE_URL,
    poll_minutes: AMO_POLL_MINUTES,
    poll_limit: AMO_POLL_LIMIT,
    bootstrapRemaining,
    rescue: {
      RESCUE_NO_LINKS_STREAK,
      RESCUE_SINCE_HOURS,
      RETRY_ON_ERROR_MS
    }
  })
);

/* -------------------- AMO: OAuth helpers (как было) -------------------- */
app.get("/amo/oauth/start", async (_req, res) => {
  // перенаправление делает фронт — оставим минималку
  res.status(200).send("Use your AmoCRM OAuth UI to obtain code; backend handles /amo/oauth/callback.");
});

app.get("/amo/oauth/callback", async (req, res) => {
  try {
    const j = {}; // теперь токены храним через amo.js; тут просто заглушка
    await sendTG("ℹ️ Оauth callback получен. Токены инжектятся отдельным маршрутом.");
    res.send(`<html><body style="font-family:system-ui">OK</body></html>`);
  } catch (e) {
    await sendTG(`❗️ OAuth callback error: <code>${e?.message || e}</code>`);
    res.status(500).send("oauth callback failed");
  }
});

app.get("/amo/refresh", async (_req, res) => {
  try {
    const j = await amoRefresh();
    await sendTG("🔄 Amo refresh ok " + mask(j?.access_token || ""));
    res.json({ ok: true });
  } catch (e) {
    await sendTG("❗️ refresh error: " + (e?.message || e));
    res.status(500).json({ ok: false });
  }
});

/* ---- Ручной пул Amo (с прокидкой force/since_epoch/bootstrap) ---- */
app.get("/amo/poll", async (req, res) => {
  try {
    assertKey(req);
    const limit = Math.min(parseInt(req.query.limit || AMO_POLL_LIMIT, 10), 200);
    const force = String(req.query.force || "0") === "1";
    const sinceEpoch = req.query.since_epoch ? parseInt(req.query.since_epoch, 10) : null;
    const bootstrapLimit = req.query.bootstrap ? Math.min(parseInt(req.query.bootstrap, 10), 500) : null;

    const out = await processAmoCallNotes(limit, bootstrapRemaining, {
      force,
      sinceEpochSec: sinceEpoch,
      bootstrapLimit
    });

    if (bootstrapRemaining > 0 && out && typeof out.started === "number") {
      bootstrapRemaining = Math.max(0, bootstrapRemaining - out.started);
    }
    res.json({ ok: true, ...out, bootstrapRemaining });
  } catch (e) {
    res.status(401).json({ ok: false, error: String(e) });
  }
});

/* ---- AMO DEBUG ---- */
app.get("/amo/debug/notes", async (req, res) => {
  try {
    assertKey(req);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);

    const [leads, contacts, companies] = await Promise.all([
      amoFetch(`/api/v4/leads/notes?limit=${limit}`),
      amoFetch(`/api/v4/contacts/notes?limit=${limit}`),
      amoFetch(`/api/v4/companies/notes?limit=${limit}`),
    ]);

    const pick = (entity, arr) => {
      const items = Array.isArray(arr?._embedded?.notes) ? arr._embedded.notes : [];
      return items.map(n => ({
        entity,
        id: n.id,
        note_type: n.note_type,
        created_at: n.created_at,
        has_text: !!(n.text || n.params?.text),
        duration: n.params?.duration || 0,
        link: n.params?.link || "",
      }));
    };

    const out = [
      ...pick("lead", leads),
      ...pick("contact", contacts),
      ...pick("company", companies),
    ].sort((a,b) => (b.created_at||0) - (a.created_at||0));

    res.json({ ok: true, count: out.length, items: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/amo/debug/raw", async (req, res) => {
  try {
    assertKey(req);
    const path = String(req.query.path || "");
    if (!path.startsWith("/")) return res.status(400).json({ ok:false, error:"path must start with /" });
    const j = await amoFetch(path);
    res.json(j);
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

/* -------------------- TELEGRAM WEBHOOK (коротко, без изменений логики) -------------------- */
app.post(`/tg/${TELEGRAM.TG_SECRET}`, async (req, res) => {
  try {
    const upd = req.body || {};
    const msg = upd.message || upd.edited_message || {};
    const chatId = msg.chat?.id;
    if (!chatId) return res.json({ ok: true });

    const txt = (msg.text || "").trim();
    if (txt.startsWith("/start") || txt.startsWith("/help")) {
      await tgReply(chatId, "👋 Пришли аудио (voice/audio/document) — я расшифрую и пришлю аналитику.");
      return res.json({ ok: true });
    }

    let fileId = null;
    let fileName = "audio.mp3";
    if (msg.voice)       { fileId = msg.voice.file_id;           fileName = "voice.ogg"; }
    else if (msg.audio)  { fileId = msg.audio.file_id;           fileName = msg.audio.file_name || "audio.mp3"; }
    else if (msg.document) {
      const name = msg.document.file_name || "file.bin";
      if (/\.(mp3|m4a|ogg|oga|opus|wav)$/i.test(name)) { fileId = msg.document.file_id; fileName = name; }
    }

    if (!fileId) {
      const m = txt.match(/^\/asr\s+(\S+)/i);
      if (m) {
        await tgReply(chatId, "⏳ Беру по ссылке, расшифровываю…");
        const inUrl = m[1];
        let relayCdnUrl;
        try { relayCdnUrl = await tgRelayAudio(inUrl, `🎧 tg /asr relay`); } catch { relayCdnUrl = inUrl; }
        const text = await enqueueAsr(() => transcribeAudioFromUrl(relayCdnUrl, { callId: "tg-cmd", fileName: "audio.ext" }));
        if (!text) { await tgReply(chatId, "❗️ Не смог расшифровать по ссылке."); return res.json({ ok: true }); }
        await tgReply(chatId, "📝 <b>Транскрипт</b>:\n<code>" + cap(text, 3500) + "</code>");
        try {
          const qa = await analyzeTranscript(text, { callId: "tg-cmd", brand: "iRazbil" });
          await tgReply(chatId, formatQaForTelegram(qa));
        } catch (e) {
          await tgReply(chatId, "⚠️ Ошибка анализа: <code>"+(e?.message||e)+"</code>");
        }
        return res.json({ ok: true });
      }
      await tgReply(chatId, "🧩 Отправь аудиофайл, чтобы я расшифровал.");
      return res.json({ ok: true });
    }

    await tgReply(chatId, "⏳ Расшифровываю...");
    const fileUrl = await tgGetFileUrl(fileId);
    const text = await enqueueAsr(() => transcribeAudioFromUrl(fileUrl, { callId: "tg-file", fileName }));
    if (!text) { await tgReply(chatId, "❗️ Ошибка распознавания."); return res.json({ ok: true }); }

    await tgReply(chatId, "📝 <b>Транскрипт</b>:\n<code>" + cap(text, 3500) + "</code>");
    try {
      const qa = await analyzeTranscript(text, { callId: "tg-file", brand: "iRazbil" });
      await tgReply(chatId, formatQaForTelegram(qa));
    } catch (e) {
      await tgReply(chatId, "⚠️ Ошибка анализа: <code>"+(e?.message||e)+"</code>");
    }
    res.json({ ok: true });
  } catch (e) {
    try { await sendTG("TG webhook error: " + (e?.message || e)); } catch {}
    res.status(200).json({ ok: true });
  }
});

/* -------------------- AUTO POLLER + RESCUE -------------------- */
let lastPollSummary = null;
let noLinksStreak = 0;
let inFlight = false;

async function doPoll({ force = false, sinceEpochSec = null, bootstrapLimit = null } = {}) {
  const limit = AMO_POLL_LIMIT;
  const out = await processAmoCallNotes(limit, bootstrapRemaining, { force, sinceEpochSec, bootstrapLimit });
  if (bootstrapRemaining > 0 && out && typeof out.started === "number") {
    bootstrapRemaining = Math.max(0, bootstrapRemaining - out.started);
  }
  // учёт спасателя
  if ((out.withLinks || 0) === 0) noLinksStreak++; else noLinksStreak = 0;
  lastPollSummary = out;
  return out;
}

if (AMO_POLL_MINUTES > 0) {
  console.log(`⏰ auto-poll каждые ${AMO_POLL_MINUTES} мин (limit=${AMO_POLL_LIMIT}, bootstrap=${AMO_BOOTSTRAP_LIMIT})`);

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      // обычный тик
      const out = await doPoll();
      // спасатель: если подряд нет ссылок RESCUE_NO_LINKS_STREAK раз — делаем форс-скан за последние RESCUE_SINCE_HOURS
      if (noLinksStreak >= RESCUE_NO_LINKS_STREAK) {
        const since = Math.floor((Date.now() - RESCUE_SINCE_HOURS * 3600 * 1000) / 1000);
        await sendTG(`🛟 Rescue: withLinks=0 уже ${noLinksStreak} тиков — форс-скан за ${RESCUE_SINCE_HOURS}ч`);
        await doPoll({ force: true, sinceEpochSec: since, bootstrapLimit: Math.max(200, AMO_POLL_LIMIT) });
        noLinksStreak = 0;
      }
      // лог для наглядности
      if (out && (out.started > 0 || out.withLinks > 0)) {
        await sendTG(
          `📡 Amo poll:\n` +
          `• scanned ${out.scanned}\n` +
          `• withLinks ${out.withLinks}\n` +
          `• started ${out.started}\n` +
          `• skipped ${out.skipped}\n` +
          `• ignored ${out.ignored}\n` +
          `• seenOnly ${out.seenOnly}`
        );
      }
    } catch (e) {
      console.error("[AMO] poll error:", e);
      try { await sendTG(`❗️ [auto] poll error: <code>${e?.message || e}</code>. Повтор через ${Math.round(RETRY_ON_ERROR_MS/1000)}с`); } catch {}
      // быстрый повтор при сетевых/временных ошибках
      setTimeout(async () => {
        try { await doPoll(); } catch {}
      }, RETRY_ON_ERROR_MS);
    } finally {
      inFlight = false;
    }
  };

  // первый запуск сразу + интервал
  tick();
  setInterval(tick, AMO_POLL_MINUTES * 60 * 1000);
} else {
  console.log("⏸ auto-poll disabled");
}

/* -------------------- START -------------------- */
app.listen(PORT, () => console.log(`Smart AI Listener (${VERSION}) listening on ${PORT}`));
