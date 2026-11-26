import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { domainTool } from '../lib/runtime/tools.js';
import { NON_CONTENT_CARD_FIELDS } from '../lib/card-content.js';
import { readTeachingDraft, saveTeachingDraft } from '../ui/teaching-draft.js';

import { calculationPlan as plan, calculationQuote as quote, setupCalculation as setup } from './helpers/calculation-session.mjs';

const genericPlan = { diagnosis: 'gap', transfer: 'Generic transfer', rungs: [0, 1].map(i => ({ lesson: `Generic ${i}`, check: 'Why?', answer: 'Hidden generic' })) };

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
  await assert.rejects(service.call('teach.start', { runId: run.id, mode: 'other' }), /不支持的引导练习模式/);
  service.complete = async () => JSON.stringify({ ...plan(), rungs: plan().rungs.slice(0, 4) });
  await assert.rejects(service.call('teach.start', { runId: run.id, mode: 'calculation' }), /引导步骤不完整/);
  const fabricated = plan(); fabricated.rungs[0].citations[0].quote = 'fabricated';
  service.complete = async () => JSON.stringify(fabricated);
  await assert.rejects(service.call('teach.start', { runId: run.id, mode: 'calculation' }), /资料原文与教材对不上/);
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
  await assert.rejects(creating, /原题内容已修改/);
  assert.equal((await service.store.read()).teaching.length, 0);
  service.complete = async () => JSON.stringify(plan());
  const teaching = await service.call('teach.start', { runId: run.id, mode: 'calculation' });
  service.complete = async () => JSON.stringify({ passed: true, feedback: 'Good' });
  await service.call('teach.answer', { id: teaching.id, stepIndex: 0, answer: 'One' });
  await assert.rejects(service.call('teach.answer', { id: teaching.id, stepIndex: 0, answer: 'Stale input' }), /引导步骤已变化/);
  await service.store.update(s => { s.runs[0].entries[0].card.answer = 'New answer'; });
  await assert.rejects(service.call('teach.answer', { id: teaching.id, stepIndex: 1, answer: 'Two' }), /原题内容已修改/);
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
  assert.match(checks.find(result => result.status === 'rejected').reason.message, /引导步骤已变化/);
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
  await assert.rejects(service.call('teach.start', { runId: run.id, mode: 'calculation' }), /请先作答原题/);
  assert.equal(calls, 0);
  await service.store.update(s => { s.runs[0].entries[0].feedback = feedback; });
  await assert.rejects(service.call('teach.start', { runId: run.id, mode: 'calculation', queueVersion: 999 }), /本轮练习已变化/);
  const started = await service.call('teach.start', { runId: run.id, mode: 'calculation' });
  service.complete = async () => JSON.stringify({ passed: 'true', feedback: 'Invalid' });
  await assert.rejects(service.call('teach.answer', { id: started.id, answer: 'Learner response' }), /批改结果格式有误/);
  assert.equal((await service.call('teach.get', { id: started.id })).index, 0);
  await service.store.update(s => { s.sources = []; });
  const before = calls;
  await service.store.update(s => { s.teaching = []; });
  await assert.rejects(service.call('teach.start', { runId: run.id, mode: 'calculation' }), /没有引用资料/);
  assert.equal(calls, before);
});

/* ---------- #1240: non-content records during guided teaching ---------- */

const quizSource = {
  id: 's-quiz',
  title: '线性代数讲义',
  text: '正交矩阵的逆等于它的转置，实对称矩阵可以通过谱定理正交对角化。',
};
const quizCard = () => ({
  id: 'q-teach',
  kind: 'quiz',
  topic: '谱定理',
  objective: '理解实对称矩阵的正交对角化条件',
  prompt: '实对称矩阵为什么总能正交对角化？',
  answer: '谱定理保证存在标准正交特征基。',
  hint: '回忆谱定理的结论。',
  explanation: '正交矩阵的转置等于它的逆，谱定理保证不同特征向量可取标准正交基。',
  misconception: '以为任意实矩阵都能正交对角化。',
  citations: [{ sourceId: 's-quiz', quote: quizSource.text }],
  options: [
    { id: 'a', text: '谱定理保证存在标准正交特征基', correct: true, explanation: '谱定理直接给出正交对角化。' },
    { id: 'b', text: '行列式恒为零', correct: false, explanation: '对称矩阵行列式不必为零。' },
    { id: 'c', text: '矩阵不可逆', correct: false, explanation: '可逆与否不影响正交对角化。' },
  ],
});
const quizTranslation = {
  prompt: 'Why can every real symmetric matrix be orthogonally diagonalized?',
  answer: 'The spectral theorem guarantees an orthonormal eigenbasis.',
  explanation: 'An orthogonal matrix has its transpose as its inverse, and the spectral theorem yields an orthonormal basis.',
  options: [
    { id: 'a', text: 'The spectral theorem guarantees an orthonormal eigenbasis', explanation: 'Direct consequence of the spectral theorem.' },
    { id: 'b', text: 'The determinant is always zero', explanation: 'A symmetric matrix need not be singular.' },
    { id: 'c', text: 'The matrix is not invertible', explanation: 'Invertibility is not required.' },
  ],
};

async function setupQuizTeaching(t, { complete, completeLight } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-teach-meta-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new StudyService(root, {
    complete: complete || (async () => JSON.stringify(genericPlan)),
    completeLight: completeLight || (async (_system, _prompt, options) => {
      if (options?.task === 'card.translate') return JSON.stringify(quizTranslation);
      return JSON.stringify({ terms: ['谱定理', '正交矩阵'] });
    }),
  });
  await service.call('source.add', quizSource);
  const saved = await service.call('draft.save', { deck: { id: 'd-teach', title: '谱定理', cards: [quizCard()] } });
  await service.call('draft.publish.quick', { id: saved.id, draftVersion: saved.draftVersion });
  const run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd-teach', cardId: 'q-teach' }] });
  await service.call('review.answer', { runId: run.id, cardId: 'q-teach', selected: ['b'] });
  return { service, run };
}

test('#1240: card.terms, card.followup.add and card.translate after teach.start do not break teach.answer', async t => {
  for (const kind of ['terms', 'followup', 'translate']) {
    const { service, run } = await setupQuizTeaching(t);
    const session = await service.call('teach.start', { runId: run.id });
    if (kind === 'terms') {
      await service.call('card.terms', { deckId: 'd-teach', cardId: 'q-teach' });
    } else if (kind === 'followup') {
      await service.call('card.followup.add', { deckId: 'd-teach', cardId: 'q-teach', question: '什么是标准正交基？', answer: '两两正交且模长为 1 的基向量。' });
    } else {
      await service.call('card.translate', { deckId: 'd-teach', cardId: 'q-teach' });
    }
    const refreshed = await service.call('review.get', { runId: run.id });
    if (kind === 'terms') assert.deepEqual(refreshed.solution.terms, ['谱定理', '正交矩阵']);
    if (kind === 'followup') assert.equal(refreshed.followups.length, 1);
    if (kind === 'translate') assert.equal(refreshed.card.translation.prompt, quizTranslation.prompt);

    service.complete = async () => JSON.stringify({ passed: true, feedback: '答对了，继续下一步。' });
    const next = await service.call('teach.answer', { id: session.id, stepIndex: 0, answer: '谱定理保证正交基' });
    assert.equal(next.index, 1, `teach.answer succeeds after ${kind}`);
  }
});

test('#1240: card.terms landing mid-flight during teach.start does not abort or call the main model twice', async t => {
  let completeCalls = 0;
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  const { service, run } = await setupQuizTeaching(t, {
    complete: async () => {
      completeCalls++;
      started.resolve();
      await gate.promise;
      return JSON.stringify(genericPlan);
    },
  });
  const pending = service.call('teach.start', { runId: run.id });
  await started.promise;
  await service.call('card.terms', { deckId: 'd-teach', cardId: 'q-teach' });
  await service.call('review.get', { runId: run.id });
  // Also simulate an entry.card copy already carrying the non-content terms record before commit.
  await service.store.update(s => {
    const live = s.decks[0].cards[0];
    s.runs[0].entries[0].card.terms = structuredClone(live.terms);
  });
  gate.resolve();
  const session = await pending;
  assert.equal(session.index, 0);
  assert.equal(completeCalls, 1, 'main model called exactly once');
  service.complete = async () => JSON.stringify({ passed: true, feedback: '很好' });
  const advanced = await service.call('teach.answer', { id: session.id, stepIndex: 0, answer: '理解了' });
  assert.equal(advanced.index, 1);
});

test('#1240: card.update changing the answer after teach.start still throws original-question-changed', async t => {
  const { service, run } = await setupQuizTeaching(t);
  const session = await service.call('teach.start', { runId: run.id });
  await service.call('card.update', {
    deckId: 'd-teach',
    cardId: 'q-teach',
    patch: { answer: '因为实对称矩阵满足谱定理，存在正交矩阵将其对角化。' },
    reason: 'refine answer',
  });
  await service.call('review.get', { runId: run.id });
  service.complete = async () => JSON.stringify({ passed: true, feedback: 'ok' });
  await assert.rejects(
    service.call('teach.answer', { id: session.id, stepIndex: 0, answer: '我的回答' }),
    /原题内容已修改/,
  );
});

test('#1240: pre-upgrade sessions with legacy origin_snapshot continue when question is unchanged', async t => {
  const { service, run } = await setupQuizTeaching(t);
  const session = await service.call('teach.start', { runId: run.id });
  await service.store.update(s => {
    const legacyDigest = createHash('sha256').update(JSON.stringify(s.runs[0].entries[0].card)).digest('hex');
    s.teaching[0].origin_snapshot = legacyDigest;
  });
  // Cached reopen accepts the legacy digest without invoking the model.
  service.complete = async () => { throw new Error('Cache must reuse legacy session'); };
  const reopened = await service.call('teach.start', { runId: run.id });
  assert.equal(reopened.id, session.id);

  // Answering the step also succeeds with the legacy digest.
  service.complete = async () => JSON.stringify({ passed: true, feedback: '继续' });
  const advanced = await service.call('teach.answer', { id: session.id, stepIndex: 0, answer: '正交基' });
  assert.equal(advanced.index, 1);

  // A real question edit still invalidates a legacy-snapshot session.
  await service.call('card.update', {
    deckId: 'd-teach',
    cardId: 'q-teach',
    patch: { answer: '修改后的参考答案' },
    reason: 'change answer',
  });
  await assert.rejects(
    service.call('teach.answer', { id: session.id, stepIndex: 1, answer: '继续' }),
    /原题内容已修改/,
  );
});

test('#1240: teach.start sends stripped question content without terms, translation, followups or other non-content fields', async t => {
  let capturedPrompt = null;
  const { service } = await setupQuizTeaching(t, {
    complete: async (_system, prompt) => {
      capturedPrompt = JSON.parse(prompt);
      return JSON.stringify(genericPlan);
    },
  });
  await service.call('card.terms', { deckId: 'd-teach', cardId: 'q-teach' });
  await service.call('card.translate', { deckId: 'd-teach', cardId: 'q-teach' });
  await service.call('card.followup.add', { deckId: 'd-teach', cardId: 'q-teach', question: '为什么要正交？', answer: '因为特征向量彼此垂直。' });
  await service.call('card.focus', { deckId: 'd-teach', cardId: 'q-teach', focus: true });
  await service.call('card.flag', { deckId: 'd-teach', cardId: 'q-teach', reason: '重点复习' });
  // Start a fresh run so entry.card itself is cloned with all non-content fields attached.
  const freshRun = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd-teach', cardId: 'q-teach' }], fresh: true });
  await service.call('review.answer', { runId: freshRun.id, cardId: 'q-teach', selected: ['b'] });
  await service.call('teach.start', { runId: freshRun.id });
  assert.ok(capturedPrompt?.question, 'model received question payload');
  assert.equal(capturedPrompt.question.prompt, quizCard().prompt);
  assert.equal(capturedPrompt.question.answer, quizCard().answer);
  for (const field of NON_CONTENT_CARD_FIELDS) {
    assert.equal(field in capturedPrompt.question, false, `prompt question must omit non-content field "${field}"`);
  }
});

test('teach.start trims large cited sources via evidenceWindows instead of sending the full source text', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-teach-window-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const captured = [];
  const service = new StudyService(root, {
    complete: async (system, prompt) => {
      captured.push({ system, payload: JSON.parse(prompt) });
      return JSON.stringify(captured.length === 1 ? genericPlan : plan());
    },
  });
  const hugePrefix = 'A'.repeat(25_000);
  const hugeSuffix = 'B'.repeat(25_000);
  const fullText = `${hugePrefix} ${quote} ${hugeSuffix}`;
  await service.store.update(s => {
    s.sources.push({ id: 'source', title: 'Big Textbook', text: fullText, courses: ['Physics'] });
    s.decks.push({
      id: 'deck',
      title: 'Motion',
      cards: [{
        id: 'card',
        kind: 'flashcard',
        prompt: 'At 3 m/s for 4 s, how far?',
        answer: '12 m',
        citations: [{ sourceId: 'source', quote }],
      }],
    });
  });
  const run = await service.call('review.start', { deckId: 'deck', mode: 'flashcard' });
  await service.call('review.reveal', { runId: run.id, cardId: run.card.id });
  await service.call('review.answer', { runId: run.id, cardId: run.card.id, grade: 2 });

  await service.call('teach.start', { runId: run.id, mode: 'understanding', language: 'zh' });
  await service.call('teach.start', { runId: run.id, mode: 'calculation', language: 'en' });

  assert.equal(captured.length, 2);
  assert.match(captured[0].system, /Use the requested language\./);
  for (const call of captured) {
    assert.equal(call.payload.sources.length, 1);
    assert.equal(call.payload.sources[0].id, 'source');
    assert.ok(call.payload.sources[0].text.includes(quote), 'evidence window keeps the cited quote verbatim');
    assert.ok(call.payload.sources[0].text.length <= 8000, `expected trimmed evidence window <= 8000 chars, got ${call.payload.sources[0].text.length}`);
    assert.ok(call.payload.sources[0].text.length < fullText.length / 5, 'did not send full 50KB source text');
  }
});

