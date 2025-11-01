// sync_amo.js — Amo → Supabase ingest (raw), idempotent, no cursors
// v1.0 for Smart AI Listener (Railway)
// Собирает заметки из AmoCRM по 4 сущностям, нормализует, ищет ссылки на записи,
// кладёт в Supabase: amo_notes_raw (upsert) и recordings_queue (enqueue по links[]).

import { fetchWithTimeout } from "./utils.js";
import { saveAmoNotesRaw, enqueueRecordings } from "./supabaseStore.js";
import { findRecordingLinksInNote, isLikelyCallNote } from "./amo.js";
import { sendTG } from "./telegram.js";

/* ================= ENV ================= */
const AMO_BASE_URL = (process.env.AMO_BASE_URL || "").replace(/\/+$/,"");
const AMO_ACCESS_TOKEN = process.env.AMO_ACCESS_TOKEN || "";
const DEFAULT_PAGES = parseInt(process.env.AMO_SYNC_PAGES || "5", 10);
const DEFAULT_PER_PAGE = parseInt(process.env.AMO_SYNC_PER_PAGE || "50", 10);
const DEFAULT_LOOKBACK_DAYS = parseInt(process.env.AMO_SYNC_LOOKBACK_DAYS || "90", 10);

if (!AMO_BASE_URL) console.warn("[sync_amo] AMO_BASE_URL not set");
if (!AMO_ACCESS_TOKEN) console.warn("[sync_amo] AMO_ACCESS_TOKEN not set");

/* ================ Helpers ================ */
function toISO(ms) {
  try { return new Date(ms).toISOString(); } catch { return null; }
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function amoGet(path, search = "") {
  const url = `${AMO_BASE_URL}${path}${search}`;
  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${AMO_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    redirect: "follow",
  }, 30000);

  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`AMO GET ${path} failed ${res.status}: ${t}`);
  }
  return res.json();
}

// v4: /api/v4/<entity>/notes
async function fetchNotesForEntity(entityPlural, page = 1, limit = 50) {
  const path = `/api/v4/${entityPlural}/notes`;
  const q = `?page=${page}&limit=${limit}`;
  const data = await amoGet(path, q);
  const arr = data?._embedded?.notes;
  return Array.isArray(arr) ? arr : [];
}

/**
 * Тянем окно заметок по 4 сущностям (leads/contacts/companies/customers) с пагинацией,
 * нормализуем и находим ссылки.
 */
export async function pullAmoNotesWindow({ pages = DEFAULT_PAGES, perPage = DEFAULT_PER_PAGE } = {}) {
  const entities = ["leads", "contacts", "companies", "customers"];
  const out = [];

  for (const e of entities) {
    for (let p = 1; p <= pages; p++) {
      const arr = await fetchNotesForEntity(e, p, perPage);
      if (!arr.length) break;

      for (const n of arr) {
        const entity = e.slice(0, -1); // leads -> lead
        const created_ts = Number.parseInt(n?.created_at ?? 0, 10) || 0;
        const links = findRecordingLinksInNote(n);
        const has_link = links.length > 0;

        out.push({
          amo_note_key: `${entity}:${n.id}`,
          amo_note_id: n.id,
          entity,
          entity_id: n?.entity_id ?? 0,
          note_type: n?.note_type ?? null,
          created_at_ts: created_ts,
          created_at: created_ts ? toISO(created_ts * 1000) : null,
          note_text: n?.text ?? null,
          params: n?.params ?? null,
          has_link,
          links
        });
      }

      // лёгкий троттлинг, чтобы не долбить API
      await sleep(200);
    }
  }

  // Свежие сверху
  out.sort((a,b) => (b.created_at_ts || 0) - (a.created_at_ts || 0));
  return out;
}

/**
 * Главная функция: Amo → Supabase (raw upsert) → постановка ссылок в recordings_queue
 * @param {object} cfg
 *  - pages, perPage: глубина и ширина выборки по каждой сущности
 *  - lookbackDays: окно по времени (без курсоров) — фильтруем created_at_ts >= now - X дней
 *  - notifyChatId: при желании уведомим в TG об объёмах
 */
export async function syncAmoToSupabase({
  pages = DEFAULT_PAGES,
  perPage = DEFAULT_PER_PAGE,
  lookbackDays = DEFAULT_LOOKBACK_DAYS,
  notifyChatId = null
} = {}) {
  // 1) Забираем окно из Amo
  const all = await pullAmoNotesWindow({ pages, perPage });

  // 2) Обрезаем по окну времени (страховка от излишней глубины)
  const minTs = Math.floor((Date.now() - lookbackDays * 86400 * 1000) / 1000);
  const windowed = all.filter(r => (r.created_at_ts || 0) >= minTs);

  // 3) Сохраняем сырые заметки (idempotent upsert по amo_note_key)
  const rawRes = await saveAmoNotesRaw(windowed);

  // 4) Выбираем кандидатов с линками ТОЛЬКО по звонкам
  const candidates = windowed.filter(r => {
    if (!r.has_link) return false;
    const likelyCall = isLikelyCallNote({ note_type: r.note_type, text: r.note_text, params: r.params });
    return likelyCall;
  });

  // 5) Ставим в очередь (idempotent по record_url)
  const enqRes = await enqueueRecordings(candidates);

  // 6) (опц.) уведомление в TG
  if (notifyChatId) {
    try {
      await sendTG(notifyChatId, [
        "✅ Amo sync finished",
        `window: ${lookbackDays}d, pages: ${pages}×${perPage}`,
        `raw upsert → inserted≈${rawRes.inserted}`,
        `queue → enqueued≈${enqRes.enqueued}`
      ].join("\n"));
    } catch {}
  }

  return {
    ok: true,
    windowDays: lookbackDays,
    pages, perPage,
    raw: rawRes,
    queue: enqRes
  };
}

// (опционально) маленькая самопроверка в dev
if (process.env.NODE_ENV === "development" && process.env.RUN_SYNC_ON_START === "1") {
  (async () => {
    try {
      const r = await syncAmoToSupabase({});
      console.log("[sync_amo] dev run result:", r);
    } catch (e) {
      console.error("[sync_amo] dev run error:", e);
    }
  })();
}
