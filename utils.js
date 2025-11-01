// utils.js
import fetch from "node-fetch";

export function debug(...args) {
  if (process.env.DEBUG === "true" || process.env.DEBUG === "1") {
    console.log("[debug]", ...args);
  }
}

export function cap(s, n = 2000) {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…[cut]" : t;
}

export function safeStr(obj, n = 3500) {
  try {
    if (typeof obj === "string") return cap(obj, n);
    return cap(JSON.stringify(obj, null, 2), n);
  } catch {
    return "[unserializable]";
  }
}

export function fmtPhone(p) {
  if (!p) return "-";
  const s = String(p).trim();
  return s.startsWith("+") ? s : "+" + s;
}

export function fmtDate(secOrMs) {
  const date = new Date(
    typeof secOrMs === "number" && secOrMs < 1e12 ? secOrMs * 1000 : secOrMs
  );
  return date.toLocaleString("ru-RU", { timeZone: process.env.AMO_TIMEZONE || "Europe/Moscow" });
}

export function mask(s) {
  if (!s) return "";
  const t = String(s);
  return t.length <= 8 ? t.replace(/.(?=.{2})/g, "*") : t.slice(0, 4) + "…" + t.slice(-4);
}

export function chunkText(str, max = 3500) {
  const out = [];
  for (let i = 0; i < str.length; i += max) out.push(str.slice(i, i + max));
  return out;
}

export async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), ms);
  try {
    const headers = {
      "user-agent": "SmartAIListener/3.0 (+railway)",
      ...opts.headers,
    };
    return await fetch(url, { ...opts, headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
