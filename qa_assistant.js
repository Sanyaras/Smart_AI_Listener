// qa_assistant.js
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const CALL_QA_MODEL  = process.env.CALL_QA_MODEL  || "gpt-4.1-mini";

// Максимальная длина транскрипта, чтобы не упираться в лимиты модели
const MAX_TXT = 16000;

/**
 * Профессиональный анализ звонка «глазами РОПа».
 * Возвращает СТРОГИЙ JSON с глубокой оценкой, психо-срезом и рекомендациями.
 */
export async function analyzeTranscript(transcript, meta = {}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");
  if (!transcript || !transcript.trim()) throw new Error("Empty transcript");

  const t = transcript.length > MAX_TXT ? (transcript.slice(0, MAX_TXT) + "\n[...cut...]") : transcript;

  const system = [
    "Ты — строгий и опытный руководитель отдела продаж (РОП).",
    "Твоя задача — профессионально разобрать ЛЮБОЙ телефонный диалог (продажи/саппорт/логистика/жалоба/другое) и выдать подробную оценку.",
    "Всегда отвечай ТОЛЬКО в формате ЖЁСТКОГО JSON (без пояснений и без текста вне JSON).",
    "Структура JSON ровно такая:",
    "{",
    '  "meta": { "language": "ru|en|...", "intent": "sales|support|delivery|complaint|admin|other", "stage": "first_contact|follow_up|closing|post_sale|other", "outcome": "success|callback_scheduled|info_sent|refusal|no_answer|other" },',
    '  "psycho": { "customer_sentiment": -3, "manager_tone": -3, "empathy": 0, "tension": 0, "trust_signals": [], "stress_markers": [], "escalate_flag": false, "notes": "" },',
    '  "technique": {',
    '    "greeting": 0, "intro": 0, "rapport": 0, "needs": 0, "qualification": 0,',
    '    "value": 0, "objection_handling": 0, "next_step": 0, "closing": 0, "clarity": 0, "compliance": 0',
    "  },",
    '  "kpis": { "estimated_talk_ratio_manager_percent": 0, "interruptions_count": 0, "callbacks_promised": 0, "followups_committed": 0 },',
    '  "risks": [],',
    '  "best_quotes": { "value_proposition": "", "objection": "", "closing": "" },',
    '  "action_items": [ { "owner":"manager|rop", "item":"", "due":"ASAP|date" } ],',
    '  "training_recommendations": [],',
    '  "score": {',
    '    "rubric": "rop-v1",',
    '    "weights": { "psycho": 25, "needs": 15, "value": 15, "objections": 15, "next_step": 15, "compliance": 5, "clarity": 5, "rapport": 5 },',
    '    "per_dimension": { "psycho": 0, "needs": 0, "value": 0, "objections": 0, "next_step": 0, "compliance": 0, "clarity": 0, "rapport": 0 },',
    '    "total": 0',
    "  },",
    '  "suggestions": { "one_line_coach_tip": "", "detailed": "" }',
    "}",
    "",
    "Правила оценки:",
    "- customer_sentiment / manager_tone: от -3 (очень негативно) до +3 (очень позитивно).",
    "- empathy, tension: 0..3.",
    "- technique: greeting/intro 0..1; rapport 0..2; needs 0..3; qualification 0..2; value 0..3; objection_handling 0..2; next_step 0..2; closing 0..2; clarity 0..2; compliance 0..2.",
    "- per_dimension и total: 0..100. Total — взвешенная сумма по weights (округляй до целого).",
    "- language — язык транскрипта; отвечай на том же языке в текстовых полях.",
    "- Если звонок НЕ продажа — корректно определяй intent и оценивай применимые критерии (не наказывай за «нет УТП», если это саппорт).",
    "- Обязательно дай actionable рекомендации: что сказать/сделать иначе в следующий раз."
  ].join("\n");

  const user = [
    meta.callId ? `CallID: ${meta.callId}` : null,
    meta.ext ? `ext: ${meta.ext}` : null,
    meta.direction ? `direction: ${meta.direction}` : null,
    meta.from && meta.to ? `from: ${meta.from} -> to: ${meta.to}` : null,
    meta.brand ? `brand: ${meta.brand}` : null,
    "",
    "Транскрипт (разделено на роли, если возможно):",
    t
  ].filter(Boolean).join("\n");

  const payload = {
    model: CALL_QA_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.2,
    // просим JSON «жестко»
    response_format: { type: "json_object" }
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`assistant http ${r.status}: ${t}`);
  }
  const data = await r.json();
  const txt = data?.choices?.[0]?.message?.content || "";

  // Парсим JSON (иногда модель оборачивает кодблоками — убираем)
  const clean = String(txt).trim().replace(/^```json\s*|\s*```$/g, "");
  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error("assistant returned non-JSON: " + (txt?.slice(0, 600) || ""));
  }
  return parsed;
}

export function formatQaForTelegram(qa) {
  const s = safe(qa);
  const dim = s.score?.per_dimension || {};
  const psycho = s.psycho || {};
  const meta = s.meta || {};

  const emo = (n) => (n <= -2 ? "🔴" : n < 0 ? "🟠" : n === 0 ? "🟡" : n <= 2 ? "🟢" : "🟣");

  const lines = [
    "📊 <b>Аналитика звонка (РОП)</b>",
    meta.intent ? `• Тип: <b>${esc(meta.intent)}</b> · Стадия: <b>${esc(meta.stage||"-")}</b>` : null,
    meta.outcome ? `• Итог: <b>${esc(meta.outcome)}</b>` : null,
    "",
    "🧠 <b>Психо-срез</b>",
    `• Клиент: ${emo(psycho.customer_sentiment ?? 0)} <code>${psycho.customer_sentiment ?? 0}</code> · Тон менеджера: ${emo(psycho.manager_tone ?? 0)} <code>${psycho.manager_tone ?? 0}</code>`,
    `• Эмпатия: <code>${psycho.empathy ?? 0}</code> · Напряжение: <code>${psycho.tension ?? 0}</code> · Эскалация: <code>${psycho.escalate_flag ? "да" : "нет"}</code>`,
    psycho.notes ? `• Заметки: <i>${esc(psycho.notes)}</i>` : null,
    "",
    "🧩 <b>Техника</b>",
    `• Потребность: <code>${s.technique?.needs ?? "-"}</code> · УТП: <code>${s.technique?.value ?? "-"}</code> · Возражения: <code>${s.technique?.objection_handling ?? "-"}</code>`,
    `• След. шаг: <code>${s.technique?.next_step ?? "-"}</code> · Закрытие: <code>${s.technique?.closing ?? "-"}</code>`,
    `• Раппорт: <code>${s.technique?.rapport ?? "-"}</code> · Понятность: <code>${s.technique?.clarity ?? "-"}</code>`,
    "",
    "📈 <b>Оценки (0–100)</b>",
    `• Psycho: <code>${dim.psycho ?? "-"}</code> · Needs: <code>${dim.needs ?? "-"}</code> · Value: <code>${dim.value ?? "-"}</code> · Obj: <code>${dim.objections ?? "-"}</code>`,
    `• Next: <code>${dim.next_step ?? "-"}</code> · Rapport: <code>${dim.rapport ?? "-"}</code> · Clarity: <code>${dim.clarity ?? "-"}</code> · Compliance: <code>${dim.compliance ?? "-"}</code>`,
    "",
    s.score?.total !== undefined ? `⭐️ <b>Total:</b> <b>${s.score.total}</b>/100 (rubric ${esc(s.score.rubric || "v1")})` : null,
    "",
    s.suggestions?.one_line_coach_tip ? `🎯 <b>Совет:</b> ${esc(s.suggestions.one_line_coach_tip)}` : null,
    s.suggestions?.detailed ? `🛠 <b>Рекомендации:</b>\n${esc(s.suggestions.detailed)}` : null,
    "",
    (s.risks && s.risks.length) ? "⚠️ <b>Риски:</b>\n• " + s.risks.map(esc).join("\n• ") : null,
    (s.action_items && s.action_items.length) ? "\n📝 <b>Action items:</b>\n" + s.action_items.map(a => `• <i>${esc(a.owner||"manager")}</i>: ${esc(a.item||"")} (${esc(a.due||"ASAP")})`).join("\n") : null
  ].filter(Boolean);

  return lines.join("\n");
}

function safe(x) { return (x && typeof x === "object") ? x : {}; }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
