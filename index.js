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
import { initTelegram, sendTGMessage } from "./telegram.js";
import { fetchWithTimeout, debug, safeStr } from "./utils.js";

const app = express();
app.use(bodyParser.json({ limit: "10mb" }));

// ====================== INIT TELEGRAM (Webhook mode) ======================
(async () => {
  try {
    await initTelegram(process.env, app);
    console.log("🤖 Telegram инициализирован (Webhook mode)");
  } catch (err) {
    console.error("❌ Ошибка инициализации Telegram:", err);
  }
})();

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

      // 0️⃣ Проверка источника: если MegaPBX — проксируем через Telegram
      if (link && link.includes("megapbx.ru")) {
        debug("📡 MegaPBX detected — uploading to Telegram...");
        const newLink = await uploadToTelegramAndGetUrl(link);
        if (newLink) {
          link = newLink;
          debug("✅ Заменён на Telegram CDN:", link);
        } else {
          console.warn("⚠️ Не удалось загрузить через Telegram, пропуск...");
          continue;
        }
      }

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

    console.log("✅ mainCycle успешно завершён");
  } catch (e) {
    console.error("❌ Ошибка цикла:", safeStr(e));
  }
}

// ====================== EXPRESS ROUTES ======================

app.get("/", (req, res) => res.send("✅ Smart AI Listener v3 работает"));

app.post("/amo/force-scan", async (req, res) => {
  console.log("⚙️ POST /amo/force-scan запущен вручную");
  try {
    await mainCycle();
    console.log("✅ mainCycle завершён вручную");
    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Ошибка при ручном запуске force-scan:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
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

// ====================== DEBUG: SHORT ======================

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

    if (!json?._embedded?.notes)
      return res.status(500).json({ error: "No notes returned", raw: json });

    const result = json._embedded.notes.map((n) => ({
      id: n.id,
      entity_id: n.entity_id,
      created_at: n.created_at,
      link: n.params?.link || n.params?.LINK || null,
      type: n.note_type,
    }));

    res.json({ ok: true, count: result.length, notes: result });
  } catch (e) {
    console.error("❌ /amo/debug:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====================== DEBUG: FULL ======================

app.get("/amo/debug/full", async (req, res) => {
  try {
    const key = req.query.key;
    if (key !== process.env.CRM_SHARED_KEY)
      return res.status(403).json({ error: "Forbidden" });

    const scope = req.query.scope || "leads";
    const page = req.query.page || 1;
    const from = req.query.from || null;
    const limit = req.query.limit || 20;

    const tokens = await getAmoTokens();
    if (!tokens?.access_token)
      return res.status(401).json({ error: "No valid token" });

    let url = `${process.env.AMO_BASE_URL}/api/v4/${scope}/notes?limit=${limit}&page=${page}&order[id]=desc`;
    if (from) {
      const ts = Math.floor(new Date(from).getTime() / 1000);
      url += `&filter[created_at][from]=${ts}`;
    }

    console.log(`📡 Fetching ${scope} notes page=${page} from=${from || "none"} ...`);

    const amoRes = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${tokens.access_token}` } },
      25000
    );

    const json = await amoRes.json();
    const notes = (json._embedded?.notes || []).map((n) => ({
      id: n.id,
      type: n.note_type,
      created_at: n.created_at,
      entity_id: n.entity_id,
      paramsKeys: n.params ? Object.keys(n.params) : [],
      sample: JSON.stringify(n.params || {}).slice(0, 500) + "...",
    }));

    res.json({
      ok: true,
      scope,
      page,
      count: notes.length,
      notes,
    });
  } catch (e) {
    console.error("❌ /amo/debug/full:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ====================== CALLS VIEW ======================

app.get("/amo/calls", async (req, res) => {
  try {
    const key = req.query.key;
    if (key !== process.env.CRM_SHARED_KEY)
      return res.status(403).json({ error: "Forbidden" });

    const calls = await getRecentCalls(15);
    res.json({ ok: true, count: calls.length, calls });
  } catch (e) {
    console.error("❌ /amo/calls:", e);
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
