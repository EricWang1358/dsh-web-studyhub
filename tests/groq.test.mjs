import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiTiers } from "../lib/gemini.js";
import { GROQ_FILE_LIMIT, groqPlan, quietCuts, retryAfterMs, toSpeechWav, whisperPrompt } from "../lib/groq.js";
import { wavInfo } from "../lib/audio-file.js";
import { StudyService } from "../lib/service.js";

const FREE = "FREE_KEY_0000000000000000001", PAID = "PAID_KEY_0000000000000000002", GROQ = "gsk_GROQ_KEY_00000000000000003";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const geminiReply = (text) => json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } });
const groqReply = (text) => json({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 5, completion_tokens: 4 } });
const dayQuota = () => json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }, 429);
const groqLimit = (message = "Rate limit reached for model in organization on requests per day (RPD): Limit 1000. Please try again in 14m2s.", retry = "842") =>
  json({ error: { message, type: "requests", code: "rate_limit_exceeded" } }, 429, { "retry-after": retry });
const groqFailure = (status, message) => json({ error: { message, type: "invalid_request_error" } }, status);

/** Stand-ins for Google and Groq: routes[who] answers each request to that provider (free key, Groq, paid key). */
function network(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    url = String(url);
    const who = url.includes("api.groq.com") ? "groq" : init.headers?.["x-goog-api-key"] === FREE ? "free" : "paid";
    const call = { who, url, init };
    calls.push(call);
    return routes[who](call, calls.filter((other) => other.who === who).length);
  };
  return { fetch, calls, of: (who) => calls.filter((call) => call.who === who) };
}
const wav = ({ seconds, rate = 16000, channels = 1, sample = () => 0 }) => {
  const frames = Math.round(seconds * rate), data = Buffer.alloc(frames * channels * 2), header = Buffer.alloc(44);
  for (let frame = 0; frame < frames && sample(0, 0) !== 0; frame++) for (let channel = 0; channel < channels; channel++) data.writeInt16LE(sample(frame, channel), (frame * channels + channel) * 2);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28); header.writeUInt16LE(channels * 2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};
const idle = async () => {};

test("a request goes to the Gemini free key first, then Groq, then the paid key, and remembers who is used up", async () => {
  let groqDown = false;
  const net = network({ free: () => dayQuota(), groq: () => (groqDown ? groqLimit() : groqReply('{"from":"groq"}')), paid: () => geminiReply('{"from":"paid"}') });
  const tiers = new GeminiTiers({ keys: { free: FREE, groq: GROQ, paid: PAID }, fetch: net.fetch, sleep: idle });
  assert.equal(await tiers.complete("gemini-x", "system text", "user text"), '{"from":"groq"}');
  assert.deepEqual(net.calls.map((call) => call.who), ["free", "groq"]);
  assert.deepEqual([tiers.usage.free.requests, tiers.usage.groq.requests, tiers.usage.paid.requests], [0, 1, 0]);
  assert.deepEqual([tiers.usage.groq.inputTokens, tiers.usage.groq.outputTokens], [5, 4], "Groq's own usage fields are counted");

  const sent = JSON.parse(net.of("groq")[0].init.body), headers = net.of("groq")[0].init.headers;
  assert.equal(net.of("groq")[0].url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(headers.authorization, `Bearer ${GROQ}`);
  assert.deepEqual([sent.model, sent.messages, sent.response_format, sent.reasoning_effort],
    ["openai/gpt-oss-120b", [{ role: "system", content: "system text" }, { role: "user", content: "user text" }], { type: "json_object" }, "low"]);

  await tiers.complete("gemini-x", "s", "p");
  assert.deepEqual(net.calls.map((call) => call.who), ["free", "groq", "groq"], "the free key is used up for the day: the next request starts at Groq");

  groqDown = true;
  net.calls.length = 0;
  assert.equal(await tiers.complete("gemini-x", "s", "p"), '{"from":"paid"}');
  assert.deepEqual(net.calls.map((call) => call.who), ["groq", "paid"]);
  assert.ok(tiers.warnings.some((text) => /改用 Groq/.test(text)) && tiers.warnings.some((text) => /Groq 额度被限流.*付费密钥/.test(text)), tiers.warnings.join(" | "));
  net.calls.length = 0;
  await tiers.complete("gemini-x", "s", "p");
  assert.deepEqual(net.calls.map((call) => call.who), ["paid"], "both free tiers are skipped once they are used up");
  assert.equal(tiers.usage.paid.requests, 2);
});

test("Groq's optional parameters are dropped one at a time when it rejects them", async () => {
  const net = network({ groq: (call, n) => (n < 3 ? groqFailure(400, "unsupported parameter") : groqReply("{}")) });
  const tiers = new GeminiTiers({ keys: { groq: GROQ }, fetch: net.fetch, sleep: idle });
  await tiers.complete("m", "s", "p");
  const forms = net.of("groq").map((call) => JSON.parse(call.init.body));
  assert.deepEqual(forms.map((body) => [body.reasoning_effort ?? null, body.response_format?.type ?? null]), [["low", "json_object"], [null, "json_object"], [null, null]]);
});

test("when every tier fails the request fails, after each got its retries", async () => {
  const net = network({ free: () => dayQuota(), groq: () => groqFailure(503, "over capacity"), paid: () => json({ error: { message: "down" } }, 503) });
  const tiers = new GeminiTiers({ keys: { free: FREE, groq: GROQ, paid: PAID }, fetch: net.fetch, sleep: idle });
  await assert.rejects(tiers.complete("m", "s", "p"), /暂时不可用/);
  assert.deepEqual([net.of("free").length, net.of("groq").length, net.of("paid").length], [1, 3, 3], "Groq and the paid key each tried three times, the free key was known to be used up");
  assert.ok(tiers.warnings.some((text) => /改用付费密钥/.test(text)));
});

test("a rejected Groq key is set aside for good; a request Groq cannot do only skips it this once", async () => {
  const net = network({ groq: (call, n) => (n === 1 ? groqFailure(401, "Invalid API Key") : groqFailure(413, "Request too large")), paid: () => geminiReply("{}") });
  const tiers = new GeminiTiers({ keys: { groq: GROQ, paid: PAID }, fetch: net.fetch, sleep: idle });
  await tiers.complete("m", "s", "p");
  assert.deepEqual(net.calls.map((call) => call.who), ["groq", "paid"]);
  assert.ok(tiers.warnings.some((text) => /Groq 密钥被拒绝（401）.*付费密钥/.test(text)), tiers.warnings.join(" | "));
  await tiers.complete("m", "s", "p");
  assert.deepEqual(net.calls.map((call) => call.who), ["groq", "paid", "paid"], "a dead key is not offered again");

  const busy = network({ groq: () => groqFailure(413, "Request too large for model: tokens per minute (TPM) limit"), paid: () => geminiReply("{}") });
  const other = new GeminiTiers({ keys: { groq: GROQ, paid: PAID }, fetch: busy.fetch, sleep: idle });
  await other.complete("m", "s", "p");
  await other.complete("m", "s", "p");
  assert.deepEqual(busy.calls.map((call) => call.who), ["groq", "paid", "groq", "paid"], "an over-size request does not condemn the key");
  assert.ok(other.warnings.some((text) => /Groq 没能完成这一步.*改用付费密钥/.test(text)));
});

test("choosing paid only keeps the recording away from both free providers", async () => {
  const net = network({ paid: () => geminiReply("{}"), free: () => assert.fail("free"), groq: () => assert.fail("groq") });
  const tiers = new GeminiTiers({ keys: { free: FREE, groq: GROQ, paid: PAID }, fetch: net.fetch, skipFree: true, sleep: idle });
  await tiers.complete("m", "s", "p");
  assert.deepEqual(net.calls.map((call) => call.who), ["paid"]);
});

test("Groq alone is enough, and when it fails there is nothing behind it", async () => {
  const good = new GeminiTiers({ keys: { groq: GROQ }, fetch: network({ groq: () => groqReply('{"a":1}') }).fetch, sleep: idle });
  assert.equal(await good.complete("m", "s", "p"), '{"a":1}');
  assert.equal(good.configured, true);
  const bad = new GeminiTiers({ keys: { groq: GROQ }, fetch: network({ groq: () => groqFailure(404, "model_not_found") }).fetch, sleep: idle });
  await assert.rejects(bad.complete("m", "s", "p"), /模型不存在或此密钥不可用：model_not_found/);
});

test("a chunk of audio goes to Groq as a Whisper upload with the language and the vocabulary as hints", async () => {
  const net = network({ free: () => dayQuota(), groq: () => json({ text: " hello there " }) });
  const tiers = new GeminiTiers({ keys: { free: FREE, groq: GROQ }, fetch: net.fetch, sleep: idle });
  const bytes = wav({ seconds: 5 });
  const result = await tiers.transcribe({ bytes, mimeType: "audio/wav", kind: ".wav", seconds: 5, config: { languageCodes: ["en-US"], mode: "SMART", vocabulary: ["partition", "ACID"] } });
  assert.deepEqual(result, { text: "hello there", tier: "groq" });
  const call = net.of("groq")[0], form = call.init.body.toString("latin1");
  assert.equal(call.url, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(call.init.headers.authorization, `Bearer ${GROQ}`);
  assert.match(call.init.headers["content-type"], /^multipart\/form-data; boundary=/);
  for (const [name, value] of [["model", "whisper-large-v3"], ["language", "en"], ["prompt", "partition, ACID"], ["response_format", "json"], ["temperature", "0"]])
    assert.ok(form.includes(`name="${name}"\r\n\r\n${value}\r\n`), `${name} = ${value}`);
  assert.ok(form.includes('filename="audio.wav"') && form.includes("content-type: audio/wav"));
  assert.ok(call.init.body.includes(bytes), "the audio itself is in the upload");
  assert.deepEqual([tiers.usage.groq.requests, tiers.usage.groq.audioSeconds, tiers.usage.free.requests], [1, 5, 0]);
  assert.ok(tiers.warnings.some((text) => /Groq 的 Whisper/.test(text)));
});

test("audio over Groq's file limit goes in pieces; a rate-limit wait in the middle resumes at the next piece", async () => {
  const sleeps = [];
  const texts = ["first part", "second part"];
  let answered = 0;
  const net = network({
    free: () => dayQuota(),
    groq: (call, n) => {
      if (n === 2 && !answered++) return groqLimit("Rate limit reached on requests per minute (RPM): Limit 20. Please try again in 2s.", "2");
      return json({ text: texts[n === 1 ? 0 : 1] });
    },
  });
  const tiers = new GeminiTiers({ keys: { free: FREE, groq: GROQ }, fetch: net.fetch, sleep: async (ms) => { sleeps.push(ms); } });
  const bytes = wav({ seconds: 800 }); // 25.6 MB of 16 kHz speech
  assert.ok(bytes.length > GROQ_FILE_LIMIT);
  const result = await tiers.transcribe({ bytes, mimeType: "audio/wav", kind: ".wav", seconds: 800, config: {} });
  assert.deepEqual(result, { text: "first part second part", tier: "groq" });
  assert.equal(net.of("groq").length, 3, "piece one, piece two (limited), piece two again: piece one was not sent twice");
  assert.deepEqual(sleeps, [2000], "it waited the two seconds Groq asked for");
  for (const call of net.of("groq")) assert.ok(call.init.body.length < 25_000_000);
  assert.equal(tiers.usage.groq.requests, 2);
});

test("how audio is prepared for Groq: speech-rate WAV, pieces under the limit, and what needs ffmpeg", async () => {
  const stereo = wav({ seconds: 2, rate: 44100, channels: 2, sample: (frame, channel) => (channel ? 3000 : 1000) });
  const speech = toSpeechWav(stereo, wavInfo(stereo)), info = wavInfo(speech);
  assert.deepEqual([info.sampleRate, info.channels, info.bits], [16000, 1, 16]);
  assert.ok(Math.abs(info.seconds - 2) < 0.01, "same length");
  assert.equal(speech.readInt16LE(info.dataStart + 2000), 2000, "the channels are averaged");
  assert.equal(toSpeechWav(wav({ seconds: 1 }), wavInfo(wav({ seconds: 1 }))), null, "16 kHz mono is left alone");
  const piecesOf = (plan) => Promise.all(Array.from({ length: plan.count }, (_, index) => plan.load(index)));

  const wavPlan = await groqPlan({ bytes: wav({ seconds: 1500 }), kind: ".wav" }); // 48 MB at 16 kHz
  const wavParts = await piecesOf(wavPlan);
  assert.ok(wavParts.length >= 3 && wavParts.every((piece) => piece.bytes.length <= GROQ_FILE_LIMIT && piece.ext === "wav"));
  assert.ok(Math.abs(wavParts.reduce((sum, piece) => sum + piece.seconds, 0) - 1500) < 1, "nothing is lost between the pieces");

  const frame = Buffer.alloc(417); frame.set([0xff, 0xfb, 0x90, 0x00]);
  const mp3 = Buffer.concat(Array.from({ length: 62_000 }, () => frame)); // about 26 MB, 27 minutes
  const mp3Parts = await piecesOf(await groqPlan({ bytes: mp3, kind: ".mp3", seconds: 1619 }));
  assert.ok(mp3Parts.length >= 2 && mp3Parts.every((piece) => piece.bytes.length <= GROQ_FILE_LIMIT && piece.ext === "mp3"));
  assert.equal(mp3Parts.reduce((sum, piece) => sum + piece.bytes.length, 0), mp3.length, "cut on frame boundaries, nothing dropped");

  const small = await groqPlan({ bytes: Buffer.alloc(100), kind: ".flac", seconds: 3, ffmpeg: null });
  assert.deepEqual((await piecesOf(small)).map((piece) => [piece.ext, piece.seconds]), [["flac", 3]], "a file that fits needs no ffmpeg, whatever its format");

  // What needs a decoder, when there is none: the reason is given, and the request moves on to the next tier.
  assert.match((await groqPlan({ bytes: Buffer.alloc(10), kind: ".aac", ffmpeg: null })).error, /AAC 不是 Groq 能直接读的格式，要转换需要 ffmpeg/);
  assert.match((await groqPlan({ bytes: Buffer.alloc(GROQ_FILE_LIMIT + 1), kind: ".m4a", ffmpeg: null })).error, /M4A 超过 Groq 的 25 MB 限制，要切开需要 ffmpeg/);
});

test("cuts are moved to the quietest moment near where they would fall", () => {
  const energy = new Array(600).fill(1000); // 60 s in 100 ms steps, all loud
  for (const at of [95, 96, 97, 194, 195, 196, 296, 297, 298, 398, 399, 400, 497, 498, 499]) energy[at] = 0; // pauses before 10, 20, 30, 40, 50 s
  const cuts = quietCuts(energy, 60, 6, 2.5);
  assert.equal(cuts.length, 7);
  assert.deepEqual([cuts[0], cuts.at(-1)], [0, 60]);
  for (const [k, cut] of [1, 2, 3, 4, 5].map((k) => [k, cuts[k]])) assert.ok(cut > k * 10 - 0.7 && cut <= k * 10, `cut ${k} at ${cut} s falls inside the pause before ${k * 10} s`);
  assert.deepEqual(quietCuts(energy, 60, 1, 2.5), [0, 60], "a single piece has no cuts");
});

test("Groq's wait hints are read from the header or the message", () => {
  const reply = (seconds) => ({ headers: { get: (name) => (name === "retry-after" ? seconds : null) } });
  assert.equal(retryAfterMs(reply("842"), {}), 842_000);
  assert.equal(retryAfterMs(null, { error: { message: "Please try again in 14m2.5s." } }), 842_500);
  assert.equal(retryAfterMs(null, { error: { message: "try again in 7.66s" } }), 7660);
  assert.equal(retryAfterMs(null, { error: { message: "try again in 1h2m3s" } }), 3_723_000);
  assert.equal(retryAfterMs(null, { error: { message: "try again in 120ms" } }), 120);
  assert.equal(retryAfterMs(null, { error: { message: "no hint here" } }), null);
  assert.equal(whisperPrompt(["a", "b"]), "a, b");
  const long = whisperPrompt(Array.from({ length: 80 }, (_, i) => `term${i}`));
  assert.ok(long.length <= 300 && !long.endsWith(",") && /term\d+$/.test(long), "cut at a term boundary");
});

/** A service on a temporary library whose network is `net`. */
async function serviceOn(t, net, settings) {
  const dir = await mkdtemp(join(tmpdir(), "groq-")), names = ["DSH_HOME", "GEMINI_FREE_API_KEY", "GEMINI_PAID_API_KEY", "GROQ_API_KEY"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name]; // keys from this machine must not leak into the test
  process.env.DSH_HOME = join(dir, "home");
  t.after(async () => {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    await rm(dir, { recursive: true, force: true });
  });
  const root = join(dir, "library"), service = new StudyService(root, { fetch: net.fetch });
  await service.call("audio.settings.set", { textProvider: "gemini", ...settings });
  const file = join(dir, "lecture.wav");
  await writeFile(file, wav({ seconds: 5 }));
  return { service, root, file };
}
/** What a model would answer for each text step, given the request's system prompt. */
function textSteps(system, prompt) {
  if (system.startsWith("You proofread")) return '{"corrections":[]}';
  if (system.startsWith("You translate")) {
    const payload = JSON.parse(prompt);
    return JSON.stringify({ titleZh: "地图案例", titleEn: "Map Cases", paragraphs: payload.paragraphs.map((p) => ({ n: p.n, en: "Translated.", zh: "译文。" })) });
  }
  return '{"titleEn":"Google Maps Case Study"}';
}
const groqAnswers = (call) => (call.url.endsWith("/audio/transcriptions") ? json({ text: "今天我们讲谷歌地图的应用案例。第一个案例是路线规划。" })
  : groqReply(textSteps(...JSON.parse(call.init.body).messages.map((message) => message.content))));

test("an import with the free Gemini quota gone is finished by Groq, and the cost says so", async (t) => {
  const net = network({ free: () => dayQuota(), groq: groqAnswers, paid: () => assert.fail("the paid key is the last resort") });
  const { service, root, file } = await serviceOn(t, net, { freeKey: FREE, groqKey: GROQ, paidKey: PAID });
  const job = await service.call("job.wait", { jobId: (await service.call("audio.import", { path: file })).jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "complete", job.stage);
  assert.equal(net.of("free").length, 1, "one try on the free key, which was used up");
  assert.deepEqual([job.usage.free.requests, job.usage.groq.requests, job.usage.paid.requests], [0, 4, 0], "transcription, proofreading, translation and title all on Groq");
  assert.ok(job.warnings.some((text) => /Groq 的 Whisper/.test(text)) && job.warnings.some((text) => /改用 Groq/.test(text)));
  const [folder] = await readdir(join(root, "audio-cache"));
  const raw = (await readdir(join(root, "audio-cache", folder))).find((name) => name.startsWith("raw-"));
  assert.equal(JSON.parse(await readFile(join(root, "audio-cache", folder, raw), "utf8")).tier, "groq", "the saved transcript remembers who made it");
  assert.equal((await service.call("snapshot", {})).sources.length, 1);
});

test("Groq alone is enough to import a recording", async (t) => {
  const net = network({ groq: groqAnswers });
  const { service, file } = await serviceOn(t, net, { groqKey: GROQ });
  const job = await service.call("job.wait", { jobId: (await service.call("audio.import", { path: file })).jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "complete", job.stage);
  assert.deepEqual([job.usage.groq.requests, net.of("free").length, net.of("paid").length], [4, 0, 0]);
});

test("paid only really means paid only, even with Groq configured", async (t) => {
  const paidAnswers = (call) => (call.url.includes(":generateContent") && JSON.parse(call.init.body).systemInstruction
    ? geminiReply(textSteps(JSON.parse(call.init.body).systemInstruction.parts[0].text, JSON.parse(call.init.body).contents[0].parts[0].text))
    : geminiReply("今天我们讲谷歌地图的应用案例。第一个案例是路线规划。"));
  const net = network({ free: () => assert.fail("free"), groq: () => assert.fail("groq"), paid: paidAnswers });
  const { service, file } = await serviceOn(t, net, { freeKey: FREE, groqKey: GROQ, paidKey: PAID });
  const job = await service.call("job.wait", { jobId: (await service.call("audio.import", { path: file, paidOnly: true })).jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "complete", job.stage);
  assert.ok(net.calls.length >= 4 && net.calls.every((call) => call.who === "paid"));
});

test("the Groq key is stored like the others: masked, cleared on request, checked by the key test", async (t) => {
  const net = network({ free: () => json({ models: [] }), groq: () => json({ data: [] }), paid: () => json({ error: { message: "denied" } }, 403) });
  const { service } = await serviceOn(t, net, { freeKey: FREE, groqKey: GROQ, paidKey: PAID });
  const view = await service.call("audio.settings.get", {});
  assert.deepEqual(view.groqKey, { set: true, hint: `••••${GROQ.slice(-4)}` });
  assert.ok(!JSON.stringify(view).includes(GROQ), "the key itself never reaches the panel");
  assert.deepEqual([view.groqTranscribeModel, view.groqTextModel], ["whisper-large-v3", "openai/gpt-oss-120b"]);
  assert.equal((await service.call("audio.settings.set", { groqTextModel: "openai/gpt-oss-20b" })).groqTextModel, "openai/gpt-oss-20b", "a model id may contain a slash");
  await assert.rejects(service.call("audio.settings.set", { groqTextModel: "not a model!" }), /Groq 模型名称/);
  await assert.rejects(service.call("audio.settings.set", { groqKey: "short" }), /格式不对/);
  const report = await service.call("audio.test", {});
  assert.deepEqual([report.free.ok, report.groq.ok, report.paid.ok], [true, true, false]);
  assert.equal(net.of("groq")[0].url, "https://api.groq.com/openai/v1/models");
  assert.equal((await service.call("audio.settings.set", { groqKey: "" })).groqKey.set, false);
  assert.equal((await service.call("audio.test", {})).groq.configured, false);
});
