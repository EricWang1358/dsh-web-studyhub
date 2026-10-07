import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeSaved } from '../lib/live.js';
import { KEY, batchLibrary, hostModel, letters, library, seedReview, subtitleText, wav } from './helpers/audio-family.mjs';
import { AUDIO_SWITCHES } from './helpers/audio-switch.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { settleJob, until } from './helpers/wait.mjs';

/* S2-7: the audio family as a whole. Every path (single recording, batch, subtitles, review, class save, class correction) has its own switch, so the same
   library can see old and new paths together. This file holds what only the whole family can show: the same fixture gives the same result with a switch off
   and on, paths of both sides mixed in one service count and settle once, flipping a switch never changes a job in flight, and every kind of the family
   offers exactly the controls it declares. */

/** Service options with a switch board the test can flip while the service runs (a switch only reads at the next submission). */
function board(complete) {
  const pilot = {}, { runtimePilot: _fixed, ...managed } = switchOptions('runtime', { complete, paths: [] });
  return { pilot, options: { ...managed, runtimePilot: pilot }, flip: (...names) => { for (const name of names) pilot[name] = !pilot[name]; }, set: (value, ...names) => { for (const name of names) pilot[name] = value; } };
}
const ALL = [...AUDIO_SWITCHES];
const CLASS = 'saved-class-0001', CLASS_A = 'saved-class-000a', CLASS_B = 'saved-class-000b', SENTENCES = ['Transactions preserve consistency across related database changes.', 'Partitioning splits one big table into smaller physical pieces.'];
const savedClass = (lib, id = CLASS) => writeSaved(lib.root, { id, title: `Databases ${id}`, course: 'Databases', segments: SENTENCES.map((en, index) => ({ id: index + 1, t: index * 5000, en, zh: `译：${en}`, zhState: 'done' })) });
const rowOf = async (lib, id) => (await lib.service.call('snapshot')).jobs.find(job => job.id === id);
const BATCH_ID = /audio-batch-[0-9a-f-]{36}/g; // a batch's own id is random
const sourcesOf = state => state.sources.map(({ id, text, title, courses }) => ({ id: id.replace(BATCH_ID, '<batch>'), text, title, courses })).sort((a, b) => a.id.localeCompare(b.id));
/** What a learner can see of a library after the work: documents, letter kinds, the requests the model got. */
const visible = (state, requests) => ({ sources: sourcesOf(state), letters: state.inbox.map(item => item.kind).sort(), requests: [...requests].sort() });
const writeFiles = async (dir, fills) => Promise.all(fills.map(async fill => { const path = join(dir, `W${fill}.wav`); await writeFile(path, wav(fill)); return path; }));

/* ---- 1. The same fixture, switch off and on ---------------------------------------------------------------------------------------------------------- */

const PATHS = {
  subtitles: { switches: ['audioSubtitles'], run: async lib => { const done = await settleJob(lib.service, (await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText, course: 'Pricing' })).jobId); return done; } },
  review: { switches: ['audioReview'], run: async lib => { await seedReview(lib.service, 3); return settleJob(lib.service, (await lib.service.call('audio.corrections.review', { sourceId: 'talk-1' })).jobId); } },
  'class save': { switches: ['audioLiveSave'], run: async lib => { await savedClass(lib); return settleJob(lib.service, (await lib.service.call('live.save', { id: CLASS, proofread: true })).jobId); } },
};
for (const [name, path] of Object.entries(PATHS)) test(`${name}: the same fixture gives the same documents, letters and model requests with the switch off and on`, async t => {
  const results = {};
  for (const side of ['legacy', 'runtime']) {
    const log = [], { options, set } = board(hostModel(log));
    set(side === 'runtime', ...path.switches);
    const lib = await library(t, { settings: { textProvider: 'host' }, complete: hostModel(log), ...options });
    const done = await path.run(lib);
    assert.equal(done.status, 'complete', `${side}: ${done.stage}`);
    results[side] = visible(await lib.state(), log);
  }
  assert.deepEqual(results.runtime, results.legacy);
  assert.ok(results.legacy.requests.length > 0 && results.legacy.sources.length > 0, 'the fixture does work');
});

for (const shape of ['single', 'batch']) test(`${shape}: the same recordings give the same documents, letters and model requests with the switch off and on`, async t => {
  const results = {};
  for (const side of ['legacy', 'runtime']) {
    const { options, set } = board(), keys = { paidKey: KEY };
    set(side === 'runtime', shape === 'single' ? 'audioSingle' : 'audioBatch');
    const lib = await batchLibrary(t, { keys, ...options });
    const done = await settleJob(lib.service, (await lib.service.call('audio.import', shape === 'batch' ? { files: [{ path: lib.a }, { path: lib.b }], title: 'Week 3' } : { path: lib.a })).jobId);
    assert.equal(done.status, 'complete', `${side}: ${done.stage}`);
    results[side] = visible(await lib.state(), lib.calls);
  }
  assert.deepEqual(results.runtime, results.legacy);
});

/* ---- 2. Old and new paths together in one service ---------------------------------------------------------------------------------------------------- */

test('paths of both sides mixed in one library: every job is one row, one letter and one set of ledger tokens, whichever side ran it', async t => {
  const log = [], { options, flip, set } = board(hostModel(log));
  const lib = await library(t, { settings: { textProvider: 'host', paidKey: KEY }, complete: hostModel(log), fetch: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'A lecture about transactions and partitions.' }] } }], usageMetadata: {} })), ...options });
  const side = job => job.contract.contractVersion === 2 ? 'runtime' : 'legacy';
  const ran = [];
  const run = async (what, start) => { const done = await settleJob(lib.service, (await start()).jobId); assert.equal(done.status, 'complete', `${what}: ${done.stage}`); ran.push([what, side(await rowOf(lib, done.id))]); return done; };
  const [w3, w4, w5, w6] = await writeFiles(lib.dir, [3, 4, 5, 6]);
  const cues = n => subtitleText.replace('朋友们唉', `第 ${n} 位同学`);
  await seedReview(lib.service, 2, 'talk-1'); await seedReview(lib.service, 2, 'talk-2');
  await savedClass(lib, CLASS_A); await savedClass(lib, CLASS_B);
  // Every path once on the old side, then (a switch flipped between submissions) once on the new side, in one service.
  await run('single', () => lib.service.call('audio.import', { path: w3 }));
  await run('batch', () => lib.service.call('audio.import', { files: [{ path: w4 }, { path: w5 }], title: 'Old batch' }));
  await run('subtitles', () => lib.service.call('audio.subtitles.import', { filename: 'one.txt', text: cues(1) }));
  await run('review', () => lib.service.call('audio.corrections.review', { sourceId: 'talk-1' }));
  await run('class save', () => lib.service.call('live.save', { id: CLASS_A, proofread: true }));
  set(true, ...ALL);
  await run('single', () => lib.service.call('audio.import', { path: w6 }));
  await run('batch', () => lib.service.call('audio.import', { files: [{ path: w3 }, { path: w6 }], title: 'New batch' }));
  await run('subtitles', () => lib.service.call('audio.subtitles.import', { filename: 'two.txt', text: cues(2) }));
  await run('review', () => lib.service.call('audio.corrections.review', { sourceId: 'talk-2' }));
  await run('class save', () => lib.service.call('live.save', { id: CLASS_B, proofread: true }));
  flip('audioSingle');
  assert.deepEqual(ran.map(([, which]) => which), [...Array(5).fill('legacy'), ...Array(5).fill('runtime')], 'a switch decides the side of the NEXT submission, nothing else');
  const state = await lib.state(), jobs = (await lib.service.call('snapshot')).jobs;
  assert.equal(new Set(jobs.map(job => job.id)).size, jobs.length, 'no job is listed twice');
  assert.equal(jobs.length, ran.length);
  const ids = state.sources.map(source => source.id);
  assert.equal(new Set(ids).size, ids.length, 'no document is stored twice');
  const FINAL = ['audio-result', 'audio-failed'];
  for (const job of jobs) assert.equal(letters(state, job.id).filter(kind => FINAL.includes(kind)).length, 1, `${job.id}: exactly one closing letter`);
  // The model's tokens are booked once per request on either side: the host model answered `log.length` requests and the ledger holds that many.
  assert.equal((await lib.ledger()).calls, log.length);
});

/* ---- 3. A switch flipped with work in flight --------------------------------------------------------------------------------------------------------- */

test('a switch flipped while a recording is being transcribed does not change that job: it finishes on its side, the next one follows the switch', async t => {
  const { options, set } = board(), lib = await batchLibrary(t, { keys: { paidKey: KEY, transcribeConcurrency: 2 }, hold: true, ...options });
  set(true, 'audioSingle');
  const first = await lib.service.call('audio.import', { path: lib.a });
  await until(() => lib.held.has('A'), 'the first transcription to start');
  set(false, 'audioSingle');
  const second = await lib.service.call('audio.import', { path: lib.b });
  await until(() => lib.held.has('B'), 'the second transcription to start');
  lib.held.get('B')(); lib.held.get('A')();
  const [a, b] = [await settleJob(lib.service, first.jobId), await settleJob(lib.service, second.jobId)];
  assert.deepEqual([a.status, b.status], ['complete', 'complete'], `${a.stage} / ${b.stage}`);
  assert.deepEqual([(await rowOf(lib, a.id)).contract.contractVersion, (await rowOf(lib, b.id)).contract.contractVersion], [2, 1]);
  assert.deepEqual(lib.calls.filter(call => call.startsWith('transcribe')).sort(), ['transcribe:A', 'transcribe:B'], 'each recording was transcribed once');
  assert.equal((await lib.state()).sources.length, 2);
});

test('the correction of a class keeps the side it started on: a switch turned off mid-class stops nothing and re-arms nothing, a cancelled one stays stopped', async t => {
  const log = [], { options, set } = board(hostModel(log));
  const answer = async (system, prompt, request) => { const input = JSON.parse(prompt), last = input.items.at(-1).n; log.push('correct'); return JSON.stringify({ items: [], note: { text: '知识点', refs: [last] }, memory: { text: '摘要', refs: [last] }, followups: [] }); };
  const lib = await library(t, { settings: { textProvider: 'host' }, complete: answer, completeLight: answer, ...options });
  await savedClass(lib, CLASS_A); await savedClass(lib, CLASS_B);
  set(true, 'audioLiveCorrection');
  await lib.service.call('live.correct', { id: CLASS_A });
  const correctionJobs = async () => (await lib.service.call('snapshot')).jobs.filter(job => job.contract?.kind === 'audio-live-correction');
  await until(async () => (await correctionJobs()).length === 1, 'the correction job of the first class');
  set(false, 'audioLiveCorrection');
  const [job] = await correctionJobs();
  assert.equal((await settleJob(lib.service, job.id)).status, 'complete', 'the job of a class started on the runtime goes on to the end of its class');
  await lib.service.call('live.correct', { id: CLASS_B });
  const second = lib.service.runtime.liveSessions.registered(lib.root, CLASS_B);
  await until(() => second.correction.snapshot().pending === 0 && !second.correction.snapshot().running, 'the legacy correction of the second class');
  assert.equal((await correctionJobs()).length, 1, 'a class started with the switch off is corrected on the old path: no job');
  assert.equal(log.length, 2, 'one request per class, none twice');
});

/* ---- 4. What the console offers ----------------------------------------------------------------------------------------------------------------------- */

test('every audio kind on the runtime offers exactly the controls it declares: cancel works, nothing else is a fake button', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }), answer = hostModel([]);
  const blocked = async (system, prompt, options) => { await Promise.race([gate, new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }))]); return answer(system, prompt, options); };
  const { options, set } = board(blocked);
  set(true, ...ALL);
  const lib = await batchLibrary(t, { keys: { paidKey: KEY, transcribeConcurrency: 3, textProvider: 'host' }, hold: true, ...options, complete: blocked, completeLight: blocked });
  t.after(release);
  await seedReview(lib.service, 2); await savedClass(lib);
  const started = {
    'audio-import': await lib.service.call('audio.import', { path: lib.a }),
    'audio-batch': await lib.service.call('audio.import', { files: [{ path: lib.a }, { path: lib.b }], title: 'Batch' }),
    'audio-subtitles': await lib.service.call('audio.subtitles.import', { filename: 'pricing.txt', text: subtitleText }),
    'audio-review': await lib.service.call('audio.corrections.review', { sourceId: 'talk-1' }),
    'audio-live-save': await lib.service.call('live.save', { id: CLASS, proofread: true }),
  };
  await lib.service.call('live.correct', { id: CLASS });
  await until(async () => (await lib.service.call('snapshot')).jobs.some(job => job.contract?.kind === 'audio-live-correction'), 'the correction job');
  const rows = (await lib.service.call('snapshot')).jobs.filter(job => job.contract?.contractVersion === 2);
  assert.deepEqual(rows.map(job => job.contract.kind).sort(), ['audio-batch', 'audio-import', 'audio-live-correction', 'audio-live-save', 'audio-review', 'audio-subtitles']);
  for (const row of rows) {
    const { capabilities, actions, kind } = row.contract;
    assert.equal(actions.cancel.available, capabilities.cancel, `${kind} (${row.contract.status}): cancel is offered exactly when declared`);
    if (capabilities.pauseMode === 'unsupported') assert.equal(actions.pause.available, false, `${kind}: no pause button without pause`);
    if (!capabilities.set) assert.equal(actions.set.available, false, `${kind}: no setting button without settings`);
    assert.equal(actions.retry.available, false, `${kind}: nothing to retry while it runs`);
  }
  for (const row of rows) await lib.service.call('job.control', { jobId: row.contract.jobId, action: 'cancel' }).catch(error => assert.fail(`${row.contract.kind}: ${error.message}`));
  for (const row of rows) assert.ok(['cancelled', 'failed'].includes((await settleJob(lib.service, row.id)).status), `${row.contract.kind} ended`);
  assert.ok(Object.keys(started).every(kind => rows.some(row => row.contract.kind === kind)));
});
