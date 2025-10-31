// qa_assistant.js (v4.3-IRAZBIL) — JSON-only QA + duration-aware scoring & robust render
// Совместимо со схемой v4.1 (тот же JSON на выходе), улучшена логика total:
// - non-scoring: IVR-only и очень короткие (<15s) → "неоценочный"
// - "service_short" (15–60s) → мягкая шкала, без алертов
// - "sales" (≥60s) → взвешенная шкала (нормировка на 100), value/objections вносят вклад
// - "support" (≥60s) → value/objections не штрафуют (N/A), нормировка без них
// Рендер в TG показывает "неоценочный" вместо балла для соответствующих случаев.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const CALL_QA_MODEL  = process.env.CALL_QA_MODEL  || "gpt-4.1-mini";

const MAX_TXT = 16000;
const OPENAI_TIMEOUT_MS  = parseInt(process.env.CALL_QA_TIMEOUT_MS || "60000", 10);
const OPENAI_MAX_RETRIES = parseInt(process.env.CALL_QA_RETRIES    || "2", 10);

// --------- Public API ---------
export async function analyzeTranscript(transcript, meta = {}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");
  if (!transcript || !transcript.trim()) throw new Error("Empty transcript");

  const t = transcript.length > MAX_TXT ? (transcript.slice(0, MAX_TXT) + "\n[...cut...]") : transcript;

  // ----- System -----
  const system = `
Вы – AI-ассистент по оценке качества звонков компании iRazbil (продажа и ремонт устройств Apple).
Входные данные – транскрипт телефонного разговора (без указания говорящих).
Ваша задача – провести оценку звонка и выдать РОВНО один JSON по схеме.

Инструкции:
• Определите роли: manager (менеджер), customer (клиент), ivr (автоинформатор). Разбейте реплики и используйте их в «quotes».
• Определите intent: "sales" (продажа/консультация) или "support" (ремонт/поддержка). Не штрафуйте за неприменимые критерии.
• Оцените техники: greeting, rapport, needs, value, objection_handling, next_step, closing, clarity, compliance — в 0..10.
• Дайте психо-эмоциональный анализ, краткое summary и action_items (рекомендации).
• Строгий JSON: НИЧЕГО, кроме полей схемы. Температура 0.0.

Схема JSON:
{
  "intent": "sales|support",
  "score": {
    "greeting": 0..10,
    "rapport": 0..10,
    "needs": 0..10,
    "value": 0..10,
    "objection_handling": 0..10,
    "next_step": 0..10,
    "closing": 0..10,
    "clarity": 0..10,
    "compliance": 0..10,
    "total": 0..100
  },
  "psycho_emotional": {
    "customer_sentiment": "string",
    "manager_tone": "string",
    "manager_empathy": "string",
    "stress_level": "string"
  },
  "techniques": {
    "greeting": "done well|partially|missed|N/A|short text",
    "rapport":   "...",
    "needs":     "...",
    "value":     "...",
    "objection_handling": "...",
    "next_step": "...",
    "closing":   "...",
    "clarity":   "...",
    "compliance":"..."
  },
  "quotes": [
    { "speaker": "manager|customer|ivr", "quote": "..." },
    { "speaker": "customer", "quote": "..." }
  ],
  "summary": "string (3–5 предложений)",
  "action_items": ["...", "..."]
}

Edge-cases:
• Если разговора почти нет (почти один IVR или 1-2 короткие реплики) — выставляйте минимальные подоценки, но формат JSON сохраняйте.
• Если критерий неприменим — «N/A» в techniques и не снижайте total за него.
  `.trim();

  // ----- User -----
  const user = [
    meta.callId ? `CallID: ${meta.callId}` : null,
    meta.direction ? `direction: ${meta.direction}` : null,
    meta.from && meta.to ? `from: ${meta.from} -> to: ${meta.to}` : null,
    `brand: ${meta.brand || "iRazbil"}`,
    "",
    "Транскрипт (без указаных говорящих; требуется ролевая сегментация):",
    t
  ].filter(Boolean).join("\n");

  const payload = {
    model: CALL_QA_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.0,
    response_format: { type: "json_object" }
  };

  const data = await callOpenAIChatWithRetry(payload, OPENAI_MAX_RETRIES, OPENAI_TIMEOUT_MS);
  const txt = data?.choices?.[0]?.message?.content || "";
  const clean = String(txt).trim().replace(/^```json\s*|\s*```$/g, "");

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error("assistant returned non-JSON (schema violation)");
  }

  ensureSchemaShape(parsed);

  // ----- Duration-aware gating & weighted total -----
  const durSec = Number.isFinite(+meta.duration_sec) ? +meta.duration_sec : null;
  const gating = classifyCallType(transcript, durSec, parsed.intent, parsed.techniques);

  // нормализуем сабскор и считаем total по весам, учитывая gating
  normalizeSubscores(parsed);
  parsed.score.total = computeWeightedTotal(parsed, gating);

  sanitizeQuotes(parsed);
  return parsed;
}

export function formatQaForTelegram(qa) {
  const s = safe(qa);
  const sc = s.score || {};
  const pe = s.psycho_emotional || {};
  const tech = s.techniques || {};
  const quotes = Array.isArray(s.quotes) ? s.quotes.slice(0, 3) : [];

  const intentRu = toRuIntent(s.intent);
  const peCustomer = ruify(pe.customer_sentiment || "unknown");
  const peTone     = ruify(pe.manager_tone || "unknown");
  const peEmp      = ruify(pe.manager_empathy || "unknown");
  const peStress   = ruify(pe.stress_level || "unknown");

  // эвристика для "неоценочного" отображения (total могли оставить 0, но мы явно подписываемся)
  const nonScoringDisplay =
    isIvrDominated(quotes, s.summary) ||
    isNonScoringByHeuristics(sc, tech);

  const head = nonScoringDisplay
    ? `• Тип: <b>${esc(intentRu)}</b> · <i>неоценочный звонок</i>`
    : `• Тип: <b>${esc(intentRu)}</b> · Итоговый балл: <b>${num(sc.total)}</b>/100`;

  const lines = [
    "📊 <b>Аналитика звонка (iRazbil v4.3)</b>",
    head,
    "",
    "🧠 <b>Психо-эмоциональный фон</b>",
    `• Клиент: <i>${esc(peCustomer)}</i>`,
    `• Менеджер: <i>${esc(peTone)}</i> · Эмпатия: <i>${esc(peEmp)}</i> · Уровень стресса: <i>${esc(peStress)}</i>`,
    "",
    "🧩 <b>Техники (оценки 0–10)</b>",
    `• Приветствие: <code>${num(sc.greeting)}</code> · Раппорт: <code>${num(sc.rapport)}</code> · Потребности: <code>${num(sc.needs)}</code> · Ценность: <code>${num(sc.value)}</code>`,
    `• Возражения: <code>${num(sc.objection_handling)}</code> · Следующий шаг: <code>${num(sc.next_step)}</code> · Завершение: <code>${num(sc.closing)}</code>`,
    `• Ясность: <code>${num(sc.clarity)}</code> · Комплаенс: <code>${num(sc.compliance)}</code>`,
    "",
    "🧩 <b>Техники (статус)</b>",
    `• Приветствие: ${esc(ruify(tech.greeting || "-"))}`,
    `• Раппорт: ${esc(ruify(tech.rapport || "-"))}`,
    `• Потребности: ${esc(ruify(tech.needs || "-"))}`,
    `• Ценность: ${esc(ruify(tech.value || "-"))}`,
    `• Возражения: ${esc(ruify(tech.objection_handling || "-"))}`,
    `• Следующий шаг: ${esc(ruify(tech.next_step || "-"))}`,
    `• Завершение: ${esc(ruify(tech.closing || "-"))}`,
    `• Ясность: ${esc(ruify(tech.clarity || "-"))}`,
    `• Комплаенс: ${esc(ruify(tech.compliance || "-"))}`,
    "",
    quotes.length ? "💬 <b>Цитаты</b>" : null,
    ...quotes.map(q => `• <b>${roleRu(q.speaker || "?")}:</b> “${esc(q.quote || "")}”`),
    "",
    s.summary ? `📝 <b>Итог</b>: ${esc(s.summary)}` : null,
    Array.isArray(s.action_items) && s.action_items.length
      ? ["📌 <b>Действия</b>:", ...s.action_items.slice(0, 5).map(i => `• ${esc(i)}`)].join("\n")
      : null
  ].filter(Boolean);

  return lines.join("\n");
}

export function makeSpoilerTranscript(roleLabeledText, maxChars = 4000) {
  const body = String(roleLabeledText || "").slice(0, maxChars);
  return body ? `🗣️ <b>Расшифровка (сокращено)</b>\n||${esc(body)}||` : "";
}

// --------- Internal: OpenAI call with retry + timeout ---------
async function callOpenAIChatWithRetry(payload, retries, timeoutMs) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: ac.signal
      });
      clearTimeout(to);
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`assistant http ${r.status}: ${txt}`);
      }
      return await r.json();
    } catch (e) {
      clearTimeout(to);
      lastError = e;
      if (attempt < retries) {
        const backoff = 300 * Math.pow(2, attempt);
        await sleep(backoff);
      }
    }
  }
  throw lastError || new Error("OpenAI call failed");
}

// ---------------- utils & scoring core ----------------
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
function safe(x) { return (x && typeof x === "object") ? x : {}; }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function num(n) { return (typeof n === "number" && Number.isFinite(n)) ? n : "-"; }

function clamp10(n) {
  const v = Number.isFinite(+n) ? +n : 0;
  return Math.max(0, Math.min(10, v));
}

function ensureSchemaShape(obj) {
  obj.intent ??= "unknown";
  obj.score ??= {};
  const sc = obj.score;
  sc.greeting ??= 0;
  sc.rapport ??= 0;
  sc.needs ??= 0;
  sc.value ??= 0;
  sc.objection_handling ??= 0;
  sc.next_step ??= 0;
  sc.closing ??= 0;
  sc.clarity ??= 0;
  sc.compliance ??= 0;
  sc.total ??= 0;

  obj.psycho_emotional ??= {
    customer_sentiment: "unknown",
    manager_tone: "unknown",
    manager_empathy: "unknown",
    stress_level: "unknown"
  };
  obj.techniques ??= {
    greeting: "unknown",
    rapport: "unknown",
    needs: "unknown",
    value: "unknown",
    objection_handling: "unknown",
    next_step: "unknown",
    closing: "unknown",
    clarity: "unknown",
    compliance: "unknown"
  };
  if (!Array.isArray(obj.quotes)) obj.quotes = [];
  obj.summary ??= "unknown";
  if (!Array.isArray(obj.action_items)) obj.action_items = [];
}

function normalizeSubscores(obj) {
  const sc = obj.score || {};
  sc.greeting = clamp10(sc.greeting);
  sc.rapport  = clamp10(sc.rapport);
  sc.needs    = clamp10(sc.needs);
  sc.value    = clamp10(sc.value);
  sc.objection_handling = clamp10(sc.objection_handling);
  sc.next_step = clamp10(sc.next_step);
  sc.closing   = clamp10(sc.closing);
  sc.clarity   = clamp10(sc.clarity);
  sc.compliance= clamp10(sc.compliance);
}

function classifyCallType(transcript, durSec, intentRaw, tech) {
  const intent = String(intentRaw || "").toLowerCase();
  const dur = Number.isFinite(+durSec) ? +durSec : null;

  const ivrOnly = isIvrDominatedText(transcript);
  if (ivrOnly || (dur !== null && dur < 15)) return { kind: "na" }; // неоценочный

  if (dur !== null && dur < 60) {
    // короткий сервисный «инфозвонок»
    return { kind: "service_short" };
  }

  // полноценные
  if (intent === "sales")   return { kind: "sales" };
  if (intent === "support") return { kind: "support" };

  return { kind: "support" };
}

function computeWeightedTotal(obj, gating) {
  const sc = obj.score || {};
  const tech = obj.techniques || {};
  const kind = gating?.kind || "support";

  // non-scoring: показывать «неоценочный»; для совместимости вернём 0
  if (kind === "na") return 0;

  // Мягкая шкала для service_short: нормируем на «ожидаемое»
  if (kind === "service_short") {
    // учитываем главное: greeting, needs, clarity, compliance, next_step, closing слегка
    const weights = {
      greeting:  5,
      rapport:   5,
      needs:     25,
      value:     0,  // N/A
      objection_handling: 0, // N/A
      next_step: 25,
      closing:   10,
      clarity:   20,
      compliance:10,
    };
    const { total, max } = weightedSum(sc, weights);
    // мягкая шкала — верхний кап ~60
    const score = Math.round((total / max) * 60);
    return clamp100(score);
  }

  // Полные звонки
  if (kind === "sales") {
    // Веса для продаж (сумма 100)
    const weights = {
      greeting:  3,
      rapport:   10,
      needs:     25,
      value:     20,
      objection_handling: 15,
      next_step: 20,
      closing:   5,
      clarity:   2,
      compliance:0
    };
    const { total, max } = weightedSum(sc, weights);
    return clamp100(Math.round((total / max) * 100));
  }

  // support (полный): value/objections не штрафуют (если реально N/A)
  const valueNA = isNA(tech.value);
  const objNA   = isNA(tech.objection_handling);

  const weightsSupportBase = {
    greeting:  4,
    rapport:   10,
    needs:     30,
    value:     valueNA ? 0 : 10,
    objection_handling: objNA ? 0 : 10,
    next_step: 20,
    closing:   8,
    clarity:   6,
    compliance:12
  };
  const { total, max } = weightedSum(sc, weightsSupportBase);
  return clamp100(Math.round((total / max) * 100));
}

function weightedSum(sc, weights) {
  let total = 0, max = 0;
  for (const [k, w] of Object.entries(weights)) {
    const ww = Number.isFinite(+w) ? +w : 0;
    if (ww <= 0) continue;
    total += (clamp10(sc[k]) / 10) * ww;
    max   += ww;
  }
  return { total, max: Math.max(1, max) };
}

function clamp100(n) { return Math.max(0, Math.min(100, Number.isFinite(+n) ? +n : 0)); }

function isNA(text) {
  const s = String(text || "").toLowerCase();
  return s.includes("n/a") || s.includes("не применимо") || s.includes("na");
}

function sanitizeQuotes(obj) {
  if (!Array.isArray(obj.quotes)) { obj.quotes = []; return; }
  const mapRole = (r) => {
    const s = String(r || "").toLowerCase();
    if (s.includes("manager") || s.includes("менедж")) return "manager";
    if (s.includes("customer") || s.includes("client") || s.includes("клиент")) return "customer";
    if (s.includes("ivr") || s.includes("auto") || s.includes("авто")) return "ivr";
    return "customer";
  };
  obj.quotes = obj.quotes
    .map(q => ({ speaker: mapRole(q?.speaker), quote: String(q?.quote || "").trim() }))
    .filter(q => q.quote.length > 0)
    .slice(0, 5);
}

// --------- IVR / non-scoring helpers ----------
function isIvrDominatedText(transcript) {
  const s = String(transcript || "").toLowerCase();
  // частые фрагменты IVR/звонка
  const ivrHints = [
    "нажмите 1", "нажмите один", "нажмите 2", "нажмите два",
    "оставайтесь на линии", "вам ответит первый освободившийся сотрудник",
    "звонит телефон", "ivr:", "автоинформатор"
  ];
  let hits = 0;
  for (const h of ivrHints) if (s.includes(h)) hits++;
  // если почти весь текст — это IVR/«звонит телефон», считаем non-scoring
  return hits >= 2 && s.replace(/ivr:|звонит телефон|[^\w]+/g, "").length < 800;
}

function isIvrDominated(quotes, summary) {
  const qs = (quotes || []).map(q => (q.speaker||"") + ":" + (q.quote||"")).join("\n").toLowerCase();
  const sum = String(summary||"").toLowerCase();
  return /ivr|автоинформатор/.test(qs) && /ivr|автоинформатор/.test(sum);
}

function isNonScoringByHeuristics(sc, tech) {
  // крайне низкие все показатели + value/objections N/A → вероятно, короткий/формальный звонок
  const vals = [
    sc.greeting, sc.rapport, sc.needs, sc.next_step,
    sc.closing, sc.clarity, sc.compliance
  ].map(v => Number.isFinite(+v) ? +v : 0);
  const veryLow = vals.filter(v => v <= 3).length >= 6;
  return veryLow;
}

// -------------- локализация/русификатор --------------
function toRuIntent(intent) {
  const s = String(intent || "").toLowerCase();
  if (s === "sales") return "продажа";
  if (s === "support") return "поддержка/ремонт";
  if (s === "ivr") return "IVR/меню";
  if (s === "noise") return "шум/неразборчиво";
  return s || "unknown";
}
function roleRu(speaker) {
  const s = String(speaker || "").toLowerCase();
  if (s.includes("manager")) return "менеджер";
  if (s.includes("customer")) return "клиент";
  if (s.includes("ivr")) return "автоинформатор";
  return "говорящий";
}
function ruify(text) {
  const s = String(text || "").trim();
  const map = [
    [/^done\s*well$/i, "хорошо выполнено"],
    [/^partially$/i, "частично выполнено"],
    [/^missed$/i, "пропущено"],
    [/^n\/?a$/i, "не применимо"],
    [/^polite$/i, "вежливый"],
    [/^calm$/i, "спокойный"],
    [/^professional$/i, "профессиональный"],
    [/^impatient/i, "нетерпеливый"],
    [/^frustrat/i, "раздражение/фрустрация"],
    [/^neutral$/i, "нейтральный"],
    [/^negative$/i, "негативный"],
    [/^positive$/i, "позитивный"],
    [/^low$/i, "низкий"],
    [/^moderate$/i, "умеренный"],
    [/^high$/i, "высокий"],
  ];
  for (const [re, rep] of map) if (re.test(s)) return rep;
  const lower = s.toLowerCase();
  if (lower.includes("impatient") && lower.includes("polite")) return "нетерпеливый, но вежливый";
  if (lower.includes("calm") && lower.includes("professional")) return "спокойный, профессиональный";
  return s;
}
