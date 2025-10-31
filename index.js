// index.js — Smart AI Listener (v2.4.2-IRAZBIL safe-cursors)
// архитектура: telegram / asr / amo / megapbx / supabaseStore / utils

import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";

// ---- QA ----
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

// ---- Telegram ----
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

// ---- ASR ----
import {
  enqueueAsr,
  transcribeAudioFromUrl,
  getAsrState,
} from "./asr.js";

// ---- AmoCRM ----
import {
  processAmoCallNotes,
  amoFetch,
  amoRefresh,
  getAmoTokensMask,
  injectAmoTokens,
} from "./amo.js";

// ---- Megapbx ----
import { normalizeMegafon } from "./megapbx.js";

// ---- Utils ----
import {
  debug,
  cap,
  safeStr,
  mask,
  chunkText,
  fetchWithTimeout,
} from "./utils.js";

// ---- Supabase ----
import {
  isAlreadyProcessed,
  markProcessed,
  setSecret,
} from "./supabaseStore.js";

/* -------------------- ENV -------------------- */
const VERSION = "railway-2.4.2-irazbil";

const TG_BOT_TOKEN       = process.env.TG_BOT_TOKEN || "";
const TG_CHAT_ID         = process.env.TG_CHAT_ID || "";
const TG_WEBHOOK_SECRET  = (process.env.TG_WEBHOOK_SECRET || "").trim();
const TG_UPLOAD_CHAT_ID  = process.env.TG_UPLOAD_CHAT_ID || TG_CHAT_ID;
const NODE_ENV           = process.env.NODE_ENV || "development";

const CRM_SHARED_KEY     = process.env.CRM_SHARED_KEY || ""; // use: boxfield-qa-2025
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY || "";

const AUTO_TRANSCRIBE    = process.env.AUTO_TRANSCRIBE === "1";
const SHOW_CONTACT_EVENTS= process.env.SHOW_CONTACT_EVENTS === "1";
const RELAY_BASE_URL     = process.env.RELAY_BASE_URL || "";
const TG_DIRECT_FETCH    = process.env.TG_DIRECT_FETCH === "1";

const AMO_POLL_MINUTES   = parseInt(process.env.AMO_POLL_MINUTES || "0", 10);
const AMO_POLL_LIMIT     = parseInt(process.env.AMO_POLL_LIMIT   || "30", 10);

const AMO_BOOTSTRAP_LIMIT = parseInt(process.env.AMO_BOOTSTRAP_LIMIT || "5", 10);
let bootstrapRemaining = AMO_BOOTSTRAP_LIMIT;

// OAuth конфиг
const AMO_BASE_URL      = (process.env.AMO_BASE_URL || "").replace(/\/+$/,"");
const AMO_CLIENT_ID     = process.env.AMO_CLIENT_ID || "";
const AMO_CLIENT_SECRET = process.env.AMO_CLIENT_SECRET || "";
const AMO_REDIRECT_URI  = process.env.AMO_REDIRECT_URI || "";

// internal helper: валиден ли env для OAuth
function ensureAmoOauthEnv() {
  if (!AMO_BASE_URL || !AMO_CLIENT_ID || !AMO_CLIENT_SECRET || !AMO_REDIRECT_URI) {
    throw new Error("AMO OAuth env incomplete (AMO_BASE_URL / AMO_CLIENT_ID / AMO_CLIENT_SECRET / AMO_REDIRECT_URI)");
  }
}

const HISTORY_TIMEOUT_MS =
  parseInt(process.env.HISTORY_TIMEOUT_MIN || "7", 10) * 60 * 1000;
const CALL_TTL_MS =
  parseInt(process.env.CALL_TTL_MIN || "60", 10) * 60 * 1000;

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
function wrapRecordingUrl(url) {
  if (!RELAY_BASE_URL) return url;
  try {
    const u = new URL(url);
    const rb = new URL(RELAY_BASE_URL);
    if (u.hostname === rb.hostname && u.port === rb.port) return url;
  } catch {}
  return RELAY_BASE_URL + encodeURIComponent(url);
}
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
app.get("/", (_, res) => res.send("OK"));
app.get("/version", (_, res) => res.json({ version: VERSION }));
app.get("/diag/env", (_, res) =>
  res.json({
    version: VERSION,
    tg: !!TG_BOT_TOKEN,
    chat_id: TG_CHAT_ID,
    amo: getAmoTokensMask(),
    supabase: !!process.env.SUPABASE_URL,
    poll_minutes: AMO_POLL_MINUTES,
    poll_limit: AMO_POLL_LIMIT,
    bootstrapRemaining,
  })
);

/* -------------------- AMO OAuth -------------------- */
app.get("/amo/oauth/start", async (req, res) => {
  try {
    ensureAmoOauthEnv();
    const state = crypto.randomBytes(16).toString("hex");
    const url =
      `${AMO_BASE_URL}/oauth?` +
      `client_id=${encodeURIComponent(AMO_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(AMO_REDIRECT_URI)}` +
      `&response_type=code` +
      `&mode=post_message` +
      `&state=${encodeURIComponent(state)}`;
    res.redirect(url);
  } catch (e) {
    await sendTG(`❗️ OAuth start error: <code>${e?.message || e}</code>`);
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
      await sendTG(`❗️ OAuth exchange failed: <code>${text}</code>`);
      return res.status(400).send("oauth exchange failed");
    }
    const j = JSON.parse(text);

    const access  = j.access_token  || "";
    const refresh = j.refresh_token || "";
    if (!access || !refresh) throw new Error("empty tokens in response");

    await setSecret("AMO_ACCESS_TOKEN", access);
    await setSecret("AMO_REFRESH_TOKEN", refresh);
    try { await injectAmoTokens(access, refresh); } catch {}

    await sendTG(
      "✅ <b>AmoCRM авторизация завершена</b>\n" +
      `• access: <code>${mask(access)}</code>\n` +
      `• refresh: <code>${mask(refresh)}</code>`
    );

    res.send(
      `<html><body style="font-family:system-ui">` +
      `<h3>Готово ✅</h3><p>Можете закрыть вкладку. Токены сохранены, слушатель подключён.</p>` +
      `</body></html>`
    );
  } catch (e) {
    await sendTG(`❗️ OAuth callback error: <code>${e?.message || e}</code>`);
    res.status(500).send("oauth callback failed");
  }
});

app.get("/amo/refresh", async (_, res) => {
  try {
    const j = await amoRefresh();
    await sendTG("🔄 Amo refresh ok " + mask(j.access_token));
    res.json({ ok: true });
  } catch (e) {
    await sendTG("❗️ refresh error: " + (e?.message || e));
    res.status(500).json({ ok: false });
  }
});

/* ---- safe cursor tools ---- */
app.post("/amo/cursors/reset", async (req, res) => {
  try {
    assertKey(req);
    await Promise.all([
      setSecret("amo_cursor_lead_notes_created_at", "0"),
      setSecret("amo_cursor_contact_notes_created_at", "0"),
      setSecret("amo_cursor_company_notes_created_at", "0"),
    ]);
    await sendTG("♻️ Amo cursors reset to 0 (lead/contact/company).");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});
app.post("/amo/cursors/soft-backfill", async (req, res) => {
  try {
    assertKey(req);
    const hours = Math.max(1, Math.min(parseInt(req.query.hours || "24", 10), 168));
    const targetSec = Math.floor(Date.now()/1000) - hours*3600;
    await Promise.all([
      setSecret("amo_cursor_lead_notes_created_at", String(targetSec)),
      setSecret("amo_cursor_contact_notes_created_at", String(targetSec)),
      setSecret("amo_cursor_company_notes_created_at", String(targetSec)),
    ]);
    await sendTG(`⏪ Soft-backfill cursors set to -${hours}h.`);
    res.json({ ok: true, targetSec });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  }
});

/* ---- manual poll ---- */
app.get("/amo/poll", async (req, res) => {
  try {
    assertKey(req);
    const limit = Math.min(parseInt(req.query.limit || AMO_POLL_LIMIT, 10), 100);
    const out = await processAmoCallNotes(limit, bootstrapRemaining);
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
        param_keys: n.params ? Object.keys(n.params).slice(0, 20) : [],
        params_preview: (() => {
          try { return JSON.stringify(n.params || {}).slice(0, 600); }
          catch { return ""; }
        })(),
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

/* -------------------- TELEGRAM WEBHOOK -------------------- */
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
    if (msg.voice) {
      fileId = msg.voice.file_id;
      fileName = "voice.ogg";
    } else if (msg.audio) {
      fileId = msg.audio.file_id;
      fileName = msg.audio.file_name || "audio.mp3";
    } else if (msg.document) {
      const name = msg.document.file_name || "file.bin";
      if (/\.(mp3|m4a|ogg|oga|opus|wav)$/i.test(name)) {
        fileId = msg.document.file_id;
        fileName = name;
      }
    }

    if (!fileId) {
      if (txt) {
        const m = txt.match(/^\/asr\s+(\S+)/i);
        if (m) {
          const inUrl = m[1];
          await tgReply(chatId, "⏳ Беру по ссылке, расшифровываю…");
          let relayCdnUrl;
          try { relayCdnUrl = await tgRelayAudio(inUrl, `🎧 tg /asr relay`); } catch { relayCdnUrl = inUrl; }
          const text = await enqueueAsr(() =>
            transcribeAudioFromUrl(relayCdnUrl, { callId: "tg-cmd", fileName: "audio.ext" })
          );
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
      }
      await tgReply(chatId, "🧩 Отправь аудиофайл, чтобы я расшифровал.");
      return res.json({ ok: true });
    }

    await tgReply(chatId, "⏳ Расшифровываю...");
    const fileUrl = await tgGetFileUrl(fileId);
    const text = await enqueueAsr(() =>
      transcribeAudioFromUrl(fileUrl, { callId: "tg-file", fileName })
    );
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
    console.error("TG webhook error:", e);
    try { await sendTG("TG webhook error: " + (e?.message || e)); } catch {}
    res.status(200).json({ ok: true });
  }
});

/* -------------------- AUTO POLLER -------------------- */
if (AMO_POLL_MINUTES > 0) {
  console.log(`⏰ auto-poll каждые ${AMO_POLL_MINUTES} мин (limit=${AMO_POLL_LIMIT}, bootstrap=${AMO_BOOTSTRAP_LIMIT})`);
  const tickAmo = async () => {
    try {
      const out = await processAmoCallNotes(AMO_POLL_LIMIT, bootstrapRemaining);
      if (bootstrapRemaining > 0 && out && typeof out.started === "number") {
        bootstrapRemaining = Math.max(0, bootstrapRemaining - out.started);
      }
      console.log("[AMO] poll:", out);
      if (out?.started > 0) {
        await sendTG(
          `📡 Amo poll:\n` +
          `• scanned ${out.scanned}\n` +
          `• with links ${out.withLinks}\n` +
          `• started ${out.started}\n` +
          `• ignored ${out.ignored}\n` +
          `• bootstrapRemaining ${bootstrapRemaining}`
        );
      }
    } catch (e) {
      console.error("[AMO] poll error:", e);
      try { await sendTG("❗️ poll error: " + (e?.message || e)); } catch {}
    }
  };
  tickAmo();
  setInterval(tickAmo, AMO_POLL_MINUTES * 60 * 1000);
} else {
  console.log("⏸ auto-poll disabled");
}

/* -------------------- START -------------------- */
const server = app.listen(PORT, () =>
  console.log(`Smart AI Listener (${VERSION}) listening on ${PORT}`)
);
