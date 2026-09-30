import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StudyService } from "../lib/service.js";
import { paceTracker, taskTracker } from "../lib/audio-job.js";
import { checkpoints, digest, finishTranscript, plainModel } from "../lib/audio-import.js";
import { notify } from "../lib/inbox.js";

const KEY = "AIzaRetryTestKey_000000000000001";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const reply = (text) => json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} });
const pcmWav = (seconds, rate = 8000) => {
  const data = Buffer.alloc(seconds * rate * 2, 1), header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};
/** The text steps as a model would answer them, counting each kind of call. */
function textAnswers(counts, { failTranslate = () => false } = {}) {
  return (system, prompt) => {
    const kind = system.startsWith("You proofread") ? "proofread" : system.startsWith("You translate") ? "translate" : "title";
    counts[kind] = (counts[kind] || 0) + 1;
    if (kind === "proofread") return '{"corrections":[]}';
    if (kind === "title") return '{"titleEn":"Google Maps Case Study"}';
    if (failTranslate()) return "this is not json at all";
    const cut = prompt.indexOf("\n\nYour previous"), payload = JSON.parse(cut < 0 ? prompt : prompt.slice(0, cut));
    return JSON.stringify({ titleZh: "地图案例", titleEn: "Map Cases", paragraphs: payload.paragraphs.map((p) => ({ n: p.n, en: "Translated.", zh: "译文。" })) });
  };
}
async function fixture(t, { complete, textProvider = "gemini", counts = {}, failTranslate } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "audio-retry-")), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, "home");
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  const answer = textAnswers(counts, { failTranslate });
  const fetch = async (url, init = {}) => {
    url = String(url);
    if (init.method === "DELETE") return json({});
    const body = JSON.parse(init.body);
    if (url.includes("transcribe:")) { counts.transcribe = (counts.transcribe || 0) + 1; return reply("今天我们讲谷歌地图的应用案例。第一个案例是路线规划。"); }
    return reply(answer(body.systemInstruction.parts[0].text, body.contents[0].parts[0].text));
  };
  const root = join(dir, "library"), service = new StudyService(root, { fetch, complete });
  await service.call("audio.settings.set", { paidKey: KEY, textProvider });
  const file = join(dir, "谷歌地图.mp3");
  await writeFile(file, pcmWav(5));
  return { dir, root, service, file, counts };
}
const uploadFolders = (root) => readdir(join(root, "audio-uploads")).catch(() => []);
test('a fresh process lists a failed single recording and retries from its saved transcription', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'audio-single-restart-')), root = join(dir, 'library');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const child = mode => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/audio-single-process.mjs', import.meta.url)), root, mode],
      { env: { ...process.env, DSH_HOME: join(dir, 'home') }, windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', data => { out += data; }); proc.stderr.on('data', data => { err += data; });
    proc.on('error', reject); proc.on('close', code => code ? reject(new Error(err || out)) : resolve(JSON.parse(out.trim())));
  });
  const first = await child('fail');
  assert.equal(first.failed.status, 'failed');
  assert.equal(first.transcriptions, 1);
  const second = await child('resume');
  assert.equal(second.before.id, first.failed.id);
  assert.equal(second.before.retryable, true);
  assert.equal(second.beforeCalls, 0);
  assert.equal(second.done.status, 'complete', second.done.stage);
  assert.equal(second.transcriptions, 0, 'the saved transcription survives a fresh process');
});
test('an old failed inbox letter becomes a selectable recovery card without guessing its original path', async t => {
  const { service, file } = await fixture(t);
  await service.store.update(s => { notify(s, { kind: 'audio-failed', jobId: 'old-single-job', filename: '谷歌地图.mp3', detail: '校对第 2/9 段失败' }); });
  const old = (await service.call('snapshot')).jobs.find(job => job.id === 'old-single-job');
  assert.equal(old.legacy, true);
  assert.equal(old.retryable, false);
  assert.match(old.stage, /重新选择同一录音/);
  await assert.rejects(service.call('audio.retry', { jobId: old.id }), /不能重试/);
  await assert.rejects(service.call('audio.import', { path: file, recoveryJobId: 'wrong-job' }), /不可恢复/);
  const started = await service.call('audio.import', { path: file, recoveryJobId: old.id });
  assert.equal((await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 20 })).status, 'complete');
  const snapshot = await service.call('snapshot');
  assert.ok(!snapshot.jobs.some(job => job.id === old.id));
  assert.ok(!snapshot.inbox.items.some(item => item.jobId === old.id && item.kind === 'audio-failed'));
});
test('a failed single import refuses to attach saved progress to a changed local recording', async t => {
  const { service, file } = await fixture(t, { failTranslate: () => true });
  const failed = await service.call('job.wait', { jobId: (await service.call('audio.import', { path: file })).jobId, timeoutSeconds: 30 });
  assert.equal(failed.status, 'failed');
  await writeFile(file, pcmWav(6));
  await assert.rejects(service.call('audio.retry', { jobId: failed.id }), /原录音内容已变化/);
  assert.ok((await service.call('snapshot')).jobs.some(job => job.id === failed.id && job.retryable), 'the original card remains visible');
});
async function upload(service, name, bytes) {
  const { uploadId } = await service.call("audio.upload.start", { name, size: bytes.length });
  await service.call("audio.upload.chunk", { uploadId, offset: 0, data: bytes.toString("base64") });
  await service.call("audio.upload.finish", { uploadId });
  return uploadId;
}

test("on the host model route every text request is a DSH sub-agent task with a job id, and the panel can list it", async (t) => {
  const seen = [];
  const counts = {};
  const answer = textAnswers(counts);
  // What the host needs from the third argument: the job id of a generation job, and hooks to report the child it starts.
  const host = async (system, prompt, execution) => {
    seen.push(execution);
    const child = { runtime: "subagent", childId: `child-${seen.length}`, label: `Study ${execution.jobId.slice(0, 8)} · ${execution.stage}` };
    execution.onEvent({ status: "running", ...child });
    const text = answer(system, prompt);
    execution.onEvent({ status: "complete", ...child });
    return text;
  };
  const { service, file } = await fixture(t, { complete: host, textProvider: "host", counts });
  const job = await service.call("job.wait", { jobId: (await service.call("audio.import", { path: file })).jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "complete", job.stage);
  assert.equal(seen.length, 3, "proofread, translate and title");
  assert.deepEqual([job.textProvider, job.usage.paid.requests], ["host", 1], "only the transcription went to Gemini; the host model does the text");
  assert.ok(seen.every((execution) => execution.jobId === job.id && execution.stage && execution.signal && typeof execution.onEvent === "function"));
  assert.deepEqual(job.tasks.map((task) => [task.kind, task.stage, task.runtime]),
    [["transcribe", "转写 1/1", "gemini"], ["proofread", "校对 1/1", "subagent"], ["translate", "翻译 1/1", "subagent"], ["title", "生成标题", "subagent"]]);
  assert.ok(job.tasks.every((task) => task.status === "complete" && task.startedAt && task.finishedAt));
  assert.deepEqual(job.tasks.slice(1).map((task) => task.childId), ["child-1", "child-2", "child-3"], "each sub-agent can be opened from its task");
  const passthrough = plainModel(async (system, prompt, ...rest) => `${system}|${prompt}|${rest.length}`);
  assert.equal(await passthrough("s", "p", { signal: undefined, task: "audio.proofread" }), "s|p|0");
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  await assert.rejects(passthrough("s", "p", { signal: controller.signal }), /stopped/);
});

test('a missing host adapter stops on the first text call and resumes without repeating transcription', async t => {
  const counts = {};
  let missing = true, calls = 0;
  const answer = textAnswers(counts);
  const { service, file } = await fixture(t, { counts, textProvider: 'host', complete: async (system, prompt) => {
    calls++;
    if (missing) throw Object.assign(new Error('no adapter registered for provider "opencode2-deepseek"'), { code: 'NO_ADAPTER' });
    return answer(system, prompt);
  } });
  const first = await service.call('job.wait', { jobId: (await service.call('audio.import', { path: file })).jobId, timeoutSeconds: 30 });
  assert.equal(first.status, 'failed');
  assert.match(first.stage, /opencode2-deepseek/);
  assert.equal(calls, 1, 'adapter absence cannot be repaired by asking for different JSON');
  assert.equal(counts.transcribe, 1);
  assert.equal(first.steps.transcribe.done, 1);
  missing = false;
  const next = await service.call('job.wait', { jobId: (await service.call('audio.retry', { jobId: first.id })).jobId, timeoutSeconds: 30 });
  assert.equal(next.status, 'complete', next.stage);
  assert.equal(counts.transcribe, 1);
  assert.equal(next.usageRun.paid.requests, 0, 'host text completion must reuse the Gemini transcript checkpoint');
});

test("a failed import is resumed from what is saved: no second transcription, no second upload, no second notice", async (t) => {
  let failing = true;
  const { service, root, counts } = await fixture(t, { failTranslate: () => failing });
  const id = await upload(service, "谷歌地图应用案例讲解.mp3", pcmWav(5));
  const first = await service.call("job.wait", { jobId: (await service.call("audio.import", { uploadId: id })).jobId, timeoutSeconds: 30 });
  assert.equal(first.status, "failed");
  assert.match(first.stage, /翻译第 1\/1 部分失败：模型没有按要求返回 JSON（回复开头是「this is not json at all」）/, "a reply that is not JSON is described in words, not as a parser error");
  assert.equal(first.retryable, true);
  assert.deepEqual([first.steps.transcribe, first.steps.proofread, first.steps.translate], [{ done: 1, total: 1 }, { done: 1, total: 1 }, { done: 0, total: 1 }]);
  assert.deepEqual([counts.transcribe, counts.proofread, counts.translate], [1, 1, 2], "translation was tried twice: once, then again with the correction");
  assert.deepEqual(first.tasks.map((task) => `${task.stage}:${task.runtime}:${task.status}`),
    ["转写 1/1:gemini:complete", "校对 1/1:gemini:complete", "翻译 1/1:gemini:complete", "翻译 1/1:gemini:complete"], "both attempts at the translation are listed");
  assert.ok(first.pace.transcribe && first.pace.proofread && first.pace.translate, "the pace of each phase is recorded for the estimate");
  assert.deepEqual([first.usage.paid.requests, first.usage.paid.audioSeconds, first.usageRun.paid.requests], [4, 5, 4], "a stopped import still says what it has spent");
  assert.ok((await uploadFolders(root)).includes(id), "the uploaded copy is kept so nothing has to be chosen or uploaded again");

  failing = false;
  const restarted = await service.call("audio.retry", { jobId: first.id });
  assert.notEqual(restarted.jobId, first.id);
  const second = await service.call("job.wait", { jobId: restarted.jobId, timeoutSeconds: 30 });
  assert.equal(second.status, "complete", second.stage);
  assert.deepEqual([counts.transcribe, counts.proofread, counts.translate], [1, 1, 3], "only the missing translation was done");
  assert.deepEqual([second.usageRun.paid.requests, second.usage.paid.requests, second.usage.paid.audioSeconds], [2, 6, 5],
    "the retry sent two requests, but the recording has cost six: the first attempt is not forgotten");
  assert.equal((await service.call("snapshot", {})).sources[0].audio.usage.paid.requests, 6, "the saved source records the whole cost");
  assert.ok(!(await uploadFolders(root)).includes(id), "the copy goes once the import has succeeded");
  const snapshot = await service.call("snapshot", {});
  assert.ok(!snapshot.jobs.some((job) => job.id === first.id), "the failed card is replaced by the retry");
  const kinds = snapshot.inbox.items.map((item) => item.kind);
  assert.equal(kinds.filter((kind) => kind === "audio-transcribe").length, 1, "the transcript was announced once, not again on the retry");
  assert.equal(kinds.filter((kind) => kind === "audio-failed").length, 0, "the letter about the failure is withdrawn once the retry has replaced it");
  assert.equal(kinds.filter((kind) => kind === "audio-result").length, 1);
  await assert.rejects(service.call("audio.retry", { jobId: second.id }), /不能重试/);
});

test("a retry uses the settings as they are now, and dismissing a failed card removes the kept upload", async (t) => {
  let failing = true;
  const { service, root, counts } = await fixture(t, { failTranslate: () => failing });
  const id = await upload(service, "retry-later.mp3", pcmWav(5));
  const first = await service.call("job.wait", { jobId: (await service.call("audio.import", { uploadId: id })).jobId, timeoutSeconds: 30 });
  assert.equal(first.status, "failed");
  await service.call("audio.settings.set", { paidKey: "" });
  const restarted = await service.call("audio.retry", { jobId: first.id });
  const broken = await service.call("job.wait", { jobId: restarted.jobId, timeoutSeconds: 30 });
  assert.equal(broken.status, "failed");
  assert.match(broken.stage, /还没有配置 Gemini API 密钥/, "the key that was removed is not remembered from the first attempt");
  assert.equal(counts.transcribe, 1);
  assert.equal(broken.retryable, true);
  await service.call("job.dismiss", { jobId: broken.id });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(!(await uploadFolders(root)).includes(id), "dismissing the card discards the upload it was keeping");
  await assert.rejects(service.call("audio.retry", { jobId: broken.id }), /不能重试/);
  failing = false;
});

test("the same failure twice in a row stops proofreading instead of spending on every window", async () => {
  const paragraphs = Array.from({ length: 4 }, (_, i) => `${i}`.repeat(5000));
  let calls = 0;
  const complete = async () => { calls++; throw new Error("upstream said no"); };
  await assert.rejects(finishTranscript({ paragraphs, filename: "a.mp3", complete, settings: {}, saved: checkpoints(), keys: { raw: "r", text: "t" } }),
    /校对第 2\/4 段失败：连续 2 段用同样的错误失败（upstream said no）.*接着做/);
  assert.equal(calls, 4, "two windows, each asked twice, and no more");

  let toggle = 0;
  const varied = async () => { throw new Error(`failure ${toggle++}`); };
  const warnings = [];
  await assert.rejects(finishTranscript({ paragraphs: paragraphs.slice(0, 1), filename: "a.mp3", complete: async (system) => { if (system.startsWith("You proofread")) return varied(); throw new Error("stop here"); },
    settings: {}, saved: checkpoints(), keys: { raw: "r", text: "t" }, warn: (text) => warnings.push(text) }), /stop here/);
  assert.match(warnings[0], /第 1 段校对失败，这一段保留原转写/, "a single failed window is still skipped, not fatal");
});

test("saved work is matched by content: an edited window is done again, the others are reused", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "audio-content-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const counts = {};
  const complete = async (system, prompt) => textAnswers(counts)(system, prompt);
  const base = ["a".repeat(3000), "b".repeat(3000), "c".repeat(3000)];
  const run = (paragraphs) => finishTranscript({ paragraphs, filename: "a.mp3", complete, settings: {}, saved: checkpoints(dir), keys: { raw: "r", text: "t" } });
  await run(base);
  assert.deepEqual([counts.proofread, counts.translate], [2, 3]);
  Object.keys(counts).forEach((key) => delete counts[key]);
  await run([base[0], "B".repeat(3000), base[2]]);
  assert.deepEqual([counts.proofread, counts.translate], [1, 1], "the first window changed and the middle part changed; nothing else was asked again");
  Object.keys(counts).forEach((key) => delete counts[key]);
  await run([base[0], "B".repeat(3000), base[2]]);
  assert.deepEqual([counts.proofread ?? 0, counts.translate ?? 0], [0, 0], "an identical run costs nothing");
  assert.notEqual(digest(["x"]), digest(["y"]));
});

test("only items that took real time inform the estimate: ones read from the saved work say nothing about speed", (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, "now", () => clock);
  const job = {}, pace = paceTracker(job);
  pace({ phase: "proofread", done: 0 });
  clock += 20; pace({ phase: "proofread", done: 1 });
  clock += 20; pace({ phase: "proofread", done: 2 });
  assert.equal(job.pace.proofread.each, null, "two windows came from the checkpoints");
  clock += 40_000; pace({ phase: "proofread", done: 3 });
  assert.equal(job.pace.proofread.each, 40_000);
  clock += 20_000; pace({ phase: "proofread", done: 4 });
  assert.equal(job.pace.proofread.each, 30_000, "the average of the slow ones");
  assert.deepEqual([job.pace.proofread.at, job.pace.proofread.since], [clock, 1_000_000]);
  pace({ phase: "translate", done: 0 });
  assert.equal(job.pace.translate.each, null);
  assert.ok(job.pace.proofread, "another phase does not replace this one");
});

test("the task list is capped, and a request that was cancelled is marked cancelled, not failed", async () => {
  const job = {}, track = taskTracker(job);
  for (let index = 0; index < 160; index++) await track({ kind: "proofread", part: index + 1 }, async () => "x");
  assert.equal(job.tasks.length, 150);
  assert.equal(job.tasks[0].part, 11, "the oldest are dropped");
  await assert.rejects(track({ kind: "translate" }, async () => { throw Object.assign(new Error("stopped"), { name: "AbortError" }); }), /stopped/);
  assert.equal(job.tasks.at(-1).status, "cancelled");
  await assert.rejects(track({ kind: "translate" }, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(job.tasks.at(-1).status, "failed");
});

test("work saved before the tally existed still counts: a retry adds to what its transcript cost", async (t) => {
  let failing = true;
  const { service, root, file } = await fixture(t, { failTranslate: () => failing });
  const first = await service.call("job.wait", { jobId: (await service.call("audio.import", { path: file })).jobId, timeoutSeconds: 30 });
  assert.equal(first.status, "failed");
  const [folder] = await readdir(join(root, "audio-cache"));
  assert.ok(JSON.parse(await readFile(join(root, "audio-cache", folder, "usage.json"), "utf8")).paid.requests > 0, "the tally is kept next to the saved work");
  await rm(join(root, "audio-cache", folder, "usage.json"));
  failing = false;
  const second = await service.call("job.wait", { jobId: (await service.call("audio.retry", { jobId: first.id })).jobId, timeoutSeconds: 30 });
  assert.equal(second.status, "complete", second.stage);
  assert.deepEqual([second.usageRun.paid.requests, second.usage.paid.requests, second.usage.paid.audioSeconds], [2, 3, 5],
    "one saved transcript counted from its file (one request, 5 s of audio), plus this run's two requests");
});

test("by default only the transcription is a Gemini request: the text steps go to the conversation model when there is one", async (t) => {
  const counts = {}, answer = textAnswers(counts);
  const withModel = await fixture(t, { complete: async (system, prompt) => answer(system, prompt), textProvider: "auto", counts });
  const job = await withModel.service.call("job.wait", { jobId: (await withModel.service.call("audio.import", { path: withModel.file })).jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "complete", job.stage);
  assert.deepEqual([job.textProvider, counts.transcribe, job.usage.paid.requests], ["host", 1, 1], "one Gemini request, for the audio");
  assert.equal((await withModel.service.call("audio.settings.get", {})).textProvider, "auto", "the setting stays automatic; only the run resolves it");

  const gemini = {};
  const without = await fixture(t, { textProvider: "auto", counts: gemini });
  const plain = await without.service.call("job.wait", { jobId: (await without.service.call("audio.import", { path: without.file })).jobId, timeoutSeconds: 30 });
  assert.equal(plain.status, "complete", plain.stage);
  assert.deepEqual([plain.textProvider, plain.usage.paid.requests], ["gemini", 4], "with no conversation model the text steps fall back to Gemini: 1 + proofread + translate + title");
  await assert.rejects(without.service.call("audio.settings.set", { textProvider: "somewhere" }), /auto、gemini 或 host/);
});
