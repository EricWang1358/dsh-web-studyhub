/* The three read-only assists of the generation context, pinned from the outside (issue #608): generate.weakTopics, generate.suggest and generate.path.suggest,
   called the way the UI calls them, with a recording light model. What is pinned is every prompt the model is sent, in order and byte for byte (the order and the bytes are what a
   cache hit and the token bill rest on), and every answer, its key order included. tests/fixtures/generation-suggest-golden.json was recorded from the code before these assists
   were split into pure functions and must not move with a refactoring; a deliberate change of a prompt re-records it (STUDY_RECORD_GOLDEN=1) and the diff of the file is the review. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';

const FIXTURE = new URL('./fixtures/generation-suggest-golden.json', import.meta.url);
const recording = process.env.STUDY_RECORD_GOLDEN === '1';
const golden = recording ? {} : JSON.parse(await readFile(FIXTURE, 'utf8'));
if (recording) after(() => writeFile(FIXTURE, `${JSON.stringify(Object.fromEntries(Object.entries(golden).sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`));

function pinned(name, actual) {
  const value = JSON.parse(JSON.stringify(actual));
  if (recording) { golden[name] = value; return; }
  assert.ok(Object.hasOwn(golden, name), `no recording for "${name}"`);
  assert.deepEqual(value, golden[name], name);
  assert.equal(JSON.stringify(value), JSON.stringify(golden[name]), `${name}: same keys in the same order`);
}

const BODY = 'This body sentence must never be sent to the model because only titles and headings are allowed here.';
const NOTES = ['# Distributed systems', BODY, '## Consensus and Raft', BODY, '1.2 Replication strategies', BODY, '第三章 一致性模型', BODY].join('\n');
const card = (id, topic) => ({ id, kind: 'flashcard', topic, prompt: `${id}?`, answer: 'a' });

/** A library with materials, a stated exam and weak topics; `answers` are what the light model says in turn (the last one repeats): text, an Error to throw, or a function. */
async function library(t, { answers, language } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-suggest-golden-'));
  const calls = [], signals = [];
  const light = answers ? async (system, prompt, options) => {
    calls.push({ system, prompt });
    signals.push(options?.signal);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (typeof answer === 'function') return answer();
    if (answer instanceof Error) throw answer;
    return answer;
  } : undefined;
  const service = new StudyService(root, { ...(light ? { light } : {}), ...(language ? { language } : {}) });
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const a = await service.call('source.add', { title: 'Distributed notes', text: NOTES, courses: ['SWE5001'] });
  const b = await service.call('source.add', { title: 'Cloud storage', text: `# Object storage\n${BODY}`, courses: ['SWE5001'] });
  await service.call('course.save', { name: 'SWE5001', focusTopics: ['Consensus'], exam: { format: 'open-book-case', totalMarks: 60, sections: [{ title: 'Case study', marks: 40, topics: ['Trade-offs'] }] } });
  await service.store.update((s) => {
    s.sources.push({ id: 'list', title: 'A list of exam points', text: '# Must never be listed', provenance: 'exam-blueprint', blueprint: { points: [] }, courses: ['SWE5001'] });
    s.decks.push({ id: 'd1', title: 'Deck', course: 'SWE5001', cards: [card('c1', 'Raft elections'), card('c2', 'Raft elections'), card('c3', 'Sharding'), card('c4', 'Caching')] },
      { id: 'd2', title: 'Other course', course: 'OTHER', cards: [card('o1', 'Unrelated weak topic')] });
    for (const [deckId, quiz_id, grade] of [['d1', 'c1', 1], ['d1', 'c2', 2], ['d1', 'c3', 1], ['d1', 'c4', 5], ['d2', 'o1', 1]])
      s.attempts.push({ deckId, quiz_id, assessment: 'self', grade, timestamp: '2026-01-01T00:00:00.000Z' });
  });
  return { service, calls, signals, ids: [a.id, b.id, 'list'] };
}
const failure = (run) => run.then(() => assert.fail('it should refuse'), (error) => ({ refused: error.message }));
const GOOD = JSON.stringify({ focus: ['Raft vs Paxos', 'Replication'], coverage: 'standard', difficulty: 'application', kind: 'mixed', why: 'Weak on Raft.' });
const PATH_STEPS = [{ id: 'step-1', title: '第 1 章 引言', pages: 10, chars: 80_000 }, { id: 'step-2', title: '第 2 章 进程', pages: 20, chars: 120_000 }];
const PATH_GOOD = JSON.stringify({ steps: [{ id: 'step-2', title: '先学进程', focus: '概念辨析', count: 12, reason: '后面依赖它' }, { id: 'step-1', title: '再看引言', count: 6 }] });

/* ---------- generate.weakTopics ---------- */

test('generate.weakTopics: the course, every course, and a course argument that is not one', async (t) => {
  const { service } = await library(t);
  pinned('weakTopics.course', await service.call('generate.weakTopics', { course: 'SWE5001' }));
  pinned('weakTopics.none', await service.call('generate.weakTopics', {}));
  pinned('weakTopics.notAString', await service.call('generate.weakTopics', { course: 42 }));
});

/* ---------- generate.suggest ---------- */

for (const language of ['zh', 'en']) test(`generate.suggest: one call, its prompts and answer in ${language}`, async (t) => {
  const { service, calls, ids } = await library(t, { answers: [GOOD], language });
  const output = await service.call('generate.suggest', { sourceIds: ids, course: 'SWE5001', goal: 'exam' });
  pinned(`suggest.model.${language}`, { calls, output });
});

test('generate.suggest: an answer it cannot read gets one retry, then the sample says what it looked like', async (t) => {
  const retried = await library(t, { answers: ['not json at all', GOOD] });
  pinned('suggest.retry', { calls: retried.calls, output: await retried.service.call('generate.suggest', { sourceIds: retried.ids, course: 'SWE5001' }) });
  const noisy = `  a   reply\n\nwith   ${'x'.repeat(400)}  `;
  const unusable = await library(t, { answers: [noisy] });
  pinned('suggest.unusable', { calls: unusable.calls, output: await unusable.service.call('generate.suggest', { sourceIds: unusable.ids, course: 'SWE5001' }) });
});

test('generate.suggest: a failing model leaves the local answer and a clipped message', async (t) => {
  const long = await library(t, { answers: [new Error(`refused ${'y'.repeat(500)}`)] });
  pinned('suggest.failed', { calls: long.calls, output: await long.service.call('generate.suggest', { sourceIds: long.ids, course: 'SWE5001' }) });
  const odd = await library(t, { answers: [() => { throw 'a plain string'; }] });
  pinned('suggest.failed.string', await odd.service.call('generate.suggest', { sourceIds: odd.ids }));
});

test('generate.suggest: the time limit is one limit over both tries', async (t) => {
  const { service, calls, signals, ids } = await library(t, { answers: [() => new Promise(() => {})] });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const answer = service.call('generate.suggest', { sourceIds: ids, course: 'SWE5001' });
  while (!calls.length) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(44_999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signals[0].aborted, false);
  t.mock.timers.tick(1);
  pinned('suggest.timeout', { calls: calls.length, output: await answer });
  assert.equal(signals[0].aborted, true, 'past the limit the call is told to stop: it would otherwise spend tokens nobody reads');
  t.mock.timers.reset();
});

test('generate.suggest: what it refuses, what it says with no model or no signal, and what it may see', async (t) => {
  const none = await library(t);
  pinned('suggest.notAList', await failure(none.service.call('generate.suggest', { sourceIds: 'nope' })));
  pinned('suggest.noModel', await none.service.call('generate.suggest', { sourceIds: none.ids, course: 'SWE5001' }));
  const quiet = await library(t, { answers: [GOOD] });
  await quiet.service.store.update((s) => { s.attempts = []; });
  pinned('suggest.noSignal', { calls: quiet.calls, output: await quiet.service.call('generate.suggest', { sourceIds: [], course: 'SWE5001' }) });
  const fenced = await library(t, { answers: [`Sure!\n\`\`\`json\n${GOOD}\n\`\`\``] });
  // A goal it does not know, an unregistered course, and ids that are not strings; the 501st id is past the cap, so that material is not seen.
  const beyond = [...Array.from({ length: 500 }, (_, index) => `missing-${index}`), fenced.ids[0]];
  pinned('suggest.bounds', { calls: fenced.calls, output: await fenced.service.call('generate.suggest', { sourceIds: [fenced.ids[1], 7, null], course: 'Nobody', goal: 'world domination' }),
    capped: await fenced.service.call('generate.suggest', { sourceIds: beyond }) });
});

/* ---------- generate.path.suggest ---------- */

for (const language of ['zh', 'en']) test(`generate.path.suggest: one call, its prompts and answer in ${language}`, async (t) => {
  const { service, calls } = await library(t, { answers: [PATH_GOOD], language });
  const output = await service.call('generate.path.suggest', { steps: PATH_STEPS, course: 'OS', goal: 'exam' });
  pinned(`path.model.${language}`, { calls, output });
});

test('generate.path.suggest: an answer without the ids gets one retry naming them, then the sample says what it looked like', async (t) => {
  const retried = await library(t, { answers: ['{"note":"here you go"}', PATH_GOOD] });
  pinned('path.retry', { calls: retried.calls, output: await retried.service.call('generate.path.suggest', { steps: PATH_STEPS }) });
  const unusable = await library(t, { answers: [JSON.stringify({ note: 'z'.repeat(400) })] });
  pinned('path.unusable', { calls: unusable.calls, output: await unusable.service.call('generate.path.suggest', { steps: PATH_STEPS }) });
  const nothing = await library(t, { answers: ['null'] });
  pinned('path.nullReply', await nothing.service.call('generate.path.suggest', { steps: PATH_STEPS }));
});

test('generate.path.suggest: text that is not JSON gets the corrective prompt first, and a failing model a clipped message', async (t) => {
  const prose = await library(t, { answers: ['I cannot help with that'] });
  pinned('path.notJson', { calls: prose.calls, output: await prose.service.call('generate.path.suggest', { steps: PATH_STEPS }) });
  const corrected = await library(t, { answers: ['I cannot help with that', PATH_GOOD] });
  pinned('path.corrected', { calls: corrected.calls, output: await corrected.service.call('generate.path.suggest', { steps: PATH_STEPS }) });
  const failing = await library(t, { answers: [new Error(`refused ${'y'.repeat(500)}`)] });
  pinned('path.failed', { calls: failing.calls, output: await failing.service.call('generate.path.suggest', { steps: PATH_STEPS }) });
});

test('generate.path.suggest: the time limit', async (t) => {
  const { service, calls, signals } = await library(t, { answers: [() => new Promise(() => {})] });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const answer = service.call('generate.path.suggest', { steps: PATH_STEPS });
  while (!calls.length) await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(45_000);
  pinned('path.timeout', { calls: calls.length, output: await answer });
  assert.equal(signals[0].aborted, true, 'past the limit the call is told to stop');
  t.mock.timers.reset();
});

test('generate.path.suggest: what it refuses, what it says with nothing to ask, and how the steps it sends are bounded', async (t) => {
  const none = await library(t);
  pinned('path.notAList', await failure(none.service.call('generate.path.suggest', { steps: 'nope' })));
  pinned('path.noArgs', await failure(none.service.call('generate.path.suggest')));
  pinned('path.noModel', await none.service.call('generate.path.suggest', { steps: PATH_STEPS }));
  pinned('path.noSteps', await none.service.call('generate.path.suggest', { steps: [null, { id: 7 }, {}] }));
  const { service, calls } = await library(t, { answers: ['{"steps":[]}'] });
  const steps = [
    { id: `  step\n1 ${'i'.repeat(60)}`, title: `  a\t\ttitle ${'T'.repeat(200)}`, pages: 3.6, chars: '41.5', text: 'SECRET BODY TEXT' },
    { id: 'no-numbers', title: null, pages: -2, chars: 'many' },
    null, { id: 9 },
    ...Array.from({ length: 60 }, (_, index) => ({ id: `step-${index}`, title: `Chapter ${index}`, pages: 1, chars: 1000 })),
  ];
  const output = await service.call('generate.path.suggest', { steps, course: `  OS\n${'c'.repeat(200)}`, goal: 'world domination' });
  pinned('path.bounds', { calls, output });
  const other = await library(t, { answers: [PATH_GOOD] });
  pinned('path.courseNotAString', { calls: other.calls, output: await other.service.call('generate.path.suggest', { steps: PATH_STEPS, course: 42, goal: 'work' }) });
});
