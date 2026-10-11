/* Synthetic Ogg streams for the Ogg splitter's tests, and an independent reader for what the splitter writes.
   Nothing here imports lib/audio-ogg.js: the CRC, the page layout and the packet assembly are written again from the
   spec (RFC 3533, RFC 7845, Vorbis I §A), so a mistake in the splitter cannot hide behind the same mistake here. */

/** The Ogg CRC-32 (polynomial 0x04c11db7, not reflected, start 0, no final xor), bit by bit. */
export function referenceCrc(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) : crc << 1) >>> 0;
  }
  return crc >>> 0;
}

function pageBytes({ flags, granule, serial, sequence, lacing, body }) {
  const head = Buffer.alloc(27 + lacing.length);
  head.write("OggS", 0, "latin1");
  head[5] = flags;
  head.writeBigInt64LE(BigInt(granule), 6);
  head.writeUInt32LE(serial >>> 0, 14);
  head.writeUInt32LE(sequence >>> 0, 18);
  head[26] = lacing.length;
  head.set(lacing, 27);
  const page = Buffer.concat([head, body]);
  page.writeUInt32LE(referenceCrc(page), 22);
  return page;
}

/**
 * The pages of one logical stream. `packets` are { data, granule, flush }: `granule` is the stream position after the
 * packet, `flush` ends the page after it. A page also ends when it holds `maxSegments` lacing values, so a long packet
 * runs over several pages (those that complete no packet carry granule -1). Returns the page objects (not yet bytes).
 */
export function streamPages(packets, { serial = 0x5eed, maxSegments = 255, bos = true, eos = true } = {}) {
  const pages = [];
  let lacing = [], bodies = [], granule = -1, continued = false;
  const flush = () => {
    if (!lacing.length) return;
    pages.push({ flags: continued ? 1 : 0, granule, serial, lacing: Uint8Array.from(lacing), body: Buffer.concat(bodies) });
    continued = lacing.at(-1) === 255;
    lacing = []; bodies = []; granule = -1;
  };
  for (const packet of packets) {
    const values = [];
    for (let left = packet.data.length; ; left -= 255) { values.push(Math.min(255, left)); if (left < 255) break; }
    let offset = 0;
    values.forEach((value, index) => {
      if (lacing.length === maxSegments) flush();
      lacing.push(value);
      bodies.push(packet.data.subarray(offset, offset + value));
      offset += value;
      if (index === values.length - 1) granule = packet.granule;
    });
    if (packet.flush) flush();
  }
  flush();
  if (bos) pages[0].flags |= 2;
  if (eos) pages.at(-1).flags |= 4;
  return pages;
}

/** Bytes of pages, numbered per serial in the order given. */
export function writePages(pages) {
  const next = new Map();
  return Buffer.concat(pages.map((page) => {
    const sequence = next.get(page.serial) ?? 0;
    next.set(page.serial, sequence + 1);
    return pageBytes({ ...page, sequence });
  }));
}

export function opusHead({ channels = 2, preSkip = 312, rate = 48000 } = {}) {
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "latin1");
  head[8] = 1; head[9] = channels;
  head.writeUInt16LE(preSkip, 10); head.writeUInt32LE(rate, 12);
  return head;
}
export function opusTags(extra = 0) {
  const vendor = Buffer.from("studyhub-test", "latin1");
  const comment = Buffer.from(`PAD=${"x".repeat(extra)}`, "latin1");
  const out = Buffer.alloc(8 + 4 + vendor.length + 4 + 4 + comment.length);
  out.write("OpusTags", 0, "latin1");
  out.writeUInt32LE(vendor.length, 8); vendor.copy(out, 12);
  out.writeUInt32LE(1, 12 + vendor.length); out.writeUInt32LE(comment.length, 16 + vendor.length);
  comment.copy(out, 20 + vendor.length);
  return out;
}
/** An Opus packet of 120 ms (CELT 20 ms frames, code 3, six of them): 5760 samples at 48 kHz. Its bytes say its index. */
export const OPUS_PACKET_SAMPLES = 5760;
export function opusPacket(index, size = 8) {
  const data = Buffer.alloc(Math.max(3, size));
  data[0] = (31 << 3) | 3; data[1] = 6;
  for (let i = 2; i < data.length; i++) data[i] = (index * 31 + i * 7) & 0xff;
  return data;
}

/**
 * A whole Ogg Opus stream of `seconds` (after pre-skip): the two header packets, then 120 ms packets, `perPage` to a
 * page. `size(index)` picks each packet's length (a long one runs over pages when `maxSegments` is small).
 * `startGranule` gives the stream a starting offset, as a stream cut out of a live broadcast has. The last granule is
 * trimmed to the exact length, as encoders do.
 */
export function opusStream({ seconds, preSkip = 312, perPage = 8, size = () => 8, maxSegments = 255, tagsBytes = 0, startGranule = 0, serial = 0x5eed } = {}) {
  const samples = Math.round(seconds * 48000), count = Math.ceil((samples + preSkip) / OPUS_PACKET_SAMPLES);
  const packets = [
    { data: opusHead({ preSkip }), granule: 0, flush: true },
    { data: opusTags(tagsBytes), granule: 0, flush: true },
  ];
  for (let index = 0; index < count; index++) {
    const last = index === count - 1;
    packets.push({ data: opusPacket(index, size(index)), granule: startGranule + (last ? samples + preSkip : (index + 1) * OPUS_PACKET_SAMPLES), flush: last || (index + 1) % perPage === 0 });
  }
  return { pages: streamPages(packets, { serial, maxSegments }), packets, audioPackets: packets.slice(2).map((packet) => packet.data) };
}

export function vorbisHeaders({ rate = 44100, channels = 1 } = {}) {
  const id = Buffer.alloc(30);
  id[0] = 1; id.write("vorbis", 1, "latin1");
  id[11] = channels; id.writeUInt32LE(rate, 12); id.writeInt32LE(64000, 20);
  id[28] = 0xb8; id[29] = 1;
  const vendor = Buffer.from("studyhub-test", "latin1");
  const comment = Buffer.alloc(7 + 4 + vendor.length + 4 + 1);
  comment[0] = 3; comment.write("vorbis", 1, "latin1");
  comment.writeUInt32LE(vendor.length, 7); vendor.copy(comment, 11); comment[comment.length - 1] = 1;
  const setup = Buffer.alloc(60, 0x5a);
  setup[0] = 5; setup.write("vorbis", 1, "latin1");
  return [id, comment, setup];
}
/** An Ogg Vorbis stream: identification header alone on the first page, comment and setup on the next, then fake audio packets of 1024 samples. */
export function vorbisStream({ seconds, rate = 44100, perPage = 16, serial = 0x7001 } = {}) {
  const [id, comment, setup] = vorbisHeaders({ rate });
  const samples = Math.round(seconds * rate), count = Math.ceil(samples / 1024);
  const packets = [{ data: id, granule: 0, flush: true }, { data: comment, granule: 0 }, { data: setup, granule: 0, flush: true }];
  for (let index = 0; index < count; index++) {
    const data = Buffer.alloc(12);
    for (let i = 1; i < data.length; i++) data[i] = (index * 13 + i) & 0xff;
    data[0] = (index & 0x7e); // bit 0 clear: an audio packet
    const last = index === count - 1;
    packets.push({ data, granule: last ? samples : (index + 1) * 1024, flush: last || (index + 1) % perPage === 0 });
  }
  return { pages: streamPages(packets, { serial }), packets, audioPackets: packets.slice(3).map((packet) => packet.data) };
}

/**
 * Read an Ogg file the strict way: every page must start with OggS, carry a correct CRC and have version 0.
 * Returns { pages: [{ flags, granule, serial, sequence, lacing, body }], packets: Map(serial → [Buffer]) }.
 */
export function readOggStrict(bytes) {
  const pages = [], packets = new Map(), partial = new Map();
  for (let at = 0; at < bytes.length;) {
    if (bytes.toString("latin1", at, at + 4) !== "OggS") throw new Error(`no capture pattern at ${at}`);
    if (bytes[at + 4] !== 0) throw new Error(`version ${bytes[at + 4]} at ${at}`);
    const count = bytes[at + 26], lacing = bytes.subarray(at + 27, at + 27 + count);
    const size = lacing.reduce((sum, value) => sum + value, 0), end = at + 27 + count + size;
    if (end > bytes.length) throw new Error(`page at ${at} runs past the end`);
    const page = Buffer.from(bytes.subarray(at, end)), crc = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    if (referenceCrc(page) !== crc) throw new Error(`bad CRC on the page at ${at}`);
    const entry = { flags: bytes[at + 5], granule: Number(bytes.readBigInt64LE(at + 6)), serial: bytes.readUInt32LE(at + 14),
      sequence: bytes.readUInt32LE(at + 18), lacing: Uint8Array.from(lacing), body: bytes.subarray(at + 27 + count, end) };
    pages.push(entry);
    let pieces = partial.get(entry.serial) || [], offset = 0;
    if (!(entry.flags & 1) && pieces.length) throw new Error(`page ${entry.sequence} drops an unfinished packet`);
    if (entry.flags & 1 && !pieces.length) throw new Error(`page ${entry.sequence} continues a packet that never began`);
    for (const value of lacing) {
      pieces.push(entry.body.subarray(offset, offset + value));
      offset += value;
      if (value < 255) {
        if (!packets.has(entry.serial)) packets.set(entry.serial, []);
        packets.get(entry.serial).push(Buffer.concat(pieces));
        pieces = [];
      }
    }
    partial.set(entry.serial, pieces);
    at = end;
  }
  return { pages, packets };
}
