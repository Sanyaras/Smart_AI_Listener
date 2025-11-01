// amo.js
import { fetchWithTimeout, fmtDate, debug, safeStr } from "./utils.js";
import { getAmoTokens, saveAmoTokens, insertCallRecord } from "./supabaseStore.js";

const BASE_URL = process.env.AMO_BASE_URL;
const CLIENT_ID = process.env.AMO_CLIENT_ID;
const CLIENT_SECRET = process.env.AMO_CLIENT_SECRET;
const REDIRECT_URI = process.env.AMO_REDIRECT_URI;

if (!BASE_URL || !CLIENT_ID || !CLIENT_SECRET)
  throw new Error("❌ Missing AmoCRM credentials in env");

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

// ================= FETCH RECENT NOTES =================

function isValidCall(note) {
  if (!note) return false;
  const type = note.note_type;
  const link =
    note.params?.LINK || note.params?.link || note.params?.file || "";
  return (
    (type === "call_in" || type === "call_out") &&
    typeof link === "string" &&
    link.includes(".mp3")
  );
}

async function fetchNotes(scope = "leads", sinceSeconds = 0, limit = 200) {
  const token = await getAccessToken();
  const url = `${BASE_URL}/api/v4/${scope}/notes?filter[type][]=call_in&filter[type][]=call_out&limit=${limit}&order[id]=desc`;
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!json?._embedded?.notes) {
    debug(`⚠️ No notes found for ${scope}:`, safeStr(json));
    return [];
  }
  return json._embedded.notes.filter(
    (n) => n.created_at >= sinceSeconds && isValidCall(n)
  );
}

// ================= PROCESS CALLS =================

export async function processAmoCalls() {
  try {
    const since = Math.floor(Date.now() / 1000) - 60 * 60 * 24; // 24 часа
    const scopes = ["leads", "contacts"];
    let totalInserted = 0;

    for (const scope of scopes) {
      debug(`📡 Fetching recent ${scope} call notes...`);
      const fresh = await fetchNotes(scope, since, 200);
      if (!fresh.length) {
        debug(`📭 Нет звонков для ${scope}`);
        continue;
      }

      debug(`📞 Найдено ${fresh.length} звонков (${scope})`);

      for (const note of fresh) {
        const note_id = note.id;
        const entity_id = note.entity_id || 0;
        const link =
          note.params?.LINK || note.params?.link || note.params?.file || null;
        const created_at = note.created_at
          ? new Date(note.created_at * 1000).toISOString()
          : new Date().toISOString();

        if (!link) {
          debug(`⚪️ Пропущен note ${note_id}: нет ссылки`);
          continue;
        }

        await insertCallRecord({
          note_id,
          contact_id: entity_id,
          link,
          created_at,
          scope,
        });
        totalInserted++;
        debug(`✅ Добавлен звонок (${scope}): ${note_id} (${fmtDate(note.created_at)})`);
      }
    }

    debug(`📦 Всего добавлено ${totalInserted} звонков`);
    return totalInserted;
  } catch (e) {
    console.error("❌ processAmoCalls:", safeStr(e));
    return 0;
  }
}
