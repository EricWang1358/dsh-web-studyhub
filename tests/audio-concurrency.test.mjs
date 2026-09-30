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
async function harness(t, { limit, transcript, complete } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "audio-jobs-")), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, "home");
  const held = [], calls = { transcribe: 0, vocabularies: [] };
  const fetch = async (url, init = {}) => {
    url = String(url);
    if (init.method === "DELETE") return json({});
    const body = JSON.parse(init.body);
    if (url.includes("transcribe:")) {
      calls.transcribe++;
      calls.vocabularies.push(body.generationConfig?.audioTranscriptionConfig?.customVocabulary || []);
      await new Promise((resolve, reject) => {
        held.push(resolve);
        init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
      return reply(transcript || "今天我们讲谷歌地图的应用案例。第一个案例是路线规划。");
    }
    const system = body.systemInstruction.parts[0].text, prompt = body.contents[0].parts[0].text;
    if (system.startsWith("You proofread")) return reply('{"corrections":[]}');
    if (system.startsWith("You translate")) {
      const payload = JSON.parse(prompt);
      return reply(JSON.stringify({ titleZh: "地图案例", titleEn: "Map Cases", paragraphs: payload.paragraphs.map((p) => ({ n: p.n, en: "Translated.", zh: "译文。" })) }));
    }
    return reply('{"titleEn":"Google Maps Case Study"}');
  };
  const service = new StudyService(join(dir, "library"), { fetch, complete });
  const services = [service];
  t.after(async () => {
    for (const item of services) {
      await item.call('job.cancel', { all: true });
      for (const job of (await item.call('snapshot')).jobs) await item.call('job.wait', { jobId: job.id, timeoutSeconds: 5 });
    }
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await service.call("audio.settings.set", { paidKey: KEY, textProvider: complete ? 'host' : "gemini", ...(limit ? { audioConcurrency: limit } : {}) });
  const files = {};
  const add = async (name, fill) => { files[name] = join(dir, name); await writeFile(files[name], wav(fill)); return files[name]; };
  const start = (name) => service.call("audio.import", { path: files[name] });
  const jobsNow = async () => Object.fromEntries((await service.call("snapshot", {})).jobs.filter((job) => job.type === "audio-import").map((job) => [job.filename, job]));
  const release = (count = 1) => { for (let i = 0; i < count; i++) held.shift()?.(); };
  const anotherLibrary = () => { const other = new StudyService(join(dir, 'other-library'), { fetch }); services.push(other); return other; };
  return { service, calls, held, add, start, jobsNow, release, anotherLibrary };
}

test("recordings run one at a time and queued recordings take the slot in submitted order", async (t) => {
  const { service, calls, add, start, jobsNow, release } = await harness(t);
  const settings = await service.call('audio.settings.get');
  assert.equal(settings.audioConcurrency, 1);
  assert.equal(settings.textConcurrency, 3);
  for (const [name, fill] of [["a.wav", 1], ["b.wav", 2], ["c.wav", 3]]) await add(name, fill);
  const [a, b, c] = [await start("a.wav"), await start("b.wav"), await start("c.wav")];
  assert.deepEqual([a, b, c].map((r) => [r.status, r.queuedBehind]), [["running", 0], ["queued", 1], ["queued", 2]]);
  await until(() => calls.transcribe === 1, "first recording to start");
  const now = await jobsNow();
  assert.deepEqual(["a.wav", "b.wav", "c.wav"].map((name) => now[name].status), ["running", "queued", "queued"]);
  assert.equal(now["c.wav"].phase, "queued");
  assert.equal(calls.transcribe, 1, "waiting recordings have not touched the network");

  release();
  await service.call("job.wait", { jobId: a.jobId, timeoutSeconds: 10 });
  await until(() => calls.transcribe === 2, "second recording to take the freed slot");
  assert.equal((await jobsNow())["c.wav"].status, "queued");
  release();
  assert.equal((await service.call('job.wait', { jobId: b.jobId, timeoutSeconds: 10 })).status, 'complete');
  await until(() => calls.transcribe === 3, 'third recording to start');
  assert.equal((await jobsNow())["c.wav"].status, "running");
  release();
  assert.equal((await service.call("job.wait", { jobId: c.jobId, timeoutSeconds: 10 })).status, "complete");
  assert.equal((await service.call("snapshot", {})).sources.length, 3);
});

test("legacy recording settings and text concurrency changes never release another recording", async (t) => {
  const { service, calls, add, start, jobsNow, release } = await harness(t, { limit: 1 });
  await add("a.wav", 1); await add("b.wav", 2);
  const [a, b] = [await start("a.wav"), await start("b.wav")];
  assert.deepEqual([a.status, b.status, b.queuedBehind], ["running", "queued", 1]);
  await until(() => calls.transcribe === 1, "the first transcription");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.transcribe, 1, "with one slot the second waits");

  assert.equal((await service.call("audio.settings.set", { audioConcurrency: 2 })).audioConcurrency, 1);
  await service.call('audio.settings.set', { textConcurrency: 2 });
  await service.call('audio.settings.set', { textConcurrency: 3 });
  assert.equal((await jobsNow())["b.wav"].status, "queued");
  assert.equal(calls.transcribe, 1);
  release();
  assert.equal((await service.call('job.wait', { jobId: a.jobId, timeoutSeconds: 10 })).status, 'complete');
  await until(() => calls.transcribe === 2, 'second recording after first completes');
  release();
  assert.equal((await service.call('job.wait', { jobId: b.jobId, timeoutSeconds: 10 })).status, 'complete');

  await assert.rejects(service.call("audio.settings.set", { audioConcurrency: 0 }), /1 到 6/);
  await assert.rejects(service.call("audio.settings.set", { audioConcurrency: 7 }), /1 到 6/);
  await assert.rejects(service.call("audio.settings.set", { audioConcurrency: 2.5 }), /1 到 6/);
  assert.equal((await service.call("audio.settings.set", { audioConcurrency: 6 })).audioConcurrency, 1);
});

test('recordings from different libraries share one host processing slot', async t => {
  const { service, anotherLibrary, add, start, calls, release } = await harness(t);
  const other = anotherLibrary();
  await add('first.wav', 10);
  const path = await add('second.wav', 11);
  const first = await start('first.wav');
  await until(() => calls.transcribe === 1, 'first library transcription');
  const second = await other.call('audio.import', { path });
  assert.equal(second.status, 'queued');
  assert.equal(calls.transcribe, 1);
  release();
  assert.equal((await service.call('job.wait', { jobId: first.jobId, timeoutSeconds: 10 })).status, 'complete');
  await until(() => calls.transcribe === 2, 'other library transcription');
  release();
  assert.equal((await other.call('job.wait', { jobId: second.jobId, timeoutSeconds: 10 })).status, 'complete');
});

test('the service overlaps plugin-owned host children and tracks each child separately', async t => {
  const pending = new Map(), requests = [];
  let active = 0, maximum = 0;
  const complete = async (system, prompt, options) => {
    const kind = system.startsWith('You proofread') ? 'proofread' : system.startsWith('You translate') ? 'translate' : 'title';
    requests.push({ kind, options });
    assert.equal(options.resultOwner, 'plugin');
    const childId = `child-${requests.length}`;
    options.onEvent({ runtime: 'subagent', childId, status: 'running' });
    if (kind !== 'title') {
      active++; maximum = Math.max(maximum, active);
      try { await new Promise((resolve, reject) => {
        pending.set(childId, resolve);
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      }); } finally { active--; pending.delete(childId); }
    }
    if (kind === 'proofread') return '{"corrections":[]}';
    if (kind === 'title') return '{"titleEn":"Lecture"}';
    const input = JSON.parse(prompt);
    return JSON.stringify({ titleEn: options.stage, titleZh: '译文', paragraphs: input.paragraphs.map(p => ({ n: p.n, zh: '译文。' })) });
  };
  const transcript = Array.from({ length: 4 }, (_, i) => `Part ${i + 1}: ` + 'lecture evidence '.repeat(260)).join('\n\n');
  const { service, add, start, release, calls } = await harness(t, { transcript, complete });
  await add('long.wav', 12);
  const started = await start('long.wav');
  await until(() => calls.transcribe === 1, 'transcription');
  release();
  await until(() => pending.size === 3, 'three host children');
  const running = (await service.call('snapshot')).jobs.find(job => job.id === started.jobId).tasks.filter(task => task.kind === 'proofread');
  assert.equal(running.length, 3);
  assert.equal(new Set(running.map(task => task.childId)).size, 3);
  assert.ok(running.every(task => task.runtime === 'subagent' && task.status === 'running'));
  for (let wave = 0; wave < 4; wave++) {
    await until(() => pending.size === (wave % 2 === 0 ? 3 : 1), `text wave ${wave}`);
    for (const resume of [...pending.values()].toReversed()) resume();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const done = await service.call('job.wait', { jobId: started.jobId, timeoutSeconds: 10 });
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(maximum, 3);
  assert.equal(active, 0);
  assert.equal(requests.filter(item => item.kind === 'proofread').length, 4);
  assert.equal(requests.filter(item => item.kind === 'translate').length, 4);
  assert.ok(requests.every(item => item.options.jobId === started.jobId));
  assert.ok(done.tasks.filter(task => ['proofread', 'translate'].includes(task.kind)).every(task => task.status === 'complete'));
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
