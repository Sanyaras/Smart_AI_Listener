// amo.js — Smart AI Listener / AmoCRM integration
// Версия: 2.4.2 (stable OAuth store + wide link parse + ignore older calls)

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

// сколько часов считаем «свежими» звонки из amo
const IGNORE_OLDER_HOURS = parseInt(process.env.AMO_IGNORE_OLDER_HOURS || "3", 10);
const IGNORE_MS = IGNORE_OLDER_HOURS * 60 * 60 * 1000;

// app_secrets ключи (канонические)
const SECRET_KEY_ACCESS  = "amo_access_token";
const SECRET_KEY_REFRESH = "amo_refresh_token";

/* -------------------- TOKENS: load & persist -------------------- */
let TOKENS_LOADED_ONCE = false;

async function loadTokensFromStoreIfNeeded() {
  if (TOKENS_LOADED_ONCE) return;

  // основной источник правды — app_secrets
  let acc = await getSecret(SECRET_KEY_ACCESS);
  let ref = await getSecret(SECRET_KEY_REFRESH);

  // обратная совместимость со старыми именами
  if (!acc) acc = await getSecret("AMO_ACCESS_TOKEN");
  if (!ref) ref = await getSecret("AMO_REFRESH_TOKEN");

  // env имеет приоритет если уже задан
  if (!AMO_ACCESS_TOKEN && acc) AMO_ACCESS_TOKEN = acc;
  if (!AMO_REFRESH_TOKEN && ref) AMO_REFRESH_TOKEN = ref;

  TOKENS_LOADED_ONCE = true;
}

async function persistTokens(access, refresh) {
  if (access) {
    AMO_ACCESS_TOKEN = access;
    await setSecret(SECRET_KEY_ACCESS, access);
    await setSecret("AMO_ACCESS_TOKEN", access); // бэкап
  }
  if (refresh) {
    AMO_REFRESH_TOKEN = refresh;
    await setSecret(SECRET_KEY_REFRESH, refresh);
    await setSecret("AMO_REFRESH_TOKEN", refresh); // бэкап
  }
}

/** Публичная точка для индекса — «подлить» токены из OAuth callback и сохранить их. */
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
  // legacy путь (через переменную AMO_AUTH_CODE) — оставлен для совместимости
  if (!AMO_AUTH_CODE) throw new Error("AMO_AUTH_CODE missing");
  const j = await amoOAuth({ grant_type: "authorization_code", code: AMO_AUTH_CODE });
  await persistTokens(j.access_token || "", j.refresh_token || "");
  return j;
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
    } finally {
      amoRefreshPromise = null;
    }
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

  // первая попытка
  let r = await doFetch(AMO_ACCESS_TOKEN);
  if (r.status === 401) {
    // пробуем рефреш
    try {
      await amoRefresh();
    } catch (e) {
      const body = await r.text().catch(()=> "");
      throw new Error(`amo ${path} 401 and refresh failed: ${body || e?.message || e}`);
    }
    // вторая попытка уже с новым access
    r = await doFetch(AMO_ACCESS_TOKEN);
  }

  if (r.status === 204) return { _embedded: { notes: [] } };
  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`amo ${path} ${r.status}: ${t}`);
  }
  return await r.json();
}

/* -------------------- Ответственный менеджер -------------------- */
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

/* -------------------- Парсер ссылок из заметок (расширенный) -------------------- */
function findRecordingLinksInNote(note) {
  const urls = new Set();

  // общий регэксп для любых https-URL (без требования на .mp3 и т.п.)
  const urlRe = /https?:\/\/[^\s"'<>]+/ig;

  const pushFromText = (txt) => {
    if (!txt) return;
    const m = String(txt).match(urlRe);
    if (m) m.forEach(u => urls.add(u));
  };

  // рекурсивно обходим объект и собираем ссылки из типовых полей
  const collectFromObj = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      const key = String(k).toLowerCase();

      if (typeof v === "string") {
        // поля, которые часто содержат ссылку на запись
        if (/(record|recording|audio|call|voice|download|file|storage|rec|link|url)/i.test(key)) {
          pushFromText(v);
        } else {
          pushFromText(v);
        }
      } else if (Array.isArray(v)) {
        v.forEach(collectFromObj);
      } else if (typeof v === "object") {
        try { pushFromText(JSON.stringify(v)); } catch {}
        collectFromObj(v);
      }
    }
  };

  // источники: note.text + note.params
  if (note?.text) pushFromText(note.text);
  if (note?.params) collectFromObj(note.params);

  // фильтрация кандидатов по «смысловым» словам (не требуем расширения)
  const candidates = Array.from(urls);
  const filtered = candidates.filter(u =>
    /(record|recording|audio|call|voice|download|file|storage|rec|mp3|wav|ogg|m4a|opus)/i.test(u)
  );

  // убираем очевидный мусор и дубли
  const out = Array.from(new Set(filtered)).filter(u => !/\.(svg|png|jpg|gif)(\?|$)/i.test(u));

  return out;
}

/* -------------------- Основная логика опроса заметок -------------------- */
export async function processAmoCallNotes(limit = 20, maxNewToProcessThisTick = Infinity) {
  // снимаем фильтр по типам заметок — иногда звонки не лежат как call_in/out
  const qs = `limit=${limit}`;

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

  // свежие — первыми
  picked.sort((a,b) => (b.created_at||0) - (a.created_at||0));

  const now = Date.now();
  let started = 0, skipped = 0, withLinks = 0, ignored = 0;

  for (const note of picked) {
    const source_type = "amo_note";
    const source_id = String(note.note_id);

    // анти-двойная обработка
    const already = await isAlreadyProcessed(source_type, source_id);
    if (already) { skipped++; continue; }

    // отбрасываем старше N часов
    const ageMs = now - (note.created_at * 1000);
    if (ageMs > IGNORE_MS) {
      // ВАЖНО: правильный порядок аргументов (source_type, source_id, record_url)
      await markSeenOnly(source_type, source_id, null);
      ignored++;
      continue;
    }

    if (started >= maxNewToProcessThisTick) break;

    // вытаскиваем ссылки на записи
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
