// telegram.js
import fetch from "node-fetch";
import { Telegraf } from "telegraf";
import fs from "fs";
import FormData from "form-data";
import { debug, safeStr } from "./utils.js";
import { getUnprocessedCalls, markCallProcessed } from "./supabaseStore.js";
import { transcribeAudio } from "./asr.js";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

let TELEGRAM_BOT_TOKEN = null;
let TELEGRAM_CHAT_ID = null;
let TG_UPLOAD_CHAT_ID = null;
let bot = null;

/**
 * Инициализация Telegram-бота (polling mode)
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

  // === Команды ===
  bot.start((ctx) => ctx.reply("✅ Бот активен и готов к работе!"));
  bot.command("ping", (ctx) => ctx.reply("🏓 Pong!"));
  bot.command("scan", async (ctx) => {
    await ctx.reply("🔍 Начинаю ручное сканирование звонков...");
    await processCallsAndReport(ctx);
  });

  // === Обработка голосовых и аудио ===
  bot.on("message", async (ctx) => {
    const msg = ctx.message;

    if (msg.voice || msg.audio) {
      const fileId = msg.voice?.file_id || msg.audio?.file_id;
      console.log(`🎤 Получен голос/аудио file_id=${fileId}`);

      try {
        const fileRes = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
        );
        const fileInfo = await fileRes.json();

        if (!fileInfo.ok || !fileInfo.result?.file_path) {
          await ctx.reply("⚠️ Не удалось получить файл из Telegram API.");
          return;
        }

        const filePath = fileInfo.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

        await ctx.reply("🎧 Распознаю голос...");
        const transcript = await transcribeAudio(fileUrl);

        if (transcript) {
          // Разбиваем длинные тексты на части
          const parts = transcript.match(/[\s\S]{1,4000}/g) || [];
          for (const [i, part] of parts.entries()) {
            await ctx.reply(`🗣️ Часть ${i + 1}/${parts.length}:\n${part}`);
          }

          const qa = await analyzeTranscript(transcript, { callId: "TG-VOICE" });
          const qaText = formatQaForTelegram(qa);
          await ctx.reply(`📊 Анализ звонка:\n${qaText}`);
        } else {
          await ctx.reply("⚠️ Не удалось транскрибировать голос.");
        }
      } catch (err) {
        console.error("❌ Ошибка при обработке голосового:", err);
        await ctx.reply("❌ Ошибка при обработке голосового сообщения.");
      }
    } else if (msg.text) {
      await ctx.reply(
        "📨 Команды:\n/start — проверить связь\n/ping — тест\n/scan — обработать звонки из AmoCRM"
      );
    }
  });

  // === Запуск Polling ===
  await bot.launch();
  console.log("🤖 Telegram запущен в режиме polling (читает чат напрямую)");

  // === Автообработка звонков ===
  const AUTO_SCAN_MINUTES = parseInt(env.AUTO_SCAN_MINUTES || "5", 10);
  if (AUTO_SCAN_MINUTES > 0) {
    setInterval(async () => {
      console.log(`🕒 Авто-скан звонков (${AUTO_SCAN_MINUTES} мин)...`);
      await processCallsAndReport();
    }, AUTO_SCAN_MINUTES * 60 * 1000);

    console.log(`🔁 Автоматическая обработка звонков включена (${AUTO_SCAN_MINUTES} мин)`);
  }
}

/**
 * Отправка текста в Telegram
 */
export async function sendTGMessage(text, chatOverride = null) {
  try {
    if (!bot) return;
    const chatId = chatOverride || TELEGRAM_CHAT_ID;

    // Разбиваем длинные сообщения (Telegram лимит 4096)
    const parts = text.match(/[\s\S]{1,4000}/g) || [];
    for (const part of parts) {
      await bot.telegram.sendMessage(chatId, part, { parse_mode: "HTML" });
    }
  } catch (e) {
    console.error("❌ sendTGMessage:", e.message);
  }
}

/**
 * Relay: загружает mp3 в Telegram и возвращает ссылку
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
    const buffer = Buffer.from(await res.arrayBuffer());

    const tmpFile = `/tmp/audio_${Date.now()}.mp3`;
    fs.writeFileSync(tmpFile, buffer);

    const formData = new FormData();
    formData.append("chat_id", TG_UPLOAD_CHAT_ID);
    formData.append("document", fs.createReadStream(tmpFile));
    formData.append("caption", "📎 Звонок (relay)");

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
    console.error("❌ uploadToTelegramAndGetUrl:", safeStr(e));
    return null;
  }
}

/**
 * Основной процесс обработки звонков
 */
export async function processCallsAndReport(ctx = null) {
  try {
    const unprocessed = await getUnprocessedCalls(5);
    if (!unprocessed.length) {
      const msg = "📭 Нет новых звонков для обработки";
      console.log(msg);
      if (ctx) await ctx.reply(msg);
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

    if (ctx) await ctx.reply("✅ Все новые звонки обработаны!");
  } catch (e) {
    console.error("❌ processCallsAndReport:", safeStr(e));
    if (ctx) await ctx.reply("❌ Ошибка при обработке звонков");
  }
}
