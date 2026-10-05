import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { jobArchive } from '../lib/job-archive.js';
import { jobCleanup } from '../lib/job-cleanup.js';
import { createJobServices } from '../lib/runtime/jobs.js';
import { settleJob, until } from './helpers/wait.mjs';

/* 任务 归档 through the whole service (the jobs context, the library snapshot and the audio recovery) on temporary libraries with fake models: a restart is a new
   service over the same folder (the archive's file is read again). Nothing here touches a real library, a key or ~/.dsh. */

const KEY = 'AIzaArchiveTestKey_0000000000001';
const text = '容器镜像把应用和它的运行环境打包在一起，交付到服务器上时已经是成型的产物，使用方不必再自行编译安装。'.repeat(4);
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const reply = (words) => json({ candidates: [{ content: { parts: [{ text: words }] } }], usageMetadata: {} });
const pcmWav = (seconds, rate = 8000) => {
  const data = Buffer.alloc(seconds * rate * 2, 1), header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
};

async function questionLibrary(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-archive-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async () => { throw new Error('model down'); } });
  await service.call('source.add', { id: 's', title: '容器笔记', text });
  const started = [await service.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' }), await service.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' })];
  for (const job of started) await service.call('job.wait', { jobId: job.jobId });
  return { root, service, ids: started.map((job) => job.jobId) };
}
const liveIds = async (service) => (await service.call('snapshot')).jobs.map((job) => job.id);

test('a finished question job is archived: it leaves snapshot.jobs, shows in snapshot.archivedJobs read-only, survives a restart, and unarchive brings it back', async (t) => {
  const { root, service, ids } = await questionLibrary(t);
  const before = (await service.call('snapshot')).fingerprint;
  const reply = await service.call('job.archive', { jobIds: ids });
  assert.deepEqual(reply.archived.sort(), [...ids].sort());
  const snapshot = await service.call('snapshot');
  assert.deepEqual(snapshot.jobs, []);
  assert.deepEqual(snapshot.archivedJobs.map((job) => job.id).sort(), [...ids].sort());
  assert.notEqual(snapshot.fingerprint, before, 'archiving changes what the panel polls for');
  const first = snapshot.archivedJobs[0];
  assert.equal(first.archived.at.slice(0, 2), '20');
  assert.equal(first.contract.status, 'failed');
  assert.equal(first.contract.actions.retry.available, false);
  assert.equal(first.contract.actions.retry.reason.code, 'archived');
  assert.equal((await service.call('snapshot', { compact: true })).archivedJobs, undefined, 'an agent reads live jobs only');
  // a restart: a new service over the same folder reads the file again
  jobArchive(root).reload();
  const restarted = new StudyService(root, { complete: async () => { throw new Error('model down'); } });
  const again = await restarted.call('snapshot');
  assert.deepEqual(again.jobs, []);
  assert.equal(again.archivedJobs.length, 2, 'still there after a restart');
  assert.deepEqual((await restarted.call('job.unarchive', { jobIds: [ids[0]] })).unarchived, [ids[0]]);
  const back = await restarted.call('snapshot');
  assert.deepEqual(back.jobs.map((job) => job.id), [ids[0]]);
  assert.equal(back.jobs[0].contract.title, first.contract.title ?? back.jobs[0].contract.title);
  assert.equal(back.jobs[0].contract.status, 'failed');
  assert.equal(back.jobs[0].restoredContract, undefined);
  assert.equal(back.archivedJobs.length, 1);
  // and it can be dismissed like any finished job
  assert.deepEqual(await restarted.call('job.dismiss', { jobId: ids[0] }), { dismissed: [ids[0]] });
  assert.deepEqual(await restarted.call('job.delete', { jobIds: [ids[1]] }), { deleted: [ids[1]], skipped: [], missing: [] });
  assert.deepEqual((await restarted.call('snapshot')).archivedJobs, []);
});

test('job.delete skips a running job and says so, in the same request that deletes the finished ones', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-archive-running-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = new StudyService(root, { complete: async (system, prompt, options) => { await gate; throw new Error('model down'); } });
  t.after(() => release());
  await service.call('source.add', { id: 's', title: '容器笔记', text });
  const running = await service.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' });
  const reply = await service.call('job.delete', { jobIds: [running.jobId, 'nothing'] });
  assert.deepEqual(reply, { deleted: [], skipped: [{ id: running.jobId, reason: 'running' }], missing: ['nothing'] });
  assert.deepEqual(await liveIds(service), [running.jobId]);
  assert.deepEqual((await service.call('job.archive', { jobIds: [running.jobId] })).skipped, [{ id: running.jobId, reason: 'running' }]);
  release();
  await service.call('job.wait', { jobId: running.jobId });
});

async function audioLibrary(t, { failTranslate = () => true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'study-archive-audio-')), previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'home');
  t.after(async () => { await jobCleanup.idle(); if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous; await rm(dir, { recursive: true, force: true }); });
  const fetch = async (url, init = {}) => {
    url = String(url);
    if (init.method === 'DELETE') return json({});
    const body = JSON.parse(init.body);
    if (url.includes('transcribe:')) return reply('今天我们讲谷歌地图的应用案例。第一个案例是路线规划。');
    const system = body.systemInstruction.parts[0].text, prompt = body.contents[0].parts[0].text;
    const kind = system.startsWith('You proofread') ? 'proofread' : system.startsWith('You translate') ? 'translate' : 'title';
    if (kind === 'proofread') return reply('{"corrections":[]}');
    if (kind === 'title') return reply('{"titleEn":"Maps"}');
    if (failTranslate()) return reply('this is not json at all');
    const cut = prompt.indexOf('\n\nYour previous'), payload = JSON.parse(cut < 0 ? prompt : prompt.slice(0, cut));
    return reply(JSON.stringify({ titleZh: '地图', titleEn: 'Maps', paragraphs: payload.paragraphs.map((p) => ({ n: p.n, en: 'Translated.', zh: '译文。' })) }));
  };
  const root = join(dir, 'library'), service = new StudyService(root, { fetch });
  await service.call('audio.settings.set', { paidKey: KEY, textProvider: 'gemini' });
  const file = join(dir, '地图.mp3');
  await writeFile(file, pcmWav(5));
  return { dir, root, service, file, fetch };
}
const folders = (root) => readdir(join(root, 'audio-batches')).catch(() => []);

test('an archived audio import keeps its folder untouched, is not resurrected by a restart, and unarchive brings it back ready to continue; delete cleans the working copy', async (t) => {
  const { root, service, file, fetch } = await audioLibrary(t);
  const failed = await settleJob(service, (await service.call('audio.import', { path: file })).jobId);
  assert.equal(failed.status, 'failed');
  const key = failed.singleId, folder = (await folders(root)).filter((name) => !name.includes('.retired'));
  assert.deepEqual(folder, [key]);
  const reply = await service.call('job.archive', { jobIds: [key] });
  assert.deepEqual(reply.archived, [key]);
  assert.deepEqual(await folders(root), [key], 'archiving deletes nothing');
  assert.deepEqual((await service.call('snapshot')).jobs, []);
  // restart
  jobArchive(root).reload();
  const restarted = new StudyService(root, { fetch });
  const snapshot = await restarted.call('snapshot');
  assert.deepEqual(snapshot.jobs, [], 'a restart does not bring an archived import back into the list');
  assert.equal(snapshot.archivedJobs.length, 1);
  assert.equal(snapshot.archivedJobs[0].contract.jobId, key);
  assert.equal(snapshot.archivedJobs[0].contract.status, 'failed');
  assert.deepEqual(await folders(root), [key]);
  await assert.rejects(restarted.call('job.control', { jobId: key, action: 'retry' }), (error) => error.code === 'archived');
  // unarchive: the folder is read the way a restart reads it, so the job can be continued
  assert.deepEqual((await restarted.call('job.unarchive', { jobIds: [key] })).unarchived, [key]);
  const back = (await restarted.call('snapshot')).jobs;
  assert.equal(back.length, 1);
  assert.equal(back[0].singleId, key);
  assert.equal(back[0].contract.actions.retry.available, true, 'it can be continued from where it stopped');
  assert.deepEqual((await restarted.call('snapshot')).archivedJobs, []);
  // archive again, then delete the archived record: the working copy goes with it, the library keeps its sources
  await restarted.call('job.archive', { jobIds: [key] });
  assert.deepEqual(await restarted.call('job.delete', { jobIds: [key] }), { deleted: [key], skipped: [], missing: [] });
  await jobCleanup.idle();
  assert.deepEqual((await folders(root)).filter((name) => name.includes(key)), [], 'the batch folder is gone once the background cleanup settles');
  assert.deepEqual((await restarted.call('snapshot')).archivedJobs, []);
  assert.equal((await restarted.call('snapshot')).sources.length, 0, 'nothing else was removed');
});

test('a finished audio import that is archived leaves its transcripts alone: the sources it made are still in the library', async (t) => {
  const { root, service, file } = await audioLibrary(t, { failTranslate: () => false });
  const done = await settleJob(service, (await service.call('audio.import', { path: file })).jobId);
  assert.equal(done.status, 'complete', done.stage);
  const sources = (await service.call('snapshot')).sources.map((source) => source.id);
  assert.ok(sources.length >= 1);
  await service.call('job.archive', { jobIds: [done.singleId || done.id] });
  const after = await service.call('snapshot');
  assert.deepEqual(after.sources.map((source) => source.id), sources);
  assert.deepEqual(after.archivedJobs[0].contract.result.refs.filter((ref) => ref.kind === 'source').map((ref) => ref.id), sources);
  await service.call('job.delete', { jobIds: [done.singleId || done.id] });
  await jobCleanup.idle();
  assert.deepEqual((await service.call('snapshot')).sources.map((source) => source.id), sources, 'deleting the task record never deletes what it imported');
  assert.ok(root);
});

test('finished jobs do not vanish when the list is trimmed: past 100 the oldest are archived (auto) before they leave memory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-archive-prune-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const jobs = new Map();
  for (let n = 0; n < 103; n++) jobs.set(`gen-${n}`, { id: `gen-${n}`, root, status: 'failed', deckTitle: `Deck ${n}`, startedAt: new Date(Date.UTC(2026, 9, 1, 0, n)).toISOString(), finishedAt: new Date(Date.UTC(2026, 9, 1, 1, n)).toISOString() });
  jobs.set('running', { id: 'running', root, status: 'running', startedAt: '2020-01-01T00:00:00.000Z' });
  const services = createJobServices({ jobs, retryable: new Map(), generationControllers: new Map() });
  await services.pruneJobs();
  assert.equal(jobs.size, 101, '100 finished jobs and the running one stay in memory');
  const archive = jobArchive(root);
  const kept = await archive.list();
  assert.deepEqual(kept.map((record) => record.id).sort(), ['gen-0', 'gen-1', 'gen-2']);
  assert.ok(kept.every((record) => record.auto === true && record.job.archived.auto === true), 'marked as archived by the list trimming, not by the learner');
  assert.equal(kept[0].job.contract.title.startsWith('Deck'), true);
  await until(async () => (await readdir(root)).includes('job-archive.json'));
});

test('a legacy job (an old failed inbox letter) that is archived stays archived after a restart instead of coming back from its letter', async (t) => {
  const { root, service, fetch } = await audioLibrary(t);
  const { notify } = await import('../lib/inbox.js');
  await service.store.update((s) => { notify(s, { kind: 'audio-failed', jobId: 'old-single-job', filename: '谷歌地图.mp3', detail: '校对第 2/9 段失败' }); });
  assert.ok((await liveIds(service)).includes('old-single-job'));
  await service.call('job.archive', { jobIds: ['old-single-job'] });
  assert.ok(!(await liveIds(service)).includes('old-single-job'));
  jobArchive(root).reload();
  const restarted = new StudyService(root, { fetch });
  assert.ok(!(await liveIds(restarted)).includes('old-single-job'));
  assert.equal((await restarted.call('snapshot')).archivedJobs.some((job) => job.id === 'old-single-job'), true);
  await restarted.call('job.unarchive', { jobIds: ['old-single-job'] });
  assert.ok((await liveIds(restarted)).includes('old-single-job'), 'unarchive brings the recovery card back');
  await restarted.call('job.delete', { jobIds: ['old-single-job'] });
  assert.ok(!(await restarted.call('snapshot')).inbox.items.some((item) => item.jobId === 'old-single-job' && item.kind === 'audio-failed'), 'deleting prunes the letter');
});
