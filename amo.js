// amo.js — Smart AI Listener / AmoCRM integration
// Версия: 2.3.0 (anti-spam + ignore older calls)

import { fetchWithTimeout, mask, chunkText } from "./utils.js";
import { sendTG, sendTGDocument, tgRelayAudio } from "./telegram.js";
import { enqueueAsr, transcribeAudioFromUrl } from "./asr.js";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";
import { isAlreadyProcessed, markProcessed, markSeenOnly } from "./supabaseStore.js";

// ---- env
const AMO_BASE_URL       = (process.env.AMO_BASE_URL || "").replace(/\/+$/,"");
const AMO_CLIENT_ID      = process.env.AMO_CLIENT_ID || "";
const AMO_CLIENT_SECRET  = process.env.AMO_CLIENT_SECRET || "";
const AMO_REDIRECT_URI   = process.env.AMO_REDIRECT_URI || "";
const AMO_AUTH_CODE      = process.env.AMO_AUTH_CODE || "";
let   AMO_ACCESS_TOKEN   = process.env.AMO_ACCESS_TOKEN || "";
let   AMO_REFRESH_TOKEN  = process.env.AMO_REFRESH_TOKEN || "";

const IGNORE_OLDER_HOURS = parseInt(process.env.AMO_IGNORE_OLDER_HOURS || "3", 10);
const IGNORE_MS = IGNORE_OLDER_HOURS * 60 * 60 * 1000;

// ---- utils
export function getAmoTokensMask() {
  return {
    access: AMO_ACCESS_TOKEN ? mask(AMO_ACCESS_TOKEN) : "",
    refresh: AMO_REFRESH_TOKEN ? mask(AMO_REFRESH_TOKEN) : ""
  }
}

function ensureAmoEnv() {
  if (!AMO_BASE_URL || !AMO_CLIENT_ID || !AMO_CLIENT_SECRET || !AMO_REDIRECT_URI) {
    throw new Error("AMO_* env incomplete");
  }
}

async function amoOAuth(body) {
  ensureAmoEnv();
  const url = `${AMO_BASE_URL}/oauth2/access_token`;
  const resp = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: AMO_CLIENT_ID,
      client_secret: AMO_CLIENT_SECRET,
      redirect_uri: AMO_REDIRECT_URI,
      ...body
    })
  }, 20000);
  if (!resp.ok) throw new Error(`amo oauth ${resp.status}: ${await resp.text().catch(()=> "")}`);
  return await resp.json();
}

export async function amoExchangeCode() {
  if (!AMO_AUTH_CODE) throw new Error("AMO_AUTH_CODE missing");
  const j = await amoOAuth({ grant_type: "authorization_code", code: AMO_AUTH_CODE });
  AMO_ACCESS_TOKEN = j.access_token || "";
  AMO_REFRESH_TOKEN = j.refresh_token || "";
  return j;
}

let amoRefreshPromise = null;
export async function amoRefresh() {
  if (!AMO_REFRESH_TOKEN) throw new Error("AMO_REFRESH_TOKEN missing");
  if (amoRefreshPromise) return amoRefreshPromise;
  amoRefreshPromise = (async () => {
    try {
      const j = await amoOAuth({ grant_type: "refresh_token", refresh_token: AMO_REFRESH_TOKEN });
      AMO_ACCESS_TOKEN = j.access_token || "";
      AMO_REFRESH_TOKEN = j.refresh_token || "";
      return j;
    } finally {
      amoRefreshPromise = null;
    }
  })();
  return amoRefreshPromise;
}

export async function amoFetch(path, opts = {}, ms = 15000) {
  ensureAmoEnv();
  if (!AMO_ACCESS_TOKEN) throw new Error("No AMO_ACCESS_TOKEN — run /amo/exchange first");
  const url = `${AMO_BASE_URL}${path}`;
  const r = await fetchWithTimeout(url, {
    ...opts,
    headers: { "authorization": `Bearer ${AMO_ACCESS_TOKEN}`, "content-type":"application/json", ...(opts.headers||{}) }
  }, ms);
  if (r.status === 401) {
    await amoRefresh();
    const r2 = await fetchWithTimeout(url, {
      ...opts,
      headers: { "authorization": `Bearer ${AMO_ACCESS_TOKEN}`, "content-type":"application/json", ...(opts.headers||{}) }
    }, ms);
    if (!r2.ok) throw new Error(`amo ${path} ${r2.status}: ${await r2.text().catch(()=> "")}`);
    return await r2.json();
  }
  if (r.status === 204) return { _embedded: { notes: [] } };
  if (!r.ok) throw new Error(`amo ${path} ${r.status}: ${await r.text().catch(()=> "")}`);
  return await r.json();
}

/* ------- ответственный менеджер ------- */
const AMO_USER_CACHE = new Map();
let AMO_USER_CACHE_TS = 0;

async function amoGetUsersMap() {
  const NOW = Date.now();
  if (NOW - AMO_USER_CACHE_TS < 10 * 60 * 1000 && AMO_USER_CACHE.size > 0) {
    return AMO_USER_CACHE;
  }
  const data = await amoFetch("/api/v4/users?limit=250");
  const arr = data?._embedded?.users || [];
  AMO_USER_CACHE.clear();
  for (const u of arr) {
    AMO_USER_CACHE.set(u.id, {
      name: (
        [u.name, u.last_name, u.first_name, u.middle_name]
          .filter(Boolean)
          .join(" ")
          .trim()
      ) || u.name || `user#${u.id}`
    });
  }
  AMO_USER_CACHE_TS = NOW;
  return AMO_USER_CACHE;
}

async function amoGetResponsible(entity, entityId) {
  try {
    let path = "";
    if (entity === "lead")        path = `/api/v4/leads/${entityId}`;
    else if (entity === "contact") path = `/api/v4/contacts/${entityId}`;
    else if (entity === "company") path = `/api/v4/companies/${entityId}`;
    else return { userId: null, userName: null };

    const card = await amoFetch(path);
    const respId = card.responsible_user_id || card.responsible_user || null;

    if (!respId) {
      return { userId: null, userName: null };
    }

    const usersMap = await amoGetUsersMap();
    const u = usersMap.get(respId);
    return {
      userId: respId,
      userName: u ? u.name : `user#${respId}`
    };
  } catch (e) {
    console.warn("amoGetResponsible error:", e?.message || e);
    return { userId: null, userName: null };
  }
}

/* ------- парсинг ссылок из примечания ------- */
function findRecordingLinksInNote(note) {
  const sources = [];
  if (note.text) sources.push(String(note.text));
  if (note.params && typeof note.params === "object") {
    sources.push(JSON.stringify(note.params));
  }
  const blob = sources.join(" ");
  const urls = [];
  const re = /(https?:\/\/[^\s"'<>]+?\.(mp3|wav|ogg|m4a|opus)(\?[^\s"'<>]*)?)/ig;
  let m;
  while ((m = re.exec(blob))) {
    urls.push(m[1]);
  }
  return Array.from(new Set(urls));
}

/* ------- основная логика опроса amo notes ------- */
export async function processAmoCallNotes(limit = 20, maxNewToProcessThisTick = Infinity) {
  const qs = `limit=${limit}&filter[note_type][]=call_in&filter[note_type][]=call_out`;

  const [leads, contacts, companies] = await Promise.all([
    amoFetch(`/api/v4/leads/notes?${qs}`),
    amoFetch(`/api/v4/contacts/notes?${qs}`),
    amoFetch(`/api/v4/companies/notes?${qs}`)
  ]);

  const picked = [];
  const pack = (entity, arr) => {
    const items = Array.isArray(arr?._embedded?.notes) ? arr._embedded.notes : [];
    for (const n of items) {
      picked.push({
        entity,
        note_id: n.id,
        note_type: n.note_type,
        created_at: n.created_at,
        entity_id: n.entity_id,
        text: n.text || n.params?.text || "",
        params: n.params || n.payload || n.data || {}
      });
    }
  };
  pack("lead", leads);
  pack("contact", contacts);
  pack("company", companies);

  picked.sort((a,b) => (b.created_at||0) - (a.created_at||0));

  const now = Date.now();
  let started = 0, skipped = 0, withLinks = 0, ignored = 0;

  for (const note of picked) {
    const source_type = "amo_note";
    const source_id = String(note.note_id);

    const already = await isAlreadyProcessed(source_type, source_id);
    if (already) { skipped++; continue; }

    const ageMs = now - (note.created_at * 1000);
    if (ageMs > IGNORE_MS) {
      await markSeenOnly(source_id, null, source_type);
      ignored++;
      continue;
    }

    if (started >= maxNewToProcessThisTick) break;

    const links = findRecordingLinksInNote(note);
    if (!links.length) { skipped++; continue; }
    withLinks++;

    const respInfo = await amoGetResponsible(note.entity, note.entity_id);
    const managerTxt = respInfo.userName ? respInfo.userName : "неизвестно";

    for (const origUrl of links) {
      let relayCdnUrl;
      try {
        relayCdnUrl = await tgRelayAudio(origUrl, `🎧 Аудио (${note.note_type}) • ${managerTxt}`);
      } catch {
        relayCdnUrl = origUrl;
      }

      const text = await enqueueAsr(() =>
        transcribeAudioFromUrl(relayCdnUrl, { callId: `amo-${note.note_id}` })
      );

      if (text) {
        const qa = await analyzeTranscript(text, {
          callId: `amo-${note.note_id}`,
          brand: process.env.CALL_QA_BRAND || "",
          manager: managerTxt,
          amo_entity: note.entity,
          amo_entity_id: note.entity_id
        });
        await sendTG(formatQaForTelegram(qa));
        started++;
        await markProcessed(source_type, source_id, origUrl);
      } else {
        await sendTG("⚠️ ASR не удалось выполнить для ссылки из amo.");
      }
    }
  }

  return { scanned: picked.length, withLinks, started, skipped, ignored };
}
