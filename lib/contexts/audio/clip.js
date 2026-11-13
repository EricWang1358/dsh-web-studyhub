import { readFile } from "node:fs/promises";
import path from "node:path";
import { AUDIO_MIME } from "../../audio-formats.js";
import { KEY_FIELDS } from "../../audio-providers.js";
import { tiersFromSettings } from "../../gemini.js";

const UPLOAD_ID = /^[\w-]{8,64}$/;

/** Estimate clip duration in seconds from a WAV header's byte rate, or fall back to 16kHz Int16 mono sizing. */
export function wavDurationSeconds(bytes) {
  if (!bytes?.length) return 1;
  if (bytes.length >= 44 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") {
    const byteRate = bytes.readUInt32LE(28);
    if (byteRate > 0) return Math.max(1, Math.round((bytes.length - 44) / byteRate));
  }
  return Math.max(1, Math.round(bytes.length / 32000));
}

export function hasTranscribeKey(settings) {
  return KEY_FIELDS.some((field) => String(settings?.[field] || "").trim().length > 0);
}

/**
 * Transcribe one uploaded short voice clip (for review answers or help questions) and discard its raw audio file right away.
 */
export async function transcribeUploadedClip({ root, uploadId, uploads, readSettings, fetch, resources, gateway, language, vocabulary, signal }) {
  if (typeof uploadId !== "string" || !UPLOAD_ID.test(uploadId)) throw new Error("无效的语音上传编号");
  const upload = uploads.claimUpload(root, uploadId);
  let bytes;
  const ext = path.extname(upload.name || ".wav").toLowerCase() || ".wav";
  try {
    bytes = await readFile(upload.path);
  } finally {
    // Raw voice audio is never retained after reading it for transcription.
    await uploads.discardUpload(upload).catch(() => {});
  }
  if (!bytes?.length) throw new Error("录音内容为空，请重新录制");
  const settings = await readSettings();
  if (!hasTranscribeKey(settings)) {
    throw new Error("当前还没有可用的语音转写密钥，请在「设置 › 音频转写」配置转写服务");
  }
  const mimeType = AUDIO_MIME[ext] || "audio/wav";
  const seconds = ext === ".wav" ? wavDurationSeconds(bytes) : Math.max(1, Math.round(bytes.length / 24000));
  const languageCodes = Array.isArray(settings?.languageCodes) && settings.languageCodes.length
    ? settings.languageCodes
    : language === "en" ? ["en"] : ["zh", "en"];
  const terms = Array.isArray(vocabulary) ? vocabulary.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 60) : [];
  const tiers = tiersFromSettings(settings, { fetch, skipFree: settings.paidOnly === true, resources, gateway });
  const result = await tiers.transcribe({
    bytes, mimeType, kind: ext, seconds,
    config: { languageCodes, ...(terms.length ? { vocabulary: terms } : {}) },
    signal,
  });
  return { text: String(result?.text || "").trim(), seconds };
}
