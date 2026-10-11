import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHUNK_SECONDS, loadAudio, partsFor, tooLongToSend } from "../lib/audio-file.js";
import { headerSeconds } from "../lib/audio-headers.js";
import { probeAudioFile } from "../lib/audio-preflight.js";
import { localizeAppMessage } from "../lib/application-messages.js";

/* #408: one transcription request must stay under the transcribe model's 98,304 input tokens, whatever the format, and a
   recording StudyHub cannot cut must be refused before a doomed request goes out. */

/** What Google said ("The input token count exceeds the maximum number of tokens allowed 98304") and how Gemini counts audio. */
const TRANSCRIBE_INPUT_TOKENS = 98_304, AUDIO_TOKENS_PER_SECOND = 32;

test("a request carries at most 45 minutes: under the model's input-token limit with room to spare", () => {
  assert.ok(CHUNK_SECONDS * AUDIO_TOKENS_PER_SECOND <= TRANSCRIBE_INPUT_TOKENS * 0.9, "at least 10% left for the vocabulary and instructions");
  assert.ok(59.5 * 60 * AUDIO_TOKENS_PER_SECOND > TRANSCRIBE_INPUT_TOKENS, "the old 59.5-minute chunk was over the limit for every format");
  // The three recordings of the report: 2 h 55 min, 1 h 45 min and 40 min.
  assert.deepEqual([10477, 6292, 2383].map((seconds) => partsFor(seconds)), [4, 3, 1]);
  for (const seconds of [10477, 6292, 2383]) assert.ok(seconds / partsFor(seconds) * AUDIO_TOKENS_PER_SECOND < TRANSCRIBE_INPUT_TOKENS);
  assert.equal(partsFor(3600, 59 * 60), 2, "a limit saved before (59 minutes) is lowered to 45");
});

const flac = (seconds, rate = 16000) => {
  const bytes = Buffer.alloc(42 + 64), samples = seconds * rate;
  bytes.write("fLaC", 0, "latin1");
  bytes[4] = 0x80; bytes[7] = 34;
  bytes[18] = rate >> 12; bytes[19] = (rate >> 4) & 0xff; bytes[20] = ((rate & 0xf) << 4) | (0 << 1) | 0;
  bytes[21] = (15 << 4) | Math.floor(samples / 2 ** 32); bytes.writeUInt32BE(samples % 2 ** 32, 22);
  return bytes;
};
const aiff = (seconds, rate = 8000) => {
  const exponent = Math.floor(Math.log2(rate)), mantissa = BigInt(rate) << BigInt(63 - exponent);
  const comm = Buffer.alloc(26);
  comm.write("COMM", 0, "latin1"); comm.writeUInt32BE(18, 4); comm.writeUInt16BE(1, 8); comm.writeUInt32BE(seconds * rate, 10); comm.writeUInt16BE(16, 14);
  comm.writeUInt16BE(16383 + exponent, 16); comm.writeBigUInt64BE(mantissa, 18);
  const head = Buffer.alloc(12);
  head.write("FORM", 0, "latin1"); head.writeUInt32BE(4 + comm.length + 16, 4); head.write("AIFF", 8, "latin1");
  return Buffer.concat([head, comm, Buffer.from("SSND\0\0\0\x08\0\0\0\0\0\0\0\0", "latin1")]);
};
const adts = (seconds, rate = 8000) => {
  const frame = Buffer.from([0xff, 0xf1, (1 << 6) | (11 << 2), 0x40, 0, 0x1f, 0xfc, 0, 0, 0]); // 8 kHz, mono, 10 bytes
  frame[3] = 0x40 | (10 >> 11); frame[4] = (10 >> 3) & 0xff; frame[5] = ((10 & 7) << 5) | 0x1f;
  return Buffer.concat(Array.from({ length: Math.ceil(seconds * rate / 1024) }, () => frame));
};
const webm = (milliseconds) => {
  const duration = Buffer.alloc(8); duration.writeDoubleBE(milliseconds);
  const info = Buffer.concat([Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]), Buffer.from([0x44, 0x89, 0x88]), duration]);
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80, 0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x80 | info.length]), info, Buffer.alloc(64)]);
};

test("FLAC, AIFF, AAC and WebM state how long they are", () => {
  assert.equal(headerSeconds(flac(3000), ".flac"), 3000);
  assert.equal(headerSeconds(aiff(3000), ".aiff"), 3000);
  assert.ok(Math.abs(headerSeconds(adts(3000), ".aac") - 3000) < 0.2);
  assert.equal(headerSeconds(webm(3_000_000), ".webm"), 3000);
  assert.equal(headerSeconds(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]), ".webm"), null, "a recorder's WebM without a duration says nothing");
  assert.equal(headerSeconds(Buffer.from("fLaC"), ".flac"), null);
});

test("a long recording StudyHub cannot cut is refused before anything is sent, and the pre-flight says so", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "audio-limit-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = { "lecture.flac": flac(50 * 60), "lecture.aiff": aiff(50 * 60), "lecture.aac": adts(46 * 60), "lecture.webm": webm(50 * 60_000) };
  for (const [name, bytes] of Object.entries(files)) {
    const file = join(dir, name);
    await writeFile(file, bytes);
    await assert.rejects(loadAudio({ path: file, ffmpeg: null }), (error) => {
      assert.equal(error.code, "AUDIO_UNSPLITTABLE");
      assert.match(error.message, /约 (46|50) 分钟，超过单次转写的 45 分钟上限；这种格式要切开需要 ffmpeg/);
      assert.match(localizeAppMessage(error.message), /^This (FLAC|AIFF|AAC|WebM) recording is about (46|50) minutes, above the 45-minute limit/);
      return true;
    }, name);
    await assert.rejects(loadAudio({ path: file, ffmpeg: null, measureOnly: true }), /AUDIO_UNSPLITTABLE|ffmpeg/, `${name}: the pre-flight check refuses it too`);
  }
  const short = join(dir, "short.flac");
  await writeFile(short, flac(30 * 60));
  const audio = await loadAudio({ path: short, ffmpeg: null });
  assert.deepEqual([audio.chunks.length, audio.seconds, audio.chunks[0].seconds], [1, 1800, 1800], "one that fits goes up whole, with its length known");
  const recorder = join(dir, "recorder.webm");
  await writeFile(recorder, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]), Buffer.alloc(4096)]));
  assert.deepEqual((await loadAudio({ path: recorder, ffmpeg: null })).chunks.map((chunk) => chunk.seconds), [0], "a small file of unknown length still goes up whole");
});

test("a file whose length is unknown is refused only when its size is clearly over one request", () => {
  assert.equal(tooLongToSend({ kind: ".webm", seconds: null, size: 50 * 1048576 }), null);
  const problem = tooLongToSend({ kind: ".ogg", seconds: null, size: 81 * 1048576, reason: "这份 OGG 由几段录音首尾相接而成（chained Ogg），不能在本地无损切分" });
  assert.match(problem, /^这份 OGG 读不出时长（这份 OGG 由几段录音首尾相接而成（chained Ogg），不能在本地无损切分），按大小（81\.0 MB）估计超过单次转写的 45 分钟上限/);
  assert.match(localizeAppMessage(problem), /^The length of this OGG recording cannot be read \(This OGG file is several recordings joined end to end \(chained Ogg\)/);
  assert.equal(tooLongToSend({ kind: ".flac", seconds: 44 * 60, size: 500 * 1048576 }), null, "a known length wins over the size");
});

test("the pre-flight check plans an Ogg recording's parts with the 45-minute limit, even with an old 59-minute setting", async (t) => {
  const { opusStream, writePages } = await import("./helpers/ogg-fixture.mjs");
  const dir = await mkdtemp(join(tmpdir(), "audio-limit-ogg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "2026-09-14_0956.ogg");
  await writeFile(file, writePages(opusStream({ seconds: 10477, perPage: 10, size: () => 3 }).pages));
  const probe = await probeAudioFile(file, { partSeconds: 59 * 60 });
  assert.equal(probe.blocked, false);
  assert.deepEqual([probe.format, Math.round(probe.seconds), probe.parts], ["opus", 10477, 4]);
  assert.deepEqual(probe.issue, { code: "long-split", minutes: 175, parts: 4, requests: 4, partMinutes: 45 });
  const audio = await loadAudio({ path: file });
  assert.deepEqual(audio.chunks.map((chunk) => Math.round(chunk.seconds / 60)), [44, 44, 44, 44], "the console shows each segment's real minutes");
  assert.ok(audio.chunks.every((chunk) => chunk.seconds * AUDIO_TOKENS_PER_SECOND < TRANSCRIBE_INPUT_TOKENS));
});

test("the new messages read in English too", () => {
  for (const [zh, en] of [
    ["OGG 文件末尾不完整（可能没有传完，或录音中途停了），最后不完整的一页已略去", /^The end of this OGG file is incomplete/],
    ["压缩编码的 WAV 超过 45 分钟无法切分，请先转成 MP3", /^Compressed WAV recordings longer than 45 minutes cannot be split/],
    ["这份 M4A 约 76 分钟，超过单次转写的 45 分钟上限，但它的内部结构不能在本地无损切分（这份 M4A 是分片格式（fragmented MP4），不能在本地无损切分）。请在录音软件里另存为 MP3 后再导入", /^This M4A is about 76 minutes, above the 45-minute limit of one transcription request, and its structure cannot be split losslessly here \(This M4A is a fragmented MP4/],
    ["读不懂这份 OGG 文件的结构（头信息不完整），可能不完整或已损坏", /^This OGG file's structure cannot be read \(the headers are incomplete\)/],
    ["这份 OGG 里的音频不是 Opus 或 Vorbis 编码，不能在本地无损切分", /neither Opus nor Vorbis/],
    ["这份 OGG 的头信息和音频挤在同一页里，不能在本地无损切分", /share a page/],
    ["ffmpeg 没有切出可用的音频", /^ffmpeg did not produce/],
    ["每次请求最长的分钟数应是 5 到 45 的整数", /from 5 to 45 minutes/],
  ]) assert.match(localizeAppMessage(zh), en, zh);
});
