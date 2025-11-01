// asr.js
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { debug, safeStr } from "./utils.js";

const TMP_DIR = "/tmp/audio_cache";
await fs.mkdir(TMP_DIR, { recursive: true });

// Helper to download mp3 with retry
async function downloadAudioFile(url, timeout = 120000) {
  const filename = path.join(TMP_DIR, `${Date.now()}.mp3`);
  debug(`🕓 Скачиваю аудио: ${url}`);
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Bad response ${res.status}`);
    const buffer = await res.arrayBuffer();
    await fs.writeFile(filename, Buffer.from(buffer));
    clearTimeout(id);
    debug(`✅ Аудио скачано: ${filename}`);
    return filename;
  } catch (e) {
    clearTimeout(id);
    console.error("❌ Ошибка скачивания mp3:", safeStr(e));
    return null;
  }
}

// Whisper/OpenAI transcription
export async function transcribeAudio(audioUrl) {
  try {
    const localPath = await downloadAudioFile(audioUrl);
    if (!localPath) return null;

    const openaiUrl = "https://api.openai.com/v1/audio/transcriptions";
    const formData = new FormData();
    formData.append("model", "whisper-1");
    formData.append("file", new Blob([await fs.readFile(localPath)]), "call.mp3");
    formData.append("response_format", "text");

    debug("🎙️ Отправляю в Whisper...");
    const res = await fetch(openaiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData,
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("❌ Ошибка OpenAI:", text);
      return null;
    }

    const transcript = await res.text();
    debug(`🧾 Распознано ${transcript.length} символов`);
    return transcript.trim();
  } catch (e) {
    console.error("❌ transcribeAudio error:", safeStr(e));
    return null;
  }
}
