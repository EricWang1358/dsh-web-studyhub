import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiTiers } from "../lib/gemini.js";
import { CUT_PREFIX, findFfmpeg, groqPlan, sweepStaleCuts } from "../lib/groq.js";

/* Cutting the formats that need a decoder, checked with the real ffmpeg (these tests skip themselves without one):
   speech-like noise in bursts with a pause every ten seconds is made into each format, cut, and every piece is decoded again. */

const command = await findFfmpeg();
const withFfmpeg = command ? test : test.skip;
const FREE = "FREE_KEY_0000000000000000001", GROQ = "gsk_GROQ_KEY_00000000000000003", PAID = "PAID_KEY_0000000000000000002";
const LIMIT = 360_000; // a small limit so a minute of audio needs cutting: ten seconds per piece
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (part) => { stderr += part; });
  child.on("close", (code) => (code === 0 ? resolve(stderr) : reject(new Error(stderr.slice(-600)))));
});
/** How long ffmpeg can decode `file` for, in seconds. */
async function decodedSeconds(file) {
  const log = await run(["-v", "info", "-stats", "-i", file, "-f", "null", "-"]);
  const times = [...log.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].at(-1);
  return Number(times[1]) * 3600 + Number(times[2]) * 60 + Number(times[3]);
}
// Only this process's folders: other test runs (parallel worktrees) share the OS temp directory.
const groqDirs = async () => (await readdir(tmpdir())).filter((name) => name.startsWith(CUT_PREFIX));

/** 60 s of noise bursts, 9.4 s of sound and a 0.6 s pause every ten seconds, as WAV, then in the format asked for. */
async function recording(t, formats) {
  const dir = await mkdtemp(join(tmpdir(), "groq-split-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const source = join(dir, "source.wav");
  await run(["-y", "-v", "error", "-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,10),9.4),0.3*(random(0)*2-1),0)':s=16000:d=60", "-c:a", "pcm_s16le", source]);
  const made = {};
  for (const [name, args] of Object.entries(formats)) { made[name] = join(dir, `speech.${name}`); await run(["-y", "-v", "error", "-i", source, ...args, made[name]]); }
  return { dir, made };
}
const FORMATS = {
  m4a: ["-c:a", "aac", "-b:a", "64k"],
  ogg: ["-c:a", "libvorbis", "-q:a", "10"], // Vorbis at 64 kbps would come out smaller than the test limit
  opus: ["-c:a", "libopus", "-b:a", "64k", "-f", "ogg"],
  webm: ["-c:a", "libopus", "-b:a", "64k"],
  flac: ["-c:a", "flac"],
  aac: ["-c:a", "aac", "-b:a", "64k", "-f", "adts"],
  aiff: ["-c:a", "pcm_s16be"],
};

withFfmpeg("M4A, OGG, Opus, WebM, FLAC, AAC and AIFF are cut at pauses into pieces that decode and add up to the recording", async (t) => {
  const before = await groqDirs();
  const { dir, made } = await recording(t, FORMATS);
  for (const name of Object.keys(FORMATS)) {
    const bytes = await readFile(made[name]);
    const plan = await groqPlan({ bytes, kind: `.${name}`, limit: LIMIT, ffmpeg: command });
    assert.equal(plan.error, undefined, `${name}: ${plan.error}`);
    assert.equal(plan.count, 6, `${name}: sixty seconds in pieces of at most ten`);
    let total = 0;
    const cuts = [];
    for (let index = 0; index < plan.count; index++) {
      const piece = await plan.load(index);
      assert.ok(piece.bytes.length <= LIMIT && piece.ext === "flac", `${name} piece ${index}: ${piece.bytes.length} bytes`);
      assert.equal(piece.bytes.subarray(0, 4).toString("latin1"), "fLaC", `${name}: a real FLAC file`);
      const file = join(dir, `${name}-${index}.flac`);
      await writeFile(file, piece.bytes);
      const heard = await decodedSeconds(file);
      assert.ok(Math.abs(heard - piece.seconds) < 0.25, `${name} piece ${index} decodes to ${heard} s, planned ${piece.seconds}`);
      total += heard;
      cuts.push(total);
    }
    assert.ok(Math.abs(total - 60) < 0.6, `${name}: the pieces add up to ${total} s`);
    for (let k = 1; k <= 5; k++) assert.ok(cuts[k - 1] > k * 10 - 0.75 && cuts[k - 1] < k * 10 + 0.1, `${name}: cut ${k} at ${cuts[k - 1]} s should fall in the pause before ${k * 10} s`);
    await plan.cleanup();
  }
  assert.deepEqual(await groqDirs(), before, "ffmpeg's temporary files are removed");
});

withFfmpeg("stopping while ffmpeg works ends it and leaves nothing behind", async (t) => {
  const before = await groqDirs();
  const { made } = await recording(t, { m4a: FORMATS.m4a });
  const bytes = await readFile(made.m4a), controller = new AbortController();
  const planning = groqPlan({ bytes, kind: ".m4a", limit: LIMIT, ffmpeg: command, signal: controller.signal });
  controller.abort(new Error("stopped by the learner"));
  await assert.rejects(planning, /stopped by the learner/);
  assert.deepEqual(await groqDirs(), before);
});

withFfmpeg("a big M4A that the free Gemini key cannot take is sent to Groq as FLAC pieces, in order, and the text is joined", async (t) => {
  const before = await groqDirs();
  const { made } = await recording(t, { m4a: FORMATS.m4a });
  const bytes = await readFile(made.m4a);
  const sent = [];
  const fetch = async (url, init = {}) => {
    url = String(url);
    if (url.includes("api.groq.com")) {
      const form = init.body.toString("latin1");
      assert.ok(form.includes('filename="audio.flac"') && form.includes("content-type: audio/flac"));
      sent.push(init.body.length);
      return json({ text: `part ${sent.length}` });
    }
    return init.headers["x-goog-api-key"] === FREE ? json({ error: { code: 429, message: "quota", details: [{ violations: [{ quotaId: "RequestsPerDay-FreeTier" }] }] } }, 429) : assert.fail("paid");
  };
  const tiers = new GeminiTiers({ keys: { free: FREE, groq: GROQ, paid: PAID }, groq: { fileLimit: LIMIT }, ffmpeg: command, fetch, sleep: async () => {} });
  const result = await tiers.transcribe({ bytes, mimeType: "audio/m4a", kind: ".m4a", seconds: 60, config: {} });
  assert.deepEqual(result, { text: "part 1 part 2 part 3 part 4 part 5 part 6", tier: "groq" });
  assert.equal(sent.length, 6);
  assert.ok(sent.every((size) => size < LIMIT + 2000));
  assert.equal(tiers.usage.groq.requests, 6);
  assert.deepEqual(await groqDirs(), before, "cleaned up after the chunk");
});

test("without ffmpeg a big M4A goes on to the next tier, and the warning says what is missing", async () => {
  const seen = [];
  const fetch = async (url, init = {}) => {
    url = String(url);
    seen.push(url.includes("api.groq.com") ? "groq" : init.headers["x-goog-api-key"] === FREE ? "free" : "paid");
    if (url.includes("api.groq.com")) return assert.fail("Groq cannot be asked without cutting the file");
    if (init.headers["x-goog-api-key"] === FREE) return json({ error: { code: 429, message: "quota", details: [{ violations: [{ quotaId: "RequestsPerDay-FreeTier" }] }] } }, 429);
    return json({ candidates: [{ content: { parts: [{ text: "transcribed by the paid key" }] } }], usageMetadata: {} });
  };
  const tiers = new GeminiTiers({ keys: { free: FREE, groq: GROQ, paid: PAID }, groq: { fileLimit: 1000 }, ffmpeg: null, fetch, sleep: async () => {} });
  const result = await tiers.transcribe({ bytes: Buffer.alloc(5000), mimeType: "audio/m4a", kind: ".m4a", seconds: 60, config: {} });
  assert.deepEqual([result.text, result.tier], ["transcribed by the paid key", "paid"]);
  assert.ok(tiers.warnings.some((text) => /M4A 超过 Groq 的 25 MB 限制，要切开需要 ffmpeg/.test(text) && /改用付费密钥/.test(text)), tiers.warnings.join(" | "));
  assert.ok(!seen.includes("groq"));
});

test("cut folders left by a process that died are swept once a day old, and fresh ones are left alone", async (t) => {
  const stale = await mkdtemp(join(tmpdir(), CUT_PREFIX)), fresh = await mkdtemp(join(tmpdir(), CUT_PREFIX));
  t.after(() => Promise.all([stale, fresh].map((folder) => rm(folder, { recursive: true, force: true }))));
  await writeFile(join(stale, "in.m4a"), "copy of somebody's recording");
  const twoDaysAgo = new Date(Date.now() - 48 * 3600_000);
  await utimes(stale, twoDaysAgo, twoDaysAgo);
  await sweepStaleCuts();
  const left = await groqDirs();
  assert.ok(!left.some((name) => stale.endsWith(name)), "the old folder is gone");
  assert.ok(left.some((name) => fresh.endsWith(name)), "a folder another job may be using is not touched");
});
