// index.js
import express from "express";
import bodyParser from "body-parser";
import { processAmoCalls } from "./amo.js";
import { transcribeAudio } from "./asr.js";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";
import { getUnprocessedCalls, markCallProcessed } from "./supabaseStore.js";
import { initTelegramEnv, sendTGMessage } from "./telegram.js";
import { debug, safeStr } from "./utils.js";

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

initTelegramEnv(process.env);

const PORT = process.env.PORT || 8080;
const POLL_INTERVAL_MIN = parseInt(process.env.AMO_POLL_MINUTES || "5", 10) * 60 * 1000;

// ====================== CORE PROCESS ======================

async function mainCycle() {
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
      const { note_id, link } = call;
      debug(`➡️ Note ${note_id}: ${link}`);

      // 1️⃣ Транскрипция
      const transcript = await transcribeAudio(link);
      if (!transcript) {
        debug(`⚠️ Пропущен звонок ${note_id}: не удалось транскрибировать`);
        continue;
      }

      // 2️⃣ Анализ звонка (QA)
      const qa = await analyzeTranscript(transcript, { callId: note_id });
      const qaText = formatQaForTelegram(qa);

      // 3️⃣ Telegram отчёт
      await sendTGMessage(`📞 <b>Звонок #${note_id}</b>\n${qaText}`);

      // 4️⃣ Помечаем в Supabase
      await markCallProcessed(note_id, transcript, qa);
      debug(`✅ Звонок ${note_id} полностью обработан`);
    }
  } catch (e) {
    console.error("❌ Ошибка цикла:", safeStr(e));
  }
}

// ====================== EXPRESS ROUTES ======================

app.get("/", (req, res) => res.send("✅ Smart AI Listener v3 работает"));

app.post("/amo/force-scan", async (req, res) => {
  debug("⚙️ Принудительный запуск /amo/force-scan");
  await mainCycle();
  res.json({ ok: true });
});

app.get("/status", async (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    env: {
      AMO_BASE_URL: process.env.AMO_BASE_URL,
      TG_CHAT_ID: process.env.TG_CHAT_ID,
    },
  });
});
import { getAmoTokens } from "./supabaseStore.js";
import { fetchWithTimeout } from "./utils.js";

app.get("/amo/debug", async (req, res) => {
  try {
    const key = req.query.key;
    if (key !== process.env.CRM_SHARED_KEY) return res.status(403).json({ error: "Forbidden" });

    const tokens = await getAmoTokens();
    if (!tokens?.access_token) return res.status(401).json({ error: "No valid token" });

    const url = `${process.env.AMO_BASE_URL}/api/v4/leads/notes?filter[type]=call_in&limit=10`;
    const amoRes = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    const json = await amoRes.json();

    if (!json?._embedded?.notes) {
      return res.status(500).json({ error: "No notes returned", raw: json });
    }

    const result = json._embedded.notes.map((n) => ({
      id: n.id,
      entity_id: n.entity_id,
      created_at: n.created_at,
      link: n.params?.LINK || n.params?.link || null,
      type: n.note_type,
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
