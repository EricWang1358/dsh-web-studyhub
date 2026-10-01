import { groqPlan, multipart, retryAfterMs } from "./groq.js";

/* SiliconFlow (硅基流动) as a free transcription tier: Gemini free key → SiliconFlow → Groq → Gemini paid key.

   SiliconFlow is an official API reachable from mainland China without a proxy. Its speech endpoint is OpenAI-shaped
   (POST /v1/audio/transcriptions, multipart `file` + `model`) and answers only { "text": "…" }: no segments, no
   timestamps, no prompt or vocabulary. FunAudioLLM/SenseVoiceSmall is free. A file may be at most 50 MB and one
   hour long, so a chunk that is bigger is cut into pieces with the same plan as Groq's (WAV at speech rate and cut at
   pauses, MP3 on frame boundaries, M4A remuxed without ffmpeg, other formats through ffmpeg when it is installed).
   It is used for transcription only; proofreading, translation and titles never go here.
   Nothing here logs or returns a key; it only travels in the Authorization header of requests to api.siliconflow.cn. */

export const SILICONFLOW_ORIGIN = "https://api.siliconflow.cn";
export const SILICONFLOW_TRANSCRIBE_MODEL = "FunAudioLLM/SenseVoiceSmall";
/** The documented limit is 50 MB per file; stay clear of it (the multipart wrapper adds a little). */
export const SILICONFLOW_FILE_LIMIT = 48_000_000;
/** And one hour per file. A chunk never exceeds 59.5 minutes (audio-file.js), so this only guards odd inputs. */
export const SILICONFLOW_SECONDS_LIMIT = 3600;

const MIME = { wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", webm: "audio/webm" };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

async function transcribePiece(fetch, key, piece, { model, signal }) {
  const { body, contentType } = multipart({ model }, { name: `audio.${piece.ext}`, type: MIME[piece.ext] || "application/octet-stream", bytes: piece.bytes });
  const response = await fetch(`${SILICONFLOW_ORIGIN}/v1/audio/transcriptions`, {
    method: "POST", signal, timeoutMs: Math.round(clamp(60_000 + (piece.seconds || 0) * 150, 120_000, 600_000)),
    headers: { authorization: `Bearer ${key}`, "content-type": contentType }, body,
    audioUsage: { model, stage: "transcribe", seconds: piece.seconds },
  });
  const reply = await response.json().catch(() => ({}));
  // SiliconFlow puts its reason in `message`; the tier logic reads `error.message`, as Google and Groq send it.
  const normal = reply && typeof reply === "object" && !reply.error && reply.message ? { ...reply, error: { message: String(reply.message) } } : reply;
  return { status: response.status, body: normal, retryAfterMs: retryAfterMs(response, normal) };
}
/** A failure this provider cannot fix by trying again, in the shape GeminiTiers.request() reads (it moves on). */
const unable = (message) => ({ status: 415, body: { error: { message: String(message).slice(0, 300) } } });

/**
 * The SiliconFlow attempt for one chunk of audio, as a function of the key for GeminiTiers.request(). Like Groq's, it
 * remembers the pieces already done, so a rate-limit wait in the middle resumes at the next piece. Call `.cleanup()`
 * when the chunk is finished.
 */
export function siliconflowTranscriber({ fetch, model = SILICONFLOW_TRANSCRIBE_MODEL, bytes, kind, seconds, signal, limit = SILICONFLOW_FILE_LIMIT, ffmpeg }) {
  const texts = [];
  let plan, loaded;
  const run = async (key) => {
    if (!plan) {
      try { plan = await groqPlan({ bytes, kind, seconds, limit, ffmpeg, signal, provider: "硅基流动", limitLabel: "50 MB" }); }
      catch (error) { if (signal?.aborted) throw error; return unable(error.message); }
    }
    if (plan.error) return unable(plan.error);
    while (texts.length < plan.count) {
      const index = texts.length;
      if (loaded?.index !== index) {
        try { loaded = { index, piece: await plan.load(index) }; }
        catch (error) { if (signal?.aborted) throw error; return unable(error.message); }
      }
      if (loaded.piece.seconds > SILICONFLOW_SECONDS_LIMIT) return unable("这一段超过硅基流动单个文件 1 小时的上限");
      const result = await transcribePiece(fetch, key, loaded.piece, { model, signal });
      if (result.status < 200 || result.status >= 300) return result;
      texts.push(String(result.body?.text ?? "").trim());
      loaded = null;
    }
    return { status: 200, body: { text: texts.filter(Boolean).join(" ") }, requests: plan.count };
  };
  run.cleanup = async () => { await plan?.cleanup?.(); };
  return run;
}

/** Proves a key works without transcribing anything: the OpenAI-compatible model list answers 401 to a bad key.
    (The account endpoint /v1/user/info answers 410 "deprecated" to valid keys since October 2026.) */
export async function siliconflowCheck(fetch, key) {
  const response = await fetch(`${SILICONFLOW_ORIGIN}/v1/models`, { timeoutMs: 30_000, headers: { authorization: `Bearer ${key}` } });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body: body && !body.error && body.message ? { ...body, error: { message: String(body.message) } } : body };
}
