import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";

const KEY = "AIzaConcurrencyKey_00000000001";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const reply = (text) => json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} });
const wav = (fill, seconds = 5, rate = 8000) => {
  const data = Buffer.alloc(seconds * rate * 2, fill), header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};
const until = async (condition, what, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail(`timed out waiting for ${what}`);
};

/** A service whose transcription requests stay open until the test lets them go, so "at once" can be observed. */
async function harness(t, { limit } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "audio-jobs-")), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, "home");
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  const held = [], calls = { transcribe: 0, vocabularies: [] };
  const fetch = async (url, init = {}) => {
    url = String(url);
    if (init.method === "DELETE") return json({});
    const body = JSON.parse(init.body);
    if (url.includes("transcribe:")) {
      calls.transcribe++;
      calls.vocabularies.push(body.generationConfig?.audioTranscriptionConfig?.customVocabulary || []);
      await new Promise((resolve) => held.push(resolve));
      return reply("今天我们讲谷歌地图的应用案例。第一个案例是路线规划。");
    }
    const system = body.systemInstruction.parts[0].text, prompt = body.contents[0].parts[0].text;
    if (system.startsWith("You proofread")) return reply('{"corrections":[]}');
    if (system.startsWith("You translate")) {
      const payload = JSON.parse(prompt);
      return reply(JSON.stringify({ titleZh: "地图案例", titleEn: "Map Cases", paragraphs: payload.paragraphs.map((p) => ({ n: p.n, en: "Translated.", zh: "译文。" })) }));
    }
    return reply('{"titleEn":"Google Maps Case Study"}');
  };
  const service = new StudyService(join(dir, "library"), { fetch });
  await service.call("audio.settings.set", { paidKey: KEY, textProvider: "gemini", ...(limit ? { audioConcurrency: limit } : {}) });
  const files = {};
  const add = async (name, fill) => { files[name] = join(dir, name); await writeFile(files[name], wav(fill)); return files[name]; };
  const start = (name) => service.call("audio.import", { path: files[name] });
  const jobsNow = async () => Object.fromEntries((await service.call("snapshot", {})).jobs.filter((job) => job.type === "audio-import").map((job) => [job.filename, job]));
  const release = (count = 1) => { for (let i = 0; i < count; i++) held.shift()?.(); };
  return { service, calls, held, add, start, jobsNow, release };
}

test("by default two recordings are worked on at once and the third waits for a slot", async (t) => {
  const { service, calls, add, start, jobsNow, release } = await harness(t);
  assert.equal((await service.call("audio.settings.get", {})).audioConcurrency, 2, "the default is two at a time");
  for (const [name, fill] of [["a.wav", 1], ["b.wav", 2], ["c.wav", 3]]) await add(name, fill);
  const [a, b, c] = [await start("a.wav"), await start("b.wav"), await start("c.wav")];
  assert.deepEqual([a, b, c].map((r) => [r.status, r.queuedBehind]), [["running", 0], ["running", 0], ["queued", 1]]);
  await until(() => calls.transcribe === 2, "both first recordings to be transcribing together");
  const now = await jobsNow();
  assert.deepEqual(["a.wav", "b.wav", "c.wav"].map((name) => now[name].status), ["running", "running", "queued"]);
  assert.equal(now["c.wav"].phase, "queued");
  assert.equal(calls.transcribe, 2, "the waiting one has not touched the network");

  release();
  await service.call("job.wait", { jobId: a.jobId, timeoutSeconds: 10 });
  await until(() => calls.transcribe === 3, "the waiting recording to take the freed slot");
  assert.equal((await jobsNow())["c.wav"].status, "running");
  release(2);
  for (const r of [b, c]) assert.equal((await service.call("job.wait", { jobId: r.jobId, timeoutSeconds: 10 })).status, "complete");
  assert.equal((await service.call("snapshot", {})).sources.length, 3);
});

test("the limit is a setting: one at a time runs them in turn, and raising it starts the one that waits", async (t) => {
  const { service, calls, add, start, jobsNow, release } = await harness(t, { limit: 1 });
  await add("a.wav", 1); await add("b.wav", 2);
  const [a, b] = [await start("a.wav"), await start("b.wav")];
  assert.deepEqual([a.status, b.status, b.queuedBehind], ["running", "queued", 1]);
  await until(() => calls.transcribe === 1, "the first transcription");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.transcribe, 1, "with one slot the second waits");

  await service.call("audio.settings.set", { audioConcurrency: 2 });
  await until(() => calls.transcribe === 2, "the waiting recording to start as soon as the limit allows");
  assert.equal((await jobsNow())["b.wav"].status, "running");
  release(2);
  for (const r of [a, b]) assert.equal((await service.call("job.wait", { jobId: r.jobId, timeoutSeconds: 10 })).status, "complete");

  await assert.rejects(service.call("audio.settings.set", { audioConcurrency: 0 }), /1 到 6/);
  await assert.rejects(service.call("audio.settings.set", { audioConcurrency: 7 }), /1 到 6/);
  await assert.rejects(service.call("audio.settings.set", { audioConcurrency: 2.5 }), /1 到 6/);
  assert.equal((await service.call("audio.settings.set", { audioConcurrency: 6 })).audioConcurrency, 6);
});

test("stopping a recording that is still waiting ends it at once and holds no slot", async (t) => {
  const { service, calls, add, start, release } = await harness(t, { limit: 1 });
  await add("a.wav", 1); await add("b.wav", 2); await add("c.wav", 3);
  const [a, b, c] = [await start("a.wav"), await start("b.wav"), await start("c.wav")];
  await until(() => calls.transcribe === 1, "the first transcription");
  await service.call("job.cancel", { jobId: b.jobId });
  const cancelled = await service.call("job.wait", { jobId: b.jobId, timeoutSeconds: 5 });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.retryable, true, "it can still be started later without choosing the file again");
  assert.equal(calls.transcribe, 1, "the first one is still the only one working");

  release();
  await service.call("job.wait", { jobId: a.jobId, timeoutSeconds: 10 });
  await until(() => calls.transcribe === 2, "the next in line to start (not the cancelled one)");
  release();
  assert.equal((await service.call("job.wait", { jobId: c.jobId, timeoutSeconds: 10 })).status, "complete");
});

test("the same recording under two names is transcribed once, not twice at the same time", async (t) => {
  const { service, calls, add, start, jobsNow, release } = await harness(t);
  await add("lecture.wav", 4); await add("lecture copy.wav", 4);
  const [first, second] = [await start("lecture.wav"), await start("lecture copy.wav")];
  await until(() => calls.transcribe === 1, "the first transcription");
  await until(async () => (await jobsNow())["lecture copy.wav"]?.phase === "queued", "the copy to wait its turn");
  assert.equal(calls.transcribe, 1, "the copy does not pay for the same audio again");

  release();
  assert.equal((await service.call("job.wait", { jobId: first.jobId, timeoutSeconds: 10 })).status, "complete");
  const copy = await service.call("job.wait", { jobId: second.jobId, timeoutSeconds: 10 });
  assert.equal(copy.status, "complete", copy.stage);
  assert.equal(copy.reused, true, "it finds the source the first one saved");
  assert.equal(calls.transcribe, 1);
  assert.equal((await service.call("snapshot", {})).sources.length, 1);
});

test('queued audio keeps its submitted course and vocabulary after focus switches', async t => {
  const { service, calls, add, start, release } = await harness(t, { limit: 1 });
  await service.call('source.add', { title: 'Course directory', text: 'Course directory for imports', courses: ['A', 'B'] });
  await service.call('focus.set', { course: 'A' });
  await service.store.update(state => state.decks.push({ id: 'a-course', title: 'Original terminology', course: 'A', cards: [] }));
  await add('first.wav', 7); await add('queued.wav', 8);
  const first = await start('first.wav'), queued = await start('queued.wav');
  await until(() => calls.transcribe === 1, 'first transcription');
  await service.call('focus.set', { course: 'B' });
  await service.store.update(state => { state.decks[0].title = 'Changed terminology'; });
  release();
  await service.call('job.wait', { jobId: first.jobId, timeoutSeconds: 10 });
  await until(() => calls.transcribe === 2, 'queued transcription');
  release();
  const done = await service.call('job.wait', { jobId: queued.jobId, timeoutSeconds: 10 });
  assert.equal(done.status, 'complete', done.stage);
  assert.deepEqual((await service.call('source.get', { id: done.sourceIds[0] })).courses, ['A']);
  assert.ok(calls.vocabularies[1].includes('Original terminology'));
  assert.ok(!calls.vocabularies[1].includes('Changed terminology'));
  assert.equal((await service.call('snapshot')).focus.course, 'B');
});

test("a copy that waits for the same recording can be stopped, and the next one still waits for the first", async (t) => {
  const { service, calls, add, start, jobsNow, release } = await harness(t, { limit: 3 });
  await add("one.wav", 5); await add("two.wav", 5); await add("three.wav", 5);
  const [one, two, three] = [await start("one.wav"), await start("two.wav"), await start("three.wav")];
  await until(() => calls.transcribe === 1, "the first transcription");
  await until(async () => (await jobsNow())["three.wav"]?.phase === "queued", "the third to wait");
  await service.call("job.cancel", { jobId: two.jobId });
  assert.equal((await service.call("job.wait", { jobId: two.jobId, timeoutSeconds: 5 })).status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await jobsNow())["three.wav"].phase, "queued", "the third still waits for the first, not for the one that was stopped");
  assert.equal(calls.transcribe, 1);
  release();
  await service.call("job.wait", { jobId: one.jobId, timeoutSeconds: 10 });
  const done = await service.call("job.wait", { jobId: three.jobId, timeoutSeconds: 10 });
  assert.deepEqual([done.status, done.reused], ["complete", true]);
});
