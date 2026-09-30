/* Wire format of the Gemini Live API used for streaming transcription
   (gemini-3.5-transcribe-live). Pure functions only: the session in live.js
   owns sockets and timing.

   Verified against a real handshake: the endpoint accepts a WebSocket, and a
   bad key is refused with close code 1007 "API key not valid". The message
   shapes below follow Google's live-transcribe guide (setup with
   inputAudioTranscription, realtimeInput audio of 16 kHz 16-bit PCM,
   inputTranscription for finals and interimInputTranscription for partials).
   The parser accepts camelCase and snake_case, nested in serverContent or at
   the top level, as an object with `text` or as a plain string. */

export const LIVE_ENDPOINT = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
export const LIVE_MODEL = "gemini-3.5-transcribe-live";
export const SAMPLE_RATE = 16000;
/** 16-bit mono: bytes per millisecond of audio. */
export const BYTES_PER_MS = SAMPLE_RATE * 2 / 1000;
/** The guide asks for chunks of about 100 ms. */
export const FRAME_BYTES = 100 * BYTES_PER_MS;
/** Live transcription sessions last at most 10 minutes; hand over a little before. */
export const SESSION_LIMIT_MS = 10 * 60 * 1000;
/** Published price: $0.005/min audio in + $0.004/min text out. */
export const LIVE_USD_PER_MINUTE = 0.009;

export const liveUrl = (key) => `${LIVE_ENDPOINT}?key=${encodeURIComponent(key)}`;

export function setupMessage({ model = LIVE_MODEL, languageCodes = [], vocabulary = [] } = {}) {
  return { setup: {
    model: `models/${model}`,
    generationConfig: { responseModalities: ["TEXT"] },
    inputAudioTranscription: {
      languageCodes,
      ...(vocabulary.length ? { customVocabulary: vocabulary.slice(0, 100) } : {}),
      mode: "VERBATIM",
    },
  } };
}
export const audioMessage = (bytes) => ({ realtimeInput: { audio: { data: Buffer.from(bytes).toString("base64"), mimeType: `audio/pcm;rate=${SAMPLE_RATE}` } } });
export const endMessage = () => ({ realtimeInput: { audioStreamEnd: true } });

/** Split PCM into frames of about 100 ms; the tail shorter than a frame is returned as `rest`. */
export function frames(buffer, size = FRAME_BYTES) {
  const whole = Math.floor(buffer.length / size) * size, list = [];
  for (let at = 0; at < whole; at += size) list.push(buffer.subarray(at, at + size));
  return { frames: list, rest: buffer.subarray(whole) };
}

const pick = (source, names) => {
  for (const name of names) if (source && source[name] !== undefined && source[name] !== null) return source[name];
  return undefined;
};
const textOf = (value) => (typeof value === "string" ? value : typeof value?.text === "string" ? value.text : "");

/** Text of a WebSocket frame: the Live API sends JSON as text or as a binary frame. */
export async function frameText(data) {
  if (typeof data === "string") return data;
  if (data && typeof data.text === "function") return data.text();
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  return "";
}

/**
 * One server message → what the session cares about. `keys` lists the top
 * level and serverContent keys, so a message the parser does not understand
 * can still be reported (names only, never contents).
 */
export function parseServerMessage(text) {
  let message;
  try { message = JSON.parse(text); } catch { return { ignored: true, keys: [] }; }
  if (!message || typeof message !== "object") return { ignored: true, keys: [] };
  const nested = message.serverContent ?? message.server_content;
  const content = nested && typeof nested === "object" ? nested : message;
  const keys = [...new Set([...Object.keys(message), ...(content === message ? [] : Object.keys(content).map((k) => `serverContent.${k}`))])];
  const final = textOf(pick(content, ["inputTranscription", "input_transcription"]));
  const interim = textOf(pick(content, ["interimInputTranscription", "interim_input_transcription"]));
  const goAway = pick(message, ["goAway", "go_away"]);
  const failure = pick(message, ["error"]);
  return {
    keys,
    setupComplete: pick(message, ["setupComplete", "setup_complete"]) !== undefined,
    ...(final ? { final } : {}),
    ...(interim ? { interim } : {}),
    turnComplete: !!pick(content, ["turnComplete", "turn_complete"]),
    ...(goAway !== undefined ? { goAway: String(goAway?.timeLeft ?? goAway?.time_left ?? "") } : {}),
    ...(failure ? { error: String(failure.message || failure).slice(0, 300) } : {}),
  };
}

/** Why a connection closed, in terms the tier logic acts on. */
export function classifyClose(code, reason = "") {
  const text = String(reason).slice(0, 300);
  if (/API key|API_KEY|permission|not supported|location/i.test(text) || code === 1007 && /key/i.test(text))
    return { kind: "key", message: text || "密钥被拒绝" };
  if (/quota|RESOURCE_EXHAUSTED|rate.?limit|exceeded|too many/i.test(text))
    return { kind: "quota", scope: /day|daily/i.test(text) ? "day" : "minute", message: text || "额度用完或被限流" };
  return { kind: "other", message: text || `连接关闭（${code}）` };
}
