// supabaseStore.js — работа с Supabase REST API
// Используется для Amo sync и очереди транскрипции.
// Совместимо с Railway. Авторизация через SUPABASE_SERVICE_KEY.
//
// Таблицы:
//  - amo_notes_raw (уникальный amo_note_key)
//  - recordings_queue (уникальный record_url)
//  - amo_ingest_state (опционально для хранения since и др.)

import { fetchWithTimeout } from "./utils.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL) console.warn("[supabaseStore] SUPABASE_URL not set");
if (!SUPABASE_SERVICE_KEY) console.warn("[supabaseStore] SUPABASE_SERVICE_KEY not set");

// ===== Helper =====
async function sbase(path, method = "GET", payload = null, extraHeaders = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const opts = {
    method,
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...extraHeaders
    },
  };
  if (payload) opts.body = JSON.stringify(payload);
  const res = await fetchWithTimeout(url, opts, 30000);
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`Supabase ${method} ${path} failed ${res.status}: ${t}`);
  }
  try { return await res.json(); } catch { return {}; }
}

// ===== Amo raw notes =====
export async function saveAmoNotesRaw(rows) {
  if (!rows?.length) return { inserted: 0, updated: 0, skipped: 0 };
  const url = `${SUPABASE_URL}/rest/v1/amo_notes_raw`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify(rows)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`saveAmoNotesRaw failed ${res.status}: ${t}`);
  }
  const uniq = new Set(rows.map(r => r.amo_note_key));
  return { inserted: uniq.size, updated: 0, skipped: 0 };
}

// ===== Recordings queue =====
export async function enqueueRecordings(rows) {
  if (!rows?.length) return { enqueued: 0, duplicates: 0 };
  const enq = [];
  for (const r of rows) {
    for (const u of r.links) {
      enq.push({
        amo_note_key: r.amo_note_key,
        record_url: u,
        status: "pending",
        created_at: new Date().toISOString()
      });
    }
  }
  if (!enq.length) return { enqueued: 0, duplicates: 0 };

  const url = `${SUPABASE_URL}/rest/v1/recordings_queue`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify(enq)
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`enqueueRecordings failed ${res.status}: ${t}`);
  }
  const uniq = new Set(enq.map(r => r.record_url));
  return { enqueued: uniq.size, duplicates: 0 };
}

// ===== Очередь: получить batch pending =====
export async function takeQueueBatch(limit = 5) {
  const url = `/recordings_queue?status=eq.pending&order=created_at.asc&limit=${limit}`;
  return sbase(url, "GET");
}

// ===== Обновить статус =====
export async function markQueueStatus(ids, status, extra = {}) {
  if (!ids?.length) return { updated: 0 };
  const idList = ids.map(x => `"${x}"`).join(",");
  const path = `/recordings_queue?id=in.(${idList})`;
  const payload = { status, ...extra };
  const res = await sbase(path, "PATCH", payload);
  return { updated: Array.isArray(res) ? res.length : 0 };
}

export async function markQueueDone(id, extra = {}) {
  const path = `/recordings_queue?id=eq.${id}`;
  const payload = {
    status: "done",
    finished_at: new Date().toISOString(),
    ...extra
  };
  const res = await sbase(path, "PATCH", payload);
  return { updated: Array.isArray(res) ? res.length : 0 };
}

export async function markQueueError(id, err) {
  const path = `/recordings_queue?id=eq.${id}`;
  const payload = {
    status: "error",
    attempts: 1,
    error: String(err),
    finished_at: new Date().toISOString()
  };
  const res = await sbase(path, "PATCH", payload);
  return { updated: Array.isArray(res) ? res.length : 0 };
}

// ===== Stats =====
export async function getQueueStats() {
  const url = `/recordings_queue?select=status,count:id`;
  return sbase(url, "GET");
}

// ===== State store (опционально) =====
export async function saveIngestState(key, val) {
  const payload = [{ key, val, updated_at: new Date().toISOString() }];
  const res = await fetch(`${SUPABASE_URL}/rest/v1/amo_ingest_state`, {
    method: "POST",
    headers: {
      "apikey": SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`saveIngestState failed ${res.status}`);
  return true;
}

export async function loadIngestState(key) {
  const url = `/amo_ingest_state?key=eq.${key}&select=val`;
  const res = await sbase(url, "GET");
  return Array.isArray(res) && res.length ? res[0].val : null;
}
