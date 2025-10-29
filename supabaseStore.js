// supabaseStore.js — учёт обработанных звонков (чтобы не спамить повторно)
// таблица: processed_calls
// колонки:
//   id (uuid, default uuid_generate_v4())
//   source (text)            -> "amo_note" | "megapbx_call" | ...
//   note_id (text)
//   record_url (text)
//   processed_at (timestamptz, default now())
//   transcribed (bool, default true)
//   qa_done (bool, default true)

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

// low-level helper to call Supabase REST
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

  // Supabase может вернуть 406 "No Content" на select без результатов — это норм
  if (res.status === 406) return [];
  if (!res.ok) {
    const txt = await res.text().catch(()=> "");
    throw new Error(`supabase ${method} ${path} ${res.status}: ${txt}`);
  }
  if (res.status === 204) return null;
  return await res.json().catch(()=> null);
}

/**
 * Проверка: мы уже обрабатывали эту сущность?
 * source: "amo_note" / "megapbx_call" и т.д.
 * noteId: id заметки (amo) или callId (АТС)
 *
 * Возвращает true, если запись уже есть в processed_calls
 */
export async function isAlreadyProcessed(source, noteId) {
  try {
    const rows = await sbFetch(`/${TABLE}?source=eq.${encodeURIComponent(source)}&note_id=eq.${encodeURIComponent(noteId)}&select=id`);
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) {
    console.warn("isAlreadyProcessed error:", e?.message || e);
    // fail-safe: если база не отвечает — считаем "уже обработано", чтобы не сжечь токены Whisper
    return true;
  }
}

/**
 * Помечаем звонок как обработанный.
 * source: "amo_note" / "megapbx_call"
 * noteId: note_id или callId
 * recordUrl: исходная ссылка на аудио (для дебага)
 */
export async function markProcessed(source, noteId, recordUrl) {
  try {
    await sbFetch(`/${TABLE}`, {
      method: "POST",
      body: [{
        source: source,
        note_id: String(noteId),
        record_url: recordUrl,
        transcribed: true,
        qa_done: true,
      }]
    });
    console.log(`✅ Marked processed in Supabase: ${source}/${noteId}`);
  } catch (e) {
    console.warn("markProcessed error:", e?.message || e);
  }
}
