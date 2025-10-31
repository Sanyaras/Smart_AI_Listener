// index.js — Smart AI Listener (v2.6.1-IRAZBIL)
// Архитектура: telegram / asr / amo / supabaseStore / utils / qa_assistant
// Ключевые фичи:
//  • Автопуллер Amo по расписанию (AMO_POLL_MINUTES) c экспоненциальным ре-траем при сетевых сбоях
//  • Эндпоинты для диагностики, ручного опроса, форс-бэкфилла "от даты", просмотра курсоров
//  • Исправленное сохранение OAuth-токенов Amo без синтаксических артефактов

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
  sendTGDocument,
  tgReply,
  tgGetFileUrl,
  tgRelayAudio,
  formatTgMegapbxMessage,
  getTelegramQueuesState,
} from "./telegram.js";

// ---- ASR очередь/распознавание ----
import {
  enqueueAsr,
  transcribeAudioFromUrl,
  getAsrState,
} from "./asr.js";

// ---- AmoCRM интеграция (новый надёжный поллер) ----
import {
  processAmoCallNotes,
  amoFetch,
  amoRefresh,
  getAmoTokensMask,
  injectAmoTokens,
} from "./amo.js";

// ---- Утилиты/сетевые ----
import {
  debug,
  cap,
  safeStr,
  mask,
  chunkText,
  fetchWithTimeout,
} from "./utils.js";

// ---- Supabase tokens/flags ----
import {
  isAlreadyProcessed,
  markProcessed,
  setSecret, // для OAuth-секретов
  getSecret,
} from "./supabaseStore.js";

/* -------------------- ENV -------------------- */
const VERSION            = "railway-2.6.1-irazbil";
const TG_BOT_TOKEN       = process.env.TG_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT_ID         = process.env.TG_CHAT_ID || "";
const TG_WEBHOOK_SECRET  = (process.env.TG_WEBHOOK_SECRET || "").trim();
const TG_UPLOAD_CHAT_ID  = process.env.TG_UPLOAD_CHAT_ID || TG_CHAT_ID;
const NODE_ENV           = process.env.NODE_ENV || "development";

const CRM_SHARED_KEY     = process.env.CRM_SHARED_KEY || ""; // e.g. "boxfield-qa-2025"
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY || "";

const AUTO_TRANSCRIBE    = process.env.AUTO_TRANSCRIBE === "1";
const SHOW_CONTACT_EVENTS= process.env.SHOW_CONTACT_EVENTS === "1";
const RELAY_BASE_URL     = process.env.RELAY_BASE_URL || "";
const TG_DIRECT_FETCH    = process.env.TG_DIRECT_FETCH === "1";

const AMO_POLL_MINUTES   = parseInt(process.env.AMO_POLL_MINUTES || "10", 10);
const AMO_POLL_LIMIT     = parseInt(process.env.AMO_POLL_LIMIT   || "30", 10);
// при старте ограничиваем, сколько «старых» звонков дополнительно подтянуть авто-поллером
const AMO_BOOTSTRAP_LIMIT = parseInt(process.env.AMO_BOOTSTRAP_LIMIT || "5", 10);
// опционально: стартовать автопуллер с бэкфиллом за N часов назад (если курсоры пустые)
const AMO_BOOTSTRAP_BACKFILL_HOURS = parseInt(process.env.AMO_BOOTSTRAP_BACKFILL_HOURS || "0", 10);

let bootstrapRemaining = AMO_BOOTSTRAP_LIMIT;

// OAuth конфиг (Railway)
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
function getIncomingKey(req) {
  const auth = req.headers["authorization"] || req.headers["Authorization"] || "";
  const m = String(auth).match(/Bearer\s+(.+)/i);
  if (m) return m[1];
  return (
    req.headers["x-api-key"] ||
    req.headers["x-crm-key"] ||
    req.headers["x-auth-token"] ||
    req.query?.key ||
    (typeof req.body === "object" ? req.body.crm_token : undefined)
  );
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
function wrapRecordingUrl(url) {
  if (!RELAY_BASE_URL) return url;
  try {
    const u = new URL(url);
    const rb = new URL(RELAY_BASE_URL);
    if (u.hostname === rb.hostname && u.port === rb.port) return url;
  } catch {}
  return RELAY_BASE_URL + encodeURIComponent(url);
}

/* -------------------- DIAGNOSTICS -------------------- */
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

/* -------------------- AMO: Stable OAuth flow -------------------- */
// 1) Старт авторизации: редиректим на AmoCRM OAuth
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

// 2) Callback AmoCRM: code → access/refresh, сохранить в Supabase и инжектнуть в рантайм
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

    await setSecret("AMO_ACCESS_TOKEN", access).catch(()=>{});
    await setSecret("AMO_REFRESH_TOKEN", refresh).catch(()=>{});
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

/* -------------------- AMO helper endpoints -------------------- */
app.get("/amo/refresh", async (_, res) => {
  try {
    const j = await amoRefresh();
    await sendTG("🔄 Amo refresh ok " + mask(j.access_token));
    res.json({ ok: true });
  } catch (e) {
    await sendTG("❗️ refresh error: " + (e?.message || e));
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Manual poll (tail scan with optional limit/overlap/backfill)
app.get("/amo/poll", async (req, res) => {
  try {
    assertKey(req);
    const limit = Math.min(parseInt(req.query.limit || AMO_POLL_LIMIT, 10) || AMO_POLL_LIMIT, 300);
    const backfillHours = parseInt(req.query.backfillHours || "0", 10) || 0;
    const overlapMin = parseInt(req.query.overlapMin || (process.env.AMO_CURSOR_OVERLAP_MIN || "180"), 10);
    const since = req.query.since ? parseInt(req.query.since, 10) : 0;

    const options = {};
    if (!Number.isNaN(since) && since > 0) {
      options.force = true;
      options.since = since;
    } else if (backfillHours > 0) {
      options.force = true;
      options.since = Math.max(0, Math.floor(Date.now()/1000) - backeme(backfillHours));
    }
    if (!Number.isNaN(overlapMin) && overlapMin > 0) {
      process.env.AMO_CURSOR_OVERLAP_MIN = String(overlapMin);
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

// Force backfill for last N hours
app.get("/amo/force", async (req, res) => {
  try {
    assertKey(req);
    const hours = Math.max(1, parseInt(req.query.hours || (process.env.AMO_BACKFILL_MAX_HOURS || "24"), 10));
    const limit = Math.min(parseInt(req.query.limit || "200", 10) || 200, 500);
    const since = Math.max(0, Math.floor(Date.now()/1000) - hours*3600);
    const out = await processAmoCallNotes(limit, 999999, { force: true, since });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(401).json({ ok: false, error: String(e) });
  }
});

// View cursors
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

// Debug helpers (raw dumps)
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
      await tgReply(
        chatId,
        "👋 Пришли аудио (voice/audio/document) — я расшифрую и пришлю аналитику."
      );
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
      // поддержка команды /asr <url>
      if (txt) {
        const m = txt.match(/^\/asr\s+(\S+)/i);
        if (m) {
          const inUrl = m[1];
          await tgReply(chatId, "⏳ Беру по ссылке, расшифровываю…");
          let relayCdnUrl;
          try {
            relayCdnUrl = await tgRelayAudio(inUrl, `🎧 tg /asr relay`);
          } catch {
            relayCdnUrl = inUrl;
          }
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

/* -------------------- AUTO POLLER WITH RETRIES -------------------- */
function backeme(hours){ return Math.floor(hours*3600); }

if (AMPOk()) {
  console.log(
    `⏰ auto-poll каждые ${AMO_POLL_MINUTES} мин (limit=${AMO_POLL_LIMIT}, bootstrap=${AMO_BOOTSTRAP_LIMIT})`
  );

  const tickAmo = async (opts = {}) => {
    const { force = false, since = 0 } = opts;
    try {
      const options = {};
      if (force) options.force = true;
      if (since) options.fineGrained = true, options.since = since;

      const out = await processAmoCallNotes(AMO_POLL_LIMIT, bootstrapRemaining, options);
      if (bootstrapRemaining > 0 && out && typeof out.started === "number") {
        bootstrapRemaining = Math.max(0, bootstrapRemaining - out.started);
      }
      if (out?.started > 0) {
        await sendTG(
          `📡 Amo poll:\n` +
          `• scanned ${out.scanned}\n` +
          `• with links ${out.withLinks}\n` +
          `• started ${out.started}\n` +
          `• skipped ${out.skipped} · seenOnly ${out.seenOnly} · ignored ${out.ignored}\n` +
          `• cursors: L${out.cursors.lead_next} C${out.cursors.contact_next} Co${out.cursors.company_next}\n` +
          `• bootstrapRemaining ${bootstrapRemaining}`
        );
      }
    } catch (e) {
      console.error("[AMO] poll error:", e);
      try { await sendTG("❗️ [AMO] poll error: " + (e?.message || e)); } catch {}
      // экспоненциальный ре-трай с минимальной задержкой
      scheduleNext(true);
      return;
    }
    scheduleNext(false);
  };

  let timer = null;
  let backoffMs = 0;
  function scheduleNext(failed) {
    if (failed) {
      backoffMs = Math.min(5 * 60 * 1000, (backoffMs ? backoffMs * 2 : 30 * 1000));
    } else {
      backoffMs = 0;
    }
    const base = AMO_POLL_MINUTES * 60 * 1000;
    const jitter = Math.floor(Math.random() * 5000);
    const due = (failed ? backoffMs : base) + jitter;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // если курсоры пустые и задан бэкфилл — стартуем «от даты» один раз
      if (AMO_BOOTSTRAY()) {
        const since = Math.max(0, Math.floor(Date.now()/1000) - backeme(AMO_BOOTSTRAP_BACKFILL + 0));
        tickAmo({ force: true, since });
        AMO_BOOTSTRAP_BACKFILL_STARTED = true;
      } else {
        tickAmo();
      }
    }, due);
  }

  let AMO_BOOTSTRAP_BACKFILL_STARTED = false;
  function AMO_BOOTSTRAY() {
    if (!AMO_BOOTSTRAP_BACKFILL_HOURS) return false;
    if (AMO_BOOTSTRAP_BACKFILL_STARTED) return false;
    return true;
  }
  function AMO_BOOTSTRAP_BACKFILL(){ return AMO_BOOTSTRAP_BACKFILL_HOURS; }
  function AMPOk(){ return AMO_PTOP() && AMO_POLL_MINUTES > 0; }
  function AMO_PTOP(){ return !!AMO_BASE_URL && !!AMO_CLIENT_ID && !!AMO_CLIENT_SECRET && !!AMO_REDIRECT_URI; }

  // первый запуск сразу
  tickAmo();
} else {
  console.log("⏸ auto-poll disabled or AMO env incomplete");
}

/* -------------------- START -------------------- */
const server = app.listen(PORT, () =>
  console.log(`Smart AI Listener (${VERSION}) listening on ${PORT}`)
);
