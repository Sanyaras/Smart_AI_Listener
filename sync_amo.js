// sync_amo.js — Amo → Supabase ingest (raw), idempotent, no cursors
// ES-modules style

import { fetchWithTimeout, toISO } from "./utils.js";
import { saveAmoNotesRaw, enqueueRecordings } from "./supabaseStore.js";
import { findRecordingLinksInNote, isLikelyCallNote } from "./amo.js"; // уже есть в проекте
import { sendTG } from "./telegram.js";

const AMO_BASE_URL = process.env.AMO_BASE_URL;
const AMO_ACCESS_TOKEN = process.env.AMO_ACCESS_TOKEN;

// Amo REST: универсальный геттер
async function amoGet(path, search = "") {
  const url = `${AMO_BASE_URL}${path}${search}`;
  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${AMO_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    timeout: 30000
  });
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`AMO GET ${path} failed ${res.status}: ${t}`);
  }
  return res.json();
}

// Получаем заметки (notes) по сущности
async function fetchNotesForEntity(entity, page = 1, limit = 50) {
  // в Amo v4 заметки по сущности — /api/v4/<entity>/notes
  // сортировки по created_at нет официальной — заберём несколько страниц и отсортируем сами
  const path = `/api/v4/${entity}/notes`;
  const search = `?page=${page}&limit=${limit}`;
  const data = await amoGet(path, search);
  return Array.isArray(data?._embedded?.notes) ? data._embedded.notes : [];
}

// Собираем по 4 сущностям и нормализуем
export async function pullAmoNotesWindow({ pages = 5, perPage = 50 } = {}) {
  const entities = ["leads", "contacts", "companies", "customers"];
  const res = [];

  for (const e of entities) {
    for (let p = 1; p <= pages; p++) {
      const arr = await fetchNotesForEntity(e, p, perPage);
      if (!arr.length) break;

      for (const n of arr) {
        // нормализуем к нашему формату + найдём ссылки
        const created_ts = Number.parseInt(n?.created_at ?? 0, 10) || 0;
        const links = findRecordingLinksInNote(n);
        const has_link = links.length > 0;

        res.push({
          amo_note_key: `${e.slice(0,-1)}:${n.id}`,       // leads -> lead
          amo_note_id: n.id,
          entity: e.slice(0,-1),                          // lead/contact/company/customer
          entity_id: n?.entity_id ?? 0,
          note_type: n?.note_type ?? null,
          created_at_ts: created_ts,
          created_at: created_ts ? toISO(created_ts * 1000) : null,
          note_text: n?.text ?? null,
          params: n?.params ?? null,
          has_link,
          links
        });
      }

      // маленькая пауза, чтобы не долбить API
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // глобальная сортировка по времени (свежие сверху)
  res.sort((a,b) => (b.created_at_ts || 0) - (a.created_at_ts || 0));
  return res;
}

// Главная функция: инжест + постановка в очередь на транскрипт
export async function syncAmoToSupabase({ pages = 5, perPage = 50, lookbackDays = 90, notifyChatId = null } = {}) {
  const all = await pullAmoNotesWindow({ pages, perPage });

  // отфильтруем по окну (без курсора, просто по дате)
  const minTs = Math.floor((Date.now() - lookbackDays * 86400 * 1000) / 1000);
  const windowed = all.filter(r => (r.created_at_ts || 0) >= minTs);

  // idempotent upsert в raw-таблицу
  const { inserted, updated, skipped } = await saveAmoNotesRaw(windowed);

  // найдём новые записи со ссылками, которых ещё нет в очереди
  const candidates = windowed.filter(r => r.has_link && isLikelyCallNote({ note_type: r.note_type, text: r.note_text, params: r.params }));

  const enq = await enqueueRecordings(candidates);

  // (опционально) уведомление в телеграм об объёмах
  if (notifyChatId) {
    await sendTG(notifyChatId, [
      `Amo sync finished`,
      `window: ${lookbackDays}d, pages: ${pages}x${perPage}`,
      `raw upsert → inserted: ${inserted}, updated: ${updated}, skipped: ${skipped}`,
      `queue → enqueued: ${enq.enqueued}, duplicates: ${enq.duplicates}`
    ].join("\n"));
  }

  return {
    ok: true,
    windowDays: lookbackDays,
    pages, perPage,
    raw: { inserted, updated, skipped },
    queue: enq
  };
}
