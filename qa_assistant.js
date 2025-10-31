// qa_assistant.js — QA-анализ звонков + форматтер для Telegram
// v4.2-IRAZBIL (non-evaluable calls policy + pipeline passport)
// Задача:
//  • Анализ транскрипта с помощью OpenAI (или offline fallback)
//  • Нормализация итоговой структуры под amo.js / index.js
//  • "Короткие/инфо/не по адресу" — не штрафуем (score_total = null, suppress_alert = true)
//  • Паспорт пайплайна: модель/версии/хэш конфига (для трассировки)

// ──────────────────────────────────────────────────────────────────────────────
// Конфиг рубрики/алертов (меняешь здесь — хэш конфига изменится)
const CALL_QA_MODEL         = process.env.CALL_QA_MODEL || "gpt-4o-mini";
const QA_RUBRIC_VERSION     = process.env.QA_RUBRIC_VERSION || "irazbil-rubric@4.2";
const ALERT_RULES_VERSION   = process.env.ALERT_RULES_VERSION || "alerts@1.1.0";

// Пороги/категоризация
const SHORT_CALL_SEC        = parseInt(process.env.QA_SHORT_CALL_SEC || "25", 10);
const NON_EVALUABLE_INTENTS = new Set(["short", "info", "misroute", "ivr_only"]);

// Базовые пороги алертов (для справки/хэша — сами алерты дергаются из index/amo env)
const ALERT_MIN_TOTAL       = parseInt(process.env.ALERT_MIN_TOTAL || "60", 10);
const ALERT_MIN_SENTIMENT   = parseInt(process.env.ALERT_MIN_SENTIMENT || "-2", 10);
const ALERT_IF_ESCALATE     = (process.env.ALERT_IF_ESCALATE || "1") === "1";

// ──────────────────────────────────────────────────────────────────────────────
import crypto from "crypto";

// Хэш конфига — для трассировки в БД
function configHash() {
  const cfg = {
    CALL_QA_MODEL,
    QA_RUBRIC_VERSION,
    ALERT_RULES_VERSION,
    SHORT_CALL_SEC,
    NON_EVALUABLE_INTENTS: Array.from(NON_EVALUABLE_INTENTS).sort(),
    ALERT_MIN_TOTAL, ALERT_MIN_SENTIMENT, ALERT_IF_ESCALATE,
  };
  const s = JSON.stringify(cfg);
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Простейшая эвристика: определить "intent" по тексту
function naiveIntentDetect(text = "", meta = {}) {
  const t = (text || "").toLowerCase();
  const dur = meta?.duration_sec || 0;

  if (!t.trim()) return "unknown";
  if (dur > 0 && dur <= SHORT_CALL_SEC) return "short";
  if (/нажал(и)?\s*не туда|перепутал(а)?|ошиблись номером|это не туда|не ваш сервис/.test(t)) return "misroute";
  if (/статус|когда будет готов|сколько по времени|позвоните|перезвоните|диагностик|готов/i.test(t)) return "support";
  if (/сколько стоит|цена|стоимость|купить|есть в наличии|оформить заказ|заказ/i.test(t)) return "sales";
  if (/подскажите|узнать|вопрос|интересует/i.test(t)) return "info";
  return "support"; // по умолчанию считаем поддержкой
}

// Простейшая эвристика для тональности клиента (-3..+3)
function naiveSentiment(text = "") {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return 0;
  if (/(ор(у|ете)|вы.*(должн|почему)|сколько можно|ужас.*сервис|ненавижу|отврат|хрен|пизд|бляд)/.test(t)) return -3;
  if (/(разочаров|недоволен|не доволен|плохо|не устраивает|вынужден)/.test(t)) return -2;
  if (/(непонятно|неясно|что с моим|где мой|сколько ждать)/.test(t)) return -1;
  if (/(спасибо|благодарю|хорошего дня|отлично|супер)/.test(t)) return +2;
  return 0;
}

// Простейшая оценка техник менеджера (0..10) + итог
function scoreManagerHeuristics(text = "", meta = {}) {
  // Очень простая шкала по ключевым словам — временный fallback.
  // В проде основную детализацию даёт модель.
  const t = (text || "").toLowerCase();

  const greeting = /здравств|добрый|меня зовут|компания/.test(t) ? 6 : 3;
  const rapport  = /как.*могу помочь|скажите пожалуйста|давайте|хорошо/i.test(t) ? 5 : 2;
  const needs    = /уточн|какая модель|что случилось|по какому вопросу|детал/i.test(t) ? 6 : 3;
  const value    = /для вас.*можем|выгодно|предлож/i.test(t) ? 4 : 0;
  const obj      = /но|однако|к сожалению/i.test(t) ? 3 : 0;
  const next     = /перезвон|свяжем|передам|приходите|оформ/i.test(t) ? 6 : 2;
  const close    = /всего добр|хорошего дня|до свидан/i.test(t) ? 6 : 0;
  const clarity  = /итог|значит|получается|тогда/i.test(t) ? 6 : 3;
  const comp     = /согласн|по правилам|оформ|согласие/i.test(t) ? 6 : 5;

  const per = {
    greeting, rapport, needs, value, objections: obj, next_step: next, closing: close, clarity, compliance: comp
  };

  // Итоговая метрика (простая средняя по задействованным)
  const vals = Object.values(per);
  const total = Math.round(vals.reduce((a,b) => a+b, 0) / vals.length);

  return { per, total };
}

// Обёртка обращения к модели (если ключ есть)
async function callOpenAIForQA(text, meta) {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
  if (!OPENAI_API_KEY) return null;

  // Формируем системную инструкцию — короткую и детерминированную
  const sys = [
    "Ты — QA-инспектор звонков сервисного центра. Отвечай JSON строго по схеме:",
    "{ intent: 'sales|support|info|misroute|short|unknown',",
    "  psycho_emotional: { customer_sentiment: -3..3, manager_tone: 'string', manager_empathy: 'низкий|умеренный|высокий', escalate_flag: boolean },",
    "  score: { total: 0..100, per_dimension: { greeting, rapport, needs, value, objections, next_step, closing, clarity, compliance } },",
    "  kpis: { estimated_talk_ratio_manager_percent?: number },",
    "  summary: 'краткий вывод' }",
    "Если звонок «short|info|misroute|ivr_only» — выставь intent и аккуратные оценки (или 0), но помни: такие звонки НЕ для штрафов.",
  ].join(" ");

  const user = [
    `Текст транскрипта (может быть коротким):\n${text}\n`,
    `Метаданные: ${JSON.stringify({ duration_sec: meta?.duration_sec || 0, note_type: meta?.note_type || "" })}`
  ].join("\n");

  // Используем fetch к OpenAI REST (без внешних зависимостей)
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "authorization": `Bearer ${OPENAI_API_KEY}`, "content-type":"application/json" },
    body: JSON.stringify({
      model: CALL_QA_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user }
      ]
    })
  });
  if (!r.ok) {
    const tx = await r.text().catch(()=> "");
    throw new Error(`OpenAI QA HTTP ${r.status}: ${tx}`);
  }
  const j = await r.json();
  const raw = j?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Главная функция — анализ транскрипта
export async function analyzeTranscript(text, meta = {}) {
  const duration = meta?.duration_sec || 0;

  // 1) Попробуем модель
  let modelQa = null;
  try {
    modelQa = await callOpenAIForQA(text || "", meta);
  } catch (e) {
    // молча упадем в эвристику
  }

  // 2) Эвристики как fallback / для нормализации
  let intent = modelQa?.intent || naiveIntentDetect(text, meta);
  let sent   = Number.isFinite(+modelQa?.psycho_emotional?.customer_sentiment)
               ? +modelQa.psycho_emotional.customer_sentiment
               : naiveSentiment(text);

  // Если очень короткий звонок — принудительно short
  if (duration > 0 && duration <= SHORT_CALL_SEC) intent = "short";

  // Эвристические пер-оценки, если модели нет
  const h = scoreManagerHeuristics(text, meta);
  const modelTotal = Number.isFinite(+modelQa?.score?.total) ? +modelQa.score.total : null;
  const perDimension = modelQa?.score?.per_dimension || h.per;
  let total = modelTotal ?? h.total;

  // Психо-эмоциональный блок
  const psycho_emotional = {
    customer_sentiment: sent,
    manager_tone: modelQa?.psycho_emotional?.manager_tone || (sent <= -2 ? "напряжённый" : sent >= 2 ? "дружелюбный" : "спокойный"),
    manager_empathy: modelQa?.psycho_emotional?.manager_empathy || (sent <= -2 ? "низкий" : "умеренный"),
    escalate_flag: Boolean(modelQa?.psycho_emotional?.escalate_flag) || (sent <= -3)
  };

  // Если intent неоценочный — убираем итоговую оценку из «штрафного поля»
  let suppress_alert = false;
  if (NON_EVALUABLE_INTENTS.has(intent)) {
    suppress_alert = true;
    total = null; // в БД score_total = null, чтобы не попадал под пороги
  }

  // Соберём итог
  const qa = {
    intent,
    meta: { intent }, // совместимость с более старыми вызовами
    psycho_emotional,
    score: { total, per_dimension: perDimension },
    kpis: { estimated_talk_ratio_manager_percent: modelQa?.kpis?.estimated_talk_ratio_manager_percent ?? null },
    summary: modelQa?.summary || "",
    // паспорт пайплайна
    passport: {
      qa_model: CALL_QA_MODEL,
      qa_rubric_version: QA_RUBRIC_VERSION,
      alert_rules_version: ALERT_RULES_VERSION,
      config_hash: configHash(),
      suppress_alert
    }
  };

  return qa;
}

// Форматтер карточки в Telegram (HTML)
export function formatQaForTelegram(qa) {
  const i = qa?.intent || "unknown";
  const pe = qa?.psycho_emotional || {};
  const sc = qa?.score || {};
  const per = sc.per_dimension || {};
  const total = sc.total;

  const nonEval = NON_EVALUABLE_INTENTS.has(i);
  const badge = nonEval ? "· неоценочный звонок" : `· Итоговый балл: ${total ?? "—"}/100`;

  const lines = [];

  // Заголовок
  const typeRu = (
    i === "sales"   ? "продажи" :
    i === "support" ? "поддержка/ремонт" :
    i === "info"    ? "информационный" :
    i === "misroute"? "не по адресу" :
    i === "short"   ? "короткий" : "не распознан"
  );

  lines.push("📊 <b>Аналитика звонка (iRazbil v4.2)</b>");
  lines.push(`• Тип: <b>${typeRu}</b> ${badge}`);

  // Психо-эмоциональный блок
  const tone = pe.manager_tone ? ` · Менеджер: ${pe.manager_tone}` : "";
  const emp  = pe.manager_empathy ? ` · Эмпатия: ${pe.manager_empathy}` : "";
  lines.push("🧠 <b>Психо-эмоциональный фон</b>");
  lines.push(`• Клиент: ${typeof pe.customer_sentiment === "number" ? pe.customer_sentiment : "—"}${tone}${emp}`);

  // Техники — коротко
  const pick = k => (typeof per[k] === "number" ? per[k] : "—");
  lines.push("🧩 <b>Техники (оценки 0–10)</b>");
  lines.push(`• Приветствие: ${pick("greeting")} · Раппорт: ${pick("rapport")} · Потребности: ${pick("needs")} · Ценность: ${pick("value")}`);
  lines.push(`• Возражения: ${pick("objections")} · Следующий шаг: ${pick("next_step")} · Завершение: ${pick("closing")}`);
  lines.push(`• Ясность: ${pick("clarity")} · Комплаенс: ${pick("compliance")}`);

  if (nonEval) {
    lines.push("⚖️ <i>Звонок помечен как «неоценочный» — формальный балл не выставляется и в алерты не пойдёт.</i>");
  }

  return lines.join("\n");
}
