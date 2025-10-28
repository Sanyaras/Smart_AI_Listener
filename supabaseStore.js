// supabaseStore.js — Supabase лог транскрибированных звонков
// используется таблица processed_calls (источник: amo / megafon)

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

  const url = `${SUPABASE_URL.replace(/\/+$/,"")}/rest/v1${path}`;

  const headers = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal
  });

  if (res.status === 406) return [];
  if (!res.ok) {
    const txt = await res.text().catch(()=> "");
    throw new Error(`supabase ${method} ${path} ${res.status}: ${txt}`);
  }
  if (res.status === 204) return null;
  return await res.json().catch(()=> null);
}

// Проверяем: уже обрабатывали ли эту note_id?
export async function wasAlreadyProcessed(noteId) {
  try {
    const rows = await sbFetch(`/${TABLE}?note_id=eq.${noteId}&select=note_id`);
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.warn("wasAlreadyProcessed error:", e?.message || e);
    // fail-safe: если supabase недоступен, считаем "обработано", чтобы не сжечь деньги
    return true;
  }
}

// Помечаем, что нота обработана
export async function markProcessed({ note_id, record_url, source = "amo" }) {
  try {
    await sbFetch(`/${TABLE}`, {
      method: "POST",
      body: [{
        source,
        note_id: String(note_id),
        record_url,
        transcribed: true,
        qa_done: true
      }]
    });
  } catch (e) {
    console.warn("markProcessed error:", e?.message || e);
  }
}
