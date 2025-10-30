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
export async function markSeenOnly(source_type, source_id, record_url) {
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
