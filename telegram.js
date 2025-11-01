// telegram.js
import fetch from "node-fetch";
import { Telegraf } from "telegraf";
import { insertCallRecord } from "./supabaseStore.js";
import { debug, safeStr } from "./utils.js";

const botToken = process.env.TG_BOT_TOKEN;
const chatId = process.env.TG_CHAT_ID;

if (!botToken) throw new Error("❌ Missing TG_BOT_TOKEN in environment variables");

export const bot = new Telegraf(botToken);

debug("🤖 Telegram bot listener initialized...");

// ==========================
// Обработка аудио и войсов
// ==========================
bot.on(["audio", "voice"], async (ctx) => {
  try {
    const msg = ctx.message;
    const fileInfo = msg.audio || msg.voice;
    const file_id = fileInfo.file_id;
    const duration = fileInfo.duration || 0;
    const sender = msg.from?.username || msg.from?.first_name || "unknown";
    const created_at = new Date(msg.date * 1000).toISOString();

    // 1️⃣ Получаем file_path
    const getFileRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getFile?file_id=${file_id}`
    );
    const fileJson = await getFileRes.json();
    if (!fileJson.ok) throw new Error(`getFile failed: ${safeStr(fileJson)}`);

    // 2️⃣ Строим прямую ссылку
    const file_path = fileJson.result.file_path;
    const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file_path}`;
    debug(`🎧 Получен файл из Telegram: ${fileUrl}`);

    // 3️⃣ Сохраняем в Supabase как звонок
    const note_id = `tg_${msg.message_id}`;
    const contact_id = msg.from?.id || 0;

    const record = await insertCallRecord({
      note_id,
      contact_id,
      link: fileUrl,
      created_at,
    });

    if (record) {
      await ctx.reply(`✅ Аудио получено и сохранено (${sender}, ${duration}s)`);
      debug(`💾 call_record добавлен в Supabase: ${note_id}`);
    } else {
      await ctx.reply(`⚠️ Ошибка при сохранении записи в базу`);
    }
  } catch (e) {
    console.error("❌ Ошибка при обработке аудио:", safeStr(e));
    await ctx.reply("⚠️ Не удалось сохранить аудио 😢");
  }
});

// ==========================
// Обработка текстовых команд
// ==========================
bot.command("ping", async (ctx) => {
  await ctx.reply("🏓 Bot online!");
});

bot.command("last", async (ctx) => {
  await ctx.reply("📜 Последние 10 аудио-записей обрабатываются...");
});

// ==========================
// Запуск
// ==========================
export function startTelegramBot() {
  bot.launch();
  debug("🚀 Telegram bot запущен и слушает новые аудио/войсы...");
}
