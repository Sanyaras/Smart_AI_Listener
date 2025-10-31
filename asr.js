// asr.js — Smart ASR with optional role-tagging (returns STRING)
// Node 20+: uses global fetch/FormData/Blob
import { fetchWithTimeout, cap } from "./utils.js";
import { sendTG } from "./telegram.js";

const OPENAI_API_KEY   = process.env.OPENAI_API_KEY || "";
const ASR_CONCURRENCY  = parseInt(process.env.ASR_CONCURRENCY || "2", 10);
const ASR_ROLE_MODEL   = process.env.ASR_ROLE_MODEL || "gpt-4o-mini"; // модель для ролевой разметки
const MAX_DOWNLOAD_MB  = parseInt(process.env.ASR_MAX_MB || "60", 10); // предел размера записи в MB
const MAX_DOWNLOAD     = MAX_DOWNLOAD_MB * 1024 * 1024;

const asrQueue = [];
let asrActive = 0;

export function getAsrState() {
  return { asrActive, asrQueueLength: asrQueue.length };
}

export function enqueueAsr(taskFn) {
  return new Promise((resolve, reject) => {
    asrQueue.push({ taskFn, resolve, reject });
    processAsrQueue();
  });
}

async function processAsrQueue() {
  if (asrActive >= ASR_CONCURRENCY) return;
  const next = asrQueue.shift();
  if (!next) return;
  asrActive++;
  try {
    const out = await next.taskFn();
    next.resolve(out);
  } catch (e) {
    next.reject(e);
  } finally {
    asrActive--;
    processAsrQueue();
  }
}

/**
 * Транскрибация аудио по URL
 * Возвращает СТРОКУ.
 * Если ролевой теггер сработает — формат строк:
 *   ivr: ...
 *   customer: ...
 *   manager: ...
 * Иначе — сырой текст Whisper.
 */
export async function transcribeAudioFromUrl(fileUrl, meta = {}) {
  if (!OPENAI_API_KEY) {
    await sendTG("⚠️ <b>OPENAI_API_KEY не задан</b> — пропускаю транскрибацию.");
    return null;
  }

  try {
    // 1) HEAD: быстрый чек размера
    try {
      const head = await fetchWithTimeout(fileUrl, { method: "HEAD", redirect: "follow" }, 8000);
      const cl = head.headers.get("content-length");
      if (cl && parseInt(cl, 10) > MAX_DOWNLOAD) {
        await sendTG(`⚠️ Запись слишком большая (<code>${(parseInt(cl,10)/1024/1024).toFixed(1)}MB</code>) — пропуск.`);
        return null;
      }
    } catch (_) { /* ok, пропускаем HEAD-ошибку */ }

    // 2) Скачиваем аудио
    const r = await fetchWithTimeout(fileUrl, { redirect: "follow" }, 30000);
    if (!r.ok) {
      await sendTG(`❗️ Ошибка скачивания записи: HTTP <code>${r.status}</code>`);
      return null;
    }

    // двукратная проверка размера (по header и по факту)
    const contentLength = r.headers.get("content-length");
    if (contentLength && parseInt(contentLength,10) > MAX_DOWNLOAD) {
      await sendTG(`⚠️ Запись <code>${(parseInt(contentLength,10)/1024/1024).toFixed(1)}MB</code> слишком большая — пропуск.`);
      return null;
    }

    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX_DOWNLOAD) {
      await sendTG(`⚠️ Запись <code>${(buf.byteLength/1024/1024).toFixed(1)}MB</code> слишком большая — пропуск.`);
      return null;
    }

    // 3) Whisper (text)
    const form = new FormData();
    const filename = meta.fileName || (meta.callId ? `${meta.callId}.mp3` : "audio.mp3");
    form.append("file", new Blob([buf]), filename);
    form.append("model", "whisper-1");
    form.append("language", "ru");
    form.append("response_format", "text");

    const resp = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form
    }, 120000);

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      await sendTG(`❗️ Whisper ошибка: HTTP <code>${resp.status}</code>\n<code>${cap(errText,1000)}</code>`);
      return null;
    }

    const rawText = (await resp.text()).trim();
    if (!rawText) return null;

    // 4) Мягкая ролевка (опционально). Возвращаем СТРОКУ.
    let labeled = null;
    try {
      const rolePrompt =
`Разбей текст телефонного звонка по ролям: ivr (автоответчик), manager (менеджер), customer (клиент).
Верни ТОЛЬКО JSON-массив объектов: [{"speaker":"ivr|manager|customer","text":"..."}] без комментариев.
Текст:
${rawText}`;

      const analyzeResp = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: ASR_ROLE_MODEL,
          messages: [
            { role: "system", content: "Ты помощник по разметке ролей в телефонных диалогах. Никаких объяснений, только ответ по формату." },
            { role: "user", content: rolePrompt }
          ],
          temperature: 0
        })
      }, 60000);

      const j = await analyzeResp.json().catch(() => null);
      const arr = (() => {
        try {
          const raw = j?.choices?.[0]?.message?.content || "";
          const clean = raw.replace(/```json|```/g, "").trim();
          const parsed = JSON.parse(clean);
          return Array.isArray(parsed) ? parsed : null;
        } catch { return null; }
      })();

      if (arr && arr.length) {
        labeled = arr
          .map(x => `${(x.speaker || "unknown").toLowerCase()}: ${x.text || ""}`.trim())
          .join("\n");
      }
    } catch (_) { /* молча откатываемся на сырой текст */ }

    return labeled || rawText;

  } catch (e) {
    await sendTG(`❗️ Общая ошибка транскрибации: <code>${e?.message || e}</code>`);
    return null;
  }
}
