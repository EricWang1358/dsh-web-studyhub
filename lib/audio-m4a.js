/* Lossless splitting of M4A / MP4 audio (AAC, ALAC…) without ffmpeg.

   A long phone or lecture recording is usually an M4A. A transcription request takes at most an hour (and the free
   providers take a limited file size), so a longer one is cut here, losslessly: the sample table of the first audio
   track (stsz sizes, stco/co64 chunk offsets, stsc sample-to-chunk, stts durations) is read, the coded frames are
   copied unchanged into each part, and every part is written as a small, complete M4A of its own:

     ftyp (copied) · moov [ mvhd · trak [ tkhd · mdia [ mdhd · hdlr (copied) · minf [ smhd · dinf · stbl [
       stsd (copied byte for byte, so the decoder setup in esds is untouched) · stts · stsc · stsz · stco ] ] ] ] ] · mdat

   Nothing is re-encoded. Cuts fall on frame boundaries (about 64 ms apart for 16 kHz AAC) nearest to equal durations.
   Limits: fragmented MP4 (moof/mvex) and files without an audio track are refused with a reason; only the first
   audio track is kept (video, chapters and metadata are dropped); the edit list is not copied, so the encoder's
   priming (a few tens of milliseconds of silence) stays at the start of each part. */

export class M4aError extends Error {
  constructor(message, code) { super(message); this.name = "M4aError"; this.code = code; }
}
const unreadable = (detail) => new M4aError(`读不懂这份 M4A 文件的结构（${detail}），可能不完整或已损坏`, "M4A_UNREADABLE");

/** The boxes between `from` and `to`: { type, start, body, end }. */
function boxes(bytes, from = 0, to = bytes.length) {
  const list = [];
  for (let at = from; at + 8 <= to;) {
    let size = bytes.readUInt32BE(at), header = 8;
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (size === 1) {
      if (at + 16 > to) throw unreadable(`${type} 的长度不完整`);
      size = Number(bytes.readBigUInt64BE(at + 8)); header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) throw unreadable(`${type} 超出了文件或上一层`);
    list.push({ type, start: at, body: at + header, end: at + size });
    at += size;
  }
  return list;
}
const find = (bytes, parent, type) => boxes(bytes, parent.body, parent.end).find((box) => box.type === type);
const need = (box, what) => { if (!box) throw unreadable(`缺少 ${what}`); return box; };
const slice = (bytes, box) => bytes.subarray(box.start, box.end);

/**
 * The first audio track's sample table. Throws M4aError (code M4A_UNREADABLE or M4A_UNSUPPORTED).
 * Returns { ftyp, movieTimescale, timescale, duration, seconds, language, hdlr, stsd, samples: { count, sizes, offsets, durations } }.
 */
export function parseM4a(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.toString("latin1", 4, 8) !== "ftyp") throw unreadable("开头没有 ftyp");
  const top = boxes(bytes);
  if (top.some((box) => box.type === "moof")) throw new M4aError("这份 M4A 是分片格式（fragmented MP4），不能在本地无损切分", "M4A_UNSUPPORTED");
  const moov = need(top.find((box) => box.type === "moov"), "moov");
  if (find(bytes, moov, "mvex")) throw new M4aError("这份 M4A 是分片格式（fragmented MP4），不能在本地无损切分", "M4A_UNSUPPORTED");
  const mvhd = need(find(bytes, moov, "mvhd"), "mvhd");
  const movieTimescale = bytes.readUInt32BE(mvhd.body + (bytes[mvhd.body] === 1 ? 20 : 12)) || 1000;
  let track = null;
  for (const trak of boxes(bytes, moov.body, moov.end).filter((box) => box.type === "trak")) {
    const mdia = find(bytes, trak, "mdia"), hdlr = mdia && find(bytes, mdia, "hdlr");
    if (hdlr && bytes.toString("latin1", hdlr.body + 8, hdlr.body + 12) === "soun") { track = { trak, mdia, hdlr }; break; }
  }
  if (!track) throw new M4aError("这份 MP4 里没有音频轨", "M4A_UNSUPPORTED");
  const mdhd = need(find(bytes, track.mdia, "mdhd"), "mdhd"), v1 = bytes[mdhd.body] === 1;
  const timescale = bytes.readUInt32BE(mdhd.body + (v1 ? 20 : 12));
  if (!timescale) throw unreadable("时间刻度为 0");
  const language = bytes.readUInt16BE(mdhd.body + (v1 ? 32 : 20));
  const minf = need(find(bytes, track.mdia, "minf"), "minf"), stbl = need(find(bytes, minf, "stbl"), "stbl");
  const stsd = need(find(bytes, stbl, "stsd"), "stsd"), stts = need(find(bytes, stbl, "stts"), "stts");
  const stsc = need(find(bytes, stbl, "stsc"), "stsc"), stsz = need(find(bytes, stbl, "stsz"), "stsz");
  const stco = find(bytes, stbl, "stco") || need(find(bytes, stbl, "co64"), "stco / co64");

  const count = bytes.readUInt32BE(stsz.body + 8), fixed = bytes.readUInt32BE(stsz.body + 4);
  if (!count) throw unreadable("没有音频帧");
  if (!fixed && stsz.body + 12 + count * 4 > stsz.end) throw unreadable("stsz 不完整");
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || bytes.readUInt32BE(stsz.body + 12 + i * 4);

  const durations = new Uint32Array(count);
  let filled = 0, duration = 0;
  for (let i = 0, n = bytes.readUInt32BE(stts.body + 4); i < n && filled < count; i++) {
    const run = bytes.readUInt32BE(stts.body + 8 + i * 8), delta = bytes.readUInt32BE(stts.body + 12 + i * 8);
    for (let k = 0; k < run && filled < count; k++) { durations[filled++] = delta; duration += delta; }
  }
  if (filled !== count) throw unreadable("stts 与帧数不一致");

  const wide = stco.type === "co64", chunkCount = bytes.readUInt32BE(stco.body + 4);
  const chunkOffset = (index) => (wide ? Number(bytes.readBigUInt64BE(stco.body + 8 + index * 8)) : bytes.readUInt32BE(stco.body + 8 + index * 4));
  const entries = Array.from({ length: bytes.readUInt32BE(stsc.body + 4) }, (_, i) => ({
    first: bytes.readUInt32BE(stsc.body + 8 + i * 12), per: bytes.readUInt32BE(stsc.body + 12 + i * 12) }));
  if (!entries.length) throw unreadable("stsc 为空");
  const offsets = new Float64Array(count);
  let sample = 0;
  for (let chunk = 0, entry = 0; chunk < chunkCount && sample < count; chunk++) {
    while (entry + 1 < entries.length && entries[entry + 1].first <= chunk + 1) entry++;
    let at = chunkOffset(chunk);
    for (let k = 0; k < entries[entry].per && sample < count; k++) {
      if (at + sizes[sample] > bytes.length) throw unreadable("音频帧超出了文件末尾（文件可能没有传完整）");
      offsets[sample] = at; at += sizes[sample]; sample++;
    }
  }
  if (sample !== count) throw unreadable("块表与帧数不一致");
  return { ftyp: slice(bytes, top[0]), movieTimescale, timescale, duration, seconds: duration / timescale, language,
    hdlr: slice(bytes, track.hdlr), stsd: slice(bytes, stsd), samples: { count, sizes, offsets, durations } };
}

/* ---------- writing ---------- */
function box(type, ...parts) {
  const body = Buffer.concat(parts), head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length); head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}
const full = (type, version, flags, ...parts) => { const head = Buffer.alloc(4); head.writeUInt32BE(((version << 24) | flags) >>> 0); return box(type, head, ...parts); };
const u32 = (...values) => list32(values);
/** Big-endian 32-bit words from an array or typed array, without spreading it into arguments (tables can be long). */
const list32 = (values) => { const out = Buffer.alloc(values.length * 4); for (let i = 0; i < values.length; i++) out.writeUInt32BE(values[i] >>> 0, i * 4); return out; };
const u64 = (value) => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(Math.round(value))); return out; };
const MATRIX = u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000);
const BIG = 0xffffffff;
/** creation/modification time, timescale-ish field and a duration, as version 0 (32-bit) or 1 (64-bit). */
const times = (duration, scale) => (duration > BIG
  ? { version: 1, bytes: [u64(0), u64(0), ...(scale === undefined ? [] : [u32(scale)]), u64(duration)] }
  : { version: 0, bytes: [u32(0, 0), ...(scale === undefined ? [] : [u32(scale)]), u32(duration)] });

function partFile(info, bytes, from, to) {
  const { samples } = info, count = to - from;
  let duration = 0;
  const runs = [];
  for (let i = from; i < to; i++) {
    const delta = samples.durations[i];
    duration += delta;
    if (runs.length && runs.at(-1)[1] === delta) runs.at(-1)[0]++; else runs.push([1, delta]);
  }
  const data = Buffer.concat(Array.from({ length: count }, (_, k) => bytes.subarray(samples.offsets[from + k], samples.offsets[from + k] + samples.sizes[from + k])));
  const movieDuration = Math.round(duration * info.movieTimescale / info.timescale);
  const mvhdTimes = times(movieDuration, info.movieTimescale), mdhdTimes = times(duration, info.timescale);
  const tkhdTimes = movieDuration > BIG ? { version: 1, bytes: [u64(0), u64(0), u32(1, 0), u64(movieDuration)] } : { version: 0, bytes: [u32(0, 0, 1, 0, movieDuration)] };
  const wide = data.length + 1024 > BIG;
  const moovFor = (offset) => box("moov",
    full("mvhd", mvhdTimes.version, 0, ...mvhdTimes.bytes, u32(0x00010000), Buffer.from([1, 0]), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2)),
    box("trak",
      full("tkhd", tkhdTimes.version, 3, ...tkhdTimes.bytes, Buffer.alloc(8), Buffer.from([0, 0, 0, 0, 1, 0, 0, 0]), MATRIX, u32(0, 0)),
      box("mdia",
        full("mdhd", mdhdTimes.version, 0, ...mdhdTimes.bytes, Buffer.from([info.language >> 8, info.language & 0xff, 0, 0])),
        info.hdlr,
        box("minf", full("smhd", 0, 0, u32(0)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))),
          box("stbl", info.stsd,
            full("stts", 0, 0, u32(runs.length), list32(runs.flat())),
            full("stsc", 0, 0, u32(1, 1, count, 1)),
            full("stsz", 0, 0, u32(0, count), list32(samples.sizes.subarray(from, to))),
            wide ? full("co64", 0, 0, u32(1), u64(offset)) : full("stco", 0, 0, u32(1, offset)))))));
  const head = wide ? Buffer.concat([u32(1), Buffer.from("mdat", "latin1"), u64(16 + data.length)]) : Buffer.concat([u32(8 + data.length), Buffer.from("mdat", "latin1")]);
  const size = moovFor(0).length, offset = info.ftyp.length + size + head.length;
  return { bytes: Buffer.concat([info.ftyp, moovFor(offset), head, data]), seconds: duration / info.timescale, samples: count };
}

/**
 * `parts` standalone M4A files of about equal duration, cut on frame boundaries. Each is { bytes, seconds, samples }.
 * `info` is parseM4a(bytes) when the caller already has it.
 */
export function splitM4a(bytes, parts, info = parseM4a(bytes)) {
  const { count, durations } = info.samples, wanted = Math.max(1, Math.min(Math.floor(parts) || 1, count));
  const cuts = [0];
  let elapsed = 0;
  for (let i = 0, part = 1; i < count && part < wanted; i++) {
    const target = info.duration * part / wanted;
    // Cut before sample i when that boundary is the one nearest the target.
    if (elapsed + durations[i] / 2 >= target && i > cuts.at(-1)) { cuts.push(i); part++; }
    elapsed += durations[i];
  }
  while (cuts.length < wanted) cuts.push(Math.min(count - (wanted - cuts.length), cuts.at(-1) + 1));
  cuts.push(count);
  return cuts.slice(0, -1).map((from, index) => partFile(info, bytes, from, cuts[index + 1]));
}

/** The fewest equal-duration parts that each fit `limit` bytes, or null when even single frames do not. */
export function splitM4aBySize(bytes, limit, info = parseM4a(bytes)) {
  for (let parts = Math.max(1, Math.ceil(bytes.length / (limit * 0.95))); parts <= info.samples.count; parts = Math.ceil(parts * 1.25) + 1) {
    const pieces = splitM4a(bytes, parts, info);
    if (pieces.every((piece) => piece.bytes.length <= limit)) return pieces;
  }
  return null;
}
