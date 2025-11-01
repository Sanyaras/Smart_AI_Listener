// supabaseStore.js
// хранение статуса обработанных звонков из amo / мегапбх
// таблица processed_calls

if (typeof fetch === "undefined") {
  throw new Error("Global fetch required (Node >=18)");
}

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const TABLE = "processed_calls";

function ensureSupabaseEnv() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("Supabase env missing (SUPABASE_URL / SUPABASE_SERVICE_KEY)");
  }
}

async function sbFetch(path, { method = "GET", body, signal } = {}) {
  ensureSupabaseEnv();

  const url = `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1${path}`;

  const headers = {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });

  if (res.status === 406) return [];
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`supabase ${method} ${path} ${res.status}: ${txt}`);
  }
  if (res.status === 204) return null;
  return await res.json().catch(() => null);
}

/**
 * Проверяем по (source_type, source_id): обрабатывали ли этот звонок?
 * source_type:
 *   - "amo_note"
 *   - "megapbx_call"
 *
 * source_id:
 *   - note.id из amo
 *   - callId из АТС
 */
export async function isAlreadyProcessed(source_type, source_id) {
  try {
    const rows = await sbFetch(
      `/${TABLE}?source=eq.${encodeURIComponent(
        source_type
      )}&note_id=eq.${encodeURIComponent(
        source_id
      )}&select=note_id,transcribed,qa_done,seen_only`
    );

    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.warn("isAlreadyProcessed error:", e?.message || e);
    // fail-safe: если supabase умер — считаем, что уже обработано,
    // чтобы не сжечь деньги/токены и не спамить
    return true;
  }
}

/**
 * Пометить как ОБРАБОТАНО:
 * - записали транскрипт
 * - сделали qa
 * - отправили в телегу
 */
export async function markProcessed(source_type, source_id, record_url) {
  try {
    await sbFetch(`/${TABLE}`, {
      method: "POST",
      body: [
        {
          source: source_type,
          note_id: String(source_id),
          record_url,
          transcribed: true,
          qa_done: true,
          seen_only: false,
        },
      ],
    });
  } catch (e) {
    console.warn("markProcessed error:", e?.message || e);
  }
}

/**
 * Пометить как "просто видел, но не обрабатывал", чтобы больше не брать.
 * use case: звонок слишком старый (>3ч), мы не хотим его крутить,
 * но и не хотим каждый тик думать "а вдруг".
 */
export async function markSeenOnly(source_type, source_id, record_url = "") {
  try {
    await sbFetch(`/${TABLE}`, {
      method: "POST",
      body: [
        {
          source: source_type,
          note_id: String(source_id),
          record_url,
          transcribed: false,
          qa_done: false,
          seen_only: true,
        },
      ],
    });
  } catch (e) {
    console.warn("markSeenOnly error:", e?.message || e);
  }
}
// ===== secrets storage (app_secrets) =====
export async function getSecret(key) {
  try {
    const rows = await sbFetch(`/app_secrets?key=eq.${encodeURIComponent(key)}&select=val&limit=1`);
    if (Array.isArray(rows) && rows.length > 0) return rows[0].val || null;
    return null;
  } catch (e) {
    console.warn("getSecret error:", e?.message || e);
    return null;
  }
}

export async function setSecret(key, val) {
  try {
    const existing = await sbFetch(`/app_secrets?key=eq.${encodeURIComponent(key)}&select=key&limit=1`);
    if (Array.isArray(existing) && existing.length > 0) {
      await sbFetch(`/app_secrets?key=eq.${encodeURIComponent(key)}`, {
        method: "PATCH",
        body: { val, updated_at: new Date().toISOString() }
      });
      return true;
    }
    await sbFetch(`/app_secrets`, {
      method: "POST",
      body: [{ key, val, updated_at: new Date().toISOString() }]
    });
    return true;
  } catch (e) {
    console.warn("setSecret error:", e?.message || e);
    return false;
  }
}
// --- recordings_queue helpers ---

async function sbase(url, method, payload) {
  const res = await fetch(url, {
    method,
    headers: {
      "apikey": process.env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "return=representation"
    },
    body: payload ? JSON.stringify(payload) : undefined
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`Supabase ${method} ${url} failed ${res.status}: ${t}`);
  }
  return res.json().catch(()=> ({}));
}

export async function saveAmoNotesRaw(rows) {
  if (!rows?.length) return { inserted: 0, updated: 0, skipped: 0 };
  const url = `${process.env.SUPABASE_URL}/rest/v1/amo_notes_raw`;
  await fetch(url, {
    method: "POST",
    headers: {
      "apikey": process.env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify(rows)
  });
  const uniq = new Set(rows.map(r => r.amo_note_key));
  return { inserted: uniq.size, updated: 0, skipped: 0 };
}

export async function enqueueRecordings(rows) {
  const enq = [];
  for (const r of rows) {
    for (const url of r.links) {
      enq.push({
        amo_note_key: r.amo_note_key,
        record_url: url,
        status: "pending"
      });
    }
  }
  if (!enq.length) return { enqueued: 0, duplicates: 0 };
  const url = `${process.env.SUPABASE_URL}/rest/v1/recordings_queue`;
  await fetch(url, {
    method: "POST",
    headers: {
      "apikey": process.env.SUPABASE_SERVICE_KEY,
      "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify(enq)
  });
  const uniq = new Set(enq.map(r => r.record_url));
  return { enqueued: uniq.size, duplicates: 0 };
}

export async function takeQueueBatch(limit=5) {
  // берём pending по created_at
  const url = `${process.env.SUPABASE_URL}/rest/v1/recordings_queue?status=eq.pending&order=created_at.asc&limit=${limit}`;
  return sbase(url, "GET");
}

export async function markQueueStatus(ids, status, extra={}) {
  if (!ids?.length) return { updated: 0 };
  const url = `${process.env.SUPABASE_URL}/rest/v1/recordings_queue?id=in.(${ids.map(x => `"${x}"`).join(",")})`;
  const payload = { status, ...extra, ...(status==="downloading" ? { started_at: new Date().toISOString() } : {}) };
  const res = await sbase(url, "PATCH", payload);
  return { updated: Array.isArray(res) ? res.length : 0 };
}

export async function markQueueDone(id, extra={}) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/recordings_queue?id=eq.${id}`;
  const payload = { status: "done", finished_at: new Date().toISOString(), ...extra };
  const res = await sbase(url, "PATCH", payload);
  return { updated: Array.isArray(res) ? res.length : 0 };
}

export async function markQueueError(id, err) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/recordings_queue?id=eq.${id}`;
  const payload = { status: "error", attempts: 1, error: String(err), finished_at: new Date().toISOString() };
  const res = await sbase(url, "PATCH", payload);
  return { updated: Array.isArray(res) ? res.length : 0 };
}
