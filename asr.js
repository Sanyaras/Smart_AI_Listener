// asr.js
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { debug, safeStr, fetchWithTimeout } from "./utils.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) throw new Error("❌ OPENAI_API_KEY is missing");

const TEMP_DIR = "/tmp/asr_audio";

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

export async function transcribeAudio(url) {
  try {
    debug("🎧 Downloading audio:", url);
    const filename = path.join(TEMP_DIR, `call_${Date.now()}.mp3`);
    const file = fs.createWriteStream(filename);

    const res = await fetchWithTimeout(url, {}, 30000);
    if (!res.ok) throw new Error(`Download failed ${res.status}`);
    await new Promise((resolve, reject) => {
      res.body.pipe(file);
      res.body.on("error", reject);
      file.on("finish", resolve);
    });

    debug("📡 Uploading to Whisper...");

    const form = new FormData();
    form.append("file", fs.createReadStream(filename));
    form.append("model", "whisper-1");
    form.append("language", "ru");

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: form,
    });

    const json = await r.json();
    if (!json.text) throw new Error("No transcription returned");
    debug("✅ Transcription complete, length:", json.text.length);

    try { fs.unlinkSync(filename); } catch {}

    return json.text.trim();
  } catch (e) {
    console.error("❌ transcribeAudio error:", safeStr(e));
    return null;
  }
}
