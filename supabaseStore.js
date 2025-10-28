// supabaseStore.js
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠️ Supabase env missing (SUPABASE_URL / SUPABASE_SERVICE_KEY). Will fallback to in-memory sets.");
}

const supa = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false }
    })
  : null;

// fallback in-memory (на случай если нет сабы или саба легла)
const memoryProcessed = new Set();

// helper чтобы собрать ключ вида 'amo_note:174512111'
function makeKey(source_type, source_id) {
  return `${source_type}:${source_id}`;
}

// проверка — видели уже или нет
export async function isAlreadyProcessed(source_type, source_id) {
  const k = makeKey(source_type, source_id);

  // если supabase не настроен — просто смотрим в память процесса
  if (!supa) {
    return memoryProcessed.has(k);
  }

  const { data, error } = await supa
    .from("processed_calls")
    .select("id")
    .eq("source_type", source_type)
    .eq("source_id", source_id)
    .limit(1)
    .maybeSingle();

  if (error && error.code !== "PGRST116") { // PGRST116 = no rows
    console.warn("supabase isAlreadyProcessed error:", error);
  }

  // если нашли строку, значит да, уже было
  return !!data;
}

// пометить как обработанный
export async function markProcessed(source_type, source_id, audio_url = "") {
  const k = makeKey(source_type, source_id);
  if (!supa) {
    memoryProcessed.add(k);
    return { ok: true, stored: "memory" };
  }

  // пытаемся вставить; если такая запись уже была, просто игнорим
  const { error } = await supa
    .from("processed_calls")
    .insert([{ source_type, source_id, audio_url }])
    .select("id")
    .maybeSingle();

  if (error && error.code !== "23505") { // unique violation
    console.warn("supabase markProcessed error:", error);
    return { ok: false, error };
  }

  return { ok: true, stored: "supabase" };
}
