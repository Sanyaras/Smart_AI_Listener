// ====================== telegram.js — industrial+debug+unified v3.8-final ======================
// Telegram-интеграция, relay, транскрипция, QA-анализ и Telegram-отчёт (всё в один чат)

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
      console.warn("⚠️ TG_WEBHOOK_SECRET not set — using ephemeral:", TELEGRAM.TG_SECRET);
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
        { method: "POST", headers: { "content-type": "application/json" }, body: payload },
        ms
      );
      const txt = await r.text();
      const json = JSON.parse(txt || "{}");

      if (!r.ok || !json.ok) {
        throw new Error(`Telegram ${apiPath} ${r.status}: ${txt}`);
      }
      return json;
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ Telegram retry #${attempt + 1}/${retries + 1}: ${safeStr(e)}`);
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/* -------------------- SEND MESSAGE -------------------- */
export async function sendTG(text) {
  if (!TELEGRAM.TG_CHAT_ID) {
    console.warn("⚠️ sendTG: TG_CHAT_ID отсутствует");
    return false;
  }

  const body = {
    chat_id: TELEGRAM.TG_CHAT_ID,
    text: cap(text || "(пустое сообщение)", 3900),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  try {
    console.log(`📤 sendTG → chat_id=${TELEGRAM.TG_CHAT_ID}`);
    const res = await tgRequest("sendMessage", body, 10000, 1);
    if (res?.ok) console.log("✅ Сообщение успешно доставлено");
    return true;
  } catch (e) {
    console.error("❌ sendTG ошибка:", safeStr(e));
    return false;
  }
}

/* -------------------- RELAY -------------------- */
export async function tgRelayAudio(origUrl, captionForTg = "🎧 Relay upload") {
  const chatId = TELEGRAM.TG_UPLOAD_CHAT_ID || TELEGRAM.TG_CHAT_ID;
  if (!chatId) throw new Error("TG_UPLOAD_CHAT_ID/TG_CHAT_ID не установлен");

  console.log(`📡 Relay upload → ${origUrl} → чат ${chatId}`);

  let sendResp;
  try {
    sendResp = await tgRequest(
      "sendDocument",
      {
        chat_id: chatId,
        document: origUrl,
        caption: captionForTg,
        parse_mode: "HTML",
      },
      25000
    );
  } catch (e) {
    console.warn("⚠️ sendDocument не сработал, fallback → sendAudio");
    sendResp = await tgRequest(
      "sendAudio",
      { chat_id: chatId, audio: origUrl, caption: captionForTg },
      25000
    );
  }

  const fileId =
    sendResp?.result?.document?.file_id ||
    sendResp?.result?.audio?.file_id ||
    sendResp?.result?.voice?.file_id;
  if (!fileId) throw new Error("tgRelayAudio: Telegram не вернул file_id");

  const fileInfo = await tgRequest("getFile", { file_id: fileId }, 15000);
  const filePath = fileInfo?.result?.file_path;
  if (!filePath) throw new Error("tgRelayAudio: Telegram не вернул file_path");

  const finalUrl = `https://api.telegram.org/file/bot${TELEGRAM.TG_BOT_TOKEN}/${filePath}`;
  console.log(`✅ Relay готов: ${finalUrl}`);
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
      console.log(`\n==============================\n➡️ Звонок #${note_id}\n==============================`);

      let relayUrl = link;
      if (link && link.includes("megapbx.ru")) {
        try {
          relayUrl = await tgRelayAudio(link, `📎 Relay AmoCRM #${note_id}`);
        } catch (e) {
          console.error(`❌ Relay ошибка #${note_id}:`, safeStr(e));
          continue;
        }
      }

      if (!relayUrl) {
        console.warn(`⚠️ Пропуск звонка #${note_id}: relayUrl отсутствует`);
        continue;
      }

      // 🎤 Транскрипция
      console.log(`🎧 Транскрибирую #${note_id}...`);
      let transcript;
      try {
        transcript = await transcribeAudio(relayUrl);
        console.log(`✅ Транскрипция готова (${transcript?.length || 0} символов)`);
      } catch (e) {
        console.error(`❌ Ошибка транскрипции #${note_id}:`, safeStr(e));
        continue;
      }

      if (!transcript?.trim()) {
        console.warn(`⚠️ Пропуск звонка #${note_id}: пустая транскрипция`);
        continue;
      }

      // 💬 Отправляем транскрипцию в Telegram (в спойлере)
      const cleanTranscript = transcript.replace(/[<>&]/g, ""); // экранируем спецсимволы
      const shortTranscript = cap(cleanTranscript, 3900);
      const spoilerMsg = `🎙️ <b>Транскрипция звонка #${note_id}</b>\n||${shortTranscript}||`;
      await sendTG(spoilerMsg);

      // 🧠 Анализ звонка
      console.log("🧠 Анализ звонка...");
      let qa;
      try {
        qa = await analyzeTranscript(transcript, { callId: note_id });
        console.log("✅ QA-анализ успешно завершён");
      } catch (e) {
        console.error(`❌ Ошибка QA #${note_id}:`, safeStr(e));
        await sendTG(`⚠️ Ошибка QA для звонка #${note_id}: ${safeStr(e)}`);
        continue;
      }

      // 📊 Отчёт в Telegram
      const qaText = formatQaForTelegram(qa);
      const reportMsg = `📞 <b>Звонок #${note_id}</b>\n${qaText}`;
      const ok = await sendTG(reportMsg);
      if (!ok) console.warn(`⚠️ Не удалось отправить отчёт по звонку #${note_id}`);

      // 💾 Сохраняем в Supabase
      await markCallProcessed(note_id, transcript, qa);
      console.log(`💾 Звонок #${note_id} сохранён в базе`);
    }

    console.log("\n✅ processCallsAndReport завершён без критических ошибок\n");
  } catch (e) {
    console.error("💥 processCallsAndReport ошибка:", safeStr(e));
  }
}
