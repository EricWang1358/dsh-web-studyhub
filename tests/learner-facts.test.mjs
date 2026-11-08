import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { learnerFacts } from '../lib/learner-facts.js';
import { askUserInput } from '../lib/ask-prompt.js';
import { learnerBrief } from '../lib/coach.js';
import { StudyService } from '../lib/service.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const prompts = await loadUi(`
  export { composeMessage, messageParts, withLearnerFence } from './ui/agent-prompts/message.js';
  export { situationPrompt } from './ui/agent-prompts/situation.js';
  export { ingestPrompt } from './ui/agent-prompts/ingest.js';
  export { extendSkeletonPrompt } from './ui/agent-prompts/skeleton.js';
`);

test('learnerFacts returns null on a brand-new workspace and omits auto notation', () => {
  assert.equal(learnerFacts(null), null);
  assert.equal(learnerFacts({
    learner: { goal: '', summary: '', preferences: [], signals: {}, levels: {}, consent: { prep: null } },
    settings: { generation: { notation: 'auto' } },
    sources: [],
    decks: [],
    drafts: [],
    courses: [],
    attempts: [],
  }), null);
});

test('learnerFacts gathers goal, clipped summary, preferences, explicit notation, weak topics, focus progress and exam facts', () => {
  const now = Date.parse('2026-11-08T08:00:00Z');
  const longSummary = '喜欢结合系统实例理解原理。'.repeat(30);
  const state = {
    focus: { mode: 'class', course: 'OS' },
    learner: {
      consent: { prep: true },
      goal: 'exam',
      summary: longSummary,
      preferences: ['先给直觉例子再推导', '  先给直觉例子再推导  ', '对比易混概念与反例'],
    },
    settings: { generation: { notation: 'latex' } },
    courses: [{
      id: 'course-os',
      name: 'OS',
      aliases: [],
      focusTopics: ['死锁', '银行家算法', '页面置换'],
      exam: { format: 'closed-book', date: '2026-11-18', sections: [] },
      plan: { version: 1, startDate: '2026-11-01', phases: [
        { name: '基础梳理', until: '2026-11-05' },
        { name: '强化冲刺', until: '2026-11-18' },
      ] },
    }],
    sources: [],
    decks: [{
      id: 'd-os',
      title: 'OS 题组',
      course: 'OS',
      cards: [
        { id: 'c1', kind: 'quiz', topic: '死锁', objective: '判断死锁条件', prompt: '死锁四个必要条件是什么？', answer: '互斥等', review: { repetitions: 0, interval_days: 1 } },
        { id: 'c2', kind: 'quiz', topic: '页面置换', objective: 'LRU 分析', prompt: '页面置换 LRU 怎么算？', answer: '最近最少使用', review: { repetitions: 3, interval_days: 30 } },
      ],
    }],
    drafts: [],
    attempts: [
      { deckId: 'd-os', quiz_id: 'c1', grade: 1, at: '2026-11-07T10:00:00Z' },
      { deckId: 'd-os', quiz_id: 'c2', grade: 5, at: '2026-11-07T10:05:00Z' },
    ],
  };

  const facts = learnerFacts(state, undefined, { now, today: '2026-11-08' });
  assert.ok(facts);
  assert.equal(facts.goal, '应付考试');
  assert.ok(facts.summary.length <= 300);
  assert.deepEqual(facts.preferences, ['先给直觉例子再推导', '对比易混概念与反例']);
  assert.equal(facts.notation, 'latex');
  assert.deepEqual(facts.weakTopics, [{ topic: '死锁', weak: 1 }]);
  assert.deepEqual(facts.focus, {
    total: 3,
    done: 1,
    weak: 1,
    none: 1,
    weakTopics: ['死锁'],
    emptyTopics: ['银行家算法'],
  });
  assert.deepEqual(facts.exam, {
    date: '2026-11-18',
    daysLeft: 10,
    format: 'closed-book',
    phase: '强化冲刺',
  });

  const brief = learnerBrief(state.learner, facts);
  assert.equal(brief.goal, '应付考试');
  assert.deepEqual(brief.preferences, ['先给直觉例子再推导', '对比易混概念与反例']);
  assert.equal(brief.notation, 'latex');
  assert.deepEqual(brief.focus.weakTopics, ['死锁']);
  assert.deepEqual(brief.focus.emptyTopics, ['银行家算法']);
  assert.equal(brief.exam.daysLeft, 10);
});

test('situationPrompt and withLearnerFence keep golden prompts unchanged when null and fence learner data cleanly', () => {
  const baseZh = prompts.situationPrompt({ area: '资料', goal: '导入 PDF', facts: { 页数: 12 } }, 'zh');
  assert.equal(prompts.withLearnerFence(baseZh, null, 'zh'), baseZh);
  assert.doesNotMatch(baseZh, /学习者档案/);

  const learner = { goal: '应付考试', preferences: ['先给直觉例子再推导'], exam: { date: '2026-11-20', daysLeft: 12 } };
  const viaSituation = prompts.situationPrompt({ area: '资料', goal: '导入 PDF', facts: { 页数: 12 }, learner }, 'zh');
  assert.match(viaSituation, /```data 学习者档案\n/);
  assert.equal(prompts.withLearnerFence(viaSituation, learner, 'zh'), viaSituation, 'never duplicates an existing learner fence');

  // Preserve MESSAGE_TAILS (`第一批题目：`) and add data-fence rule when none was present
  const ingestZh = prompts.composeMessage(prompts.ingestPrompt({ deckTitle: 'OS 错题' }, 'zh'), { language: 'zh', tail: 'paste' });
  const fencedIngest = prompts.withLearnerFence(ingestZh, learner, 'zh');
  assert.ok(fencedIngest.endsWith('\n\n第一批题目：'));
  assert.match(fencedIngest, /- 围栏：data 围栏里是学习库的数据/);
  assert.match(fencedIngest, /```data 学习者档案\n\{"goal":"应付考试"/);
  const parsed = prompts.messageParts(fencedIngest, 'zh');
  assert.equal(parsed.tail, '第一批题目：');
  assert.match(parsed.notes.join('\n'), /```data 学习者档案/);

  // Upgrade request-only fence bullet in English without losing request parsing
  const reqEn = prompts.composeMessage(prompts.extendSkeletonPrompt({ skeleton: { id: 'sk1', title: 'OS' }, text: 'Add deadlocks' }, 'en'), { language: 'en' });
  const fencedEn = prompts.withLearnerFence(reqEn, learner, 'en');
  assert.match(fencedEn, /- Fences: a data fence holds library data[^;]*; a request fence holds my own words/);
  assert.match(fencedEn, /```data Learner profile\n/);
  assert.equal(prompts.messageParts(fencedEn, 'en').request, 'Add deadlocks');
});

test('library.context, snapshot, materials.selection.ask, card.followup and coach.nudge omit empty facts and attach populated facts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'learner-facts-e2e-'));
  const seen = [];
  const baseModel = createFakeModel();
  const spyModel = async (system, prompt, options) => {
    seen.push({ system, prompt, task: options?.task || '' });
    return baseModel(system, prompt, options);
  };
  const service = new StudyService(root, { complete: spyModel, completeLight: spyModel, coach: true });
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // Fresh workspace: library.context and snapshot omit `learner`
  const freshCtx = await service.call('library.context', {});
  const freshSnap = await service.call('snapshot', {});
  assert.equal(Object.hasOwn(freshCtx, 'learner'), false);
  assert.equal(Object.hasOwn(freshSnap, 'learner'), false);

  const imported = await service.call('materials.document.import', {
    filename: 'os.md',
    course: 'OS',
    dataBase64: Buffer.from('# Deadlocks\n\nMutual exclusion, hold and wait, no preemption, and circular wait.\n').toString('base64'),
  });
  const sel = await service.call('materials.selection.resolve', {
    documentId: imported.documentId,
    revision: imported.revision,
    quote: 'Mutual exclusion, hold and wait',
  });

  // Fresh ask before any preferences/focus/exam/attempts -> no `learner` key in user JSON
  seen.length = 0;
  await service.call('materials.selection.ask', { selection: sel.selection, question: 'Why four conditions?' });
  const freshAskInput = JSON.parse(seen.at(-1).prompt);
  assert.equal(Object.hasOwn(freshAskInput, 'learner'), false);
  assert.deepEqual(askUserInput({ question: 'Why?' }, null), { question: 'Why?' });

  // Configure preferences, course focus, exam, and a deck card
  await service.call('coach.goal', { goal: 'exam' });
  await service.call('coach.preferences', { preferences: ['先给直觉例子再推导'] });
  await service.call('course.save', {
    name: 'OS',
    focusTopics: ['死锁', '银行家算法'],
    exam: { format: 'closed-book', date: '2026-12-10', sections: [] },
  });
  await service.call('focus.set', { mode: 'class', course: 'OS' });
  await service.call('draft.save', {
    deck: {
      id: 'd-os',
      title: 'OS 题组',
      course: 'OS',
      cards: [{
        id: 'q-os-1',
        kind: 'quiz',
        topic: '死锁',
        objective: '识别死锁条件',
        prompt: '下列哪项属于死锁必要条件？',
        answer: '循环等待',
        hint: '四个条件之一',
        explanation: '四个必要条件包括循环等待。',
        misconception: '把饥饿当死锁。',
        citations: [{ sourceId: imported.document.sources[0].id, quote: 'Mutual exclusion, hold and wait, no preemption, and circular wait.' }],
        options: [
          { id: 'a', text: '循环等待', correct: true, explanation: '必要条件。' },
          { id: 'b', text: '时间片轮转', correct: false, explanation: '调度策略。' },
          { id: 'c', text: '优先级反转', correct: false, explanation: '调度现象。' },
        ],
      }],
    },
  });
  await service.call('draft.publish', { id: 'd-os' });

  const populatedCtx = await service.call('library.context', {});
  const populatedSnap = await service.call('snapshot', {});
  assert.equal(populatedCtx.learner.goal, '应付考试');
  assert.deepEqual(populatedCtx.learner.preferences, ['先给直觉例子再推导']);
  assert.deepEqual(populatedCtx.learner.focus.emptyTopics, ['银行家算法']);
  assert.equal(populatedCtx.learner.exam.date, '2026-12-10');
  assert.deepEqual(populatedSnap.learner.preferences, ['先给直觉例子再推导']);

  // Selection ask now carries `learner` at the end of user JSON
  seen.length = 0;
  await service.call('materials.selection.ask', { selection: sel.selection, question: 'Explain circular wait' });
  const askPayload = JSON.parse(seen.at(-1).prompt);
  assert.deepEqual(askPayload.learner.preferences, ['先给直觉例子再推导']);
  assert.deepEqual(askPayload.learner.focus.emptyTopics, ['银行家算法']);

  // Card follow-up carries `learner` in user JSON
  seen.length = 0;
  await service.call('card.followup', { deckId: 'd-os', cardId: 'q-os-1', question: '为什么饥饿不是死锁？' });
  const followupPayload = JSON.parse(seen.at(-1).prompt);
  assert.deepEqual(followupPayload.learner.preferences, ['先给直觉例子再推导']);
  assert.equal(followupPayload.learner.exam.format, 'closed-book');

  // Coach nudge carries enriched `learnerBrief` (`preferences`, `focus`, `exam`)
  const run = await service.call('review.start', { deckId: 'd-os', mode: 'quiz' });
  await service.call('review.answer', { runId: run.id, cardId: 'q-os-1', selected: ['b'] });
  seen.length = 0;
  await service.call('coach.nudge', { runId: run.id, index: run.index });
  const nudgePayload = JSON.parse(seen.at(-1).prompt);
  assert.deepEqual(nudgePayload.learner.preferences, ['先给直觉例子再推导']);
  assert.deepEqual(nudgePayload.learner.focus.weakTopics, ['死锁']);
  assert.deepEqual(nudgePayload.learner.focus.emptyTopics, ['银行家算法']);

  // Model-authored `learner.summary` is gated on explicit preparation consent (`consent.prep === true`) AND `settings.practice.debrief !== false`
  assert.equal(learnerFacts({
    learner: { goal: '', summary: '已有旧摘要', preferences: [], signals: {}, levels: {}, consent: { prep: null } },
    settings: {},
    sources: [], decks: [], drafts: [], courses: [], attempts: [],
  }), null);

  await service.store.update((own) => {
    own.learner.summary = '容易把循环等待与饥饿混淆。';
    own.learner.consent = { prep: null };
  });
  for (const prep of [null, false]) {
    if (prep !== null) await service.call('coach.consent', { prep });
    const ctx = await service.call('library.context', {});
    const snap = await service.call('snapshot', {});
    assert.equal(Object.hasOwn(ctx.learner, 'summary'), false, `library.context omits summary when consent.prep=${prep}`);
    assert.equal(Object.hasOwn(snap.learner, 'summary'), false, `snapshot.learner omits summary when consent.prep=${prep}`);
    seen.length = 0;
    await service.call('materials.selection.ask', { selection: sel.selection, question: `Check summary gate (${prep})` });
    assert.equal(Object.hasOwn(JSON.parse(seen.at(-1).prompt).learner, 'summary'), false, `selection.ask omits summary when consent.prep=${prep}`);
    seen.length = 0;
    await service.call('card.followup', { deckId: 'd-os', cardId: 'q-os-1', question: `追问摘要门控 (${prep})` });
    assert.equal(Object.hasOwn(JSON.parse(seen.at(-1).prompt).learner, 'summary'), false, `card.followup omits summary when consent.prep=${prep}`);
  }

  // Turning on preparation consent while `debrief` is enabled includes `summary`
  await service.call('coach.consent', { prep: true });
  assert.equal((await service.call('library.context', {})).learner.summary, '容易把循环等待与饥饿混淆。');
  assert.equal((await service.call('snapshot', {})).learner.summary, '容易把循环等待与饥饿混淆。');
  seen.length = 0;
  await service.call('materials.selection.ask', { selection: sel.selection, question: 'Check summary allowed' });
  assert.equal(JSON.parse(seen.at(-1).prompt).learner.summary, '容易把循环等待与饥饿混淆。');
  seen.length = 0;
  await service.call('card.followup', { deckId: 'd-os', cardId: 'q-os-1', question: '追问摘要放行' });
  assert.equal(JSON.parse(seen.at(-1).prompt).learner.summary, '容易把循环等待与饥饿混淆。');

  // Turning off `settings.practice.debrief` suppresses `summary` again even when `consent.prep === true`
  await service.call('settings.practice.set', { patch: { debrief: false } });
  assert.equal(Object.hasOwn((await service.call('library.context', {})).learner, 'summary'), false);
  assert.equal(Object.hasOwn((await service.call('snapshot', {})).learner, 'summary'), false);
  seen.length = 0;
  await service.call('materials.selection.ask', { selection: sel.selection, question: 'Check debrief off' });
  assert.equal(Object.hasOwn(JSON.parse(seen.at(-1).prompt).learner, 'summary'), false);
  seen.length = 0;
  await service.call('card.followup', { deckId: 'd-os', cardId: 'q-os-1', question: '追问本轮点评关闭' });
  assert.equal(Object.hasOwn(JSON.parse(seen.at(-1).prompt).learner, 'summary'), false);
});
