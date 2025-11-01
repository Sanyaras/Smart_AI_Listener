// queue_worker.js — recordings_queue: pending -> ASR (from URL) -> QA -> TG -> done
// v1.0 for Smart AI Listener (Railway)

import {
  takeQueueBatch,
  markQueueStatus,
  markQueueDone,
  markQueueError,
} from "./supabaseStore.js";
import { sendTG } from "./telegram.js";
import { transcribeAudioFromUrl, getAsrState, enqueueAsr } from "./asr.js";
import { runQAOnTranscript } from "./qa_assistant.js";

// Нотификации (опционально)
const NOTIFY_CHAT_ID = process.env.TG_ALERTS_CHAT_ID || null;

// Сколько задач брать за тик, если не задано в query
const DEFAULT_TICK_LIMIT = parseInt(process.env.QUEUE_TICK_LIMIT || "5", 10);

/**
 * Один тик обработки очереди:
 *  1) берем pending из recordings_queue (FIFO по created_at)
 *  2) помечаем "downloading" (старт обработки)
 *  3) для каждой записи: ASR → QA → TG → done
 *  4) ошибки — статус error + текст
 *
 * Возвращает агрегаты, включая состояние встроенной очереди ASR.
 */
export async function processQueueOnce(limit = DEFAULT_TICK_LIMIT) {
  const batch = await takeQueueBatch(limit);
  if (!Array.isArray(batch) || !batch.length) {
    return { ok: true, taken: 0, done: 0, ...getAsrState() };
  }

  const ids = batch.map((x) => x.id);
  await markQueueStatus(ids, "downloading", {
    started_at: new Date().toISOString(),
  });

  let done = 0;

  // Гоним задачи через внутреннюю очередь asr.js (уважает ASR_CONCURRENCY)
  const tasks = batch.map((item) =>
    enqueueAsr(async () => {
      const { id, record_url, amo_note_key } = item;

      try {
        // 1) Транскрипт напрямую по URL
        const text = await transcribeAudioFromUrl(record_url, {
          callId: amo_note_key,
          fileName: "call.mp3",
        });
        if (!text || !text.trim()) throw new Error("ASR returned empty text");

        // 2) Оценка/QA по тексту
        const qa = await runQAOnTranscript({
          text,
          sourceUrl: record_url,
          amoNoteKey: amo_note_key,
        });

        // 3) Нотификация (по желанию)
        if (NOTIFY_CHAT_ID) {
          await sendTG(
            NOTIFY_CHAT_ID,
            [
              "▶️ Voice processed",
              `note: ${amo_note_key}`,
              `score: ${qa?.score ?? "N/A"}`,
            ].join("\n")
          );
        }

        // 4) Done
        await markQueueDone(id, { error: null });
        done++;
      } catch (e) {
        await markQueueError(id, e);
        if (NOTIFY_CHAT_ID) {
          await sendTG(`❌ Queue error: <code>${String(e)}</code>`);
        }
      }
    })
  );

  // Дождаться выполнения всех задач тика
  await Promise.allSettled(tasks);

  return { ok: true, taken: batch.length, done, ...getAsrState() };
}

/**
 * (опционально) Бесконечный цикл воркера.
 * Не используем по умолчанию в Railway, но оставляем для VPS/PM2.
 */
export async function processQueueLoop({
  pollIntervalMs = 5000,
  maxIdleRounds = 60,
} = {}) {
  let idle = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await processQueueOnce();
    if (r.taken === 0) {
      idle++;
      if (idle >= maxIdleRounds) {
        return { ok: true, reason: "idle_timeout", ...r };
      }
      await new Promise((res) => setTimeout(res, pollIntervalMs));
    } else {
      idle = 0;
    }
  }
}
