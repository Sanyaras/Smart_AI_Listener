// telegram.js
import crypto from "crypto";
import { fetchWithTimeout, debug, safeStr, chunkText } from "./utils.js";

export const TELEGRAM = {
  TG_BOT_TOKEN: "",
  TG_CHAT_ID: "",
  TG_UPLOAD_CHAT_ID: "",
  TG_WEBHOOK_SECRET: "",
  NODE_ENV: "",
};

let tgQueue = [];
let tgWorkerRunning = false;

export function initTelegramEnv(env = process.env) {
  TELEGRAM.TG_BOT_TOKEN = env.TG_BOT_TOKEN || "";
  TELEGRAM.TG_CHAT_ID = env.TG_CHAT_ID || "";
  TELEGRAM.TG_UPLOAD_CHAT_ID = env.TG_UPLOAD_CHAT_ID || TELEGRAM.TG_CHAT_ID;
  TELEGRAM.TG_WEBHOOK_SECRET = env.TG_WEBHOOK_SECRET || crypto.randomBytes(8).toString("hex");
  TELEGRAM.NODE_ENV = env.NODE_ENV || "production";

  if (!TELEGRAM.TG_BOT_TOKEN || !TELEGRAM.TG_CHAT_ID) {
    throw new Error("❌ Missing TG_BOT_TOKEN or TG_CHAT_ID");
  }

  debug("✅ Telegram env initialized");
}

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    tgQueue.push({ fn, resolve, reject });
    if (!tgWorkerRunning) runWorker();
  });
}

async function runWorker() {
  tgWorkerRunning = true;
  while (tgQueue.length) {
    const job = tgQueue.shift();
    try {
      const res = await job.fn();
      job.resolve(res);
    } catch (e) {
      job.reject(e);
    }
    await new Promise((r) => setTimeout(r, 200)); // задержка между сообщениями
  }
  tgWorkerRunning = false;
}

async function tgRequest(api, body, timeout = 12000) {
  if (!TELEGRAM.TG_BOT_TOKEN) throw new Error("TG_BOT_TOKEN not set");
  const url = `https://api.telegram.org/bot${TELEGRAM.TG_BOT_TOKEN}/${api}`;
  const payload = JSON.stringify(body);

  return enqueue(async () => {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    }, timeout);

    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(`Telegram error: ${safeStr(data)}`);
    return data;
  });
}

export async function sendTGMessage(text) {
  try {
    const chunks = chunkText(text, 3900);
    for (const part of chunks) {
      await tgRequest("sendMessage", {
        chat_id: TELEGRAM.TG_CHAT_ID,
        text: part,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    }
    return true;
  } catch (e) {
    console.error("❌ sendTGMessage:", safeStr(e));
    return false;
  }
}

export async function sendTGDocument(fileUrl, caption = "") {
  try {
    await tgRequest("sendDocument", {
      chat_id: TELEGRAM.TG_UPLOAD_CHAT_ID,
      document: fileUrl,
      caption,
      parse_mode: "HTML",
    });
    return true;
  } catch (e) {
    console.error("❌ sendTGDocument:", safeStr(e));
    return false;
  }
}
