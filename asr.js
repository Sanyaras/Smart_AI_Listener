// asr.js
import fetch from "node-fetch";
import FormData from "form-data";
import { debug, safeStr } from "./utils.js";

// ========================
// Telegram Upload Helper
// ========================
async function uploadToTelegramAndGetUrl(mp3Url) {
  try {
    debug(`📡 Загружаем mp3 в Telegram через ${process.env.TG_UPLOAD_CHAT_ID}...`);

    // Скачиваем mp3 (если доступен)
    const audioRes = await fetch(mp3Url, { timeout: 20000 });
    if (!audioRes.ok) throw new Error(`Download failed: ${audioRes.statusText}`);
    const audioBuffer = await audioRes.arrayBuffer();

    // Отправляем в Telegram
    const formData = new FormData();
    formData.append("chat_id", process.env.TG_UPLOAD_CHAT_ID);
    formData.append("audio", Buffer.from(audioBuffer), "call.mp3");

    const sendRes = await fetch(
      `https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendAudio`,
      { method: "POST", body: formData }
    );

    const sendJson = await sendRes.json();
    if (!sendJson.ok) throw new Error(`Telegram sendAudio failed: ${safeStr(sendJson)}`);
    const file_id = sendJson.result?.audio?.file_id;

    // Получаем прямую ссылку на файл
    const getFile = await fetch(
      `https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/getFile?file_id=${file_id}`
    );
    const fileJson = await getFile.json();
    if (!fileJson.ok) throw new Error(`getFile failed: ${safeStr(fileJson)}`);

    const tgFileUrl = `https://api.telegram.org/file/bot${process.env.TG_BOT_TOKEN}/${fileJson.result.file_path}`;
    debug(`✅ mp3 успешно загружен в Telegram: ${tgFileUrl}`);

    return tgFileUrl;
  } catch (e) {
    console.error("❌ uploadToTelegramAndGetUrl:", e.message);
    return null;
  }
}

// ========================
// Whisper Transcription
// ========================
export async function transcribeAudio(originalUrl) {
  try {
    if (!originalUrl) {
      debug("⚠️ Нет ссылки на mp3, пропуск транскрипции");
      return null;
    }

    // 1️⃣ Пробуем загрузить через Telegram
    const tgUrl = await uploadToTelegramAndGetUrl(originalUrl);
    if (!tgUrl) {
      debug("⚠️ Не удалось переслать mp3 в Telegram, пропуск");
      return null;
    }

    // 2️⃣ Отправляем аудио в OpenAI Whisper
    debug("🧠 Отправляем файл в Whisper...");
    const audioRes = await fetch(tgUrl);
    if (!audioRes.ok) throw new Error(`Failed to fetch from Telegram: ${audioRes.status}`);

    const audioBuffer = await audioRes.arrayBuffer();
    const formData = new FormData();
    formData.append("file", Buffer.from(audioBuffer), "audio.mp3");
    formData.append("model", "whisper-1");

    const openaiRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: formData,
    });

    const json = await openaiRes.json();
    if (!json.text) throw new Error(`Whisper response invalid: ${safeStr(json)}`);

    debug("✅ Транскрипция готова");
    return json.text;
  } catch (e) {
    console.error("❌ transcribeAudio error:", safeStr(e));
    return null;
  }
}
