import express from "express";
import bodyParser from "body-parser";

/* -------------------- app -------------------- */
const app = express();

/* --- parsers --- */
// JSON
app.use(bodyParser.json({ limit: "2mb" }));
// x-www-form-urlencoded (важно для MegaPBX)
app.use(bodyParser.urlencoded({ extended: false }));
// текст (на всякий)
app.use(bodyParser.text({ type: ["text/*", "application/octet-stream"] }));

/* --- env --- */
const TG_BOT_TOKEN   = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID     = process.env.TG_CHAT_ID;
const CRM_SHARED_KEY = process.env.CRM_SHARED_KEY || "boxfield-qa-2025"; // твой ключ из примера

/* -------------------- helpers -------------------- */
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
      disable_web_page_preview: false
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

/** Нормализуем объект события: разные поля → в единый вид */
function normalizeMegafon(body, headers = {}, query = {}) {
  // body может быть строкой (если чужой контент-тайп)
  let b = body;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch { b = { raw: b }; }
  }
  if (!b || typeof b !== "object") b = {};

  const type =
    b.type || b.event || b.command || b.status || query.type || query.event || "unknown";

  const callId =
    b.callid || b.call_id || b.uuid || b.id || query.callid || query.call_id || "-";

  const direction =
    b.direction || query.direction || "-"; // 'in' | 'out'

  const telnum = b.telnum || b.to || query.telnum || query.to || "-";     // наш номер/линию
  const phone  = b.phone  || b.from || query.phone  || query.from || "-"; // номер абонента
  const ext    = b.ext || b.employee_ext || b.agent || query.ext || "-";

  // Отформатируем From/To в зависимости от направления
  let from = "-";
  let to   = "-";
  if (direction === "out") { from = telnum; to = phone; }
  else if (direction === "in") { from = phone; to = telnum; }
  else {
    // неизвестно — покажем оба, что есть
    from = b.from || phone || "-";
    to   = b.to   || telnum || "-";
  }

  // Соберём кандидатов на "запись" из всех ключей
  const recordInfo = extractRecordInfo(b);

  return {
    type, callId, direction, telnum, phone, ext, from, to,
    recordInfo,
    raw: b,
    headers,
    query
  };
}

/** Ищем "запись" в произвольном payload: record_url/link/mp3/wav/id и т.п. */
function extractRecordInfo(obj) {
  const info = { urls: [], ids: [], hints: [] };
  const pushUrl = (u) => { if (u && /^https?:\/\//i.test(u)) info.urls.push(String(u)); };
  const pushId  = (x) => { if (x) info.ids.push(String(x)); };

  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    for (const [k, v] of Object.entries(cur)) {
      const key = k.toLowerCase();
      if (v && typeof v === "object") { stack.push(v); continue; }
      const val = String(v ?? "");

      // URL-кандидаты
      if (val.startsWith("http://") || val.startsWith("https://")) {
        // интересует всё, где встречается record/rec и/или аудиорасширения
        if (/\b(record|rec|recording|audio|file|link)\b/i.test(key) || /\.(mp3|wav|ogg)(\?|$)/i.test(val)) {
          pushUrl(val);
        }
      }

      // Поля с id записи
      if (/\b(record(_?id)?|rec_id|file_id)\b/i.test(key)) pushId(val);

      // Подсказки (например, "link", "url", без расширений)
      if ((/link|url|file/i.test(key)) && val) info.hints.push(`${k}: ${val}`);
    }
  }

  // Удалим дубли
  info.urls = Array.from(new Set(info.urls));
  info.ids  = Array.from(new Set(info.ids));
  info.hints = Array.from(new Set(info.hints));
  return info;
}

/** Готовим красивый текст для Telegram */
function formatTgMessage(normalized) {
  const { type, callId, direction, telnum, phone, ext, from, to, recordInfo, raw } = normalized;

  const typePretty = {
    RINGING: "📳 RINGING (звонит)",
    ACCEPTED: "✅ ACCEPTED (принят)",
    HANGUP: "⛔️ HANGUP (завершён)",
    MISSED: "❌ MISSED (пропущен)",
    RECORD: "🎙️ RECORD",
    RECORD_READY: "🎙️ RECORD_READY",
    FINISHED: "🏁 FINISHED"
  }[String(type).toUpperCase()] || `🔔 ${type}`;

  const lines = [
    "📞 <b>MegaPBX → Webhook</b>",
    `• Событие: <b>${typePretty}</b>`,
    `• CallID: <code>${callId}</code>`,
    `• Направление: <code>${direction}</code>`,
    `• От: <code>${from}</code> → Кому: <code>${to}</code>`,
    `• Наш номер (telnum): <code>${telnum}</code>`,
    `• Внутр. (ext): <code>${ext}</code>`
  ];

  // Добавим инфо о записи, если есть
  if (recordInfo.urls.length) {
    lines.push("", "🎧 <b>Запись:</b>");
    for (const u of recordInfo.urls.slice(0, 5)) lines.push(`• ${u}`);
  } else if (recordInfo.ids.length) {
    lines.push("", "🎧 <b>Идентификаторы записи:</b>");
    for (const id of recordInfo.ids.slice(0, 5)) lines.push(`• <code>${id}</code>`);
  } else if (recordInfo.hints.length) {
    lines.push("", "🎧 <b>Подсказки по записи:</b>");
    for (const h of recordInfo.hints.slice(0, 5)) lines.push(`• <code>${h}</code>`);
  }

  // Сырая нагрузка — последней строкой (укороченная)
  lines.push("", "<i>Raw:</i>", `<code>${safeStr(raw)}</code>`);

  return lines.join("\n");
}

/* -------------------- security -------------------- */
/** Проверяем общий ключ — берём из заголовков/квери/тела */
function getIncomingKey(req) {
  return (
    req.headers["x-api-key"] ||
    req.headers["x-crm-key"] ||
    req.headers["x-auth-token"] ||
    req.headers["authorization"] ||
    req.query?.key ||
    (typeof req.body === "object" ? req.body.crm_token : undefined)
  );
}

/* -------------------- routes -------------------- */

/** Health */
app.get("/", (_, res) => res.send("OK"));

/** Основной вебхук MegaPBX (им удобно слать на корень или /megafon) */
app.all(["/megafon", "/"], async (req, res, next) => {
  if (req.method === "GET") return next(); // GET на корень пусть обрабатывает ниже
  try {
    // Авторизация по общему ключу (если задан)
    const inKey = getIncomingKey(req);
    if (CRM_SHARED_KEY && inKey && String(inKey) !== String(CRM_SHARED_KEY)) {
      return res.status(401).send("bad key");
    }

    const normalized = normalizeMegafon(req.body, req.headers, req.query);
    const msg = formatTgMessage(normalized);
    await sendTG(msg);

    // Если вдруг запись найдена — можно дополнительно пометить OK
    const hasRecord = normalized.recordInfo.urls.length || normalized.recordInfo.ids.length;
    res.json({ ok: true, got: normalized.type, callId: normalized.callId, hasRecord: !!hasRecord });
  } catch (e) {
    try { await sendTG(`❗️ <b>Webhook error</b>:\n<code>${(e && e.message) || e}</code>`); } catch {}
    res.status(500).send("server error");
  }
});

/** Диагностика: показать, что сервер принимает и JSON, и форму */
app.post("/megafon/test", async (req, res) => {
  const normalized = normalizeMegafon(req.body, req.headers, req.query);
  const msg = formatTgMessage(normalized);
  await sendTG("🧪 <b>TEST post</b>\n\n" + msg);
  res.json({ ok: true, test: true });
});

/** Фоллбэк-логгер на все остальные пути (заголовки/квери/тело) */
app.all("*", async (req, res) => {
  try {
    const body = typeof req.body === "undefined" ? {} : req.body;
    const lines = [
      "📞 <b>MegaPBX → CRM webhook</b>",
      `• Method: <code>${req.method}</code>`,
      `• Path: <code>${req.path || req.url || "/"}</code>`,
      "",
      "<b>Headers</b>:\n<code>" + safeStr(req.headers) + "</code>",
      "",
      "<b>Query</b>:\n<code>" + safeStr(req.query || {}) + "</code>",
      "",
      "<b>Body</b>:\n<code>" + safeStr(body) + "</code>"
    ];
    await sendTG(lines.join("\n"));
    res.json({ ok: true, note: "fallback handler" });
  } catch (e) {
    try { await sendTG(`❗️ <b>Fallback error</b>:\n<code>${(e && e.message) || e}</code>`); } catch {}
    res.status(500).send("server error");
  }
});

/* -------------------- listen -------------------- */
app.listen(process.env.PORT || 3000, () => {
  console.log("listening on", process.env.PORT || 3000);
});
