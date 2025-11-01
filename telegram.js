// telegram.js
import { Telegraf } from "telegraf";
import { supabase } from "./supabaseStore.js";
import fetch from "node-fetch";
import { debug } from "./utils.js";

let bot = null;
let CHAT_ID = null;

// ============ ИНИЦИАЛИЗАЦИЯ TELEGRAM ============
export function initTelegramEnv(env) {
  const token = env.TG_BOT_TOKEN;
  CHAT_ID = env.TG_CHAT_ID;

  if (!token) {
    console.warn("⚠️ TG_BOT_TOKEN не найден, Telegram бот не запущен");
    return;
  }

  bot = new Telegraf(token);
  debug("🤖 Telegram bot listener initialized...");

  bot.on(["voice", "audio"], async (ctx) => {
    try {
      const file = ctx.message.voice || ctx.message.audio;
      const fileId = file.file_id;
      const fileInfo = await ctx.telegram.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;

      debug(`🎧 Получен файл из Telegram: ${fileUrl}`);

      const note_id = `tg_${fileId}`;
      const created_at = new Date().toISOString();

      // сохраняем в call_records
      await supabase.from("call_records").upsert({
        note_id,
        contact_id: ctx.from.id,
        link: fileUrl,
        created_at,
        status: "new",
      });

      await ctx.reply("✅ Аудио получено и отправлено на анализ!");
    } catch (err) {
      console.error("❌ Ошибка обработки Telegram файла:", err);
      ctx.reply("⚠️ Ошибка загрузки аудио");
    }
  });

  bot.launch();
  debug("🚀 Telegram bot запущен и слушает новые аудио/войсы...");
}

// ============ ОТПРАВКА СООБЩЕНИЙ ============
export async function sendTGMessage(text) {
  try {
    if (!bot || !CHAT_ID) {
      console.warn("⚠️ Telegram bot не инициализирован");
      return;
    }
    await bot.telegram.sendMessage(CHAT_ID, text, { parse_mode: "HTML" });
    debug("📨 Сообщение отправлено в Telegram");
  } catch (err) {
    console.error("❌ Ошибка отправки Telegram сообщения:", err);
  }
}
