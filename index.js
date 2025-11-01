// index.js — Smart AI Listener (railway-2.7.3-irazbil-new-calls)
// Берём только новые звонки: пагинация page=1 → вверх, ручной since, ретраи на 429.
// Эндпоинты: /version, /diag/env, /amo/diag, /amo/debug/notes, /amo/since [GET/POST], /amo/since/penultimate [POST], /amo/poll

import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";

// ---- QA
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

// ---- Telegram
import {
  initTelegramEnv,
  TELEGRAM,
  sendTG,
  tgReply,
  tgGetFileUrl,
  tgRelayAudio,
} from "./telegram.js";

// ---- ASR
import { enqueueAsr, transcribeAudioFromUrl } from "./asr.js";

// ---- AmoCRM
import {
  processAmoCallNotes,
  amoFetch,
  amoRefresh,
  getAmoTokensMask,
  injectAmoTokens,
  getManualSince,
  setManualSince,
  setManualSinceToPenultimate,
  debugFetchRecentWithMeta,
} from "./amo.js";

// ---- Utils
import { cap, mask, fetchWithTimeout } from "./utils.js";

// ---- Supabase secrets
import { setSecret } from "./supabaseStore.js";

/* -------------------- ENV -------------------- */
const VERSION             = "railway-2.7.3-irazbil";

const TG_BOT_TOKEN        = process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID          = process.env.TG_CHAT_ID || "";
const TG_WEBHOOK_SECRET   = (process.env.TG_WEBHOOK_SECRET || "").trim();
const TG_UPLOAD_CHAT_ID   = process.env.TG_UPLOAD_CHAT_ID || TG_CHAT_ID;
const NODE_ENV            = process.env.NODE_ENV || "development";

const CRM_SHARED_KEY      = process.env.CRM_SHARED_KEY || "boxfield-qa-2025";

const AMO_POLL_MINUTES    = parseInt(process.env.AMO_POLL_MINUTES || "10", 10);
const AMO_POLL_LIMIT      = parseInt(process.env.AMO_POLL_LIMIT   || "30", 10);
let   bootstrapRemaining  = parseInt(process.env.AMO_BOOTSTRAP_LIMIT || "5", 10);

const PORT                = process.env.PORT || 3000;

// Amo OAuth env
const AMO_BASE_URL        = (process.env.AMO_BASE_URL || "").replace(/\/+$/,"");
const AMO_CLIENT_ID       = process.env.AMO_CLIENT_ID || "";
const AMO_CLIENT_SECRET   = process.env.AMO_CLIENT_SECRET || "";
const AMO_REDIRECT_URI    = process.env.AMO_REDIRECT_URI || "";

/* -------------------- SIMPLE PINGER -------------------- */
const SIMPLE_POLL_URL          = (process.env.SIMPLE_POLL_URL || "").trim();
const SIMPLE_POLL_INTERVAL_MIN = parseInt(process.env.SIMPLE_POLL_INTERVAL_MIN || "10", 10);
const SIMPLE_POLL_FORCE_HOURS  = parseInt(process.env.SIMPLE_POLL_FORCE_HOURS || "72", 10);

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
    simple_pinger: {
      enabled: !!SIMPLE_POLL_URL && SIMPLE_POLL_INTERVAL_MIN > 0,
      url: SIMPLE_POLL_URL,
      interval_min: SIMPLE_POLL_INTERVAL_MIN,
      force_hours: SIMPLE_POLL_FORCE_HOURS
    }
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

/* -------------------- AMO: POLL/FORCE/DEBUG/DIAG -------------------- */
app.get("/amo/poll", async (req, res) => {
  try {
    assertKey(req);
    const limit = Math.min(parseInt(req.query.limit || AMO_POLL_LIMIT, 10) || AMO_POLL_LIMIT, 300);
    const since = req.query.since ? parseInt(req.query.since, 10) : null;
    const manual = since || await getManualSince().catch(()=> null);
    const options = {};
    if (manual && Number.isFinite(manual) && manual > 0) {
      options.force = true;
      options.sinceEpochSec = manual;
      options.bootstrapLimit = limit;
    }
    const out = await processAmoCallNotes(limit, bootstrapRemaining, options);
    if (bootstrapRemaining > 0 && out && typeof out.started === "number") {
      bootstrapRemaining = Math.max(0, bootstrapRemaining - out.started);
    }
    res.json({ ok: true, ...out, bootstrapRemaining, since: manual || out?.since });
  } catch (e) {
    res.status(401).json({ ok: false, error: String(e) });
  }
});

app.get("/amo/diag", async (req, res) => {
  try {
    assertKey(req);
    const manual_since = await getManualSince().catch(()=> null);
    res.json({ ok: true, version: VERSION, manual_since });
  } catch (e) {
    res.status(401).json({ ok:false, error: String(e) });
  }
});

app.get("/amo/debug/notes", async (req, res) => {
  try {
    assertKey(req);
    const limit = Math.min(parseInt(req.query.limit || "50", 10), 100);
    const j = await debugFetchRecentWithMeta(limit);
    res.json(j);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

/* ----- Ручной курсор: GET — посмотреть, POST — установить, /penultimate — на предпоследний ----- */
app.get("/amo/since", async (req, res) => {
  try {
    assertKey(req);
    const manual_since = await getManualSince().catch(()=> null);
    res.json({ ok: true, manual_since });
  } catch (e) {
    res.status(401).json({ ok:false, error:String(e) });
  }
});

app.post("/amo/since", async (req, res) => {
  try {
    assertKey(req);
    const since = parseInt(req.body?.since ?? req.query.since ?? "0", 10) || 0;
    if (!since) return res.status(400).json({ ok:false, error:"since required (unix sec)" });
    await setManualSince(since);
    res.json({ ok:true, manual_since: since });
  } catch (e) {
    res.status(401).json({ ok:false, error:String(e) });
  }
});

app.post("/amo/since/penultimate", async (req, res) => {
  try {
    assertKey(req);
    const manual_since = await setManualSinceToPenultimate();
    res.json({ ok:true, manual_since, source:"penultimate" });
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

/* -------------------- AUTO / WATCHDOG / PINGER -------------------- */
const SELF_HTTP_POLL   = (process.env.SELF_HTTP_POLL || "1") === "1";
const BACKFILL_ENABLED = (process.env.BACKFILL_ENABLED || "1") === "1";
const WATCHDOG_ENABLED = (process.env.WATCHDOG_ENABLED || "1") === "1";

let lastTickAt = 0;
let lastStartedAt = 0;
let lastWithLinksAt = 0;

async function runTick(kind = "regular") {
  try {
    const manual = await getManualSince().catch(()=> null);
    const out = await processAmoCallNotes(AMO_POLL_LIMIT, bootstrapRemaining, manual ? { force:true, sinceEpochSec: manual, bootstrapLimit: AMO_POLL_LIMIT } : {});
    lastTickAt = Date.now();
    if (out.started > 0) lastStartedAt = Date.now();
    if (out.withLinks > 0) lastWithLinksAt = Date.now();
    console.log(`[AMO] ${kind} tick -> since=${manual || out?.since} scanned=${out.scanned} withLinks=${out.withLinks} started=${out.started}`);
    if (out.started > 0) { try { await sendTG(`📡 AMO ${kind} tick: scanned ${out.scanned}, withLinks ${out.withLinks}, started ${out.started}`); } catch {} }
    return out;
  } catch (e) {
    console.error(`[AMO] ${kind} tick error:`, e);
    try { await sendTG(`❗️ AMO ${kind} tick error: <code>${e?.message || e}</code>`); } catch {}
    throw e;
  }
}

async function runHttpSelfPoll() {
  const manual = await getManualSince().catch(()=> null);
  const u = new URL(`http://127.0.0.1:${PORT}/amo/poll`);
  u.searchParams.set("key", CRM_SHARED_KEY);
  u.searchParams.set("limit", String(AMO_POLL_LIMIT));
  if (manual) u.searchParams.set("since", String(manual));
  try {
    const r = await fetch(u.toString());
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

function buildSimplePollUrl() {
  if (!SIMPLE_POLL_URL) return null;
  try {
    const u = new URL(SIMPLE_POLL_URL);
    // внешний пингер может сам ставить since
    return u.toString();
  } catch {
    return SIMPLE_POLL_URL;
  }
}

async function simplePingOnce(kind = "simple") {
  const url = buildSimplePollUrl();
  if (!url) return;
  try {
    const r = await fetch(url);
    let j = null;
    try { j = await r.json(); } catch {}
    const msg = `[PING] ${kind} -> ${r.status}` + (j ? ` scanned=${j.scanned||0} withLinks=${j.withLinks||0} started=${j.started||0}` : "");
    console.log(msg);
    try { await sendTG(`✅ ${msg}`); } catch {}
  } catch (e) {
    const msg = `[PING] ${kind} error: ${e?.message || e}`;
    console.warn(msg);
    try { await sendTG(`❗️ ${msg}`); } catch {}
  }
}

/* schedule */
if (AMO_POLL_MINUTES > 0) {
  console.log(`⏰ auto-poll каждые ${AMO_POLL_MINUTES} мин (limit=${AMO_POLL_LIMIT})`);
  runTick("boot").catch(()=>{});
  setInterval(() => { runTick("regular").catch(()=>{}); }, AMO_POLL_MINUTES * 60 * 1000);

  if (SELF_HTTP_POLL) {
    setInterval(() => { runHttpSelfPoll(); }, AMO_POLL_MINUTES * 60 * 1000);
  }

  if (BACKFILL_ENABLED) {
    setInterval(async () => {
      try {
        const manual = await getManualSince().catch(()=> null);
        const since = manual || Math.floor((Date.now() - 6*3600*1000) / 1000);
        const out = await processAmoCallNotes(AMO_POLL_LIMIT, bootstrapRemaining, { force:true, sinceEpochSec: since, bootstrapLimit: AMO_POLL_LIMIT });
        console.log(`[AMO] soft-backfill -> scanned=${out.scanned} withLinks=${out.withLinks} started=${out.started}`);
        if (out.started > 0) lastStartedAt = Date.now();
        if (out.withLinks > 0) lastWithLinksAt = Date.now();
      } catch (e) {
        console.warn(`[AMO] soft-backfill error:`, e?.message || e);
      }
    }, 15 * 60 * 1000);
  }

  if (WATCHDOG_ENABLED) {
    function minutes(ms){ return Math.floor(ms/60000); }
    setInterval(async () => {
      const now = Date.now();
      const noLinksMin   = lastWithLinksAt ? minutes(now - lastWithLinksAt) : Infinity;
      const noStartedMin = lastStartedAt   ? minutes(now - lastStartedAt)   : Infinity;
      if (noLinksMin >= 20 && noStartedMin >= 20) {
        try { await sendTG(`🛠 Watchdog: не было активности ${Math.min(noLinksMin, noStartedMin)} мин — форс-скан.`); } catch {}
        try {
          const manual = await getManualSince().catch(()=> null);
          const since = manual || Math.floor((Date.now() - 6*3600*1000) / 1000);
          const out = await processAmoCallNotes(AMO_POLL_LIMIT, bootstrapRemaining, { force:true, sinceEpochSec: since, bootstrapLimit: AMO_POLL_LIMIT });
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
