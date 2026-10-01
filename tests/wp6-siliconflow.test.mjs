import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiTiers, describeFailure, tiersFromSettings } from "../lib/gemini.js";
import { SILICONFLOW_FILE_LIMIT, SILICONFLOW_ORIGIN, SILICONFLOW_TRANSCRIBE_MODEL } from "../lib/siliconflow.js";
import { publicAudioSettings, readAudioSettings, saveAudioSettings } from "../lib/audio-settings.js";
import { addUsage, requestsOf } from "../lib/audio-usage.js";
import { audioUsageFetch, summarizeAudioUsage } from "../lib/audio-dashboard.js";
import { localizeAppMessage } from "../lib/application-messages.js";
import { StudyService } from "../lib/service.js";

/* SiliconFlow (硅基流动) SenseVoice: a free transcription tier reachable from mainland China. It answers only { text },
   takes at most 50 MB and one hour per file, and is used for transcription only, never for text steps. */

const FREE = "FREE_KEY_0000000000000000001", PAID = "PAID_KEY_0000000000000000002", GROQ = "gsk_GROQ_KEY_00000000000000003", SF = "sk-siliconflowkey00000000000000004";
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const geminiReply = (text) => json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } });
const dayQuota = () => json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }] } }, 429);
const idle = async () => {};
function network(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    url = String(url);
    const who = url.includes("api.siliconflow.cn") ? "siliconflow" : url.includes("api.groq.com") ? "groq" : init.headers?.["x-goog-api-key"] === FREE ? "free" : "paid";
    const call = { who, url, init };
    calls.push(call);
    if (!routes[who]) assert.fail(`${who} must not be asked`);
    return routes[who](call, calls.filter((other) => other.who === who).length);
  };
  return { fetch, calls, of: (who) => calls.filter((call) => call.who === who), order: () => calls.map((call) => call.who) };
}
const wav = (seconds, rate = 16000) => {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2), header = Buffer.alloc(44);
  // A steady tone with a pause in the middle, where a cut belongs.
  const frames = data.length / 2, pause = [Math.floor(frames * 0.48), Math.floor(frames * 0.52)];
  for (let i = 0; i < frames; i++) data.writeInt16LE(i >= pause[0] && i < pause[1] ? 0 : (i % 50) * 40 - 1000, i * 2);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

test("a chunk goes to SiliconFlow as a multipart upload (file + model) and its { text } is the transcript", async () => {
  const net = network({ siliconflow: () => json({ text: " 今天讲分区表。 " }) });
  const tiers = new GeminiTiers({ keys: { siliconflow: SF }, fetch: net.fetch, sleep: idle });
  const bytes = wav(5);
  const result = await tiers.transcribe({ bytes, mimeType: "audio/wav", kind: ".wav", seconds: 5, config: { languageCodes: ["zh-CN"], vocabulary: ["分区"] } });
  assert.deepEqual(result, { text: "今天讲分区表。", tier: "siliconflow" });
  const call = net.of("siliconflow")[0], form = call.init.body.toString("latin1");
  assert.equal(call.url, `${SILICONFLOW_ORIGIN}/v1/audio/transcriptions`);
  assert.equal(call.url, "https://api.siliconflow.cn/v1/audio/transcriptions");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.authorization, `Bearer ${SF}`);
  assert.match(call.init.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.ok(form.includes(`name="model"\r\n\r\n${SILICONFLOW_TRANSCRIBE_MODEL}\r\n`), "the model field");
  assert.equal(SILICONFLOW_TRANSCRIBE_MODEL, "FunAudioLLM/SenseVoiceSmall");
  assert.ok(form.includes('name="file"; filename="audio.wav"') && form.includes("content-type: audio/wav"), "the file field");
  assert.ok(call.init.body.includes(bytes.subarray(44, 1044)), "the audio itself is in the upload");
  assert.deepEqual([tiers.usage.siliconflow.requests, tiers.usage.siliconflow.audioSeconds], [1, 5]);
  assert.ok(tiers.warnings.some((text) => /硅基流动/.test(text)), "the card says who transcribed it");
});

test("transcription order is Gemini free → SiliconFlow → Groq → Gemini paid", async () => {
  const net = network({ free: () => dayQuota(), siliconflow: () => json({ text: "from siliconflow" }) });
  const tiers = new GeminiTiers({ keys: { free: FREE, siliconflow: SF, groq: GROQ, paid: PAID }, fetch: net.fetch, sleep: idle });
  const result = await tiers.transcribe({ bytes: wav(2), mimeType: "audio/wav", kind: ".wav", seconds: 2, config: {} });
  assert.equal(result.tier, "siliconflow");
  assert.deepEqual(net.order(), ["free", "siliconflow"], "Groq and the paid key are not asked when SiliconFlow answers");
  assert.ok(tiers.warnings.some((text) => /改用 硅基流动|改用硅基流动/.test(text)), tiers.warnings.join(" | "));
});

for (const [label, reply, expectedOrder, expectRejected] of [
  ["a rejected key (401)", () => json({ message: "Invalid token" }, 401), ["siliconflow", "groq"], true],
  ["a rate limit (429)", () => json({ message: "TPM limit reached" }, 429, { "retry-after": "3600" }), ["siliconflow", "groq"], false],
  ["server errors (503, retried twice)", () => json({ message: "busy" }, 503), ["siliconflow", "siliconflow", "siliconflow", "groq"], false],
]) {
  test(`SiliconFlow hands over to the next free tier on ${label}`, async () => {
    const net = network({ siliconflow: reply, groq: () => json({ text: "from groq" }) });
    const tiers = new GeminiTiers({ keys: { siliconflow: SF, groq: GROQ, paid: PAID }, fetch: net.fetch, sleep: idle });
    const result = await tiers.transcribe({ bytes: wav(2), mimeType: "audio/wav", kind: ".wav", seconds: 2, config: {} });
    assert.equal(result.tier, "groq");
    assert.deepEqual(net.order(), expectedOrder);
    assert.equal(tiers.rejected.has("siliconflow"), expectRejected);
    if (label.includes("429")) {
      net.calls.length = 0;
      await tiers.transcribe({ bytes: wav(2), mimeType: "audio/wav", kind: ".wav", seconds: 2, config: {} });
      assert.deepEqual(net.order(), ["groq"], "a limited SiliconFlow is set aside for a while");
    }
  });
}

test("text steps never go to SiliconFlow; with only a SiliconFlow key the text step says what is missing", async () => {
  const net = network({ paid: () => geminiReply('{"ok":true}') });
  const tiers = new GeminiTiers({ keys: { siliconflow: SF, paid: PAID }, fetch: net.fetch, sleep: idle });
  assert.equal(await tiers.complete("m", "system", "prompt"), '{"ok":true}');
  assert.deepEqual(net.order(), ["paid"]);
  const only = new GeminiTiers({ keys: { siliconflow: SF }, fetch: network({}).fetch, sleep: idle });
  await assert.rejects(only.complete("m", "s", "p"), (error) => /硅基流动只用于转写/.test(error.message) && !/付费密钥/.test(error.message));
});

test("paid only skips Gemini free, SiliconFlow and Groq", async () => {
  const net = network({ paid: () => geminiReply("paid transcript") });
  const tiers = new GeminiTiers({ keys: { free: FREE, siliconflow: SF, groq: GROQ, paid: PAID }, fetch: net.fetch, skipFree: true, sleep: idle });
  const result = await tiers.transcribe({ bytes: wav(1), mimeType: "audio/wav", kind: ".wav", seconds: 1, config: {} });
  assert.equal(result.tier, "paid");
  assert.deepEqual(net.order(), ["paid"]);
});

test("audio over SiliconFlow's file limit goes in pieces, and a wait in the middle resumes at the next piece", async () => {
  let limited = false;
  const net = network({ siliconflow: (call, n) => {
    if (n === 2 && !limited) { limited = true; return json({ message: "rate limited, retry later" }, 429, { "retry-after": "2" }); }
    return json({ text: `piece ${n === 1 ? 1 : 2}` });
  } });
  const sleeps = [];
  const tiers = new GeminiTiers({ keys: { siliconflow: SF }, siliconflow: { fileLimit: 200_000 }, fetch: net.fetch, sleep: async (ms) => { sleeps.push(ms); } });
  const bytes = wav(10); // 320 kB of 16 kHz speech
  const result = await tiers.transcribe({ bytes, mimeType: "audio/wav", kind: ".wav", seconds: 10, config: {} });
  assert.deepEqual(result, { text: "piece 1 piece 2", tier: "siliconflow" });
  assert.equal(net.of("siliconflow").length, 3, "piece one, piece two (limited), piece two again");
  assert.deepEqual(sleeps, [2000]);
  for (const call of net.of("siliconflow")) assert.ok(call.init.body.length < 200_000 + 1000);
  assert.equal(tiers.usage.siliconflow.requests, 2);
  assert.equal(SILICONFLOW_FILE_LIMIT <= 50 * 1000 * 1000, true, "stays under the documented 50 MB");
});

test("failure text names SiliconFlow in plain language, in both languages", () => {
  assert.equal(describeFailure(401, { message: "Invalid token" }, "siliconflow"), "硅基流动密钥被拒绝（401）：Invalid token");
  assert.equal(localizeAppMessage(describeFailure(401, { message: "Invalid token" }, "siliconflow")), "SiliconFlow API key rejected (401): Invalid token");
  assert.match(describeFailure(0, { error: { message: "ECONNRESET" } }, "siliconflow"), /连不上硅基流动/);
  assert.match(localizeAppMessage(describeFailure(0, { error: { message: "ECONNRESET" } }, "siliconflow")), /Unable to connect to SiliconFlow/);
  assert.match(localizeAppMessage(describeFailure(500, { message: "boom" }, "siliconflow")), /^SiliconFlow request failed \(500\): boom/);
});

/** A service on a temporary library; keys from this machine never leak in. */
async function serviceOn(t, net, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wp6-sf-")), names = ["DSH_HOME", "GEMINI_FREE_API_KEY", "GEMINI_PAID_API_KEY", "GROQ_API_KEY", "SILICONFLOW_API_KEY"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.DSH_HOME = join(dir, "home");
  t.after(async () => {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    await rm(dir, { recursive: true, force: true });
  });
  const root = join(dir, "library"), service = new StudyService(root, { fetch: net.fetch, ...options });
  const file = join(dir, "lecture.wav");
  await writeFile(file, wav(5));
  return { service, root, file, dir };
}
function textSteps(system, prompt) {
  if (system.startsWith("You proofread")) return '{"corrections":[]}';
  if (system.startsWith("You translate")) {
    const payload = JSON.parse(prompt);
    return JSON.stringify({ titleZh: "分区", titleEn: "Partitions", paragraphs: payload.paragraphs.map((p) => ({ n: p.n, en: "Translated.", zh: "译文。" })) });
  }
  return '{"titleEn":"Partition Lecture"}';
}

test("the SiliconFlow key is stored like the others: masked, verified without transcribing, cleared on request", async (t) => {
  const net = network({ siliconflow: (call) => (call.url.endsWith("/v1/user/info") ? json({ code: 20000, data: { id: "u" } }) : assert.fail("a key check must not transcribe")) });
  const { service, dir } = await serviceOn(t, net);
  const view = await service.call("audio.settings.set", { siliconflowKey: SF });
  assert.deepEqual(view.siliconflowKey, { set: true, hint: `••••${SF.slice(-4)}` });
  assert.ok(!JSON.stringify(view).includes(SF), "the key itself never reaches the panel");
  assert.equal(view.siliconflowTranscribeModel, "FunAudioLLM/SenseVoiceSmall");
  assert.equal(view.settingsFile, join(dir, "home", "study", "audio.json"), "the panel can show where keys really live");
  const report = await service.call("audio.test", { tier: "siliconflow" });
  assert.deepEqual(Object.keys(report), ["siliconflow"], "one provider checked on its own");
  assert.equal(report.siliconflow.ok, true);
  assert.equal(net.of("siliconflow")[0].url, "https://api.siliconflow.cn/v1/user/info");
  assert.equal(net.of("siliconflow")[0].init.headers.authorization, `Bearer ${SF}`);
  const all = await service.call("audio.test", {});
  assert.deepEqual(Object.keys(all), ["free", "siliconflow", "groq", "paid"]);
  assert.equal(all.free.configured, false);
  assert.equal((await service.call("audio.settings.set", { siliconflowKey: "" })).siliconflowKey.set, false);
  await assert.rejects(service.call("audio.settings.set", { siliconflowKey: "short" }), /格式不对/);
  // Saved keys of the other providers keep working unchanged.
  const saved = await saveAudioSettings({ freeKey: FREE, groqKey: GROQ });
  assert.deepEqual([saved.freeKey, saved.groqKey, saved.siliconflowKey], [FREE, GROQ, ""]);
  assert.equal(publicAudioSettings(await readAudioSettings()).freeKey.set, true);
});

test("a rejected SiliconFlow key check is reported in plain words", async (t) => {
  const net = network({ siliconflow: () => json({ message: "Invalid token" }, 401) });
  const { service } = await serviceOn(t, net);
  await service.call("audio.settings.set", { siliconflowKey: SF });
  const report = await service.call("audio.test", { tier: "siliconflow" });
  assert.equal(report.siliconflow.ok, false);
  assert.match(report.siliconflow.message, /硅基流动密钥被拒绝（401）/);
});

test("an import with only SiliconFlow transcribes there, proofreads with the DSH model, and is counted on the dashboard", async (t) => {
  const net = network({ siliconflow: () => json({ text: "今天我们讲分区表。第一种是范围分区。" }) });
  const complete = async (system, prompt) => textSteps(system, prompt);
  const { service, file } = await serviceOn(t, net, { complete });
  await service.call("audio.settings.set", { siliconflowKey: SF });
  const job = await service.call("job.wait", { jobId: (await service.call("audio.import", { path: file })).jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "complete", job.stage);
  assert.deepEqual([job.usage.siliconflow.requests, job.usage.free.requests, job.usage.paid.requests], [1, 0, 0]);
  assert.equal(job.usage.siliconflow.audioSeconds, 5);
  assert.equal(net.calls.length, 1, "text steps used the DSH model, not SiliconFlow");
  const usage = await service.call("audio.usage", {});
  const provider = usage.providers.find((item) => item.tier === "siliconflow");
  assert.ok(provider, "the dashboard has a SiliconFlow row");
  assert.equal(provider.configured, true);
  assert.equal(provider.today.requests, 1);
  assert.equal(provider.today.audioSeconds, 5);
  assert.equal(usage.trend.at(-1).siliconflow, 1);
});

test("usage tallies and the ledger count SiliconFlow on its own line", async () => {
  const total = addUsage({ siliconflow: { requests: 2, audioSeconds: 60 } }, { siliconflow: { requests: 1, audioSeconds: 30 }, free: { requests: 1 } });
  assert.deepEqual([total.siliconflow.requests, total.siliconflow.audioSeconds, total.free.requests], [3, 90, 1]);
  assert.equal(requestsOf(total), 4);
  assert.equal(total.estimatedPaidTranscribeUsd, 0, "SiliconFlow is free: no paid estimate");
  const events = [];
  const settings = { siliconflowKey: SF, siliconflowTranscribeModel: SILICONFLOW_TRANSCRIBE_MODEL };
  const ledger = audioUsageFetch(settings, async () => json({ text: "ok" }));
  // The ledger writes to DSH_HOME; here only the event shape is checked through the summary of recorded events.
  const at = Date.now();
  events.push({ type: "request", at, tier: "siliconflow", keyId: (await import("../lib/audio-dashboard.js")).keyId(SF), model: SILICONFLOW_TRANSCRIBE_MODEL, stage: "transcribe", status: 200, audioSeconds: 42 });
  const summary = summarizeAudioUsage(events, settings, at + 1);
  const row = summary.providers.find((item) => item.tier === "siliconflow");
  assert.deepEqual([row.today.requests, row.today.audioSeconds, row.configured], [1, 42, true]);
  assert.equal(typeof ledger, "function");
  assert.equal(tiersFromSettings({ siliconflowKey: SF }).keys.siliconflow, SF);
});
