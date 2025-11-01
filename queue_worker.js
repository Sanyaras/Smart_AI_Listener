// queue_worker.js — воркер для recordings_queue
// шаги: взять pending -> скачать аудио -> asr -> qa -> tg -> done

import { takeQueueBatch, markQueueStatus, markQueueDone, markQueueError } from "./supabaseStore.js";
import { sendTG } from "./telegram.js";
import { fetchWithTimeout } from "./utils.js";
import { transcribeFromUrl } from "./asr.js";
import { runQAOnTranscript } from "./qa_assistant.js";

const NOTIFY_CHAT_ID = process.env.TG_ALERTS_CHAT_ID || null;

async function downloadToBuffer(url) {
  const res = await fetchWithTimeout(url, { method: "GET", timeout: 120000 });
  if (!res.ok) {
    const t = await res.text().catch(()=> "");
    throw new Error(`download failed ${res.status}: ${t}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function processQueueOnce(limit=5) {
  const batch = await takeQueueBatch(limit);
  if (!batch?.length) return { ok:true, taken:0, done:0 };

  const ids = batch.map(x => x.id);
  await markQueueStatus(ids, "downloading");

  let done = 0;

  for (const item of batch) {
    try {
      const { id, record_url, amo_note_key } = item;

      // 1) Скачать аудио
      const buf = await downloadToBuffer(record_url);

      // 2) Транскрибировать
      const asr = await transcribeFromUrl(buf, { sourceUrl: record_url, amoNoteKey: amo_note_key });

      // 3) Оценка/QA
      const qa = await runQAOnTranscript(asr);

      // 4) Уведомить (опционально)
      if (NOTIFY_CHAT_ID) {
        await sendTG(NOTIFY_CHAT_ID, [
          `▶️ Voice processed`,
          `note: ${amo_note_key}`,
          `dur: ${asr?.duration ?? "?"}s`,
          `score: ${qa?.score ?? "N/A"}`
        ].join("\n"));
      }

      // 5) Done
      await markQueueDone(id, { error: null });
      done++;

    } catch (e) {
      await markQueueError(item.id, e);
      if (NOTIFY_CHAT_ID) {
        await sendTG(NOTIFY_CHAT_ID, `❌ Queue error: ${String(e)}`);
      }
    }
  }

  return { ok:true, taken: batch.length, done };
}
