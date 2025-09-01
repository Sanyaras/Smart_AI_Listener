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

app.all("/megafon", async (req, res) => {
  try {
    const gotKey =
      req.headers["x-crm-key"] ||
      req.query?.key ||
      req.headers["authorization"];

    if (CRM_SHARED_KEY && gotKey && String(gotKey) !== String(CRM_SHARED_KEY)) {
      return res.status(401).send("bad key");
    }

    const body = req.body;
    const event = body?.event || body?.command || body?.type || "unknown";
    const callId = body?.call_id || "-";
    const from = body?.from || "-";
    const to = body?.to || "-";
    const ext = body?.employee_ext || "-";
    const recordUrl = body?.record_url;
    const recordId = body?.record_id;

    const lines = [
      "📞 <b>MegaPBX → CRM webhook</b>",
      `• Event: <code>${event}</code>`,
      `• CallID: <code>${callId}</code>`,
      `• From: <code>${from}</code> → To: <code>${to}</code>`,
      `• Ext: <code>${ext}</code>`,
      recordUrl ? `• record_url: ${recordUrl}` : "",
      recordId ? `• record_id: <code>${recordId}</code>` : "",
      "",
      "<i>Raw body:</i>",
      `<code>${safeStr(body)}</code>`
    ].filter(Boolean);

    await sendTG(lines.join("\n"));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).send("server error");
  }
});

function safeStr(obj) {
  try {
    return JSON.stringify(obj, null, 2).slice(0, 3500);
  } catch {
    return "[unserializable]";
  }
}

app.get("/", (_, res) => res.send("OK"));

app.listen(process.env.PORT || 3000, () => {
  console.log("listening on", process.env.PORT || 3000);
});
