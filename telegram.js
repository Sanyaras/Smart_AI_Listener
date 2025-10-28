// telegram.js
import crypto from "crypto";
import { fetchWithTimeout, cap, chunkText, fmtPhone, prettyType, safeStr } from "./utils.js";

let tgQueue = [];
let tgWorkerRunning = false;

export function initTelegramEnv(env) {
  TELEGRAM.TG_BOT_TOKEN = env.TG_BOT_TOKEN || "";
  TELEGRAM.TG_CHAT_ID = env.TG_CHAT_ID || "";
  TELEGRAM.TG_WEBHOOK_SECRET = (env.TG_WEBHOOK_SECRET || "").trim();
  TELEGRAM.TG_SECRET = TELEGRAM.TG_WEBHOOK_SECRET || "";
  TELEGRAM.TG_UPLOAD_CHAT_ID = env.TG_UPLOAD_CHAT_ID || TELEGRAM.TG_CHAT_ID;
  TELEGRAM.NODE_ENV = env.NODE_ENV || "development";

  if (!TELEGRAM.TG_SECRET) {
    if (TELEGRAM.NODE_ENV === "production") {
      throw new Error("TG_WEBHOOK_SECRET is required in production");
    } else {
      TELEGRAM.TG_SECRET = crypto.randomBytes(18).toString("hex");
      console.warn("TG_WEBHOOK_SECRET not set — using ephemeral secret:", TELEGRAM.TG_SECRET);
    }
  }
}

export const TELEGRAM = {
  TG_BOT_TOKEN: "",
  TG_CHAT_ID: "",
  TG_WEBHOOK_SECRET: "",
  TG_SECRET: "",
  TG_UPLOAD_CHAT_ID: "",
  NODE_ENV: ""
};

function enqueueTGTask(fn) {
  return new Promise((resolve, reject) => {
    tgQueue.push({ fn, resolve, reject });
    if (!tgWorkerRunning) runTgWorker();
  });
}

async function runTgWorker() {
  tgWorkerRunning = true;
  while (tgQueue.length) {
    const item = tgQueue.shift();
    try {
      const result = await item.fn();
      item.resolve(result);
    } catch (e) {
      item.reject(e);
    }
    await new Promise(r => setTimeout(r, parseInt(process.env.TG_SEND_DELAY_MS || "150", 10)));
  }
  tgWorkerRunning = false;
}

export function getTelegramQueuesState() {
  return { tgWorkerRunning, tgQueueLength: tgQueue.length };
}

async function tgRequest(apiPath, bodyObj, ms = 12000) {
  if (!TELEGRAM.TG_BOT_TOKEN) throw new Error("TG_BOT_TOKEN not set");
  const url = `https://api.telegram.org/bot${TELEGRAM.TG_BOT_TOKEN}/${apiPath}`;
  const payload = JSON.stringify(bodyObj);
  const attempt = async (triesLeft = 3, backoff = 250) => {
    try {
      const r = await fetchWithTimeout(url, { method: "POST", headers: { "content-type":"application/json" }, body: payload }, ms);
      if (!r.ok) {
        const text = await r.text().catch(()=>"");
        const err = new Error(`tg ${apiPath} http ${r.status}: ${text}`);
        if (r.status >= 500 && triesLeft > 1) {
          await new Promise(r=>setTimeout(r, backoff));
          return attempt(triesLeft - 1, backoff * 2);
        }
        throw err;
      }
      return await r.json().catch(()=>({ ok: true }));
    } catch (e) {
      if (triesLeft > 1 && (e.name === "FetchError" || String(e).includes("timeout"))) {
        await new Promise(r=>setTimeout(r, backoff));
        return attempt(triesLeft - 1, backoff * 2);
      }
      throw e;
    }
  };
  return enqueueTGTask(() => attempt());
}

export async function sendTG(text) {
  try {
    if (!TELEGRAM.TG_BOT_TOKEN || !TELEGRAM.TG_CHAT_ID) { console.warn("sendTG skipped: no TG env"); return false; }
    const body = { chat_id: TELEGRAM.TG_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true };
    await tgRequest("sendMessage", body, 12000);
    return true;
  } catch (e) {
    console.error("sendTG error:", e?.message || e);
    return false;
  }
}

export async function sendTGDocument(fileUrl, caption = "") {
  if (!TELEGRAM.TG_BOT_TOKEN || !TELEGRAM.TG_CHAT_ID) return false;
  const body = { chat_id: TELEGRAM.TG_CHAT_ID, document: fileUrl, caption, parse_mode: "HTML", disable_content_type_detection: false };
  return await tgRequest("sendDocument", body, 20000);
}

export async function tgReply(chatId, text, extra = {}) {
  try {
    const body = { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra };
    await tgRequest("sendMessage", body, 12000);
    return true;
  } catch (e) {
    console.error("tgReply error:", e?.message || e);
    return false;
  }
}

export async function tgGetFileUrl(fileId) {
  const resp = await tgRequest("getFile", { file_id: fileId }, 12000);
  if (!resp || !resp.result || !resp.result.file_path) throw new Error(`getFile: file_path missing`);
  return `https://api.telegram.org/file/bot${TELEGRAM.TG_BOT_TOKEN}/${resp.result.file_path}`;
}

// relay внешний URL через тех-чат -> вернётся CDN ссылка телеги
export async function tgRelayAudio(origUrl, captionForTg = "") {
  if (!TELEGRAM.TG_UPLOAD_CHAT_ID) throw new Error("TG_UPLOAD_CHAT_ID not set");
  const sendResp = await tgRequest("sendDocument", {
    chat_id: TELEGRAM.TG_UPLOAD_CHAT_ID,
    document: origUrl,
    caption: captionForTg,
    parse_mode: "HTML",
    disable_content_type_detection: false
  }, 20000);

  const fileId =
    sendResp?.result?.document?.file_id ||
    sendResp?.result?.audio?.file_id ||
    sendResp?.result?.voice?.file_id;

  if (!fileId) throw new Error("tgRelayAudio: no file_id from Telegram");

  const fileInfo = await tgRequest("getFile", { file_id: fileId }, 12000);
  if (!fileInfo?.result?.file_path) throw new Error("tgRelayAudio: getFile missing file_path");

  return `https://api.telegram.org/file/bot${TELEGRAM.TG_BOT_TOKEN}/${fileInfo.result.file_path}`;
}

// то что раньше делалось в formatTgMessage()
export function formatTgMegapbxMessage(n) {
  const lines = [
    "📞 <b>MegaPBX → Webhook</b>",
    `• Событие: <b>${prettyType(n.type)}</b>`,
    `• CallID: <code>${n.callId}</code>`,
    `• Направление: <code>${n.direction || "-"}</code>`,
    `• От: ${fmtPhone(n.from)} → Кому: ${fmtPhone(n.to)}`,
    `• Наш номер (telnum): ${fmtPhone(n.telnum)}`,
    `• Внутр. (ext): <code>${n.ext}</code>`
  ];
  if (n.user && n.user !== "-")            lines.push(`• Оператор (user): <code>${n.user}</code>`);
  if (n.diversion && n.diversion !== "-")  lines.push(`• Diversion: ${fmtPhone(n.diversion)}`);
  const extras = [];
  if (n.extra) {
    const { status, duration, wait, start } = n.extra;
    if (status && status !== "-") extras.push(`статус: <code>${status}</code>`);
    if (duration) extras.push(`длительность: <code>${duration}s</code>`);
    if (wait) extras.push(`ожидание: <code>${wait}s</code>`);
    if (start) extras.push(`начало: <code>${start}</code>`);
  }
  if (extras.length) lines.push("", "• " + extras.join(" · "));
  if (n.recordInfo?.urls?.length) {
    lines.push("", "🎧 <b>Запись:</b>");
    for (const u of n.recordInfo.urls.slice(0, 5)) lines.push(`• ${u}`);
  } else if (n.recordInfo?.ids?.length) {
    lines.push("", "🎧 <b>ID записи:</b>");
    for (const id of n.recordInfo.ids.slice(0, 5)) lines.push(`• <code>${id}</code>`);
  }
  lines.push("", "<i>Raw:</i>", `<code>${safeStr(n.raw)}</code>`);
  return lines.join("\n");
}
