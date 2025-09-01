import express from "express";
import bodyParser from "body-parser";

const app = express();

app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.text({ type: ["text/*", "application/octet-stream"] }));

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CRM_SHARED_KEY = process.env.CRM_SHARED_KEY;

async function sendTG(text) {
  const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
}

function safeStr(obj) {
  try {
    if (typeof obj === "string") return obj.slice(0, 3500);
    return JSON.stringify(obj, null, 2).slice(0, 3500);
  } catch {
    return "[unserializable]";
  }
}

async function handler(req, res) {
  try {
    const method = req.method;
    const path = req.path || req.url || "/";
    const headers = req.headers || {};
    const query = req.query || {};
    const body = typeof req.body === "undefined" ? {} : req.body;

    // Проверка ключа (если вообще передан)
    const gotKey =
      headers["x-crm-key"] ||
      headers["x-auth-token"] ||
      headers["authorization"] ||
      query.key;
    if (CRM_SHARED_KEY && gotKey && String(gotKey) !== String(CRM_SHARED_KEY)) {
      return res.status(401).send("bad key");
    }

    // Полезные поля, если они есть
    const event =
      (typeof body === "object" ? (body.event || body.command || body.type) : undefined) ||
      query.event ||
      "unknown";
    const callId =
      (typeof body === "object" ? (body.call_id || body.uuid) : undefined) ||
      query.call_id ||
      "-";
    const from =
      (typeof body === "object" ? body.from : undefined) ||
      query.from ||
      "-";
    const to =
      (typeof body === "object" ? body.to : undefined) ||
      query.to ||
      "-";
    const ext =
      (typeof body === "object" ? (body.employee_ext || body.ext || body.agent) : undefined) ||
      query.ext ||
      "-";
    const recordUrl =
      (typeof body === "object" ? (body.record_url || body.recordUrl) : undefined) ||
      query.record_url;
    const recordId =
      (typeof body === "object" ? (body.record_id || body.recordId) : undefined) ||
      query.record_id;

    const lines = [
      "📞 <b>MegaPBX → CRM webhook</b>",
      `• Method: <code>${method}</code>`,
      `• Path: <code>${path}</code>`,
      `• Event: <code>${event}</code>`,
      `• CallID: <code>${callId}</code>`,
      `• From: <code>${from}</code> → To: <code>${to}</code>`,
      `• Ext: <code>${ext}</code>`,
      recordUrl ? `• record_url: ${recordUrl}` : "",
      recordId ? `• record_id: <code>${recordId}</code>` : "",
      "",
      "<b>Headers</b>:\n<code>" + safeStr(headers) + "</code>",
      "",
      "<b>Query</b>:\n<code>" + safeStr(query) + "</code>",
      "",
      "<b>Body</b>:\n<code>" + safeStr(body) + "</code>"
    ].filter(Boolean);

    await sendTG(lines.join("\n"));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    try {
      await sendTG(`❗️ <b>Error</b>:\n<code>${(e && e.message) || e}</code>`);
    } catch {}
    res.status(500).send("server error");
  }
}

// Принимаем запросы на любой путь
app.all("*", handler);

app.get("/", (_, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log("listening on", process.env.PORT || 3000);
});
