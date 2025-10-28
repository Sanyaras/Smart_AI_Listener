// supabaseStore.js
// Храним обработанные звонки/аудио в Supabase, чтобы не дублировать ASR

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠️ SUPABASE_URL / SUPABASE_SERVICE_KEY not set. Dup-protection will NOT work.");
}

// один клиент на всё приложение
const sb = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
  : null;

/**
 * checkAlreadyProcessed
 * возвращает true, если мы уже обрабатывали этот звонок
 *
 * логика:
 *  - если есть note_id → ищем по note_id
 *  - если есть record_url → ищем по record_url
 */
export async function checkAlreadyProcessed({ note_id, record_url }) {
  if (!sb) return false; // нет базы — считаем, что не обрабатывали

  try {
    // сначала по note_id
    if (note_id) {
      const { data, error } = await sb
        .from("processed_calls")
        .select("id")
        .eq("note_id", note_id)
        .limit(1);

      if (error) {
        console.warn("supabase check note_id error:", error.message || error);
      } else if (data && data.length > 0) {
        return true; // уже есть
      }
    }

    // fallback: по ссылке на запись
    if (record_url) {
      const { data, error } = await sb
        .from("processed_calls")
        .select("id")
        .eq("record_url", record_url)
        .limit(1);

      if (error) {
        console.warn("supabase check record_url error:", error.message || error);
      } else if (data && data.length > 0) {
        return true;
      }
    }

    return false;
  } catch (e) {
    console.warn("supabase checkAlreadyProcessed EXC:", e?.message || e);
    return false;
  }
}

/**
 * saveProcessedCall
 * кладём факт обработки (и транскрипт если есть)
 */
export async function saveProcessedCall({
  note_id,
  record_url,
  manager,
  transcript
}) {
  if (!sb) return false;

  try {
    const row = {
      note_id: note_id ?? null,
      record_url: record_url ?? null,
      manager: manager ?? null,
      transcript: transcript ?? null,
      created_at: new Date().toISOString()
    };

    const { data, error } = await sb
      .from("processed_calls")
      .insert(row)
      .select("id")
      .single();

    if (error) {
      console.warn("supabase saveProcessedCall error:", error.message || error);
      return false;
    }

    return Boolean(data && data.id);
  } catch (e) {
    console.warn("supabase saveProcessedCall EXC:", e?.message || e);
    return false;
  }
}
