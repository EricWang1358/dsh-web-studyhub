import test from 'node:test';
import assert from 'node:assert/strict';
import { writeSaved } from '../lib/live.js';
import { liveLeftToFinish } from '../lib/live-finish.js';
import { library } from './helpers/audio-family.mjs';
import { settleJob } from './helpers/wait.mjs';

/* 保存为资料 after the class is never blocked. What is missing (polish of sentences the polish has not reached, translations that failed, class notes) is
   finished first by one job of the task console, bounded; whatever cannot be finished is said in the job's result and the transcript is saved anyway. */

const ID = 'finish-class-0001';
const SENTENCES = ['Transactions preserve consistency across related database changes.', '分区可以减少查询需要读取的数据量。', 'Partitioning splits one big table into smaller pieces.'];
const reply = (input, extra = {}) => JSON.stringify({ items: [], note: { text: `要点 ${input.items.at(-1).n}`, refs: [input.items.at(-1).n] },
  memory: { text: '课程摘要', refs: [input.items.at(-1).n] }, followups: [], ...extra });
/** A text model that corrects (nothing to change), writes notes, and cannot translate. */
const model = log => async (system, prompt) => {
  if (system.startsWith('You correct speech-recognition')) { const input = JSON.parse(prompt); log.push('correct'); return reply(input); }
  if (system.includes('class notes from a live-class transcript')) { log.push('notes'); return JSON.stringify({ summary: '摘要', points: [{ text: '要点', refs: [1] }] }); }
  log.push('other'); throw new Error('translation model unavailable');
};
async function savedClass(t, { complete, settings = { textProvider: 'host' }, zhStates = ['done', 'none', 'error'] } = {}) {
  const log = [], lib = await library(t, { settings, ...(complete === null ? {} : { complete: complete ?? model(log) }) });
  await writeSaved(lib.root, { id: ID, title: 'Databases week 5', course: 'Databases', vocabulary: [],
    segments: SENTENCES.map((en, index) => ({ id: index + 1, t: index * 5000, en, zh: zhStates[index] === 'done' ? '译' : '', zhState: zhStates[index] })) });
  return { ...lib, log };
}
const sessionOf = async lib => { await lib.service.call('live.get', { id: ID }); return lib.service.runtime.liveSessions.registered(lib.root, ID); };

test('what is left to finish: sentences the polish has not reached and non-Chinese translations that failed, never a Chinese sentence', async t => {
  const lib = await savedClass(t);
  const session = await sessionOf(lib);
  assert.deepEqual(liveLeftToFinish(session, { model: true }), { polish: 3, translations: 1 });
  assert.deepEqual(liveLeftToFinish(session, { model: false }), { polish: 0, translations: 0 }, 'with no model nothing can be finished');
});

test('saving a class with polish and a translation left is one job that finishes the polish, says what failed, and saves the transcript and the notes', async t => {
  const lib = await savedClass(t);
  const started = await lib.service.call('live.save', { id: ID });
  assert.ok(started.jobId, 'a job, visible in the task console');
  const done = await settleJob(lib.service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.ok(lib.log.includes('correct'), 'the polish ran through the correction path');
  const session = lib.service.runtime.liveSessions.registered(lib.root, ID);
  assert.equal(session.correction.snapshot().pending, 0);
  assert.equal(done.sourceIds.length, 2, 'the transcript and the class notes');
  assert.match(done.sourceIds[1], /-notes-/);
  assert.ok(done.warnings.some(text => /有 1 句没有译文/.test(text)), JSON.stringify(done.warnings));
  assert.match(done.stage, /有几项没有完成/);
  const state = await lib.state();
  assert.ok(state.sources.some(source => source.id === done.sourceIds[0]), 'the transcript is saved although the translation failed');
  assert.match(state.sources.find(source => source.id === done.sourceIds[0]).text, /Partitioning splits/);
});

test('a class that is complete is saved at once, as before: no job', async t => {
  const lib = await savedClass(t, { zhStates: ['done', 'none', 'done'], complete: async () => { throw new Error('no request expected before the notes'); } });
  const session = await sessionOf(lib);
  session.correction.coveredThrough = 3;
  const reply = await lib.service.call('live.save', { id: ID });
  assert.equal(reply.jobId, undefined);
  assert.equal(reply.sourceIds.length, 1, 'no notes: the model could not write them');
  assert.equal(reply.noteSourceId, null);
});

test('with no model the class is saved at once, never refused for unpolished sentences, waiting translations or background corrections', async t => {
  const lib = await savedClass(t, { complete: null, settings: { textProvider: 'gemini' } });
  const reply = await lib.service.call('live.save', { id: ID });
  assert.equal(reply.jobId, undefined);
  assert.deepEqual([reply.sourceIds.length, reply.noteSourceId], [1, null]);
  const session = lib.service.runtime.liveSessions.registered(lib.root, ID);
  session.correction.tasks.push({ id: 't', ids: [1], reason: 'x', evidenceIds: [], status: 'queued', attempts: 0 });
  session.correction.worker = Promise.resolve();
  const again = await lib.service.call('live.save', { id: ID });
  assert.deepEqual(again.sourceIds, reply.sourceIds);
});

test('the proofread save is not refused for an unfinished polish either', async t => {
  const lib = await savedClass(t);
  const started = await lib.service.call('live.save', { id: ID, proofread: true });
  assert.ok(started.jobId);
});

test('a class that is still running cannot be saved, and says so', async t => {
  const lib = await savedClass(t);
  const session = await sessionOf(lib);
  Object.defineProperty(session, 'active', { get: () => true });
  await assert.rejects(lib.service.call('live.save', { id: ID }), /请先结束这场实录/);
});
