import { open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseM4a, splitM4a } from "./audio-m4a.js";
import { opusPacketSamples, parseOgg, splitOgg } from "./audio-ogg.js";
import { headerSeconds } from "./audio-headers.js";
import { AUDIO_MIME as MIME, AUDIO_EXTENSIONS, MAX_AUDIO_BYTES, REQUEST_LIMIT_MINUTES } from "./audio-formats.js";

/* Reading and splitting a local audio file. One transcription request takes at most CHUNK_SECONDS of audio, so long
   MP3, WAV, M4A and Ogg (Opus, Vorbis) recordings are cut at frame or page boundaries into chunks (no re-encoding, no
   ffmpeg; M4A parts are remuxed by audio-m4a.js, Ogg parts by audio-ogg.js). The other formats (FLAC, AIFF, AAC,
   WebM) go up whole when they fit one request; a longer one is cut with ffmpeg when it is installed
   (audio-ffmpeg-cut.js) and refused before anything is sent when it is not. */

/** An error the pre-flight check can name: `code` says what kind of problem it is. */
export const audioError = (message, code) => Object.assign(new Error(message), { code });

export { MAX_AUDIO_BYTES, AUDIO_EXTENSIONS };
export const MAX_AUDIO_SECONDS = 8 * 3600;
/** The transcribe model (gemini-3.5-transcribe) refuses a request over 98,304 input tokens ("The input token count
    exceeds the maximum number of tokens allowed 98304"), and Gemini counts audio at 32 tokens a second, whatever the
    format or bitrate: at most 51.2 minutes of audio. */
const TRANSCRIBE_INPUT_TOKENS = 98_304;
const AUDIO_TOKENS_PER_SECOND = 32;
/** So a request carries at most 45 minutes (86,400 tokens), which leaves room for the vocabulary and the instructions.
    Free quota is counted in requests, so a recording goes in as few parts as the limit allows: whole when it fits,
    otherwise the fewest equal parts. The learner's 「每次请求最长」 can only lower it. */
export const CHUNK_SECONDS = REQUEST_LIMIT_MINUTES * 60;
// A change of REQUEST_LIMIT_MINUTES (lib/audio-formats.js) that would bring back the rejected requests fails at once.
if (CHUNK_SECONDS * AUDIO_TOKENS_PER_SECOND > TRANSCRIBE_INPUT_TOKENS * 0.9) throw new Error("REQUEST_LIMIT_MINUTES leaves no room under the transcribe model's input-token limit");
export const MIN_PART_SECONDS = 5 * 60;
/** A file whose length cannot be read is taken to be over the limit when it is bigger than CHUNK_SECONDS at 192 kbps. */
const UNKNOWN_BYTES_PER_SECOND = 24_000;
/** How many parts a recording of `seconds` is sent in, at most `limit` seconds each. */
export const partsFor = (seconds, limit = CHUNK_SECONDS) => Math.max(1, Math.ceil(seconds / Math.min(Math.max(limit, MIN_PART_SECONDS), CHUNK_SECONDS)));


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
const KIND = { ".wav": "WAV", ".mp3": "MP3", ".m4a": "M4A / MP4", ".aac": "AAC", ".ogg": "OGG", ".opus": "Opus", ".flac": "FLAC", ".webm": "WebM", ".aiff": "AIFF", ".aif": "AIFF" };
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

const LIMIT_MINUTES = CHUNK_SECONDS / 60;
const TO_MP3 = "请先另存为 MP3 再导入（MP3 会在本地无损切开），或安装 ffmpeg 后重试";
/**
 * Why a recording in a format StudyHub cannot cut itself cannot go up in one request, or null when it fits. `seconds`
 * is its length when known; otherwise `size` (bytes) decides, against CHUNK_SECONDS at 192 kbps. `reason` says why the
 * length is unknown. The text is for when ffmpeg is missing: with ffmpeg the recording is cut instead.
 */
export function tooLongToSend({ kind, seconds, size, reason }) {
  const label = KIND[kind] || String(kind).replace(/^\./, "").toUpperCase();
  if (seconds) return seconds <= CHUNK_SECONDS ? null
    : `这份 ${label} 约 ${Math.round(seconds / 60)} 分钟，超过单次转写的 ${LIMIT_MINUTES} 分钟上限；这种格式要切开需要 ffmpeg，这台电脑上没有找到。${TO_MP3}`;
  return size <= CHUNK_SECONDS * UNKNOWN_BYTES_PER_SECOND ? null
    : `这份 ${label} 读不出时长${reason ? `（${reason}）` : ""}，按大小（${(size / 1048576).toFixed(1)} MB）估计超过单次转写的 ${LIMIT_MINUTES} 分钟上限；这种格式要切开需要 ffmpeg，这台电脑上没有找到。${TO_MP3}`;
}
/** Read up to `length` bytes from `file` starting at `offset` without loading the whole file. */
async function readRange(file, offset, length) {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, offset + filled);
    if (!bytesRead) break;
    filled += bytesRead;
  }
  return filled === length ? buffer : buffer.subarray(0, filled);
}

/** Walk MPEG frames in a fixed-size sliding buffer (256 KB) for measureOnly preflight without loading up to 512 MB into RAM. */
export async function scanMp3File(file, size) {
  const head = await readRange(file, 0, Math.min(size, 10));
  const start = mp3Start(head);
  const WINDOW = 256 * 1024, LOOKAHEAD = 8192;
  const buf = Buffer.allocUnsafe(Math.min(WINDOW, Math.max(16, size - start)));
  let winStart = start, bufLen = 0, at = 0;
  const refill = async () => {
    if (at > 0 && at < bufLen) buf.copy(buf, 0, at, bufLen);
    winStart += at;
    bufLen = Math.max(0, bufLen - at);
    at = 0;
    while (bufLen < buf.length && winStart + bufLen < size) {
      const want = Math.min(buf.length - bufLen, size - (winStart + bufLen));
      const { bytesRead } = await file.read(buf, bufLen, want, winStart + bufLen);
      if (!bytesRead) break;
      bufLen += bytesRead;
    }
  };
  let total = 0, frames = 0, covered = 0, synced = false;
  if (start < size) await refill();
  while (winStart + at < size) {
    if ((at >= bufLen || bufLen - at < LOOKAHEAD) && winStart + bufLen < size) await refill();
    if (at >= bufLen) break;
    const view = buf.subarray(0, bufLen);
    const frame = mp3Frame(view, at), next = frame && at + frame.length;
    const remainingAfterNext = frame ? size - (winStart + next) : 0;
    if (!frame || (!synced && next < bufLen && !mp3Frame(view, next) && remainingAfterNext > 128)) {
      synced = false; at++; continue;
    }
    synced = true;
    total += frame.seconds; frames++; covered += frame.length;
    at = next;
  }
  return { start, seconds: total, frames, covered };
}

/** Stream-read RIFF/WAVE chunk headers only (skipping the sample payload) for measureOnly preflight. */
export async function wavInfoFromFile(file, size) {
  if (size < 44) return null;
  const riff = await readRange(file, 0, 12);
  if (riff.length < 12 || riff.subarray(0, 4).toString("latin1") !== "RIFF" || riff.subarray(8, 12).toString("latin1") !== "WAVE") return null;
  let at = 12, format = null;
  while (at + 8 <= size) {
    const chunk = await readRange(file, at, 8);
    if (chunk.length < 8) break;
    const id = chunk.subarray(0, 4).toString("latin1");
    const chunkSize = chunk.readUInt32LE(4), body = at + 8;
    if (id === "fmt " && body + 16 <= size) {
      const fmt = await readRange(file, body, 16);
      if (fmt.length >= 16)
        format = { tag: fmt.readUInt16LE(0), channels: fmt.readUInt16LE(2), sampleRate: fmt.readUInt32LE(4),
          byteRate: fmt.readUInt32LE(8), blockAlign: fmt.readUInt16LE(12), bits: fmt.readUInt16LE(14) };
    }
    if (id === "data" && format) {
      const length = Math.min(chunkSize === 0xffffffff || chunkSize === 0 ? size - body : chunkSize, size - body);
      return { ...format, dataStart: body, dataLength: length, seconds: format.byteRate ? length / format.byteRate : 0 };
    }
    at = body + chunkSize + (chunkSize & 1);
  }
  return null;
}

/** Parse sub-boxes inside an in-memory MP4 container buffer (used for moov during measureOnly). */
function mp4ChildBoxes(bytes, from, to) {
  const list = [];
  for (let at = from; at + 8 <= to;) {
    let boxSize = bytes.readUInt32BE(at), header = 8;
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (boxSize === 1) {
      if (at + 16 > to) throw new Error(`${type} 的长度不完整`);
      boxSize = Number(bytes.readBigUInt64BE(at + 8)); header = 16;
    } else if (boxSize === 0) boxSize = to - at;
    if (boxSize < header || at + boxSize > to) throw new Error(`${type} 超出了文件或上一层`);
    list.push({ type, start: at, body: at + header, end: at + boxSize });
    at += boxSize;
  }
  return list;
}

/** Stream-probe an M4A/MP4 file: walks top-level box headers (never reading mdat) and inspects only the moov metadata box. */
async function measureM4aFile(file, size) {
  try {
    if (size < 16) throw new Error("开头没有 ftyp");
    const first = await readRange(file, 0, 8);
    if (first.length < 8 || first.toString("latin1", 4, 8) !== "ftyp") throw new Error("开头没有 ftyp");
    let at = 0, moovBox = null;
    while (at + 8 <= size) {
      const head = await readRange(file, at, Math.min(16, size - at));
      if (head.length < 8) break;
      let boxSize = head.readUInt32BE(0), header = 8;
      const type = head.toString("latin1", 4, 8);
      if (boxSize === 1) {
        if (head.length < 16) throw new Error(`${type} 的长度不完整`);
        boxSize = Number(head.readBigUInt64BE(8)); header = 16;
      } else if (boxSize === 0) boxSize = size - at;
      if (boxSize < header || at + boxSize > size) throw new Error(`${type} 超出了文件或上一层`);
      if (type === "moof") throw new Error("这份 M4A 是分片格式（fragmented MP4），不能在本地无损切分");
      if (type === "moov" && !moovBox) moovBox = { body: at + header, len: boxSize - header };
      at += boxSize;
    }
    if (!moovBox) throw new Error("缺少 moov");
    if (moovBox.len > 32 * 1024 * 1024) throw new Error("moov 过大");
    const moov = await readRange(file, moovBox.body, moovBox.len);
    const find = (parent, type) => mp4ChildBoxes(moov, parent.body, parent.end).find((b) => b.type === type);
    const need = (box, what) => { if (!box) throw new Error(`缺少 ${what}`); return box; };
    const root = { body: 0, end: moov.length };
    if (find(root, "mvex")) throw new Error("这份 M4A 是分片格式（fragmented MP4），不能在本地无损切分");
    need(find(root, "mvhd"), "mvhd");
    let track = null;
    for (const trak of mp4ChildBoxes(moov, 0, moov.length).filter((b) => b.type === "trak")) {
      const mdia = find(trak, "mdia"), hdlr = mdia && find(mdia, "hdlr");
      if (hdlr && moov.toString("latin1", hdlr.body + 8, hdlr.body + 12) === "soun") { track = { mdia }; break; }
    }
    if (!track) throw new Error("这份 MP4 里没有音频轨");
    const mdhd = need(find(track.mdia, "mdhd"), "mdhd"), v1 = moov[mdhd.body] === 1;
    const timescale = moov.readUInt32BE(mdhd.body + (v1 ? 20 : 12));
    if (!timescale) throw new Error("时间刻度为 0");
    const minf = need(find(track.mdia, "minf"), "minf"), stbl = need(find(minf, "stbl"), "stbl");
    need(find(stbl, "stsd"), "stsd");
    const stts = need(find(stbl, "stts"), "stts"), stsc = need(find(stbl, "stsc"), "stsc"), stsz = need(find(stbl, "stsz"), "stsz");
    const stco = find(stbl, "stco") || need(find(stbl, "co64"), "stco / co64");
    const count = moov.readUInt32BE(stsz.body + 8), fixed = moov.readUInt32BE(stsz.body + 4);
    if (!count) throw new Error("没有音频帧");
    if (!fixed && stsz.body + 12 + count * 4 > stsz.end) throw new Error("stsz 不完整");
    let filled = 0, duration = 0;
    for (let i = 0, n = moov.readUInt32BE(stts.body + 4); i < n && filled < count; i++) {
      const run = moov.readUInt32BE(stts.body + 8 + i * 8), delta = moov.readUInt32BE(stts.body + 12 + i * 8);
      const take = Math.min(run, count - filled);
      filled += take; duration += take * delta;
    }
    if (filled !== count) throw new Error("stts 与帧数不一致");
    const wide = stco.type === "co64", chunkCount = moov.readUInt32BE(stco.body + 4);
    const chunkOffset = (index) => (wide ? Number(moov.readBigUInt64BE(stco.body + 8 + index * 8)) : moov.readUInt32BE(stco.body + 8 + index * 4));
    const entries = Array.from({ length: moov.readUInt32BE(stsc.body + 4) }, (_, i) => ({
      first: moov.readUInt32BE(stsc.body + 8 + i * 12), per: moov.readUInt32BE(stsc.body + 12 + i * 12) }));
    if (!entries.length) throw new Error("stsc 为空");
    let sample = 0;
    for (let chunk = 0, entry = 0; chunk < chunkCount && sample < count; chunk++) {
      while (entry + 1 < entries.length && entries[entry + 1].first <= chunk + 1) entry++;
      let offset = chunkOffset(chunk);
      for (let k = 0; k < entries[entry].per && sample < count; k++) {
        const sampleSize = fixed || moov.readUInt32BE(stsz.body + 12 + sample * 4);
        if (offset + sampleSize > size) throw new Error("音频帧超出了文件末尾（文件可能没有传完整）");
        offset += sampleSize; sample++;
      }
    }
    if (sample !== count) throw new Error("块表与帧数不一致");
    return { splittable: true, seconds: duration / timescale, reason: null };
  } catch (error) {
    const seconds = await m4aSeconds(file, size);
    return { splittable: false, seconds, reason: error?.message || "结构不明" };
  }
}

/** Stream-probe an Ogg Opus/Vorbis file by walking only page headers (skipping audio payloads). */
async function measureOggFile(file, size) {
  const CAPTURE = 0x4f676753, FIRST = 2;
  if (size < 27) return { info: null, reason: "读不懂这份 OGG 文件的结构（开头没有 OggS），可能不完整或已损坏" };
  let at = 0, pageCount = 0, truncated = false, opening = true, codec = null, serial = null;
  let wanted = 0, headerPieces = [], headersDone = false;
  const headerPackets = [];
  let audioPages = 0, firstAudio = null, lastGranule = -1;
  const startsWith = (data, text, off = 0) => data.length >= off + text.length && data.toString("latin1", off, off + text.length) === text;
  while (at < size) {
    if (at + 27 > size) {
      if (pageCount > 0) {
        const tail = await readRange(file, at, size - at);
        if (tail.indexOf("OggS", 0, "latin1") < 0) break;
      }
      truncated = true; break;
    }
    const hdr = await readRange(file, at, 27);
    if (hdr.readUInt32BE(0) !== CAPTURE) {
      if (pageCount > 0) {
        const tail = await readRange(file, at, Math.min(size - at, 65536));
        if (tail.indexOf("OggS", 0, "latin1") < 0 && size - at <= 65536) break;
      }
      return { info: null, reason: `读不懂这份 OGG 文件的结构（${at === 0 ? "开头没有 OggS" : `第 ${pageCount + 1} 页的开头不对`}），可能不完整或已损坏` };
    }
    if (hdr[4] !== 0) return { info: null, reason: "读不懂这份 OGG 文件的结构（页的版本号不是 0），可能不完整或已损坏" };
    const flags = hdr[5], granuleRaw = hdr.readBigInt64LE(6), granule = granuleRaw < 0n ? -1 : Number(granuleRaw);
    const pageSerial = hdr.readUInt32LE(14), segments = hdr[26], body = at + 27 + segments;
    if (body > size) { truncated = true; break; }
    const table = await readRange(file, at + 27, segments);
    let bodySize = 0;
    for (let i = 0; i < segments; i++) bodySize += table[i];
    if (body + bodySize > size) { truncated = true; break; }
    pageCount++;
    if (flags & FIRST) {
      if (!opening) return { info: null, reason: "这份 OGG 由几段录音首尾相接而成（chained Ogg），不能在本地无损切分" };
      if (!codec) {
        const payload = await readRange(file, body, bodySize);
        if (startsWith(payload, "OpusHead")) { codec = "opus"; serial = pageSerial; wanted = 2; }
        else if (payload[0] === 1 && startsWith(payload, "vorbis", 1)) { codec = "vorbis"; serial = pageSerial; wanted = 3; }
      }
    } else {
      opening = false;
    }
    if (codec && pageSerial === serial) {
      if (!headersDone) {
        const payload = await readRange(file, body, bodySize);
        let offset = 0;
        for (let i = 0; i < segments; i++) {
          const val = table[i];
          headerPieces.push(payload.subarray(offset, offset + val));
          offset += val;
          if (val < 255) {
            headerPackets.push({ data: Buffer.concat(headerPieces), last: i === segments - 1 });
            headerPieces = [];
            if (headerPackets.length === wanted) {
              if (!headerPackets.at(-1).last) return { info: null, reason: "这份 OGG 的头信息和音频挤在同一页里，不能在本地无损切分" };
              headersDone = true;
              break;
            }
          }
        }
      } else {
        audioPages++;
        if (!firstAudio && codec === "opus" && granule >= 0) {
          const payload = await readRange(file, body, bodySize);
          let offset = 0, samples = 0, pieces = [];
          for (let i = 0; i < segments; i++) {
            const val = table[i];
            pieces.push(payload.subarray(offset, offset + val));
            offset += val;
            if (val < 255) { samples += opusPacketSamples(Buffer.concat(pieces)); pieces = []; }
          }
          firstAudio = { startOffset: Math.max(0, granule - samples) };
        }
        if (granule >= 0) lastGranule = granule;
      }
    }
    at = body + bodySize;
  }
  if (!codec) return { info: null, reason: "这份 OGG 里的音频不是 Opus 或 Vorbis 编码，不能在本地无损切分" };
  if (headerPackets.length < wanted) return { info: null, reason: "读不懂这份 OGG 文件的结构（头信息不完整），可能不完整或已损坏" };
  if (codec === "opus" ? !startsWith(headerPackets[1].data, "OpusTags") : headerPackets[1].data[0] !== 3 || headerPackets[2].data[0] !== 5)
    return { info: null, reason: "读不懂这份 OGG 文件的结构（头信息不完整），可能不完整或已损坏" };
  if (!audioPages || lastGranule < 0) return { info: null, reason: "读不懂这份 OGG 文件的结构（没有音频数据），可能不完整或已损坏" };
  const id = headerPackets[0].data;
  let rate, preSkip = 0, startOffset = 0;
  if (codec === "opus") {
    if (id.length < 19) return { info: null, reason: "读不懂这份 OGG 文件的结构（头信息不完整），可能不完整或已损坏" };
    rate = 48000; preSkip = id.readUInt16LE(10); startOffset = firstAudio?.startOffset || 0;
  } else {
    if (id.length < 16) return { info: null, reason: "读不懂这份 OGG 文件的结构（头信息不完整），可能不完整或已损坏" };
    rate = id.readUInt32LE(12);
    if (!rate) return { info: null, reason: "读不懂这份 OGG 文件的结构（采样率为 0），可能不完整或已损坏" };
  }
  return { info: { seconds: Math.max(0, lastGranule - startOffset - preSkip) / rate, truncated }, reason: null };
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Stream-probe duration of FLAC, AIFF, WebM or ADTS AAC without loading the whole file into memory. */
async function measureHeaderSeconds(file, size, kind) {
  try {
    if (kind === ".flac") return headerSeconds(await readRange(file, 0, Math.min(size, 64)), kind);
    if (kind === ".webm") return headerSeconds(await readRange(file, 0, Math.min(size, 4 * 1024 * 1024)), kind);
    if (kind === ".aiff" || kind === ".aif") {
      if (size < 12) return null;
      const form = await readRange(file, 0, 12);
      if (form.length < 12 || form.toString("latin1", 0, 4) !== "FORM") return null;
      for (let at = 12; at + 8 <= size;) {
        const hdr = await readRange(file, at, 8);
        if (hdr.length < 8) break;
        const id = hdr.toString("latin1", 0, 4), chunkSize = hdr.readUInt32BE(4), body = at + 8;
        if (id === "COMM" && body + 18 <= size) {
          const comm = await readRange(file, body, 18);
          if (comm.length >= 18) {
            const frames = comm.readUInt32BE(2), exponent = ((comm[8] & 0x7f) << 8) | comm[9];
            const mantissa = comm.readUInt32BE(10) * 2 ** 32 + comm.readUInt32BE(14);
            const rate = mantissa * 2 ** (exponent - 16383 - 63);
            return rate > 0 && frames ? frames / rate : null;
          }
        }
        at = body + chunkSize + (chunkSize & 1);
      }
      return null;
    }
    if (kind === ".aac") {
      const WINDOW = 256 * 1024, LOOKAHEAD = 16;
      const buf = Buffer.allocUnsafe(Math.min(WINDOW, Math.max(16, size)));
      let winStart = 0, bufLen = 0, at = 0, seconds = 0, covered = 0;
      const refill = async () => {
        if (at > 0 && at < bufLen) buf.copy(buf, 0, at, bufLen);
        winStart += at;
        bufLen = Math.max(0, bufLen - at);
        at = 0;
        while (bufLen < buf.length && winStart + bufLen < size) {
          const want = Math.min(buf.length - bufLen, size - (winStart + bufLen));
          const { bytesRead } = await file.read(buf, bufLen, want, winStart + bufLen);
          if (!bytesRead) break;
          bufLen += bytesRead;
        }
      };
      await refill();
      while (winStart + at + 7 <= size) {
        if ((at >= bufLen || bufLen - at < LOOKAHEAD) && winStart + bufLen < size) await refill();
        if (at + 7 > bufLen) break;
        const rate = ADTS_RATES[(buf[at + 2] >> 2) & 0x0f];
        const length = ((buf[at + 3] & 3) << 11) | (buf[at + 4] << 3) | (buf[at + 5] >> 5);
        if (buf[at] !== 0xff || (buf[at + 1] & 0xf6) !== 0xf0 || !rate || length < 7) { at++; continue; }
        seconds += ((buf[at + 6] & 3) + 1) * 1024 / rate;
        covered += length;
        at += length;
      }
      return seconds && covered >= size * 0.5 ? seconds : null;
    }
    return null;
  } catch { return null; }
}

/** The formats StudyHub cannot cut itself: whole when they fit one request, else cut with ffmpeg, else refused before anything is sent. */
async function planOtherFormat({ bytes, size = bytes?.length || 0, kind, seconds, limit, measure, reason, ffmpeg }) {
  const problem = tooLongToSend({ kind, seconds, size, reason });
  if (!problem) return { parts: 1, chunks: measure ? [] : [{ bytes, seconds: seconds || 0 }] };
  // Loaded only here: groq.js reads this module too.
  const command = ffmpeg !== undefined ? ffmpeg : await (await import("./groq.js")).findFfmpeg();
  if (!command) throw audioError(problem, "AUDIO_UNSPLITTABLE");
  const longest = Math.min(Math.max(limit, MIN_PART_SECONDS), CHUNK_SECONDS);
  const parts = seconds ? partsFor(seconds, limit) : Math.max(2, Math.ceil(size / (longest * UNKNOWN_BYTES_PER_SECOND)));
  if (measure) return { parts, chunks: [] };
  const { cutWithFfmpeg } = await import("./audio-ffmpeg-cut.js");
  const chunks = await cutWithFfmpeg({ command, bytes, kind, pieceSeconds: seconds ? seconds / parts + 1 : longest });
  return { parts: chunks.length, chunks };
}

/**
 * Read an explicitly supplied audio file and plan its chunks. Never fetches
 * URLs and refuses anything that is not a known audio extension.
 * `measureOnly` (the pre-flight check) probes headers/frames via bounded streaming reads
 * without allocating the full file buffer (up to 512 MB) into V8 heap memory.
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
  if (measure) {
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw audioError("请选择一个音频文件", "AUDIO_UNREADABLE");
      if (stat.size > MAX_AUDIO_BYTES) throw audioError("音频超过 512 MB，请先压缩成 MP3 或按章节拆分", "AUDIO_TOO_LARGE");
      if (!stat.size) throw audioError("音频文件是空的", "AUDIO_EMPTY");
      const size = stat.size;
      const head = await readRange(file, 0, Math.min(size, 256));
      if (!head.length) throw audioError("音频文件是空的", "AUDIO_EMPTY");
      const detected = sniffAudio(head), kind = detected && MIME[detected] ? detected : ext, warnings = [];
      if (detected && MIME[detected] && !alike(detected, ext))
        warnings.push(`文件扩展名是 ${ext}，实际内容是 ${KIND[detected]} 格式，已按 ${KIND[detected]} 处理`);
      const mimeType = MIME[kind], limit = Number(input.partSeconds) || CHUNK_SECONDS;
      let seconds = null, parts = 1;
      if (kind === ".mp3") {
        const split = await scanMp3File(file, size);
        if (!split.frames) throw audioError("没有在文件里找到可识别的 MP3 音频帧", "AUDIO_CORRUPT");
        const span = size - split.start;
        if (split.covered < span * 0.5) throw audioError(`文件里能识别的 MP3 音频只占 ${Math.round(split.covered / span * 100)}%，不像是有效的 MP3（可能被改过扩展名，或文件已损坏）`, "AUDIO_CORRUPT");
        seconds = split.seconds;
        parts = partsFor(seconds, limit);
      } else if (kind === ".wav") {
        const info = await wavInfoFromFile(file, size);
        if (!info) throw audioError("这不是有效的 WAV 文件", "AUDIO_CORRUPT");
        if (![1, 3, 0xfffe].includes(info.tag) && info.seconds > CHUNK_SECONDS)
          throw audioError(`压缩编码的 WAV 超过 ${LIMIT_MINUTES} 分钟无法切分，请先转成 MP3`, "AUDIO_UNSPLITTABLE");
        seconds = info.seconds;
        parts = [1, 3, 0xfffe].includes(info.tag) ? partsFor(seconds, limit) : 1;
      } else if (kind === ".m4a") {
        const probed = await measureM4aFile(file, size);
        seconds = probed.seconds;
        if (seconds && seconds > MAX_AUDIO_SECONDS) throw audioError("音频超过 8 小时，请先拆分", "AUDIO_TOO_LONG");
        parts = seconds ? partsFor(seconds, limit) : 1;
        if (parts > 1 && !probed.splittable)
          throw audioError(`这份 M4A 约 ${Math.round(seconds / 60)} 分钟，超过单次转写的 ${LIMIT_MINUTES} 分钟上限，但它的内部结构不能在本地无损切分（${probed.reason || "结构不明"}）。请在录音软件里另存为 MP3 后再导入`, "AUDIO_UNSPLITTABLE");
      } else if (kind === ".ogg" || kind === ".opus") {
        const probed = await measureOggFile(file, size);
        if (probed.info) {
          seconds = probed.info.seconds;
          if (probed.info.truncated) warnings.push("OGG 文件末尾不完整（可能没有传完，或录音中途停了），最后不完整的一页已略去");
          if (seconds > MAX_AUDIO_SECONDS) throw audioError("音频超过 8 小时，请先拆分", "AUDIO_TOO_LONG");
          parts = partsFor(seconds, limit);
        } else ({ parts } = await planOtherFormat({ bytes: null, size, kind, seconds: null, limit, measure: true, reason: probed.reason, ffmpeg: input.ffmpeg }));
      } else {
        seconds = await measureHeaderSeconds(file, size, kind);
        if (seconds > MAX_AUDIO_SECONDS) throw audioError("音频超过 8 小时，请先拆分", "AUDIO_TOO_LONG");
        ({ parts } = await planOtherFormat({ bytes: null, size, kind, seconds, limit, measure: true, ffmpeg: input.ffmpeg }));
      }
      if (seconds && seconds > MAX_AUDIO_SECONDS) throw audioError("音频超过 8 小时，请先拆分", "AUDIO_TOO_LONG");
      return { filename, ext: kind, declaredExt: ext, mimeType, seconds, parts, bytes: size, warnings };
    } finally { await file.close(); }
  }
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
  const hash = createHash("sha256").update(bytes).digest("hex");
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
    if (![1, 3, 0xfffe].includes(info.tag) && info.seconds > CHUNK_SECONDS)
      throw audioError(`压缩编码的 WAV 超过 ${LIMIT_MINUTES} 分钟无法切分，请先转成 MP3`, "AUDIO_UNSPLITTABLE");
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
      throw audioError(`这份 M4A 约 ${Math.round(seconds / 60)} 分钟，超过单次转写的 ${LIMIT_MINUTES} 分钟上限，但它的内部结构不能在本地无损切分（${unreadable?.message || "结构不明"}）。请在录音软件里另存为 MP3 后再导入`, "AUDIO_UNSPLITTABLE");
    chunks = parts > 1 && !measure ? splitM4a(bytes, parts, info).map((part) => ({ bytes: part.bytes, seconds: part.seconds })) : [{ bytes, seconds: seconds || 0 }];
  } else if (kind === ".ogg" || kind === ".opus") {
    // Opus or Vorbis in Ogg: the last granule gives the exact length; a longer recording is cut at page boundaries.
    let info = null, unreadable = null;
    try { info = parseOgg(bytes); } catch (error) { unreadable = error; }
    if (info) {
      seconds = info.seconds;
      if (info.truncated) warnings.push("OGG 文件末尾不完整（可能没有传完，或录音中途停了），最后不完整的一页已略去");
      if (seconds > MAX_AUDIO_SECONDS) throw audioError("音频超过 8 小时，请先拆分", "AUDIO_TOO_LONG");
      parts = partsFor(seconds, limit);
      chunks = parts > 1 && !measure ? splitOgg(bytes, parts, info).map((part) => ({ bytes: part.bytes, seconds: part.seconds })) : [{ bytes, seconds }];
    } else ({ parts, chunks } = await planOtherFormat({ bytes, kind, seconds: null, limit, measure, reason: unreadable.message, ffmpeg: input.ffmpeg }));
  } else {
    // FLAC, AIFF, AAC, WebM: their length is read from the file where it says it; StudyHub cannot cut them itself.
    seconds = headerSeconds(bytes, kind);
    if (seconds > MAX_AUDIO_SECONDS) throw audioError("音频超过 8 小时，请先拆分", "AUDIO_TOO_LONG");
    ({ parts, chunks } = await planOtherFormat({ bytes, kind, seconds, limit, measure, ffmpeg: input.ffmpeg }));
  }
  if (seconds && seconds > MAX_AUDIO_SECONDS) throw audioError("音频超过 8 小时，请先拆分", "AUDIO_TOO_LONG");
  if (measure) return { filename, ext: kind, declaredExt: ext, mimeType, seconds, parts, bytes: bytes.length, warnings };
  return { filename, ext: kind, declaredExt: ext, mimeType, hash, seconds, chunks, warnings };
}
