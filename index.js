// index.js
import express from "express";
import bodyParser from "body-parser";
import { processAmoCalls } from "./amo.js";
import { transcribeAudio } from "./asr.js";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";
import {
  getUnprocessedCalls,
  markCallProcessed,
  getAmoTokens,
  getRecentCalls
} from "./supabaseStore.js";
import { initTelegramEnv, sendTG as sendTGMessage, tgRelayAudio as uploadToTelegramAndGetUrl } from "./telegram.js";
import { fetchWithTimeout, debug, safeStr } from "./utils.js";

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const POLL_INTERVAL_MIN = parseInt(process.env.AMO_POLL_MINUTES || "5", 10) * 60 * 1000;

// ====================== INIT TELEGRAM ======================
try {
  initTelegramEnv(process.env);
  console.log("🤖 Telegram окружение инициализировано (relay mode)");
} catch (err) {
  console.error("❌ Ошибка инициализации Telegram:", err);
}

// ====================== CORE PROCESS ======================
async function mainCycle() {
  console.log("🌀 mainCycle() стартовал...");
  try {
    debug("🔄 Запуск цикла AmoCRM...");
    const found = await processAmoCalls();
    debug(`📥 Новых звонков из AmoCRM: ${found}`);

    const unprocessed = await getUnprocessedCalls(10);
    if (!unprocessed.length) {
      debug("📭 Нет необработанных звонков");
      return;
    }

    debug(`🎧 Обрабатываем ${unprocessed.length} звонков...`);
    for (const call of unprocessed) {
      let { note_id, link } = call;
      debug(`➡️ Note ${note_id}: ${link}`);

      // 0️⃣ MegaPBX: relay через Telegram, если ссылка не скачивается напрямую
      if (link && link.includes("megapbx.ru")) {
        debug("📡 MegaPBX detected — relay через Telegram...");
        const newLink = await uploadToTelegramAndGetUrl(link, "📎 Relay из AmoCRM");
        if (newLink) {
          link = newLink;
          debug("✅ Relay ссылка:", link);
        } else {
          console.warn("⚠️ Не удалось получить relay-ссылку, пропуск...");
          continue;
        }
      }

      // 1️⃣ Транскрипция
      const transcript = await transcribeAudio(link);
      if (!transcript) {
        debug(`⚠️ Пропущен звонок ${note_id}: не удалось транскрибировать`);
        continue;
      }

      // 2️⃣ Анализ звонка
      const qa = await analyzeTranscript(transcript, { callId: note_id });
      const qaText = formatQaForTelegram(qa);

      // 3️⃣ Отчёт в Telegram
      await sendTGMessage(`📞 <b>Звонок #${note_id}</b>\n${qaText}`);

      // 4️⃣ Пометка в Supabase
      await markCallProcessed(note_id, transcript, qa);
      debug(`✅ Звонок ${note_id} обработан`);
    }

    console.log("✅ mainCycle успешно завершён");
  } catch (e) {
    console.error("❌ Ошибка mainCycle:", safeStr(e));
  }
}

// ====================== EXPRESS ROUTES ======================
app.get("/", (req, res) => res.send("✅ Smart AI Listener v3 работает"));

app.post("/amo/force-scan", async (req, res) => {
  console.log("⚙️ POST /amo/force-scan запущен вручную");
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
    uptime: process.uptime(),
    env: {
      AMO_BASE_URL: process.env.AMO_BASE_URL,
      TG_CHAT_ID: process.env.TG_CHAT_ID
    }
  });
});

// ====================== DEBUG ROUTES ======================
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
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const json = await amoRes.json();

    if (!json?._embedded?.notes)
      return res.status(500).json({ error: "No notes returned", raw: json });

    const result = json._embedded.notes.map((n) => ({
      id: n.id,
      entity_id: n.entity_id,
      created_at: n.created_at,
      link: n.params?.link || n.params?.LINK || null,
      type: n.note_type
    }));

    res.json({ ok: true, count: result.length, notes: result });
  } catch (e) {
    console.error("❌ /amo/debug:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====================== SCHEDULER ======================
setInterval(mainCycle, POLL_INTERVAL_MIN);
mainCycle().catch(console.error);

// ====================== START SERVER ======================
app.listen(PORT, () => {
  console.log(`🚀 Smart-AI-Listener v3 запущен на порту ${PORT}`);
});
