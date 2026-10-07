import test from 'node:test';
import assert from 'node:assert/strict';
import { settleJob } from './helpers/wait.mjs';
import { managedRuntimeOptions } from './helpers/runtime-switch.mjs';
import { card, SCHEDULE, ONE_BY_ONE, evidence, other } from './helpers/supplement-fixtures.mjs';
import { gate, openLibrary, jobsOf, soon, stagedModel } from './helpers/generation-baseline.mjs';

/* S3-7, the generation family together: the five kinds of job of the family (question generation, a top-up of a deck, a supplement from a selected passage, the background repair of
   rejected cards, the publication of a draft) share one library with every generation switch on. One of them holds the model; the others wait their turn in the library's one queue. What
   is held to account here is what only the family together can break: nothing runs beside the one that has its turn, a stop only stops its own job, every model call is booked to the job
   that made it, and the tools and the snapshot tell the same story of every job. The models are fakes, and nothing leaves the machine. */

const PATHS = ['generation', 'generationRestart', 'generationRepair', 'generationPublish'];
const hostOf = (complete) => { const { starts: _starts, ...options } = managedRuntimeOptions({ complete, paths: PATHS }); return options; };
const passage = "Architecture includes the principles guiding a system's design and evolution.";
const base = (id, n) => ({ ...card(id, 'p1'), objective: `Explain principle ${n}`, prompt: `What guides design question ${n}?` });

async function family(t) {
  const hold = gate(), staged = stagedModel({ holdAt: 'plan', hold }), repairs = [];
  const complete = async (system, prompt, context = {}) => {
    if (system.startsWith('Repair one draft card')) { repairs.push(JSON.parse(prompt).card.id); const input = JSON.parse(prompt); return JSON.stringify({ card: { ...input.card, explanation: `Fixed: ${input.card.explanation}` } }); }
    return staged.complete(system, prompt, context);
  };
  const { service } = await openLibrary(t, { prefix: 'study-s37-', model: complete, options: hostOf(complete), hold });
  await service.call('source.add', { id: 'p1', title: 'Page 1', text: evidence, courses: ['A'] });
  await service.call('source.add', { id: 'p2', title: 'Page 2', text: other, courses: ['A'] });
  await service.store.update(state => { state.decks.push({ id: 't', title: 'Target', course: 'A', cards: [{ ...card('old'), review: SCHEDULE }], createdAt: '2026-09-29T00:00:00.000Z' }); });
  const publishable = await service.call('draft.save', { deck: { id: 'd', title: 'Architecture', cards: [base('a', 1), base('b', 2)], course: 'A' } });
  const repairable = await service.call('draft.save', { deck: { id: 'r', title: 'Repairs', cards: [base('ra', 3), base('rb', 4)], course: 'A',
    editorial: { generation: { sourceIds: ['p1'], kind: 'flashcard' }, rejectedIssues: { ra: ['explanationQuality failed'], rb: ['explanationQuality failed'] } } } });
  const imported = await service.call('materials.document.import', { filename: 'notes.md', dataBase64: Buffer.from(`# Notes\n\n${passage}`).toString('base64') });
  const selection = (await service.call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: passage })).selection;
  return { service, hold, staged, repairs, publishable, repairable, selection };
}
const rowOf = async (service, jobId) => (await jobsOf(service)).find(job => job.id === jobId);
const intervals = contract => contract.calls.filter(call => call.startedAt && call.endedAt).map(call => [Date.parse(call.startedAt), Date.parse(call.endedAt)]);

test('five kinds of job in one library: one at a time in the order they were accepted, a stop only stops its own job, every call is booked to its own job', async t => {
  const { service, hold, staged, repairs, publishable, repairable, selection } = await family(t);
  const head = await service.call('generate', { sourceIds: ['p2'], count: 1, kind: 'flashcard', performance: ONE_BY_ONE });
  await soon(() => hold.entered, 'the first job to be at the model');
  const top = await service.call('supplement', { sourceIds: ['p1'], deckId: 't', count: 1, kind: 'flashcard', performance: ONE_BY_ONE });
  const passageJob = await service.call('generation.selection.start', { selection, deckId: 't', expectedVersion: 0, count: 1, kind: 'flashcard', operationId: 'op-1' });
  const repair = await service.call('draft.repair', { id: 'r', draftVersion: repairable.draftVersion });
  const publication = await service.call('draft.publish.start', { id: 'd', draftVersion: publishable.draftVersion, mergeTargetId: 't' });
  const accepted = [head, top, passageJob, repair, publication];
  assert.deepEqual(accepted.slice(1).map(job => job.status), ['queued', 'queued', 'queued', 'queued'], 'everything behind the head waits');
  const kinds = await Promise.all(accepted.map(async job => (await rowOf(service, job.jobId)).contract.kind));
  assert.deepEqual(kinds, ['generation', 'supplement', 'supplement', 'draft-repair', 'draft-publish']);
  assert.deepEqual(staged.log, ['plan'], 'only the head has asked a model: nothing runs beside it');

  // A stop is for the job it names: the repair is stopped while it waits, and nothing about the others changes.
  await service.call('job.cancel', { jobId: repair.jobId });
  hold.open();
  const ended = [];
  for (const job of accepted) ended.push(await settleJob(service, job.jobId));
  assert.deepEqual(ended.map(job => job.status), ['complete', 'complete', 'complete', 'cancelled', 'complete']);
  assert.deepEqual(repairs, [], 'the stopped repair never asked a model');
  const state = await service.call('export');
  assert.deepEqual(state.drafts.find(draft => draft.id === 'r').editorial.rejectedIssues, { ra: ['explanationQuality failed'], rb: ['explanationQuality failed'] }, 'its draft is as it was');
  assert.ok(!state.drafts.some(draft => draft.id === 'd'), 'the publication went through');
  assert.equal(state.decks.find(deck => deck.id === 't').cards.length, 5, 'the original card, one from the supplement, one from the passage and the two of the publication: no more, no less');

  // One job has the library at a time: no call of one job overlaps a call of another, and every call is the job's own.
  const contracts = [];
  for (const job of accepted) contracts.push((await rowOf(service, job.jobId)).contract);
  const spans = contracts.flatMap((contract, index) => intervals(contract).map(span => ({ span, index })));
  for (const a of spans) for (const b of spans) if (a.index < b.index) assert.ok(a.span[1] <= b.span[0] || b.span[1] <= a.span[0], `a call of job ${a.index} overlaps one of job ${b.index}`);
  for (const contract of contracts) assert.ok(contract.calls.every(call => call.jobId === contract.jobId), 'every call is booked to the job that made it');
  assert.ok(contracts[1].calls.length > 0 && contracts[2].calls.length > 0 && contracts[4].calls.length > 0 && contracts[3].calls.length === 0);
  assert.deepEqual(contracts.map(contract => contract.status), ['complete', 'complete', 'complete', 'cancelled', 'complete']);
});

test('the tool and the snapshot tell the same story of every job of the family: the same job and state, one stage text, usage counted from the calls', async t => {
  const { service, hold, publishable, repairable, selection } = await family(t);
  hold.open();
  const started = [];
  started.push(await service.call('generate', { sourceIds: ['p2'], count: 1, kind: 'flashcard', performance: ONE_BY_ONE }));
  started.push(await service.call('supplement', { sourceIds: ['p1'], deckId: 't', count: 1, kind: 'flashcard', performance: ONE_BY_ONE }));
  started.push(await service.call('generation.selection.start', { selection, deckId: 't', expectedVersion: 0, count: 1, kind: 'flashcard', operationId: 'op-1' }));
  started.push(await service.call('draft.repair', { id: 'r', draftVersion: repairable.draftVersion }));
  started.push(await service.call('draft.publish.start', { id: 'd', draftVersion: publishable.draftVersion, mergeTargetId: 't' }));
  for (const job of started) assert.equal((await settleJob(service, job.jobId)).status, 'complete');
  for (const job of started) {
    const row = await rowOf(service, job.jobId), tool = await service.call('job.status', { jobId: job.jobId }), { contract } = row;
    assert.deepEqual([tool.id, tool.status, tool.finished], [row.id, row.status, true], `${contract.kind}: the tool and the snapshot name the same job and state`);
    assert.equal(tool.stage, row.stage, `${contract.kind}: one stage text`);
    assert.equal(contract.usage.calls, contract.calls.length, `${contract.kind}: usage is counted from the calls`);
    assert.ok(contract.calls.length > 0 && contract.calls.every(call => call.observation.boundary === 'host-attempt'), `${contract.kind}: every call went through the gateway`);
    assert.equal(contract.capabilities.pauseMode, 'unsupported', `${contract.kind}: no pause, and it says so`);
  }
});
