// ====================== index.js — Smart AI Listener (ultimate v3.2) ======================
// Надёжная версия: устойчива к падениям, логирует каждый шаг, обрабатывает все звонки последовательно.

import express from "express";
import bodyParser from "body-parser";
import { processAmoCalls } from "./amo.js";
import { transcribeAudioFromUrl as transcribeAudio } from "./asr.js";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";
import {
  getUnprocessedCalls,
  markCallProcessed,
  getAmoTokens
} from "./supabaseStore.js";
import {
  initTelegramEnv,
  sendTG as sendTGMessage,
  tgRelayAudio as uploadToTelegramAndGetUrl
} from "./telegram.js";
import { fetchWithTimeout, debug, safeStr } from "./utils.js";

const app = express();
app.use(bodyParser.json({ limit: "15mb" }));

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MIN =
  parseInt(process.env.AMO_POLL_MINUTES || "5", 10) * 60 * 1000;

// ====================== INIT TELEGRAM ======================
try {
  initTelegramEnv(process.env);
  console.log("🤖 Telegram окружение инициализировано (relay mode)");
} catch (err) {
  console.error("❌ Ошибка инициализации Telegram:", err);
}

// ====================== CORE MAIN CYCLE ======================
async function mainCycle() {
  console.log("\n==============================");
  console.log(`🌀 mainCycle() стартовал @ ${new Date().toLocaleString()}`);
  console.log("==============================");

  try {
    debug("🔄 Получаем свежие звонки из AmoCRM...");
    const found = await processAmoCalls().catch((e) => {
      console.error("⚠️ processAmoCalls ошибка:", safeStr(e));
      return 0;
    });
    debug(`📥 Найдено новых звонков: ${found}`);

    const unprocessed = await getUnprocessedCalls(10);
    if (!unprocessed?.length) {
      debug("📭 Нет необработанных звонков в Supabase");
      return;
    }

    debug(`🎧 К обработке: ${unprocessed.length} звонков...`);
    for (const call of unprocessed) {
      const { note_id, link } = call;
      console.log(`\n➡️ Начинаю обработку звонка #${note_id}`);
      let relayUrl = link;

      // 0️⃣ Проверка источника (MegaPBX)
      if (link && link.includes("megapbx.ru")) {
        console.log("📡 MegaPBX ссылка обнаружена, relay через Telegram...");
        relayUrl = await uploadToTelegramAndGetUrl(link, `🎧 Relay для #${note_id}`).catch((e) => {
          console.error("❌ Relay ошибка:", safeStr(e));
          return null;
        });
        if (!relayUrl) {
          console.warn(`⚠️ Пропуск звонка #${note_id}: relay не удалось`);
          continue;
        }
      }

      // 1️⃣ Whisper-транскрипция
      console.log(`🎤 Транскрибирую звонок #${note_id}...`);
      const transcript = await transcribeAudio(relayUrl).catch((e) => {
        console.error("❌ Ошибка транскрипции:", safeStr(e));
        return null;
      });

      if (!transcript || !transcript.trim()) {
        console.warn(`⚠️ Пропуск звонка #${note_id}: нет текста`);
        continue;
      }

      console.log(`✅ Транскрипция готова (${transcript.length} символов)`);

      // 2️⃣ Анализ через QA Assistant
      console.log("🧠 Запускаю анализ звонка...");
      let qa;
      try {
        qa = await analyzeTranscript(transcript, { callId: note_id });
        console.log("✅ QA анализ завершён успешно");
        console.log("🧩 Фрагмент JSON:", JSON.stringify(qa).slice(0, 200));
      } catch (e) {
        console.error("❌ Ошибка при анализе звонка:", safeStr(e));
        await sendTGMessage(`❗️ Ошибка анализа звонка #${note_id}: ${safeStr(e)}`);
        continue;
      }

      // 3️⃣ Форматирование и отчёт в Telegram
      let qaText = "";
      try {
        qaText = formatQaForTelegram(qa);
        await sendTGMessage(`📞 <b>Звонок #${note_id}</b>\n${qaText}`);
        console.log("📨 Отчёт успешно отправлен в Telegram");
      } catch (e) {
        console.error("❌ Ошибка при отправке отчёта в Telegram:", safeStr(e));
      }

      // 4️⃣ Сохранение результатов в Supabase
      try {
        await markCallProcessed(note_id, transcript, qa);
        console.log(`✅ Звонок #${note_id} успешно записан как обработанный`);
      } catch (e) {
        console.error("⚠️ Ошибка при сохранении звонка:", safeStr(e));
      }
    }

    console.log("✅ mainCycle завершён успешно");
  } catch (e) {
    console.error("💥 Ошибка уровня mainCycle:", safeStr(e));
  }
}

// ====================== EXPRESS ROUTES ======================
app.get("/", (req, res) =>
  res.send("✅ Smart AI Listener v3.2 работает стабильно 🚀")
);

app.post("/amo/force-scan", async (req, res) => {
  console.log("⚙️ /amo/force-scan — ручной запуск обработки звонков");
  try {
    await mainCycle();
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Ошибка force-scan:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/status", (req, res) => {
  res.json({
    ok: true,
    uptime: `${Math.round(process.uptime())}s`,
    next_poll_min: POLL_INTERVAL_MIN / 60000,
    env: {
      AMO_BASE_URL: process.env.AMO_BASE_URL,
      TG_CHAT_ID: process.env.TG_CHAT_ID,
      NODE_ENV: process.env.NODE_ENV,
    },
  });
});

// ====================== DEBUG ROUTE ======================
app.get("/amo/debug", async (req, res) => {
  try {
    const key = req.query.key;
    if (key !== process.env.CRM_SHARED_KEY)
      return res.status(403).json({ error: "Forbidden" });

    const tokens = await getAmoTokens();
    if (!tokens?.access_token)
      return res.status(401).json({ error: "No valid token" });

    const url = `${process.env.AMO_BASE_URL}/api/v4/leads/notes?filter[type]=call_in&limit=10`;
    const amoRes = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const json = await amoRes.json();

    const notes = json?._embedded?.notes || [];
    res.json({
      ok: true,
      count: notes.length,
      notes: notes.map((n) => ({
        id: n.id,
        entity_id: n.entity_id,
        created_at: n.created_at,
        link: n.params?.link || n.params?.LINK || null,
        type: n.note_type,
      })),
    });
  } catch (e) {
    console.error("❌ /amo/debug ошибка:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====================== SCHEDULER ======================
setInterval(() => {
  console.log("⏰ Плановый запуск mainCycle()");
  mainCycle().catch(console.error);
}, POLL_INTERVAL_MIN);

// Первый запуск сразу при старте
mainCycle().catch(console.error);

// ====================== START SERVER ======================
app.listen(PORT, () => {
  console.log(`🚀 Smart-AI-Listener v3.2 запущен на порту ${PORT}`);
});
