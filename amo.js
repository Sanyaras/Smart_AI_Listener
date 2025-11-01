// amo.js
import { fetchWithTimeout, fmtDate, debug, safeStr } from "./utils.js";
import { getAmoTokens, saveAmoTokens, insertCallRecord } from "./supabaseStore.js";

const BASE_URL = process.env.AMO_BASE_URL;
const CLIENT_ID = process.env.AMO_CLIENT_ID;
const CLIENT_SECRET = process.env.AMO_CLIENT_SECRET;
const REDIRECT_URI = process.env.AMO_REDIRECT_URI;
const TIMEZONE = process.env.AMO_TIMEZONE || "Europe/Moscow";

if (!BASE_URL || !CLIENT_ID || !CLIENT_SECRET)
  throw new Error("❌ Missing AmoCRM credentials in env");

// ================= AUTH =================

async function refreshAmoTokens(refreshToken) {
  debug("🔁 Refreshing Amo tokens...");
  const res = await fetchWithTimeout(`${BASE_URL}/oauth2/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const json = await res.json();
  if (json.access_token && json.refresh_token) {
    const expires_at = new Date(Date.now() + json.expires_in * 1000).toISOString();
    await saveAmoTokens({
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_at,
    });
    debug("✅ Amo tokens refreshed");
    return json;
  } else {
    console.error("❌ Failed to refresh Amo tokens:", safeStr(json));
    return null;
  }
}

async function getAccessToken() {
  const tokens = await getAmoTokens();
  if (!tokens) throw new Error("No Amo tokens found in Supabase");

  const exp = new Date(tokens.expires_at).getTime();
  if (Date.now() > exp - 60000) {
    debug("⚠️ Token expired, refreshing...");
    const refreshed = await refreshAmoTokens(tokens.refresh_token);
    return refreshed?.access_token;
  }
  return tokens.access_token;
}

// ================= CALL DETECTION =================

function isLikelyCall(note) {
  if (!note || note.note_type !== "call_in") return false;
  const link = note.params?.link || note.params?.LINK;
  return typeof link === "string" && link.endsWith(".mp3");
}

function extractCallLink(note) {
  const link = note.params?.link || note.params?.LINK;
  return typeof link === "string" && link.includes(".mp3") ? link : null;
}

// ================= FETCH RECENT CALL NOTES =================

async function fetchRecentNotes(sinceSeconds = 0, limit = 200) {
  const token = await getAccessToken();
  const url = `${BASE_URL}/api/v4/leads/notes?filter[type]=call_in&limit=${limit}`;

  const res = await fetchWithTimeout(
    url,
    { headers: { Authorization: `Bearer ${token}` } },
    20000
  );

  const json = await res.json();
  if (!json?._embedded?.notes) {
    debug("⚠️ No notes found:", safeStr(json));
    return [];
  }

  return json._embedded.notes.filter(
    (n) => n.created_at >= sinceSeconds && isLikelyCall(n)
  );
}

// ================= PROCESS CALLS =================

export async function processAmoCalls() {
  try {
    const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24; // последние 24 часа
    const fresh = await fetchRecentNotes(since, process.env.AMO_POLL_LIMIT || 100);

    if (!fresh.length) {
      debug("📭 Нет новых звонков");
      return 0;
    }

    debug(`📞 Найдено ${fresh.length} звонков`);

    for (const note of fresh) {
      const note_id = note.id;
      const contact_id = note.entity_id;
      const link = extractCallLink(note);
      const created_at = new Date(note.created_at * 1000).toISOString();

      if (!link) {
        debug(`⚪️ Пропущен note ${note_id}: нет mp3`);
        continue;
      }

      await insertCallRecord({ note_id, contact_id, link, created_at });
      debug(`✅ Добавлен звонок: ${note_id} (${fmtDate(note.created_at)})`);
    }

    return fresh.length;
  } catch (e) {
    console.error("❌ processAmoCalls:", safeStr(e));
    return 0;
  }
}
