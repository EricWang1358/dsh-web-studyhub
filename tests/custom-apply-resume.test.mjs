/* 深度定制 (4.4 S3 gate follow-ups): what apply does about a run that stopped after its first round (sample first, or a lean strength that does not go on by itself), the same
   run asked twice at once, a chapter that could not be cut, and a weekly plan limited to the plan's chapters. The decisions are asked of applyCustom with a spy for `call` over
   a real library: the question is which call it makes, not what a model writes. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCustom } from '../lib/custom-apply.js';
import { courseSkeleton } from '../lib/custom-skeleton.js';
import { scopeUnits } from '../lib/custom-sources.js';
import { groupRevision } from '../lib/document-outline.js';
import { COURSE, lecture, open, plan, save, steps } from './helpers/custom-apply-world.mjs';

/** A library with a plan of the first chapter of lecture 3 (quiz), and a draft a run left behind for exactly its pages. */
async function world(t, { sampleFirst = false, strength = 'standard', runState = 'waiting' } = {}) {
  const study = await open(t), state = await study.store.read(), skeleton = courseSkeleton(state, COURSE), doc = lecture(skeleton, 3);
  const scope = { kind: 'chapters', chapters: [doc.chapters[0].id] };
  await save(study, plan({ scope, sampleFirst, questions: { make: true, kinds: ['quiz'], strength, variants: false } }));
  const ids = scopeUnits(state, COURSE, skeleton, scope).units.flatMap(unit => unit.sourceIds);
  const draft = { id: 'draft-1', draftVersion: 3, title: 'chapter', cards: [], editorial: { generation: { sourceIds: ids, kind: 'quiz', kinds: ['quiz'] }, coverageRun: { state: runState, autoComplete: false } } };
  const withDraft = async () => ({ ...(await study.store.read()), drafts: [draft] });
  const calls = [], call = async (name, args) => { calls.push([name, args]); return { jobId: `job-${calls.length}` }; };
  const run = async (args = {}, state2 = null) => applyCustom({ state: state2 ?? await withDraft(), call, jobs: () => [], activeJob: () => false }, { course: COURSE, ...args });
  return { study, calls, run, draft, withDraft };
}

test('a run that stopped after its first round is resumed to the end, not counted as made', async t => {
  const { calls, run } = await world(t, { sampleFirst: true });
  const answer = await run({ confirm: true });
  const [name, args] = calls[0];
  assert.equal(name, 'generate');
  assert.deepEqual([args.resumeDraftId, args.draftVersion, args.coverage], ['draft-1', 3, { run: true, autoComplete: true }]);
  assert.equal(steps(answer, 'started', 'questions').length, 1, 'said under started');
  assert.match(steps(answer, 'started', 'questions')[0].what, /接着/);
  assert.deepEqual(steps(answer, 'done', 'questions'), [], 'not under done');
});

test('a paused run is resumed too; a complete one is made, and the sample (not yet confirmed) is left as it is', async t => {
  const paused = await world(t, { runState: 'paused' });
  await paused.run();
  assert.equal(paused.calls[0][1].resumeDraftId, 'draft-1');
  const complete = await world(t, { runState: 'complete' });
  const done = await complete.run();
  assert.deepEqual(complete.calls, []);
  assert.equal(steps(done, 'done', 'questions').length, 1);
  const sample = await world(t, { sampleFirst: true });
  await sample.run();
  assert.deepEqual(sample.calls, [], 'before the learner says 「做完」 the sample stays a sample');
});

test('a chapter that could not be cut out of its material is named under recorded', async t => {
  const HASH = 'c'.repeat(64);
  const pages = Array.from({ length: 6 }, (_, index) => ({ id: `os-p${index + 1}`, title: `Notes · p.${index + 1}`, text: `Page ${index + 1} text. `.repeat(8), createdAt: '2026-10-01T08:00:00.000Z',
    courses: ['OS'], document: { id: HASH, page: index + 1, totalPages: 6, format: 'pdf', extractionVersion: 2, materialId: `document-${HASH}-pdf` } }));
  const entry = (title, level, sourceId, offset = 0) => ({ title, level, startBlock: 0, kind: 'quoted', anchor: { sourceId, offset, quote: 'x', ordinal: 0 } });
  pages[0].outline = { revision: groupRevision(pages), savedAt: '2026-10-01T09:00:00.000Z', segmentation: { level: 2 },
    entries: [entry('Basics', 1, 'os-p1'), entry('Memory', 1, 'os-p3'), entry('Paging', 2, 'os-p5', 40), entry('Wrap-up', 1, 'os-p6')] };
  const study = await open(t, { library: { sources: pages, decks: [] }, course: 'OS' }), [doc] = courseSkeleton(await study.store.read(), 'OS').documents;
  const byTitle = Object.fromEntries(doc.chapters.map(chapter => [chapter.title, chapter.id]));
  await save(study, plan({ scope: { kind: 'chapters', chapters: [byTitle.Basics, byTitle.Memory] }, questions: { make: true, kinds: ['quiz'], strength: 'lean', variants: false } }), 'OS');
  const answer = await study.call('course.custom.apply', { course: 'OS' });
  const [note] = steps(answer, 'recorded', 'questions');
  assert.match(note.what, /Memory/);
  assert.doesNotMatch(note.what, /Basics/, 'only the chapter that was not cut');
});

test('a run that is not a sample goes on by itself, whatever the strength: autoComplete is asked for', async t => {
  const { calls, run, study } = await world(t, { strength: 'lean' });
  const answer = await run({}, await study.store.read());
  assert.equal(calls[0][1].autoComplete, true, 'lean does not go on by itself unless it is asked');
  assert.equal(steps(answer, 'started', 'questions').length, 1);
  const sample = await world(t, { sampleFirst: true });
  await sample.run({}, await sample.study.store.read());
  assert.equal(sample.calls[0][1].autoComplete, false, 'the sample is its first round only');
});
