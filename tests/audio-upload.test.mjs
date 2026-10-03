import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { resolveWorkspacePath, scanAudioFiles, resolveAudioImportPaths } from "../lib/audio-files.js";
import { MAX_AUDIO_BYTES } from "../lib/audio-file.js";
import { domainTool } from "../lib/runtime/tools.js";

const KEY = "AIzaUploadTestKey_000000000000001";
const frame = Buffer.alloc(417);
frame.set([0xff, 0xfb, 0x90, 0x00]);
const mp3 = Buffer.concat(Array.from({ length: 120 }, () => frame));
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const reply = (text) => json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} });
const gemini = async (url, init = {}) => {
  if (init.method === "DELETE") return json({});
  if (String(url).includes("transcribe:")) return reply("We split the table into a partition by date, which is fast.");
  const body = JSON.parse(init.body), system = body.systemInstruction.parts[0].text, sent = body.contents[0].parts[0].text;
  const cut = sent.indexOf("\n\nYour previous"), prompt = JSON.parse(cut < 0 ? sent : sent.slice(0, cut));
  if (system.startsWith("You proofread")) return reply('{"corrections":[]}');
  if (system.startsWith("You translate")) return reply(JSON.stringify({ titleZh: "分区", titleEn: "Partitions", paragraphs: prompt.paragraphs.map((p) => ({ n: p.n, zh: "译" })) }));
  return reply('{"titleEn":"Seminar"}');
};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "audio-upload-")), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, "home");
  t.after(async () => { if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  const root = join(dir, "library"), service = new StudyService(root, { fetch: gemini });
  await service.call("audio.settings.set", { paidKey: KEY });
  return { dir, root, service };
}
async function upload(service, name, bytes, pieces = 3) {
  const { uploadId } = await service.call("audio.upload.start", { name, size: bytes.length });
  const step = Math.ceil(bytes.length / pieces);
  for (let offset = 0; offset < bytes.length; offset += step)
    await service.call("audio.upload.chunk", { uploadId, offset, data: bytes.subarray(offset, offset + step).toString("base64") });
  await service.call("audio.upload.finish", { uploadId });
  return uploadId;
}
const uploadFolders = (root) => readdir(join(root, "audio-uploads")).catch(() => []);

test("a file sent in chunks is assembled byte for byte, under its own name inside the library", async (t) => {
  const { root, service } = await fixture(t);
  const id = await upload(service, "lecture.mp3", mp3);
  const stored = await readFile(join(root, "audio-uploads", id, "lecture.mp3"));
  assert.ok(stored.equals(mp3));
});

test("uploads refuse what they should: formats, order, size, incomplete files and path tricks", async (t) => {
  const { root, service } = await fixture(t);
  await assert.rejects(service.call("audio.upload.start", { name: "notes.txt", size: 10 }), /不支持的音频格式/);
  await assert.rejects(service.call("audio.upload.start", { name: "empty.mp3", size: 0 }), /空的/);
  await assert.rejects(service.call("audio.upload.start", { name: "huge.mp3", size: MAX_AUDIO_BYTES + 1 }), /512 MB/);

  const { uploadId } = await service.call("audio.upload.start", { name: "part.mp3", size: 1000 });
  await assert.rejects(service.call("audio.upload.chunk", { uploadId, offset: 500, data: Buffer.alloc(10).toString("base64") }), /顺序不对/);
  await assert.rejects(service.call("audio.upload.chunk", { uploadId, offset: 0, data: Buffer.alloc(2000).toString("base64") }), /超过了声明的文件大小/);
  await assert.rejects(service.call("audio.upload.chunk", { uploadId, offset: 0, data: "not base64!" }), /数据无效/);
  await service.call("audio.upload.chunk", { uploadId, offset: 0, data: Buffer.alloc(400).toString("base64") });
  await assert.rejects(service.call("audio.upload.finish", { uploadId }), /没有传完（400 \/ 1000/);
  await assert.rejects(service.call("audio.import", { uploadId }), /还没有传完/);
  await assert.rejects(service.call("audio.upload.chunk", { uploadId: "../../etc", offset: 0, data: "AAAA" }), /已经失效/);

  const evil = await service.call("audio.upload.start", { name: "../../outside/evil.mp3", size: 5 });
  assert.deepEqual((await readdir(join(root, "audio-uploads", evil.uploadId))), ["evil.mp3"], "the name is reduced to a file name inside the upload folder");
  assert.deepEqual(await service.call("audio.upload.cancel", { uploadId: evil.uploadId }), { cancelled: true });
  assert.ok(!(await uploadFolders(root)).includes(evil.uploadId));
  await assert.rejects(service.call("audio.import", { path: "/x.mp3", uploadId }), /只能给一个/);
});

test("importing an upload keeps the original name and removes the copy when the job is over", async (t) => {
  const { root, service } = await fixture(t);
  const id = await upload(service, "SQL技术特性与应用讨论.mp3", mp3, 2);
  const started = await service.call("audio.import", { uploadId: id, subject: "SQL" });
  const job = await service.call("job.wait", { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "complete", job.stage);
  assert.equal(job.filename, "SQL技术特性与应用讨论.mp3");
  const source = await service.call("source.get", { id: job.sourceIds[0] });
  assert.match(source.text, /《SQL技术特性与应用讨论\.mp3》全量中英对照逐字稿/);
  assert.ok(!(await uploadFolders(root)).includes(id), "the uploaded copy is gone once the import has finished");
  await assert.rejects(service.call("audio.import", { uploadId: id }), /已经失效/);
});

test("the typed audio tool imports an upload and an ordered batch through the public runtime", async t => {
  const { root, service } = await fixture(t);
  const tool = domainTool('audio', { resolveWorkspace: async () => root, requestServices: async () => ({ fetch: gemini }), forLibrary: () => service.runtime });
  assert.equal(tool.parameters.properties.uploadId?.type, 'string');
  assert.equal(tool.parameters.properties.files?.type, 'array');
  const first = await upload(service, 'tool-single.mp3', mp3);
  const single = await tool.execute({ operation: 'audio.import', uploadId: first, terms: 'partition' }, {});
  const singleDone = await tool.execute({ operation: 'job.wait', jobId: single.jobId, timeoutSeconds: 30 }, {});
  assert.equal(singleDone.status, 'complete', singleDone.stage);
  assert.equal(singleDone.filename, 'tool-single.mp3');
  const second = await upload(service, 'tool-batch-upload.mp3', mp3);
  const path = join(root, 'tool-batch-path.mp3');
  await writeFile(path, Buffer.concat([mp3, frame]));
  const batch = await tool.execute({ operation: 'audio.import', files: [{ uploadId: second }, { path }], title: 'Tool batch', terms: ['partition'] }, {});
  const batchDone = await tool.execute({ operation: 'job.wait', jobId: batch.jobId, timeoutSeconds: 30 }, {});
  assert.equal(batchDone.status, 'complete', batchDone.stage);
  assert.deepEqual(batchDone.members.map(file => file.filename), ['tool-batch-upload.mp3', 'tool-batch-path.mp3']);
  assert.equal(tool.parameters.properties.paths, undefined, 'the tool does not advertise an ignored paths argument');
});

test("an import that fails to start keeps the upload so the learner can fix the form and retry", async (t) => {
  const { root, service } = await fixture(t);
  const id = await upload(service, "retry.mp3", mp3, 1);
  await assert.rejects(service.call("audio.import", { uploadId: id, title: "x".repeat(300) }), /title 必须是不超过 200 字/);
  assert.ok((await uploadFolders(root)).includes(id));
  const job = await service.call("job.wait", { jobId: (await service.call("audio.import", { uploadId: id })).jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "complete", job.stage);
});

test("the workspace picker lists audio, newest first, skipping build folders and hidden ones", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "audio-files-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const folder of ["sub", "node_modules/pkg", ".hidden", "audio-uploads/x", "audio-batches/x/inputs"]) await mkdir(join(dir, folder), { recursive: true });
  const files = { "old.mp3": 1, "sub/Week5 Lecture.WAV": 3, "notes.txt": 4, "node_modules/pkg/skip.mp3": 5, ".hidden/skip.mp3": 6, "audio-uploads/x/skip.mp3": 7, "audio-batches/x/inputs/skip.wav": 7, "new.m4a": 8 };
  for (const [name, age] of Object.entries(files)) {
    await writeFile(join(dir, name), Buffer.alloc(2048));
    const at = new Date(Date.now() - (10 - age) * 1000);
    await utimes(join(dir, name), at, at);
  }
  await utimes(join(dir, "old.mp3"), new Date(Date.now() - 100_000), new Date(Date.now() - 100_000));
  const all = await scanAudioFiles(dir);
  assert.deepEqual(all.files.map((f) => f.rel.replaceAll("\\", "/")), ["new.m4a", "sub/Week5 Lecture.WAV", "old.mp3"]);
  assert.equal(all.files[0].size, 2048);
  assert.ok(all.files.every((f) => f.path.startsWith(dir)));
  assert.deepEqual((await scanAudioFiles(dir, { query: "week5" })).files.map((f) => f.name), ["Week5 Lecture.WAV"]);
  assert.equal((await scanAudioFiles(dir, { limit: 1 })).truncated, true);
  await assert.rejects(scanAudioFiles("relative/dir"), /工作区路径无效/);
});

test("a path from the conversation may be quoted, @-mentioned or relative to the workspace", () => {
  const cwd = join(tmpdir(), "class");
  assert.equal(resolveWorkspacePath(cwd, "@audio/lecture.mp3"), join(cwd, "audio", "lecture.mp3"));
  assert.equal(resolveWorkspacePath(cwd, '"lecture.mp3"'), join(cwd, "lecture.mp3"));
  assert.equal(resolveWorkspacePath(cwd, join(cwd, "abs.mp3")), join(cwd, "abs.mp3"));
  assert.equal(resolveWorkspacePath(cwd, 42), 42);
  assert.deepEqual(resolveAudioImportPaths(cwd, { files: [{ path: '@B.wav' }, { uploadId: 'upload-A' }, { path: '"A.wav"' }], courses: [] }),
    { files: [{ path: join(cwd, 'B.wav') }, { uploadId: 'upload-A' }, { path: join(cwd, 'A.wav') }], courses: [] });
});
