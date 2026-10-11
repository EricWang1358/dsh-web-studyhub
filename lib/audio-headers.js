/* How long a recording is, for the formats StudyHub sends whole because it cannot cut them itself (#408): FLAC, AIFF,
   ADTS AAC and WebM. Read from what the file itself states (FLAC STREAMINFO, the AIFF COMM chunk, the WebM Segment Info
   duration) or, for AAC, by walking its frames. Null when the file does not say: a WebM written by a browser's
   recorder, for example, carries no duration. Nothing is decoded. */

/** FLAC: total samples and the sample rate from STREAMINFO, the first metadata block. */
function flacSeconds(bytes) {
  if (bytes.length < 42 || bytes.toString("latin1", 0, 4) !== "fLaC" || (bytes[4] & 0x7f) !== 0) return null;
  const rate = (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4);
  const samples = (bytes[21] & 0x0f) * 2 ** 32 + bytes.readUInt32BE(22);
  return rate && samples ? samples / rate : null;
}

/** AIFF / AIFC: sample frames and the 80-bit extended sample rate of the COMM chunk. */
function aiffSeconds(bytes) {
  if (bytes.length < 12 || bytes.toString("latin1", 0, 4) !== "FORM") return null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString("latin1", at, at + 4), size = bytes.readUInt32BE(at + 4), body = at + 8;
    if (id === "COMM" && body + 18 <= bytes.length) {
      const frames = bytes.readUInt32BE(body + 2), exponent = ((bytes[body + 8] & 0x7f) << 8) | bytes[body + 9];
      const mantissa = bytes.readUInt32BE(body + 10) * 2 ** 32 + bytes.readUInt32BE(body + 14);
      const rate = mantissa * 2 ** (exponent - 16383 - 63);
      return rate > 0 && frames ? frames / rate : null;
    }
    at = body + size + (size & 1);
  }
  return null;
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
/** ADTS AAC: every frame says its length and holds 1024 samples per raw block. Null when under half the bytes are frames. */
function adtsSeconds(bytes) {
  let at = 0, seconds = 0, covered = 0;
  while (at + 7 <= bytes.length) {
    const rate = ADTS_RATES[(bytes[at + 2] >> 2) & 0x0f], length = ((bytes[at + 3] & 3) << 11) | (bytes[at + 4] << 3) | (bytes[at + 5] >> 5);
    if (bytes[at] !== 0xff || (bytes[at + 1] & 0xf6) !== 0xf0 || !rate || length < 7) { at++; continue; }
    seconds += ((bytes[at + 6] & 3) + 1) * 1024 / rate;
    covered += length;
    at += length;
  }
  return seconds && covered >= bytes.length * 0.5 ? seconds : null;
}

/** An EBML variable-length number at `at`: { value, length }; `keep` leaves the length marker in (element IDs). */
function vint(bytes, at, keep = false) {
  const first = bytes[at];
  if (!first) return null;
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) return null;
  let value = keep ? first : first & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i];
  return { value, length };
}
/** WebM / Matroska: Duration (in TimecodeScale units, 1 ms by default) from the Segment Info element. */
function webmSeconds(bytes) {
  const info = bytes.subarray(0, Math.min(bytes.length, 4 * 1024 * 1024)).indexOf(Buffer.from([0x15, 0x49, 0xa9, 0x66]));
  if (info < 0) return null;
  const size = vint(bytes, info + 4);
  if (!size) return null;
  let scale = 1_000_000, duration = null;
  for (let at = info + 4 + size.length, end = Math.min(bytes.length, at + size.value); at < end;) {
    const id = vint(bytes, at, true), length = id && vint(bytes, at + id.length);
    if (!id || !length) break;
    const body = at + id.length + length.length;
    if (body + length.value > bytes.length) break;
    if (id.value === 0x2ad7b1 && length.value <= 8) scale = bytes.readUIntBE(body, Math.min(6, length.value));
    if (id.value === 0x4489) duration = length.value === 8 ? bytes.readDoubleBE(body) : length.value === 4 ? bytes.readFloatBE(body) : null;
    at = body + length.value;
  }
  return duration > 0 ? duration * scale / 1e9 : null;
}

const READERS = { ".flac": flacSeconds, ".aiff": aiffSeconds, ".aif": aiffSeconds, ".aac": adtsSeconds, ".webm": webmSeconds };
/** Seconds of a FLAC, AIFF, ADTS AAC or WebM recording as its bytes state it, or null when they do not. */
export function headerSeconds(bytes, kind) {
  try { return READERS[kind]?.(bytes) ?? null; } catch { return null; }
}
