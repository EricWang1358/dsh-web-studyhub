import { readFile } from "node:fs/promises";
import { providerStatus } from "../../audio-preflight.js";
import { tiersFromSettings } from "../../gemini.js";
import { audioMessage, endMessage, FRAME_BYTES, SAMPLE_RATE } from "../../live-protocol.js";

/* A voice answer (#1031) is an input method: one short clip, transcribed once, and the text goes into the box the learner would have typed in.
   audio.clip.transcribe reads a finished upload (audio.upload.*), asks ONE tier — a configured cloud provider of 设置 › 音频转写, else the local
   live engine of 课堂实录 when it is installed (no key, nothing leaves the computer) — and deletes the raw audio on every path. */

/** The longest clip the server takes (the recorder, ui/voice/wav.js, stops at 90 s; a little slack for the header and rounding). */
const MAX_SECONDS = 90;
const SLACK_SECONDS = 2;

/** No tier for this clip. `reason` is the setup guide's (no-provider, or paid-missing when 只用付费密钥 is on and only free keys are set). */
const setupError = (reason) => Object.assign(new Error("还没有可用的语音转写：在「设置 › 音频转写」填一个转写服务，或在课堂实录里装好本地识别引擎"), { code: "AUDIO_SETUP", reason: reason || "no-provider" });

/** The PCM of a WAV clip: { rate, channels, bits, pcm, seconds }, or null when the bytes are not a plain PCM WAV. */
export function wavPcm(bytes) {
  if (!bytes || bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12, format = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt " && size >= 16) format = { tag: bytes.readUInt16LE(body), channels: bytes.readUInt16LE(body + 2), rate: bytes.readUInt32LE(body + 4), bits: bytes.readUInt16LE(body + 14) };
    if (id === "data") {
      if (!format || format.tag !== 1) return null;
      const pcm = bytes.subarray(body, Math.min(bytes.length, body + size));
      return { rate: format.rate, channels: format.channels, bits: format.bits, pcm, seconds: pcm.length / (format.rate * format.channels * (format.bits / 8)) };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** Finals of the local engine as one text: Chinese runs on, two Latin words keep a space between them. */
const joinFinals = (finals) => finals.reduce((text, part) => (text && /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(part) ? `${text} ${part}` : text + part), "").trim();

/** One clip on the local live engine: its socket speaks the Live wire format (lib/live-local.js), so the clip goes in as frames and the finals come out. */
export async function transcribeLocally(WebSocketImpl, pcm, { openTimeoutMs = 90_000 } = {}) {
  const socket = new WebSocketImpl("local://voice-answer");
  const finals = [];
  const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("本地识别引擎没有按时启动，请稍后再试")); }, openTimeoutMs);
    timer.unref?.();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.setupComplete) { clearTimeout(timer); resolve(); }
      const text = message.serverContent?.inputTranscription?.text;
      if (text) finals.push(text.trim());
    });
    closed.then((event) => { clearTimeout(timer); reject(new Error(event.reason || "本地识别引擎中断")); });
  });
  await opened;
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) socket.send(JSON.stringify(audioMessage(pcm.subarray(offset, offset + FRAME_BYTES))));
  socket.send(JSON.stringify(endMessage()));
  const { code, reason } = await closed;
  if (code !== 1000) throw new Error(reason || "本地识别引擎中断");
  return joinFinals(finals.filter(Boolean));
}

/**
 * Transcribe one uploaded voice clip and delete it. `uploads` is the audio context's registry; `local()` gives the local engine's socket class when
 * it is installed (lib/contexts/audio/install/live-local-runs.js), else null. `paidOnly`: the request's 只用付费密钥, like the other audio operations;
 * absent, the audio settings' default (paidOnlyByDefault). With it on, a free key is never sent the learner's voice. Returns { text, seconds, tier }.
 */
export async function transcribeClip({ root, uploadId, uploads, settings, fetch, language, local, paidOnly }) {
  let upload;
  try { upload = uploads.claimUpload(root, String(uploadId ?? "")); }
  catch (error) {
    // An upload that never finished (or is someone else's) is not kept for later: the clip is cancelled now, not left to the 24 h backstop.
    await uploads.cancelUpload(root, String(uploadId ?? "")).catch(() => {});
    throw error;
  }
  let bytes;
  try { bytes = await readFile(upload.path); }
  finally { await uploads.discardUpload(upload).catch(() => {}); } // the raw voice is never kept once it was read
  const wav = wavPcm(bytes);
  if (!bytes.length || (wav && !wav.pcm.length)) throw new Error("录音是空的，请重新录一次");
  const seconds = wav ? wav.seconds : bytes.length / 32000;
  if (seconds > MAX_SECONDS + SLACK_SECONDS) throw new Error(`语音回答最长 ${MAX_SECONDS} 秒，请分段说`);
  const paid = typeof paidOnly === "boolean" ? paidOnly : settings.paidOnlyByDefault === true;
  const status = providerStatus(settings, { paidOnly: paid });
  if (status.transcription) {
    const languageCodes = Array.isArray(settings.languageCodes) && settings.languageCodes.length ? settings.languageCodes : language === "en" ? ["en"] : ["zh", "en"];
    const tiers = tiersFromSettings(settings, { fetch, skipFree: paid });
    const result = await tiers.transcribe({ bytes, mimeType: "audio/wav", kind: ".wav", seconds: Math.max(1, Math.round(seconds)), config: { languageCodes } });
    return { text: String(result?.text ?? "").trim(), seconds, tier: "cloud" };
  }
  const WebSocketImpl = await local();
  if (!WebSocketImpl) throw setupError(status.reason);
  if (!wav || wav.rate !== SAMPLE_RATE || wav.channels !== 1 || wav.bits !== 16) throw new Error("本地识别只接受 16 kHz 单声道录音，请用页面上的录音按钮重新录");
  return { text: await transcribeLocally(WebSocketImpl, wav.pcm), seconds, tier: "local" };
}
