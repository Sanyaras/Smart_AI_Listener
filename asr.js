// asr.js
import { fetchWithTimeout, cap } from "./utils.js";
import { sendTG } from "./telegram.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ASR_CONCURRENCY = parseInt(process.env.ASR_CONCURRENCY || "2", 10);

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

export async function transcribeAudioFromUrl(fileUrl, meta = {}) {
  if (!OPENAI_API_KEY) {
    await sendTG("⚠️ <b>OPENAI_API_KEY не задан</b> — пропускаю транскрибацию.");
    return null;
  }
  try {
    // HEAD чтобы не качать 200MB
    try {
      const head = await fetchWithTimeout(fileUrl, { method: "HEAD", redirect: "follow" }, 8000);
      const cl = head.headers.get("content-length");
      const MAX = 60 * 1024 * 1024;
      if (cl && parseInt(cl, 10) > MAX) {
        await sendTG(`⚠️ Запись слишком большая (${(parseInt(cl,10)/1024/1024).toFixed(1)}MB) — пропуск.`);
        return null;
      }
    } catch (e) {
      // ignore head fail
    }

    const r = await fetchWithTimeout(fileUrl, { redirect: "follow" }, 30000);
    if (!r.ok) {
      await sendTG(`❗️ Ошибка скачивания записи: HTTP <code>${r.status}</code>`);
      return null;
    }

    const MAX = 60 * 1024 * 1024;
    const contentLength = r.headers.get("content-length");
    if (contentLength && parseInt(contentLength,10) > MAX) {
      await sendTG(`⚠️ Запись ${(parseInt(contentLength,10)/1024/1024).toFixed(1)}MB слишком большая — пропуск.`);
      return null;
    }

    const buf = await r.arrayBuffer();
    if (buf.byteLength > MAX) {
      await sendTG(`⚠️ Запись ${(buf.byteLength/1024/1024).toFixed(1)}MB слишком большая — пропуск.`);
      return null;
    }

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

    const text = await resp.text();
    return text.trim();
  } catch (e) {
    await sendTG(`❗️ Общая ошибка транскрибации: <code>${e?.message || e}</code>`);
    return null;
  }
}
