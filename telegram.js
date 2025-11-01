// telegram.js
import fetch from "node-fetch";
import { Telegraf } from "telegraf";
import fs from "fs";
import { debug } from "./utils.js";

let TELEGRAM_BOT_TOKEN = null;
let TELEGRAM_CHAT_ID = null;
let TG_UPLOAD_CHAT_ID = null;
let bot = null;

/**
 * Инициализация Telegram-бота (с polling)
 */
export async function initTelegram(env = process.env) {
  TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || env.TG_BOT_TOKEN;
  TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID || env.TG_CHAT_ID;
  TG_UPLOAD_CHAT_ID = env.TG_UPLOAD_CHAT_ID || TELEGRAM_CHAT_ID;

  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN не задан — бот не запущен");
    return;
  }

  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.start((ctx) => ctx.reply("✅ Бот активен и готов к работе!"));
  bot.on("message", (ctx) => {
    console.log("📩 Получено сообщение:", ctx.message.text || "Без текста");
    ctx.reply("📨 Сообщение получено ✅");
  });

  await bot.launch();
  console.log("🤖 Telegram бот запущен и слушает апдейты (polling mode)");
  console.log(`📩 Основной чат: ${TELEGRAM_CHAT_ID}`);
  console.log(`📦 Relay чат: ${TG_UPLOAD_CHAT_ID}`);
}

/**
 * Отправка простого текстового сообщения
 */
export async function sendTGMessage(text, chatOverride = null) {
  try {
    if (!bot || !TELEGRAM_BOT_TOKEN) {
      console.warn("⚠️ Telegram не инициализирован — сообщение не отправлено");
      return;
    }

    const chatId = chatOverride || TELEGRAM_CHAT_ID;
    await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
    debug("📤 Отправлено сообщение в Telegram");
  } catch (e) {
    console.error("❌ sendTGMessage:", e.message);
  }
}

/**
 * Relay-загрузка аудио через Telegram
 * — бот скачивает mp3 с внешнего источника
 * — заливает его в TG_UPLOAD_CHAT_ID
 * — возвращает публичную ссылку для OpenAI
 */
export async function uploadToTelegramAndGetUrl(mp3Url) {
  try {
    console.log("🎧 Uploading audio to Telegram via relay...");
    if (!TELEGRAM_BOT_TOKEN || !TG_UPLOAD_CHAT_ID) {
      console.warn("⚠️ Telegram не инициализирован — relay невозможно");
      return null;
    }

    const res = await fetch(mp3Url);
    if (!res.ok) throw new Error(`Ошибка загрузки ${mp3Url}: ${res.status}`);
    const buffer = await res.arrayBuffer();

    const tmpFile = `/tmp/audio_${Date.now()}.mp3`;
    fs.writeFileSync(tmpFile, Buffer.from(buffer));

    const formData = new FormData();
    formData.append("chat_id", TG_UPLOAD_CHAT_ID);
    formData.append("document", new Blob([fs.readFileSync(tmpFile)]), "audio.mp3");

    const uploadUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`;
    const uploadRes = await fetch(uploadUrl, { method: "POST", body: formData });
    const uploadJson = await uploadRes.json();

    if (!uploadJson.ok) {
      console.error("❌ Ошибка Telegram upload:", uploadJson);
      return null;
    }

    const fileId = uploadJson.result.document.file_id;
    const fileInfoRes = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const fileInfo = await fileInfoRes.json();

    if (!fileInfo.ok) {
      console.error("❌ Ошибка получения file_path:", fileInfo);
      return null;
    }

    const filePath = fileInfo.result.file_path;
    const finalUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

    console.log("✅ Relay готов:", finalUrl);
    return finalUrl;
  } catch (e) {
    console.error("❌ uploadToTelegramAndGetUrl:", e.message);
    return null;
  }
}
