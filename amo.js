// amo.js — Smart AI Listener / AmoCRM integration
// Версия: 2.4.0 (anti-spam + ignore older calls + early TG notify)

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
    headers: {
      "authorization": `Bearer ${AMO_ACCESS_TOKEN}`,
      "content-type":"application/json",
      ...(opts.headers||{})
    }
  }, ms);

  if (r.status === 401) {
    await amoRefresh();
    const r2 = await fetchWithTimeout(url, {
      ...opts,
      headers: {
        "authorization": `Bearer ${AMO_ACCESS_TOKEN}`,
        "content-type":"application/json",
        ...(opts.headers||{})
      }
    }, ms);
    if (!r2.ok) throw new Error(`amo ${path} ${r2.status}: ${await r2.text().catch(()=> "")}`);
    return await r2.json();
  }

  if (r.status === 204) {
    return { _embedded: { notes: [] } };
  }

  if (!r.ok) {
    throw new Error(`amo ${path} ${r.status}: ${await r.text().catch(()=> "")}`);
  }

  return await r.json();
}

/* ------- кеш ответственных менеджеров ------- */
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

/* ------- достаём mp3-ссылки из body заметки ------- */
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

/* ------- основная логика опроса amo call_in / call_out ------- */
/**
 * @param {number} limit - сколько нот берем из amo (20..100)
 * @param {object|number} throttleArg - режим антиспама.
 *   Старый формат: number maxNewToProcessThisTick (Infinity by default)
 *   Новый формат: { bootstrapRemainingRef } - ref с полем .val
 *
 * Возвращает:
 * { scanned, withLinks, started, skipped, ignored }
 */
export async function processAmoCallNotes(limit = 20, throttleArg = Infinity) {
  // поддерживаем оба формата аргумента:
  let bootstrapRef = null;
  let maxNewToProcessThisTick = Infinity;
  if (typeof throttleArg === "number") {
    maxNewToProcessThisTick = throttleArg;
  } else if (throttleArg && typeof throttleArg === "object") {
    bootstrapRef = throttleArg.bootstrapRemainingRef || null;
    if (bootstrapRef && typeof bootstrapRef.val === "number") {
      maxNewToProcessThisTick = bootstrapRef.val;
    }
  }

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
        created_at: n.created_at,   // unix sec
        entity_id: n.entity_id,
        text: n.text || n.params?.text || "",
        params: n.params || n.payload || n.data || {}
      });
    }
  };
  pack("lead", leads);
  pack("contact", contacts);
  pack("company", companies);

  // свежие сверху
  picked.sort((a,b) => (b.created_at||0) - (a.created_at||0));

  const now = Date.now();
  let started = 0, skipped = 0, withLinks = 0, ignored = 0;

  for (const note of picked) {
    const source_type = "amo_note";
    const source_id = String(note.note_id);

    // дубль-проверка через supabase (чтобы не обрабатывать повторно)
    const already = await isAlreadyProcessed(source_type, source_id);
    if (already) {
      skipped++;
      continue;
    }

    // слишком старый? (>3ч по умолчанию)
    const ageMs = now - (note.created_at * 1000);
    if (ageMs > IGNORE_MS) {
      // запишем как seen_only, чтобы не возвращаться к нему больше
      try {
        await markSeenOnly(source_type, source_id, null);
      } catch (e) {
        console.warn("markSeenOnly fail:", e?.message || e);
      }
      ignored++;
      continue;
    }

    // лимит антиспама/бутстрапа: если мы уже обработали достаточно новых за этот тик — стоп
    if (started >= maxNewToProcessThisTick) {
      break;
    }

    // достаем ссылки на запись
    const links = findRecordingLinksInNote(note);
    if (!links.length) {
      skipped++;
      continue;
    }
    withLinks++;

    // ответственный менеджер
    const respInfo = await amoGetResponsible(note.entity, note.entity_id);
    const managerTxt = respInfo.userName ? respInfo.userName : "неизвестно";

    // ✅ РАННЕЕ УВЕДОМЛЕНИЕ В ТГ, чтобы ты видел активность
    try {
      await sendTG(
        [
          "🔎 Новый свежий звонок из AmoCRM",
          `• note_id: <code>${note.note_id}</code>`,
          `• тип: <code>${note.note_type}</code>`,
          `• сущность: <code>${note.entity} #${note.entity_id}</code>`,
          `• менеджер: <code>${managerTxt}</code>`,
          `• создано: <code>${note.created_at}</code> (unix)`
        ].join("\n")
      );
    } catch (e) {
      console.warn("early TG notify failed:", e?.message || e);
    }

    // прогоняем каждую ссылку
    for (const origUrl of links) {
      // через tgRelayAudio, чтобы Railway мог скачать приватный mp3
      let relayCdnUrl;
      try {
        relayCdnUrl = await tgRelayAudio(
          origUrl,
          `🎧 Аудио (${note.note_type}) • ${managerTxt}\n` +
          `${note.entity} #${note.entity_id} · note #${note.note_id}`
        );
      } catch {
        relayCdnUrl = origUrl;
      }

      // транскрибируем
      const text = await enqueueAsr(() =>
        transcribeAudioFromUrl(relayCdnUrl, { callId: `amo-${note.note_id}` })
      );

      if (text) {
        // прислать транскрипт кусочками в чат (удобно для дебага и реального контроля качества)
        await sendTG(
          `📝 <b>Транскрипт</b> (amo note <code>${note.note_id}</code>, ${managerTxt}):`
        );
        for (const part of chunkText(text, 3500)) {
          await sendTG(`<code>${part}</code>`);
        }

        // оценка качества звонка
        try {
          const qa = await analyzeTranscript(text, {
            callId: `amo-${note.note_id}`,
            brand: process.env.CALL_QA_BRAND || "",
            manager: managerTxt,
            amo_entity: note.entity,
            amo_entity_id: note.entity_id
          });
          await sendTG(formatQaForTelegram(qa));
        } catch (e) {
          await sendTG("⚠️ Ошибка анализа (РОП): <code>" + (e?.message || e) + "</code>");
        }

        started++;

        // фиксируем в базе как "нормально обработан"
        try {
          await markProcessed(source_type, source_id, origUrl);
        } catch (e) {
          console.warn("markProcessed fail:", e?.message || e);
        }

        // вычитаем из bootstrap лимита (если он есть)
        if (bootstrapRef && typeof bootstrapRef.val === "number") {
          bootstrapRef.val = Math.max(0, bootstrapRef.val - 1);
        }

      } else {
        // не смогли транскрибировать
        await sendTG("⚠️ ASR не удалось выполнить для ссылки из amo.");
      }
    }
  }

  return { scanned: picked.length, withLinks, started, skipped, ignored };
}
