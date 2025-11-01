// telegram.js
import fetch from "node-fetch";
import { Telegraf } from "telegraf";
import FormData from "form-data";
import { debug } from "./utils.js";

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// =============================
// Telegram Bot и утилиты
// =============================

let bot = null;

/**
 * Инициализация Telegram-бота
 */
export async function initTelegram() {
  if (!TG_BOT_TOKEN) {
    console.error("❌ TG_BOT_TOKEN отсутствует в переменных окружения!");
    return;
  }

  bot = new Telegraf(TG_BOT_TOKEN);

  // 🎧 Обработка голосовых и аудио сообщений
  bot.on(["voice", "audio"], async (ctx) => {
    try {
      const fileId = ctx.message.voice?.file_id || ctx.message.audio?.file_id;
      const sender = ctx.message.from.username || ctx.message.from.first_name;

      console.log(`🎧 Получен файл от ${sender}, file_id=${fileId}`);

      const fileInfoRes = await fetch(
        `https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${fileId}`
      );
      const fileInfo = await fileInfoRes.json();
      const filePath = fileInfo.result.file_path;

      const telegramFileUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${filePath}`;
      console.log("✅ Telegram CDN link:", telegramFileUrl);

      await ctx.reply(`✅ Файл получен!\nCDN: ${telegramFileUrl}`);
    } catch (err) {
      console.error("❌ Ошибка при обработке аудио:", err.message);
      await ctx.reply("⚠️ Ошибка при обработке аудио файла.");
    }
  });

  // Простейшие команды
  bot.command("start", (ctx) =>
    ctx.reply("🤖 Бот запущен и готов принимать аудио/войсы!")
  );
  bot.command("ping", (ctx) => ctx.reply("🏓 Pong!"));

  await bot.launch();
  console.log("🤖 Telegram bot listener initialized...");
  console.log("🚀 Telegram bot запущен и слушает новые аудио/войсы...");
}

/**
 * Отправка простого текстового сообщения в Telegram
 */
export async function sendTGMessage(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.warn("⚠️ TG_BOT_TOKEN или TG_CHAT_ID не заданы");
    return;
  }

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TG_CHAT_ID,
          text,
          parse_mode: "HTML",
        }),
      }
    );

    const data = await res.json();
    if (!data.ok) throw new Error(data.description);
    debug("💬 Сообщение отправлено в Telegram");
  } catch (e) {
    console.error("❌ sendTGMessage error:", e.message);
  }
}

// =============================
// Telegram Proxy для аудио
// =============================

/**
 * Загружает mp3 в Telegram и возвращает CDN ссылку
 * (используется как прокси для обхода VPN-блокировок MegaPBX)
 */
export async function uploadToTelegramAndGetUrl(fileUrl) {
  try {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
      console.warn("⚠️ Telegram env vars not set");
      return null;
    }

    console.log("🎧 Uploading audio to Telegram via bot...");

    // 1️⃣ Пытаемся скачать mp3 (Railway может не иметь доступа к MegaPBX)
    const res = await fetch(fileUrl, { timeout: 15000 });
    if (!res.ok) throw new Error(`Cannot fetch source audio: ${res.status}`);
    const buffer = await res.arrayBuffer();

    // 2️⃣ Заливаем в Telegram
    const form = new FormData();
    form.append("chat_id", TG_CHAT_ID);
    form.append("audio", Buffer.from(buffer), "call.mp3");

    const sendRes = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendAudio`, {
      method: "POST",
      body: form,
    });

    const data = await sendRes.json();
    if (!data.ok) throw new Error("Telegram upload failed: " + JSON.stringify(data));

    const fileId = data.result.audio.file_id;

    // 3️⃣ Получаем CDN-ссылку
    const fileInfoRes = await fetch(
      `https://api.telegram.org/bot${TG_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const fileInfo = await fileInfoRes.json();
    const filePath = fileInfo.result.file_path;

    const telegramFileUrl = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}/${filePath}`;
    console.log("✅ Telegram CDN link:", telegramFileUrl);

    return telegramFileUrl;
  } catch (e) {
    console.error("❌ uploadToTelegramAndGetUrl:", e.message);
    return null;
  }
}

// =============================
// Автоматический запуск (только при DEBUG)
// =============================
if (process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID && process.env.TG_DEBUG === "true") {
  initTelegram().catch((e) => console.error("⚠️ Telegram init error:", e.message));
}
