// telegram.js
import fetch from "node-fetch";
import fs from "fs";
import FormData from "form-data";
import { debug, safeStr } from "./utils.js";
import { getUnprocessedCalls, markCallProcessed } from "./supabaseStore.js";
import { transcribeAudio } from "./asr.js";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

let TELEGRAM_BOT_TOKEN = null;
let TELEGRAM_CHAT_ID = null;
let TG_UPLOAD_CHAT_ID = null;

/**
 * Инициализация Telegram relay (без Telegraf)
 */
export async function initTelegram(env = process.env) {
  TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || env.TG_BOT_TOKEN;
  TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID || env.TG_CHAT_ID;
  TG_UPLOAD_CHAT_ID = env.TG_UPLOAD_CHAT_ID || TELEGRAM_CHAT_ID;

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы");
    return;
  }

  console.log("🤖 Telegram relay инициализирован (direct API mode)");

  // === Автоматическая обработка звонков ===
  const AUTO_SCAN_MINUTES = parseInt(env.AUTO_SCAN_MINUTES || "5", 10);
  if (AUTO_SCAN_MINUTES > 0) {
    console.log(`🔁 Автоматическая обработка звонков каждые ${AUTO_SCAN_MINUTES} минут`);
    setInterval(async () => {
      console.log(`🕒 Запуск автоматического сканирования звонков...`);
      await processCallsAndReport();
    }, AUTO_SCAN_MINUTES * 60 * 1000);
  }
}

/**
 * Отправка текста в Telegram
 */
export async function sendTGMessage(text, chatOverride = null) {
  try {
    const chatId = chatOverride || TELEGRAM_CHAT_ID;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });

    const json = await res.json();
    if (!json.ok) console.error("❌ Ошибка отправки Telegram:", json);
  } catch (e) {
    console.error("❌ sendTGMessage:", e.message);
  }
}

/**
 * Relay: загружает mp3 через Telegram и возвращает прямую ссылку
 */
export async function uploadToTelegramAndGetUrl(fileUrl) {
  try {
    console.log("🎧 Uploading audio to Telegram via bot...");

    const tgToken = TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN;
    const tgChat = TG_UPLOAD_CHAT_ID || process.env.TG_UPLOAD_CHAT_ID || TELEGRAM_CHAT_ID;
    if (!tgToken || !tgChat) {
      console.warn("⚠️ TELEGRAM env vars missing");
      return null;
    }

    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Ошибка скачивания mp3 (${response.status})`);
    const buffer = Buffer.from(await response.arrayBuffer());

    const tmpFile = `/tmp/audio_${Date.now()}.mp3`;
    fs.writeFileSync(tmpFile, buffer);

    const formData = new FormData();
    formData.append("chat_id", tgChat);
    formData.append("document", fs.createReadStream(tmpFile));

    const uploadRes = await fetch(`https://api.telegram.org/bot${tgToken}/sendDocument`, {
      method: "POST",
      body: formData,
    });

    const uploadJson = await uploadRes.json();
    if (!uploadJson.ok) {
      console.error("❌ Telegram upload failed:", uploadJson);
      return null;
    }

    const fileId = uploadJson.result.document.file_id;
    const getFileRes = await fetch(
      `https://api.telegram.org/bot${tgToken}/getFile?file_id=${fileId}`
    );
    const fileInfo = await getFileRes.json();

    if (!fileInfo.ok) {
      console.error("❌ Ошибка получения file_path:", fileInfo);
      return null;
    }

    const filePath = fileInfo.result.file_path;
    const finalUrl = `https://api.telegram.org/file/bot${tgToken}/${filePath}`;
    console.log("✅ Upload relay complete:", finalUrl);

    return finalUrl;
  } catch (e) {
    console.error("❌ uploadToTelegramAndGetUrl:", safeStr(e));
    return null;
  }
}

/**
 * Основной процесс обработки звонков (анализ + отчёт)
 */
export async function processCallsAndReport() {
  try {
    const unprocessed = await getUnprocessedCalls(5);
    if (!unprocessed.length) {
      console.log("📭 Нет новых звонков для обработки");
      return;
    }

    for (const call of unprocessed) {
      const { note_id, link } = call;
      console.log(`📞 Обрабатываю звонок #${note_id}`);

      let relayUrl = link;
      if (link && link.includes("megapbx.ru")) {
        relayUrl = await uploadToTelegramAndGetUrl(link);
      }

      if (!relayUrl) {
        console.warn("⚠️ Не удалось получить рабочую ссылку для:", link);
        continue;
      }

      const transcript = await transcribeAudio(relayUrl);
      if (!transcript) continue;

      const qa = await analyzeTranscript(transcript, { callId: note_id });
      const qaText = formatQaForTelegram(qa);

      const msg = `📞 <b>Звонок #${note_id}</b>\n${qaText}`;
      await sendTGMessage(msg);
      await markCallProcessed(note_id, transcript, qa);

      console.log(`✅ Звонок #${note_id} обработан`);
    }
  } catch (e) {
    console.error("❌ processCallsAndReport:", safeStr(e));
  }
}
