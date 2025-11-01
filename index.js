// index.js — Smart AI Listener (Railway)
// Расширенный entrypoint: health/ready, Amo→Supabase sync, queue tick, diag,
// строгая auth (?key=CRM_SHARED_KEY), логирование, error handler, graceful shutdown.
//
// ВАЖНО: без новых npm-зависимостей (только встроенный express/cors)

import express from "express";
import cors from "cors";

import { syncAmoToSupabase } from "./sync_amo.js";
import { processQueueOnce } from "./queue_worker.js";
import { getAsrState } from "./asr.js";
import { getQueueStats } from "./supabaseStore.js";
import { sendTG } from "./telegram.js";

// ---------- ENV ----------
const PORT = parseInt(process.env.PORT || "8080", 10);
const CRM_SHARED_KEY = process.env.CRM_SHARED_KEY || ""; // напр.: boxfield-qa-2025
const SERVICE_NAME = process.env.SERVICE_NAME || "smart-ai-listener";
const NODE_ENV = process.env.NODE_ENV || "production";
const START_TS = Date.now();
const TG_ALERTS_CHAT_ID = process.env.TG_ALERTS_CHAT_ID || null;

// ---------- App ----------
const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Простейший request-id без зависимостей
app.use((req, _res, next) => {
  req._rid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  next();
});

// Мини-логгер (метод, путь, статус, ms)
app.use((req, res, next) => {
  const t0 = Date.now();
  const { method, originalUrl } = req;
  res.on("finish", () => {
    const ms = Date.now() - t0;
    console.log(`[${req._rid}] ${method} ${originalUrl} -> ${res.statusCode} ${ms}ms`);
  });
  next();
});

// simple auth middleware по ?key= / header x-shared-key
function requireKey(req, res, next) {
  if (!CRM_SHARED_KEY) return res.status(500).json({ ok: false, error: "CRM_SHARED_KEY missing" });
  const key = (req.query.key || req.headers["x-shared-key"] || "").toString().trim();
  if (key !== CRM_SHARED_KEY) return res.status(403).json({ ok: false, error: "forbidden" });
  next();
}

// Утилита: безопасный int
function clampInt(v, min, max, dflt) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// ---------- Routes ----------

// Версия/список эндпоинтов
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    env: NODE_ENV,
    since: new Date(START_TS).toISOString(),
    endpoints: [
      "GET  /healthz",
      "GET  /readyz?key=...",
      "GET  /diag?key=...",
      "GET  /envcheck?key=...",
      "POST /tg/ping?key=...               (test уведомление в TG)",
      "POST /amo/sync/run?key=...          (pages, perPage, lookbackDays, notify=1)",
      "POST /queue/tick?key=...            (limit)",
    ],
  });
});

// Liveness: просто жив ли процесс
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: SERVICE_NAME, node: NODE_ENV, ts: Date.now() });
});

// Readiness: лёгкая проверка зависимостей (Supabase stats + ASR state)
app.get("/readyz", requireKey, async (_req, res) => {
  try {
    const asr = getAsrState();
    let queueStats = null;
    try { queueStats = await getQueueStats(); } catch {}
    res.json({ ok: true, asr, queueStats, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Диагностика
app.get("/diag", requireKey, async (_req, res) => {
  try {
    const asr = getAsrState();
    let stats = null;
    try { stats = await getQueueStats(); } catch {}
    res.json({
      ok: true,
      asr,
      queueStats: stats,
      now: new Date().toISOString(),
      uptime_ms: Date.now() - START_TS,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Тест уведомления в Telegram
app.post("/tg/ping", requireKey, async (_req, res) => {
  try {
    if (!TG_ALERTS_CHAT_ID) {
      return res.status(400).json({ ok: false, error: "TG_ALERTS_CHAT_ID not set" });
    }
    await sendTG(TG_ALERTS_CHAT_ID, `✅ ${SERVICE_NAME}: ping @ ${new Date().toISOString()}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Amo → Supabase: оконный sync (без курсоров, как договаривались)
app.post("/amo/sync/run", requireKey, async (req, res) => {
  const pages        = clampInt(req.query.pages ?? req.body?.pages, 1, 50, 5);
  const perPage      = clampInt(req.query.perPage ?? req.body?.perPage, 10, 250, 50);
  const lookbackDays = clampInt(req.query.lookbackDays ?? req.body?.lookbackDays, 1, 365, 30);
  const notify       = String(req.query.notify ?? req.body?.notify ?? "0") === "1";
  try {
    const result = await syncAmoToSupabase({
      pages,
      perPage,
      lookbackDays,
      notifyChatId: notify ? (TG_ALERTS_CHAT_ID || null) : null,
    });
    res.json({ ok: true, params: { pages, perPage, lookbackDays }, result });
  } catch (e) {
    try { await sendTG(`❌ /amo/sync/run error: <code>${String(e)}</code>`); } catch {}
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Queue tick: берём pending → ASR → QA → TG → done
app.post("/queue/tick", requireKey, async (req, res) => {
  const limit = clampInt(req.query.limit ?? req.body?.limit, 1, 20, parseInt(process.env.QUEUE_TICK_LIMIT || "5", 10));
  try {
    const r = await processQueueOnce(limit);
    res.json({ ok: true, limit, ...r });
  } catch (e) {
    try { await sendTG(`❌ /queue/tick error: <code>${String(e)}</code>`); } catch {}
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Просмотр окружения (маскируем секреты)
app.get("/envcheck", requireKey, (_req, res) => {
  const mask = (v) => {
    const s = String(v || "");
    if (!s) return "";
    if (s.length <= 6) return "***";
    return s.slice(0, 3) + "***" + s.slice(-3);
    };
  res.json({
    ok: true,
    env: {
      NODE_ENV,
      SERVICE_NAME,
      PORT,
      SUPABASE_URL: process.env.SUPABASE_URL || "",
      SUPABASE_SERVICE_KEY: mask(process.env.SUPABASE_SERVICE_KEY),
      OPENAI_API_KEY: mask(process.env.OPENAI_API_KEY),
      CALL_QA_MODEL: process.env.CALL_QA_MODEL || "",
      ASR_MODEL: process.env.ASR_MODEL || "",
      TG_ALERTS_CHAT_ID: process.env.TG_ALERTS_CHAT_ID || "",
      CRM_SHARED_KEY: mask(process.env.CRM_SHARED_KEY),
    }
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ ok: false, error: "not_found", path: req.originalUrl });
});

// Глобальный error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(`[${req?._rid}] Unhandled error:`, err);
  res.status(500).json({ ok: false, error: "internal_error" });
});

// ---------- Start ----------
const server = app.listen(PORT, () => {
  console.log(`[${SERVICE_NAME}] listening on :${PORT} (${NODE_ENV})`);
});

// ---------- Graceful shutdown ----------
async function shutdown(reason) {
  try {
    console.log(`\n[${SERVICE_NAME}] shutdown: ${reason}`);
    server.close(() => {
      console.log(`[${SERVICE_NAME}] server closed`);
      process.exit(0);
    });
    // Если через 8s не закрылось — выходим жёстко
    setTimeout(() => process.exit(0), 8000).unref();
  } catch {
    process.exit(1);
  }
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
