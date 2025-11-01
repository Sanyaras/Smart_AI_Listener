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

export async function getAmoTokens() {
  try {
    const { data, error } = await supabase
      .from("app_secrets")
      .select("key, val");

    if (error) throw error;

    const map = {};
    for (const row of data || []) {
      map[row.key.toLowerCase()] = row.val;
    }

    const access_token = map.amo_access_token || map.amo_access_token?.toUpperCase() || map.amo_access_token;
    const refresh_token = map.amo_refresh_token || map.amo_refresh_token?.toUpperCase() || map.amo_refresh_token;
    const expires_at = map.amo_expires_at || null;

    if (!access_token || !refresh_token) {
      console.error("⚠️ Amo tokens not found in app_secrets");
      return null;
    }

    return { access_token, refresh_token, expires_at };
  } catch (e) {
    console.error("❌ getAmoTokens:", e.message);
    return null;
  }
}

export async function saveAmoTokens({ access_token, refresh_token, expires_at }) {
  try {
    const entries = [
      { key: "amo_access_token", val: access_token },
      { key: "AMO_ACCESS_TOKEN", val: access_token },
      { key: "amo_refresh_token", val: refresh_token },
      { key: "AMO_REFRESH_TOKEN", val: refresh_token },
      { key: "amo_expires_at", val: expires_at || new Date(Date.now() + 3600 * 1000).toISOString() },
    ];

    for (const row of entries) {
      await supabase.from("app_secrets").upsert(row, { onConflict: "key" });
    }

    debug("💾 Amo tokens updated in app_secrets");
  } catch (e) {
    console.error("❌ saveAmoTokens:", e.message);
  }
}
