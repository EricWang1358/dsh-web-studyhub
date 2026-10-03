import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { checkpoints, finishTranscript } from "../lib/audio-import.js";
import { localizeAppMessage } from "../lib/application-messages.js";

/* Pre-flight (P44/P46/P49): configuration and every file are checked before any upload or provider request; a
   member that cannot be imported holds its siblings visibly instead of cancelling them; failures read as plain words. */

const SF = "sk-siliconflowkey00000000000000004", PAID = "PAID_KEY_0000000000000000002";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const ENV = /GEMINI_|GROQ_API|SILICONFLOW_API|_API_KEY|FFMPEG_PATH|titleZh|titleEn/;

const wav = (seconds, fill = 1, rate = 8000) => {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2, fill), header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};
/** A minimal M4A of `minutes` (fake AAC frames: enough for the container, which is all pre-flight reads). */
function longM4a(minutes) {
  const box = (type, ...parts) => { const body = Buffer.concat(parts), head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, "latin1"); return Buffer.concat([head, body]); };
  const full = (type, flags, ...parts) => { const head = Buffer.alloc(4); head.writeUInt32BE(flags); return box(type, head, ...parts); };
  const words = (values) => { const out = Buffer.alloc(values.length * 4); values.forEach((value, i) => out.writeUInt32BE(value, i * 4)); return out; };
  const count = Math.ceil(minutes * 60 * 16000 / 1024), frame = Buffer.from([0x21, 0x10, 0x04, 0x60]);
  const ftyp = box("ftyp", Buffer.from("M4A "), words([0]));
  const mdat = box("mdat", Buffer.concat(Array.from({ length: count }, () => frame)));
  const moov = box("moov", full("mvhd", 0, words([0, 0, 1000, minutes * 60000, 0x10000]), Buffer.alloc(80)),
    box("trak", box("mdia", full("mdhd", 0, words([0, 0, 16000, count * 1024]), Buffer.from([0x55, 0xc4, 0, 0])),
      full("hdlr", 0, words([0]), Buffer.from("soun"), Buffer.alloc(13)),
      box("minf", box("stbl", full("stsd", 0, words([1]), box("mp4a", Buffer.alloc(28))), full("stts", 0, words([1, count, 1024])),
        full("stsc", 0, words([1, 1, count, 1])), full("stsz", 0, words([4, count])), full("stco", 0, words([1, ftyp.length + 8])))))));
  return Buffer.concat([ftyp, mdat, moov]);
}

async function fixture(t, { keys = {}, complete, fetch } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wp6-preflight-")), names = ["DSH_HOME", "GEMINI_FREE_API_KEY", "GEMINI_PAID_API_KEY", "GROQ_API_KEY", "SILICONFLOW_API_KEY"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.DSH_HOME = join(dir, "home");
  t.after(async () => {
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    await rm(dir, { recursive: true, force: true });
  });
  const calls = [];
  const network = fetch || (async (url) => { calls.push(String(url)); return json({ text: "今天讲事务和索引。" }); });
  const service = new StudyService(join(dir, "library"), { fetch: network, complete });
  if (Object.keys(keys).length) await service.call("audio.settings.set", keys);
  const file = async (name, bytes) => { const path = join(dir, name); await writeFile(path, bytes); return path; };
  return { dir, service, calls, file };
}
const textModel = async (system, prompt) => {
  if (system.startsWith("You proofread")) return '{"corrections":[]}';
  if (system.startsWith("You translate")) return JSON.stringify({ titleZh: "事务", titleEn: "Transactions", paragraphs: JSON.parse(prompt.split("\n\nYour previous")[0]).paragraphs.map((p) => ({ n: p.n, en: "Translated.", zh: "译文。" })) });
  return '{"titleEn":"Database Lecture"}';
};

test("with nothing configured, pre-flight says so before any file is sent", async (t) => {
  const { service } = await fixture(t);
  const ready = await service.call("audio.preflight", {});
  assert.equal(ready.transcription, false);
  assert.deepEqual(ready.providers, { free: false, siliconflow: false, groq: false, paid: false });
  assert.equal(ready.first, null);
  assert.equal(ready.reason, "no-provider");
  assert.deepEqual(ready.files, []);
  await assert.rejects(service.call("audio.import", { path: join(tmpdir(), "nothing-here.mp3") }), (error) => {
    assert.match(error.message, /还没有配置转写服务/);
    assert.match(error.message, /设置 › 音频转写/);
    assert.doesNotMatch(error.message, ENV);
    return true;
  });
  assert.doesNotMatch(localizeAppMessage((await service.call("audio.import", { path: "/x.mp3" }).catch((error) => error)).message), ENV);
});

test("a SiliconFlow key is enough: it is the first tier, and paid-only without a paid key is named", async (t) => {
  const { service } = await fixture(t, { keys: { siliconflowKey: SF }, complete: textModel });
  const ready = await service.call("audio.preflight", {});
  assert.deepEqual([ready.transcription, ready.first, ready.text, ready.live], [true, "siliconflow", true, false]);
  const paid = await service.call("audio.preflight", { paidOnly: true });
  assert.deepEqual([paid.transcription, paid.reason], [false, "paid-missing"]);
});

test("each file is checked: format, length, how many requests, and a lossless split offered for a long M4A", async (t) => {
  const { service, file, calls } = await fixture(t, { keys: { siliconflowKey: SF, paidKey: PAID }, complete: textModel });
  const long = await file("PE1.m4a", longM4a(76)), short = await file("A.wav", wav(3)), broken = await file("broken.mp3", Buffer.from("not audio at all, just words ".repeat(40)));
  const result = await service.call("audio.preflight", { files: [{ path: long }, { path: short }, { path: broken }] });
  assert.equal(calls.length, 0, "pre-flight never asks a provider");
  const [pe1, a, bad] = result.files;
  assert.deepEqual([pe1.name, pe1.format, pe1.blocked, pe1.parts], ["PE1.m4a", "m4a", false, 2]);
  assert.ok(Math.abs(pe1.seconds - 76 * 60) < 2);
  assert.deepEqual(pe1.issue, { code: "long-split", minutes: 76, parts: 2, requests: 2, partMinutes: 59 });
  assert.deepEqual([a.name, a.blocked, a.issue, a.parts], ["A.wav", false, null, 1]);
  assert.equal(bad.blocked, true);
  assert.equal(bad.issue.code, "AUDIO_CORRUPT");
  assert.match(bad.issue.message, /MP3/);
  assert.equal(result.blockedBy, 2);
});

test('preflight carries the configured request limit when a recording below one hour needs splitting', async t => {
  const { service, file, calls } = await fixture(t, { keys: { siliconflowKey: SF } });
  await service.call('audio.settings.set', { partMinutes: 20 });
  const path = await file('lecture.m4a', longM4a(45));
  const result = await service.call('audio.preflight', { files: [{ path }] });
  assert.equal(result.files[0].issue.partMinutes, 20);
  assert.equal(result.files[0].parts, 3);
  assert.equal(calls.length, 0);
});

test("uploads are checked by their upload id without being claimed", async (t) => {
  const { service } = await fixture(t, { keys: { siliconflowKey: SF }, complete: textModel });
  const bytes = wav(2), { uploadId } = await service.call("audio.upload.start", { name: "lecture.wav", size: bytes.length });
  await service.call("audio.upload.chunk", { uploadId, offset: 0, data: bytes.toString("base64") });
  await service.call("audio.upload.finish", { uploadId });
  const result = await service.call("audio.preflight", { files: [{ uploadId }] });
  assert.deepEqual([result.files[0].name, result.files[0].blocked, result.files[0].format], ["lecture.wav", false, "wav"]);
  const job = await service.call("job.wait", { jobId: (await service.call("audio.import", { uploadId })).jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "complete", job.stage);
});

test("a single file that cannot be imported is refused at once, in plain words, with no job and no request", async (t) => {
  const { service, file, calls } = await fixture(t, { keys: { siliconflowKey: SF }, complete: textModel });
  const broken = await file("broken.mp3", Buffer.from("not audio at all, just words ".repeat(40)));
  await assert.rejects(service.call("audio.import", { path: broken }), /可识别的 MP3 音频帧|不像是有效的 MP3/);
  assert.equal((await service.call("snapshot", {})).jobs.filter((job) => job.type === "audio-import").length, 0);
  assert.equal(calls.length, 0);
});

test("a blocked batch member holds its siblings with a reason, and skipping it continues without it", async (t) => {
  const { service, file, calls } = await fixture(t, { keys: { siliconflowKey: SF }, complete: textModel });
  const broken = await file("PE1.mp3", Buffer.from("not audio at all, just words ".repeat(40)));
  const a = await file("A.wav", wav(3, 1)), b = await file("B.wav", wav(3, 2));
  const started = await service.call("audio.import", { files: [{ path: a }, { path: broken }, { path: b }], title: "Week 5" });
  const failed = await service.call("job.wait", { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(failed.status, "failed");
  assert.equal(calls.length, 0, "no sibling was transcribed while one member is blocked");
  assert.deepEqual(failed.members.map((member) => member.status), ["waiting", "blocked", "waiting"]);
  assert.match(failed.members[1].stage, /可识别的 MP3 音频帧|不像是有效的 MP3/);
  assert.deepEqual(failed.members.filter((member) => member.status === "waiting").map((member) => member.waitingFor), ["PE1.mp3", "PE1.mp3"]);
  assert.deepEqual(failed.blocked, { index: 1, filename: "PE1.mp3" });
  assert.equal(failed.stage, "「PE1.mp3」未通过预检，其余文件尚未开始；可以跳过它继续");
  assert.equal(localizeAppMessage(failed.stage), '"PE1.mp3" did not pass the pre-flight check; the other files have not started. You can skip it and continue');
  assert.equal(failed.retryable, true);

  const english = (await service.call("snapshot", { uiLanguage: "en" })).jobs.find((job) => job.id === failed.id);
  assert.match(english.members[1].stage, /No recognizable MP3 frames|recognizable MP3 audio/);

  await assert.rejects(service.call("audio.retry", { jobId: failed.id, skip: [7] }), /跳过的文件编号无效/);
  const resumed = await service.call("audio.retry", { jobId: failed.id, skip: [1] });
  const done = await service.call("job.wait", { jobId: resumed.jobId, timeoutSeconds: 30 });
  assert.equal(done.status, "complete", done.stage);
  assert.deepEqual(done.members.map((member) => member.status), ["complete", "skipped", "complete"]);
  assert.equal(calls.length, 2, "the two good recordings, once each");
  const source = (await service.call("snapshot", {})).sources.find((item) => done.sourceIds.includes(item.id));
  const { text } = await service.call("source.get", { id: source.id, limit: 60000 });
  assert.ok(text.includes("A.wav") && text.includes("B.wav") && !text.includes("PE1.mp3"));
});

test("a failed part heading never surfaces field names: the part is titled after the file and the import continues", async () => {
  const warnings = [];
  const complete = async (system, prompt) => {
    if (system.startsWith("You proofread")) return '{"corrections":[]}';
    if (system.startsWith("You translate")) return JSON.stringify({ paragraphs: JSON.parse(prompt).paragraphs.map((p) => ({ n: p.n, zh: "译文。" })) });
    return "{}";
  };
  const result = await finishTranscript({ paragraphs: ["Today we talk about indexes."], filename: "Lecture 7.m4a", complete,
    settings: { textConcurrency: 2 }, saved: checkpoints(null), keys: { raw: "r", text: "t" }, warn: (text) => warnings.push(text) });
  assert.match(result.documents[0], /Lecture 7/);
  assert.ok(warnings.includes("第 1 部分的小标题没有生成，已用文件名代替"), warnings.join(" | "));
  assert.equal(localizeAppMessage(warnings[0]), "No heading was generated for part 1; the file name is used instead");
  for (const text of warnings) assert.doesNotMatch(text, ENV);
});
