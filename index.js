// index.js — Smart AI Listener (manual-since watermark + simple pinger) v3.2-IRAZBIL
// Режим "как руками": /amo/poll читает since из watermark (amo_manual_since) или из query.
// После удачной обработки максимально сдвигаем watermark вперёд. Никаких "старых" хвостов.
// Есть автопингер, который жмёт *ровно ту же* ссылку (без since) — сервер сам подставит watermark.

// --- deps
import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";

// QA
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

// Telegram
import {
  initTelegramEnv,
  TELEGRAM,
  sendTG,
  tgReply,
  tgGetFileUrl,
  tgRelayAudio,
} from "./telegram.js";

// ASR
import { enqueueAsr, transcribeAudioFromUrl } from "./asr.js";

// Amo simple poller (+ watermark utils)
import {
  processAmoCallNotes,
  amoRefresh,
  getAmoTokensMask,
  injectAmoTokens,
  getManualSince,
  setManualSinceForwardOnly,
  bumpManualSince,
  resetManualSinceFromHours,
} from "./amo.js";

// utils + secrets
import { cap, mask, fetchWithTimeout } from "./utils.js";
import { setSecret } from "./supabaseStore.js";

/* -------------------- ENV -------------------- */
const VERSION = "railway-3.2-irazbil";

const TG_BOT_TOKEN      = process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID        = process.env.TG_CHAT_ID || "";
const TG_WEBHOOK_SECRET = (process.env.TG_WEBHOOK_SECRET || "").trim();
const TG_UPLOAD_CHAT_ID = process.env.TG_UPLOAD_CHAT_ID || TG_CHAT_ID;
const NODE_ENV          = process.env.NODE_ENV || "production";

const CRM_SHARED_KEY    = process.env.CRM_SHARED_KEY || "boxfield-qa-2025";
const PORT              = process.env.PORT || 3000;

// OAuth env (для /amo/oauth/*)
const AMO_BASE_URL      = (process.env.AMO_BASE_URL || "").replace(/\/+$/,"");
const AMO_CLIENT_ID     = process.env.AMO_CLIENT_ID || "";
const AMO_CLIENT_SECRET = process.env.AMO_CLIENT_SECRET || "";
const AMO_REDIRECT_URI  = process.env.AMO_REDIRECT_URI || "";

/* ---- SIMPLE PINGER ----
   Пример: SIMPLE_POLL_URL="https://<host>/amo/poll?key=boxfield-qa-2025&limit=200"
   ВАЖНО: без &since — сервер сам подставит watermark.
*/
const SIMPLE_POLL_URL          = (process.env.SIMPLE_POLL_URL || "").trim();
const SIMPLE_POLL_INTERVAL_MIN = parseInt(process.env.SIMPLE_POLL_INTERVAL_MIN || "0", 10); // 0 = off

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
app.get("/diag/env", async (_req, res) => {
  const since = await getManualSince().catch(()=> null);
  res.json({
    version: VERSION,
    tg: !!TG_BOT_TOKEN,
    chat_id: TG_CHAT_ID,
    amo_tokens: getAmoTokensMask(),
    manual_since: since,
    simple_pinger: {
      enabled: !!SIMPLE_POLL_URL && SIMPLE_POLL_INTERVAL_MIN > 0,
      url: SIMPLE_POLL_URL,
      interval_min: SIMPLE_POLL_INTERVAL_MIN,
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

/* -------------------- AMO: SINCE WATERMARK API -------------------- */
app.get("/amo/since/get", async (req, res) => {
  try { assertKey(req); const v = await getManualSince(); res.json({ ok:true, manual_since:v }); }
  catch(e){ res.status(401).json({ ok:false, error:String(e) }); }
});
app.post("/amo/since/set", async (req, res) => {
  try {
    assertKey(req);
    const v = parseInt(req.query.value ?? req.body?.value ?? "", 10);
    if (!Number.isFinite(v) || v <= 0) return res.status(400).json({ ok:false, error:"value must be UNIX sec" });
    const out = await setManualSinceForwardOnly(v);
    res.json({ ok:true, manual_since: out });
  } catch(e){ res.status(401).json({ ok:false, error:String(e) }); }
});
app.post("/amo/since/bump", async (req, res) => {
  try {
    assertKey(req);
    const sec = parseInt(req.query.seconds ?? req.body?.seconds ?? "0", 10);
    if (!Number.isFinite(sec) || sec <= 0) return res.status(400).json({ ok:false, error:"seconds > 0" });
    const out = await bumpManualSince(sec);
    res.json({ ok:true, manual_since: out });
  } catch(e){ res.status(401).json({ ok:false, error:String(e) }); }
});
app.post("/amo/since/reset", async (req, res) => {
  try {
    assertKey(req);
    const hours = parseInt(req.query.hours ?? req.body?.hours ?? "24", 10);
    if (!Number.isFinite(hours) || hours <= 0) return res.status(400).json({ ok:false, error:"hours > 0" });
    const out = await resetManualSinceFromHours(hours);
    res.json({ ok:true, manual_since: out, from_hours: hours });
  } catch(e){ res.status(401).json({ ok:false, error:String(e) }); }
});

/* -------------------- AMO: POLL (как при ручном клике) -------------------- */
app.get("/amo/poll", async (req, res) => {
  try {
    assertKey(req);
    const limit = Math.min(parseInt(req.query.limit || "200", 10) || 200, 300);

    // приоритет: query.since -> watermark
    const sinceQuery = req.query.since ? Math.max(0, parseInt(req.query.since, 10) || 0) : null;
    const sinceBase  = sinceQuery || (await getManualSince());
    const out = await processAmoCallNotes(limit, { sinceEpochSec: sinceBase });

    // аккуратно двигаем watermark вперёд (только если реально что-то увидели/сканировали)
    if (out && out.maxCreatedAt) {
      await setManualSinceForwardOnly(out.maxCreatedAt);
    } else if (sinceQuery && !sinceBase) {
      // впервые поставили руками — зафиксируем
      await setManualSinceForwardOnly(sinceQuery);
    }

    res.json({ ok: true, since_used: sinceBase || null, ...out });
  } catch (e) {
    res.status(401).json({ ok: false, error: String(e) });
  }
});

/* -------------------- TELEGRAM WEBHOOK (по желанию) -------------------- */
app.post(`/tg/${TELEGRAM.TG_SECRET}`, async (req, res) => {
  try {
    const upd = req.body || {};
    const msg = upd.message || upd.edited_message || {};
    const chatId = msg?.chat?.id;
    if (!chatId) return res.json({ ok: true });

    const txt = (msg.text || "").trim();
    if (txt.startsWith("/start") || txt.startsWith("/help")) {
      await tgReply(chatId, "👋 Пришли аудио — расшифрую и пришлю аналитику.");
      return res.json({ ok: true });
    }

    let fileId = null;
    let fileName = "audio.mp3";
    if (msg.voice) { fileId = msg.voice.file_id; fileName = "voice.ogg"; }
    else if (msg.audio) { fileId = msg.audio.file_id; fileName = msg.audio.file_name || "audio.mp3"; }
    else if (msg.document) {
      const name = msg.document.file_name || "file.bin";
      if (/\.(mp3|m4a|ogg|oga|opus|wav|webm|aac)$/i.test(name)) { fileId = msg.document.file_id; fileName = name; }
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
        try { const qa = await analyzeTranscript(text, { callId: "tg-cmd", brand: "iRazbil" }); await tgReply(chatId, formatQaForTelegram(qa)); }
        catch (e) { await tgReply(chatId, "⚠️ Ошибка анализа: <code>"+(e?.message||e)+"</code>"); }
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
    try { await sendTG("TG webhook error: " + (e?.message || e)); } catch {}
    res.status(200).json({ ok: true });
  }
});

/* -------------------- SIMPLE URL PINGER -------------------- */
async function simplePingOnce(kind = "simple") {
  if (!SIMPLE_POLL_URL || SIMPLE_POLL_INTERVAL_MIN <= 0) return;
  try {
    const r = await fetch(SIMPLE_POLL_URL);
    const j = await r.json().catch(()=> ({}));
    const msg = `[PING] ${kind} -> ${r.status}` + (j ? ` scanned=${j.scanned||0} withLinks=${j.withLinks||0} started=${j.started||0} since=${j.since_used||"—"}` : "");
    console.log(msg);
    try { await sendTG(`✅ ${msg}`); } catch {}
  } catch (e) {
    const msg = `[PING] ${kind} error: ${e?.message || e}`;
    console.warn(msg);
    try { await sendTG(`❗️ ${msg}`); } catch {}
  }
}
if (SIMPLE_POLL_URL && SIMPLE_POLL_INTERVAL_MIN > 0) {
  console.log(`🔁 SIMPLE_PINGER: каждые ${SIMPLE_POLL_INTERVAL_MIN} мин → ${SIMPLE_POLL_URL} (since = watermark)`);
  simplePingOnce("boot").catch(()=>{});
  setInterval(() => { simplePingOnce("interval").catch(()=>{}); }, SIMPLE_POLL_INTERVAL_MIN * 60 * 1000);
}

/* -------------------- SERVER -------------------- */
app.listen(PORT, () => {
  console.log(`Smart AI Listener (${VERSION}) listening on ${PORT}`);
});
