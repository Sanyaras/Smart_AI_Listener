// index.js — Smart AI Listener (v2.6.2-IRAZBIL)
// Архитектура: telegram / asr / amo / supabaseStore / utils / qa_assistant
// Фичи:
//  • Автопуллер Amo по расписанию (AMO_POLL_MINUTES) + self-HTTP тик
//  • Watchdog + мягкий backfill (лечит «молчание»/пропуски)
//  • Эндпоинты: /amo/poll, /amo/force, /amo/cursors, /amo/diag, /amo/debug/*
//  • Стабильный OAuth-флоу + сохранение токенов в Supabase

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

// ---- ASR очередь/распознавание ----
import {
  enqueueAsr,
  transcribeAudioFromUrl,
} from "./asr.js";

// ---- AmoCRM интеграция (надёжный поллер) ----
import {
  processAmoCallNotes,
  amoFetch,
  amoRefresh,
  getAmoTokensMask,
  injectAmoTokens,
} from "./amo.js";

// ---- Утилиты/сетевые ----
import {
  cap,
  mask,
  fetchWithTimeout,
} from "./utils.js";

// ---- Supabase tokens/flags ----
import {
  setSecret,
  getSecret,
} from "./supabaseStore.js";

/* -------------------- ENV -------------------- */
const VERSION             = "railway-2.6.2-irazbil";

const TG_BOT_TOKEN        = process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID          = process.env.TG_CHAT_ID || "";
const TG_WEBHOOK_SECRET   = (process.env.TG_WEBHOOK_SECRET || "").trim();
const TG_UPLOAD_CHAT_ID   = process.env.TG_UPLOAD_CHAT_ID || TG_CHAT_ID;
const NODE_ENV            = process.env.NODE_ENV || "development";

const CRM_SHARED_KEY      = process.env.CRM_SHARED_KEY || "boxfield-qa-2025";

const RELAY_BASE_URL      = process.env.RELAY_BASE_URL || "";
const TG_DIRECT_FETCH     = process.env.TG_DIRECT_FETCH === "1";

const AMO_POLL_MINUTES    = parseInt(process.env.AMO_POLL_MINUTES || "10", 10);
const AMO_POLL_LIMIT      = parseInt(process.env.AMO_POLL_LIMIT   || "200", 10);
let   bootstrapRemaining  = parseInt(process.env.AMO_BOOTSTRAP_LIMIT || "5", 10);

const PORT                = process.env.PORT || 3000;

// OAuth env (для /amo/oauth/*)
const AMO_BASE_URL        = (process.env.AMO_BASE_URL || "").replace(/\/+$/,"");
const AMO_CLIENT_ID       = process.env.AMO_CLIENT_ID || "";
const AMO_CLIENT_SECRET   = process.env.AMO_CLIENT_SECRET || "";
const AMO_REDIRECT_URI    = process.env.AMO_REDIRECT_URI || "";

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
  const raw = (req.headers["authorization"] || req.headers["x-api-key"] || req.query.key || "") + "";
  const key = raw.replace(/^Bearer\s+/i, "");
  if (CRM_SHARED_KEY && key !== CRM_SHARED_KEY) throw new Error("bad key");
}
function ensureAmoOauthEnv() {
  if (!AMO_BASE_URL || !AMO_CLIENT_ID || !AMO_CLIENT_SECRET || !AMO_REDIRECT_URI) {
    throw new Error("AMO OAuth env incomplete (AMO_BASE_URL / AMO_CLIENT_ID / AMO_CLIENT_SECRET / AMO_REDIRECT_URI)");
  }
}

/* -------------------- BASIC/DIAG -------------------- */
app.get("/", (_, res) => res.send("OK"));
app.get("/version", (_, res) => res.json({ version: VERSION }));
app.get("/diag/env", async (_, res) => {
  res.json({
    version: VERSION,
    tg: !!TG_BOT_TOKEN,
    chat_id: TG_CHAT_ID,
    amo: getAmoTokensMask(),
    supabase: !!process.env.SUPABASE_URL,
    poll_minutes: AMO_POLL_MINUTES,
    poll_limit: AMO_POLL_LIMIT,
    bootstrapRemaining,
  });
});

/* -------------------- AMO OAUTH -------------------- */
app.get("/amo/oauth/start", async (_req, res) => {
  try {
    ensureAmoOauthEnv();
    const state = crypto.randomBytes(16).toString("hex");
    const url =
      `${AMO_BASE_URL}/oauth?` +
      `client_id=${encodeURIComponent(AMO_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(AMO_REDIRECT_URI)}` +
      `&response_type=code&mode=post_message&state=${encodeURIComponent(state)}`;
    res.redirect(url);
  } catch (e) {
    try { await sendTG(`❗️ OAuth start error: <code>${e?.message || e}</code>`); } catch {}
    res.status(500).send("oauth start failed");
  }
});

app.get("/amo/oauth/callback", async (req, res) => {
  try {
    ensureAmoOauthEnv();
    const code = String(req.query.code || "");
    if (!code) throw new Error("code is missing");

    const tokenUrl = `${AMO_BASE_URL}/oauth2/access_token`;
    const body = {
      client_id: AMO_CLIENT_ID,
      client_secret: AMO_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: AMO_REDIRECT_URI,
    };

    const r = await fetchWithTimeout(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, 20000);

    const text = await r.text();
    if (!r.ok) {
      try { await sendTG(`❗️ OAuth exchange failed: <code>${text}</code>`); } catch {}
      return res.status(400).send("oauth exchange failed");
    }
    const j = JSON.parse(text);
    const access  = j.access_token  || "";
    const refresh = j.refresh_token || "";
    if (!access || !refresh) throw new Error("empty tokens in response");

    await setSecret("AMO_ACCESS_TOKEN", access).catch(()=>{});
    await setSecret("AMO_REFRESH_TOKEN", refresh).catch(()=>{});
    try { await injectAmoTokens(access, refresh); } catch {}

    try {
      await sendTG(
        "✅ <b>AmoCRM авторизация завершена</b>\n" +
        `• access: <code>${mask(access)}</code>\n` +
        `• refresh: <code>${mask(refresh)}</code>`
      );
    } catch {}
    res.send(`<html><body style="font-family:system-ui"><h3>Готово ✅</h3><p>Токены сохранены, слушатель подключён.</p></body></html>`);
  } catch (e) {
    try { await sendTG(`❗️ OAuth callback error: <code>${e?.message || e}</code>`); } catch {}
    res.status(500).send("oauth callback failed");
  }
});

app.get("/amo/refresh", async (_req, res) => {
  try {
    const j = await amoRefresh();
    try { await sendTG("🔄 Amo refresh ok " + mask(j.access_token)); } catch {}
    res.json({ ok: true });
  } catch (e) {
    try { await sendTG("❗️ refresh error: " + (e?.message || e)); } catch {}
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* -------------------- AMO: POLL/FORCE/CURSORS/DEBUG -------------------- */
// ручной tail-скан + опции
app.get("/amo/poll", async (req, res) => {
  try {
    assertKey(req);
    const limit = Math.min(parseInt(req.query.limit || AMO_POLL_LIMIT, 10) || AMO_POLL_LIMIT, 300);
    const since = req.query.since ? parseInt(req.query.since, 10) : 0;
    const options = {};
    if (!Number.isNaN(since) && since > 0) {
      options.force = true;
      options.sinceEpochSec = since;
      options.bootstrapLimit = limit;
    }
    const out = await processAmoCallNotes(limit, bootstrapRemaining, options);
    if (bootstrapRemaining > 0 && out && typeof out.started === "number") {
      bootstrapRemaining = Math.max(0, bootstrapRemaining - out.started);
    }
    res.json({ ok: true, ...out, bootstrapRemaining });
  } catch (e) {
    res.status(401).json({ ok: false, error: String(e) });
  }
});

// форс-бэкфилл за N часов
app.get("/amo/force", async (req, res) => {
  try {
    assertKey(req);
    const hours = Math.max(1, Math.min(parseInt(req.query.hours || "24", 10), 72));
    const limit = Math.min(parseInt(req.query.limit || "200", 10), 500);
    const since = Math.max(0, Math.floor(Date.now()/1000) - hours*3600);
    const out = await processAmoCallNotes(limit, 999999, { force: true, sinceEpochSec: since, bootstrapLimit: limit });
    res.json({ ok: true, forced: true, hours, limit, ...out });
  } catch (e) {
    res.status(401).json({ ok: false, error: String(e) });
  }
});

// курсоры
app.get("/amo/cursors", async (req, res) => {
  try {
    assertKey(req);
    const [lead, contact, company] = await Promise.all([
      getSecret("amo_cursor_lead_notes_created_at"),
      getSecret("amo_cursor_contact_notes_created_at"),
      getSecret("amo_cursor_company_notes_created_at"),
    ]);
    res.json({ ok:true, cursors: { lead, contact, company }});
  } catch (e) {
    res.status(401).json({ ok:false, error: String(e) });
  }
});

// debug
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
        entity_id: n.entity_id,
        params_keys: n.params ? Object.keys(n.params).slice(0, 20) : [],
        has_link: !!(n?.params?.link),
      }));
    };
    const out = [
      ...pick("lead",     leads),
      ...pick("contact",  contacts),
      ...pick("company",  companies),
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

/* -------------------- TELEGRAM WEBHOOK -------------------- */
app.post(`/tg/${TELEGRAM.TG_SECRET}`, async (req, res) => {
  try {
    const upd = req.body || {};
    const msg = upd.message || upd.edited_message || {};
    const chatId = msg?.chat?.id;
    if (!chatId) return res.json({ ok: true });

    const txt = (msg.text || "").trim();
    if (txt.startsWith("/start") || txt.startsWith("/help")) {
      await tgReply(chatId, "👋 Пришли аудио (voice/audio/document) — я расшифрую и пришлю аналитику.");
      return res.json({ ok: true });
    }

    let fileId = null;
    let fileName = "audio.mp3";
    if (msg.voice) {
      fileId = msg.voice.file_id;
      fileName = "voice.ogg";
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
      fileName = msg.audio.file_name || "audio.mp3";
    } else if (msg.document) {
      const name = msg.document.file_name || "file.bin";
      if (/\.(mp3|m4a|ogg|oga|opus|wav|webm|aac)$/i.test(name)) {
        fileId = msg.document.file_id;
        fileName = name;
      }
    }

    if (!fileId) {
      const m = txt.match(/^\/asr\s+(\S+)/i);
      if (m) {
        const inUrl = m[1];
        await tgReply(chatId, "⏳ Беру по ссылке, расшифровываю…");
        let relayCdnUrl;
        try { relayCdnUrl = await tgRelayAudio(inUrl, `🎧 tg /asr relay`); } catch { relayCdnUrl = inUrl; }
        const text = await enqueueAsr(() => transcribeAudioFromUrl(relayCdnUrl, { callId: "tg-cmd", fileName: "audio.ext" }));
        if (!text) { await tgReply(chatId, "❗️ Не смог расшифровать по ссылке."); return res.json({ ok: true }); }
        await tgReply(chatId, "📝 <b>Транскрипт</b>:\n<code>" + cap(text, 3500) + "</code>");
        try { const qa = await analyzeTranscript(text, { callId: "tg-cmd", brand: "iRazbil" }); await tgReply(chatId, formatQaForTelegram(qa)); } catch (e) { await tgReply(chatId, "⚠️ Ошибка анализа: <code>"+(e?.message||e)+"</code>"); }
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
    try { const qa = await analyzeTranscript(text, { callId: "tg-file", brand: "iRazbil" }); await tgReply(chatId, formatQaForTelegram(qa)); }
    catch (e) { await tgReply(chatId, "⚠️ Ошибка анализа: <code>"+(e?.message||e)+"</code>"); }
    res.json({ ok: true });
  } catch (e) {
    console.error("TG webhook error:", e);
    try { await sendTG("TG webhook error: " + (e?.message || e)); } catch {}
    res.status(200).json({ ok: true });
  }
});

/* -------------------- AUTO / WATCHDOG / HTTP-SELF -------------------- */
const SELF_HTTP_POLL   = (process.env.SELF_HTTP_POLL || "1") === "1";   // локальный GET на /amo/poll
const BACKFILL_ENABLED = (process.env.BACKFILL_ENABLED || "1") === "1"; // периодический soft backfill
const WATCHDOG_ENABLED = (process.env.WATCHDOG_ENABLED || "1") === "1"; // форс, если тишина

let lastTickAt = 0;        // ms
let lastStartedAt = 0;     // ms (были обработанные звонки)
let lastWithLinksAt = 0;   // ms (были записи/ссылки)

async function runTick(kind = "regular") {
  try {
    const out = await processAmoCallNotes(AMO_POLL_LIMIT, bootstrapRemaining);
    lastTickAt = Date.now();
    if (out.started > 0) lastStartedAt = Date.now();
    if (out.withLinks > 0) lastWithLinksAt = Date.now();
    console.log(`[AMO] ${kind} tick -> scanned=${out.scanned} withLinks=${out.withLinks} started=${out.started}`);
    if (out.started > 0) { try { await sendTG(`📡 AMO ${kind} tick: scanned ${out.scanned}, withLinks ${out.withLinks}, started ${out.started}`); } catch {} }
    return out;
  } catch (e) {
    console.error(`[AMO] ${kind} tick error:`, e);
    try { await sendTG(`❗️ AMO ${kind} tick error: <code>${e?.message || e}</code>`); } catch {}
    throw e;
  }
}

// self-HTTP тик — имитируем ручной клик /amo/poll
async function runHttpSelfPoll() {
  const url = `http://127.0.0.1:${PORT}/amo/poll?key=${encodeURIComponent(CRM_SHARED_KEY)}&limit=${AMO_POLL_LIMIT}`;
  try {
    const r = await fetch(url);
    const j = await r.json().catch(()=> ({}));
    lastTickAt = Date.now();
    if (j.started > 0) lastStartedAt = Date.now();
    if (j.withLinks > 0) lastWithLinksAt = Date.now();
    console.log(`[AMO] self-http tick -> scanned=${j.scanned} withLinks=${j.withLinks} started=${j.started}`);
    return j;
  } catch (e) {
    console.error(`[AMO] self-http tick error:`, e?.message || e);
  }
}

function minutes(ms){ return Math.floor(ms/60000); }

if (AMO_POLL_MINUTES > 0) {
  console.log(`⏰ auto-poll каждые ${AMO_POLL_MINUTES} мин (limit=${AMO_POLL_LIMIT}, bootstrap=${bootstrapRemaining})`);

  // Немедленный запуск после старта контейнера
  runTick("boot").catch(()=>{});

  // Регулярный in-process тик
  setInterval(() => { runTick("regular").catch(()=>{}); }, AMO_POLL_MINUTES * 60 * 1000);

  // Параллельно self-HTTP тик (на некоторых платформах надёжнее)
  if (SELF_HTTP_POLL) {
    setInterval(() => { runHttpSelfPoll(); }, AMO_POLL_MINUTES * 60 * 1000);
  }

  // Периодический мягкий backfill (раз в 15 минут) — добирает «поздние» ссылки
  if (BACKFILL_ENABLED) {
    setInterval(async () => {
      try {
        const since = Math.floor((Date.now() - 6*3600*1000) / 1000); // 6 часов назад
        const out = await processAmoCallNotes(AMO_POLL_LIMIT, bootstrapRemaining, {
          force: true,
          sinceEpochSec: since,
          bootstrapLimit: AMO_POLL_LIMIT
        });
        console.log(`[AMO] soft-backfill -> scanned=${out.scanned} withLinks=${out.withLinks} started=${out.started}`);
        if (out.started > 0) lastStartedAt = Date.now();
        if (out.withLinks > 0) lastWithLinksAt = Date.now();
      } catch (e) {
        console.warn(`[AMO] soft-backfill error:`, e?.message || e);
      }
    }, 15 * 60 * 1000);
  }

  // Watchdog: если 20 минут нет withLinks/started — форсим скан за 6ч
  if (WATCHDOG_ENABLED) {
    setInterval(async () => {
      const now = Date.now();
      const noLinksMin   = lastWithLinksAt ? minutes(now - lastWithLinksAt) : Infinity;
      const noStartedMin = lastStartedAt   ? minutes(now - lastStartedAt)   : Infinity;
      if (noLinksMin >= 20 && noStartedMin >= 20) {
        try { await sendTG(`🛠 Watchdog: не было активности ${Math.min(noLinksMin, noStartedMin)} мин — форс-скан за 6ч.`); } catch {}
        const since = Math.floor((Date.now() - 6*3600*1000) / 1000);
        try {
          const out = await processAmoCallNotes(AMO_POLL_LIMIT, bootstrapRemaining, {
            force: true,
            sinceEpochSec: since,
            bootstrapLimit: AMO_POLL_LIMIT
          });
          console.log(`[AMO] watchdog-force -> scanned=${out.scanned} withLinks=${out.withLinks} started=${out.started}`);
          if (out.started > 0) lastStartedAt = Date.now();
          if (out.withLinks > 0) lastWithLinksAt = Date.now();
        } catch (e) {
          console.warn(`[AMO] watchdog-force error:`, e?.message || e);
        }
      }
    }, 5 * 60 * 1000);
  }
} else {
  console.log("⏸ auto-poll disabled");
}

/* -------------------- SERVER -------------------- */
app.listen(PORT, () => {
  console.log(`Smart AI Listener (${VERSION}) listening on ${PORT}`);
});

 
