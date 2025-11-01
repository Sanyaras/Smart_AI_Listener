// telegram.js
import fetch from "node-fetch";
import { Telegraf } from "telegraf";
import { debug, safeStr } from "./utils.js";

let bot = null;
let TELEGRAM_CHAT_ID = null;
let TELEGRAM_BOT_TOKEN = null;

/**
 * Инициализация окружения Telegram
 */
export function initTelegramEnv(env = process.env) {
  TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || env.TG_BOT_TOKEN;
  TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("⚠️ TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID не заданы");
    return;
  }

  try {
    bot = new Telegraf(TELEGRAM_BOT_TOKEN);
    console.log("🤖 Telegram бот инициализирован (relay mode)");
  } catch (err) {
    console.error("❌ Ошибка инициализации Telegraf:", err);
  }
}

/**
 * Отправка текстового сообщения в Telegram
 */
export async function sendTGMessage(text) {
  if (!bot || !TELEGRAM_CHAT_ID) return;
  try {
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    debug("📩 Отправлено в Telegram");
  } catch (e) {
    console.error("❌ Ошибка при отправке Telegram-сообщения:", safeStr(e));
  }
}

/**
 * Передача аудио через Telegram — прокси-загрузка
 * Telegram скачивает mp3 с MegaPBX и возвращает CDN-ссылку
 */
export async function tgRelayAudio(url, caption = "Call recording") {
  if (!bot || !TELEGRAM_CHAT_ID) {
    console.error("⚠️ Telegram не инициализирован — relay невозможно");
    return null;
  }

  try {
    console.log(`🎧 Relay: скачиваем и заливаем в Telegram -> ${url}`);

    const sent = await bot.telegram.sendAudio(TELEGRAM_CHAT_ID, { url }, { caption });

    if (!sent?.audio?.file_id) {
      console.warn("⚠️ Telegram relay не вернул file_id");
      return null;
    }

    const fileInfo = await bot.telegram.getFile(sent.audio.file_id);
    if (!fileInfo?.file_path) {
      console.warn("⚠️ Telegram relay не вернул file_path");
      return null;
    }

    const cdnUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;
    console.log(`✅ Telegram CDN link готов: ${cdnUrl}`);
    return cdnUrl;
  } catch (e) {
    console.error("❌ tgRelayAudio error:", safeStr(e));
    return null;
  }
}

/**
 * Универсальная обёртка — используется в Amo обработке
 * (пытается relay через Telegram, если напрямую не доступен)
 */
export async function uploadToTelegramAndGetUrl(mp3Url) {
  try {
    console.log("🎧 Uploading audio to Telegram via relay...");
    const tgUrl = await tgRelayAudio(mp3Url, "📞 Новый звонок");
    if (!tgUrl) {
      console.warn("⚠️ Не удалось получить relay-ссылку через Telegram");
      return null;
    }
    return tgUrl;
  } catch (err) {
    console.error("❌ uploadToTelegramAndGetUrl:", safeStr(err));
    return null;
  }
}

export { TELEGRAM_CHAT_ID };
