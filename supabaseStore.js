// supabaseStore.js
import { createClient } from "@supabase/supabase-js";
import { debug, safeStr } from "./utils.js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
if (!supabaseUrl || !supabaseKey) throw new Error("❌ Missing Supabase credentials");

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
});

// ===== CALL RECORDS TABLE =====

export async function insertCallRecord({ note_id, contact_id, link, created_at }) {
  try {
    const { data, error } = await supabase
      .from("call_records")
      .insert([{ note_id, contact_id, link, created_at, status: "new" }])
      .select();

    if (error) throw error;
    debug("✅ Added call record:", note_id);
    return data?.[0] || null;
  } catch (e) {
    console.error("❌ insertCallRecord:", safeStr(e));
    return null;
  }
}

export async function getUnprocessedCalls(limit = 10) {
  const { data, error } = await supabase
    .from("call_records")
    .select("*")
    .eq("status", "new")
    .limit(limit)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("❌ getUnprocessedCalls:", safeStr(error));
    return [];
  }
  return data || [];
}

export async function markCallProcessed(note_id, transcript, qa_report) {
  try {
    const { error } = await supabase
      .from("call_records")
      .update({
        status: "processed",
        transcript,
        qa_report,
        last_update: new Date().toISOString(),
      })
      .eq("note_id", note_id);

    if (error) throw error;
    debug("✅ Marked processed:", note_id);
    return true;
  } catch (e) {
    console.error("❌ markCallProcessed:", safeStr(e));
    return false;
  }
}

// ===== APP_SECRETS TABLE (AMO TOKENS) =====

export async function getAmoTokens() {
  const { data, error } = await supabase
    .from("app_secrets")
    .select("access_token, refresh_token, expires_at")
    .limit(1)
    .single();

  if (error) {
    console.error("❌ getAmoTokens:", safeStr(error));
    return null;
  }
  return data;
}

export async function saveAmoTokens({ access_token, refresh_token, expires_at }) {
  try {
    // очищаем таблицу и вставляем одну запись
    await supabase.from("app_secrets").delete().neq("id", 0);
    const { error } = await supabase.from("app_secrets").insert([
      { access_token, refresh_token, expires_at },
    ]);
    if (error) throw error;
    debug("💾 Saved Amo tokens to app_secrets");
  } catch (e) {
    console.error("❌ saveAmoTokens:", safeStr(e));
  }
}
