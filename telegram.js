// telegram.js
import { Telegraf } from "telegraf";
import fetch from "node-fetch";
import fs from "fs";
import FormData from "form-data";
import { transcribeAudio } from "./asr.js";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";
import { getUnprocessedCalls, markCallProcessed } from "./supabaseStore.js";
import { safeStr } from "./utils.js";

let bot = null;
let TELEGRAM_BOT_TOKEN = null;
let TELEGRAM_CHAT_ID = null;
let TG_UPLOAD_CHAT_ID = null;

/**
 * Инициализация Telegram бота
 */
export async function initTelegram(env = process.env) {
  TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || env.TG_BOT_TOKEN;
  TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID || env.TG_CHAT_ID;
  TG_UPLOAD_CHAT_ID = env.TG_UPLOAD_CHAT_ID || TELEGRAM_CHAT_ID;

  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN не задан — Telegram отключён");
    return;
  }

  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  // --- /start
  bot.start((ctx) =>
    ctx.reply("✅ Бот активен! Можешь кидать голосовые или использовать команду /scan")
  );

  // --- /scan (ручной запуск анализа звонков)
  bot.command("scan", async (ctx) => {
    await ctx.reply("🔍 Проверяю звонки...");
    await processCallsAndReport(ctx);
  });

  // --- обработка голосовых из чата
  bot.on("voice", async (ctx) => {
    const fileId = ctx.message.voice.file_id;
    console.log(`🎤 Получен голосовой: ${fileId}`);
    await ctx.reply("🎧 Распознаю голос...");

    try {
      const fileRes = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
      );
      const fileInfo = await fileRes.json();
      const filePath = fileInfo.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

      const transcript = await transcribeAudio(fileUrl);
      if (!transcript) {
        await ctx.reply("⚠️ Не удалось расшифровать голосовое сообщение.");
        return;
      }

      await ctx.reply(`🗣️ Расшифровка:\n\n${transcript.slice(0, 4000)}`);

      const qa = await analyzeTranscript(transcript, { callId: "tg-voice" });
      const qaText = formatQaForTelegram(qa);
      await ctx.reply(`📊 Анализ:\n${qaText}`);
    } catch (err) {
      console.error("❌ Ошибка при обработке голосового:", err);
      await ctx.reply("❌ Ошибка при обработке голосового.");
    }
  });

  // --- текстовые команды / помощь
  bot.on("text", async (ctx) => {
    const msg = ctx.message.text.trim().toLowerCase();
    if (msg === "ping") {
      await ctx.reply("🏓 Pong! Бот работает");
    } else if (msg === "help" || msg === "команды") {
      await ctx.reply("📨 Команды:\n/start — проверить связь\n/scan — обработать звонки\nping — проверить работу");
    } else {
      await ctx.reply("🤖 Отправь голосовое сообщение или напиши /scan");
    }
  });

  // --- запуск в режиме polling (бот слушает чат)
  await bot.launch();
  console.log("🤖 Telegram запущен в режиме polling (читает чат)");

  // --- автообработка звонков
  const AUTO_SCAN_MINUTES = parseInt(env.AUTO_SCAN_MINUTES || "5", 10);
  if (AUTO_SCAN_MINUTES > 0) {
    console.log(`🔁 Автообработка звонков каждые ${AUTO_SCAN_MINUTES} мин`);
    setInterval(async () => {
      console.log(`🕒 Авто-скан звонков...`);
      await processCallsAndReport();
    }, AUTO_SCAN_MINUTES * 60 * 1000);
  }
}

/**
 * Отправка сообщения в Telegram
 */
export async function sendTGMessage(text, chatOverride = null) {
  try {
    const chatId = chatOverride || TELEGRAM_CHAT_ID;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.error("❌ sendTGMessage:", safeStr(e));
  }
}

/**
 * Relay — загружает mp3 в Telegram и получает прямую ссылку
 */
export async function uploadToTelegramAndGetUrl(fileUrl) {
  try {
    console.log("🎧 Uploading audio to Telegram via relay...");

    const res = await fetch(fileUrl);
    if (!res.ok) throw new Error(`Ошибка загрузки ${fileUrl}: ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    const tmpFile = `/tmp/audio_${Date.now()}.mp3`;
    fs.writeFileSync(tmpFile, buffer);

    const formData = new FormData();
    formData.append("chat_id", TG_UPLOAD_CHAT_ID);
    formData.append("document", fs.createReadStream(tmpFile));

    const uploadRes = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
      { method: "POST", body: formData }
    );
    const uploadJson = await uploadRes.json();

    if (!uploadJson.ok) throw new Error(uploadJson.description);

    const fileId = uploadJson.result.document.file_id;
    const fileInfoRes = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    );
    const fileInfo = await fileInfoRes.json();

    const filePath = fileInfo.result.file_path;
    const finalUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
    console.log("✅ Relay готов:", finalUrl);

    return finalUrl;
  } catch (e) {
    console.error("❌ uploadToTelegramAndGetUrl:", safeStr(e));
    return null;
  }
}

/**
 * Обработка звонков из Supabase
 */
export async function processCallsAndReport(ctx = null) {
  try {
    const unprocessed = await getUnprocessedCalls(5);
    if (!unprocessed.length) {
      if (ctx) await ctx.reply("📭 Нет новых звонков");
      else console.log("📭 Нет новых звонков");
      return;
    }

    for (const call of unprocessed) {
      const { note_id, link } = call;
      console.log(`📞 Обрабатываю звонок #${note_id}`);

      let relayUrl = link;
      if (link && link.includes("megapbx.ru")) {
        relayUrl = await uploadToTelegramAndGetUrl(link);
      }

      if (!relayUrl) continue;

      const transcript = await transcribeAudio(relayUrl);
      if (!transcript) continue;

      const qa = await analyzeTranscript(transcript, { callId: note_id });
      const qaText = formatQaForTelegram(qa);

      const msg = `📞 <b>Звонок #${note_id}</b>\n${qaText}`;
      await sendTGMessage(msg);
      await markCallProcessed(note_id, transcript, qa);

      console.log(`✅ Звонок #${note_id} обработан`);
    }

    if (ctx) await ctx.reply("✅ Все звонки обработаны!");
  } catch (e) {
    console.error("❌ processCallsAndReport:", safeStr(e));
    if (ctx) await ctx.reply("❌ Ошибка при обработке звонков");
  }
}
