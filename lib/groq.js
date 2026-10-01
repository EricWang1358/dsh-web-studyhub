import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitMp3, splitWavQuiet, wavInfo } from "./audio-file.js";
import { splitM4aBySize } from "./audio-m4a.js";

/* Groq as the middle tier of the audio pipeline: Gemini free key → Groq → Gemini paid key.

   Groq has a free plan with Whisper for speech (an OpenAI-style multipart endpoint) and open chat models for text.
   Its free plan takes at most 25 MB per audio file, so a chunk that the Gemini path would send whole is cut into
   pieces here and the texts are joined:
   - WAV is converted to 16 kHz mono first (what Groq does to it anyway, at a fraction of the size) and cut at pauses;
   - MP3 is cut on frame boundaries;
   - every other format (M4A, OGG, FLAC, WebM, and AAC/AIFF which Groq cannot read as they are) is cut with ffmpeg
     when it is installed: decoded once to find pauses, then each piece is made on demand as 16 kHz mono FLAC, one at
     a time so a long recording never sits in memory as pieces. Without ffmpeg those formats are not cut, and the
     request moves on to the next tier saying why.
   Nothing here logs or returns a key; it only travels in the Authorization header of requests to api.groq.com. */

export const GROQ_ORIGIN = "https://api.groq.com";
export const GROQ_TRANSCRIBE_MODEL = "whisper-large-v3";
export const GROQ_TEXT_MODEL = "openai/gpt-oss-120b";
/** The free plan takes 25 MB per file; stay clear of it. */
export const GROQ_FILE_LIMIT = 24_000_000;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
// What Groq accepts (AAC and AIFF are not on its list); Opus arrives in an Ogg container.
const KINDS = { ".wav": "wav", ".mp3": "mp3", ".m4a": "m4a", ".ogg": "ogg", ".opus": "ogg", ".flac": "flac", ".webm": "webm" };
const MIME = { wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", webm: "audio/webm" };
const kindOf = (kind) => { const text = String(kind).toLowerCase(); return text.startsWith(".") ? text : `.${text}`; };

/** 16-bit PCM WAV bytes for mono samples `data` at `rate`. */
function pcmWav(data, rate) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
/**
 * 16-bit PCM WAV as mono at no more than 16 kHz (channels averaged, samples box-filtered down), or null when it
 * already is, or is another encoding.
 */
export function toSpeechWav(bytes, info) {
  if (info.tag !== 1 || info.bits !== 16 || (info.sampleRate <= 16000 && info.channels === 1)) return null;
  const rate = Math.min(16000, info.sampleRate), ratio = info.sampleRate / rate, frames = Math.floor(info.dataLength / info.blockAlign);
  const count = Math.floor(frames / ratio), data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const from = Math.floor(i * ratio), to = Math.min(frames, Math.max(from + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let frame = from; frame < to; frame++) {
      const base = info.dataStart + frame * info.blockAlign;
      for (let channel = 0; channel < info.channels; channel++) sum += bytes.readInt16LE(base + channel * 2);
    }
    data.writeInt16LE(Math.round(sum / ((to - from) * info.channels)), i * 2);
  }
  return pcmWav(data, rate);
}

/* ---- ffmpeg: the way to cut formats that cannot be cut without decoding ---- */

let ffmpegFound;
const canRun = (command) => new Promise((resolve) => {
  const child = spawn(command, ["-version"], { stdio: "ignore", windowsHide: true });
  child.on("error", () => resolve(false));
  child.on("close", (code) => resolve(code === 0));
});
/** The ffmpeg to use: FFMPEG_PATH, else the one on PATH; null when there is none. A found one is remembered. */
export async function findFfmpeg() {
  if (ffmpegFound) return ffmpegFound;
  for (const command of [process.env.FFMPEG_PATH, "ffmpeg"].filter(Boolean)) if (await canRun(command)) return (ffmpegFound = command);
  return null;
}
/** Run ffmpeg to the end; `onData` receives what it writes to stdout. Stopped when `signal` aborts. */
function runFfmpeg(command, args, { signal, onData, timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(command, args, { stdio: ["ignore", onData ? "pipe" : "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    const stop = () => child.kill();
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    child.stderr.on("data", (part) => { stderr = (stderr + part).slice(-1500); });
    if (onData) child.stdout.on("data", onData);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(new Error(`ffmpeg 没能处理这段音频（退出码 ${code}）：${stderr.trim().split(/\r?\n/).at(-1) || "没有说明"}`));
    });
  });
}
const HOP = 1600; // 100 ms of 16 kHz speech
/**
 * Where a decoded recording is quietest, so a cut does not slice a sentence: the energy of every 100 ms.
 * The audio is decoded once, to 16 kHz mono, and only the energies are kept.
 */
async function loudness(command, file, signal) {
  const energy = [];
  let tail = Buffer.alloc(0), sum = 0, count = 0, samples = 0;
  await runFfmpeg(command, ["-v", "error", "-i", file, "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"], {
    signal, timeoutMs: 30 * 60_000,
    onData(part) {
      const data = tail.length ? Buffer.concat([tail, part]) : part, usable = data.length - (data.length % 2);
      for (let at = 0; at < usable; at += 2) {
        const value = data.readInt16LE(at);
        sum += value * value; samples++;
        if (++count === HOP) { energy.push(sum / HOP); sum = 0; count = 0; }
      }
      tail = data.subarray(usable);
    },
  });
  return { energy, seconds: samples / 16000 };
}
/** `parts` pieces of about equal length, each cut moved to the quietest 200 ms within `reach` seconds of where it would fall. */
export function quietCuts(energy, seconds, parts, reach) {
  const cuts = [0], span = Math.round(reach * 10);
  for (let part = 1; part < parts; part++) {
    const centre = Math.round(seconds * 10 * part / parts);
    let best = -1, quiet = Infinity;
    for (let hop = Math.max(Math.round(cuts.at(-1) * 10) + 10, centre - span); hop <= Math.min(energy.length - 2, centre + span); hop++) {
      const level = energy[hop] + energy[hop + 1];
      if (level < quiet) { quiet = level; best = hop; }
    }
    cuts.push(best >= 0 ? (best + 1) / 10 : seconds * part / parts);
  }
  return [...cuts, seconds];
}
/** This process's cut folders: the pid keeps parallel processes (and test runs) from counting each other's folders. */
export const CUT_PREFIX = `study-groq-${process.pid}-`;
/** Temporary folders left by a process that died mid-cut (each holds a copy of the audio) are removed once they are a day old. */
export async function sweepStaleCuts(now = Date.now()) {
  try {
    for (const name of await readdir(tmpdir())) {
      if (!name.startsWith("study-groq-")) continue;
      const folder = join(tmpdir(), name);
      if (now - (await stat(folder)).mtimeMs > 24 * 3600_000) await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  } catch { /* housekeeping only */ }
}
/** Pieces of a recording made with ffmpeg: decoded once for the pauses, then each piece made when it is asked for. */
async function ffmpegPlan({ command, bytes, kind, limit, signal, provider = "Groq" }) {
  await sweepStaleCuts();
  const dir = await mkdtemp(join(tmpdir(), CUT_PREFIX));
  const cleanup = () => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  try {
    const input = join(dir, `in${kind === ".opus" ? ".ogg" : kind}`);
    await writeFile(input, bytes);
    const { energy, seconds } = await loudness(command, input, signal);
    if (!(seconds > 0)) throw new Error("ffmpeg 没有从这段音频里读出声音");
    // 16-bit FLAC of 16 kHz speech is never larger than the PCM it came from (32 kB/s), so this many seconds always fits.
    // Half a second over a whole number of pieces is encoder padding, not another piece.
    const longest = Math.max(10, Math.floor(limit / 32_000 * 0.9)), parts = Math.max(1, Math.ceil((seconds - 0.5) / longest));
    const cuts = quietCuts(energy, seconds, parts, Math.min(20, longest * 0.25));
    return {
      count: parts, cleanup,
      async load(index) {
        const from = cuts[index], length = cuts[index + 1] - from, out = join(dir, `piece${index}.flac`);
        await runFfmpeg(command, ["-y", "-v", "error", "-ss", String(from), "-t", String(length), "-i", input, "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", "-c:a", "flac", out], { signal });
        const piece = await readFile(out);
        await rm(out, { force: true });
        if (piece.length > limit) throw new Error(`ffmpeg 切出的一段仍超过 ${provider} 的文件大小限制`);
        return { bytes: piece, seconds: length, ext: "flac" };
      },
    };
  } catch (error) { await cleanup(); throw error; }
}

const fixed = (pieces) => ({ count: pieces.length, load: async (index) => pieces[index], cleanup: async () => {} });
/**
 * How to send a chunk of audio to Groq, as a plan: `{ count, load(index) → { bytes, seconds, ext }, cleanup() }`, each piece
 * small enough for the file limit, or `{ error }` saying why it cannot be sent (then the next tier takes over).
 * `ffmpeg` is the ffmpeg to use for the formats that need one (undefined: look for it; null: there is none).
 */
export async function groqPlan({ bytes, kind, seconds = 0, limit = GROQ_FILE_LIMIT, ffmpeg, signal, provider = "Groq", limitLabel = "25 MB" }) {
  const ext = KINDS[kindOf(kind)], per = limit * 0.95;
  if (ext === "wav") {
    const info = wavInfo(bytes);
    if (!info) return { error: "读不出 WAV 文件头" };
    const small = toSpeechWav(bytes, info);
    const source = small ? { bytes: small, info: wavInfo(small) } : { bytes, info };
    if (source.bytes.length <= limit) return fixed([{ bytes: source.bytes, seconds: source.info.seconds || seconds, ext }]);
    const pieces = splitWavQuiet(source.bytes, source.info, Math.ceil(source.bytes.length / per), 20).map((piece) => ({ ...piece, ext }));
    return pieces.some((piece) => piece.bytes.length > limit) ? { error: `这段 WAV 切不到 ${provider} 的文件大小限制以内` } : fixed(pieces);
  }
  if (ext && bytes.length <= limit) return fixed([{ bytes, seconds, ext }]);
  if (ext === "mp3") {
    const whole = splitMp3(bytes, Infinity);
    if (!whole.seconds) return { error: "读不出 MP3 的音频帧" };
    const pieces = splitMp3(bytes, whole.seconds / Math.ceil(bytes.length / per)).chunks
      .map((chunk) => ({ bytes: bytes.subarray(chunk.start, chunk.end), seconds: chunk.seconds, ext }));
    return pieces.some((piece) => piece.bytes.length > limit) ? { error: `这段 MP3 切不到 ${provider} 的文件大小限制以内` } : fixed(pieces);
  }
  // Everything else needs a decoder to be cut (or to be read at all), except M4A: without ffmpeg its frames are
  // remuxed into smaller M4A files (audio-m4a.js), losslessly.
  const label = String(kind).replace(/^\./, "").toUpperCase();
  const command = ffmpeg === undefined ? await findFfmpeg() : ffmpeg;
  if (!command && ext === "m4a") {
    try {
      const pieces = splitM4aBySize(bytes, limit);
      if (pieces) return fixed(pieces.map((piece) => ({ bytes: piece.bytes, seconds: piece.seconds, ext })));
    } catch { /* not a plain M4A: the reason below */ }
  }
  if (!command) return { error: `${label} ${ext ? `超过 ${provider} 的 ${limitLabel} 限制，要切开需要 ffmpeg` : `不是 ${provider} 能直接读的格式，要转换需要 ffmpeg`}（这台电脑上没有找到），这一步先交给下一档` };
  return ffmpegPlan({ command, bytes, kind: kindOf(kind), limit, signal, provider });
}

export function multipart(fields, file) {
  const boundary = `----study${randomBytes(12).toString("hex")}`;
  const parts = Object.entries(fields).map(([name, value]) => Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${file.name}"\r\ncontent-type: ${file.type}\r\n\r\n`),
    file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** How long Groq asks us to wait, from the retry-after header or the "try again in 14m2.5s" of its message. */
export function retryAfterMs(response, body) {
  const header = Number(response?.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header * 1000);
  const text = /try again in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i.exec(String(body?.error?.message ?? ""));
  if (!text) return null;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  let total = 0;
  for (const [, amount, name] of text[1].matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) total += Number(amount) * unit[name];
  return total > 0 ? Math.round(total) : null;
}

/** ISO-639-1 language from the first configured code ("en-US" → "en"); Whisper detects the language when it is left out. */
const languageOf = (codes) => /^[a-z]{2}(?![a-z])/.exec(String(codes?.[0] ?? ""))?.[0] ?? "";
/** The vocabulary as Whisper's prompt (it reads at most 224 tokens), cut at a term boundary. */
export function whisperPrompt(vocabulary = []) {
  const text = vocabulary.join(", ");
  return text.length <= 300 ? text : text.slice(0, 300).replace(/,[^,]*$/, "");
}

async function transcribePiece(fetch, key, piece, { model, language, prompt, signal }) {
  const { body, contentType } = multipart({ model, response_format: "json", temperature: "0", ...(language ? { language } : {}), ...(prompt ? { prompt } : {}) },
    { name: `audio.${piece.ext}`, type: MIME[piece.ext], bytes: piece.bytes });
  const response = await fetch(`${GROQ_ORIGIN}/openai/v1/audio/transcriptions`, {
    method: "POST", signal, timeoutMs: Math.round(clamp(60_000 + (piece.seconds || 0) * 200, 120_000, 600_000)),
    headers: { authorization: `Bearer ${key}`, "content-type": contentType }, body,
    audioUsage: { model, stage: 'transcribe', seconds: piece.seconds },
  });
  const reply = await response.json().catch(() => ({}));
  return { status: response.status, body: reply, retryAfterMs: retryAfterMs(response, reply) };
}
/** A failure this provider cannot fix by trying again, in the shape GeminiTiers.request() reads (it moves on to the next tier). */
const unable = (message) => ({ status: 415, body: { error: { message: String(message).slice(0, 300) } } });
/**
 * The Groq attempt for one chunk of audio, as a function of the key for GeminiTiers.request(). It remembers the pieces
 * already done, so a rate-limit wait in the middle resumes at the next piece instead of sending the first ones again.
 * Call `.cleanup()` when the chunk is finished (it removes ffmpeg's temporary files).
 */
export function groqTranscriber({ fetch, model = GROQ_TRANSCRIBE_MODEL, bytes, kind, seconds, config = {}, signal, limit, ffmpeg }) {
  const texts = [];
  let plan, loaded;
  const run = async (key) => {
    if (!plan) {
      try { plan = await groqPlan({ bytes, kind, seconds, limit, ffmpeg, signal }); }
      catch (error) { if (signal?.aborted) throw error; return unable(error.message); }
    }
    if (plan.error) return unable(plan.error);
    const options = { model, language: languageOf(config.languageCodes), prompt: whisperPrompt(config.vocabulary), signal };
    while (texts.length < plan.count) {
      const index = texts.length;
      if (loaded?.index !== index) {
        try { loaded = { index, piece: await plan.load(index) }; }
        catch (error) { if (signal?.aborted) throw error; return unable(error.message); }
      }
      const result = await transcribePiece(fetch, key, loaded.piece, options);
      if (result.status < 200 || result.status >= 300) return result;
      texts.push(String(result.body?.text ?? "").trim());
      loaded = null;
    }
    return { status: 200, body: { text: texts.filter(Boolean).join(" ") }, requests: plan.count };
  };
  run.cleanup = async () => { await plan?.cleanup?.(); };
  return run;
}

/** The text of a chat-completions reply. */
export const chatText = (body) => String(body?.choices?.[0]?.message?.content ?? "");
/**
 * One system + user prompt answered as JSON by a Groq chat model. Groq answers a parameter it dislikes with a 400, so the
 * optional ones go in order: reasoning effort (only some models take it), then JSON mode, then a plain request.
 */
export async function groqChat({ fetch, key, model = GROQ_TEXT_MODEL, system, prompt, signal, reasoningEffort = 'low', stage }) {
  const forms = [];
  if (/gpt-oss/i.test(model) && ['low', 'medium', 'high'].includes(reasoningEffort)) forms.push({ reasoning_effort: reasoningEffort, response_format: { type: "json_object" } });
  forms.push({ response_format: { type: "json_object" } }, {});
  let last;
  for (const extra of forms) {
    const response = await fetch(`${GROQ_ORIGIN}/openai/v1/chat/completions`, {
      method: "POST", signal, timeoutMs: 4 * 60_000,
      audioUsage: { model, stage, reasoning: extra.reasoning_effort || 'default' },
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], ...extra }),
    });
    const body = await response.json().catch(() => ({}));
    last = { status: response.status, body, retryAfterMs: retryAfterMs(response, body), reasoning: extra.reasoning_effort || 'default' };
    if (response.status !== 400) return last;
  }
  return last;
}

/** Cheapest call that proves a key works. */
export async function groqCheck(fetch, key) {
  const response = await fetch(`${GROQ_ORIGIN}/openai/v1/models`, { timeoutMs: 30_000, headers: { authorization: `Bearer ${key}` } });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
