// #1642: a family's origin label and the step-1 note claim only what produced them. The built-in families are fixed text with topic names filled in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  analyzeAssessmentModes,
  confirmCalibrationFamily,
  isFamilyCalibrated,
  normalizeCoachSpec,
  projectCoachSpecForView,
  saveCoachSpec,
} from '../lib/exam-coach.js';

/** What the analysis before #1642 really saved (captured by running it): one run with a sample paper, one without a paper or any keyword. */
const legacy = () => JSON.parse(readFileSync(new URL('./fixtures/coach-spec-before-1642.json', import.meta.url), 'utf8'));
const originsOf = spec => Object.fromEntries(spec.taskFamilies.map(family => [family.id, family.origin]));
const rulesOf = spec => spec.taskFamilies.map(({ keyConditions, reasoningSteps, distractorRules, rubricPoints }) =>
  ({ keyConditions, reasoningSteps, distractorRules, rubricPoints }));

const lecture = { id: 'mat-1', course: 'OS', title: '操作系统讲义', text: '# 进程调度\n最短剩余时间优先需要估计运行时间公式。\n# 虚拟内存置换\n缺页率推导与工作集窗口案例计算。' };
const paper = text => ({ id: 'ref-1', course: 'OS', title: '往年真题样卷', text });
const analyzeWithPaper = (text, options = {}) =>
  analyzeAssessmentModes({ sources: [lecture, paper(text)] }, { course: 'OS', referenceSourceIds: ['ref-1'], ...options });

test('a sample paper changes no built-in rule, so no built-in family is called an observation of it', async () => {
  const first = await analyzeWithPaper('一、选择题：进程调度与周转时间计算。');
  const second = await analyzeWithPaper('一、辨析题：说明下列做法为什么会导致死锁。二、论述题：评价银行家算法。');
  assert.deepEqual(rulesOf(second), rulesOf(first), 'two unlike papers, the same rules: none of them was read from a paper');
  for (const spec of [first, second]) {
    assert.deepEqual([...new Set(Object.values(originsOf(spec)))], ['built-in-template']);
    assert.equal(spec.taskFamilies.length, 3);
  }
});

/** No keyword of either extra family and two headings: the case once labelled a model suggestion without any model call. */
const plain = { id: 'mat-2', course: '语文', title: '语文讲义', text: '# 修辞手法\n比喻与拟人。\n# 表达方式\n记叙与抒情。' };

test('only the labels changed: the same material still gives the families and version saved before #1642', async () => {
  const unlabelled = spec => spec.taskFamilies.map(({ origin, ...family }) => family);
  const sources = [
    { id: 'mat-1', course: '操作系统', title: '操作系统讲义', text: '# 进程调度\n最短剩余时间优先需要估计运行时间公式。\n# 虚拟内存置换\n缺页率推导与工作集窗口案例计算。' },
    { id: 'ref-1', course: '操作系统', title: '往年真题样卷', text: '一、选择题：进程调度与周转时间计算。' },
  ];
  const now = {
    withPaper: await analyzeAssessmentModes({ sources }, { course: '操作系统', referenceSourceIds: ['ref-1'] }),
    withoutPaper: await analyzeAssessmentModes({ sources: [plain] }, { course: '语文' }),
  };
  for (const [name, saved] of Object.entries(legacy())) {
    assert.deepEqual(unlabelled(now[name]), unlabelled(saved), name);
    assert.equal(now[name].specVersion, saved.specVersion, name);
  }
});

test('without a model call no family is a model suggestion, and without a paper none is a fact of the material', async () => {
  const spec = await analyzeAssessmentModes({ sources: [plain] }, { course: '语文' });
  assert.deepEqual(originsOf(spec), { 'concept-discrimination': 'built-in-template', 'scenario-tradeoff-task': 'built-in-template' });
});

test('a family the model added stays a model suggestion, even under the id of a built-in one', async () => {
  const completeLight = async () => JSON.stringify({ taskFamily: { id: 'concept-discrimination', title: '模型补充的任务', primaryFormat: 'quiz',
    keyConditions: ['模型给的条件'], reasoningSteps: ['模型给的步骤'] } });
  const spec = await analyzeWithPaper('一、选择题。', { completeLight });
  assert.equal(spec.taskFamilies.at(-1).title, '模型补充的任务');
  assert.equal(spec.taskFamilies.at(-1).origin, 'model-suggested');
  assert.equal(normalizeCoachSpec(spec).taskFamilies.at(-1).origin, 'model-suggested', 'and still is after being read back');
});

test('the step-1 note claims no reading of the paper and arrives whole', async () => {
  for (const spec of [await analyzeWithPaper('一、选择题。'), await analyzeAssessmentModes({ sources: [lecture] }, { course: 'OS' })]) {
    const note = spec.scopeBoundary.sampleFrequencyNote;
    assert.doesNotMatch(note, /已分析|题型频次|样本观察|观察频率/);
    assert.match(note, /固定写法/);
    assert.match(note, /请对照考纲确认。$/, 'not cut off by the length limit');
  }
  assert.doesNotMatch(normalizeCoachSpec({}).scopeBoundary.sampleFrequencyNote, /统计|观察频率/, 'a plan that was never analyzed has no statistics either');
});

test('a plan saved before #1642 is read with true labels and note, without asking the learner to analyze again', () => {
  const { withPaper, withoutPaper } = legacy();
  assert.deepEqual(originsOf(withPaper), { 'concept-discrimination': 'reference-observed', 'multi-step-derivation': 'reference-observed', 'scenario-tradeoff-task': 'source-fact' });
  assert.equal(originsOf(withoutPaper)['scenario-tradeoff-task'], 'model-suggested');
  for (const saved of [withPaper, withoutPaper]) {
    const view = projectCoachSpecForView(saved);
    assert.deepEqual([...new Set(Object.values(originsOf(view)))], ['built-in-template']);
    assert.doesNotMatch(view.scopeBoundary.sampleFrequencyNote, /已分析|题型频次|推导考察方式/);
    assert.equal(view.specVersion, saved.specVersion, 'a label is not a rule: the version the learner confirmed against stays');
  }
  assert.match(projectCoachSpecForView(withPaper).scopeBoundary.sampleFrequencyNote, /1 份参考样卷、1 份课程资料/);
  assert.match(projectCoachSpecForView(withoutPaper).scopeBoundary.sampleFrequencyNote, /1 份课程资料，暂无往年样卷/);
});

test('confirmations made before #1642 survive the relabelling', () => {
  const saved = legacy().withPaper;
  saved.taskFamilies = saved.taskFamilies.map(family => ({ ...family, confirmations:
    { appearanceApproved: true, intentApproved: true, answerVerified: true, confirmedSpecVersion: saved.specVersion, staleReason: null } }));
  const read = normalizeCoachSpec(saved);
  for (const family of read.taskFamilies) assert.equal(isFamilyCalibrated(family, read.specVersion), true, family.id);
  const { spec } = confirmCalibrationFamily(saved, { familyId: 'concept-discrimination', appearanceApproved: true });
  assert.equal(spec.taskFamilies[0].origin, 'built-in-template');
});

test('an old built-in family whose reasoning steps the learner edited is still a built-in one', () => {
  const saved = legacy().withPaper;
  saved.taskFamilies[0].reasoningSteps = ['我自己改过的步骤'];
  const next = saveCoachSpec(saved, { taskFamilies: saved.taskFamilies });
  assert.equal(next.taskFamilies[0].origin, 'built-in-template');
  assert.deepEqual(next.taskFamilies[0].reasoningSteps, ['我自己改过的步骤']);
});

test('a family whose mistake causes or rubric were written anew keeps the origin its writer gave it, and a note of their own is kept', () => {
  const saved = legacy().withPaper;
  saved.taskFamilies[0].distractorRules = [{ id: 'mis-paper', code: 'P1', label: '样卷里的坑', reason: '第 3 题把充分条件当必要条件' }];
  saved.taskFamilies[1].rubricPoints = [{ id: 'r', criterion: '样卷给分点', marks: 10, condition: '照样卷评分说明' }];
  saved.scopeBoundary.sampleFrequencyNote = '三套卷子里辨析题占一半。';
  const read = normalizeCoachSpec(saved);
  assert.equal(read.taskFamilies[0].origin, 'reference-observed');
  assert.equal(read.taskFamilies[1].origin, 'reference-observed');
  assert.equal(read.scopeBoundary.sampleFrequencyNote, '三套卷子里辨析题占一半。');
});

test('a family saved without an origin is not called a fact of the material', () => {
  const next = saveCoachSpec({}, { taskFamilies: [{ id: 'mine', title: '我的任务', primaryFormat: 'quiz' }] });
  assert.equal(next.taskFamilies[0].origin, 'user-defined');
});
