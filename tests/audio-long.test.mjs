import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { longFetch } from "../lib/http.js";
import { GeminiTiers, GeminiError, transcribeTimeoutMs, uploadTimeoutMs, describeFailure } from "../lib/gemini.js";
import { CHUNK_SECONDS, loadAudio, partsFor, sniffAudio, splitWavQuiet, wavInfo } from "../lib/audio-file.js";
import { saveAudioSettings, readAudioSettings } from "../lib/audio-settings.js";

const PAID = "AIzaLongTestKey_00000000000000001";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const reply = (text) => json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} });
const frame = Buffer.alloc(417);
frame.set([0xff, 0xfb, 0x90, 0x00]);
const pcmWav = (seconds, rate, sample = () => 8000) => {
  const count = seconds * rate, data = Buffer.alloc(count * 2), header = Buffer.alloc(44);
  for (let i = 0; i < count; i++) data.writeInt16LE(sample(i / rate, i), i * 2);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

/* ---- the long-deadline client ---- */

async function server(handler) {
  const listener = http.createServer(handler);
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${listener.address().port}`, close: () => new Promise((resolve) => { listener.closeAllConnections?.(); listener.close(resolve); }) };
}

test("longFetch sends and receives whole bodies in the shape the Gemini client expects", async (t) => {
  const seen = [];
  const local = await server(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts);
    seen.push({ method: req.method, length: body.length, type: req.headers["content-type"], size: req.headers["content-length"] });
    if (req.url === "/teapot") return res.writeHead(418, { "x-goog-upload-url": "https://example/u" }).end('{"error":{"message":"short"}}');
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ echoed: body.length }));
  });
  t.after(local.close);
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  const ok = await longFetch(`${local.url}/echo`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: big });
  assert.equal(ok.status, 200);
  assert.equal(ok.ok, true);
  assert.deepEqual(await ok.json(), { echoed: big.length });
  assert.deepEqual(seen[0], { method: "POST", length: big.length, type: "application/octet-stream", size: String(big.length) });
  const teapot = await longFetch(`${local.url}/teapot`, { method: "POST", body: "{}" });
  assert.deepEqual([teapot.status, teapot.ok, teapot.headers.get("X-Goog-Upload-Url"), teapot.headers.get("missing")], [418, false, "https://example/u", null]);
  assert.equal((await teapot.json()).error.message, "short");
});

test("longFetch waits as long as it is told, then fails with a timeout that says how long, and obeys abort", async (t) => {
  const local = await server((req, res) => setTimeout(() => res.end("late"), 600));
  t.after(local.close);
  await assert.rejects(longFetch(`${local.url}/slow`, { timeoutMs: 120 }), (error) => {
    assert.ok(error instanceof TypeError);
    assert.equal(error.cause.code, "LONGFETCH_TIMEOUT");
    assert.equal(error.cause.timeoutMs, 120);
    return true;
  });
  assert.equal(await (await longFetch(`${local.url}/slow`, { timeoutMs: 5000 })).text(), "late", "a longer deadline gets the answer");
  const controller = new AbortController();
  const pending = longFetch(`${local.url}/slow`, { signal: controller.signal, timeoutMs: 5000 });
  setTimeout(() => controller.abort(new Error("stopped by the learner")), 50);
  await assert.rejects(pending, /stopped by the learner/);
  await assert.rejects(longFetch("http://example.com/x"), /Only https/, "keys never go out in the clear");
  await assert.rejects(longFetch("http://127.0.0.1:9/x"), (error) => error.cause.code === "ECONNREFUSED");
});

/* ---- deadlines follow the size of the work ---- */

test("the wait for a transcription grows with the audio, within a floor and a cap", () => {
  const minutes = (seconds, bytes) => transcribeTimeoutMs(seconds, bytes) / 60_000;
  assert.equal(minutes(60), 5, "a short clip still gets five minutes");
  assert.ok(minutes(13.7 * 60) > 9 && minutes(13.7 * 60) < 12);
  assert.equal(minutes(47.8 * 60), 30, "a long recording gets the cap");
  assert.ok(minutes(20 * 60) > minutes(13.7 * 60));
  assert.equal(minutes(0, 30 * 1024 * 1024) > 5, true, "with no duration the byte size decides");
  assert.ok(uploadTimeoutMs(1024) >= 120_000 && uploadTimeoutMs(87.6 * 1048576) > 14 * 60_000 && uploadTimeoutMs(10 * 1024 ** 3) === 40 * 60_000);
});

test("a transcription request carries the deadline for its own length and size", async () => {
  const timeouts = [];
  const fetch = async (url, init = {}) => {
    url = String(url);
    if (init.method === "DELETE") return json({});
    if (url.endsWith("/upload/v1beta/files")) { timeouts.push(["start", init.timeoutMs]); return new Response("{}", { headers: { "x-goog-upload-url": "https://generativelanguage.googleapis.com/upload/session/s1" } }); }
    if (url.endsWith("/upload/session/s1")) { timeouts.push(["upload", init.timeoutMs]); return json({ file: { name: "files/f", uri: "https://generativelanguage.googleapis.com/v1beta/files/f", state: "ACTIVE" } }); }
    timeouts.push(["generate", init.timeoutMs]);
    return reply("text");
  };
  const tiers = new GeminiTiers({ keys: { paid: PAID }, fetch });
  const bytes = Buffer.alloc(13 * 1024 * 1024);
  await tiers.transcribe({ bytes, mimeType: "audio/wav", seconds: 47.8 * 60 });
  assert.deepEqual(timeouts, [["start", 60_000], ["upload", uploadTimeoutMs(bytes.length)], ["generate", 30 * 60_000]]);
  timeouts.length = 0;
  // A fresh client: the first one remembers that sending through the Files API worked.
  await new GeminiTiers({ keys: { paid: PAID }, fetch }).transcribe({ bytes: Buffer.alloc(2000), mimeType: "audio/wav", seconds: 13.7 * 60 });
  assert.deepEqual(timeouts, [["generate", transcribeTimeoutMs(13.7 * 60)]]);
});

const timedOut = (ms) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`no response within ${ms / 1000} seconds`), { code: "LONGFETCH_TIMEOUT", timeoutMs: ms }) });

test("a timeout is tried once more, then reported with the wait it gave up after", async () => {
  let calls = 0;
  const flaky = new GeminiTiers({ keys: { paid: PAID }, fetch: async () => { if (++calls === 1) throw timedOut(1_500_000); return reply("worked the second time"); } });
  assert.equal((await flaky.transcribe({ bytes: Buffer.alloc(2000), mimeType: "audio/wav", seconds: 600 })).text, "worked the second time");
  assert.equal(calls, 2);

  calls = 0;
  const dead = new GeminiTiers({ keys: { paid: PAID }, fetch: async () => { calls++; throw timedOut(1_500_000); } });
  await assert.rejects(dead.transcribe({ bytes: Buffer.alloc(2000), mimeType: "audio/wav", seconds: 600 }), (error) => {
    assert.ok(error instanceof GeminiError && error.fatal);
    assert.match(error.message, /Google 超过 25 分钟没有回应.*调小/);
    return true;
  });
  assert.equal(calls, 2, "one try and one more, no oftener: each can spend quota");
  assert.match(describeFailure(0, { error: { code: "UND_ERR_HEADERS_TIMEOUT" } }, "paid"), /超过 5 分钟没有回应/);
  assert.match(describeFailure(0, { error: { message: "getaddrinfo ENOTFOUND generativelanguage.googleapis.com" } }, "paid"), /ENOTFOUND/);
});

/* ---- what is in the file decides how it is read and cut ---- */

test("a recording goes in as few requests as the limit allows", () => {
  assert.deepEqual([3000, CHUNK_SECONDS, CHUNK_SECONDS + 1, 65 * 60, 121 * 60].map((s) => partsFor(s)), [1, 1, 2, 2, 3]);
  assert.equal(partsFor(1300, 600), 3);
  assert.equal(partsFor(1300, 10), partsFor(1300, 300), "a limit below five minutes is raised to five");
  assert.equal(partsFor(9999, 99999), partsFor(9999), "and one above the model's hour is lowered");
});

test("cuts land in the quietest moment near where an even split would fall", () => {
  const gaps = [[762, 764], [1489, 1491], [2262, 2264]];
  const wav = pcmWav(3000, 1000, (seconds, i) => (gaps.some(([from, to]) => seconds >= from && seconds < to) ? 0 : i % 2 ? 8000 : -8000));
  const info = wavInfo(wav), pieces = splitWavQuiet(wav, info, 4);
  assert.equal(pieces.length, 4);
  assert.ok(Math.abs(pieces.reduce((n, p) => n + p.seconds, 0) - 3000) < 0.01, "nothing is lost");
  let at = 0;
  pieces.slice(0, -1).forEach((piece, index) => {
    at += piece.seconds;
    assert.ok(at >= gaps[index][0] && at <= gaps[index][1], `cut ${index + 1} at ${at}s is inside the pause ${gaps[index]}`);
    assert.equal(wavInfo(piece.bytes).dataLength, piece.bytes.length - 44, "each piece is a WAV of its own");
  });
});

test("the bytes decide the format: a WAV called .mp3 is read as a WAV, nonsense is refused", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "audio-sniff-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const disguised = join(dir, "谷歌地图应用案例讲解.mp3"), mp3 = join(dir, "real.mp3"), junk = join(dir, "junk.mp3"), long = join(dir, "long.wav");
  await writeFile(disguised, pcmWav(5, 8000));
  await writeFile(mp3, Buffer.concat(Array.from({ length: 120 }, () => frame)));
  await writeFile(junk, Buffer.from(Array.from({ length: 6000 }, (_, i) => (i * 7919 + 13) % 251)));
  await writeFile(long, pcmWav(700, 1000));

  const wav = await loadAudio({ path: disguised });
  assert.deepEqual([wav.ext, wav.declaredExt, wav.mimeType, wav.chunks.length], [".wav", ".mp3", "audio/wav", 1]);
  assert.match(wav.warnings[0], /文件扩展名是 \.mp3，实际内容是 WAV 格式，已按 WAV 处理/);
  assert.ok(Math.abs(wav.seconds - 5) < 0.01);

  const real = await loadAudio({ path: mp3 });
  assert.deepEqual([real.ext, real.mimeType, real.warnings], [".mp3", "audio/mp3", []]);
  await assert.rejects(loadAudio({ path: junk }), /MP3/);

  assert.equal((await loadAudio({ path: long })).chunks.length, 1, "seven minutes fit one request");
  const limited = await loadAudio({ path: long, partSeconds: 300 });
  assert.equal(limited.chunks.length, 3, "the learner's own limit is honoured");
  assert.ok(limited.chunks.every((c) => c.seconds < 300), "each part fits the limit, allowing for the cut to move to a pause");
  assert.ok(Math.abs(limited.chunks.reduce((n, c) => n + c.seconds, 0) - 700) < 0.01);
});

test("formats are told apart by their first bytes", () => {
  const at = (...bytes) => Buffer.from(bytes);
  const text = (value, offset = 0) => Buffer.concat([Buffer.alloc(offset), Buffer.from(value, "latin1"), Buffer.alloc(20)]);
  assert.equal(sniffAudio(text("RIFF\0\0\0\0WAVEfmt ")), ".wav");
  assert.equal(sniffAudio(text("ID3\x03")), ".mp3");
  assert.equal(sniffAudio(text("fLaC")), ".flac");
  assert.equal(sniffAudio(text("OggS\0\0OpusHead")), ".opus");
  assert.equal(sniffAudio(text("OggS\0\0\x01vorbis")), ".ogg");
  assert.equal(sniffAudio(text("ftypM4A ", 4)), ".m4a");
  assert.equal(sniffAudio(at(0x1a, 0x45, 0xdf, 0xa3, 0)), ".webm");
  assert.equal(sniffAudio(at(0xff, 0xfb, 0x90, 0)), ".mp3");
  assert.equal(sniffAudio(at(0xff, 0xf1, 0x50, 0)), ".aac");
  assert.equal(sniffAudio(Buffer.from("just some text")), null);
});

test("the longest a request may be is a setting, within what the model allows", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "audio-part-")), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(home, { recursive: true, force: true }); });
  assert.equal((await readAudioSettings()).partMinutes, 59, "as long as possible by default: free quota is counted in requests");
  assert.equal((await saveAudioSettings({ partMinutes: 30 })).partMinutes, 30);
  for (const bad of [4, 60, 30.5, "abc"]) await assert.rejects(saveAudioSettings({ partMinutes: bad }), /5 到 59/);
});
