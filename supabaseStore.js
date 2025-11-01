// supabaseStore.js — унифицированное хранилище для Smart AI Listener
// Зависит от @supabase/supabase-js и переменных окружения:
// SUPABASE_URL, SUPABASE_SERVICE_KEY
// Таблицы настраиваются через ENV: SB_TBL_QUEUE / SB_TBL_SEEN / SB_TBL_SECRETS

import { createClient } from "@supabase/supabase-js";

// -------- ENV / init --------
const SUPABASE_URL  = process.env.SUPABASE_URL || "";
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn("[supabaseStore] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
}

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Имена таблиц (можно переопределить через ENV)
const TBL_QUEUE   = process.env.SB_TBL_QUEUE   || "recordings_queue";
const TBL_SEEN    = process.env.SB_TBL_SEEN    || "amo_notes_seen";
const TBL_SECRETS = process.env.SB_TBL_SECRETS || "app_secrets";

/* ============================================================
 * QUEUE API
 * ============================================================
 * Структура ожидаемой таблицы recordings_queue (минимум):
 * id (uuid/serial), status (text: 'pending'|'done'|'failed'),
 * record_url (text), amo_note_key (text), created_at (timestamptz),
 * finished_at (timestamptz), error_reason (text),
 * transcript_len (int), score_total (int),
 * issues (jsonb), summary (text), qa_raw (jsonb)
 */

// Вернуть pending-задачи по FIFO
export async function getPending(limit = 5) {
  const { data, error } = await sb
    .from(TBL_QUEUE)
    .select("*")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

// Поставить запись в очередь (если такой amo_note_key + record_url уже есть — не дублировать)
export async function enqueueRecording(payload) {
  // ожидаем: { record_url, amo_note_key, ... }
  const record_url = (payload?.record_url || payload?.recordUrl || "").trim();
  const amo_note_key = (payload?.amo_note_key || payload?.amoNoteKey || "").trim();

  if (!record_url) throw new Error("enqueueRecording: record_url is required");

  // Пытаемся найти дубликат
  let q = sb.from(TBL_QUEUE).select("id,status").eq("record_url", record_url).limit(1);
  if (amo_note_key) q = q.eq("amo_note_key", amo_note_key);

  const { data: exist, error: errFind } = await q;
  if (errFind) throw errFind;

  if (Array.isArray(exist) && exist.length > 0) {
    // Уже в очереди — ок, просто вернём существующий id
    return { id: exist[0].id, status: exist[0].status, dedup: true };
  }

  const insert = {
    status: "pending",
    record_url,
    amo_note_key: amo_note_key || null,
    created_at: new Date().toISOString(),
    ...(payload || {}),
  };

  const { data, error } = await sb.from(TBL_QUEUE).insert(insert).select("id,status").limit(1);
  if (error) throw error;
  return (data && data[0]) ? data[0] : null;
}

// Завершить задачу успешно (с сохранением результатов)
export async function markDone(id, payload = {}) {
  if (!id) throw new Error("markDone: id is required");
  const patch = {
    status: "done",
    finished_at: new Date().toISOString(),
    ...(payload || {}),
  };
  const { error } = await sb.from(TBL_QUEUE).update(patch).eq("id", id);
  if (error) throw error;
  return true;
}

// Пометить задачу как failed
export async function markFailed(id, reason = "unknown") {
  if (!id) throw new Error("markFailed: id is required");
  const patch = {
    status: "failed",
    finished_at: new Date().toISOString(),
    error_reason: String(reason).slice(0, 1000),
  };
  const { error } = await sb.from(TBL_QUEUE).update(patch).eq("id", id);
  if (error) throw error;
  return true;
}

// Статистика очереди (для /diag)
export async function getQueueStats() {
  const { data, error } = await sb.from(TBL_QUEUE).select("status");
  if (error) throw error;
  const counts = { total: 0, pending: 0, done: 0, failed: 0 };
  for (const row of data || []) {
    counts.total++;
    const s = String(row.status || "").toLowerCase();
    if (counts[s] !== undefined) counts[s]++;
  }
  return counts;
}

/* ============================================================
 * SEEN NOTES API (для amo.js)
 * ============================================================
 * Таблица amo_notes_seen (минимум):
 * id (uuid/serial), note_key (text unique), seen_at (timestamptz), processed_at (timestamptz)
 */

// Проверить, обрабатывали ли уже эту заметку (true если была processed)
export async function isAlreadyProcessed(noteKey) {
  if (!noteKey) return false;
  const { data, error } = await sb
    .from(TBL_SEEN)
    .select("processed_at, seen_at")
    .eq("note_key", String(noteKey))
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return false;
  // processed_at приоритетно; если только seen_at — считаем «видели, но не обработали»
  return Boolean(data[0].processed_at);
}

// Отметить как увиденную (но ещё не обработанную)
export async function markSeenOnly(noteKey) {
  if (!noteKey) return false;
  const now = new Date().toISOString();
  // upsert по note_key
  const { error } = await sb
    .from(TBL_SEEN)
    .upsert({ note_key: String(noteKey), seen_at: now }, { onConflict: "note_key" });
  if (error) throw error;
  return true;
}

// Отметить как обработанную
export async function markProcessed(noteKey) {
  if (!noteKey) return false;
  const now = new Date().toISOString();
  const { error } = await sb
    .from(TBL_SEEN)
    .upsert({ note_key: String(noteKey), processed_at: now, seen_at: now }, { onConflict: "note_key" });
  if (error) throw error;
  return true;
}

/* ============================================================
 * APP SECRETS (опционально: хранение токенов/параметров)
 * ============================================================
 * Таблица app_secrets (минимум):
 * id (uuid/serial), key (text unique), val (text/jsonb), updated_at (timestamptz)
 */

// Получить секрет по ключу (строка или объект, как храните)
export async function getSecret(key) {
  if (!key) return null;
  const { data, error } = await sb
    .from(TBL_SECRETS)
    .select("val")
    .eq("key", String(key))
    .limit(1);
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return data[0]?.val ?? null;
}

// Установить/обновить секрет
export async function setSecret(key, val) {
  if (!key) return false;
  const now = new Date().toISOString();
  const row = { key: String(key), val, updated_at: now };
  const { error } = await sb.from(TBL_SECRETS).upsert(row, { onConflict: "key" });
  if (error) throw error;
  return true;
}
