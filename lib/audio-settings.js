import { parseStoredJson } from "./util.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GROQ_TEXT_MODEL, GROQ_TRANSCRIBE_MODEL } from "./groq.js";
import { SILICONFLOW_TRANSCRIBE_MODEL } from "./siliconflow.js";
import { LIVE_TRANSLATE_MODEL, TEXT_MODEL, TRANSCRIBE_MODEL } from "./gemini.js";
import { LIVE_MODEL } from "./live-protocol.js";
import { AUDIO_PROVIDERS, KEY_FIELDS } from "./audio-providers.js";

/* Audio settings live in the user's DSH home, next to the shared board, not in
   the study library: the library is exported, backed up and shown to the
   panel, and an API key must appear in none of those. Environment variables
   (the provider's `envVar` in audio-providers.js) fill in a key the file lacks. */

/** Where the keys really live: the DSH user directory (DSH_HOME when it is set). */
export const audioSettingsPath = () => join(process.env.DSH_HOME?.trim() || join(homedir(), ".dsh"), "study", "audio.json");
const settingsPath = audioSettingsPath;
/** The keys, one per transcription provider, in the order requests try them. */
export { KEY_FIELDS };

export const AUDIO_DEFAULTS = Object.freeze({
  ...Object.fromEntries(KEY_FIELDS.map((field) => [field, ""])),
  groqTranscribeModel: GROQ_TRANSCRIBE_MODEL, groqTextModel: GROQ_TEXT_MODEL, siliconflowTranscribeModel: SILICONFLOW_TRANSCRIBE_MODEL,
  transcribeModel: TRANSCRIBE_MODEL, textModel: TEXT_MODEL, liveModel: LIVE_MODEL, liveTranslateModel: LIVE_TRANSLATE_MODEL,
  // "auto": the conversation model when there is one, Gemini otherwise. Only transcription needs Gemini.
  textProvider: "auto", mode: "SMART", languageCodes: [], partMinutes: 59,
  liveCorrectionReasoning: 'low',
  // Recordings are serial; a single recording uses two or three text children.
  audioConcurrency: 1, textConcurrency: 3,
  proofreadReasoning: 'default', translateReasoning: 'low', dailyLimits: {},
});
export const MAX_AUDIO_JOBS = 6;

// AI Studio auth keys can contain dots and exceed the legacy key length.
// Check only token-shaped input here; Google determines whether a key is valid.
const KEY = /^[\w.+/=-]{20,4096}$/, MODEL = /^[\w.-]{2,80}$/, GROQ_MODEL = /^[\w./-]{2,80}$/, LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

async function readFileSettings() {
  try {
    const value = parseStoredJson(await readFile(settingsPath(), "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
/** Effective settings, keys included. Never send this object to a panel or a model. */
export async function readAudioSettings() {
  const file = await readFileSettings();
  const merged = { ...AUDIO_DEFAULTS, ...file };
  merged.audioConcurrency = 1;
  merged.textConcurrency = [2, 3].includes(file.textConcurrency) ? file.textConcurrency : AUDIO_DEFAULTS.textConcurrency;
  for (const { keyField, envVar } of AUDIO_PROVIDERS) merged[keyField] = String(file[keyField] || process.env[envVar] || "").trim();
  return merged;
}
const hint = (key) => (key ? `••••${key.slice(-4)}` : "");
/** What the panel may see: whether each key is set and its last four characters, and where the file is. */
export function publicAudioSettings(settings) {
  const shown = (key) => ({ set: !!key, hint: hint(key) }), rest = { ...settings };
  for (const field of KEY_FIELDS) delete rest[field];
  return { ...rest, ...Object.fromEntries(KEY_FIELDS.map((field) => [field, shown(settings[field])])), settingsFile: settingsPath() };
}
/* Learner-facing reasons, in plain words: no environment variables, no field names. */
export const NO_TRANSCRIPTION_KEY = "还没有配置转写服务：请在「设置 › 音频转写」里填一个密钥（推荐硅基流动：免费、国内直连）。不要把密钥贴到对话里";
export const NO_PAID_KEY = "选择了只用付费密钥，但还没有配置付费密钥";
export const LIVE_NEEDS_GEMINI = "课堂实录的实时转写只支持 Gemini：请在「设置 › 音频转写」里填写 Gemini 密钥（需要海外网络），不要贴到对话里";
/** Whether any transcription provider has a key (respecting "paid only"). */
export const hasTranscriptionKey = (settings, { paidOnly = false } = {}) =>
  paidOnly ? !!settings.paidKey : KEY_FIELDS.some((field) => !!settings[field]);
/**
 * Change settings. A key left out (or undefined) stays as it is, an empty
 * string clears it, anything else replaces it.
 */
export async function saveAudioSettings(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("设置必须是对象");
  const file = await readFileSettings(), next = { ...file, audioConcurrency: 1 };
  if (patch.textConcurrency !== undefined) {
    if (![2, 3].includes(patch.textConcurrency)) throw new Error('单条录音的校对与翻译并发数应是 2 或 3');
    next.textConcurrency = patch.textConcurrency;
  }
  for (const field of ['proofreadReasoning', 'translateReasoning']) {
    if (patch[field] === undefined) continue;
    if (!['default', 'low', 'medium', 'high'].includes(patch[field])) throw new Error('推理强度应为 default、low、medium 或 high');
    next[field] = patch[field];
  }
  if (patch.dailyLimits !== undefined) {
    if (!patch.dailyLimits || typeof patch.dailyLimits !== 'object' || Array.isArray(patch.dailyLimits)) throw new Error('每日额度应为模型与请求数的对应表');
    const limits = {};
    for (const [model, limit] of Object.entries(patch.dailyLimits)) {
      if (!MODEL.test(model) || !Number.isInteger(limit) || limit < 0 || limit > 1000000000) throw new Error('每日额度应为有效模型及非负整数');
      if (limit) limits[model] = limit;
    }
    next.dailyLimits = limits;
  }
  for (const field of KEY_FIELDS) {
    if (patch[field] === undefined) continue;
    const value = String(patch[field]).trim();
    if (value && !KEY.test(value)) throw new Error("API 密钥格式不对，请重新复制服务商页面里的完整密钥");
    if (value) next[field] = value; else delete next[field];
  }
  for (const field of ["transcribeModel", "textModel", "liveModel", "liveTranslateModel"]) {
    if (patch[field] === undefined) continue;
    const value = String(patch[field]).trim();
    if (value && !MODEL.test(value)) throw new Error("模型名称只能包含字母、数字、点、下划线和连字符");
    if (value) next[field] = value; else delete next[field];
  }
  for (const field of ["groqTranscribeModel", "groqTextModel", "siliconflowTranscribeModel"]) {
    if (patch[field] === undefined) continue;
    const value = String(patch[field]).trim();
    if (value && !GROQ_MODEL.test(value)) throw new Error(field.startsWith("groq") ? "Groq 模型名称只能包含字母、数字、点、下划线、连字符和斜杠" : "模型名称只能包含字母、数字、点、下划线、连字符和斜杠");
    if (value) next[field] = value; else delete next[field];
  }
  if (patch.textProvider !== undefined) {
    if (!["auto", "gemini", "host"].includes(patch.textProvider)) throw new Error("textProvider 只能是 auto、gemini 或 host");
    next.textProvider = patch.textProvider;
  }
  if (patch.liveCorrectionReasoning !== undefined) {
    if (!['low', 'default'].includes(patch.liveCorrectionReasoning)) throw new Error('校正推理强度只能是 low 或 default');
    next.liveCorrectionReasoning = patch.liveCorrectionReasoning;
  }
  if (patch.mode !== undefined) {
    if (!["SMART", "VERBATIM"].includes(patch.mode)) throw new Error("mode 只能是 SMART 或 VERBATIM");
    next.mode = patch.mode;
  }
  if (patch.partMinutes !== undefined) {
    const minutes = Number(patch.partMinutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 59) throw new Error("每次请求最长的分钟数应是 5 到 59 的整数");
    next.partMinutes = minutes;
  }
  if (patch.audioConcurrency !== undefined) {
    const count = Number(patch.audioConcurrency);
    if (!Number.isInteger(count) || count < 1 || count > MAX_AUDIO_JOBS) throw new Error(`同时处理的录音数应是 1 到 ${MAX_AUDIO_JOBS} 的整数`);
    next.audioConcurrency = 1; // Old clients may still send their former setting.
  }
  if (patch.languageCodes !== undefined) {
    const codes = Array.isArray(patch.languageCodes) ? patch.languageCodes.map((c) => String(c).trim()).filter(Boolean) : null;
    if (!codes || codes.length > 5 || codes.some((c) => !LANGUAGE.test(c))) throw new Error("languageCodes 应是至多 5 个语言代码，例如 [\"en-US\"]");
    next.languageCodes = codes;
  }
  const target = settingsPath(), temp = `${target}.${randomUUID()}.tmp`;
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(temp, JSON.stringify({ version: 1, ...next }, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
  return readAudioSettings();
}
