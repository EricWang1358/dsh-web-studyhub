import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OggError, opusPacketSamples, parseOgg, splitOgg } from "../lib/audio-ogg.js";
import { CHUNK_SECONDS, loadAudio } from "../lib/audio-file.js";
import { OPUS_PACKET_SAMPLES, opusStream, readOggStrict, streamPages, vorbisStream, writePages } from "./helpers/ogg-fixture.mjs";

/* Lossless Ogg splitting (#408): a long Opus or Vorbis recording is cut at page boundaries into standalone Ogg files,
   nothing re-encoded. Every part is read back with the independent strict reader in helpers/ogg-fixture.mjs. */

const close = (actual, expected, within, what) => assert.ok(Math.abs(actual - expected) <= within, `${what}: ${actual} vs ${expected} (±${within})`);

/** Check one part as a standalone Ogg file; returns its audio packets and its last relative granule. */
function checkPart(bytes, { headers, serial, codec, index }) {
  const { pages, packets } = readOggStrict(bytes);
  assert.deepEqual(new Set(pages.map((page) => page.serial)), new Set([serial]), "only the audio stream is kept");
  assert.deepEqual(pages.map((page) => page.sequence), pages.map((_, i) => i), "page numbers run 0, 1, 2… without a gap");
  assert.equal(pages[0].flags & 2, 2, "the first page opens the stream (BOS)");
  assert.ok(pages.slice(1).every((page) => !(page.flags & 2)), "no other page claims to open it");
  assert.equal(pages.at(-1).flags & 4, 4, "the last page closes the stream (EOS)");
  assert.ok(pages.slice(0, -1).every((page) => !(page.flags & 4)), "no other page claims to close it");
  const own = packets.get(serial);
  assert.deepEqual(own.slice(0, headers.length), headers, "the header packets come first, byte for byte");
  // The first audio page is the page after the one that completes the last header packet.
  let done = 0, first = -1;
  for (const [i, page] of pages.entries()) {
    if (done >= headers.length) { first = i; break; }
    for (const value of page.lacing) if (value < 255) done++;
  }
  assert.ok(first > 0, "there is audio after the headers");
  const audioPages = pages.slice(first);
  assert.ok(pages.slice(0, first).every((page) => page.granule === 0 || page.granule === -1), "header pages keep granule 0 (or -1 where no packet ends)");
  assert.equal(audioPages[0].flags & 1, 0, "audio starts on a fresh packet, not in the middle of one");
  const granules = audioPages.map((page) => page.granule).filter((granule) => granule !== -1);
  assert.ok(granules.every((granule, i) => i === 0 || granule >= granules[i - 1]), `granules never go back (part ${index})`);
  const audio = own.slice(headers.length);
  if (codec === "opus" && index > 0) {
    // A part after the first starts at position 0: its first granule is exactly the samples of the packets that end on that page.
    let samples = 0, ended = 0;
    for (const value of audioPages[0].lacing) if (value < 255) samples += opusPacketSamples(audio[ended++]);
    assert.equal(audioPages[0].granule, samples, "the first audio page of a later part is counted from zero");
  }
  return { audio, last: granules.at(-1), pages };
}

test("an Opus stream: its length is the last granule minus pre-skip, at 48 kHz", () => {
  const stream = opusStream({ seconds: 600 });
  const info = parseOgg(writePages(stream.pages));
  assert.equal(info.codec, "opus");
  assert.equal(info.preSkip, 312);
  assert.equal(info.rate, 48000);
  close(info.seconds, 600, 1e-9, "duration");
  assert.equal(info.truncated, false);
  assert.equal(opusPacketSamples(Buffer.from([0xfb, 6])), OPUS_PACKET_SAMPLES);
  assert.equal(opusPacketSamples(Buffer.from([0x08])), 960, "SILK 20 ms, one frame");
  assert.equal(opusPacketSamples(Buffer.from([0x81])), 240, "CELT 2.5 ms, two frames");
});

test("an Opus stream is cut into standalone parts that hold every packet once, in order", () => {
  const stream = opusStream({ seconds: 600 }), bytes = writePages(stream.pages), info = parseOgg(bytes);
  const parts = splitOgg(bytes, 3, info);
  assert.equal(parts.length, 3);
  const headers = stream.packets.slice(0, 2).map((packet) => packet.data), audio = [];
  parts.forEach((part, index) => {
    const read = checkPart(part.bytes, { headers, serial: 0x5eed, codec: "opus", index });
    audio.push(...read.audio);
    close(part.seconds, 200, 1, `part ${index + 1} is about a third`);
    close((read.last - info.preSkip) / 48000, part.seconds, 1e-9, "the part's own granules say its length");
  });
  assert.deepEqual(audio, stream.audioPackets, "nothing lost, nothing doubled, nothing re-encoded");
  close(parts.reduce((sum, part) => sum + part.seconds, 0), 600 - 2 * 312 / 48000, 1e-6, "the parts add up (each later part drops its pre-skip)");
  const payload = (file) => Buffer.concat(readOggStrict(file).pages.slice(2).map((page) => page.body));
  assert.ok(Buffer.concat(parts.map((part) => payload(part.bytes))).equals(payload(bytes)), "the audio pages' payloads are the original's");
});

test("cuts fall only where a page ends a packet, even when packets run over several pages", () => {
  // Pages of at most 3 lacing values: a 1000-byte packet takes 4 values and spills across pages; some pages complete no packet.
  const stream = opusStream({ seconds: 120, perPage: 2, maxSegments: 3, size: (i) => (i % 5 === 2 ? 1000 : 9) });
  const bytes = writePages(stream.pages);
  assert.ok(stream.pages.some((page) => page.granule === -1), "the fixture has pages that end no packet");
  const parts = splitOgg(bytes, 4);
  assert.equal(parts.length, 4);
  const headers = stream.packets.slice(0, 2).map((packet) => packet.data), audio = [];
  parts.forEach((part, index) => {
    const read = checkPart(part.bytes, { headers, serial: 0x5eed, codec: "opus", index });
    assert.ok(read.pages.at(-1).lacing.at(-1) < 255, "a part never ends in the middle of a packet");
    audio.push(...read.audio);
  });
  assert.deepEqual(audio, stream.audioPackets);
});

test("header pages are copied whole, also when the comment header runs over two pages", () => {
  const stream = opusStream({ seconds: 90, tagsBytes: 70_000 });
  assert.ok(stream.pages[1].granule === -1 && stream.pages[2].granule === 0, "OpusTags spans two pages");
  const bytes = writePages(stream.pages), parts = splitOgg(bytes, 2);
  const headers = stream.packets.slice(0, 2).map((packet) => packet.data);
  const audio = parts.flatMap((part, index) => checkPart(part.bytes, { headers, serial: 0x5eed, codec: "opus", index }).audio);
  assert.deepEqual(audio, stream.audioPackets);
});

test("a stream that starts at a granule offset keeps it in the first part and leaves it out of the length", () => {
  const stream = opusStream({ seconds: 300, startGranule: 48000 * 7 }), bytes = writePages(stream.pages), info = parseOgg(bytes);
  close(info.seconds, 300, 1e-9, "the offset is not part of the recording");
  assert.equal(info.startOffset, 48000 * 7);
  const parts = splitOgg(bytes, 2, info);
  close(parts.reduce((sum, part) => sum + part.seconds, 0), 300 - 312 / 48000, 1e-6, "lengths add up");
  const first = readOggStrict(parts[0].bytes).pages;
  assert.equal(first[2].granule, stream.pages[2].granule, "the first part keeps the original positions");
});

test("an Ogg Vorbis stream: three headers, length from the last granule and the sample rate", () => {
  const stream = vorbisStream({ seconds: 400, rate: 44100 }), bytes = writePages(stream.pages), info = parseOgg(bytes);
  assert.equal(info.codec, "vorbis");
  assert.equal(info.rate, 44100);
  close(info.seconds, 400, 1e-9, "duration");
  const parts = splitOgg(bytes, 2, info);
  const headers = stream.packets.slice(0, 3).map((packet) => packet.data);
  const audio = parts.flatMap((part, index) => checkPart(part.bytes, { headers, serial: 0x7001, codec: "vorbis", index }).audio);
  assert.deepEqual(audio, stream.audioPackets);
  close(parts.reduce((sum, part) => sum + part.seconds, 0), 400, 1e-6, "Vorbis has no pre-skip: the parts add up exactly");
  const second = readOggStrict(parts[1].bytes).pages;
  close(second.at(-1).granule / 44100, parts[1].seconds, 1e-9, "the second part's granules are its own");
});

test("a final page cut short is left out, and the rest is still read and split", () => {
  const stream = opusStream({ seconds: 200 }), whole = writePages(stream.pages), bytes = whole.subarray(0, whole.length - 5);
  const info = parseOgg(bytes);
  assert.equal(info.truncated, true);
  assert.ok(info.seconds < 200 && info.seconds > 198, `${info.seconds}`);
  const parts = splitOgg(bytes, 2, info);
  for (const [index, part] of parts.entries()) checkPart(part.bytes, { headers: stream.packets.slice(0, 2).map((p) => p.data), serial: 0x5eed, codec: "opus", index });
  // A tag a tagger appended after the last page (ID3v1: "TAG" and 125 bytes) is not audio and does not stop the split.
  const tagged = Buffer.concat([whole, Buffer.from("TAG".padEnd(128, "x"), "latin1")]), read = parseOgg(tagged);
  assert.deepEqual([read.truncated, read.seconds], [false, 200]);
  assert.ok(splitOgg(tagged, 2, read).every((part) => !part.bytes.includes("TAGxxx")), "the tag is left out of the parts");
});

test("another logical stream multiplexed with the audio is dropped from the parts", () => {
  const audio = opusStream({ seconds: 120 }), skeleton = streamPages([{ data: Buffer.from("fishead\0skeleton", "latin1"), granule: 0, flush: true },
    { data: Buffer.from("index"), granule: 0, flush: true }], { serial: 0x51ce });
  // Every BOS page comes first, then the streams' pages interleave.
  const pages = [audio.pages[0], skeleton[0], ...audio.pages.slice(1, 5), skeleton[1], ...audio.pages.slice(5)];
  const info = parseOgg(writePages(pages));
  assert.equal(info.serial, 0x5eed);
  const parts = splitOgg(writePages(pages), 2, info);
  const all = parts.flatMap((part, index) => checkPart(part.bytes, { headers: audio.packets.slice(0, 2).map((p) => p.data), serial: 0x5eed, codec: "opus", index }).audio);
  assert.deepEqual(all, audio.audioPackets);
});

test("what cannot be cut losslessly is refused with a reason", () => {
  const one = opusStream({ seconds: 30, serial: 1 }), two = opusStream({ seconds: 30, serial: 2 });
  assert.throws(() => parseOgg(writePages([...one.pages, ...two.pages])), (error) => error instanceof OggError && error.code === "OGG_UNSUPPORTED" && /chained/.test(error.message));
  const speex = streamPages([{ data: Buffer.from("Speex   1.2", "latin1"), granule: 0, flush: true }, { data: Buffer.alloc(30), granule: 160, flush: true }]);
  assert.throws(() => parseOgg(writePages(speex)), (error) => error.code === "OGG_UNSUPPORTED" && /Opus 或 Vorbis/.test(error.message));
  const good = writePages(opusStream({ seconds: 30 }).pages);
  assert.throws(() => parseOgg(Buffer.concat([good.subarray(0, 200), Buffer.from("this is not a page at all, it is junk"), good.subarray(200)])), (error) => error.code === "OGG_UNREADABLE");
  assert.throws(() => parseOgg(Buffer.from("not an ogg file at all, really not")), (error) => error.code === "OGG_UNREADABLE");
  assert.throws(() => parseOgg(writePages(opusStream({ seconds: 30 }).pages.slice(0, 2))), (error) => error.code === "OGG_UNREADABLE", "headers without audio");
});

/* ---- loadAudio: long Ogg files are cut like MP3, WAV and M4A ---- */

test("loadAudio cuts a 100-minute .ogg (Opus) into parts that each fit one request, with their real lengths", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "audio-ogg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "2026-09-14_1311.ogg");
  await writeFile(file, writePages(opusStream({ seconds: 6000, perPage: 9 }).pages));
  const audio = await loadAudio({ path: file });
  assert.deepEqual([audio.ext, audio.declaredExt, audio.mimeType, audio.warnings], [".opus", ".ogg", "audio/opus", []]);
  close(audio.seconds, 6000, 1e-6, "length");
  assert.equal(audio.chunks.length, Math.ceil(6000 / CHUNK_SECONDS));
  assert.ok(audio.chunks.every((chunk) => chunk.seconds > 0 && chunk.seconds <= CHUNK_SECONDS), audio.chunks.map((c) => c.seconds).join(", "));
  close(audio.chunks.reduce((sum, chunk) => sum + chunk.seconds, 0), 6000, 0.05, "the chunks add up to the recording");
  for (const chunk of audio.chunks) assert.doesNotThrow(() => readOggStrict(chunk.bytes));
  const measured = await loadAudio({ path: file, measureOnly: true });
  assert.deepEqual([measured.parts, measured.ext], [audio.chunks.length, ".opus"]);
  close(measured.seconds, 6000, 1e-6, "pre-flight length");
});

test("loadAudio honours the learner's shorter limit for .opus, and sends a short one whole", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "audio-opus-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const long = join(dir, "lecture.opus"), short = join(dir, "short.opus");
  const bytes = writePages(opusStream({ seconds: 50 * 60 }).pages);
  await writeFile(long, bytes);
  await writeFile(short, writePages(opusStream({ seconds: 300 }).pages));
  assert.equal((await loadAudio({ path: long })).chunks.length, 2);
  const limited = await loadAudio({ path: long, partSeconds: 600 });
  assert.equal(limited.chunks.length, 5);
  assert.ok(limited.chunks.every((chunk) => chunk.seconds <= 601));
  const whole = await loadAudio({ path: short });
  assert.equal(whole.chunks.length, 1);
  close(whole.chunks[0].seconds, 300, 1e-6, "a whole file still says how long it is");
  assert.ok(whole.chunks[0].bytes.equals(await import("node:fs/promises").then((fs) => fs.readFile(short))), "a file that fits is sent as it is");
});

test("loadAudio cuts a long Ogg Vorbis file, warns about a cut-off end, and sends what it cannot read as before", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "audio-vorbis-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const vorbis = join(dir, "class.ogg"), cut = join(dir, "cut.ogg"), chained = join(dir, "chained.ogg");
  await writeFile(vorbis, writePages(vorbisStream({ seconds: 50 * 60, rate: 16000, perPage: 40 }).pages));
  const whole = writePages(opusStream({ seconds: 600 }).pages);
  await writeFile(cut, whole.subarray(0, whole.length - 3));
  await writeFile(chained, writePages([...opusStream({ seconds: 20, serial: 1 }).pages, ...opusStream({ seconds: 20, serial: 2 }).pages]));
  const read = await loadAudio({ path: vorbis });
  assert.deepEqual([read.ext, read.chunks.length], [".ogg", 2]);
  close(read.chunks.reduce((sum, chunk) => sum + chunk.seconds, 0), 3000, 1e-6, "Vorbis parts add up");
  const truncated = await loadAudio({ path: cut });
  assert.match(truncated.warnings.join(" "), /末尾不完整/);
  // A chained file is not cut; a short one still goes up whole, as it always has (only a long one is refused).
  const chain = await loadAudio({ path: chained });
  assert.deepEqual([chain.chunks.length, chain.chunks[0].seconds], [1, 0]);
});
