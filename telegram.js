// ====================== telegram.js — industrial+human readable v3.6 ======================
// Telegram-интеграция, relay, транскрипция, QA-анализ и Telegram-отчёт (с текстом звонка)

import crypto from "crypto";
import { fetchWithTimeout, cap, safeStr } from "./utils.js";
import { getUnprocessedCalls, markCallProcessed } from "./supabaseStore.js";
import { transcribeAudioFromUrl as transcribeAudio } from "./asr.js";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

export const TELEGRAM = {
  TG_BOT_TOKEN: "",
  TG_CHAT_ID: "",
  TG_WEBHOOK_SECRET: "",
  TG_SECRET: "",
  TG_UPLOAD_CHAT_ID: "",
  NODE_ENV: "",
};

/* -------------------- INIT -------------------- */
export function initTelegramEnv(env = process.env) {
  TELEGRAM.TG_BOT_TOKEN = env.TG_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || "";
  TELEGRAM.TG_CHAT_ID = env.TG_CHAT_ID || env.TELEGRAM_CHAT_ID || "";
  TELEGRAM.TG_UPLOAD_CHAT_ID = env.TG_UPLOAD_CHAT_ID || TELEGRAM.TG_CHAT_ID;
  TELEGRAM.TG_WEBHOOK_SECRET = (env.TG_WEBHOOK_SECRET || "").trim();
  TELEGRAM.TG_SECRET = TELEGRAM.TG_WEBHOOK_SECRET || "";
  TELEGRAM.NODE_ENV = env.NODE_ENV || "development";

  if (!TELEGRAM.TG_SECRET) {
    if (TELEGRAM.NODE_ENV === "production") {
      throw new Error("TG_WEBHOOK_SECRET is required in production");
    } else {
      TELEGRAM.TG_SECRET = crypto.randomBytes(18).toString("hex");
      console.warn(
        "⚠️ TG_WEBHOOK_SECRET not set — using ephemeral:",
        TELEGRAM.TG_SECRET
      );
    }
  }

  if (!TELEGRAM.TG_BOT_TOKEN) {
    console.warn("⚠️ TG_BOT_TOKEN не установлен, Telegram неактивен");
  } else {
    console.log("🤖 Telegram API инициализирован");
  }
}

/* -------------------- CORE TG REQUEST -------------------- */
async function tgRequest(apiPath, bodyObj, ms = 20000, retries = 2) {
  if (!TELEGRAM.TG_BOT_TOKEN)
    throw new Error("TG_BOT_TOKEN отсутствует (initTelegramEnv не выполнен)");
  const url = `https://api.telegram.org/bot${TELEGRAM.TG_BOT_TOKEN}/${apiPath}`;
  const payload = JSON.stringify(bodyObj);

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        },
        ms
      );
      const text = await r.text();
      const json = JSON.parse(text || "{}");
      if (!r.ok || !json.ok)
        throw new Error(`Telegram ${apiPath} ${r.status}: ${text}`);
      return json;
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ Telegram retry #${attempt + 1}: ${safeStr(e)}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/* -------------------- SEND MESSAGE -------------------- */
export async function sendTG(text) {
  if (!TELEGRAM.TG_CHAT_ID) {
    console.warn("⚠️ sendTG skipped: TG_CHAT_ID отсутствует");
    return false;
  }
  try {
    const body = {
      chat_id: TELEGRAM.TG_CHAT_ID,
      text: cap(text || "(пустое сообщение)", 4000),
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    await tgRequest("sendMessage", body);
    return true;
  } catch (e) {
    console.error("❌ sendTG ошибка:", safeStr(e));
    return false;
  }
}

/* -------------------- RELAY -------------------- */
export async function tgRelayAudio(origUrl, captionForTg = "🎧 Relay upload") {
  if (!TELEGRAM.TG_UPLOAD_CHAT_ID)
    throw new Error("TG_UPLOAD_CHAT_ID не установлен");

  console.log(`📡 Relay upload → ${origUrl}`);
  let sendResp;
  try {
    sendResp = await tgRequest(
      "sendDocument",
      {
        chat_id: TELEGRAM.TG_UPLOAD_CHAT_ID,
        document: origUrl,
        caption: captionForTg,
        parse_mode: "HTML",
      },
      30000
    );
  } catch (e) {
    console.warn("⚠️ sendDocument не сработал, fallback → sendAudio");
    sendResp = await tgRequest(
      "sendAudio",
      {
        chat_id: TELEGRAM.TG_UPLOAD_CHAT_ID,
        audio: origUrl,
        caption: captionForTg,
      },
      30000
    );
  }

  const fileId =
    sendResp?.result?.document?.file_id ||
    sendResp?.result?.audio?.file_id ||
    sendResp?.result?.voice?.file_id;
  if (!fileId) throw new Error("tgRelayAudio: Telegram не вернул file_id");

  const fileInfo = await tgRequest("getFile", { file_id: fileId }, 15000);
  const finalPath = fileInfo?.result?.file_path;
  if (!finalPath)
    throw new Error("tgRelayAudio: Telegram не вернул file_path");

  const finalUrl = `https://api.telegram.org/file/bot${TELEGRAM.TG_BOT_TOKEN}/${finalPath}`;
  console.log("✅ Relay готов:", finalUrl);
  return finalUrl;
}

/* -------------------- MAIN PROCESS -------------------- */
export async function processCallsAndReport() {
  try {
    const unprocessed = await getUnprocessedCalls(5);
    if (!unprocessed?.length) {
      console.log("📭 Нет новых звонков для обработки");
      return;
    }

    for (const call of unprocessed) {
      const { note_id, link } = call;
      console.log(`\n➡️ Обрабатываю звонок #${note_id}`);

      let relayUrl = link;
      if (link && link.includes("megapbx.ru")) {
        try {
          relayUrl = await tgRelayAudio(link, `📎 Relay из AmoCRM #${note_id}`);
        } catch (e) {
          console.error(`❌ Relay ошибка для #${note_id}:`, safeStr(e));
          continue;
        }
      }

      if (!relayUrl) continue;

      // Whisper транскрипция
      console.log(`🎤 Транскрибирую звонок #${note_id}...`);
      const transcript = await transcribeAudio(relayUrl).catch((e) => {
        console.error(`❌ Ошибка транскрипции #${note_id}:`, safeStr(e));
        return null;
      });

      if (!transcript || !transcript.trim()) {
        console.warn(`⚠️ Пропуск звонка #${note_id}: нет текста`);
        continue;
      }

      console.log(`✅ Транскрипция готова (${transcript.length} символов)`);

      // 💬 Отправляем саму транскрипцию в Telegram (в спойлере)
      const shortTranscript = cap(transcript, 3900);
      const spoiler = `🎙️ <b>Транскрипция звонка #${note_id}</b>\n||${shortTranscript.replace(
        /([|<>])/g,
        ""
      )}||`;
      await sendTG(spoiler);

      // Анализ
      console.log("🧠 Анализ звонка...");
      let qa;
      try {
        qa = await analyzeTranscript(transcript, { callId: note_id });
        console.log("✅ QA-анализ завершён");
      } catch (e) {
        console.error(`❌ Ошибка QA #${note_id}:`, safeStr(e));
        await sendTG(`❗️ Ошибка QA для звонка #${note_id}: ${safeStr(e)}`);
        continue;
      }

      // Отчёт в Telegram
      const qaText = formatQaForTelegram(qa);
      await sendTG(`📞 <b>Звонок #${note_id}</b>\n${qaText}`);

      // Сохраняем в Supabase
      await markCallProcessed(note_id, transcript, qa);
      console.log(`💾 Звонок #${note_id} сохранён`);
    }
  } catch (e) {
    console.error("💥 processCallsAndReport ошибка:", safeStr(e));
  }
}
