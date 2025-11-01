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

export async function initTelegram(env = process.env, app = null) {
  TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN || env.TG_BOT_TOKEN;
  TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID || env.TG_CHAT_ID;
  TG_UPLOAD_CHAT_ID = env.TG_UPLOAD_CHAT_ID || TELEGRAM_CHAT_ID;

  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("⚠️ TELEGRAM_BOT_TOKEN не задан — Telegram отключён");
    return;
  }

  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.start((ctx) => ctx.reply("✅ Бот активен и готов к работе!"));
  bot.command("scan", async (ctx) => {
    await ctx.reply("🔍 Запускаю скан звонков...");
    await processCallsAndReport(ctx);
  });

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
        const filePath = fileInfo.result.file_path;
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

        await ctx.reply("🎧 Распознаю голос...");
        const transcript = await transcribeAudio(fileUrl);

        if (transcript) {
          await ctx.reply(`🗣️ Расшифровка:\n\n${transcript.slice(0, 4000)}`);
          const qa = await analyzeTranscript(transcript, { callId: "TG-VOICE" });
          const qaText = formatQaForTelegram(qa);
          await ctx.reply(`📊 Анализ звонка:\n${qaText}`);
        } else {
          await ctx.reply("⚠️ Не удалось распознать голос.");
        }
      } catch (err) {
        console.error("❌ Ошибка при обработке голосового:", err);
        await ctx.reply("❌ Ошибка при обработке голосового.");
      }
    } else if (msg.text) {
      await ctx.reply("📨 Команды:\n/start — проверить связь\n/scan — анализ новых звонков");
    }
  });

  // === Webhook или fallback на polling ===
  const webhookDomain = (env.TG_WEBHOOK_URL || process.env.TG_WEBHOOK_URL || "")
    .trim()
    .replace(/^=+/, "");
  const webhookPath = `/tg/webhook/${env.TG_WEBHOOK_SECRET || "secret"}`;

  if (!webhookDomain || !webhookDomain.startsWith("https://")) {
    console.warn(`⚠️ TG_WEBHOOK_URL некорректен (${webhookDomain || "пусто"}) — Telegram в polling`);
    await bot.launch();
  } else if (app) {
    try {
      app.use(await bot.createWebhook({ domain: webhookDomain, path: webhookPath }));
      console.log(`🤖 Telegram бот запущен через webhook: ${webhookDomain}${webhookPath}`);
    } catch (err) {
      console.error("❌ Ошибка webhook, fallback polling:", err.message);
      await bot.launch();
    }
  } else {
    await bot.launch();
    console.log("⚙️ Telegram работает в polling режиме (app не передан)");
  }

  const AUTO_SCAN_MINUTES = parseInt(env.AUTO_SCAN_MINUTES || "5", 10);
  if (AUTO_SCAN_MINUTES > 0) {
    setInterval(async () => {
      console.log(`🕒 Авто-скан звонков (${AUTO_SCAN_MINUTES} мин)...`);
      await processCallsAndReport();
    }, AUTO_SCAN_MINUTES * 60 * 1000);
  }
}

export async function sendTGMessage(text, chatOverride = null) {
  try {
    if (!bot) return;
    const chatId = chatOverride || TELEGRAM_CHAT_ID;
    await bot.telegram.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (e) {
    console.error("❌ sendTGMessage:", e.message);
  }
}

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
    formData.append("document", fs.createReadStream(tmpFile));

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

export async function processCallsAndReport(ctx = null) {
  try {
    const unprocessed = await getUnprocessedCalls(5);
    if (!unprocessed.length) {
      const msg = "📭 Нет новых звонков";
      if (ctx) await ctx.reply(msg);
      console.log(msg);
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

      await sendTGMessage(`📞 <b>Звонок #${note_id}</b>\n${qaText}`);
      await markCallProcessed(note_id, transcript, qa);

      console.log(`✅ Звонок #${note_id} обработан`);
    }

    if (ctx) await ctx.reply("✅ Все звонки обработаны!");
  } catch (e) {
    console.error("❌ processCallsAndReport:", safeStr(e));
    if (ctx) await ctx.reply("❌ Ошибка при обработке звонков");
  }
}
