// telegram.js — финальная версия (возвращаем проверенный relay)
import crypto from "crypto";
import { fetchWithTimeout, cap, safeStr } from "./utils.js";
import { getUnprocessedCalls, markCallProcessed } from "./supabaseStore.js";
import { transcribeAudio } from "./asr.js";
import { analyzeTranscript, formatQaForTelegram } from "./qa_assistant.js";

export const TELEGRAM = {
  TG_BOT_TOKEN: "",
  TG_CHAT_ID: "",
  TG_WEBHOOK_SECRET: "",
  TG_SECRET: "",
  TG_UPLOAD_CHAT_ID: "",
  NODE_ENV: ""
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
}

/* -------------------- TG CORE -------------------- */
async function tgRequest(apiPath, bodyObj, ms = 15000) {
  if (!TELEGRAM.TG_BOT_TOKEN) throw new Error("TG_BOT_TOKEN not set");
  const url = `https://api.telegram.org/bot${TELEGRAM.TG_BOT_TOKEN}/${apiPath}`;
  const payload = JSON.stringify(bodyObj);

  const r = await fetchWithTimeout(
    url,
    { method: "POST", headers: { "content-type": "application/json" }, body: payload },
    ms
  );

  const text = await r.text();
  if (!r.ok) throw new Error(`Telegram ${apiPath} ${r.status}: ${text}`);
  const json = JSON.parse(text);
  if (!json.ok) throw new Error(`Telegram ${apiPath} error: ${text}`);
  return json;
}

/* -------------------- SEND -------------------- */
export async function sendTG(text) {
  try {
    if (!TELEGRAM.TG_BOT_TOKEN || !TELEGRAM.TG_CHAT_ID) {
      console.warn("⚠️ sendTG skipped: no TG env");
      return false;
    }
    const body = {
      chat_id: TELEGRAM.TG_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    };
    await tgRequest("sendMessage", body);
    return true;
  } catch (e) {
    console.error("❌ sendTG:", e.message || e);
    return false;
  }
}

export async function tgReply(chatId, text, extra = {}) {
  try {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra
    };
    await tgRequest("sendMessage", body);
  } catch (e) {
    console.error("tgReply error:", e.message || e);
  }
}

export async function tgGetFileUrl(fileId) {
  const resp = await tgRequest("getFile", { file_id: fileId });
  if (!resp?.result?.file_path)
    throw new Error(`tgGetFileUrl: file_path missing`);
  return `https://api.telegram.org/file/bot${TELEGRAM.TG_BOT_TOKEN}/${resp.result.file_path}`;
}

/* -------------------- RELAY -------------------- */
export async function tgRelayAudio(origUrl, captionForTg = "🎧 Relay upload") {
  if (!TELEGRAM.TG_UPLOAD_CHAT_ID) throw new Error("TG_UPLOAD_CHAT_ID not set");

  // 📤 Telegram сам скачивает файл по URL — без ручного стрима
  const sendResp = await tgRequest(
    "sendDocument",
    {
      chat_id: TELEGRAM.TG_UPLOAD_CHAT_ID,
      document: origUrl,
      caption: captionForTg,
      parse_mode: "HTML",
      disable_content_type_detection: false
    },
    25000
  );

  const fileId =
    sendResp?.result?.document?.file_id ||
    sendResp?.result?.audio?.file_id ||
    sendResp?.result?.voice?.file_id;

  if (!fileId) throw new Error("tgRelayAudio: no file_id from Telegram");

  const fileInfo = await tgRequest("getFile", { file_id: fileId }, 15000);
  if (!fileInfo?.result?.file_path)
    throw new Error("tgRelayAudio: missing file_path");

  const finalUrl = `https://api.telegram.org/file/bot${TELEGRAM.TG_BOT_TOKEN}/${fileInfo.result.file_path}`;
  console.log("✅ Relay готов:", finalUrl);
  return finalUrl;
}

/* -------------------- PROCESS CALLS -------------------- */
export async function processCallsAndReport() {
  try {
    const unprocessed = await getUnprocessedCalls(5);
    if (!unprocessed.length) {
      console.log("📭 Нет новых звонков для обработки");
      return;
    }

    for (const call of unprocessed) {
      const { note_id, link } = call;
      console.log(`📞 Обрабатываю звонок #${note_id}`);

      // relay если megapbx
      let relayUrl = link;
      if (link && link.includes("megapbx.ru")) {
        relayUrl = await tgRelayAudio(link, "📎 Relay из AmoCRM");
      }

      if (!relayUrl) continue;

      const transcript = await transcribeAudio(relayUrl);
      if (!transcript) continue;

      const qa = await analyzeTranscript(transcript, { callId: note_id });
      const qaText = formatQaForTelegram(qa);

      await sendTG(`📞 <b>Звонок #${note_id}</b>\n${qaText}`);
      await markCallProcessed(note_id, transcript, qa);
      console.log(`✅ Звонок #${note_id} обработан`);
    }
  } catch (e) {
    console.error("❌ processCallsAndReport:", safeStr(e));
  }
}
