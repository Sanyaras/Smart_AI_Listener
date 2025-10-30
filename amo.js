// amo.js — Smart AI Listener / AmoCRM integration
// Версия: 2.6.1 (pagination + date/link/context + wide parse)

import { fetchWithTimeout, mask } from "./utils.js";
import { sendTG, tgRelayAudio } from "./telegram.js";
import { enqueueAsr, transcribeAudioFromUrl } from "./asr.js";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";
import { isAlreadyProcessed, markProcessed, markSeenOnly, getSecret, setSecret } from "./supabaseStore.js";

/* -------------------- ENV -------------------- */
const AMO_BASE_URL       = (process.env.AMO_BASE_URL || "").replace(/\/+$/,"");
const AMO_CLIENT_ID      = process.env.AMO_CLIENT_ID || "";
const AMO_CLIENT_SECRET  = process.env.AMO_CLIENT_SECRET || "";
const AMO_REDIRECT_URI   = process.env.AMO_REDIRECT_URI || "";
const AMO_AUTH_CODE      = process.env.AMO_AUTH_CODE || "";
let   AMO_ACCESS_TOKEN   = process.env.AMO_ACCESS_TOKEN || "";
let   AMO_REFRESH_TOKEN  = process.env.AMO_REFRESH_TOKEN || "";

// Часовой пояс для отображения времени заметки
const AMO_TIMEZONE       = process.env.AMO_TIMEZONE || "Europe/Moscow";

// Сколько часов считаем «свежими» звонки (0 = не ограничивать)
const IGNORE_OLDER_HOURS = parseInt(process.env.AMO_IGNORE_OLDER_HOURS || "72", 10);
const IGNORE_MS = IGNORE_OLDER_HOURS * 60 * 60 * 1000;

/* -------------------- TOKENS store -------------------- */
const SECRET_KEY_ACCESS  = "amo_access_token";
const SECRET_KEY_REFRESH = "amo_refresh_token";
let TOKENS_LOADED_ONCE = false;

async function loadTokensFromStoreIfNeeded() {
  if (TOKENS_LOADED_ONCE) return;

  let acc = await getSecret(SECRET_KEY_ACCESS);
  let ref = await getSecret(SECRET_KEY_REFRESH);

  // обратная совместимость
  if (!acc) acc = await getSecret("AMO_ACCESS_TOKEN");
  if (!ref) ref = await getSecret("AMO_REFRESH_TOKEN");

  // если токены не заданы через env — берём из стора
  if (!AMO_ACCESS_TOKEN && acc) AMO_ACCESS_TOKEN = acc;
  if (!AMO_REFRESH_TOKEN && ref) AMO_REFRESH_TOKEN = ref;

  TOKENS_LOADED_ONCE = true;
}

async function persistTokens(access, refresh) {
  if (access) {
    AMO_ACCESS_TOKEN = access;
    await setSecret(SECRET_KEY_ACCESS, access);
    await setSecret("AMO_ACCESS_TOKEN", access); // бэкап-ключ
  }
  if (refresh) {
    AMO_REFRESH_TOKEN = refresh;
    await setSecret(SECRET_KEY_REFRESH, refresh);
    await setSecret("AMO_REFRESH_TOKEN", refresh); // бэкап-ключ
  }
}

// публично — чтобы из index.js «подлить» токены после /oauth/callback
export function injectAmoTokens(access, refresh) {
  return persistTokens(access, refresh);
}

/* -------------------- UTILS -------------------- */
export function getAmoTokensMask() {
  return {
    access: AMO_ACCESS_TOKEN ? mask(AMO_ACCESS_TOKEN) : "",
    refresh: AMO_REFRESH_TOKEN ? mask(AMO_REFRESH_TOKEN) : ""
  };
}

function ensureAmoEnv() {
  if (!AMO_BASE_URL || !AMO_CLIENT_ID || !AMO_CLIENT_SECRET || !AMO_REDIRECT_URI) {
    throw new Error("AMO_* env incomplete");
  }
}

function fmtTs(tsSec) {
  if (!tsSec) return "—";
  try {
    return new Date(tsSec * 1000).toLocaleString("ru-RU", { timeZone: AMO_TIMEZONE });
  } catch {
    return new Date(tsSec * 1000).toISOString();
  }
}

/* -------------------- OAuth / Fetch -------------------- */
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

let amoRefreshPromise = null;
export async function amoRefresh() {
  await loadTokensFromStoreIfNeeded();
  if (!AMO_REFRESH_TOKEN) throw new Error("AMO_REFRESH_TOKEN missing");
  if (amoRefreshPromise) return amoRefreshPromise;
  amoRefreshPromise = (async () => {
    try {
      const j = await amoOAuth({ grant_type: "refresh_token", refresh_token: AMO_REFRESH_TOKEN });
      await persistTokens(j.access_token || "", j.refresh_token || "");
      return j;
    } finally { amoRefreshPromise = null; }
  })();
  return amoRefreshPromise;
}

export async function amoFetch(path, opts = {}, ms = 15000) {
  ensureAmoEnv();
  await loadTokensFromStoreIfNeeded();

  if (!AMO_ACCESS_TOKEN) throw new Error("No AMO_ACCESS_TOKEN — do OAuth at /amo/oauth/start");

  const url = `${AMO_BASE_URL}${path}`;
  const doFetch = (token) =>
    fetchWithTimeout(url, {
      ...opts,
      headers: { "authorization": `Bearer ${token}`, "content-type":"application/json", ...(opts.headers||{}) }
    }, ms);

  let r = await doFetch(AMO_ACCESS_TOKEN);
  if (r.status === 401) {
    await amoRefresh();
    r = await doFetch(AMO_ACCESS_TOKEN);
  }
  if (r.status === 204) return { _embedded: { notes: [] } };
  if (!r.ok) throw new Error(`amo ${path} ${r.status}: ${await r.text().catch(()=> "")}`);
  return await r.json();
}

/* -------------------- Pagination helper -------------------- */
async function amoFetchPaged(pathBase, perPage = 100, pagesMax = 5) {
  let page = 1;
  const all = [];
  while (page <= pagesMax) {
    const sep = pathBase.includes("?") ? "&" : "?";
    const j = await amoFetch(`${pathBase}${sep}limit=${perPage}&page=${page}`);
    const arr = Array.isArray(j?._embedded?.notes) ? j._embedded.notes : [];
    all.push(...arr);
    const next = j?._links?.next?.href;
    if (!next || arr.length === 0) break;
    page++;
  }
  return all;
}

/* -------------------- Users (ответственный) -------------------- */
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
      name:
        ([u.name, u.last_name, u.first_name, u.middle_name].filter(Boolean).join(" ").trim()) ||
        u.name || `user#${u.id}`
    });
  }
  AMO_USER_CACHE_TS = NOW;
  return AMO_USER_CACHE;
}

async function amoGetResponsible(entity, entityId) {
  try {
    let path = "";
    if (entity === "lead") path = `/api/v4/leads/${entityId}`;
    else if (entity === "contact") path = `/api/v4/contacts/${entityId}`;
    else if (entity === "company") path = `/api/v4/companies/${entityId}`;
    else return { userId: null, userName: null };

    const card = await amoFetch(path);
    const respId = card.responsible_user_id || card.responsible_user || null;

    if (!respId) return { userId: null, userName: null };

    const usersMap = await amoGetUsersMap();
    const u = usersMap.get(respId);
    return { userId: respId, userName: u ? u.name : `user#${respId}` };
  } catch {
    return { userId: null, userName: null };
  }
}

/* -------------------- Link parser (wide) -------------------- */
function findRecordingLinksInNote(note) {
  const urls = new Set();
  const urlRe = /https?:\/\/[^\s"'<>]+/ig;

  const pushFromText = (txt) => {
    if (!txt) return;
    const m = String(txt).match(urlRe);
    if (m) m.forEach(u => urls.add(u));
  };

  const collectFromObj = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).toLowerCase();
      if (typeof v === "string") {
        // подсказочные названия полей
        if (/(record|recording|audio|call|voice|download|file|storage|rec|link|url)/i.test(key)) pushFromText(v);
        else pushFromText(v);
      } else if (Array.isArray(v)) {
        v.forEach(collectFromObj);
      } else if (typeof v === "object") {
        try { pushFromText(JSON.stringify(v)); } catch {}
        collectFromObj(v);
      }
    }
  };

  if (note?.text) pushFromText(note.text);
  if (note?.params) collectFromObj(note.params);

  const candidates = Array.from(urls);
  const filtered = candidates.filter(u =>
    /(record|recording|audio|call|voice|download|file|storage|rec|mp3|wav|ogg|m4a|opus)/i.test(u)
  );
  return Array.from(new Set(filtered)).filter(u => !/\.(svg|png|jpg|gif)(\?|$)/i.test(u));
}

/* -------------------- Main loop -------------------- */
export async function processAmoCallNotes(limit = 100, maxNewToProcessThisTick = Infinity) {
  // Снимаем фильтр по типам заметок (иногда интеграции пишут не как call_in/out)
  const [leadNotes, contactNotes, companyNotes] = await Promise.all([
    amoFetchPaged("/api/v4/leads/notes", limit, 5),
    amoFetchPaged("/api/v4/contacts/notes", limit, 5),
    amoFetchPaged("/api/v4/companies/notes", limit, 5),
  ]);

  const picked = [];
  const pack = (entity, items) => {
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
  pack("lead", leadNotes);
  pack("contact", contactNotes);
  pack("company", companyNotes);

  picked.sort((a,b) => (b.created_at||0) - (a.created_at||0));

  const now = Date.now();
  let started = 0, skipped = 0, withLinks = 0, ignored = 0;

  for (const note of picked) {
    const source_type = "amo_note";
    const source_id = String(note.note_id);

    // Анти-дубль
    if (await isAlreadyProcessed(source_type, source_id)) { skipped++; continue; }

    // Отбрасываем слишком старые, если включено ограничение
    const ageMs = now - (note.created_at * 1000);
    if (IGNORE_OLDER_HOURS > 0 && ageMs > IGNORE_MS) {
      // порядок аргументов: (source_type, source_id, record_url)
      await markSeenOnly(source_type, source_id, null);
      ignored++;
      continue;
    }

    if (started >= maxNewToProcessThisTick) break;

    // Ссылки на записи
    const links = findRecordingLinksInNote(note);
    if (!links.length) { skipped++; continue; }
    withLinks++;

    // Ответственный + дата + ссылка на сущность
    const when = fmtTs(note.created_at);
    const respInfo = await amoGetResponsible(note.entity, note.entity_id);
    const managerTxt = respInfo.userName || "неизвестно";
    const entityUrl = `${AMO_BASE_URL}/${note.entity}s/detail/${note.entity_id}`;

    for (const origUrl of links) {
      let relayCdnUrl;
      try {
        // Перекидываем в TG CDN с подписью (менеджер + дата + линк на Amo)
        const caption = `🎧 Аудио (${note.note_type}) • ${managerTxt} • ${when}\n<a href="${entityUrl}">🔗 Открыть в AmoCRM</a>`;
        relayCdnUrl = await tgRelayAudio(origUrl, caption);
      } catch {
        relayCdnUrl = origUrl;
      }

      const text = await enqueueAsr(() =>
        transcribeAudioFromUrl(relayCdnUrl, { callId: `amo-${note.note_id}`, when })
      );

      if (text) {
        const qa = await analyzeTranscript(text, {
          callId: `amo-${note.note_id}`,
          when,
          manager: managerTxt,
          amo_entity: note.entity,
          amo_entity_id: note.entity_id,
          amo_entity_url: entityUrl
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
