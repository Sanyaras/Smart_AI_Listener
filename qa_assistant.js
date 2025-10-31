// qa_assistant.js (v4.1-IRAZBIL) — JSON-only QA per iRazbil rubric
// - Строгий фиксированный JSON (roles + anchors + consistency rules)
// - Детерминизм (temperature=0)
// - Ретраи запроса к OpenAI с таймаутом
// - Нормализация баллов (0..10) и корректный total (учёт intent и N/A для value)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const CALL_QA_MODEL  = process.env.CALL_QA_MODEL  || "gpt-4.1-mini"; // можно переопределить через ENV

const MAX_TXT = 16000;
const OPENAI_TIMEOUT_MS = parseInt(process.env.CALL_QA_TIMEOUT_MS || "60000", 10);
const OPENAI_MAX_RETRIES = parseInt(process.env.CALL_QA_RETRIES || "2", 10);

/**
 * Анализ транскрипта по фиксированной JSON-схеме.
 * Возвращает объект строго по структуре:
 * {
 *   intent, score{...}, psycho_emotional{...}, techniques{...},
 *   quotes:[{speaker,quote},...], summary, action_items:[...]
 * }
 */
export async function analyzeTranscript(transcript, meta = {}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");
  if (!transcript || !transcript.trim()) throw new Error("Empty transcript");

  const t = transcript.length > MAX_TXT ? (transcript.slice(0, MAX_TXT) + "\n[...cut...]") : transcript;

  // ---------------- System ----------------
  const system = `
Вы – AI-ассистент по оценке качества звонков компании iRazbil (продажа и ремонт устройств).
Входные данные – транскрипт телефонного разговора (без указания говорящих).
Ваша задача – провести полную оценку звонка с разбиением ролей и выводом результатов строго в формате JSON.

Инструкции для оценки:
• Определите роли собеседников: manager (менеджер компании), customer (клиент) и ivr (автоинформатор). Разбейте транскрипт на реплики с указанием роли каждого говорящего.
• Определите намерение звонка (intent): "sales" (покупка/продажа устройства) или "support" (ремонт/поддержка устройства). Учитывайте это при оценке: не снижайте оценку за критерии, не относящиеся к данному intent (если критерий неприменим, он не должен уменьшать итоговый балл).
• Оцените работу менеджера по ключевым техникам разговора: greeting, rapport, needs, value, objection_handling, next_step, closing, clarity, compliance. Для каждого параметра присвойте числовую оценку и краткий анализ (см. схему).
• Проведите психоэмоциональный анализ разговора: эмоциональное состояние клиента и менеджера, уровень стресса/спокойствия, вежливость, эмпатия менеджера и т.д.
• Выделите ключевые цитаты (2–5 фраз) с ролью говорящего.
• Составьте краткое резюме звонка.
• Сформируйте список рекомендаций/action items.

Формат вывода: один JSON-объект со следующими полями И ТОЛЬКО ИМИ:

{
  "intent": "...",            // "sales" или "support"
  "score": {
    "greeting": <number>,
    "rapport": <number>,
    "needs": <number>,
    "value": <number>,
    "objection_handling": <number>,
    "next_step": <number>,
    "closing": <number>,
    "clarity": <number>,
    "compliance": <number>,
    "total": <number>
  },
  "psycho_emotional": {
    "customer_sentiment": "...",
    "manager_tone": "...",
    "manager_empathy": "...",
    "stress_level": "..."
  },
  "techniques": {
    "greeting": "...",
    "rapport": "...",
    "needs": "...",
    "value": "...",
    "objection_handling": "...",
    "next_step": "...",
    "closing": "...",
    "clarity": "...",
    "compliance": "..."
  },
  "quotes": [
    { "speaker": "manager", "quote": "..." },
    { "speaker": "customer", "quote": "..." }
  ],
  "summary": "...",
  "action_items": [ "...", "..." ]
}

Особые требования:
• Строго следуйте схеме JSON. НИКАКОГО текста вне JSON.
• Формат и поля фиксированы — без добавления или удаления ключей.
• Если данных нет, ставьте "unknown" или null (соблюдая тип).
• Температура модели: 0.0 (детерминированность).
• Убедитесь, что total согласован с подоценками (например, сумма/нормализация). Не наказывайте за неприменимые критерии (value для support и т.п.) — используйте N/A или нейтральный вклад.

2) JSON Schema — ключи и типы:
- intent (string): "sales" или "support".
- score (object): greeting, rapport, needs, value, objection_handling, next_step, closing, clarity, compliance — числа (например, 0–10). total — согласованный суммарный балл.
- psycho_emotional (object): customer_sentiment, manager_tone, manager_empathy, stress_level — строки.
- techniques (object): значения-строки с короткой оценкой выполнения ("done well", "partially", "missed", "N/A" или короткое описание).
- quotes: массив объектов {speaker, quote}, где speaker ∈ {"manager","customer","ivr"}.
- summary: строка (3–5 предложений).
- action_items: массив строк с конкретными рекомендациями.

3) Scoring Calibration — Anchor Examples (слабый / средний / сильный)
Anchor 1 – Слабый звонок (низкое качество)
Customer: "Алло…" (тихо)
Manager: "... (молчание) ... Алло."
Customer: "(раздражённо) Алло, вы меня слышите?"
Manager: "Да. Что вам?"
Customer: "У меня проблема с телефоном после обновления…"
Manager: "Это не ко мне. Следующий!" (бросает трубку)
— Оценки ориентир: greeting 0, rapport 0, needs 1, value 0, objection_handling 0, next_step 0, closing 0, clarity 1, compliance 0; total ~5/100.

Anchor 2 – Средний звонок (удовлетворительно)
Customer: "Здравствуйте, у меня сломался смартфон, он на гарантии…"
Manager: "Добрый день. Вы по поводу ремонта, верно? Какой у вас телефон?"
Customer: "iPhone X, после обновления перестал включаться."
Manager: "Понимаю. Принесите устройство в сервис — проверим бесплатно."
— Ориентир: greeting 3, rapport 3, needs 4, value 3, objection_handling N/A/5, next_step 5, closing 4, clarity 5, compliance 5; total ~80/100.

Anchor 3 – Сильный звонок (высокое качество, sales)
Customer: "Хочу узнать насчёт покупки нового телефона..."
Manager: "Добрый день! Спасибо за звонок в iRazbil, меня зовут Олег..."
… (уточнения, ценность, работа с возражениями, следующий шаг, завершение)
— Ориентир: всё по 5 (из 5), total 100/100.

4) Consistency Rules:
- Строгий фиксированный формат JSON.
- Температура 0.0 — без дрейфа.
- Опираться на якоря при выставлении баллов.
- Фиксированные веса: суммируйте подоценки по простой явной формуле. Для N/A не штрафуйте.
- Сначала ролевой разбор (manager/customer/ivr), затем оценка техник.
- Единообразие толкований (что считается greeting и т.п.).
- Никаких побочных рассуждений во внешнем ответе.

5) Улучшения/указания:
- Контекст компании iRazbil (сервис Apple, sales и ремонт).
- Русский + англ. термины допустимы (не снижать clarity за понятные англ. слова).
- Не придумывать фактов — если нет прощания, не писать, что было.
- Для нетипичных/пустых/шумовых случаев — вернуть валидный JSON с "unknown"/0 и понятным summary.

6) Edge Cases:
- Пустой/обрывочный текст → intent "support" по умолчанию, все оценки 0, summary объясняет нехватку данных, action_items: ["Повторить звонок"].
- Только IVR → оценки техник менеджера 0/N/A, summary отражает отсутствие оператора.
- Агрессия/нецензурная лексика → в psycho_emotional; compliance/rapport падают, если нарушает менеджер.
- Другая тематика → intent "support" как ближайшее, с соответствующим summary.
- Очень длинный диалог → цитаты 2–5 ключевых, без лишней длины.

Ответ ТОЛЬКО в формате JSON по заданной схеме. Любой текст вне JSON считается ошибкой.`.trim();

  // ---------------- User ----------------
  const exampleUserIntro = `
User: Пример:

Здравствуйте, вы позвонили в компанию iRazbil. Пожалуйста, ожидайте ответа оператора...
Алло, у меня телефон сломался после обновления. Что делать?
Добрый день! Менеджер iRazbil, чем могу помочь?
... (транскрипт разговора) ...
`.trim();

  const user = [
    meta.callId ? `CallID: ${meta.callId}` : null,
    meta.direction ? `direction: ${meta.direction}` : null,
    meta.from && meta.to ? `from: ${meta.from} -> to: ${meta.to}` : null,
    meta.brand ? `brand: ${meta.brand}` : "brand: iRazbil",
    "",
    exampleUserIntro,
    "",
    "Транскрипт (без указания говорящих, требуется ролевая сегментация):",
    t
  ].filter(Boolean).join("\n");

  // ---------------- OpenAI call (retry + timeout) ----------------
  const payload = {
    model: CALL_QA_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.0, // важно: детерминированность
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

  // Базовая валидация и нормализация (включая корректный total)
  ensureSchemaShape(parsed);
  normalizeScoresAndTotal(parsed);

  // Санитизация цитат, чтобы speaker ∈ {"manager","customer","ivr"}
  sanitizeQuotes(parsed);

  return parsed;
}

/**
 * Телеграм-рендер под новую схему.
 * Ничего лишнего, только компактная сводка для оперативного контроля.
 */
export function formatQaForTelegram(qa) {
  const s = safe(qa);
  const sc = s.score || {};
  const pe = s.psycho_emotional || {};
  const tech = s.techniques || {};
  const quotes = Array.isArray(s.quotes) ? s.quotes.slice(0, 3) : [];

  const lines = [
    "📊 <b>Аналитика звонка (iRazbil v4.1)</b>",
    `• Intent: <b>${esc(s.intent || "-")}</b> · Total: <b>${num(sc.total)}</b>`,
    "",
    "🧠 <b>Психо-эмоциональный фон</b>",
    `• Клиент: <i>${esc(pe.customer_sentiment || "unknown")}</i>`,
    `• Менеджер: <i>${esc(pe.manager_tone || "unknown")}</i> · Эмпатия: <i>${esc(pe.manager_empathy || "unknown")}</i> · Стресс: <i>${esc(pe.stress_level || "unknown")}</i>`,
    "",
    "🧩 <b>Техники (оценки)</b>",
    `• Greeting: <code>${num(sc.greeting)}</code> · Rapport: <code>${num(sc.rapport)}</code> · Needs: <code>${num(sc.needs)}</code> · Value: <code>${num(sc.value)}</code>`,
    `• Obj: <code>${num(sc.objection_handling)}</code> · Next: <code>${num(sc.next_step)}</code> · Closing: <code>${num(sc.closing)}</code>`,
    `• Clarity: <code>${num(sc.clarity)}</code> · Compliance: <code>${num(sc.compliance)}</code>`,
    "",
    "🧩 <b>Техники (статус)</b>",
    `• greeting: ${esc(tech.greeting || "-")}`,
    `• needs: ${esc(tech.needs || "-")}`,
    `• value: ${esc(tech.value || "-")}`,
    `• objections: ${esc(tech.objection_handling || "-")}`,
    `• next_step: ${esc(tech.next_step || "-")}`,
    `• closing: ${esc(tech.closing || "-")}`,
    `• clarity: ${esc(tech.clarity || "-")}`,
    `• compliance: ${esc(tech.compliance || "-")}`,
    "",
    quotes.length ? "💬 <b>Цитаты</b>" : null,
    ...quotes.map(q => `• <b>${esc(q.speaker || "?")}:</b> “${esc(q.quote || "")}”`),
    "",
    s.summary ? `📝 <b>Итог</b>: ${esc(s.summary)}` : null,
    Array.isArray(s.action_items) && s.action_items.length
      ? ["📌 <b>Действия</b>:", ...s.action_items.slice(0, 5).map(i => `• ${esc(i)}`)].join("\n")
      : null
  ].filter(Boolean);

  return lines.join("\n");
}

/**
 * Необязательный вспомогательный вывод компактного транскрипта
 * (если ты уже разметил роли отдельно где-то ещё).
 */
export function makeSpoilerTranscript(roleLabeledText, maxChars = 4000) {
  const body = String(roleLabeledText || "").slice(0, maxChars);
  return body ? `🗣️ <b>Расшифровка (сокращено)</b>\n||${esc(body)}||` : "";
}

// ---------------- Internal: OpenAI call with retry + timeout ----------------
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
      // небольшой экспоненциальный бэкоф
      if (attempt < retries) {
        const backoff = 300 * Math.pow(2, attempt);
        await sleep(backoff);
      }
    }
  }
  throw lastError || new Error("OpenAI call failed");
}

// ---------------- utils ----------------
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
function safe(x) { return (x && typeof x === "object") ? x : {}; }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function num(n) { return (typeof n === "number" && Number.isFinite(n)) ? n : "-"; }

function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function clamp10(n) {
  const v = Number.isFinite(+n) ? +n : 0;
  return Math.max(0, Math.min(10, v));
}

/**
 * Мягкая проверка структуры результата (не ломаем ран).
 * Если чего-то не хватает — добиваем дефолтами, чтобы Telegram-рендер не падал.
 */
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

/**
 * Нормализация числовых баллов (0..10), корректный total:
 * - Если intent="support" ИЛИ techniques.value содержит "N/A"/"не применимо", метрика value исключается из знаменателя.
 * - Total = (сумма применимых метрик / (10 * кол-во применимых)) * 100, округление до целого.
 */
function normalizeScoresAndTotal(obj) {
  const sc = obj.score || {};
  const tech = obj.techniques || {};
  const intent = String(obj.intent || "").toLowerCase();

  sc.greeting = clamp10(sc.greeting);
  sc.rapport  = clamp10(sc.rapport);
  sc.needs    = clamp10(sc.needs);
  sc.value    = clamp10(sc.value);
  sc.objection_handling = clamp10(sc.objection_handling);
  sc.next_step = clamp10(sc.next_step);
  sc.closing   = clamp10(sc.closing);
  sc.clarity   = clamp10(sc.clarity);
  sc.compliance = clamp10(sc.compliance);

  // определяем применимость value
  const valueText = (tech.value || "").toLowerCase();
  const valueNA = intent === "support" || valueText.includes("n/a") || valueText.includes("не применимо");

  const metrics = [
    ["greeting", sc.greeting],
    ["rapport", sc.rapport],
    ["needs", sc.needs],
    // value — условно включаем
    ["value", sc.value, valueNA],
    ["objection_handling", sc.objection_handling],
    ["next_step", sc.next_step],
    ["closing", sc.closing],
    ["clarity", sc.clarity],
    ["compliance", sc.compliance],
  ];

  let sum = 0;
  let denom = 0;
  for (const [name, val, na] of metrics) {
    if (name === "value" && na) continue;
    sum += clamp10(val);
    denom += 10;
  }
  const total = denom > 0 ? Math.round((sum / denom) * 100) : 0;
  sc.total = Math.max(0, Math.min(100, total));
}

/**
 * Санитизация цитат: speaker ∈ {"manager","customer","ivr"}, quote — строка
 */
function sanitizeQuotes(obj) {
  if (!Array.isArray(obj.quotes)) { obj.quotes = []; return; }
  const mapRole = (r) => {
    const s = String(r || "").toLowerCase();
    if (s.includes("manager")) return "manager";
    if (s.includes("customer") || s.includes("client")) return "customer";
    if (s.includes("ivr") || s.includes("auto")) return "ivr";
    return "customer"; // безопасный фолбэк
  };
  obj.quotes = obj.quotes
    .map(q => ({ speaker: mapRole(q?.speaker), quote: String(q?.quote || "").trim() }))
    .filter(q => q.quote.length > 0)
    .slice(0, 5);
}
