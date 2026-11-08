import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build as esbuild } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { CASE_FORMAT } from '../lib/case-study.js';
import {
  CLASSROOM_METHOD,
  advanceMethodStage,
  checkedMethod,
  clampMethodStageIndices,
  remapMethodOnStageMove,
  remapMethodOnStageRemove,
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
import { nativeSelects } from './helpers/native-selects.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { reviewElement } from './helpers/review-render.mjs';

const SKILL_TUTOR_PATH = new URL('../skills/study-tutor/SKILL.md', import.meta.url);

const ui = await loadUi(`
  export {
    default as CourseMethodCard,
    stageNeedsMaterial,
    checkLine,
    MethodForm,
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


const nodeRequire = createRequire(import.meta.url);

async function createStatefulMethodHarness() {
  const compiled = await esbuild({
    stdin: {
      contents: `
        export { default as CourseMethodCard, MethodForm } from './ui/CourseMethodCard.jsx';
        export { AppContext } from './ui/app/app-context.js';
        export { StudyServicesContext } from './ui/study-context.jsx';
        export { setUiLanguage } from './ui/i18n.js';
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: [
      'react', 'react-dom', 'react/*', 'react-dom/*',
      '@codemirror/*', '@lezer/*', '@base-ui/*',
      'markdown-it', 'markdown-it-texmath', 'dompurify',
      'katex', 'katex/*', 'parse5', 'pdf-lib', 'yaml', 'schemastery', 'proper-lockfile',
    ],
    plugins: [nativeSelects],
    loader: { '.css': 'text' },
    logLevel: 'silent',
  });
  let active = null;
  let activeCtx = { study: null, app: null };
  let studyCtxRef = null;
  let appCtxRef = null;
  const readSlot = init => {
    const idx = active.cursor++;
    if (!(idx in active.slots)) active.slots[idx] = init();
    return [idx, active.slots[idx]];
  };
  const hooks = {
    ...React,
    useState(initial) {
      if (!active) return React.useState(initial);
      const owner = active;
      const [idx, val] = readSlot(() => (typeof initial === 'function' ? initial() : initial));
      return [val, next => { owner.slots[idx] = typeof next === 'function' ? next(owner.slots[idx]) : next; }];
    },
    useRef(initial) {
      if (!active) return React.useRef(initial);
      return readSlot(() => ({ current: initial }))[1];
    },
    useId() {
      if (!active) return React.useId();
      return readSlot(() => `m-id-${active.cursor}`)[1];
    },
    useCallback(fn, deps) {
      return active ? fn : React.useCallback(fn, deps);
    },
    useMemo(fn, deps) {
      return active ? fn() : React.useMemo(fn, deps);
    },
    useInsertionEffect() {},
    useContext(ctx) {
      if (!active) return React.useContext(ctx);
      if (ctx === studyCtxRef) return activeCtx.study;
      if (ctx === appCtxRef) return activeCtx.app;
      return React.useContext(ctx);
    },
    useEffect(cb, deps) {
      if (!active) { React.useEffect(cb, deps); return; }
      const [, slot] = readSlot(() => ({ deps: undefined, cleanup: null }));
      const changed = !slot.deps || !deps || deps.length !== slot.deps.length || deps.some((v, i) => !Object.is(v, slot.deps[i]));
      if (changed) {
        active.effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = cb() || null;
        });
        slot.deps = deps;
      }
    },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(
    id => (id === 'react' ? hooks : nodeRequire(id)),
    mod,
    mod.exports,
  );
  const components = mod.exports;
  studyCtxRef = components.StudyServicesContext;
  appCtxRef = components.AppContext;

  const mapExpanded = (node, formOwner, ctxPair) => {
    if (!node || typeof node !== 'object') return node;
    if (node.type === components.MethodForm) {
      formOwner.cursor = 0;
      active = formOwner;
      activeCtx = ctxPair;
      try {
        return components.MethodForm(node.props);
      } finally {
        active = null;
      }
    }
    if (!node.props?.children) return node;
    const kids = React.Children.toArray(node.props.children);
    let mutated = false;
    const mapped = kids.map(child => {
      const next = mapExpanded(child, formOwner, ctxPair);
      if (next !== child) mutated = true;
      return next;
    });
    return mutated ? React.cloneElement(node, node.props, ...mapped) : node;
  };

  function findNode(tree, predicate) {
    if (!tree || typeof tree !== 'object') return null;
    if (predicate(tree)) return tree;
    for (const child of React.Children.toArray(tree.props?.children)) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }

  function mount({ course, readout = null, data = null, call, act, busy = false }) {
    let props = { course, readout, data };
    let studyCall = call || (async () => ({}));
    let studyAct = act || (async () => undefined);
    const rootOwner = { cursor: 0, slots: [], effects: [] };
    const formOwner = { cursor: 0, slots: [], effects: [] };

    const makeCtx = () => {
      const wrapped = inApp(components, h('div'), { data: props.data, call: studyCall, act: studyAct, busy });
      return {
        study: wrapped.props.value,
        app: wrapped.props.children.props.value,
      };
    };

    const renderTree = (patch = {}) => {
      if ('call' in patch) { studyCall = patch.call; delete patch.call; }
      if ('act' in patch) { studyAct = patch.act; delete patch.act; }
      props = { ...props, ...patch };
      const ctxPair = makeCtx();
      rootOwner.cursor = 0;
      active = rootOwner;
      activeCtx = ctxPair;
      let raw;
      try {
        raw = components.CourseMethodCard(props);
      } finally {
        active = null;
      }
      return mapExpanded(raw, formOwner, ctxPair);
    };

    return {
      render: renderTree,
      async flushEffects() {
        for (const owner of [rootOwner, formOwner]) {
          owner.effects.splice(0).forEach(fn => fn());
        }
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
      },
      html(patch = {}) {
        const tree = renderTree(patch);
        return renderToStaticMarkup(inApp(components, tree, { data: props.data, call: studyCall, act: studyAct, busy }));
      },
      findButton(labelOrMatcher) {
        const tree = renderTree();
        return findNode(tree, node => {
          if (typeof node.props?.onClick !== 'function') return false;
          const textCandidate = typeof node.props.children === 'string'
            ? node.props.children
            : (typeof node.props.label === 'string' ? node.props.label : '');
          return typeof labelOrMatcher === 'function' ? labelOrMatcher(textCandidate, node) : textCandidate === labelOrMatcher;
        });
      },
      unmount() {
        for (const owner of [rootOwner, formOwner]) {
          owner.slots.forEach(slot => slot?.cleanup?.());
        }
      },
    };
  }

  return { components, mount, findNode };
}

test('11. Non-focused course in CourseSettings uses authoritative course.method.get instead of stripped compact snapshot and preserves verified stages on jump (Blocking #1 + Minor #6)', async t => {
  const { service } = await createLibrary(t);
  const FOCUSED = 'Focused Systems';
  const OTHER = 'Non-Focused Compilers';

  await service.call('course.save', { name: FOCUSED });
  const savedOther = await service.call('course.save', {
    name: OTHER,
    exam: { date: '2026-12-30' },
    plan: {
      version: 1,
      status: 'active',
      by: 'exam',
      phases: [
        { name: 'Lexing & Parsing', until: '2000-01-01' },
        { name: 'SSA & Register Alloc', until: '2026-12-10' },
        { name: 'Codegen Review', until: '2026-12-28' },
      ],
    },
    method: {
      name: '编译器三步走',
      stages: [
        { name: '词法与语法', activity: 'explain', level: 'medium', scope: { deckIds: ['d-nf-1'] } },
        { name: 'SSA 优化', activity: 'practice', level: 'medium', scope: { deckIds: ['d-nf-2'] } },
        { name: '冲刺复盘', activity: 'review', level: 'medium', scope: { deckIds: ['d-nf-3'] } },
      ],
    },
  });

  await service.call('source.add', {
    id: 'src-nf-1',
    title: 'Dragon Book Notes',
    text: 'LL(1) parsers construct predictive parsing tables from FIRST and FOLLOW sets. '.repeat(5),
    courses: [OTHER],
  });

  const nowMs = Date.now();
  await service.store.update(state => {
    state.decks.push(
      { id: 'd-focus-1', title: 'Focus Set', course: FOCUSED, cards: [makeChoiceCard('fc-0', 'Focus')] },
      { id: 'd-nf-1', title: 'Parsing Set', course: OTHER, cards: Array.from({ length: 5 }, (_, i) => makeChoiceCard(`nf1-${i}`, 'Parsing')) },
      { id: 'd-nf-2', title: 'SSA Set', course: OTHER, cards: Array.from({ length: 5 }, (_, i) => makeChoiceCard(`nf2-${i}`, 'SSA')) },
      { id: 'd-nf-3', title: 'Codegen Set', course: OTHER, cards: Array.from({ length: 5 }, (_, i) => makeChoiceCard(`nf3-${i}`, 'Codegen')) },
    );
    // Stage 0 has 4/5 verified right (80% -> ready & stageCheckSatisfied === true!)
    for (let i = 0; i < 4; i++) {
      state.attempts.push({ id: `nf-att-${i}`, deckId: 'd-nf-1', quiz_id: `nf1-${i}`, grade: 4, assessment: 'graded', timestamp: nowMs });
    }
    state.focus = { mode: 'class', course: FOCUSED, role: '', jd: '', targetTopics: [] };
  });

  // Compact snapshot strips deck.cards and source.text, and focus.method belongs to FOCUSED (so readout is null for OTHER)
  const compact = await service.call('snapshot', { compact: true });
  assert.equal(compact.focus.course, FOCUSED);
  const strippedDeck = compact.decks.find(d => d.id === 'd-nf-1');
  assert.equal(strippedDeck.cards, undefined, 'compact snapshot strips deck.cards');
  assert.equal(compact.sources.find(s => s.id === 'src-nf-1').text, undefined, 'compact snapshot strips source.text');
  const compactOtherCourse = compact.courses.find(c => c.name === OTHER);

  const methodCalls = [];
  const actCalls = [];
  const harness = await createStatefulMethodHarness();
  harness.components.setUiLanguage('zh');
  const card = harness.mount({
    course: compactOtherCourse,
    readout: null,
    data: compact,
    call: async (op, args) => {
      methodCalls.push([op, args]);
      return service.call(op, args);
    },
    act: async (op, args) => {
      actCalls.push([op, args]);
      return service.call(op, args);
    },
  });
  t.after(() => card.unmount());

  // 1) Initial render BEFORE async course.method.get resolves: must NOT compute bogus 0-card fallback on stripped snapshot!
  const beforeEffectText = plainText(card.html());
  assert.doesNotMatch(beforeEffectText, /这一阶段还没有题/, 'stripped snapshot never flashes false 0-question check line');
  assert.doesNotMatch(beforeEffectText, /慢了一点/, 'stripped snapshot never flashes false behind-schedule warning on a verified stage');
  assert.doesNotMatch(beforeEffectText, /还没有资料/, 'stripped snapshot with chars > 0 never flashes false missing-material prompt');

  // 2) Flush useLiveEffect -> course.method.get hydrates authoritative progress, gate, and schedule
  await card.flushEffects();
  assert.equal(methodCalls.length, 1);
  assert.equal(methodCalls[0][0], 'course.method.get');
  assert.equal(methodCalls[0][1].course, OTHER);
  assert.equal(methodCalls[0][1].id, savedOther.id);

  const directGet = await service.call('course.method.get', { id: savedOther.id, course: OTHER });
  assert.ok(directGet.schedule, 'course.method.get returns authoritative schedule for custom-method courses');
  assert.equal(directGet.schedule.behind, false, 'stage 0 at 4/5 (80%) is satisfied so behind === false even past 2000-01-01');

  const hydratedHtml = card.html();
  const hydratedText = plainText(hydratedHtml);
  assert.match(hydratedText, /这一阶段：5 道里答对 4 道，够进下一阶段了。/);
  assert.match(hydratedText, /建议 2000-01-01 前/);
  assert.doesNotMatch(hydratedText, /慢了一点/, 'authoritative schedule knows Stage 0 is satisfied');
  assert.match(hydratedText, /进入下一阶段：SSA 优化/);

  // 3) Jumping from Stage 0 -> Stage 1 delegates to backend course.method.save and NEVER corrupts verified Stage 0 into skippedStages!
  const advanceBtn = card.findButton('进入下一阶段：SSA 优化');
  assert.ok(advanceBtn, 'hydrated non-focused card exposes stage advance button');
  await advanceBtn.props.onClick();

  assert.equal(actCalls.length, 1);
  assert.equal(actCalls[0][0], 'course.method.save', 'jumpToStage delegates to backend course.method.save');
  assert.deepEqual(actCalls[0][1], { id: savedOther.id, course: OTHER, stageIndex: 1 });

  const gotAfterJump = await service.call('course.get', { name: OTHER });
  const afterJump = gotAfterJump?.course ?? gotAfterJump;
  assert.equal(afterJump.method.stageIndex, 1);
  assert.equal(afterJump.method.skippedStages, undefined, 'verified Stage 0 is NOT corrupted into skippedStages');

  const afterJumpText = plainText(card.html({ course: afterJump }));
  assert.match(afterJumpText, /已检验/, 'Stage 0 renders as 已检验 (Verified)');
  assert.doesNotMatch(afterJumpText, /未完成就前进/, 'zero false skipped badge');

  // 4) Minor #6: course.method.save forwards selfReported: true to advanceMethodStage
  const selfAdvance = await service.call('course.method.save', {
    course: OTHER,
    stageIndex: 2,
    selfReported: true,
  });
  assert.equal(selfAdvance.method.stageIndex, 2);
  assert.deepEqual(selfAdvance.method.selfReportedStages, [1], 'unverified Stage 1 advanced with selfReported: true records selfReportedStages: [1]');
  assert.equal(selfAdvance.method.skippedStages, undefined, 'selfReported advance does not mark Stage 1 as skipped');
});

test('12. Case/rubric stage passing (> 50%) with weak criterion (< 60%) keeps case.drills visible, and dynamic stage-advance buttons carry wrap (Major #2 + Minor #5)', async t => {
  const { service } = await createLibrary(t);
  const COURSE = 'System Design Cases';
  const NEXT_STAGE_TITLE = '第二阶段：高并发限流与熔断恢复演练';
  const saved = await service.call('course.save', {
    name: COURSE,
    method: {
      name: '案例实战两步法',
      stages: [
        { name: '第一阶段：案例拆解', activity: 'project', level: 'medium', scope: { deckIds: ['d-case-m2'] } },
        { name: NEXT_STAGE_TITLE, activity: 'practice', level: 'medium', scope: { deckIds: ['d-drill-m2'] } },
      ],
    },
  });

  await service.call('source.add', {
    id: 'src-case-m2',
    title: 'Rate Limiter Case',
    text: 'Token bucket and leaky bucket trade burst tolerance against smooth egress rate. '.repeat(5),
    courses: [COURSE],
  });

  const makeCaseCard = id => ({
    id,
    kind: 'short',
    topic: 'Rate Limiting',
    prompt: `Design rate limiter scenario ${id}`,
    answer: 'Token bucket with Redis Lua atomic script and local fallback.',
    criteria: [
      { id: 'c-algo', point: 'Algorithm selection', max: 2 },
      { id: 'c-failover', point: 'Redis failure degradation', max: 2 },
    ],
  });

  const nowMs = Date.now();
  await service.store.update(state => {
    state.decks.push(
      { id: 'd-case-m2', title: 'Limiter Cases', course: COURSE, format: CASE_FORMAT, case: { title: 'Rate Limiter', background: 'Gateway burst control' }, cards: [makeCaseCard('c1'), makeCaseCard('c2'), makeCaseCard('c3')] },
      { id: 'd-drill-m2', title: 'Limiter Drills', course: COURSE, cards: [makeChoiceCard('dr1', 'Rate Limiting')] },
    );
    // Answer 2 of 3 case cards at 2.5 / 4 = 62.5% (> 50% -> rubricAttemptPassed === true!),
    // with c-failover scoring 0.5 / 2 = 25% (< 60% -> weakCaseDeckId === 'd-case-m2')!
    for (const cardId of ['c1', 'c2']) {
      state.attempts.push({
        id: `att-${cardId}`,
        deckId: 'd-case-m2',
        quiz_id: cardId,
        grade: 3,
        assessment: 'rubric',
        score: 2.5,
        maxScore: 4,
        rubric: {
          total: 2.5,
          max: 4,
          criteria: [
            { id: 'c-algo', point: 'Algorithm selection', score: 2, max: 2 },
            { id: 'c-failover', point: 'Redis failure degradation', score: 0.5, max: 2 },
          ],
        },
        timestamp: nowMs,
      });
    }
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });

  // Case A: 2/3 answered right -> checkPassed === true (2 >= ceil(3 * 2/3)), ready === false (2 < ceil(3 * 0.8) = 3), missed.length === 0, weakCaseDeckId === 'd-case-m2'
  const stateA = await service.store.read();
  const progA = methodProgress(stateA, COURSE);
  const gateA = stageGate(stateA, COURSE, progA);
  assert.equal(gateA.checkPassed, true, '2/3 rubric cards > 50% passes 2/3 check threshold');
  assert.equal(gateA.ready, false, '2/3 is below 80% advance threshold');
  assert.equal(gateA.missed.length, 0, 'no answered card failed');
  assert.equal(gateA.weakCaseDeckId, 'd-case-m2', 'c-failover at 25% < 60% flags weakCaseDeckId');

  const drillCalls = [];
  const harness = await createStatefulMethodHarness();
  harness.components.setUiLanguage('zh');
  const cardA = harness.mount({
    course: stateA.courses.find(c => c.name === COURSE),
    readout: { ...progA, gate: gateA },
    data: stateA,
    act: async (op, args) => { drillCalls.push([op, args]); },
  });
  t.after(() => cardA.unmount());

  const htmlA = cardA.html();
  assert.match(plainText(htmlA), /把薄弱项变成练习/, 'case.drills button stays visible when checkPassed === true and ready === false');
  const drillBtn = cardA.findButton('把薄弱项变成练习');
  assert.ok(drillBtn);
  await drillBtn.props.onClick();
  assert.deepEqual(drillCalls, [['case.drills', { deckId: 'd-case-m2' }]]);

  // Case B: Answer c3 at 2.5/4 too -> 3/3 (100% >= 80%) so BOTH ready === true AND checkPassed === true AND weakCaseDeckId === 'd-case-m2'
  await service.store.update(state => {
    state.attempts.push({
      id: 'att-c3',
      deckId: 'd-case-m2',
      quiz_id: 'c3',
      grade: 3,
      assessment: 'rubric',
      score: 2.5,
      maxScore: 4,
      rubric: {
        total: 2.5,
        max: 4,
        criteria: [
          { id: 'c-algo', point: 'Algorithm selection', score: 2, max: 2 },
          { id: 'c-failover', point: 'Redis failure degradation', score: 0.5, max: 2 },
        ],
      },
      timestamp: nowMs + 1000,
    });
  });

  const stateB = await service.store.read();
  const progB = methodProgress(stateB, COURSE);
  const gateB = stageGate(stateB, COURSE, progB);
  assert.equal(gateB.checkPassed, true);
  assert.equal(gateB.ready, true);
  assert.equal(gateB.weakCaseDeckId, 'd-case-m2');

  ui.setUiLanguage('zh');
  const cardBZhHtml = renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
    course: stateB.courses.find(c => c.name === COURSE),
    readout: { ...progB, gate: gateB },
    data: stateB,
  }), { data: stateB }));
  assert.match(plainText(cardBZhHtml), /进入下一阶段：第二阶段：高并发限流与熔断恢复演练/);
  assert.match(plainText(cardBZhHtml), /把薄弱项变成练习/, 'case.drills stays visible alongside 80% advance button');

  // Minor #5: verify sh-btn--wrap on all three dynamic `进入下一阶段：{0}` buttons (CourseMethodCard, TodayCard, MethodLine)
  const snapB = await service.call('snapshot', { compact: true });
  const homeB = ui.buildHomePlan({
    data: snapB,
    today: { course: COURSE, due: 0, weak: 0, new: 0, size: 0, scope: [] },
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: c => c === COURSE,
    actions: { start() {}, resume() {}, addSource() {} },
  });
  const todayBHtml = renderToStaticMarkup(inApp(ui, h(ui.TodayCard, { plan: homeB.plan, todayLabel: '周日' })));
  const lineBHtml = renderToStaticMarkup(inApp(ui, h(ui.MethodLine, { method: snapB.focus.method, courseId: saved.id })));

  for (const [surfaceName, markup] of [
    ['CourseMethodCard', cardBZhHtml],
    ['TodayCard', todayBHtml],
    ['MethodLine', lineBHtml],
  ]) {
    const btnMatch = markup.match(/<button[^>]*>[^<]*进入下一阶段：[^<]*<\/button>/);
    assert.ok(btnMatch, `${surfaceName} renders 进入下一阶段 button`);
    assert.match(btnMatch[0], /\bsh-btn--wrap\b/, `${surfaceName} dynamic 进入下一阶段 button carries sh-btn--wrap`);
  }

  // Also verify zero-Han in English when case.drills + Next stage render together
  const englishCourse = {
    ...stateB.courses.find(c => c.name === COURSE),
    method: {
      ...stateB.courses.find(c => c.name === COURSE).method,
      name: 'Two-Step Case Method',
      stages: [
        { name: 'Case Breakdown', activity: 'project', level: 'medium', scope: { deckIds: ['d-case-m2'] } },
        { name: 'Drill Consolidation', activity: 'practice', level: 'medium', scope: { deckIds: ['d-drill-m2'] } },
      ],
    },
  };
  ui.setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(inApp(ui, h(ui.CourseMethodCard, {
      course: englishCourse,
      readout: { ...progB, gate: { ...gateB, stage: englishCourse.method.stages[0] } },
      data: stateB,
    }), { data: stateB }));
    const enText = plainText(enHtml);
    assert.match(enText, /Next stage: Drill Consolidation/);
    assert.match(enText, /Turn weak points into practice/);
    assert.doesNotMatch(enText, han, `English CourseMethodCard with case.drills has zero Han: ${enText}`);
  } finally {
    ui.setUiLanguage('zh');
  }
});

test('13. GuidedStudyWorkbench only offers 带着错题回主会话 when the current card actually failed (including > 50% rubric rule) and StudyProgressPanel localizes cleanly without getUiLanguage (Major #3 + CI #1 + CI #2)', () => {
  const richProgress = {
    totalCount: 5,
    independentPassedCount: 1,
    independentRatio: 0.2,
    assistedCount: 0,
    selfReportedCount: 1,
    needsReviewCount: 2,
    pendingCount: 1,
    lectureCoveredCount: 1,
    displayLine: '独立检验 1/5（20%）；1 项自报，2 项需复核，1 项待检验',
    items: [
      { id: 'i1', title: 'Item 1', status: 'passed', attemptsCount: 1 },
      { id: 'i2', title: 'Item 2', status: 'self_reported', attemptsCount: 1 },
      { id: 'i3', title: 'Item 3', status: 'needs_review', attemptsCount: 1 },
      { id: 'i4', title: 'Item 4', status: 'needs_review', attemptsCount: 1 },
      { id: 'i5', title: 'Item 5', status: 'pending', attemptsCount: 0 },
    ],
  };
  const baseSession = { id: 'gs-m3', courseId: 'Distributed Systems', status: 'active', goal: { title: 'Raft Safety', checkItems: [] } };
  const card = makeChoiceCard('raft-q1', 'Raft', 'Why cannot a leader overwrite committed entries?');

  ui.setUiLanguage('zh');

  // 1) Unanswered card (feedback: null), even when progress.needsReviewCount === 2 > 0 -> NO 带着错题回主会话!
  const unansweredText = plainText(renderToStaticMarkup(inApp(ui, h(ui.GuidedStudyWorkbench, {
    session: baseSession,
    progress: richProgress,
    run: { id: 'r1', deckId: 'd-raft', card, revealed: false, feedback: null },
  }))));
  assert.doesNotMatch(unansweredText, /带着错题回主会话/, 'unanswered card never shows 带着错题回主会话 even if session has prior needsReviewCount > 0');

  // 2) Rightly answered card (feedback.correct === true), even when progress.needsReviewCount === 2 > 0 -> NO 带着错题回主会话!
  const rightText = plainText(renderToStaticMarkup(inApp(ui, h(ui.GuidedStudyWorkbench, {
    session: baseSession,
    progress: richProgress,
    run: { id: 'r1', deckId: 'd-raft', card, revealed: true, feedback: { correct: true, grade: 4 } },
  }))));
  assert.doesNotMatch(rightText, /带着错题回主会话/, 'correctly answered card never shows 带着错题回主会话');

  // 3) Rubric card scoring 2.2 / 4 (55% > 50%) with grade 2 / correct: false -> passes (> 50%), so NO 带着错题回主会话!
  const rubricPass = { total: 2.2, max: 4, criteria: [{ id: 'c1', awarded: 1.2, max: 2 }, { id: 'c2', awarded: 1.0, max: 2 }] };
  assert.equal(rubricAttemptPassed({ assessment: 'rubric', score: 2.2, maxScore: 4, rubric: rubricPass }), true);
  const rubricPassText = plainText(renderToStaticMarkup(inApp(ui, h(ui.GuidedStudyWorkbench, {
    session: baseSession,
    progress: richProgress,
    run: { id: 'r1', deckId: 'd-raft', card, revealed: true, feedback: { correct: false, grade: 2, rubric: rubricPass } },
  }))));
  assert.doesNotMatch(rubricPassText, /带着错题回主会话/, 'rubric 55% (> 50%) counts as check passed and does not trigger missed hand-off');

  // 4) Rubric card scoring 2.0 / 4 (50% <= 50%) -> fails check, so 带着错题回主会话 / Take missed questions to main chat IS rendered!
  const rubricFail = { total: 2.0, max: 4, criteria: [{ id: 'c1', awarded: 1.0, max: 2 }, { id: 'c2', awarded: 1.0, max: 2 }] };
  assert.equal(rubricAttemptPassed({ assessment: 'rubric', score: 2.0, maxScore: 4, rubric: rubricFail }), false);
  const rubricFailZh = plainText(renderToStaticMarkup(inApp(ui, h(ui.GuidedStudyWorkbench, {
    session: baseSession,
    progress: richProgress,
    run: { id: 'r1', deckId: 'd-raft', card, revealed: true, feedback: { correct: false, grade: 2, rubric: rubricFail } },
  }))));
  assert.match(rubricFailZh, /带着错题回主会话/, 'rubric 50% (not strictly > 50%) offers 带着错题回主会话');
  assert.match(rubricFailZh, /独立检验 1\/5（20%）；1 项自报，2 项需复核，1 项待检验/);

  ui.setUiLanguage('en');
  try {
    const rubricFailEn = plainText(renderToStaticMarkup(inApp(ui, h(ui.GuidedStudyWorkbench, {
      session: baseSession,
      progress: richProgress,
      estimate: { status: 'estimating' },
      run: { id: 'r1', deckId: 'd-raft', card, revealed: true, feedback: { correct: false, grade: 2, rubric: rubricFail } },
    }))));
    assert.match(rubricFailEn, /Take missed questions to main chat/);
    assert.match(rubricFailEn, /Verified on your own: 1\/5 \(20%\); 1 self-reported, 2 need review, 1 to check/);
    assert.doesNotMatch(rubricFailEn, han, `GuidedStudyWorkbench + StudyProgressPanel English has zero Han: ${rubricFailEn}`);
  } finally {
    ui.setUiLanguage('zh');
  }
});

test('14. Reordering and removing stages in MethodForm / CourseMethodCard accurately remaps stageIndex, skippedStages, and selfReportedStages (Major #4)', async t => {
  // 1) Pure unit verification of remapMethodOnStageMove and remapMethodOnStageRemove
  const initial = {
    name: '三阶学法',
    stageIndex: 0,
    skippedStages: [1],
    selfReportedStages: [2],
    stages: [
      { name: 'A', activity: 'explain', level: 'medium' },
      { name: 'B', activity: 'practice', level: 'medium' },
      { name: 'C', activity: 'review', level: 'medium' },
    ],
  };

  // Move 0 -> 2: [A, B, C] -> [B, C, A]; old 0 -> 2, old 1 -> 0, old 2 -> 1
  const movedForward = remapMethodOnStageMove(initial, 0, 2);
  assert.deepEqual(movedForward.stages.map(s => s.name), ['B', 'C', 'A']);
  assert.equal(movedForward.stageIndex, 2);
  assert.deepEqual(movedForward.skippedStages, [0]);
  assert.deepEqual(movedForward.selfReportedStages, [1]);

  // Move 2 -> 0 back: [B, C, A] -> [A, B, C]; restores exact original indices
  const movedBack = remapMethodOnStageMove(movedForward, 2, 0);
  assert.deepEqual(movedBack.stages.map(s => s.name), ['A', 'B', 'C']);
  assert.equal(movedBack.stageIndex, 0);
  assert.deepEqual(movedBack.skippedStages, [1]);
  assert.deepEqual(movedBack.selfReportedStages, [2]);

  // Remove index 0 when stageIndex: 2, skippedStages: [0, 2], selfReportedStages: [1]
  const removedFirst = remapMethodOnStageRemove({
    ...initial,
    stageIndex: 2,
    skippedStages: [0, 2],
    selfReportedStages: [1],
  }, 0);
  assert.deepEqual(removedFirst.stages.map(s => s.name), ['B', 'C']);
  assert.equal(removedFirst.stageIndex, 1, 'stageIndex 2 shifts down to 1 when stage 0 is deleted');
  assert.deepEqual(removedFirst.skippedStages, [1], 'removed stage 0 is dropped and 2 shifts to 1');
  assert.deepEqual(removedFirst.selfReportedStages, [0], 'selfReported stage 1 shifts to 0');

  // Remove active last stage (index 1 of 2): clamps stageIndex to 0 and omits empty marker arrays
  const removedLast = remapMethodOnStageRemove({
    name: '两阶',
    stageIndex: 1,
    skippedStages: [1],
    selfReportedStages: [1],
    stages: [
      { name: 'X', activity: 'practice', level: 'medium' },
      { name: 'Y', activity: 'review', level: 'medium' },
    ],
  }, 1);
  assert.deepEqual(removedLast.stages.map(s => s.name), ['X']);
  assert.equal(removedLast.stageIndex, 0);
  assert.equal(removedLast.skippedStages, undefined);
  assert.equal(removedLast.selfReportedStages, undefined);

  // 2) Interactive CourseMethodCard + MethodForm UI flow persisted via StudyService
  const { service } = await createLibrary(t);
  const COURSE = 'Networks Reorder';
  await service.call('course.save', {
    name: COURSE,
    method: {
      name: '网络三步法',
      stageIndex: 2,
      skippedStages: [0],
      selfReportedStages: [1],
      stages: [
        { name: 'Stage A', activity: 'explain', level: 'medium' },
        { name: 'Stage B', activity: 'practice', level: 'medium' },
        { name: 'Stage C', activity: 'review', level: 'medium' },
      ],
    },
  });

  const harness = await createStatefulMethodHarness();
  harness.components.setUiLanguage('zh');
  const raw0 = await service.store.read();
  const card = harness.mount({
    course: raw0.courses.find(c => c.name === COURSE),
    data: raw0,
    call: (op, args) => service.call(op, args),
    act: (op, args) => service.call(op, args),
  });
  t.after(() => card.unmount());

  // Open 改学法 -> click 下移第 1 个阶段 (moves Stage A 0 -> 1, Stage B 1 -> 0) -> click 保存学法
  card.findButton('改学法').props.onClick();
  const moveDownBtn = card.findButton('下移第 1 个阶段');
  assert.ok(moveDownBtn, 'MethodForm renders 下移第 1 个阶段 IconButton');
  moveDownBtn.props.onClick();
  await card.findButton('保存学法').props.onClick();

  const gotMove = await service.call('course.get', { name: COURSE });
  const afterMove = gotMove?.course ?? gotMove;
  assert.deepEqual(afterMove.method.stages.map(s => s.name), ['Stage B', 'Stage A', 'Stage C']);
  assert.equal(afterMove.method.stageIndex, 2, 'Stage C remains at index 2');
  assert.deepEqual(afterMove.method.skippedStages, [1], 'skipped Stage A moved 0 -> 1');
  assert.deepEqual(afterMove.method.selfReportedStages, [0], 'self-reported Stage B moved 1 -> 0');

  // Re-open 改学法 with updated course -> click 删除第 1 个阶段 (removes Stage B at index 0) -> click 保存学法
  const raw1 = await service.store.read();
  card.render({ course: afterMove, data: raw1 });
  card.findButton('改学法').props.onClick();
  const deleteFirstBtn = card.findButton('删除第 1 个阶段');
  assert.ok(deleteFirstBtn, 'MethodForm renders 删除第 1 个阶段 IconButton');
  deleteFirstBtn.props.onClick();
  await card.findButton('保存学法').props.onClick();

  const gotDelete = await service.call('course.get', { name: COURSE });
  const afterDelete = gotDelete?.course ?? gotDelete;
  assert.deepEqual(afterDelete.method.stages.map(s => s.name), ['Stage A', 'Stage C']);
  assert.equal(afterDelete.method.stageIndex, 1, 'active Stage C shifted 2 -> 1');
  assert.deepEqual(afterDelete.method.skippedStages, [0], 'skipped Stage A shifted 1 -> 0');
  assert.equal(afterDelete.method.selfReportedStages, undefined, 'deleted Stage B self-reported marker removed cleanly');
});
