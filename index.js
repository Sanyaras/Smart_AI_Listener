import express from "express";
import bodyParser from "body-parser";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

const app = express();

/* ---------- parsers ---------- */
app.use(bodyParser.json({ limit: "2mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.text({ type: ["text/*", "application/octet-stream"] }));

/* ---------- env ---------- */
const TG_BOT_TOKEN   = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID     = process.env.TG_CHAT_ID;
const CRM_SHARED_KEY = process.env.CRM_SHARED_KEY;

const MEGAPBX_BASE   = process.env.MEGAPBX_BASE || "";   // напр.: https://vats299897.megapbx.ru/crmapi/v1
const MEGAPBX_TOKEN  = process.env.MEGAPBX_TOKEN || "";  // напр.: cd0337d3-...
const MEGAPBX_PROXY  = process.env.MEGAPBX_PROXY || "";  // напр.: http://user:pass@host:port

/* ---------- proxy agent ---------- */
function makeAgent(url) {
  try {
    if (!url) return undefined;
    if (url.startsWith("http://"))  return new HttpProxyAgent(url);
    if (url.startsWith("https://")) return new HttpsProxyAgent(url);
    if (url.startsWith("socks5://") || url.startsWith("socks://")) return new SocksProxyAgent(url);
    return undefined;
  } catch { return undefined; }
}
const proxyAgent = makeAgent(MEGAPBX_PROXY);

/* ---------- helpers ---------- */
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

async function apiGet(path, headers = {}) {
  const url = `${MEGAPBX_BASE}${path}`;
  const r = await fetch(url, { method: "GET", headers, agent: proxyAgent });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

/* ---------- SPECIAL ROUTES ---------- */

/** Проверка прокси: какой внешний IP? */
app.get("/proxy/ip", async (req, res) => {
  try {
    const r = await fetch("https://api.ipify.org?format=json", { agent: proxyAgent });
    const t = await r.text();
    await sendTG("🛰️ <b>Proxy IP</b>:\n<code>" + t + "</code>");
    res.type("application/json").send(t);
  } catch (e) {
    await sendTG("❗️ /proxy/ip error: <code>" + (e?.message || e) + "</code>");
    res.status(500).send("proxy ip failed");
  }
});

/** Проверка прокси: забрать страницу через прокси */
app.get("/proxy/fetch", async (req, res) => {
  const url = req.query.url || "https://ya.ru";
  try {
    const r = await fetch(url, { agent: proxyAgent });
    const text = await r.text();
    await sendTG("🌐 <b>Proxy fetch OK</b>: " + url + "\n<code>" + text.slice(0, 300) + "</code>");
    res.type("text/html").send(text);
  } catch (e) {
    await sendTG("❗️ /proxy/fetch error (" + url + "): <code>" + (e?.message || e) + "</code>");
    res.status(500).send("proxy fetch failed");
  }
});

/** Probe MegaPBX REST /crmapi/v1 через прокси */
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
      const path = av.addQuery ? `${ep}${ep.includes("?") ? "&" : "?"}${av.addQuery}` : ep;
      try {
        const out = await apiGet(path, av.headers);
        report.push(`• ${ep} [${av.name}] → ${out.status}${out.ok ? " OK" : ""}`);
        if (out.ok) {
          report.push(`<code>${out.text.slice(0, 2000)}</code>`);
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

/* ---------- UNIVERSAL WEBHOOK HANDLER (catch-all) ---------- */
async function handler(req, res) {
  try {
    const method  = req.method;
    const path    = req.path || req.url || "/";
    const headers = req.headers || {};
    const query   = req.query || {};
    const body    = typeof req.body === "undefined" ? {} : req.body;

    const gotKey =
      headers["x-crm-key"] ||
      headers["x-auth-token"] ||
      headers["authorization"] ||
      query.key;
    if (CRM_SHARED_KEY && gotKey && String(gotKey) !== String(CRM_SHARED_KEY)) {
      return res.status(401).send("bad key");
    }

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
    try { await sendTG(`❗️ <b>Error</b>:\n<code>${(e && e.message) || e}</code>`); } catch {}
    res.status(500).send("server error");
  }
}

/* ---------- health ---------- */
app.get("/", (_, res) => res.send("OK"));

/* ---------- catch-all AFTER special routes ---------- */
app.all("*", handler);

/* ---------- listen ---------- */
app.listen(process.env.PORT || 3000, () => {
  console.log("listening on", process.env.PORT || 3000);
});
