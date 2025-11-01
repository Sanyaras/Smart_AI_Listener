// qa_assistant.js
import fetch from "node-fetch";
import { debug, safeStr } from "./utils.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CALL_QA_MODEL = "gpt-4o-mini"; // компактная и дешёвая, можно поменять на gpt-4o при желании
const TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;

if (!OPENAI_API_KEY) throw new Error("❌ OPENAI_API_KEY missing");

/**
 * Анализирует транскрипт звонка и возвращает JSON-оценку
 */
export async function analyzeTranscript(transcript, meta = {}) {
  if (!transcript?.trim()) throw new Error("Empty transcript");

  const systemPrompt = `
Вы – AI-ассистент отдела контроля качества компании iRazbil.
Вы оцениваете телефонные разговоры менеджеров с клиентами.
Нужно выдать строго JSON со структурой:

{
  "intent": "sales" | "support",
  "score": {
    "greeting": 0-10,
    "rapport": 0-10,
    "needs": 0-10,
    "value": 0-10,
    "objection_handling": 0-10,
    "next_step": 0-10,
    "closing": 0-10,
    "clarity": 0-10,
    "compliance": 0-10,
    "total": 0-100
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
  "quotes": [{ "speaker": "manager", "quote": "..." }],
  "summary": "...",
  "action_items": ["...", "..."]
}

Вывод ТОЛЬКО JSON, без комментариев.
`;

  const userPrompt = `
CallID: ${meta.callId || "unknown"}
Direction: ${meta.direction || "unknown"}
From: ${meta.from || "-"} → To: ${meta.to || "-"}
Brand: iRazbil

Транскрипт:
${transcript.slice(0, 16000)}
`;

  const body = {
    model: CALL_QA_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.0,
    response_format: { type: "json_object" },
  };

  const result = await callOpenAIWithRetry(body, MAX_RETRIES);
  return result;
}

async function callOpenAIWithRetry(payload, retries = 2) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });

      clearTimeout(timer);
      const json = await res.json();

      if (json?.choices?.[0]?.message?.content) {
        const txt = json.choices[0].message.content.trim();
        const clean = txt.replace(/^```json\s*|\s*```$/g, "");
        return JSON.parse(clean);
      }

      throw new Error("No valid response");
    } catch (e) {
      lastErr = e;
      debug(`⚠️ Retry ${i + 1}/${retries} — ${safeStr(e)}`);
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

/**
 * Форматирует JSON-оценку в HTML для Telegram
 */
export function formatQaForTelegram(qa) {
  if (!qa || typeof qa !== "object") return "⚠️ Нет данных анализа";

  const sc = qa.score || {};
  const pe = qa.psycho_emotional || {};
  const t = qa.techniques || {};
  const quotes = Array.isArray(qa.quotes) ? qa.quotes.slice(0, 3) : [];

  const lines = [
    "📊 <b>Оценка звонка</b>",
    `• Тип: <b>${qa.intent}</b> · Итог: <b>${sc.total}</b>/100`,
    "",
    "🧩 <b>Техники</b>",
    `Приветствие: ${sc.greeting}, Раппорт: ${sc.rapport}, Потребности: ${sc.needs}`,
    `Ценность: ${sc.value}, Возражения: ${sc.objection_handling}, Следующий шаг: ${sc.next_step}`,
    `Завершение: ${sc.closing}, Ясность: ${sc.clarity}, Комплаенс: ${sc.compliance}`,
    "",
    "🧠 <b>Психоэмоциональный фон</b>",
    `Клиент: ${pe.customer_sentiment} · Менеджер: ${pe.manager_tone} · Эмпатия: ${pe.manager_empathy}`,
    "",
    quotes.length ? "💬 <b>Цитаты</b>:" : null,
    ...quotes.map((q) => `• <b>${q.speaker}:</b> “${q.quote}”`),
    "",
    qa.summary ? `📝 ${qa.summary}` : null,
    qa.action_items?.length
      ? ["📌 <b>Рекомендации:</b>", ...qa.action_items.map((i) => `• ${i}`)].join("\n")
      : null,
  ].filter(Boolean);

  return lines.join("\n");
}
