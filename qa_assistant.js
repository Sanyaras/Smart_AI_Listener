// qa_assistant.js (v4.3-IRAZBIL-ru, refreshed)
// — Строгий JSON по фиксированной схеме (intent/score/psycho_emotional/techniques/quotes/summary/action_items)
// — Детерминизм: temperature=0, response_format=json_object
// — Ретраи + таймаут на вызов OpenAI
// — Нормализация 0..10 и корректный total (не штрафуем за N/A/не применимо по intent)
// — Русский рендер для Telegram (formatQaForTelegram) + компактный спойлер транскрипта
// — Адаптер runQAOnTranscript(asr) для queue_worker.js

import { sendTG } from "./telegram.js";

// -------- ENV --------
const OPENAI_API_KEY     = process.env.OPENAI_API_KEY || "";
const CALL_QA_MODEL      = process.env.CALL_QA_MODEL  || "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS  = parseInt(process.env.CALL_QA_TIMEOUT_MS || "60000", 10);
const OPENAI_MAX_RETRIES = parseInt(process.env.CALL_QA_RETRIES    || "2", 10);

// Ограничение длины входящего текста (защита от сверхдлинных транскриптов)
const MAX_TXT = 16000;

/**
 * Главная функция анализа: возвращает строго структурированный JSON-объект:
 * {
 *   intent: "sales"|"support",
 *   score: { greeting, rapport, needs, value, objection_handling, next_step, closing, clarity, compliance, total },
 *   psycho_emotional: { customer_sentiment, manager_tone, manager_empathy, stress_level },
 *   techniques: { greeting, rapport, needs, value, objection_handling, next_step, closing, clarity, compliance },
 *   quotes: [{ speaker: "manager"|"customer"|"ivr", quote: string }, ...],
 *   summary: string,
 *   action_items: string[]
 * }
 */
export async function analyzeTranscript(transcript, meta = {}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");
  if (!transcript || !transcript.trim()) throw new Error("Empty transcript");

  const t = transcript.length > MAX_TXT
    ? (transcript.slice(0, MAX_TXT) + "\n[...cut...]")
    : transcript;

  // ---------- System prompt ----------
  const system = `
Вы – AI-ассистент по оценке качества звонков компании iRazbil (продажа и ремонт устройств).
Вход: транскрипт телефонного разговора БЕЗ указания говорящих.
Задача: провести полную оценку звонка с разметкой ролей и выдать результат СТРОГО в формате JSON.

Инструкции:
• Определите роли: manager (менеджер), customer (клиент), ivr (автоинформатор). Разделите речь по ролям.
• Определите намерение звонка (intent): "sales" (покупка/продажа) или "support" (ремонт/поддержка).
• Оцените техники (0..10): greeting, rapport, needs, value, objection_handling, next_step, closing, clarity, compliance.
• Психоэмоциональный анализ: тон клиента и менеджера, эмпатия, уровень стресса.
• 2–5 цитат: speaker + quote.
• Краткое summary (3–5 предложений).
• Список action_items (рекомендации).

ВАЖНО:
• Ответ ТОЛЬКО один JSON-объект без текста вокруг.
• Форма и ключи фиксированы (см. схему). Не добавлять/удалять поля.
• Если данных нет — используйте "unknown" или null (сохраняя тип).
• Температура = 0.0 (детерминизм).
• Итоговый total = 0..100. НЕ ШТРАФУЙТЕ за неприменимые критерии (например, "value" для чистого support): помечайте такие как "N/A"/"не применимо" в techniques и не учитывайте в total.

Схема:
{
  "intent": "sales"|"support",
  "score": {
    "greeting": number, "rapport": number, "needs": number, "value": number,
    "objection_handling": number, "next_step": number, "closing": number,
    "clarity": number, "compliance": number, "total": number
  },
  "psycho_emotional": {
    "customer_sentiment": string, "manager_tone": string,
    "manager_empathy": string, "stress_level": string
  },
  "techniques": {
    "greeting": string, "rapport": string, "needs": string, "value": string,
    "objection_handling": string, "next_step": string, "closing": string,
    "clarity": string, "compliance": string
  },
  "quotes": [{ "speaker": "manager"|"customer"|"ivr", "quote": string }],
  "summary": string,
  "action_items": [string]
}

Anchors (калибровка):
- Слабый: greeting 0, rapport 0, needs 1, value 0, objections 0, next 0, closing 0, clarity 1, compliance 0; total ~5/100.
- Средний (support): greeting 3, rapport 3, needs 4, value N/A, objections N/A/5, next 5, closing 4, clarity 5, compliance 5; total ~80/100.
- Сильный (sales): почти всё ~5/5 → total ~100/100.

Edge cases:
- Пусто/только IVR → intent "support", все 0, цитаты пустые, summary поясняет нехватку данных, action_items: ["Перезвонить клиенту"].
- Агрессия/брань — отразить в psycho_emotional.
`.trim();

  // ---------- User prompt ----------
  const exampleUserIntro = `
Пример начала разговора:

Здравствуйте, вы позвонили в компанию iRazbil. Пожалуйста, ожидайте ответа оператора...
Алло, у меня телефон сломался после обновления. Что делать?
Добрый день! Менеджер iRazbil, чем могу помочь?
... (далее идёт диалог) ...
`.trim();

  const user = [
    meta.callId ? `CallID: ${meta.callId}` : null,
    meta.direction ? `direction: ${meta.direction}` : null,
    meta.from && meta.to ? `from: ${meta.from} -> to: ${meta.to}` : null,
    meta.brand ? `brand: ${meta.brand}` : "brand: iRazbil",
    "",
    exampleUserIntro,
    "",
    "Транскрипт (без ролей, требуется разметка):",
    t
  ].filter(Boolean).join("\n");

  // ---------- OpenAI call ----------
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
  const txt  = data?.choices?.[0]?.message?.content || "";
  const clean = String(txt).trim().replace(/^```json\s*|\s*```$/g, "");

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch {
    throw new Error("assistant returned non-JSON (schema violation)");
  }

  ensureSchemaShape(parsed);
  normalizeScoresAndTotal(parsed);
  sanitizeQuotes(parsed);

  return parsed;
}

/* =================== Telegram render =================== */
export function formatQaForTelegram(qa) {
  const s   = safe(qa);
  const sc  = s.score || {};
  const pe  = s.psycho_emotional || {};
  const tch = s.techniques || {};
  const qts = Array.isArray(s.quotes) ? s.quotes.slice(0, 3) : [];

  const lines = [
    "📊 <b>Аналитика звонка (iRazbil)</b>",
    `• Тип: <b>${esc(toRuIntent(s.intent))}</b> · Итоговый балл: <b>${num(sc.total)}</b>/100`,
    "",
    "🧠 <b>Психо-эмоциональный фон</b>",
    `• Клиент: <i>${esc(ruify(pe.customer_sentiment || "unknown"))}</i>`,
    `• Менеджер: <i>${esc(ruify(pe.manager_tone || "unknown"))}</i> · Эмпатия: <i>${esc(ruify(pe.manager_empathy || "unknown"))}</i> · Стресс: <i>${esc(ruify(pe.stress_level || "unknown"))}</i>`,
    "",
    "🧩 <b>Техники (0–10)</b>",
    `• Приветствие: <code>${num(sc.greeting)}</code> · Раппорт: <code>${num(sc.rapport)}</code> · Потребности: <code>${num(sc.needs)}</code> · Ценность: <code>${num(sc.value)}</code>`,
    `• Возражения: <code>${num(sc.objection_handling)}</code> · Следующий шаг: <code>${num(sc.next_step)}</code> · Завершение: <code>${num(sc.closing)}</code>`,
    `• Ясность: <code>${num(sc.clarity)}</code> · Комплаенс: <code>${num(sc.compliance)}</code>`,
    "",
    qts.length ? "💬 <b>Цитаты</b>" : null,
    ...qts.map(q => `• <b>${roleRu(q.speaker)}:</b> “${esc(q.quote)}”`),
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

/* =================== Adapter for queue_worker =================== */
/**
 * Универсальный адаптер под текущий пайплайн:
 * вход: { text, sourceUrl?, amoNoteKey? }
 * выход: { score, issues[], summary, raw }
 */
export async function runQAOnTranscript(asr) {
  try {
    const txt  = asr?.text || "";
    const meta = {
      callId:    asr?.amoNoteKey || undefined,
      sourceUrl: asr?.sourceUrl  || undefined
    };

    const raw = await analyzeTranscript(txt, meta);
    const total  = Number(raw?.score?.total ?? 0);
    const issues = Array.isArray(raw?.action_items) ? raw.action_items.slice(0, 6) : [];

    return { score: total, issues, summary: String(raw?.summary || ""), raw };
  } catch (e) {
    // Не падаем пайплайном — мягко логируем в TG и возвращаем stub
    try { await sendTG(`⚠️ QA ошибка: <code>${esc(String(e))}</code>`); } catch {}
    return { score: 0, issues: ["Ошибка оценки"], summary: String(e), raw: null };
  }
}

/* =================== OpenAI: retry + timeout =================== */
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
      if (attempt < retries) await sleep(300 * Math.pow(2, attempt));
    }
  }
  throw lastError || new Error("OpenAI call failed");
}

/* =================== Utils / schema helpers =================== */
function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }
function safe(x){ return (x && typeof x === "object") ? x : {}; }
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function num(n){ return (typeof n === "number" && Number.isFinite(n)) ? n : "-"; }
function clamp10(n){ const v = Number.isFinite(+n) ? +n : 0; return Math.max(0, Math.min(10, v)); }

function ensureSchemaShape(obj){
  obj.intent ??= "unknown";
  obj.score ??= {};
  const sc = obj.score;
  for (const k of ["greeting","rapport","needs","value","objection_handling","next_step","closing","clarity","compliance","total"]) sc[k] ??= 0;

  obj.psycho_emotional ??= {
    customer_sentiment: "unknown",
    manager_tone: "unknown",
    manager_empathy: "unknown",
    stress_level: "unknown"
  };
  obj.techniques ??= {
    greeting: "unknown", rapport: "unknown", needs: "unknown", value: "unknown",
    objection_handling: "unknown", next_step: "unknown", closing: "unknown",
    clarity: "unknown", compliance: "unknown"
  };
  if (!Array.isArray(obj.quotes)) obj.quotes = [];
  obj.summary ??= "unknown";
  if (!Array.isArray(obj.action_items)) obj.action_items = [];
}

/**
 * Корректный total:
 * — Клампим все саб-оценки к 0..10.
 * — Если intent="support" ИЛИ techniques.value содержит "N/A"/"не применимо",
 *   метрику "value" исключаем из знаменателя (не штрафуем).
 */
function normalizeScoresAndTotal(obj){
  const sc   = obj.score || {};
  const tech = obj.techniques || {};
  const intent = String(obj.intent || "").toLowerCase();

  for (const k of ["greeting","rapport","needs","value","objection_handling","next_step","closing","clarity","compliance"]) {
    sc[k] = clamp10(sc[k]);
  }

  const valueText = (tech.value || "").toLowerCase();
  const valueNA   = intent === "support" || valueText.includes("n/a") || valueText.includes("не применимо");

  const metrics = [
    ["greeting", sc.greeting],
    ["rapport", sc.rapport],
    ["needs", sc.needs],
    ["value", sc.value, valueNA],  // условно учитываем
    ["objection_handling", sc.objection_handling],
    ["next_step", sc.next_step],
    ["closing", sc.closing],
    ["clarity", sc.clarity],
    ["compliance", sc.compliance],
  ];

  let sum = 0, denom = 0;
  for (const [name, val, na] of metrics) {
    if (name === "value" && na) continue;
    sum += clamp10(val);
    denom += 10;
  }

  sc.total = denom > 0 ? Math.round((sum / denom) * 100) : 0;
}

/** Приводим цитаты к безопасной форме */
function sanitizeQuotes(obj){
  if (!Array.isArray(obj.quotes)) { obj.quotes = []; return; }
  const mapRole = (r) => {
    const s = String(r || "").toLowerCase();
    if (s.includes("manager") || s.includes("менедж")) return "manager";
    if (s.includes("customer") || s.includes("client") || s.includes("клиент")) return "customer";
    if (s.includes("ivr") || s.includes("авто")) return "ivr";
    return "customer";
  };
  obj.quotes = obj.quotes
    .map(q => ({ speaker: mapRole(q?.speaker), quote: String(q?.quote || "").trim() }))
    .filter(q => q.quote.length > 0)
    .slice(0, 5);
}

function toRuIntent(intent){
  const s = String(intent || "").toLowerCase();
  if (s === "sales")   return "продажа";
  if (s === "support") return "поддержка/ремонт";
  if (s === "ivr")     return "IVR/меню";
  return s || "unknown";
}

function roleRu(speaker){
  const s = String(speaker || "").toLowerCase();
  if (s.includes("manager"))  return "менеджер";
  if (s.includes("customer")) return "клиент";
  if (s.includes("ivr"))      return "автоинформатор";
  return "говорящий";
}

/** Простая локализация коротких англ. ярлыков */
function ruify(text){
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
  return s;
}
