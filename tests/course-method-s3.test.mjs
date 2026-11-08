import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { CASE_FORMAT } from '../lib/case-study.js';
import {
  CLASSROOM_METHOD,
  advanceMethodStage,
  checkedMethod,
  clampMethodStageIndices,
  stageScope,
} from '../lib/course-method.js';
import {
  attemptPassed,
  isSelfReportedAttempt,
  methodProgress,
  rubricAttemptPassed,
  stageCards,
  stageCheckSatisfied,
} from '../lib/course-method-progress.js';
import { stageGate } from '../lib/course-method-gate.js';
import { methodStageSchedule } from '../lib/course-method-schedule.js';
import { courseDailyPlan, dailyPlan, roundOptions } from '../lib/daily-path.js';
import { latestOutcomes } from '../lib/mastery.js';
import { computeSessionProgress } from '../lib/study-progress.js';
import { libraryContracts } from '../lib/study-contracts.js';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { reviewElement } from './helpers/review-render.mjs';

const SKILL_TUTOR_PATH = new URL('../skills/study-tutor/SKILL.md', import.meta.url);

const ui = await loadUi(`
  export {
    default as CourseMethodCard,
    stageNeedsMaterial,
    checkLine,
  } from './ui/CourseMethodCard.jsx';
  export { buildHomePlan } from './ui/study-map/home-plan.js';
  export { default as TodayCard } from './ui/study-map/TodayCard.jsx';
  export { default as MethodLine } from './ui/study-map/MethodLine.jsx';
  export { default as Review } from './ui/Review.jsx';
  export { default as GuidedStudyWorkbench } from './ui/guided-study/GuidedStudyWorkbench.jsx';
  export { StudyProgressPanel } from './ui/guided-study/StudyProgressPanel.jsx';
  export { handOffText } from './ui/agent-prompts/index.js';
  export { deliverToChat } from './ui/hand-off/use-hand-off.js';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const han = /[\u3400-\u9fff]/;
const plainText = markup => markup
  .replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"')
  .replace(/&#x27;/g, "'")
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

async function createLibrary(t, extraOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'course-method-s3-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const service = new StudyService(root, { coverage: { roundLimit: 8 }, ...extraOptions });
  t.after(() => service.dispose());
  return { root, service };
}

function makeChoiceCard(id, topic, prompt = `Question ${id}?`) {
  return {
    id,
    kind: 'quiz',
    topic,
    objective: `Understand ${topic} (${id})`,
    prompt,
    answer: 'Option A',
    hint: 'Consider the core invariant.',
    explanation: 'Option A holds under all schedules.',
    options: [
      { id: 'a', text: 'Option A', correct: true, explanation: 'Right' },
      { id: 'b', text: 'Option B', correct: false, explanation: 'Wrong' },
      { id: 'c', text: 'Option C', correct: false, explanation: 'Wrong' },
    ],
  };
}

test('1. Default classroom method (课堂跟学, own === false) preserves 100% existing behavior across progress, gate, daily queue, guided session, and UI', async t => {
  const { service } = await createLibrary(t);
  const COURSE = 'Operating Systems';
  await service.call('course.save', {
    name: COURSE,
    exam: { date: '2026-12-20' },
  });
  const src = await service.call('source.add', {
    title: 'Week 1 Processes',
    text: 'A process is a program in execution with its own address space and PCB. '.repeat(6),
    courses: [COURSE],
  });
  await service.store.update(state => {
    state.decks.push(
      { id: 'd-os-1', title: 'Processes', course: COURSE, cards: Array.from({ length: 5 }, (_, i) => makeChoiceCard(`os-1-${i}`, 'Processes')) },
      { id: 'd-os-2', title: 'Threads', course: COURSE, cards: Array.from({ length: 5 }, (_, i) => makeChoiceCard(`os-2-${i}`, 'Threads')) },
    );
    for (let i = 0; i < 8; i++) {
      const deckId = i < 5 ? 'd-os-1' : 'd-os-2';
      const cardId = i < 5 ? `os-1-${i}` : `os-2-${i - 5}`;
      state.attempts.push({ id: `att-${i}`, deckId, quiz_id: cardId, grade: 4, assessment: 'graded', timestamp: Date.now() });
    }
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });

  const methodResp = await service.call('course.method.get', { name: COURSE });
  assert.equal(methodResp.own, false);
  assert.equal(methodResp.method.name, '课堂跟学');
  assert.deepEqual(methodResp.method.stages.map(s => s.activity), ['publish', 'practice', 'review']);
  assert.equal(methodResp.schedule, undefined, 'default classroom course attaches no custom stage schedule');

  const compact = await service.call('snapshot', { compact: true });
  assert.equal(compact.focus.method.own, false);
  assert.equal(compact.focus.method.schedule, undefined);

  // Starting a guided session without checkItems on a default classroom course leaves checkItems empty as before
  const session = await service.call('study.session.start', {
    courseId: COURSE,
    scope: [{ kind: 'source', id: src.id }],
    goal: { title: 'Understand PCB' },
  });
  assert.deepEqual(session.goal.checkItems, []);

  // Daily plan on default classroom course pulls across all course decks without stage filtering
  const rawState = await service.store.read();
  const daily = dailyPlan(rawState, { now: Date.now() });
  assert.equal(daily.plan.counts.new, 2, 'remaining 2 unseen cards across the course are scheduled unchanged');

  // Home plan & MethodLine & CourseMethodCard show zero stage-jump or stage-advance chrome on default package
  ui.setUiLanguage('zh');
  const home = ui.buildHomePlan({
    data: compact,
    today: { course: COURSE, due: 0, weak: 0, new: 2, size: 2, scope: daily.scope },
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === COURSE,
    actions: { start() {}, resume() {}, addSource() {} },
  });
  assert.equal(home.plan.stageAdvance, null, 'default classroom course never shows stageAdvance on Home');
  assert.equal(renderToStaticMarkup(inApp(ui, h(ui.MethodLine, { method: compact.focus.method }))), '');

  const cardHtml = renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
    course: { id: methodResp.courseId, name: COURSE },
    readout: compact.focus.method,
    data: rawState,
  }), { data: rawState }));
  assert.match(plainText(cardHtml), /学法 课堂跟学 默认/);
  assert.doesNotMatch(plainText(cardHtml), /跳到这一阶段|进入这一阶段|回到这一阶段|建议 .* 前|慢了一点/);
});

test('2. Per-stage scope: validation, shorthand normalization, backward-compatible course fallback, and scoped progress/gate/material checks', () => {
  // Without scope, stageScope returns null so existing methods fall back to whole-course scope
  const legacy = checkedMethod({
    name: 'Legacy Method',
    stages: [{ name: 'Stage A', activity: 'practice', level: 'medium' }],
  });
  assert.equal(stageScope(legacy.stages[0]), null);
  assert.equal('scope' in legacy.stages[0], false);

  // Explicit scope & top-level shorthand keys normalize, trim, and deduplicate
  const scoped = checkedMethod({
    name: 'Scoped Method',
    stageIndex: 1,
    skippedStages: [0, 0],
    selfReportedStages: [1],
    stages: [
      {
        name: '并发与集合',
        activity: 'explain',
        alternatives: ['practice'],
        level: 'medium',
        scope: { deckIds: [' d-juc ', 'd-juc'], sourceIds: ['src-juc'], topics: ['JUC', 'ConcurrentHashMap'] },
      },
      {
        name: 'AI 应用开发',
        activity: 'practice',
        level: 'strict',
        deckIds: ['d-ai'],
        topics: ['RAG'],
      },
    ],
  });
  assert.deepEqual(scoped.stages[0].scope, {
    deckIds: ['d-juc'],
    sourceIds: ['src-juc'],
    topics: ['JUC', 'ConcurrentHashMap'],
  });
  assert.deepEqual(scoped.stages[1].scope, {
    deckIds: ['d-ai'],
    topics: ['RAG'],
  });
  assert.equal(scoped.stageIndex, 1);
  assert.deepEqual(scoped.skippedStages, [0]);
  assert.deepEqual(scoped.selfReportedStages, [1]);

  // Invalid scopes and out-of-range stage indices reject cleanly
  assert.throws(
    () => checkedMethod({ name: 'Bad', stages: [{ name: 'S1', activity: 'practice', scope: 'not-an-object' }] }),
    /范围（scope）需为对象/,
  );
  assert.throws(
    () => checkedMethod({ name: 'Bad', stages: [{ name: 'S1', activity: 'practice', scope: { deckIds: 'not-array' } }] }),
    /需为不超过|列表/,
  );
  assert.throws(
    () => checkedMethod({ name: 'Bad', skippedStages: [99], stages: [{ name: 'S1', activity: 'practice' }] }),
    /阶段序号列表/,
  );

  // Scoped methodProgress + stageGate + stageNeedsMaterial count only the stage's own materials and questions
  const COURSE = 'Java + AI';
  const courseObj = {
    id: 'c-java',
    name: COURSE,
    method: checkedMethod({
      name: '四步走',
      stages: [
        { name: '阶段1：并发', activity: 'explain', alternatives: ['practice'], level: 'medium', scope: { sourceIds: ['s-juc'], deckIds: ['d-juc'] } },
        { name: '阶段2：RAG', activity: 'practice', level: 'medium', scope: { sourceIds: ['s-rag'], topics: ['RAG'] } },
      ],
    }),
  };
  const state = {
    courses: [courseObj],
    sources: [
      { id: 's-juc', title: 'JUC Notes', courses: [COURSE], text: 'Thread safety and locks in Java. '.repeat(5) },
      // Notice: s-rag is not imported yet!
    ],
    decks: [
      { id: 'd-juc', course: COURSE, cards: Array.from({ length: 4 }, (_, i) => makeChoiceCard(`juc-${i}`, 'JUC')) },
      { id: 'd-ai', course: COURSE, cards: [
        ...Array.from({ length: 5 }, (_, i) => makeChoiceCard(`rag-${i}`, 'RAG')),
        makeChoiceCard('other-ai', 'Prompting'),
      ] },
    ],
    attempts: [
      { deckId: 'd-juc', quiz_id: 'juc-0', grade: 4 },
      { deckId: 'd-juc', quiz_id: 'juc-1', grade: 4 },
      { deckId: 'd-juc', quiz_id: 'juc-2', grade: 4 },
      // Answering RAG cards does not inflate Stage 1's gate
      { deckId: 'd-ai', quiz_id: 'rag-0', grade: 4 },
      { deckId: 'd-ai', quiz_id: 'rag-1', grade: 4 },
    ],
  };

  const prog0 = methodProgress(state, COURSE);
  assert.equal(prog0.index, 0);
  assert.deepEqual(prog0.counts, { materials: 1, cards: 4, answered: 3, right: 3 });
  const gate0 = stageGate(state, COURSE, prog0);
  assert.equal(gate0.total, 4, 'only d-juc cards belong to Stage 1');
  assert.equal(gate0.passed, 3);
  assert.equal(gate0.checkPassed, true, '3/4 >= 2/3 passes Stage 1 check');
  assert.equal(gate0.ready, false, '3/4 = 75% < 80% needs 1 more to suggest advancing');
  assert.equal(gate0.toReady, 1);

  // Stage 1 has its scoped material (s-juc), while Stage 2 lacks s-rag even though the course has s-juc!
  assert.equal(ui.stageNeedsMaterial(state, courseObj, courseObj.method.stages[0], { own: true, index: 0, current: 0 }), false);
  assert.equal(ui.stageNeedsMaterial(state, courseObj, courseObj.method.stages[1], { own: true, index: 1, current: 0 }), true);

  // Switching to Stage 2 measures only the 5 RAG-topic cards (ignoring d-juc and 'Prompting')
  const stateAtStage2 = {
    ...state,
    courses: [{ ...courseObj, method: { ...courseObj.method, stageIndex: 1 } }],
  };
  const prog1 = methodProgress(stateAtStage2, COURSE);
  assert.equal(prog1.index, 1);
  assert.deepEqual(prog1.counts, { materials: 0, cards: 5, answered: 2, right: 2 });
  const gate1 = stageGate(stateAtStage2, COURSE, prog1);
  assert.equal(gate1.total, 5);
  assert.equal(gate1.passed, 2);
});

test('3. Guided study (study.session.start) auto-populates stage checkItems and contracts/prompts enforce main-chat return-to-StudyHub check rules', async t => {
  const { service } = await createLibrary(t);
  const COURSE = '分布式系统';
  await service.call('course.save', {
    name: COURSE,
    method: {
      name: '先讲后测',
      stages: [
        { name: 'Raft 共识', activity: 'explain', alternatives: ['check'], level: 'medium', scope: { deckIds: ['d-raft'] } },
        { name: '两阶段提交', activity: 'practice', level: 'medium', scope: { deckIds: ['d-2pc'] } },
      ],
    },
  });
  const src = await service.call('source.add', {
    title: 'Raft 论文摘录',
    text: 'Leader election uses randomized election timeouts to split votes rarely. '.repeat(5),
    courses: [COURSE],
  });
  await service.store.update(state => {
    state.decks.push(
      {
        id: 'd-raft',
        title: 'Raft 题组',
        course: COURSE,
        cards: [
          makeChoiceCard('raft-1', 'Leader Election', '为什么 Raft 使用随机选举超时？'),
          makeChoiceCard('raft-2', 'Log Replication', 'Leader 何时提交日志条目？'),
        ],
      },
      {
        id: 'd-2pc',
        title: '2PC 题组',
        course: COURSE,
        cards: [makeChoiceCard('2pc-1', 'Coordinator', '协调者宕机会阻塞什么？')],
      },
    );
  });

  // Omitting goal.checkItems auto-fills from Stage 1's scoped existing cards ('raft-1', 'raft-2'), NOT Stage 2's '2pc-1'
  const session = await service.call('study.session.start', {
    courseId: COURSE,
    scope: [{ kind: 'source', id: src.id }],
    goal: { title: '掌握 Raft 选举与日志复制' },
  });
  assert.equal(session.goal.checkItems.length, 2);
  assert.deepEqual(session.goal.checkItems.map(item => item.targetCardIds), [['raft-1'], ['raft-2']]);

  // Explicit checkItems passed by the caller are respected verbatim
  const explicit = await service.call('study.session.start', {
    courseId: COURSE,
    scope: [{ kind: 'source', id: src.id }],
    goal: { title: '只测第一题', checkItems: [{ id: 'custom-1', title: '选举超时', targetCardIds: ['raft-1'] }] },
  });
  assert.equal(explicit.goal.checkItems.length, 1);
  assert.equal(explicit.goal.checkItems[0].id, 'custom-1');

  // Verify contracts, study-tutor skill, method.explain, and method.missed prompts carry the exact hand-off rules
  const guidedContract = libraryContracts.guided;
  assert.match(guidedContract, /回 StudyHub 做检验题/);
  assert.match(guidedContract, /reuse existing stage questions first/);
  assert.match(guidedContract, /study\.question\.prepare/);
  assert.match(guidedContract, /never inventing ungrounded questions/);

  const skillMd = await readFile(SKILL_TUTOR_PATH, 'utf8');
  assert.match(skillMd, /回 StudyHub 做检验题/);
  assert.match(skillMd, /不现造无出处/);
  assert.match(skillMd, /study\.branch\.open/);

  const explainText = ui.handOffText('method.explain', {
    course: COURSE,
    stage: 'Raft 共识',
    topics: ['Leader Election'],
    sourceCount: 1,
    cardCount: 2,
  });
  assert.match(explainText, /回 StudyHub 做检验题/);
  assert.match(explainText, /不现造无出处/);

  const missedText = ui.handOffText('method.missed', {
    course: COURSE,
    stage: 'Raft 共识',
    missed: [{ prompt: '为什么 Raft 使用随机选举超时？', topic: 'Leader Election' }],
    note: '还是分不清任期号和日志索引',
  });
  assert.match(missedText, /study-tutor/);
  assert.match(missedText, /为什么 Raft 使用随机选举超时/);
  assert.match(missedText, /还是分不清任期号和日志索引/);
  assert.match(missedText, /回 StudyHub 做检验题/);
});

test('4. Rubric / case questions: strictly > 0.5 score ratio passes check while keeping normal FSRS scheduling, and case.drills inherits stage scope', async t => {
  // Boundary unit checks for rubricAttemptPassed (> 0.5 strictly)
  assert.equal(rubricAttemptPassed({ assessment: 'rubric', score: 5, maxScore: 10 }), false, '5/10 = 0.50 is not strictly > 0.5');
  assert.equal(rubricAttemptPassed({ assessment: 'rubric', score: 5.5, maxScore: 10, grade: 2 }), true, '5.5/10 = 0.55 > 0.5 passes even when smGradeFor is 2');
  assert.equal(rubricAttemptPassed({
    assessment: 'rubric',
    score: 0,
    maxScore: 0,
    criteria: [{ score: 1, maxScore: 1 }, { score: 0, maxScore: 1 }],
  }), false, '1/2 criteria is not > 0.5');
  assert.equal(rubricAttemptPassed({
    assessment: 'rubric',
    score: 0,
    maxScore: 0,
    criteria: [{ score: 1, maxScore: 1 }, { score: 1, maxScore: 1 }, { score: 0, maxScore: 1 }],
  }), true, '2/3 criteria > 0.5 passes');
  assert.equal(attemptPassed({ assessment: 'rubric', score: 2.2, maxScore: 4, grade: 2 }), true);
  assert.equal(attemptPassed({ assessment: 'rubric', score: 2, maxScore: 4, grade: 2 }), false);

  // End-to-end case deck grading via card.grade + FSRS scheduling + case.drills stage scope inheritance
  let nextRubricScores = [1, 1, 0, 0];
  const { service } = await createLibrary(t, {
    complete: async (system) => {
      if (String(system).includes('strict, fair examiner')) {
        return JSON.stringify({
          questions: [{
            cardId: 'case-pay-1',
            summary: '幂等部分清楚，兜底对账有遗漏。',
            criteria: [
              { id: 'r1', score: nextRubricScores[0], evidence: ['唯一单号'], covered: ['r1.k1'], missing: [], suggestion: '' },
              { id: 'r2', score: nextRubricScores[1], evidence: ['状态机'], covered: ['r2.k1'], missing: [], suggestion: '' },
              { id: 'r3', score: nextRubricScores[2], evidence: [], covered: [], missing: ['r3.k1'], suggestion: '补充死信队列隔离失败消息。' },
              { id: 'r4', score: nextRubricScores[3], evidence: [], covered: [], missing: ['r4.k1'], suggestion: '补充定时对账任务兜底。' },
            ],
            unanchored: [],
            assumptions: [],
          }],
          summary: '总体点评。',
        });
      }
      return '{}';
    },
  });

  const COURSE = '系统设计面试';
  const src = await service.call('source.add', {
    title: '订单幂等与消息队列讲义',
    text: [
      '第三方支付网关在网络抖动时会重复推送成功回调，若订单系统缺乏唯一业务单号与状态机保护，极易造成重复入账。',
      '同时下游账务服务偶发超时，消息消费失败达到阈值后需转入死信队列，并由每日异步对账任务核对最终一致性。',
    ].join('\n\n'),
    courses: [COURSE],
  });

  const caseDeckId = 'd-case-pay';
  await service.store.update(state => {
    state.decks.push({
      id: caseDeckId,
      title: '高并发支付回调案例',
      course: COURSE,
      format: CASE_FORMAT,
      case: {
        sourceId: src.id,
        title: '高并发支付回调案例',
        totalMarks: 4,
        minutesPerMark: 3,
        readingMinutes: 5,
        origin: 'imported',
        language: 'zh',
      },
      cards: [{
        id: 'case-pay-1',
        kind: 'open',
        topic: '支付幂等与对账',
        objective: '设计支付回调幂等与最终一致兜底',
        prompt: '第三方支付重复投递成功通知且下游偶发超时，如何设计幂等与兜底？',
        answer: '唯一单号 + 状态机条件更新 + 死信队列 + 定时对账。',
        hint: '兼顾同步去重与异步补偿。',
        explanation: '四个环节缺一不可。',
        marks: 4,
        caseQuestion: 1,
        citations: [{ sourceId: src.id, quote: '第三方支付网关在网络抖动时会重复推送成功回调' }],
        rubricCriteria: [
          { id: 'r1', label: '唯一幂等键', marks: 1, descriptor: '使用唯一业务单号去重', keyPoints: ['唯一业务单号'] },
          { id: 'r2', label: '状态机保护', marks: 1, descriptor: '数据库条件更新防并发重入', keyPoints: ['状态机条件更新'] },
          { id: 'r3', label: '死信队列', marks: 1, descriptor: '消费失败隔离至死信队列', keyPoints: ['死信队列重试隔离'] },
          { id: 'r4', label: '异步对账', marks: 1, descriptor: '定时对账核平账务差异', keyPoints: ['定时对账兜底'] },
        ],
        rubric: '1. 唯一幂等键；2. 状态机保护；3. 死信队列；4. 异步对账。',
      }],
    });
  });

  await service.call('course.save', {
    name: COURSE,
    method: {
      name: '场景实战学法',
      stages: [
        { name: '阶段1：支付案例', activity: 'practice', alternatives: ['explain'], level: 'medium', scope: { deckIds: [caseDeckId] } },
        { name: '阶段2：综合复盘', activity: 'review', level: 'medium' },
      ],
    },
  });

  const session = await service.call('study.session.start', {
    courseId: COURSE,
    scope: [{ kind: 'deck', id: caseDeckId }],
  });
  assert.deepEqual(session.goal.checkItems.map(i => i.targetCardIds), [['case-pay-1']]);

  // 1) Score exactly 2 / 4 (50%, NOT > 0.5): fails stage check and exposes weakCaseDeckId + missed
  nextRubricScores = [1, 1, 0, 0];
  const run1 = await service.call('review.start', { mode: 'path', fresh: true, scope: [{ deckId: caseDeckId }] });
  await service.call('card.grade', {
    runId: run1.id,
    deckId: caseDeckId,
    cardId: 'case-pay-1',
    answer: '用唯一单号加数据库状态机条件更新防止重复入账。',
  });

  const gateAtHalf = (await service.call('course.method.get', { name: COURSE })).gate;
  assert.equal(gateAtHalf.passed, 0, '2/4 (0.5) does not pass rubric > 0.5 gate');
  assert.equal(gateAtHalf.checkPassed, false);
  assert.equal(gateAtHalf.weakCaseDeckId, caseDeckId, 'surfaces weakCaseDeckId so learner can turn weak rubric criteria into drills');
  assert.equal(gateAtHalf.missed.length, 1);
  assert.equal(gateAtHalf.missed[0].cardId, 'case-pay-1');

  const sessAtHalf = await service.call('study.session.get', { sessionId: session.id });
  assert.equal(sessAtHalf.progress.independentPassedCount, 0);
  assert.equal(sessAtHalf.progress.pendingCount, 1);

  // Triggering case.drills creates the linked drill deck for weak criteria r3 & r4, and Stage 1's scope automatically includes it!
  const drillsRes = await service.call('case.drills', { deckId: caseDeckId });
  t.after(() => service.call('job.cancel', { all: true }).catch(() => {}));
  assert.equal(drillsRes.criteria, 2);
  assert.ok(drillsRes.deckId, 'drill deck created from weak rubric points');
  await service.call('job.cancel', { all: true }).catch(() => {});

  // Add a principle drill card into the created drill deck and verify stageCards automatically includes it via deck.case.drillDeckId
  await service.store.update(state => {
    const drillDeck = state.decks.find(d => d.id === drillsRes.deckId);
    drillDeck.cards.push(makeChoiceCard('drill-dlq-1', '死信队列', '消费失败超限后消息应路由到哪里？'));
  });
  const stateAfterDrills = await service.store.read();
  const stage1Obj = stateAfterDrills.courses.find(c => c.name === COURSE).method.stages[0];
  const scopedCardsAfterDrills = stageCards(stateAfterDrills, COURSE, stage1Obj);
  assert.ok(
    scopedCardsAfterDrills.some(entry => entry.deck.id === drillsRes.deckId && entry.card.id === 'drill-dlq-1'),
    'drill deck linked via deck.case.drillDeckId inherits parent case deck stage scope',
  );

  // 2) Re-attempting case-pay-1 with 2.5 / 4 (0.625 > 0.5): passes rubric check AND updates FSRS review state!
  nextRubricScores = [1, 1, 0.5, 0];
  const run2 = await service.call('review.start', { mode: 'path', fresh: true, scope: [{ deckId: caseDeckId, cardId: 'case-pay-1' }] });
  await service.call('card.grade', {
    runId: run2.id,
    deckId: caseDeckId,
    cardId: 'case-pay-1',
    answer: '唯一单号、状态机更新，以及死信队列隔离失败消息。',
  });

  const stateAfterPass = await service.store.read();
  const caseCardStored = stateAfterPass.decks.find(d => d.id === caseDeckId).cards[0];
  assert.ok(caseCardStored.review && caseCardStored.review.reps >= 2, 'FSRS-6 review scheduling ran normally on card.grade');
  assert.ok(Number.isFinite(caseCardStored.review.stability) && caseCardStored.review.due_at, 'FSRS stability and due_at are recorded');

  const sessAfterPass = await service.call('study.session.get', { sessionId: session.id });
  assert.equal(sessAfterPass.progress.independentPassedCount, 1, '2.5/4 (> 0.5) counts as passed in guided session progress');
});

test('5. Honest evidence distinction: self-reported attempts never masquerade as verified passes in stageGate, StudyProgressPanel, or CourseMethodCard', () => {
  const COURSE = '法理学';
  const courseObj = {
    id: 'c-law',
    name: COURSE,
    method: checkedMethod({
      name: '理解后抽查',
      stages: [
        { name: '阶段1：法律原则', activity: 'explain', alternatives: ['check'], level: 'medium' },
        { name: '阶段2：案例适用', activity: 'practice', level: 'medium' },
      ],
    }),
  };
  const cards = [makeChoiceCard('law-1', '原则与规则'), makeChoiceCard('law-2', '比例原则'), makeChoiceCard('law-3', '法不溯及既往')];
  const nowMs = Date.now();
  const state = {
    courses: [courseObj],
    sources: [{ id: 's-law', courses: [COURSE], text: '法律规则具有明确的假定条件、行为模式与法律后果。'.repeat(4) }],
    decks: [{ id: 'd-law', course: COURSE, cards }],
    attempts: [
      { id: 'a1', deckId: 'd-law', quiz_id: 'law-1', grade: 4, assessment: 'self-report', timestamp: nowMs },
      { id: 'a2', deckId: 'd-law', quiz_id: 'law-2', grade: 4, assessment: 'self-report', timestamp: nowMs },
      { id: 'a3', deckId: 'd-law', quiz_id: 'law-3', grade: 4, assessment: 'graded', timestamp: nowMs },
    ],
  };

  assert.equal(isSelfReportedAttempt(state.attempts[0]), true);
  assert.equal(attemptPassed(state.attempts[0]), false, 'self-report never counts as verified pass');

  const gate = stageGate(state, COURSE);
  assert.equal(gate.total, 3);
  assert.equal(gate.passed, 1, 'only the 1 graded answer counts as passed');
  assert.equal(gate.selfReported, 2, '2 self-reported answers tracked separately');
  assert.equal(gate.checkPassed, false, '1/3 < 2/3: self-reports do not unlock stage check');
  assert.equal(gate.ready, false);
  assert.equal(gate.status, 'self-reported');
  assert.equal(gate.stages[0].status, 'self-reported');

  // StudyProgressPanel distinguishes self-reported items from independent passes
  const sessionProgress = computeSessionProgress(
    {
      createdAt: nowMs - 60_000,
      goal: {
        checkItems: cards.map(c => ({ id: `chk-${c.id}`, title: c.topic, targetCardIds: [c.id] })),
      },
      artifactRefs: [],
    },
    state.attempts,
  );
  assert.equal(sessionProgress.independentPassedCount, 1);
  assert.equal(sessionProgress.selfReportedCount, 2);
  assert.match(sessionProgress.displayLine, /2 项自报/);

  ui.setUiLanguage('zh');
  const cardZh = plainText(renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
    course: courseObj,
    data: state,
  }), { data: state })));
  assert.match(cardZh, /自报/);
  assert.match(cardZh, /另有 2 题为自报记录，不计入已检验通过/);

  const panelZh = plainText(renderToStaticMarkup(h(ui.StudyProgressPanel, {
    progress: sessionProgress,
    estimate: { status: 'estimating' },
    defaultExpanded: true,
  })));
  assert.match(panelZh, /2 项自报/);
  assert.match(panelZh, /自报/);
});

test('6. Manual failed-check return (带着错题回主会话): rendered on Review, CourseMethodCard, and GuidedStudyWorkbench; strictly manual with zero auto-redirect', async t => {
  const { service } = await createLibrary(t);
  const COURSE = '计算机网络';
  await service.call('course.save', {
    name: COURSE,
    method: {
      name: '讲练闭环',
      stages: [
        { name: '拥塞控制', activity: 'explain', alternatives: ['practice'], level: 'medium' },
        { name: '流量控制', activity: 'practice', level: 'medium' },
      ],
    },
  });
  await service.store.update(state => {
    state.decks.push({
      id: 'd-tcp',
      title: 'TCP 拥塞控制',
      course: COURSE,
      cards: [
        makeChoiceCard('tcp-1', '慢启动', '慢启动阈值 ssthresh 在超时重传后如何变化？'),
        makeChoiceCard('tcp-2', '快恢复', '收到 3 个重复 ACK 后 cwnd 如何调整？'),
        makeChoiceCard('tcp-3', 'BBR', 'BBR 探测的核心带宽与时延指标是什么？'),
      ],
    });
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });

  // Complete a 3-card fresh round answering 2 wrong on first pass (re-asks answered right at the end, missedCards preserved!)
  let run = await service.call('review.start', { mode: 'path', fresh: true, scope: [{ deckId: 'd-tcp' }] });
  let step = 0;
  while (!run.complete && step++ < 10) {
    const pick = step <= 2 ? ['b'] : ['a'];
    run = await service.call('review.answer', {
      runId: run.id,
      cardId: run.card.id,
      selected: pick,
      queueVersion: run.queueVersion,
    });
    if (!run.complete) {
      run = await service.call('review.move', { runId: run.id, direction: 1 });
    }
  }
  assert.equal(run.complete, true);
  assert.ok(Array.isArray(run.missedCards) && run.missedCards.length === 2, 'completed round carries the 2 first-pass missedCards');

  // Host chat was NEVER called automatically during or at the end of the round
  const chatDeliveries = [];
  const fakeHost = {
    askInChat: text => { chatDeliveries.push(text); return 'filled'; },
  };

  // 1) Review round summary shows manual 带着错题回主会话 button while preserving single primary CTA
  ui.setUiLanguage('zh');
  const fullData = await service.call('snapshot', {});
  const reviewHtml = renderToStaticMarkup(reviewElement(ui.Review, ui.StudyServicesContext, {
    run,
    data: fullData,
    host: fakeHost,
    shellTitle: '今日学习',
    coachProps: {
      debrief: {
        headline: '本轮做完了。',
        why: '有错题待巩固。',
        next: 'review_weak',
        insights: [],
        metrics: { answered: 3, gradedAnswered: 3, gradedCorrect: 1 },
        status: { enabled: true, consent: false, ready: 0 },
      },
      autopilot: false,
      onPractice() {},
      onContinue() {},
      onReviewWeak() {},
      destination: { kind: 'path', reason: 'continuing', label: '继续学习 →', go() {}, note: '' },
    },
  }));
  assert.equal(chatDeliveries.length, 0, 'rendering finished round with missed questions never auto-redirects');
  assert.match(plainText(reviewHtml), /带着错题回主会话/);
  assert.equal((reviewHtml.match(/class="sh-btn sh-btn--primary/g) || []).length, 1, 'still exactly one primary button on Review result page');

  // 2) GuidedStudyWorkbench shows 带着错题回主会话 ONLY when currentFeedback.correct === false
  const guidedBase = {
    session: { id: 'gs-1', courseId: COURSE, status: 'active', goal: { title: '拥塞控制', checkItems: [{ id: 'i1', title: '慢启动', targetCardIds: ['tcp-1'] }] } },
    host: fakeHost,
  };
  const workbenchUnanswered = renderToStaticMarkup(inApp(ui, h(ui.GuidedStudyWorkbench, {
    ...guidedBase,
    run: { id: 'r-g', deckId: 'd-tcp', card: makeChoiceCard('tcp-1', '慢启动'), revealed: false, feedback: null },
  })));
  assert.doesNotMatch(plainText(workbenchUnanswered), /带着错题回主会话/, 'hidden before answering');

  const workbenchRight = renderToStaticMarkup(inApp(ui, h(ui.GuidedStudyWorkbench, {
    ...guidedBase,
    run: { id: 'r-g', deckId: 'd-tcp', card: makeChoiceCard('tcp-1', '慢启动'), revealed: true, feedback: { correct: true, grade: 4 } },
  })));
  assert.doesNotMatch(plainText(workbenchRight), /带着错题回主会话/, 'hidden when answered right');

  const workbenchMissed = renderToStaticMarkup(inApp(ui, h(ui.GuidedStudyWorkbench, {
    ...guidedBase,
    run: { id: 'r-g', deckId: 'd-tcp', card: makeChoiceCard('tcp-1', '慢启动', '慢启动阈值如何变化？'), revealed: true, feedback: { correct: false, grade: 1 } },
  })));
  assert.match(plainText(workbenchMissed), /带着错题回主会话/, 'shown when current check question is missed');
  assert.equal(chatDeliveries.length, 0, 'still zero automatic chat deliveries');

  // 3) Explicit learner click triggers deliverToChat manually and fills the fenced method.missed hand-off
  const outcome = await ui.deliverToChat({
    host: fakeHost,
    prompt: ui.handOffText('method.missed', { course: COURSE, stage: '拥塞控制', missed: run.missedCards }),
  });
  assert.equal(outcome, 'filled');
  assert.equal(chatDeliveries.length, 1);
  assert.match(chatDeliveries[0], /study-tutor/);
  assert.match(chatDeliveries[0], /回 StudyHub 做检验题/);
});

test('7. Stage advancement: 80% ready suggestion on Home & CourseMethodCard, manual jump/skip (未完成就前进), and auto-clearing skipped marker once satisfied', async t => {
  const { service } = await createLibrary(t);
  const COURSE = '数据库内核';
  const savedCourse = await service.call('course.save', {
    name: COURSE,
    method: {
      name: '内核三阶',
      stages: [
        { name: '阶段1：B+树索引', activity: 'explain', alternatives: ['practice'], level: 'medium', scope: { deckIds: ['d-btree'] } },
        { name: '阶段2：MVCC与锁', activity: 'practice', alternatives: ['explain'], level: 'medium', scope: { deckIds: ['d-mvcc'] } },
        { name: '阶段3：WAL恢复', activity: 'review', level: 'medium', scope: { deckIds: ['d-wal'] } },
      ],
    },
  });
  await service.store.update(state => {
    state.sources.push({ id: 's-db', title: 'InnoDB Internals', courses: [COURSE], text: 'B+Tree leaf pages form a doubly linked list. '.repeat(6) });
    state.decks.push(
      { id: 'd-btree', title: 'B+Tree', course: COURSE, cards: Array.from({ length: 10 }, (_, i) => makeChoiceCard(`bt-${i}`, 'B+Tree')) },
      { id: 'd-mvcc', title: 'MVCC', course: COURSE, cards: Array.from({ length: 6 }, (_, i) => makeChoiceCard(`mv-${i}`, 'MVCC')) },
      { id: 'd-wal', title: 'WAL', course: COURSE, cards: Array.from({ length: 4 }, (_, i) => makeChoiceCard(`wal-${i}`, 'WAL')) },
    );
    // 7 right out of 10 on Stage 1 (70%: passes 2/3 check, not yet 80% ready)
    for (let i = 0; i < 7; i++) {
      state.attempts.push({ id: `bt-att-${i}`, deckId: 'd-btree', quiz_id: `bt-${i}`, grade: 4, assessment: 'graded', timestamp: Date.now() });
    }
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });

  const at70 = await service.call('snapshot', { compact: true });
  assert.equal(at70.focus.method.index, 0);
  assert.equal(at70.focus.method.gate.checkPassed, true);
  assert.equal(at70.focus.method.gate.ready, false);
  assert.equal(at70.focus.method.gate.toReady, 1);

  // Answer the 8th card right -> 8/10 = 80% -> gate.ready === true!
  await service.store.update(state => {
    state.attempts.push({ id: 'bt-att-7', deckId: 'd-btree', quiz_id: 'bt-7', grade: 4, assessment: 'graded', timestamp: Date.now() });
  });

  const at80 = await service.call('snapshot', { compact: true });
  assert.equal(at80.focus.method.index, 0, 'explain stage waits for learner confirmation to advance rather than silently jumping');
  assert.equal(at80.focus.method.gate.ready, true);
  assert.equal(at80.focus.method.nextStage.name, '阶段2：MVCC与锁');

  ui.setUiLanguage('zh');
  let advanceArgs = null;
  const home80 = ui.buildHomePlan({
    data: at80,
    today: { course: COURSE, due: 0, weak: 0, new: 2, size: 2, scope: [{ deckId: 'd-btree', cardId: 'bt-8' }] },
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === COURSE,
    actions: {
      start() {},
      resume() {},
      addSource() {},
      onAdvanceStage: payload => { advanceArgs = payload; },
    },
  });
  assert.ok(home80.plan.stageAdvance, 'Home TodayCard surfaces 80% stage-advance suggestion');
  assert.equal(home80.plan.stageAdvance.label, '进入下一阶段：阶段2：MVCC与锁');
  home80.plan.stageAdvance.run();
  assert.deepEqual(advanceArgs, { course: COURSE, courseId: savedCourse.id, targetIndex: 1 });

  const today80Html = plainText(renderToStaticMarkup(inApp(ui, h(ui.TodayCard, { plan: home80.plan, todayLabel: '11月8日' }))));
  assert.match(today80Html, /这一阶段检验已达八成，可以推进/);
  assert.match(today80Html, /进入下一阶段：阶段2：MVCC与锁/);

  const line80Html = plainText(renderToStaticMarkup(inApp(ui, h(ui.MethodLine, { method: at80.focus.method, courseId: savedCourse.id }))));
  assert.match(line80Html, /够进下一阶段了/);
  assert.match(line80Html, /进入下一阶段：阶段2：MVCC与锁/);

  // One-click advance via course.method.save { course, stageIndex: 1 }: Stage 1 is verified (not skipped!)
  const afterAdvance1 = await service.call('course.method.save', { course: COURSE, stageIndex: 1 });
  assert.equal(afterAdvance1.progress.index, 1);
  assert.deepEqual(afterAdvance1.method.skippedStages ?? [], []);
  assert.equal(afterAdvance1.gate.stages[0].status, 'verified');

  // Now learner manually jumps from unfinished Stage 2 (0/6 answered) straight to Stage 3!
  const afterSkip2 = await service.call('course.method.save', { course: COURSE, stageIndex: 2 });
  assert.equal(afterSkip2.progress.index, 2);
  assert.deepEqual(afterSkip2.method.skippedStages, [1], 'unfinished Stage 2 recorded in skippedStages');
  assert.equal(afterSkip2.gate.stages[0].status, 'verified');
  assert.equal(afterSkip2.gate.stages[1].status, 'skipped');

  const rawSkippedState = await service.store.read();
  const skippedCourse = rawSkippedState.courses.find(c => c.name === COURSE);
  const skippedCardHtml = plainText(renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
    course: skippedCourse,
    data: rawSkippedState,
  }), { data: rawSkippedState })));
  assert.match(skippedCardHtml, /已检验/, 'Stage 1 shows 已检验');
  assert.match(skippedCardHtml, /未完成就前进/, 'Stage 2 shows 未完成就前进');
  assert.match(skippedCardHtml, /回到这一阶段/, 'Learner can jump back to any earlier stage at any time');

  // Later, learner answers 4/6 (>= 2/3) of Stage 2's MVCC cards -> skipped marker on Stage 2 auto-clears to verified!
  await service.store.update(state => {
    for (let i = 0; i < 4; i++) {
      state.attempts.push({ id: `mv-att-${i}`, deckId: 'd-mvcc', quiz_id: `mv-${i}`, grade: 4, assessment: 'graded', timestamp: Date.now() });
    }
  });
  const afterCatchUp = await service.call('course.method.get', { name: COURSE });
  assert.equal(stageCheckSatisfied(await service.store.read(), COURSE, skippedCourse.method.stages[1]), true);
  assert.deepEqual(afterCatchUp.progress.skippedStages, [], 'Stage 2 skipped marker auto-cleared once 2/3 check is satisfied');
  assert.equal(afterCatchUp.gate.stages[1].status, 'verified');
});

test('8. Daily study queue (dailyPlan & review.start): custom multi-stage course schedules current stage new cards + ALL stages due and weak cards', async t => {
  const { service } = await createLibrary(t);
  const COURSE = '编译原理';
  const now = Date.now();
  const pastIso = new Date(now - 24 * 3600 * 1000).toISOString();
  const futureIso = new Date(now + 5 * 24 * 3600 * 1000).toISOString();

  await service.call('course.save', {
    name: COURSE,
    method: {
      name: '前端到后端三阶',
      stageIndex: 1,
      stages: [
        { name: '阶段1：词法与语法', activity: 'practice', level: 'medium', scope: { deckIds: ['d-lex'] } },
        { name: '阶段2：SSA与中间表示', activity: 'practice', level: 'medium', scope: { deckIds: ['d-ssa'] } },
        { name: '阶段3：寄存器分配', activity: 'practice', level: 'medium', scope: { deckIds: ['d-reg'] } },
      ],
    },
  });

  await service.store.update(state => {
    state.decks.push(
      {
        id: 'd-lex',
        title: 'Stage 1 Lexer',
        course: COURSE,
        cards: [
          // 2 FSRS due cards from Stage 1
          { ...makeChoiceCard('lex-due-1', 'NFA'), review: { reps: 2, due_at: pastIso, last_grade: 4, stability: 3, difficulty: 5 } },
          { ...makeChoiceCard('lex-due-2', 'DFA'), review: { reps: 2, due_at: pastIso, last_grade: 3, stability: 2, difficulty: 5 } },
          // 1 weak card (not yet due, but latest outcome < 3) from Stage 1
          { ...makeChoiceCard('lex-weak-1', 'LL(1)'), review: { reps: 1, due_at: futureIso, last_grade: 1, stability: 1, difficulty: 7 } },
          // 2 untouched new cards left in Stage 1 (should NOT be pulled while on Stage 2)
          makeChoiceCard('lex-new-1', 'LR(1)'),
          makeChoiceCard('lex-new-2', 'LALR'),
        ],
      },
      {
        id: 'd-ssa',
        title: 'Stage 2 SSA',
        course: COURSE,
        cards: [
          // 3 untouched new cards in current Stage 2 (SHOULD be pulled!)
          makeChoiceCard('ssa-new-1', 'Dominators'),
          makeChoiceCard('ssa-new-2', 'Phi Nodes'),
          makeChoiceCard('ssa-new-3', 'Mem2Reg'),
        ],
      },
      {
        id: 'd-reg',
        title: 'Stage 3 RegAlloc',
        course: COURSE,
        cards: [
          // 1 FSRS due card from Stage 3 + 2 untouched new cards (due SHOULD be kept; new should NOT be pulled!)
          { ...makeChoiceCard('reg-due-1', 'Graph Coloring'), review: { reps: 1, due_at: pastIso, last_grade: 3, stability: 2, difficulty: 5 } },
          makeChoiceCard('reg-new-1', 'Linear Scan'),
          makeChoiceCard('reg-new-2', 'Spilling'),
        ],
      },
    );
    state.attempts.push(
      { id: 'att-ld1', deckId: 'd-lex', quiz_id: 'lex-due-1', grade: 4, assessment: 'graded', timestamp: now - 48 * 3600 * 1000 },
      { id: 'att-ld2', deckId: 'd-lex', quiz_id: 'lex-due-2', grade: 3, assessment: 'graded', timestamp: now - 48 * 3600 * 1000 },
      { id: 'att-lw1', deckId: 'd-lex', quiz_id: 'lex-weak-1', grade: 1, assessment: 'graded', timestamp: now - 3600 * 1000 },
      { id: 'att-rd1', deckId: 'd-reg', quiz_id: 'reg-due-1', grade: 3, assessment: 'graded', timestamp: now - 48 * 3600 * 1000 },
    );
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });

  const rawState = await service.store.read();
  const daily = dailyPlan(rawState, { now });
  assert.equal(daily.plan.counts.due, 3, 'keeps ALL FSRS due cards across Stage 1 (2) and Stage 3 (1)');
  assert.equal(daily.plan.counts.weak, 1, 'keeps weak card from Stage 1');
  assert.equal(daily.plan.counts.new, 3, 'pulls ONLY the 3 new cards from current Stage 2 (excluding Stage 1 and Stage 3 new cards)');
  assert.equal(daily.plan.entries.length, 7);

  const plannedIds = daily.plan.entries.map(entry => entry.card.id);
  assert.deepEqual(
    plannedIds,
    ['lex-due-1', 'lex-due-2', 'reg-due-1', 'lex-weak-1', 'ssa-new-1', 'ssa-new-2', 'ssa-new-3'],
  );

  // Verify review.start { mode: 'path', course, daily: true } uses courseDailyPlan identically
  const dailyRun = await service.call('review.start', { mode: 'path', course: COURSE, daily: true, fresh: true });
  assert.equal(dailyRun.total, 7);
  assert.equal(dailyRun.card.id, 'lex-due-1');
  const directCourseDaily = courseDailyPlan(rawState, COURSE, latestOutcomes(rawState.attempts), { now, ...roundOptions(rawState) });
  assert.equal(directCourseDaily.plan.entries.length, 7);
});

test('9. Study plan date integration (course.plan & targetDate): per-stage suggested dates and single calm behind-schedule line without modals or in-app lecture steps', () => {
  const COURSE = '机器学习';
  const courseWithPlan = {
    id: 'c-ml',
    name: COURSE,
    exam: { date: '2026-11-30' },
    plan: {
      version: 1,
      status: 'active',
      by: 'exam',
      studyWeekdays: [1, 2, 3, 4, 5],
      restDates: ['2026-11-11'],
      phases: [
        { name: '线性模型与优化', until: '2026-11-05' },
        { name: '树模型与集成', until: '2026-11-15' },
        { name: '神经网络与正则化', until: '2026-11-28' },
      ],
    },
    method: checkedMethod({
      name: '三阶冲刺',
      stages: [
        { name: '阶段1：凸优化与回归', activity: 'explain', alternatives: ['practice'], level: 'medium' },
        { name: '阶段2：GBDT推导', activity: 'practice', level: 'medium' },
        { name: '阶段3：模拟冲刺', activity: 'review', level: 'medium' },
      ],
    }),
  };

  const stateIncomplete = {
    courses: [courseWithPlan],
    sources: [{ id: 's-ml', courses: [COURSE], text: 'Gradient descent updates parameters opposite the gradient. '.repeat(5) }],
    decks: [{ id: 'd-ml', course: COURSE, cards: Array.from({ length: 6 }, (_, i) => makeChoiceCard(`ml-${i}`, 'Optimization')) }],
    attempts: [],
  };

  // Both course object and course string name work seamlessly in methodStageSchedule
  const onTime = methodStageSchedule(stateIncomplete, courseWithPlan, { today: '2026-11-04' });
  assert.deepEqual(onTime.stages.map(s => s.suggestedUntil), ['2026-11-05', '2026-11-15', '2026-11-28']);
  assert.equal(onTime.behind, false);
  assert.equal(onTime.daysBehind, 0);

  // On 2026-11-08 (3 days past 2026-11-05 while Stage 1 is incomplete): behind === true
  const behind = methodStageSchedule(stateIncomplete, COURSE, { today: '2026-11-08' });
  assert.equal(behind.behind, true);
  assert.equal(behind.daysBehind, 3);
  assert.equal(behind.currentSuggestedUntil, '2026-11-05');

  // Once Stage 1 reaches 80% ready (>= 5/6 right), behind flips back to false even on 2026-11-08!
  const stateSatisfied = {
    ...stateIncomplete,
    attempts: Array.from({ length: 5 }, (_, i) => ({ deckId: 'd-ml', quiz_id: `ml-${i}`, grade: 4 })),
  };
  const caughtUp = methodStageSchedule(stateSatisfied, COURSE, { today: '2026-11-08' });
  assert.equal(caughtUp.behind, false);

  // Fallback to method.targetDate when no explicit plan phases or exam date exist
  const courseTargetOnly = {
    id: 'c-self',
    name: 'Rust 自学',
    method: checkedMethod({
      name: '所有权两步走',
      targetDate: '2026-11-20',
      updatedAt: '2026-11-01T00:00:00Z',
      stages: [
        { name: '所有权与借用', activity: 'explain', level: 'medium' },
        { name: '生命周期与并发', activity: 'practice', level: 'medium' },
      ],
    }),
  };
  const targetSched = methodStageSchedule({ courses: [courseTargetOnly], sources: [], decks: [], attempts: [] }, courseTargetOnly, { today: '2026-11-02' });
  assert.equal(targetSched.basis, 'targetDate');
  assert.equal(targetSched.stages.length, 2);
  assert.ok(targetSched.stages[0].suggestedUntil <= targetSched.stages[1].suggestedUntil);
  assert.equal(targetSched.stages[1].suggestedUntil, '2026-11-20');

  // Render CourseMethodCard when behind schedule: calm single line, zero modals/dialogs/alerts, zero in-app lecture/retell/summary steps
  ui.setUiLanguage('zh');
  const prog = methodProgress(stateIncomplete, COURSE);
  const gate = stageGate(stateIncomplete, COURSE, prog);
  const behindHtml = renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
    course: courseWithPlan,
    readout: { ...prog, gate, schedule: behind },
    data: stateIncomplete,
  }), { data: stateIncomplete }));
  const behindText = plainText(behindHtml);
  assert.match(behindText, /建议 2026-11-05 前/);
  assert.match(behindText, /建议 2026-11-15 前/);
  assert.match(behindText, /建议 2026-11-28 前/);
  assert.equal((behindHtml.match(/course-method__behind/g) || []).length, 1, 'exactly one calm behind-schedule line');
  assert.match(behindText, /当前阶段比建议日期（2026-11-05）慢了一点，按自己的节奏往前推就好/);
  assert.doesNotMatch(behindHtml, /role="alert"|role="dialog"|sh-modal|sh-dialog/, 'never pops up a modal or alert banner');
  assert.doesNotMatch(behindText, /应用内讲解|复述练习|写总结/, 'never rebuilds lecture/retell/summary steps inside the app');
});

test('10. End-to-end Java + AI job-prep walkthrough and zero-Han English UI verification across all S3 surfaces', async t => {
  const { service } = await createLibrary(t);
  const COURSE = 'Java Backend Interview';
  const saved = await service.call('course.save', {
    name: COURSE,
    exam: { date: '2026-12-15' },
    plan: {
      version: 1,
      status: 'active',
      by: 'exam',
      phases: [
        { name: 'Collections & JUC', until: '2026-11-01' },
        { name: 'JVM & MySQL', until: '2026-11-20' },
        { name: 'RAG & Agent Project', until: '2026-12-10' },
      ],
    },
    method: {
      name: 'Three-Stage Sprint',
      stages: [
        { name: 'Collections & JUC', activity: 'explain', alternatives: ['practice'], level: 'medium', scope: { deckIds: ['d-s1'] } },
        { name: 'JVM & MySQL', activity: 'practice', alternatives: ['explain'], level: 'medium', scope: { deckIds: ['d-s2'] } },
        { name: 'RAG & Agent Project', activity: 'project', alternatives: ['check'], level: 'medium', scope: { deckIds: ['d-s3'] } },
      ],
    },
  });

  await service.call('source.add', {
    id: 'src-en-1',
    title: 'JUC & JVM Notes',
    text: 'ConcurrentHashMap uses CAS and per-bin synchronization; G1 divides the heap into regions. '.repeat(4),
    courses: [COURSE],
  });

  const nowMs = Date.now();
  await service.store.update(state => {
    state.decks.push(
      { id: 'd-s1', title: 'JUC Set', course: COURSE, cards: Array.from({ length: 5 }, (_, i) => makeChoiceCard(`s1-${i}`, 'JUC', `How does lock ${i} work?`)) },
      { id: 'd-s2', title: 'JVM Set', course: COURSE, cards: Array.from({ length: 5 }, (_, i) => makeChoiceCard(`s2-${i}`, 'JVM', `How does region ${i} work?`)) },
      { id: 'd-s3', title: 'RAG Set', course: COURSE, cards: Array.from({ length: 5 }, (_, i) => makeChoiceCard(`s3-${i}`, 'RAG', `How does chunking ${i} work?`)) },
    );
    // Stage 1: 4/5 right (80% -> ready!) + 1 self-reported on s1-4
    for (let i = 0; i < 4; i++) {
      state.attempts.push({ id: `en-a-${i}`, deckId: 'd-s1', quiz_id: `s1-${i}`, grade: 4, assessment: 'graded', timestamp: nowMs });
    }
    state.attempts.push({ id: 'en-a-self', deckId: 'd-s1', quiz_id: 's1-4', grade: 4, assessment: 'self-report', timestamp: nowMs });
    state.focus = { mode: 'class', course: COURSE, role: 'Backend Engineer', jd: '', targetTopics: [] };
  });

  ui.setUiLanguage('en');
  try {
    const snap = await service.call('snapshot', { compact: true });
    assert.equal(snap.focus.method.gate.ready, true);

    // 1) Home TodayCard + MethodLine in English (80% stage-advance suggestion)
    const homeEn = ui.buildHomePlan({
      data: snap,
      today: { course: COURSE, due: 0, weak: 0, new: 1, size: 1, scope: [{ deckId: 'd-s1', cardId: 's1-4' }] },
      runs: [],
      runFor: () => null,
      activeJobs: [],
      inFocus: c => c === COURSE,
      actions: { start() {}, resume() {}, addSource() {} },
    });
    const todayEnText = plainText(renderToStaticMarkup(inApp(ui, h(ui.TodayCard, { plan: homeEn.plan, todayLabel: 'Sun, Nov 8' }))));
    assert.match(todayEnText, /Check reached 80% — ready to advance:/);
    assert.match(todayEnText, /Next stage: JVM & MySQL/);
    assert.doesNotMatch(todayEnText, han);

    const lineEnText = plainText(renderToStaticMarkup(inApp(ui, h(ui.MethodLine, { method: snap.focus.method, courseId: saved.id }))));
    assert.match(lineEnText, /Enough for the next stage/);
    assert.match(lineEnText, /Next stage: JVM & MySQL/);
    assert.doesNotMatch(lineEnText, han);

    // 2) Jump from Stage 1 -> Stage 2 (marks Stage 1 Verified) -> skip Stage 2 to Stage 3 (marks Stage 2 Moved on before finishing)
    await service.call('course.method.save', { course: COURSE, stageIndex: 1 });
    await service.call('course.method.save', { course: COURSE, stageIndex: 2 });
    // Add 1 missed attempt + 1 self-report attempt on Stage 3 so CourseMethodCard renders Verified, Moved on before finishing, Self-reported, Behind schedule, and Take missed questions to main chat all at once!
    await service.store.update(state => {
      state.attempts.push(
        { id: 's3-miss', deckId: 'd-s3', quiz_id: 's3-0', grade: 1, assessment: 'graded', timestamp: nowMs },
        { id: 's3-self', deckId: 'd-s3', quiz_id: 's3-1', grade: 4, assessment: 'self-report', timestamp: nowMs },
      );
    });

    const rawEn = await service.store.read();
    const courseEn = rawEn.courses.find(c => c.name === COURSE);
    const progEn = methodProgress(rawEn, COURSE);
    const gateEn = stageGate(rawEn, COURSE, progEn);
    const schedEn = methodStageSchedule(rawEn, courseEn, { today: '2026-12-12', progress: progEn, gate: gateEn });

    const methodCardEnHtml = renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
      course: courseEn,
      readout: { ...progEn, gate: gateEn, schedule: schedEn },
      data: rawEn,
    }), { data: rawEn }));
    const methodCardEnText = plainText(methodCardEnHtml);
    assert.match(methodCardEnText, /Verified/);
    assert.match(methodCardEnText, /Moved on before finishing/);
    assert.match(methodCardEnText, /Self-reported/);
    assert.match(methodCardEnText, /Suggested by 2026-11-01/);
    assert.match(methodCardEnText, /A little past the suggested date \(2026-12-10\)/);
    assert.match(methodCardEnText, /Take missed questions to main chat/);
    assert.match(methodCardEnText, /Return to this stage/);
    assert.doesNotMatch(methodCardEnText, han, `CourseMethodCard English contains zero Han: ${methodCardEnText}`);

    // 3) GuidedStudyWorkbench + StudyProgressPanel in English
    const guidedProgressEn = computeSessionProgress(
      {
        createdAt: nowMs - 60_000,
        goal: {
          checkItems: [
            { id: 'c0', title: 'Chunking', targetCardIds: ['s3-0'] },
            { id: 'c1', title: 'Reranking', targetCardIds: ['s3-1'] },
          ],
        },
        artifactRefs: [],
      },
      rawEn.attempts,
    );
    const workbenchEnHtml = renderToStaticMarkup(inApp(ui, h(ui.GuidedStudyWorkbench, {
      session: { id: 'gs-en', courseId: COURSE, status: 'active', goal: { title: 'RAG Pipeline', checkItems: [] } },
      progress: guidedProgressEn,
      estimate: { status: 'estimating' },
      run: { id: 'r-en', deckId: 'd-s3', card: makeChoiceCard('s3-0', 'RAG', 'How does chunking 0 work?'), revealed: true, feedback: { correct: false, grade: 1 } },
    })));
    const workbenchEnText = plainText(workbenchEnHtml);
    assert.match(workbenchEnText, /1 self-reported/);
    assert.match(workbenchEnText, /Take missed questions to main chat/);
    assert.doesNotMatch(workbenchEnText, han, `GuidedStudyWorkbench English contains zero Han: ${workbenchEnText}`);

    const panelEnText = plainText(renderToStaticMarkup(h(ui.StudyProgressPanel, {
      progress: guidedProgressEn,
      estimate: { status: 'estimating' },
      defaultExpanded: true,
    })));
    assert.match(panelEnText, /Self-reported/);
    assert.doesNotMatch(panelEnText, han, `StudyProgressPanel English contains zero Han: ${panelEnText}`);

    // 4) Review round summary with missed hand-off in English
    const reviewEnHtml = renderToStaticMarkup(reviewElement(ui.Review, ui.StudyServicesContext, {
      run: {
        id: 'r-sum-en',
        mode: 'path',
        complete: true,
        index: 3,
        total: 3,
        questions: 3,
        answered: 3,
        correct: 1,
        selfAnswered: 0,
        weakTopics: ['RAG'],
        weakScopes: { RAG: [{ deckId: 'd-s3', topic: 'RAG' }] },
        missedCards: [{ cardId: 's3-0', deckId: 'd-s3', topic: 'RAG', prompt: 'How does chunking 0 work?' }],
        scope: [{ deckId: 'd-s3' }],
        card: makeChoiceCard('s3-0', 'RAG', 'How does chunking 0 work?'),
      },
      data: { ...rawEn, settings: {} },
      shellTitle: "Today's study",
      coachProps: {
        debrief: {
          headline: 'Good effort on this batch.',
          why: '3 questions finished.',
          next: 'continue_path',
          insights: [],
          metrics: { answered: 3, gradedAnswered: 3, gradedCorrect: 1 },
          status: { enabled: true, consent: false, ready: 0 },
        },
        autopilot: false,
        onPractice() {},
        onContinue() {},
        onReviewWeak() {},
        destination: { kind: 'path', reason: 'continuing', label: 'Continue studying →', go() {}, note: '' },
      },
    }));
    const reviewEnText = plainText(reviewEnHtml);
    assert.match(reviewEnText, /Take missed questions to main chat/);
    assert.doesNotMatch(reviewEnText, han, `Review English contains zero Han: ${reviewEnText}`);

    // 5) English hand-off prompt for method.missed contains zero UI leakage and preserves learner fields
    const missedEnPrompt = ui.handOffText('method.missed', {
      course: COURSE,
      stage: 'RAG & Agent Project',
      missed: [{ prompt: 'How does chunking 0 work?', topic: 'RAG' }],
    });
    assert.match(missedEnPrompt, /return to StudyHub to take the check questions/i);
    assert.doesNotMatch(missedEnPrompt, han);
  } finally {
    ui.setUiLanguage('zh');
  }

  // Also test pure clampMethodStageIndices when stages are removed
  const shrunk = clampMethodStageIndices({
    ...CLASSROOM_METHOD,
    name: 'Shrunk',
    stageIndex: 5,
    skippedStages: [0, 2, 4],
    selfReportedStages: [1, 3],
    stages: [{ name: 'Only One', activity: 'practice', level: 'medium' }],
  });
  assert.equal(shrunk.stageIndex, 0, 'stageIndex 5 clamps to last valid stage 0');
  assert.deepEqual(shrunk.skippedStages, [0]);
  assert.equal(shrunk.selfReportedStages, undefined);
  const advanced = advanceMethodStage({
    name: 'Two',
    stages: [{ name: 'A', activity: 'explain', level: 'medium' }, { name: 'B', activity: 'practice', level: 'medium' }],
  }, 1, { currentIndex: 0, stageSatisfied: () => false });
  assert.equal(advanced.stageIndex, 1);
  assert.deepEqual(advanced.skippedStages, [0]);
});
