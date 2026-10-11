/* Lossless splitting of Ogg Opus and Ogg Vorbis audio without ffmpeg (#408).

   Phone and meeting recorders often save Opus in an Ogg file (.ogg or .opus). A transcription request takes a limited
   length (see CHUNK_SECONDS in audio-file.js), so a longer recording is cut here, losslessly. An Ogg file is a run of
   pages (RFC 3533): "OggS", flags (1 continued packet, 2 first page, 4 last page), a granule position (the stream's
   sample position after the last packet that ends on the page, -1 when none does), the stream's serial number, a page
   number, a CRC and a lacing table that splits the payload into packets (a value under 255 ends a packet).

   Each part is written as a complete Ogg file of its own:

     the header pages (Opus: OpusHead + OpusTags; Vorbis: identification + comment + setup), copied unchanged
     · the audio pages of that stretch, copied unchanged except: renumbered from 0, granules counted from the part's
       start, the first-page flag only on the first page and the last-page flag only on the last; every CRC recomputed.

   Nothing is re-encoded. A cut falls after a page that ends a packet (so no packet is split between parts), at the
   page nearest an equal share of the length; pages are about a second long, so parts are equal to within a second.
   Opus: the granule runs at 48 kHz whatever the input rate, and the decoder drops `pre-skip` samples at the start of
   every part (about 6.5 ms), so each later part loses that much at its start. Vorbis: the granule runs at the sample
   rate; a fresh decoder yields no sound for its first packet, so each later part starts a few milliseconds late.
   Refused with a reason: chained files (several recordings one after another), files whose audio is neither Opus nor
   Vorbis (Speex, FLAC in Ogg), and files whose headers share a page with audio. Only the audio stream is kept: other
   streams multiplexed with it (a Skeleton index, video) are dropped. A final page cut short is left out. */

export class OggError extends Error {
  constructor(message, code) { super(message); this.name = "OggError"; this.code = code; }
}
const unreadable = (detail) => new OggError(`读不懂这份 OGG 文件的结构（${detail}），可能不完整或已损坏`, "OGG_UNREADABLE");
const unsupported = (message) => new OggError(message, "OGG_UNSUPPORTED");

const CONTINUED = 1, FIRST = 2, LAST = 4;
const CAPTURE = 0x4f676753; // "OggS"

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i << 24;
    for (let bit = 0; bit < 8; bit++) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
    table[i] = value >>> 0;
  }
  return table;
})();
/** The Ogg page checksum (CRC-32, polynomial 0x04c11db7, not reflected), of a page whose CRC field is zero. */
export function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = (crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff];
  return crc >>> 0;
}

/** Every page: { start, end, body, flags, granule, serial, segments, endsPacket }. A last page cut short sets `truncated`. */
function readPages(bytes) {
  const pages = [];
  let at = 0, truncated = false;
  while (at < bytes.length) {
    // Bytes after the last page that hold no further page (an ID3v1 tag a tagger appended) are not audio: stop there.
    if (pages.length && bytes.indexOf("OggS", at, "latin1") < 0) break;
    if (at + 27 > bytes.length) { truncated = true; break; }
    if (bytes.readUInt32BE(at) !== CAPTURE) throw unreadable(at === 0 ? "开头没有 OggS" : `第 ${pages.length + 1} 页的开头不对`);
    if (bytes[at + 4] !== 0) throw unreadable("页的版本号不是 0");
    const segments = bytes[at + 26], body = at + 27 + segments;
    if (body > bytes.length) { truncated = true; break; }
    let size = 0;
    for (let i = 0; i < segments; i++) size += bytes[at + 27 + i];
    if (body + size > bytes.length) { truncated = true; break; }
    const granule = bytes.readBigInt64LE(at + 6);
    pages.push({ start: at, end: body + size, body, flags: bytes[at + 5], granule: granule < 0n ? -1 : Number(granule),
      serial: bytes.readUInt32LE(at + 14), segments, endsPacket: segments > 0 && bytes[body - 1] < 255 });
    at = body + size;
  }
  return { pages, truncated };
}

/** The first `count` packets of a stream's pages: [{ data, page (index), last (it is the page's last packet) }]. */
function firstPackets(bytes, pages, count) {
  const found = [];
  let pieces = [];
  for (const [index, page] of pages.entries()) {
    let offset = page.body;
    for (let i = 0; i < page.segments; i++) {
      const value = bytes[page.start + 27 + i];
      pieces.push(bytes.subarray(offset, offset + value));
      offset += value;
      if (value < 255) {
        found.push({ data: Buffer.concat(pieces), page: index, last: i === page.segments - 1 });
        pieces = [];
        if (found.length === count) return found;
      }
    }
  }
  return found;
}

/** Samples (at 48 kHz) one Opus packet decodes to, from its TOC byte (RFC 6716 §3.1). */
export function opusPacketSamples(packet) {
  if (!packet?.length) return 0;
  const config = packet[0] >> 3, code = packet[0] & 3;
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  const frames = code === 0 ? 1 : code < 3 ? 2 : (packet[1] ?? 0) & 0x3f;
  return frame * frames;
}

const startsWith = (data, text, offset = 0) => data.length >= offset + text.length && data.toString("latin1", offset, offset + text.length) === text;

/**
 * Read the audio stream of an Ogg file. Throws OggError (code OGG_UNREADABLE or OGG_UNSUPPORTED). Returns
 * { codec: "opus" | "vorbis", serial, rate (granule units per second), preSkip, startOffset, seconds, truncated,
 *   headerPages, audioPages }, the page lists holding only pages of the audio stream.
 */
export function parseOgg(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 27 || bytes.readUInt32BE(0) !== CAPTURE) throw unreadable("开头没有 OggS");
  const { pages, truncated } = readPages(bytes);
  // Every stream's first page comes before any other page; a first page later on starts another recording (chaining).
  let serial = null, codec = null, opening = true;
  for (const page of pages) {
    if (!(page.flags & FIRST)) { opening = false; continue; }
    if (!opening) throw unsupported("这份 OGG 由几段录音首尾相接而成（chained Ogg），不能在本地无损切分");
    if (codec) continue;
    const head = bytes.subarray(page.body, page.end);
    if (startsWith(head, "OpusHead")) { codec = "opus"; serial = page.serial; }
    else if (head[0] === 1 && startsWith(head, "vorbis", 1)) { codec = "vorbis"; serial = page.serial; }
  }
  if (!codec) throw unsupported("这份 OGG 里的音频不是 Opus 或 Vorbis 编码，不能在本地无损切分");
  const own = pages.filter((page) => page.serial === serial);
  const wanted = codec === "opus" ? 2 : 3, headers = firstPackets(bytes, own, wanted);
  if (headers.length < wanted) throw unreadable("头信息不完整");
  if (codec === "opus" ? !startsWith(headers[1].data, "OpusTags") : headers[1].data[0] !== 3 || headers[2].data[0] !== 5) throw unreadable("头信息不完整");
  if (!headers.at(-1).last) throw unsupported("这份 OGG 的头信息和音频挤在同一页里，不能在本地无损切分");
  const headerPages = own.slice(0, headers.at(-1).page + 1);
  let audioPages = own.slice(headerPages.length);
  // An unfinished packet at the very end (a recording that stopped mid-page) cannot be decoded: leave its pages out.
  while (audioPages.length && audioPages.at(-1).granule < 0) audioPages = audioPages.slice(0, -1);
  if (!audioPages.length) throw unreadable("没有音频数据");
  const id = headers[0].data, end = audioPages.at(-1).granule;
  let rate, preSkip = 0, startOffset = 0;
  if (codec === "opus") {
    if (id.length < 19) throw unreadable("头信息不完整");
    rate = 48000; preSkip = id.readUInt16LE(10);
    // A stream cut out of a longer one starts at a granule above zero: the first page's granule minus what its packets decode to.
    const first = audioPages[0];
    if (first.granule >= 0) {
      const samples = firstPackets(bytes, [first], first.segments).reduce((sum, packet) => sum + opusPacketSamples(packet.data), 0);
      startOffset = Math.max(0, first.granule - samples);
    }
  } else {
    if (id.length < 16) throw unreadable("头信息不完整");
    rate = id.readUInt32LE(12);
    if (!rate) throw unreadable("采样率为 0");
  }
  const seconds = Math.max(0, end - startOffset - preSkip) / rate;
  return { codec, serial, rate, preSkip, startOffset, seconds, truncated, headerPages, audioPages };
}

/** A copy of `page` with a new page number, granule and flags, and its CRC recomputed. */
function rewritePage(bytes, page, { sequence, granule, flags }) {
  const out = Buffer.from(bytes.subarray(page.start, page.end));
  out[5] = flags;
  out.writeBigInt64LE(BigInt(granule), 6);
  out.writeUInt32LE(sequence >>> 0, 18);
  out.writeUInt32LE(0, 22);
  out.writeUInt32LE(oggCrc(out), 22);
  return out;
}

/** One standalone Ogg file: the header pages, then audio pages [from, to] with granules counted from `base`. */
function partFile(bytes, info, from, to, base) {
  const out = [];
  let sequence = 0;
  for (const page of info.headerPages) out.push(rewritePage(bytes, page, { sequence: sequence++, granule: page.granule, flags: page.flags & ~LAST }));
  for (let index = from; index <= to; index++) {
    const page = info.audioPages[index];
    out.push(rewritePage(bytes, page, { sequence: sequence++, granule: page.granule < 0 ? -1 : page.granule - base,
      flags: (page.flags & CONTINUED) | (index === to ? LAST : 0) }));
  }
  const last = info.audioPages[to].granule - base;
  // The first part keeps the stream's starting offset; a later part starts at zero. Each drops its pre-skip.
  const seconds = Math.max(0, last - (from === 0 ? info.startOffset : 0) - info.preSkip) / info.rate;
  return { bytes: Buffer.concat(out), seconds, pages: to - from + 1 };
}

/**
 * `parts` standalone Ogg files of about equal length, cut after pages that end a packet. Each is { bytes, seconds, pages }.
 * `info` is parseOgg(bytes) when the caller already has it. Fewer parts come back only when there are fewer places to cut.
 */
export function splitOgg(bytes, parts, info = parseOgg(bytes)) {
  const pages = info.audioPages, wanted = Math.max(1, Math.floor(parts) || 1);
  // After page i a new part may begin: it ends a packet, says where it is, and the next page does not continue a packet.
  const places = [];
  for (let i = 0; i + 1 < pages.length; i++) if (pages[i].endsPacket && pages[i].granule >= 0 && !(pages[i + 1].flags & CONTINUED)) places.push(i);
  const begin = info.startOffset, end = pages.at(-1).granule, cuts = [];
  for (let part = 1, from = 0; part < wanted && from < places.length; part++) {
    const target = begin + (end - begin) * part / wanted;
    let best = from;
    while (best + 1 < places.length && Math.abs(pages[places[best + 1]].granule - target) <= Math.abs(pages[places[best]].granule - target)) best++;
    cuts.push(places[best]);
    from = best + 1;
  }
  const bounds = [-1, ...cuts, pages.length - 1];
  return bounds.slice(1).map((to, index) => {
    const from = bounds[index] + 1;
    return partFile(bytes, info, from, to, from === 0 ? 0 : pages[from - 1].granule);
  });
}
