import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseM4a, splitM4a } from "../lib/audio-m4a.js";
import { loadAudio } from "../lib/audio-file.js";
import { groqPlan } from "../lib/groq.js";

/* Lossless M4A splitting (P46): the AAC frames are copied, never re-encoded; each part is a small valid M4A
   with the original sample description. The checks below read the parts with an independent box walker. */

const FIXTURE = new URL("./fixtures/wp6-tone.m4a", import.meta.url);

/* ---------- an independent reader for what the splitter writes ---------- */
function boxes(bytes, from = 0, to = bytes.length) {
  const list = [];
  for (let at = from; at + 8 <= to;) {
    let size = bytes.readUInt32BE(at), header = 8;
    const type = bytes.toString("latin1", at + 4, at + 8);
    if (size === 1) { size = Number(bytes.readBigUInt64BE(at + 8)); header = 16; } else if (size === 0) size = to - at;
    assert.ok(size >= header && at + size <= to, `box ${type} at ${at} fits its parent`);
    list.push({ type, start: at, body: at + header, end: at + size });
    at += size;
  }
  return list;
}
const child = (bytes, box, type) => boxes(bytes, box.body, box.end).find((item) => item.type === type);
const path = (bytes, top, ...types) => types.reduce((box, type) => box && child(bytes, box, type), top);
function readPart(bytes) {
  const top = boxes(bytes);
  const moov = top.find((box) => box.type === "moov"), mdat = top.find((box) => box.type === "mdat");
  const stbl = path(bytes, moov, "trak", "mdia", "minf", "stbl"), mdhd = path(bytes, moov, "trak", "mdia", "mdhd");
  const stsz = child(bytes, stbl, "stsz"), stts = child(bytes, stbl, "stts"), stco = child(bytes, stbl, "stco") || child(bytes, stbl, "co64");
  const count = bytes.readUInt32BE(stsz.body + 8), sizes = Array.from({ length: count }, (_, i) => bytes.readUInt32BE(stsz.body + 12 + i * 4));
  let duration = 0;
  for (let i = 0, n = bytes.readUInt32BE(stts.body + 4); i < n; i++) duration += bytes.readUInt32BE(stts.body + 8 + i * 8) * bytes.readUInt32BE(stts.body + 12 + i * 8);
  const offset = stco.type === "co64" ? Number(bytes.readBigUInt64BE(stco.body + 8)) : bytes.readUInt32BE(stco.body + 8);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const version = bytes[mdhd.body], timescale = bytes.readUInt32BE(mdhd.body + (version === 1 ? 20 : 12));
  const mdhdDuration = version === 1 ? Number(bytes.readBigUInt64BE(mdhd.body + 24)) : bytes.readUInt32BE(mdhd.body + 16);
  return { top: top.map((box) => box.type), count, sizes, duration, timescale, mdhdDuration,
    stsd: bytes.subarray(child(bytes, stbl, "stsd").start, child(bytes, stbl, "stsd").end),
    data: bytes.subarray(offset, offset + total), insideMdat: offset >= mdat.body && offset + total <= mdat.end };
}

/* ---------- a synthetic MP4 with awkward but valid sample tables ---------- */
const box = (type, ...parts) => { const body = Buffer.concat(parts); const head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, "latin1"); return Buffer.concat([head, body]); };
const full = (type, version, flags, ...parts) => { const head = Buffer.alloc(4); head.writeUInt32BE((version << 24) | flags); return box(type, head, ...parts); };
const words = (values) => { const out = Buffer.alloc(values.length * 4); values.forEach((value, i) => out.writeUInt32BE(value, i * 4)); return out; };
const u32 = (...values) => words(values);
const u64 = (value) => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out; };
const STSD = full("stsd", 0, 0, u32(1), box("mp4a", Buffer.alloc(6), Buffer.from([0, 1]), Buffer.alloc(8), Buffer.from([0, 1, 0, 16, 0, 0, 0, 0, 0x3e, 0x80, 0, 0]),
  full("esds", 0, 0, Buffer.from([3, 25, 0, 1, 0, 4, 17, 0x40, 0x15, 0, 0, 0, 0, 0, 0x5d, 0xc0, 0, 0, 0x5d, 0xc0, 5, 2, 0x14, 0x08, 6, 1, 2]))));
/**
 * samples: frame payloads; durations: per-sample durations; chunks: samples per chunk (cycled); gaps put junk between
 * chunks so offsets are not contiguous; moovFirst/co64 choose the layout.
 */
function synthetic({ samples, durations, chunks = [3, 5, 1], moovFirst = false, co64 = false, timescale = 16000 }) {
  const layout = []; // [first sample, count]
  for (let i = 0, c = 0; i < samples.length; c++) { const n = Math.min(chunks[c % chunks.length], samples.length - i); layout.push([i, n]); i += n; }
  const runs = [];
  for (const d of durations) { if (runs.length && runs.at(-1)[1] === d) runs.at(-1)[0]++; else runs.push([1, d]); }
  const stsc = []; let previous = -1;
  layout.forEach(([, n], index) => { if (n !== previous) { stsc.push(index + 1, n, 1); previous = n; } });
  const total = durations.reduce((a, b) => a + b, 0);
  const moov = (offsets) => box("moov",
    full("mvhd", 0, 0, u32(0, 0, 1000, Math.round(total / timescale * 1000), 0x00010000), Buffer.from([1, 0]), Buffer.alloc(10), u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000), Buffer.alloc(24), u32(2)),
    box("trak", full("tkhd", 0, 3, u32(0, 0, 1, 0, Math.round(total / timescale * 1000)), Buffer.alloc(8), Buffer.from([0, 0, 0, 0, 1, 0, 0, 0]), u32(0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000), u32(0, 0)),
      box("mdia", full("mdhd", 0, 0, u32(0, 0, timescale, total), Buffer.from([0x55, 0xc4, 0, 0])),
        full("hdlr", 0, 0, u32(0), Buffer.from("soun"), Buffer.alloc(12), Buffer.from("SoundHandler\0")),
        box("minf", full("smhd", 0, 0, u32(0)), box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))),
          box("stbl", STSD, full("stts", 0, 0, u32(runs.length), words(runs.flat())),
            full("stsc", 0, 0, u32(stsc.length / 3), words(stsc)), full("stsz", 0, 0, u32(0, samples.length), words(samples.map((s) => s.length))),
            co64 ? full("co64", 0, 0, u32(offsets.length), Buffer.concat(offsets.map(u64))) : full("stco", 0, 0, u32(offsets.length), words(offsets)))))));
  const ftyp = box("ftyp", Buffer.from("M4A "), u32(512), Buffer.from("M4A isomiso2"));
  const payload = [], relative = [];
  let at = 0;
  for (const [first, n] of layout) {
    const junk = Buffer.alloc(7, 0xee); payload.push(junk); at += junk.length; // bytes that belong to no sample
    relative.push(at);
    for (const sample of samples.slice(first, first + n)) { payload.push(sample); at += sample.length; }
  }
  const mdat = box("mdat", Buffer.concat(payload));
  if (!moovFirst) return Buffer.concat([ftyp, mdat, moov(relative.map((r) => ftyp.length + 8 + r))]);
  const size = moov(relative.map(() => 0)).length;
  return Buffer.concat([ftyp, moov(relative.map((r) => ftyp.length + size + 8 + r)), mdat]);
}
const frames = (count, seed = 1) => Array.from({ length: count }, (_, i) => Buffer.from(Array.from({ length: 4 + ((i * 7 + seed) % 9) }, (_, j) => (i * 31 + j * seed) & 0xff)));
const concatSamples = (list) => Buffer.concat(list);

function assertSplit(original, parts, expect) {
  const read = parts.map((part) => readPart(part.bytes));
  for (const part of read) {
    assert.deepEqual(part.top, ["ftyp", "moov", "mdat"], "each part is ftyp, moov, then mdat");
    assert.ok(part.insideMdat, "the chunk offset points into the part's own mdat");
    assert.equal(part.mdhdDuration, part.duration, "the media header says how long the part is");
    assert.ok(part.stsd.equals(expect.stsd), "the sample description (esds) is copied byte for byte");
    assert.ok(part.count > 0);
  }
  assert.equal(read.reduce((n, part) => n + part.count, 0), expect.count, "no frame lost or duplicated");
  assert.equal(read.reduce((n, part) => n + part.duration, 0), expect.duration, "the durations add up to the recording");
  assert.ok(Buffer.concat(read.map((part) => part.data)).equals(expect.data), "the AAC frames are copied unchanged and in order");
  assert.ok(Math.abs(parts.reduce((sum, part) => sum + part.seconds, 0) - expect.duration / expect.timescale) < 1e-6);
  return read;
}

test("a real AAC M4A (moov after mdat) is read: frames, sizes, offsets and duration", async () => {
  const bytes = await readFile(FIXTURE);
  const info = parseM4a(bytes);
  assert.equal(info.samples.count, 220, "ffprobe counts 220 frames");
  assert.equal(info.timescale, 16000);
  assert.ok(Math.abs(info.seconds - 14) < 0.1, `about 14 s, got ${info.seconds}`);
  const stsd = readPart(splitM4a(bytes, 1)[0].bytes).stsd;
  assert.ok(bytes.includes(stsd), "a single part keeps the original stsd");
});

test("the real recording splits into 3 valid M4A parts near equal durations, losslessly", async () => {
  const bytes = await readFile(FIXTURE), info = parseM4a(bytes);
  const parts = splitM4a(bytes, 3);
  assert.equal(parts.length, 3);
  const data = Buffer.concat(Array.from({ length: info.samples.count }, (_, i) => bytes.subarray(info.samples.offsets[i], info.samples.offsets[i] + info.samples.sizes[i])));
  const read = assertSplit(bytes, parts, { count: 220, duration: info.duration, timescale: 16000, stsd: readPart(splitM4a(bytes, 1)[0].bytes).stsd, data });
  for (const part of read) assert.ok(Math.abs(part.duration / 16000 - 14 / 3) < 0.2, `each part is about a third: ${part.duration / 16000}`);
});

for (const layout of [{ moovFirst: false, co64: false }, { moovFirst: true, co64: false }, { moovFirst: true, co64: true }, { moovFirst: false, co64: true }]) {
  test(`synthetic MP4 (${layout.moovFirst ? "moov first" : "moov last"}, ${layout.co64 ? "co64" : "stco"}, uneven chunks, gaps, mixed stts) splits losslessly`, () => {
    const samples = frames(101, 3), durations = samples.map((_, i) => (i === 100 ? 512 : 1024));
    const bytes = synthetic({ samples, durations, ...layout });
    const info = parseM4a(bytes);
    assert.equal(info.samples.count, 101);
    assert.equal(info.duration, 100 * 1024 + 512);
    for (const count of [1, 2, 4, 7]) {
      const parts = splitM4a(bytes, count);
      assert.equal(parts.length, count);
      assertSplit(bytes, parts, { count: 101, duration: info.duration, timescale: 16000, stsd: STSD, data: concatSamples(samples) });
    }
  });
}

test("files that are not a plain M4A are refused with a reason instead of a broken split", () => {
  assert.throws(() => parseM4a(Buffer.alloc(64)), (error) => error.code === "M4A_UNREADABLE");
  const fragmented = Buffer.concat([box("ftyp", Buffer.from("iso5"), u32(0)), box("moov", full("mvhd", 0, 0, u32(0, 0, 1000, 0))), box("moof", Buffer.alloc(8)), box("mdat", Buffer.alloc(8))]);
  assert.throws(() => parseM4a(fragmented), (error) => error.code === "M4A_UNSUPPORTED");
});

test("a 76-minute M4A is split by loadAudio into 2 lossless parts instead of asking for ffmpeg", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wp6-m4a-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const count = Math.ceil(76 * 60 * 16000 / 1024), samples = frames(count, 5);
  const file = join(dir, "PE1.m4a");
  await writeFile(file, synthetic({ samples, durations: samples.map(() => 1024), moovFirst: false, chunks: [22] }));
  const audio = await loadAudio({ path: file, partSeconds: 59 * 60 });
  assert.equal(audio.ext, ".m4a");
  assert.ok(Math.abs(audio.seconds - 76 * 60) < 1);
  assert.equal(audio.chunks.length, 2, "the fewest parts that fit the one-hour limit");
  const read = audio.chunks.map((chunk) => readPart(chunk.bytes));
  assert.equal(read.reduce((n, part) => n + part.count, 0), count);
  assert.ok(audio.chunks.every((chunk) => chunk.seconds < 3600 && chunk.seconds > 30 * 60), audio.chunks.map((c) => c.seconds).join(", "));
  assert.ok(Buffer.concat(read.map((part) => part.data)).equals(concatSamples(samples)));
});

test("an M4A over a free provider's size limit is cut in pure JS when ffmpeg is absent", async () => {
  const samples = frames(4000, 2), bytes = synthetic({ samples, durations: samples.map(() => 1024) });
  const plan = await groqPlan({ bytes, kind: ".m4a", seconds: 4000 * 1024 / 16000, limit: Math.ceil(bytes.length / 3), ffmpeg: null });
  assert.ok(!plan.error, plan.error);
  const pieces = await Promise.all(Array.from({ length: plan.count }, (_, i) => plan.load(i)));
  assert.ok(pieces.length >= 3 && pieces.every((piece) => piece.ext === "m4a" && piece.bytes.length <= Math.ceil(bytes.length / 3)));
  assert.ok(Buffer.concat(pieces.map((piece) => readPart(piece.bytes).data)).equals(concatSamples(samples)));
});

const ffprobe = spawnSync("ffprobe", ["-version"], { stdio: "ignore", windowsHide: true }).status === 0;
test("each part of the real recording decodes in ffmpeg with the expected length", { skip: !ffprobe && "ffprobe is not installed" }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wp6-m4a-probe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parts = splitM4a(await readFile(FIXTURE), 2);
  let total = 0;
  for (const [index, part] of parts.entries()) {
    const file = join(dir, `part${index}.m4a`);
    await writeFile(file, part.bytes);
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,nb_frames:format=duration", "-of", "json", file], { encoding: "utf8", windowsHide: true });
    assert.equal(probe.status, 0, probe.stderr);
    const json = JSON.parse(probe.stdout);
    assert.equal(json.streams[0].codec_name, "aac");
    total += Number(json.streams[0].nb_frames);
    assert.ok(Math.abs(Number(json.format.duration) - part.seconds) < 0.1, `${json.format.duration} vs ${part.seconds}`);
    const decode = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8", windowsHide: true });
    assert.equal(decode.status, 0, decode.stderr);
    assert.equal(decode.stderr.trim(), "", "decodes without errors");
  }
  assert.equal(total, 220);
});
