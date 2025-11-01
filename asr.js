
// asr.js — надёжная транскрибация с докачкой и чанкингом (v2.6)
// Совместимо с твоими импортами: enqueueAsr, transcribeAudioFromUrl, getAsrState
// Особенности:
//  • Стрим-скачивание файла целиком (HEAD+GET), длинные таймауты, ретраи
//  • ffprobe → длительность; при необходимости ffmpeg-сегментация (по 10 мин)
//  • Конкатенация расшифровок кусков в один текст
//  • Возврат СТРОКИ; опциональная мягкая ролевка после склейки
//  • Никаких «обрезок» по размеру буфера/таймауту — всё уходит на диск

import fs from "fs/promises";
import fssync from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { pipeline } from "stream/promises";
import { spawn } from "child_process";

import { fetchWithTimeout, cap } from "./utils.js";
import { sendTG } from "./telegram.js";

/* ================= ENV/CFG ================= */
const OPENAI_API_KEY        = process.env.OPENAI_API_KEY || "";

// Whisper endpoint (официальный)
const WHISPER_MODEL         = process.env.ASR_MODEL || "whisper-1";
const WHISPER_LANG          = process.env.ASR_LANG  || "ru";
const ROLE_MODEL            = process.env.ASR_ROLE_MODEL || "gpt-4o-mini"; // опциональная ролевка

// таймауты/порог
const DOWNLOAD_TIMEOUT_MS   = parseInt(process.env.ASR_DOWNLOAD_TIMEOUT_MS || "300000", 10); // 5 мин
const UPLOAD_TIMEOUT_MS     = parseInt(process.env.ASR_UPLOAD_TIMEOUT_MS   || "420000", 10); // 7 мин
const RETRIES               = parseInt(process.env.ASR_RETRIES || "2", 10);

const MAX_DOWNLOAD_MB       = parseInt(process.env.ASR_MAX_MB || "200", 10); // жёсткий предохранитель
const MAX_DOWNLOAD_BYTES    = MAX_DOWNLOAD_MB * 1024 * 1024;

const ENABLE_CHUNKING       = (process.env.ASR_ENABLE_CHUNKING || "1") === "1";
const MAX_SEGMENT_SECONDS   = parseInt(process.env.ASR_MAX_SEGMENT_SEC || "600", 10);   // 10 мин
const CHUNK_IF_SECONDS_GT   = parseInt(process.env.ASR_CHUNK_IF_SEC_GT  || "720", 10);  // чанкать, если > 12 мин
const CHUNK_IF_SIZE_MB_GT   = parseInt(process.env.ASR_CHUNK_IF_MB_GT   || "60", 10);   // или если > 60 МБ

const TMP_DIR               = process.env.ASR_TMP_DIR || os.tmpdir();
const PIPELINE_VERSION      = "asr-2.6";

/* ================= Очередь ================= */
const ASR_CONCURRENCY       = parseInt(process.env.ASR_CONCURRENCY || "2", 10);
const _queue = [];
let _active = 0;

export function getAsrState() {
  return { asrActive: _active, asrQueueLength: _queue.length };
}
export function enqueueAsr(taskFn) {
  return new Promise((resolve, reject) => {
    _queue.push({ taskFn, resolve, reject });
    _drain();
  });
}
async function _drain() {
  if (_active >= ASR_CONCURRENCY) return;
  const next = _queue.shift();
  if (!next) return;
  _active++;
  try {
    const out = await next.taskFn();
    next.resolve(out);
  } catch (e) {
    next.reject(e);
  } finally {
    _active--;
    _drain();
  }
}

/* ================= Helpers ================= */
function hasCmd(cmd) {
  return new Promise((resolve) => {
    const ps = spawn(cmd, ["-version"]);
    let fired = false;
    ps.on("spawn", () => { if (!fired) { fired = true; resolve(true); }});
    ps.on("error", () => { if (!fired) { fired = true; resolve(false); }});
    setTimeout(() => { if (!fired) { fired = true; resolve(false); }}, 500);
  });
}
async function ffprobeDurationSec(filePath) {
  const ok = await hasCmd("ffprobe");
  if (!ok) return null;
  return new Promise((resolve) => {
    const args = [
      "-v","error",
      "-show_entries","format=duration",
      "-of","default=noprint_wrappers=1:nokey=1",
      filePath
    ];
    const ps = spawn("ffprobe", args);
    let out = "";
    ps.stdout.on("data", d => out += d.toString());
    ps.on("close", () => {
      const s = parseFloat(out.trim());
      resolve(Number.isFinite(s) && s > 0 ? Math.round(s) : null);
    });
    ps.on("error", () => resolve(null));
  });
}
async function ffmpegSegment(filePath, outDir, seconds = MAX_SEGMENT_SECONDS) {
  const ok = await hasCmd("ffmpeg");
  if (!ok) return null;
  await fs.mkdir(outDir, { recursive: true }).catch(()=>{});
  const mask = path.join(outDir, "part-%03d.mp3");
  const args = [
    "-hide_banner","-loglevel","error",
    "-i", filePath,
    "-f","segment",
    "-segment_time", String(seconds),
    "-c","copy",
    mask
  ];
  await new Promise((resolve, reject) => {
    const ps = spawn("ffmpeg", args);
    let err = "";
    ps.stderr.on("data", d => err += d.toString());
    ps.on("close", code => code === 0 ? resolve() : reject(new Error(err || `ffmpeg exit ${code}`)));
    ps.on("error", reject);
  });
  const files = (await fs.readdir(outDir))
    .filter(n => /^part-\d{3}\.mp3$/i.test(n))
    .sort()
    .map(n => path.join(outDir, n));
  return files.length ? files : null;
}
async function downloadToFile(url, filePath, timeoutMs = DOWNLOAD_TIMEOUT_MS, retries = RETRIES) {
  let lastErr = null;
  for (let a = 0; a <= retries; a++) {
    try {
      // HEAD — оценить размер
      try {
        const head = await fetchWithTimeout(url, { method: "HEAD", redirect: "follow" }, 10000);
        const cl = head.headers.get("content-length");
        if (cl && parseInt(cl,10) > MAX_DOWNLOAD_BYTES) {
          throw new Error(`too_big(${(parseInt(cl,10)/1024/1024).toFixed(1)}MB)`);
        }
      } catch (_){/* ок, пропустим */}

      const resp = await fetchWithTimeout(url, { method:"GET", redirect:"follow" }, timeoutMs);
      if (!resp.ok || !resp.body) throw new Error(`http_${resp.status}`);

      await pipeline(resp.body, fssync.createWriteStream(filePath));
      const st = await fs.stat(filePath);
      if (!st.size) throw new Error("empty_file");
      if (st.size > MAX_DOWNLOAD_BYTES) throw new Error(`too_big(${(st.size/1024/1024).toFixed(1)}MB)`);

      return st.size;
    } catch (e) {
      lastErr = e;
      try { await fs.unlink(filePath); } catch {}
      if (a < retries) await new Promise(r => setTimeout(r, 800*(a+1)));
    }
  }
  throw lastErr || new Error("download_failed");
}
function fileToBlob(filePath) {
  const buf = fssync.readFileSync(filePath);
  return new Blob([buf]);
}

/* ============== OpenAI Whisper upload ============== */
async function whisperTranscribeFile(filePath, filename = "audio.mp3") {
  const form = new FormData();
  form.append("file", fileToBlob(filePath), filename);
  form.append("model", WHISPER_MODEL);
  form.append("language", WHISPER_LANG);
  form.append("response_format", "text");

  const r = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: form
  }, UPLOAD_TIMEOUT_MS);

  if (!r.ok) {
    const t = await r.text().catch(()=> "");
    throw new Error(`whisper_${r.status}: ${cap(t, 700)}`);
  }
  const txt = (await r.text()).trim();
  return txt;
}

/* ============== «Мягкая» ролевка (после склейки) ============== */
async function roleLabel(text) {
  if (!ROLE_MODEL) return null;
  try {
    const prompt =
`Разбей текст телефонного звонка по ролям: ivr (автоответчик), manager (менеджер), customer (клиент).
Верни ТОЛЬКО JSON-массив объектов в виде [{"speaker":"ivr|manager|customer","text":"..."}] без комментариев.

Текст:
${text}`;
    const r = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
      body: JSON.stringify({
        model: ROLE_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: "Ты помощник по разметке ролей диалога. Только JSON без пояснений." },
          { role: "user", content: prompt }
        ]
      })
    }, 90000);

    const j = await r.json().catch(()=> null);
    const raw = j?.choices?.[0]?.message?.content || "";
    const clean = raw.replace(/```json|```/g, "").trim();
    const arr = JSON.parse(clean);
    if (!Array.isArray(arr) || !arr.length) return null;

    return arr.map(x => `${(x.speaker||"unknown").toLowerCase()}: ${x.text||""}`.trim()).join("\n");
  } catch {
    return null;
  }
}

/* ============== Публичный API ============== */
/**
 * Транскрибация по URL (возвращает СТРОКУ).
 * meta: { callId?:string, fileName?:string }
 */
export async function transcribeAudioFromUrl(fileUrl, meta = {}) {
  if (!OPENAI_API_KEY) {
    await sendTG("⚠️ OPENAI_API_KEY отсутствует — ASR пропущен.");
    return null;
  }

  const callId   = meta.callId || "call";
  const baseName = meta.fileName || `${callId}.mp3`;
  const dir      = await fs.mkdtemp(path.join(TMP_DIR, `asr-${PIPELINE_VERSION}-`));
  const srcPath  = path.join(dir, baseName);

  try {
    // 1) Скачать целиком
    const size = await downloadToFile(fileUrl, srcPath, DOWNLOAD_TIMEOUT_MS, RETRIES);

    // 2) Оценить длительность (если есть ffprobe)
    const durSec = await ffprobeDurationSec(srcPath);

    // 3) Нужно ли чанкать?
    let parts = null;
    const sizeMB = size / (1024*1024);
    if (ENABLE_CHUNKING && ((durSec && durSec > CHUNK_IF_SECONDS_GT) || (sizeMB > CHUNK_IF_SIZE_MB_GT))) {
      try {
        const partsDir = path.join(dir, "parts");
        parts = await ffmpegSegment(srcPath, partsDir, MAX_SEGMENT_SECONDS);
      } catch (e) {
        await sendTG(`⚠️ ffmpeg сегментация не удалась: <code>${cap(e?.message||e, 300)}</code>. Пытаюсь без чанков.`);
      }
    }

    // 4) Транскрибация
    let fullText = "";
    if (parts && parts.length) {
      for (let i=0;i<parts.length;i++) {
        const p = parts[i];
        const name = `${path.basename(baseName, path.extname(baseName))}.part${String(i+1).padStart(3,"0")}.mp3`;
        const t = await whisperTranscribeFile(p, name);
        if (t) fullText += (fullText ? "\n" : "") + t.trim();
      }
    } else {
      fullText = (await whisperTranscribeFile(srcPath, baseName)) || "";
    }
    if (!fullText.trim()) return null;

    // 5) Мягкая ролевка (если включена модель)
    const labeled = await roleLabel(fullText).catch(()=> null);
    return labeled || fullText;

  } catch (e) {
    await sendTG(`❗️ ASR ошибка: <code>${cap(e?.message || e, 600)}</code>`);
    return null;
  } finally {
    // 6) Уборка
    try {
      const files = await fs.readdir(dir).catch(()=> []);
      await Promise.all(files.map(n => fs.rm(path.join(dir, n), { recursive:true, force:true })));
      await fs.rm(dir, { recursive:true, force:true }).catch(()=>{});
    } catch {}
  }
}
