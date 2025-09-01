import express from "express";
import bodyParser from "body-parser";

const app = express();

// --- parsers ---
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.text({ type: ["text/*", "application/octet-stream"] }));

// --- env ---
const TG_BOT_TOKEN   = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID     = process.env.TG_CHAT_ID;
const CRM_SHARED_KEY = process.env.CRM_SHARED_KEY;

const MEGAPBX_BASE   = process.env.MEGAPBX_BASE || "";   // пример: https://vats299897.megapbx.ru/crmapi/v1
const MEGAPBX_TOKEN  = process.env.MEGAPBX_TOKEN || "";  // пример: cd0337d3-af81-...

// ------------- helpers -------------
async function sendTG(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
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
  }).catch(() => {});
}

function safeStr(obj) {
  try {
    if (typeof obj === "string") return obj.slice(0, 3500);
    return JSON.stringify(obj, null, 2).slice(0, 3500);
  } catch {
    return "[unserializable]";
  }
}

// ------------- universal webhook handler -------------
async function handler(req, res) {
  try {
    const method  = req.method;
    const path    = req.path || req.url || "/";
    const headers = req.headers || {};
    const query   = req.query || {};
    const body    = typeof req.body === "undefined" ? {} : req.body;

    // мягкая проверка ключа (если прислали и не совпал — 401; если не прислали — пропускаем)
    const gotKey =
      headers["x-crm-key"] ||
      headers["x-auth-token"] ||
      headers["authorization"] ||
      query.key;
    if (CRM_SHARED_KEY && gotKey && String(gotKey) !== String(CRM_SHARED_KEY)) {
      return res.status(401).send("bad key");
    }

    // извлекаем «полезные» поля, если присутствуют
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

// принимаем запросы на ЛЮБОЙ путь (на случай если ВАТС игнорирует хвосты)
app.all("*", handler);

// ------------- probe: авто-проверка API MegaPBX -------------
async function tryFetch(url, method, headers) {
  const r = await fetch(url, { method, headers });
  const text = await r.text();
  return { status: r.status, ok: r.ok, text: text.slice(0, 2000) };
}

/**
 * GET /megafon/probe
 * Перебирает несколько способов авторизации и эндпоинтов (/accounts, /calls),
 * и шлёт первый успешный ответ в Telegram.
 * ENV: MEGAPBX_BASE, MEGAPBX_TOKEN
 */
app.get("/megafon/probe", async (req, res) => {
  if (!MEGAPBX_BASE || !MEGAPBX_TOKEN) {
    await sendTG("⚠️ MEGAPBX_BASE/MEGAPBX_TOKEN не заданы.");
    return res.status(400).json({ ok: false, msg: "missing env" });
  }

  const endpoints = [
    "/accounts",
    "/calls?limit=20",
    `/calls?from=${encodeURIComponent(new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`
  ];
  const authVariants = [
    { name: "Bearer",       headers: { Authorization: `Bearer ${MEGAPBX_TOKEN}` } },
    { name: "X-Auth-Token", headers: { "X-Auth-Token": MEGAPBX_TOKEN } },
    { name: "QueryToken",   headers: {}, addQuery: `token=${encodeURIComponent(MEGAPBX_TOKEN)}` }
  ];

  let report = ["🔎 <b>MegaPBX probe</b>", `base: <code>${MEGAPBX_BASE}</code>`];
  for (const ep of endpoints) {
    for (const av of authVariants) {
      const url = av.addQuery ? `${MEGAPBX_BASE}${ep}${ep.includes("?") ? "&" : "?"}${av.addQuery}` : `${MEGAPBX_BASE}${ep}`;
      try {
        const out = await tryFetch(url, "GET", av.headers);
        report.push(`• ${ep} [${av.name}] → ${out.status}${out.ok ? " OK" : ""}`);
        if (out.ok) {
          report.push(`<code>${out.text}</code>`);
          await sendTG(report.join("\n"));
          return res.json({ ok: true, hit: { ep, auth: av.name } });
        }
      } catch (e) {
        report.push(`• ${ep} [${av.name}] → error: ${e.message}`);
      }
    }
  }
  await sendTG(report.join("\n"));
  res.status(502).json({ ok: false, msg: "no working combo found yet" });
});

/**
 * GET /megafon/accounts/test
 * Явно бьём в /accounts и шлём результат в Телеграм.
 * ENV: MEGAPBX_BASE, MEGAPBX_TOKEN
 */
app.get("/megafon/accounts/test", async (req, res) => {
  if (!MEGAPBX_BASE || !MEGAPBX_TOKEN) {
    return res.status(400).json({ ok: false, msg: "missing env" });
  }
  try {
    // по очереди пробуем 3 варианта авторизации
    const tries = [
      { headers: { Authorization: `Bearer ${MEGAPBX_TOKEN}` }, url: `${MEGAPBX_BASE}/accounts` },
      { headers: { "X-Auth-Token": MEGAPBX_TOKEN }, url: `${MEGAPBX_BASE}/accounts` },
      { headers: {}, url: `${MEGAPBX_BASE}/accounts?token=${encodeURIComponent(MEGAPBX_TOKEN)}` }
    ];
    for (const t of tries) {
      const r = await fetch(t.url, { method: "GET", headers: t.headers });
      const text = await r.text();
      if (r.ok) {
        await sendTG("👥 <b>Accounts</b>:\n<code>" + text.slice(0, 3500) + "</code>");
        return res.json({ ok: true });
      }
    }
    await sendTG("❗️ accounts: ни один способ авторизации не сработал");
    res.status(502).json({ ok: false });
  } catch (e) {
    await sendTG("❗️ accounts error: <code>" + (e?.message || e) + "</code>");
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// health
app.get("/", (_, res) => res.send("OK"));

// listen
app.listen(process.env.PORT || 3000, () => {
  console.log("listening on", process.env.PORT || 3000);
});

