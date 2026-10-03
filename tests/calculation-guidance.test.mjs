import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { domainTool } from '../lib/runtime/tools.js';
import { readTeachingDraft, saveTeachingDraft } from '../ui/teaching-draft.js';

const quote = 'Distance equals speed multiplied by elapsed time.';
const stages = ['conditions', 'formula', 'substitution', 'computation', 'verification'];
const plan = () => ({ diagnosis: 'Units need attention', transfer: 'Use consistent units before multiplying.',
  rungs: stages.map((stage, i) => ({ stage, lesson: `Stage ${i} relationship`, check: `Current check ${i}?`, answer: `Hidden reference ${i}`,
    assumptions: 'Constant speed', units: 'metres and seconds', rounding: 'Keep exact values until the final result',
    citations: [{ sourceId: 'source', quote }] })) });
const genericPlan = { diagnosis: 'gap', transfer: 'Generic transfer', rungs: [0, 1].map(i => ({ lesson: `Generic ${i}`, check: 'Why?', answer: 'Hidden generic' })) };
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-calculation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, { complete: async () => JSON.stringify(plan()) });
  await service.store.update(s => {
    s.sources.push({ id: 'source', title: 'Motion', text: quote });
    s.decks.push({ id: 'deck', title: 'Motion', cards: [{ id: 'card', kind: 'flashcard', prompt: 'At 3 m/s for 4 s, how far?', answer: '12 m', citations: [{ sourceId: 'source', quote }] }] });
  });
  const run = await service.call('review.start', { deckId: 'deck', mode: 'flashcard' });
  await service.call('review.reveal', { runId: run.id, cardId: run.card.id });
  await service.call('review.answer', { runId: run.id, cardId: run.card.id, grade: 2 });
  return { service, root, run };
}

test('calculation stages expose only the current check and persist correction without advancement', async t => {
  const { service, root, run } = await setup(t);
  let input;
  service.complete = async (_system, prompt) => { input = JSON.parse(prompt); return JSON.stringify(plan()); };
  const current = await service.call('teach.start', { runId: run.id, mode: 'calculation', language: 'en' });
  assert.equal(current.mode, 'calculation');
  assert.equal(current.total, 5);
  assert.equal(current.stage, 'conditions');
  assert.equal(input.question.prompt, 'At 3 m/s for 4 s, how far?');
  assert.equal(input.sources[0].id, 'source');
  assert.equal(JSON.stringify(current).includes('Hidden'), false);
  assert.equal(JSON.stringify(current).includes('Current check 1'), false);
  assert.equal(current.transfer, undefined);
  service.complete = async (_system, prompt) => {
    const submitted = JSON.parse(prompt);
    assert.equal(JSON.stringify(submitted).includes('Hidden reference 1'), false);
    return JSON.stringify({ passed: false, feedback: 'Check the time unit.' });
  };
  const correction = await service.call('teach.answer', { id: current.id, answer: 'Wrong', stepIndex: 0 });
  assert.equal(correction.index, 0);
  assert.equal(correction.feedback, 'Check the time unit.');
  const restarted = new StudyService(root);
  assert.equal((await restarted.call('review.get', { runId: run.id })).teaching.feedback, correction.feedback);
  service.complete = async () => JSON.stringify({ passed: true, feedback: 'Proceed' });
  for (let stepIndex = 0; stepIndex < 5; stepIndex++) {
    const next = await service.call('teach.answer', { id: current.id, stepIndex, answer: 'Learner calculation' });
    assert.equal(next.index, stepIndex + 1);
    assert.equal(next.complete, stepIndex === 4);
    assert.equal(next.transfer !== undefined, stepIndex === 4);
  }
});

test('generic legacy sessions and separately cached calculation sessions reopen the selected mode', async t => {
  const { service, root, run } = await setup(t);
  service.complete = async () => JSON.stringify(genericPlan);
  const generic = await service.call('teach.start', { runId: run.id, cardId: run.card.id });
  await service.store.update(s => { delete s.teaching[0].mode; });
  service.complete = async () => JSON.stringify(plan());
  const calculation = await service.call('teach.start', { runId: run.id, mode: 'calculation' });
  assert.notEqual(calculation.id, generic.id);
  service.complete = async () => { throw new Error('Cache must avoid calls'); };
  assert.equal((await service.call('teach.start', { runId: run.id })).id, generic.id);
  assert.equal((await new StudyService(root).call('review.get', { runId: run.id })).teaching.id, generic.id);
  assert.equal((await service.call('teach.start', { runId: run.id, mode: 'calculation' })).id, calculation.id);
  assert.equal((await new StudyService(root).call('review.get', { runId: run.id })).teaching.id, calculation.id);
});

test('bad stages, fabricated citations and unknown modes leave no sessions', async t => {
  const { service, run } = await setup(t);
  await assert.rejects(service.call('teach.start', { runId: run.id, mode: 'other' }), /mode/i);
  service.complete = async () => JSON.stringify({ ...plan(), rungs: plan().rungs.slice(0, 4) });
  await assert.rejects(service.call('teach.start', { runId: run.id, mode: 'calculation' }), /plan/i);
  const fabricated = plan(); fabricated.rungs[0].citations[0].quote = 'fabricated';
  service.complete = async () => JSON.stringify(fabricated);
  await assert.rejects(service.call('teach.start', { runId: run.id, mode: 'calculation' }), /citation/i);
  assert.equal((await service.store.read()).teaching.length, 0);
});

test('late plan or answer cannot persist against a changed origin or step', async t => {
  const { service, run } = await setup(t);
  let release;
  const started = Promise.withResolvers();
  service.complete = async () => { started.resolve(); await new Promise(resolve => { release = resolve; }); return JSON.stringify(plan()); };
  const creating = service.call('teach.start', { runId: run.id, mode: 'calculation' });
  await started.promise;
  await service.store.update(s => { s.runs[0].entries[0].card.prompt = 'Changed original'; });
  release();
  await assert.rejects(creating, /changed|reload/i);
  assert.equal((await service.store.read()).teaching.length, 0);
  service.complete = async () => JSON.stringify(plan());
  const teaching = await service.call('teach.start', { runId: run.id, mode: 'calculation' });
  service.complete = async () => JSON.stringify({ passed: true, feedback: 'Good' });
  await service.call('teach.answer', { id: teaching.id, stepIndex: 0, answer: 'One' });
  await assert.rejects(service.call('teach.answer', { id: teaching.id, stepIndex: 0, answer: 'Stale input' }), /step changed/i);
  await service.store.update(s => { s.runs[0].entries[0].card.answer = 'New answer'; });
  await assert.rejects(service.call('teach.answer', { id: teaching.id, stepIndex: 1, answer: 'Two' }), /changed|reload/i);
});

test('the public practice tool accepts an explicit calculation mode and current-step answer', async t => {
  const { service, root, run } = await setup(t);
  const tool = domainTool('study', { resolveWorkspace: async () => root,
    requestServices: async () => service.modelOptions, forLibrary: () => service.runtime });
  assert.ok(tool.parameters.properties.operation.enum.includes('teach.start'));
  assert.equal(tool.parameters.properties.stepIndex.type, 'integer');
  const started = await tool.execute({ operation: 'teach.start', runId: run.id, mode: 'calculation' }, {});
  assert.equal(started.stage, 'conditions');
  service.complete = async () => JSON.stringify({ passed: false, feedback: 'Retry' });
  assert.equal((await tool.execute({ operation: 'teach.answer', id: started.id, stepIndex: 0, answer: 'Learner response' }, {})).index, 0);
});

test('concurrent starts share a session and a delayed answer cannot advance twice', async t => {
  const { service, run } = await setup(t);
  const starts = await Promise.all([0, 1].map(() => service.call('teach.start', { runId: run.id, mode: 'calculation' })));
  assert.equal(starts[0].id, starts[1].id);
  assert.equal((await service.store.read()).teaching.length, 1);
  const gate = Promise.withResolvers(); let calls = 0;
  service.complete = async () => { if (++calls === 2) gate.resolve(); await gate.promise; return JSON.stringify({ passed: true, feedback: 'Pass' }); };
  const checks = await Promise.allSettled([0, 1].map(() => service.call('teach.answer', { id: starts[0].id, stepIndex: 0, answer: 'Learner response' })));
  assert.equal(checks.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(checks.find(result => result.status === 'rejected').reason.message, /step changed/i);
  assert.equal((await service.call('teach.get', { id: starts[0].id })).index, 1);
});

test('draft storage isolates library, session and step, caps length and tolerates unavailable storage', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous); else delete globalThis.sessionStorage; });
  const items = new Map();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: key => items.get(key) || null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key),
  } });
  const session = { id: 'teaching', index: 1 };
  saveTeachingDraft('library', session, 'draft');
  assert.equal(readTeachingDraft('library', session), 'draft');
  assert.equal(readTeachingDraft('another-library', session), '');
  assert.equal(readTeachingDraft('library', { ...session, id: 'removed-session' }), '');
  assert.equal(readTeachingDraft('library', { ...session, index: 2 }), '');
  assert.equal(readTeachingDraft('library', null), '');
  saveTeachingDraft('library', session, 'a'.repeat(20000));
  assert.equal(readTeachingDraft('library', session).length, 10000);
  saveTeachingDraft('library', { ...session, complete: true }, 'draft');
  assert.equal(readTeachingDraft('library', session), '');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('Unavailable'); } });
  assert.equal(readTeachingDraft('library', session), '');
  assert.doesNotThrow(() => saveTeachingDraft('library', session, 'draft'));
});

test('unanswered origins and missing citations cannot start model work, and bad judgments do not advance', async t => {
  const { service, run } = await setup(t);
  const feedback = (await service.store.read()).runs[0].entries[0].feedback;
  let calls = 0;
  service.complete = async () => { calls++; return JSON.stringify(plan()); };
  await service.store.update(s => { delete s.runs[0].entries[0].feedback; });
  await assert.rejects(service.call('teach.start', { runId: run.id, mode: 'calculation' }), /Answer the original/);
  assert.equal(calls, 0);
  await service.store.update(s => { s.runs[0].entries[0].feedback = feedback; });
  await assert.rejects(service.call('teach.start', { runId: run.id, mode: 'calculation', queueVersion: 999 }), /changed/i);
  const started = await service.call('teach.start', { runId: run.id, mode: 'calculation' });
  service.complete = async () => JSON.stringify({ passed: 'true', feedback: 'Invalid' });
  await assert.rejects(service.call('teach.answer', { id: started.id, answer: 'Learner response' }), /judgment/i);
  assert.equal((await service.call('teach.get', { id: started.id })).index, 0);
  await service.store.update(s => { s.sources = []; });
  const before = calls;
  await service.store.update(s => { s.teaching = []; });
  await assert.rejects(service.call('teach.start', { runId: run.id, mode: 'calculation' }), /cited source/i);
  assert.equal(calls, before);
});

