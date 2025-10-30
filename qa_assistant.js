// qa_assistant.js (v3.1) — sales/service routing, psycho, dates, IVR/noise, JSON-only
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const CALL_QA_MODEL  = process.env.CALL_QA_MODEL  || "gpt-4.1-mini";
const MAX_TXT = 16000;

// ——— core ————————————————————————————————————————————————————————
export async function analyzeTranscript(transcript, meta = {}) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");
  if (!transcript || !transcript.trim()) throw new Error("Empty transcript");

  const t = transcript.length > MAX_TXT ? (transcript.slice(0, MAX_TXT) + "\n[...cut...]") : transcript;

  const system = [
    "Ты — строгий РОП. Анализируешь звонки iRazdill.",
    "Определи intent: sales|service|ivr|noise|other. Если много автоответчика/меню — это ivr; если нечленораздельно — noise.",
    "Верни ЖЁСТКИЙ JSON, без текста вне JSON.",
    "",
    "{",
    '  "meta": { "language": "ru|en|...", "intent": "sales|service|ivr|noise|other", "stage": "first_contact|follow_up|closing|post_sale|other", "outcome": "success|callback_scheduled|info_sent|refusal|no_answer|escalated|unresolved|other" },',
    '  "psycho": { "customer_sentiment": -3, "manager_tone": -3, "empathy": 0, "tension": 0, "toxic_language": false, "escalate_flag": false, "notes": "" },',
    '  "technique": { "needs": 0, "value": 0, "objection_handling": 0, "next_step": 0, "clarity": 0, "rapport": 0, "compliance": 0 },',
    '  "kpis": { "estimated_talk_ratio_manager_percent": 0, "interruptions_count": 0 },',
    '  "sales": { "buying_intent_0_3": 0, "timeline_raw": "", "budget_raw": "", "decision_makers": [], "blockers": [], "next_step_raw": "" },',
    '  "service": { "issue_category": "", "resolved": false, "severity_1_3": 1, "promise_eta_raw": "", "steps_taken": "" },',
    '  "entities": { "dates_raw": [], "phones": [], "emails": [] },',
    '  "best_quotes": { "value_prop": "", "objection": "", "closing": "" },',
    '  "risks": [],',
    '  "score": { "rubric": "rop-v3", "per_dimension": { "psycho": 0, "needs": 0, "value": 0, "objections": 0, "next_step": 0, "clarity": 0, "rapport": 0, "compliance": 0 }, "total": 0 },',
    '  "suggestions": { "one_line": "", "detailed": "" }',
    "}",
    "",
    "Правила:",
    "- sentiment/tone -3..+3; empathy/tension 0..3; buying_intent_0_3 0..3; per_dimension/total 0..100.",
    "- Если intent=service — фокус на резолве, эмпатии, ясности; не штрафуй за УТП.",
    "- Если intent=ivr|noise — заполни кратко и выставь outcome=no_answer|other уместно.",
    "- Текстовые поля — на языке транскрипта."
  ].join("\n");

  const user = [
    meta.callId ? `CallID: ${meta.callId}` : null,
    meta.direction ? `direction: ${meta.direction}` : null,
    meta.from && meta.to ? `from: ${meta.from} -> to: ${meta.to}` : null,
    meta.brand ? `brand: ${meta.brand}` : null,
    "",
    "Транскрипт (с размеченными ролями где возможно):",
    t
  ].filter(Boolean).join("\n");

  const payload = {
    model: CALL_QA_MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0.15,
    response_format: { type: "json_object" }
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`assistant http ${r.status}: ${t}`);
  }
  const data = await r.json();
  const txt = data?.choices?.[0]?.message?.content || "";
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
  const meta = s.meta || {};
  const psycho = s.psycho || {};
  const dim = s.score?.per_dimension || {};
  const emo = (n) => (n <= -2 ? "🔴" : n < 0 ? "🟠" : n === 0 ? "🟡" : n <= 2 ? "🟢" : "🟣");
  const negBadge = psycho.toxic_language ? "⚡" : "";

  const lines = [
    "📊 <b>Аналитика звонка (РОП v3)</b>",
    `• Тип: <b>${esc(meta.intent || "-")}</b> · Стадия: <b>${esc(meta.stage || "-")}</b> · Итог: <b>${esc(meta.outcome || "-")}</b>`,
    "",
    "🧠 <b>Психо-срез</b>",
    `• Клиент: ${emo(psycho.customer_sentiment ?? 0)} <code>${psycho.customer_sentiment ?? 0}</code> ${negBadge} · Менеджер: ${emo(psycho.manager_tone ?? 0)} <code>${psycho.manager_tone ?? 0}</code>`,
    `• Эмпатия: <code>${psycho.empathy ?? 0}</code> · Напряжение: <code>${psycho.tension ?? 0}</code> · Эскалация: <code>${psycho.escalate_flag ? "да" : "нет"}</code>`,
    psycho.notes ? `• Заметки: <i>${esc(psycho.notes)}</i>` : null,
    "",
    s.meta?.intent === "sales"
      ? `🛒 <b>Sales</b>: Готовность купить: <code>${s.sales?.buying_intent_0_3 ?? "-"}</code> · Срок: <i>${esc(s.sales?.timeline_raw || "-")}</i>`
      : s.meta?.intent === "service"
      ? `🛠 <b>Service</b>: Категория: <code>${esc(s.service?.issue_category || "-")}</code> · Решено: <b>${s.service?.resolved ? "да" : "нет"}</b> · Срочн.: <code>${s.service?.severity_1_3 ?? "-"}</code>`
      : null,
    "",
    "🧩 <b>Техника</b>",
    `• Needs: <code>${s.technique?.needs ?? "-"}</code> · Value: <code>${s.technique?.value ?? "-"}</code> · Obj: <code>${s.technique?.objection_handling ?? "-"}</code> · Next: <code>${s.technique?.next_step ?? "-"}</code>`,
    `• Rapport: <code>${s.technique?.rapport ?? "-"}</code> · Clarity: <code>${s.technique?.clarity ?? "-"}</code> · Compliance: <code>${s.technique?.compliance ?? "-"}</code>`,
    "",
    "📈 <b>Оценки (0–100)</b>",
    `• Psycho: <code>${dim.psycho ?? "-"}</code> · Needs: <code>${dim.needs ?? "-"}</code> · Value: <code>${dim.value ?? "-"}</code> · Obj: <code>${dim.objections ?? "-"}</code> · Next: <code>${dim.next_step ?? "-"}</code>`,
    `• Rapport: <code>${dim.rapport ?? "-"}</code> · Clarity: <code>${dim.clarity ?? "-"}</code> · Compliance: <code>${dim.compliance ?? "-"}</code>`,
    "",
    s.score?.total !== undefined ? `⭐️ <b>Total:</b> <b>${s.score.total}</b>/100 (rubric ${esc(s.score.rubric || "v3")})` : null
  ].filter(Boolean);

  return lines.join("\n");
}

export function makeSpoilerTranscript(roleLabeledText, maxChars = 4000) {
  const body = String(roleLabeledText || "").slice(0, maxChars);
  return body ? `🗣️ <b>Расшифровка (сокращено)</b>\n||${esc(body)}||` : "";
}

// ——— utils ————————————————————————————————————————————————————————
function safe(x) { return (x && typeof x === "object") ? x : {}; }
function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
