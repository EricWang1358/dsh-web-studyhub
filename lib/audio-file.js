import { open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseM4a, splitM4a } from "./audio-m4a.js";

/* Reading and splitting a local audio file. The transcribe model accepts at
   most one hour per request, so long MP3, WAV and M4A recordings are cut at frame
   boundaries into chunks (no re-encoding, no ffmpeg; M4A parts are remuxed by
   audio-m4a.js). Other formats go up as a single request. */

/** An error the pre-flight check can name: `code` says what kind of problem it is. */
export const audioError = (message, code) => Object.assign(new Error(message), { code });

export const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
export const MAX_AUDIO_SECONDS = 8 * 3600;
/** A request may carry an hour. Free quota is counted in requests, so a recording goes in as few parts as the limit
    allows: whole when it fits, otherwise the fewest equal parts. */
export const CHUNK_SECONDS = 59.5 * 60;
export const MIN_PART_SECONDS = 5 * 60;
export const REQUEST_LIMIT_SECONDS = 3600;
/** How many parts a recording of `seconds` is sent in, at most `limit` seconds each. */
export const partsFor = (seconds, limit = CHUNK_SECONDS) => Math.max(1, Math.ceil(seconds / Math.min(Math.max(limit, MIN_PART_SECONDS), CHUNK_SECONDS)));

const MIME = {
  ".mp3": "audio/mp3", ".wav": "audio/wav", ".m4a": "audio/m4a", ".aac": "audio/aac",
  ".ogg": "audio/ogg", ".flac": "audio/flac", ".opus": "audio/opus", ".webm": "audio/webm",
  ".aiff": "audio/aiff", ".aif": "audio/aiff",
};
export const AUDIO_EXTENSIONS = Object.keys(MIME);

const BITRATES = {
  "1:1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1:2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1:3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2:1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2:2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
BITRATES["2:3"] = BITRATES["2:2"];
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** MPEG audio frame header at `at`, or null when the bytes are not a plausible frame. */
export function mp3Frame(bytes, at) {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (bytes[at + 1] >> 3) & 3, layerBits = (bytes[at + 1] >> 1) & 3;
  if (versionBits === 1 || layerBits === 0) return null;
  const layer = 4 - layerBits, mpeg1 = versionBits === 3;
  const bitrateIndex = bytes[at + 2] >> 4, rateIndex = (bytes[at + 2] >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const bitrate = BITRATES[`${mpeg1 ? 1 : 2}:${layer}`][bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[versionBits][rateIndex], padding = (bytes[at + 2] >> 1) & 1;
  const samples = layer === 1 ? 384 : layer === 3 && !mpeg1 ? 576 : 1152;
  const length = layer === 1 ? (Math.floor(12 * bitrate / sampleRate) + padding) * 4
    : Math.floor((layer === 3 && !mpeg1 ? 72 : 144) * bitrate / sampleRate) + padding;
  return length > 4 ? { length, seconds: samples / sampleRate } : null;
}
/** Where audio starts once an ID3v2 tag is skipped. */
function mp3Start(bytes) {
  if (bytes.length > 10 && bytes.subarray(0, 3).toString("latin1") === "ID3")
    return 10 + ((bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f));
  return 0;
}

/**
 * Walk every MPEG frame once. Returns the total duration and the byte ranges
 * of chunks of about `chunkSeconds`, each starting on a frame boundary.
 */
export function splitMp3(bytes, chunkSeconds = CHUNK_SECONDS) {
  const chunks = [];
  let at = mp3Start(bytes), begin = -1, seconds = 0, total = 0, frames = 0, covered = 0, synced = false;
  const close = (end) => { if (begin >= 0 && end > begin) chunks.push({ start: begin, end, seconds }); begin = -1; seconds = 0; };
  while (at < bytes.length) {
    const frame = mp3Frame(bytes, at), next = frame && at + frame.length;
    // After junk, only believe a header that is followed by another frame (or by the end / an ID3v1 tag);
    // inside a run of frames every valid header counts.
    if (!frame || (!synced && next < bytes.length && !mp3Frame(bytes, next) && bytes.length - next > 128)) { synced = false; at++; continue; }
    synced = true;
    if (begin < 0) begin = at;
    else if (seconds >= chunkSeconds) { close(at); begin = at; }
    seconds += frame.seconds; total += frame.seconds; frames++; covered += frame.length;
    at = next;
  }
  close(Math.min(at, bytes.length));
  return { seconds: total, frames, covered, chunks };
}

/** What the bytes are, whatever the file is called; null when nothing recognisable is there. */
export function sniffAudio(bytes) {
  const at = (offset, text) => bytes.length >= offset + text.length && bytes.toString("latin1", offset, offset + text.length) === text;
  if (at(0, "RIFF") && at(8, "WAVE")) return ".wav";
  if (at(0, "FORM") && (at(8, "AIFF") || at(8, "AIFC"))) return ".aiff";
  if (at(0, "fLaC")) return ".flac";
  if (at(0, "OggS")) return bytes.subarray(0, 256).includes("OpusHead") ? ".opus" : ".ogg";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return ".webm";
  if (at(4, "ftyp")) return ".m4a";
  if (at(0, "ID3")) return ".mp3";
  // Bare MPEG audio and ADTS AAC share 11 sync bits; ADTS has layer bits 00.
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return (bytes[1] & 0x06) === 0 ? ".aac" : ".mp3";
  return null;
}
const KIND = { ".wav": "WAV", ".mp3": "MP3", ".m4a": "M4A / MP4", ".aac": "AAC", ".ogg": "OGG", ".opus": "Opus", ".flac": "FLAC", ".webm": "WebM", ".aiff": "AIFF" };
const SAME = [[".aif", ".aiff"], [".opus", ".ogg"]];
const alike = (a, b) => a === b || SAME.some((pair) => pair.includes(a) && pair.includes(b));

/** RIFF/WAVE header facts, or null when this is not a WAV file. */
export function wavInfo(bytes) {
  if (bytes.length < 44 || bytes.subarray(0, 4).toString("latin1") !== "RIFF" || bytes.subarray(8, 12).toString("latin1") !== "WAVE") return null;
  let at = 12, format = null;
  while (at + 8 <= bytes.length) {
    const id = bytes.subarray(at, at + 4).toString("latin1");
    const size = bytes.readUInt32LE(at + 4), body = at + 8;
    if (id === "fmt " && body + 16 <= bytes.length)
      format = { tag: bytes.readUInt16LE(body), channels: bytes.readUInt16LE(body + 2), sampleRate: bytes.readUInt32LE(body + 4),
        byteRate: bytes.readUInt32LE(body + 8), blockAlign: bytes.readUInt16LE(body + 12), bits: bytes.readUInt16LE(body + 14) };
    if (id === "data" && format) {
      // A streamed WAV may declare an unknown size; use what is actually there.
      const length = Math.min(size === 0xffffffff || size === 0 ? bytes.length - body : size, bytes.length - body);
      return { ...format, dataStart: body, dataLength: length, seconds: format.byteRate ? length / format.byteRate : 0 };
    }
    at = body + size + (size & 1);
  }
  return null;
}
/** A standalone WAV made of bytes [from, to) of the sample data, with its own 44-byte PCM header. */
function wavPiece(bytes, info, from, to) {
  const length = to - from, header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + length, 4); header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(info.tag === 0xfffe ? 1 : info.tag, 20); header.writeUInt16LE(info.channels, 22);
  header.writeUInt32LE(info.sampleRate, 24); header.writeUInt32LE(info.byteRate, 28); header.writeUInt16LE(info.blockAlign, 32);
  header.writeUInt16LE(info.bits, 34); header.write("data", 36, "latin1"); header.writeUInt32LE(length, 40);
  return { bytes: Buffer.concat([header, bytes.subarray(info.dataStart + from, info.dataStart + to)]), seconds: length / info.byteRate };
}
/** Fixed-size pieces of `chunkSeconds`. */
export function splitWav(bytes, info, chunkSeconds = CHUNK_SECONDS) {
  const per = Math.max(info.blockAlign, Math.floor(info.byteRate * chunkSeconds / info.blockAlign) * info.blockAlign);
  const chunks = [];
  for (let offset = 0; offset < info.dataLength; offset += per) chunks.push(wavPiece(bytes, info, offset, Math.min(offset + per, info.dataLength)));
  return chunks;
}
/**
 * `parts` pieces of about equal length. For 16-bit PCM each cut is moved to the quietest 200 ms within
 * `reach` seconds of where it would fall, so a sentence is not sliced through; other encodings are cut evenly.
 */
export function splitWavQuiet(bytes, info, parts, reach = 30) {
  const align = (n) => Math.floor(n / info.blockAlign) * info.blockAlign;
  const cuts = [0];
  const canListen = info.tag === 1 && info.bits === 16;
  const hopFrames = Math.max(1, Math.round(info.sampleRate * 0.1)), hopBytes = hopFrames * info.blockAlign;
  let energy = null;
  if (canListen) {
    const blocks = Math.floor(info.dataLength / hopBytes);
    energy = new Float64Array(blocks);
    for (let b = 0; b < blocks; b++) {
      let sum = 0;
      const base = info.dataStart + b * hopBytes;
      for (let at = base; at + 1 < base + hopBytes; at += 2) { const v = bytes.readInt16LE(at); sum += v * v; }
      energy[b] = sum / (hopBytes / 2);
    }
  }
  for (let part = 1; part < parts; part++) {
    let cut = align(Math.round(info.dataLength * part / parts));
    if (energy) {
      const centre = Math.floor(cut / hopBytes), span = Math.round(reach * 10);
      const low = Math.max(Math.floor(cuts.at(-1) / hopBytes) + 1, centre - span), high = Math.min(energy.length - 2, centre + span);
      let best = -1, quiet = Infinity;
      for (let b = low; b <= high; b++) { const level = energy[b] + energy[b + 1]; if (level < quiet) { quiet = level; best = b; } }
      if (best >= 0) cut = align((best + 1) * hopBytes);
    }
    cuts.push(cut);
  }
  cuts.push(info.dataLength);
  return cuts.slice(0, -1).map((from, i) => wavPiece(bytes, info, from, cuts[i + 1])).filter((piece) => piece.seconds > 0);
}

/** Duration from the movie header of an MP4/M4A file, or null if it cannot be found. */
export async function m4aSeconds(file, size) {
  let at = 0;
  const read = async (offset, length) => {
    const buffer = Buffer.alloc(length), { bytesRead } = await file.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  };
  while (at + 8 <= size) {
    const head = await read(at, 16);
    let boxSize = head.readUInt32BE(0), header = 8;
    if (boxSize === 1 && head.length >= 16) { boxSize = Number(head.readBigUInt64BE(8)); header = 16; }
    else if (boxSize === 0) boxSize = size - at;
    if (boxSize < header) return null;
    if (head.toString("latin1", 4, 8) === "moov") {
      const moov = await read(at + header, Math.min(boxSize - header, 32 * 1024 * 1024));
      const found = moov.indexOf("mvhd", 0, "latin1");
      if (found < 0) return null;
      const body = found + 4, version = moov[body];
      const timescale = moov.readUInt32BE(body + (version === 1 ? 20 : 12));
      const duration = version === 1 ? Number(moov.readBigUInt64BE(body + 24)) : moov.readUInt32BE(body + 16);
      return timescale ? duration / timescale : null;
    }
    at += boxSize;
  }
  return null;
}

/**
 * Read an explicitly supplied audio file and plan its chunks. Never fetches
 * URLs and refuses anything that is not a known audio extension.
 * `measureOnly` (the pre-flight check) reads and validates the same way but
 * builds no chunks and no hash: it returns `parts`, the number of requests.
 */
export async function loadAudio(input) {
  const measure = input?.measureOnly === true;
  if (typeof input?.path !== "string" || !path.isAbsolute(input.path)) throw audioError("音频文件路径必须是绝对路径", "AUDIO_PATH");
  const ext = path.extname(input.path).toLowerCase();
  if (!MIME[ext]) throw audioError(`不支持的音频格式 ${ext || "（无扩展名）"}；支持 ${AUDIO_EXTENSIONS.join("、")}`, "AUDIO_UNSUPPORTED");
  const filename = path.basename(input.path);
  let file;
  try { file = await open(input.path, "r"); }
  catch (error) { throw audioError(error.code === "ENOENT" ? "找不到这份音频文件，它可能已被移动或删除" : "读不了这份音频文件（没有权限或正被占用）", "AUDIO_UNREADABLE"); }
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw audioError("请选择一个音频文件", "AUDIO_UNREADABLE");
    if (stat.size > MAX_AUDIO_BYTES) throw audioError("音频超过 512 MB，请先压缩成 MP3 或按章节拆分", "AUDIO_TOO_LARGE");
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    bytes = bytes.subarray(0, offset);
  } finally { await file.close(); }
  if (!bytes.length) throw audioError("音频文件是空的", "AUDIO_EMPTY");
  const hash = measure ? null : createHash("sha256").update(bytes).digest("hex");
  // The name says what the learner hoped; the bytes say what it is. A WAV renamed .mp3 must be read as a WAV.
  const detected = sniffAudio(bytes), kind = detected && MIME[detected] ? detected : ext, warnings = [];
  if (detected && MIME[detected] && !alike(detected, ext))
    warnings.push(`文件扩展名是 ${ext}，实际内容是 ${KIND[detected]} 格式，已按 ${KIND[detected]} 处理`);
  const mimeType = MIME[kind], limit = Number(input.partSeconds) || CHUNK_SECONDS;
  let seconds = null, chunks, parts = 1;
  if (kind === ".mp3") {
    const split = splitMp3(bytes, Infinity);
    if (!split.chunks.length) throw audioError("没有在文件里找到可识别的 MP3 音频帧", "AUDIO_CORRUPT");
    const span = bytes.length - mp3Start(bytes);
    if (split.covered < span * 0.5) throw audioError(`文件里能识别的 MP3 音频只占 ${Math.round(split.covered / span * 100)}%，不像是有效的 MP3（可能被改过扩展名，或文件已损坏）`, "AUDIO_CORRUPT");
    seconds = split.seconds;
    // The first pass only measured; cut again into equal parts once the length is known.
    parts = partsFor(seconds, limit);
    const cut = parts > 1 && !measure ? splitMp3(bytes, seconds / parts) : split;
    chunks = cut.chunks.map((c) => ({ bytes: bytes.subarray(c.start, c.end), seconds: c.seconds }));
  } else if (kind === ".wav") {
    const info = wavInfo(bytes);
    if (!info) throw audioError("这不是有效的 WAV 文件", "AUDIO_CORRUPT");
    if (![1, 3, 0xfffe].includes(info.tag) && info.seconds > REQUEST_LIMIT_SECONDS)
      throw audioError("压缩编码的 WAV 超过 1 小时无法切分，请先转成 MP3", "AUDIO_UNSPLITTABLE");
    seconds = info.seconds;
    parts = [1, 3, 0xfffe].includes(info.tag) ? partsFor(seconds, limit) : 1;
    chunks = parts > 1 && !measure ? splitWavQuiet(bytes, info, parts) : [{ bytes, seconds }];
  } else if (kind === ".m4a") {
    // The sample table gives the exact length; a recording longer than one request is remuxed into M4A parts.
    let info = null, unreadable = null;
    try { info = parseM4a(bytes); } catch (error) { unreadable = error; }
    const memory = { read: async (buffer, offset, length, position) => ({ bytesRead: bytes.copy(buffer, offset, position, Math.min(bytes.length, position + length)) }) };
    seconds = info ? info.seconds : await m4aSeconds(memory, bytes.length);
    if (seconds && seconds > MAX_AUDIO_SECONDS) throw audioError("音频超过 8 小时，请先拆分", "AUDIO_TOO_LONG");
    parts = seconds ? partsFor(seconds, limit) : 1;
    if (parts > 1 && !info)
      throw audioError(`这份 M4A 约 ${Math.round(seconds / 60)} 分钟，超过单次转写的 1 小时上限，但它的内部结构不能在本地无损切分（${unreadable?.message || "结构不明"}）。请在录音软件里另存为 MP3 后再导入`, "AUDIO_UNSPLITTABLE");
    chunks = parts > 1 && !measure ? splitM4a(bytes, parts, info).map((part) => ({ bytes: part.bytes, seconds: part.seconds })) : [{ bytes, seconds: seconds || 0 }];
  } else {
    // Nothing to cut here: the provider checks the length of the formats that do not say it.
    chunks = [{ bytes, seconds: 0 }];
  }
  if (seconds && seconds > MAX_AUDIO_SECONDS) throw audioError("音频超过 8 小时，请先拆分", "AUDIO_TOO_LONG");
  if (measure) return { filename, ext: kind, declaredExt: ext, mimeType, seconds, parts, bytes: bytes.length, warnings };
  return { filename, ext: kind, declaredExt: ext, mimeType, hash, seconds, chunks, warnings };
}
