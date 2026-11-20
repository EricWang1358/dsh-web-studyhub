import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { normalizeLessonSpec, validateLessonSpec } from '../lib/companion-template/validate.js';
import { compileLessonHtml } from '../lib/companion-template/render-html.js';
import { buildLessonTemplateRuntimeJs, LESSON_TEMPLATE_RUNTIME_JS } from '../lib/companion-template/template-runtime.js';
import { planCompanionBuild } from '../lib/contexts/generation/companion/plan.js';
import { estimateOfCompanionPlan } from '../lib/contexts/generation/companion/start.js';
import { StudyService } from '../lib/service.js';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';
import { until } from './helpers/wait.mjs';

const uiMod = await loadUi(`
  export { WrongBookView } from './ui/WrongBook.jsx';
  export { default as CompanionViewer } from './ui/companions/CompanionViewer.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { rescueGate, rescueExperimentStatusText } from './ui/wrongbook-model.js';
  export { resolveCompanionTarget, companionSlideButtonLabel, openCompanionTarget } from './ui/companions/companion-ref.js';
  export { handOffText } from './ui/agent-prompts/index.js';
`);
const {
  WrongBookView,
  CompanionViewer,
  StudyServicesContext,
  setUiLanguage,
  rescueGate,
  rescueExperimentStatusText,
  resolveCompanionTarget,
  companionSlideButtonLabel,
  openCompanionTarget,
  handOffText,
} = uiMod;

const HAN_RE = /\p{Script=Han}/u;
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function makeRescueSpec({
  language = 'zh',
  withSpot = true,
  archetype = 'sandbox',
  hid = 'H12',
  targetCardIds = ['card-stubborn-1'],
  badSandboxExpr = false,
} = {}) {
  const en = language === 'en';
  const interactive = archetype === 'matrix'
    ? {
        t: 'matrix',
        predictBeforeReveal: true,
        say: en ? 'Compare both definitions side by side.' : '把两个易混概念放在同一组边界里直接对照。',
        frameworks: [
          { id: 'f1', name: en ? 'Pointwise Convergence' : '逐点收敛' },
          { id: 'f2', name: en ? 'Uniform Convergence' : '一致收敛' },
        ],
        scenarios: [{
          id: 's1',
          title: en ? 'Moving Bump Sequence' : '移动尖峰函数序列',
          prompt: en ? 'Does integral of limit equal limit of integrals?' : '极限的积分是否等于积分的极限？',
          cells: [
            { badge: en ? 'Fails' : '会失效', tone: 'error', verdict: en ? 'Area escapes' : '面积逃逸', why: en ? 'Each point drops to 0, but peak height stays 1.' : '每个点都趋于 0，但尖峰高度不降。' },
            { badge: en ? 'Holds' : '成立', tone: 'success', verdict: en ? 'Supremum vanishes' : '上确界一致归零', why: en ? 'Uniform bound controls total integral.' : '一致上界锁住了整体积分误差。' },
          ],
        }],
      }
    : {
        t: 'sandbox',
        caption: en ? 'Slide damping ratio $\\zeta$' : '拖动阻尼比 $\\zeta$ 观察临界边界',
        say: en ? 'Watch the curve cross $\\zeta = 1$.' : '亲眼看曲线越过 $\\zeta = 1$ 的临界点。',
        knobs: [{ id: 'zeta', label: '$\\zeta$', min: 0.2, max: 1.8, step: 0.1, default: 0.4, unit: '' }],
        presets: [
          { label: en ? 'Underdamped' : '欠阻尼', values: { zeta: 0.3 } },
          { label: en ? 'Critical' : '临界阻尼', values: { zeta: 1.0 } },
        ],
        domain: { variable: 't', min: 0, max: 8, steps: 40, label: 't' },
        series: [{
          id: 'resp',
          label: '$x(t)$',
          expr: badSandboxExpr
            ? (typeof badSandboxExpr === 'string' ? badSandboxExpr : '1 / (zeta - 0.4)')
            : 'exp(-zeta*t)*cos(sqrt(max(0.001, 1 - min(0.999, zeta^2)))*t)',
        }],
        walk: [
          { set: { zeta: 0.3 }, say: en ? 'Rings below 1.' : '小于 1 时振荡。' },
          { set: { zeta: 1.0 }, say: en ? 'Critical boundary.' : '等于 1 时临界不振荡。' },
        ],
      };

  const slides = [
    {
      beat: 'predict',
      title: en ? 'Check Your Intuition First' : '先对照你上次的选项猜一猜',
      blocks: [{
        t: 'predict',
        id: 'pred-rescue-1',
        q: en ? 'When $\\zeta = 1$, does dividing by $(r_1 - r_2)$ still yield two independent roots?' : '当 $\\zeta = 1$ 时，直接除以 $(r_1 - r_2)$ 还能得到两个独立解吗？',
        options: [
          en ? 'Yes, it always gives two exponentials' : '能，照样得到两个指数解',
          en ? 'No, $r_1 = r_2$ makes the divisor zero' : '不能，重根会让分母归零失效',
        ],
        answer: 1,
        say: en ? 'Lock in your prediction before we test it.' : '先锁定你的直觉判断，等下马上揭晓。',
      }],
    },
    {
      beat: 'run',
      title: en ? 'Manipulate the Boundary' : '动手推演临界机理',
      blocks: [
        interactive,
        { t: 'reveal', of: 'pred-rescue-1', say: en ? 'Compare with your bet.' : '对照你刚才的猜想看看结果。' },
      ],
    },
  ];

  if (withSpot) {
    slides.push({
      beat: 'why',
      title: en ? 'Spot the Broken Step' : '点出推导中踩雷的那一步',
      blocks: [{
        t: 'spot',
        of: 'flaw-1',
        path: 'derivation.txt',
        lang: 'derivation',
        q: en ? 'Click the line that divides by zero at $\\zeta = 1$.' : '点出在 $\\zeta = 1$ 时隐含除以零的那一行。',
        how: en ? 'Click the flawed line.' : '点击左侧问题行。',
        source: 'Step 1: r^2 + 2*zeta*r + 1 = 0\nStep 2: Divide by (r1 - r2)\nStep 3: Write C1*e^(r1*t) + C2*e^(r2*t)',
        answerLines: [2],
        hint: en ? 'Check the denominator.' : '检查哪一步把可能为零的量放进了分母。',
        found: en ? 'At $\\zeta = 1$, $r_1 = r_2 = -1$ so $r_1 - r_2 = 0$.' : '当 $\\zeta = 1$ 时重根导致 $r_1 - r_2 = 0$。',
        say: en ? 'Pinpoint the exact hidden assumption.' : '把藏雷的那一行点出来。',
      }],
    });
  }

  slides.push({
    beat: 'check',
    title: en ? 'Fresh Boundary Check' : '换个情境检验一次',
    blocks: [{
      t: 'quiz',
      q: en ? 'For $\\ddot{y} + 6\\dot{y} + 9y = 0$, which pair forms a general basis?' : '对于 $\\ddot{y} + 6\\dot{y} + 9y = 0$，哪一组构成通解基底？',
      say: en ? 'Test the same invariant on new numbers.' : '换一组参数检验你是否真避开了重根陷阱。',
      choices: [
        { label: '$e^{-3t}$ and $2e^{-3t}$', correct: false, why: en ? 'Linearly dependent.' : '线性相关，只张成一维空间。' },
        { label: '$e^{-3t}$ and $t e^{-3t}$', correct: true, why: en ? 'Repeated root $r = -3$ requires factor $t$.' : '重根 $r = -3$ 必须乘以因子 $t$ 保证线性无关。' },
        { label: '$\\cos(3t)$ and $\\sin(3t)$', correct: false, why: en ? 'Roots are real, not purely imaginary.' : '特征根是实重根而非纯虚根。' },
        { label: '$e^{3t}$ and $e^{-3t}$', correct: false, why: en ? 'Characteristic equation is $(r+3)^2 = 0$.' : '特征方程为 $(r+3)^2 = 0$，不存在 $+3$。' },
      ],
    }],
  });

  return {
    format: 'studyhub-lesson/1',
    mode: 'rescue',
    ...(hid ? { hid } : {}),
    ...(targetCardIds ? { targetCardIds } : {}),
    template: archetype === 'matrix' ? 'dialectic' : 'sandbox',
    language,
    id: `rescue-${archetype}-${language}`,
    course: en ? 'Differential Equations' : '微分方程',
    title: en ? 'Rescue Lab: Repeated Roots at Critical Damping' : '急救实验：临界阻尼与重根退化',
    lead: en ? 'Unpack why naive division fails at $\\zeta = 1$.' : '拆解为什么在 $\\zeta = 1$ 处直接除会丢解。',
    minutes: 4,
    terms: en ? { 'Repeated Root': 'Characteristic roots coincide ($r_1 = r_2$).' } : { '重根': '特征方程两根重合（$r_1 = r_2$）。' },
    slides,
  };
}

test('1. Validator & HTML compiler: accepts 3-4 slide rescue lessons, rejects missing predict/quiz or bad AST, keeps full mode unchanged', () => {
  assert.doesNotThrow(() => new vm.Script(LESSON_TEMPLATE_RUNTIME_JS));
  assert.doesNotThrow(() => new vm.Script(buildLessonTemplateRuntimeJs('en')));

  // Valid 3-slide rescue (spot omitted) passes BOTH strictPedagogy: false and true
  const rescue3 = normalizeLessonSpec(makeRescueSpec({ withSpot: false, archetype: 'matrix', language: 'en' }));
  assert.equal(rescue3.mode, 'rescue');
  assert.equal(rescue3.hid, 'H12');
  assert.deepEqual(rescue3.targetCardIds, ['card-stubborn-1']);
  assert.equal(rescue3.slides.length, 3);
  const check3 = validateLessonSpec(rescue3, { strictPedagogy: true });
  assert.equal(check3.ok, true, `3-slide rescue failed: ${check3.errors.join('; ')}`);
  assert.equal(check3.stats.mode, 'rescue');

  // Valid 4-slide rescue (with spot + sandbox) compiles cleanly with 0 external URLs & 0 Chinese in English
  const rescue4En = makeRescueSpec({ withSpot: true, archetype: 'sandbox', language: 'en' });
  const compiledEn = compileLessonHtml(rescue4En, { strictPedagogy: true });
  assert.ok(compiledEn.html.startsWith('<!doctype html>'));
  assert.ok(!/https?:\/\/(?!www\.w3\.org\/)/i.test(compiledEn.html));
  assert.ok(!HAN_RE.test(compiledEn.html), 'English rescue HTML must contain zero Chinese');
  assert.equal(compiledEn.lesson.mode, 'rescue');
  assert.equal(compiledEn.lesson.hid, 'H12');

  // Reject rescue missing Slide 1 predict
  const noPredict = makeRescueSpec({ withSpot: false });
  noPredict.slides[0] = { beat: 'open', title: 'Intro', blocks: [{ t: 'text', md: 'Plain text', say: 'Hi.' }] };
  noPredict.slides[1].blocks = noPredict.slides[1].blocks.filter(b => b.t !== 'reveal');
  const resNoPredict = validateLessonSpec(noPredict, { strictPedagogy: false });
  assert.equal(resNoPredict.ok, false);
  assert.ok(resNoPredict.errors.some(e => /Slide 1.*predict/i.test(e)));

  // Reject rescue missing final quiz
  const noQuiz = makeRescueSpec({ withSpot: false });
  noQuiz.slides[noQuiz.slides.length - 1] = { beat: 'take', title: 'Summary', blocks: [{ t: 'text', md: 'Done.', say: 'Done.' }] };
  const resNoQuiz = validateLessonSpec(noQuiz, { strictPedagogy: false });
  assert.equal(resNoQuiz.ok, false);
  assert.ok(resNoQuiz.errors.some(e => /final slide.*quiz/i.test(e)));

  // Reject rescue with non-finite or unsafe sandbox AST expression
  const badAst = makeRescueSpec({ withSpot: true, badSandboxExpr: '1 / 0' });
  const resBadAst = validateLessonSpec(badAst, { strictPedagogy: true });
  assert.equal(resBadAst.ok, false);
  assert.ok(resBadAst.errors.some(e => /sandbox/i.test(e)));
  const unsafeAst = makeRescueSpec({ withSpot: true, badSandboxExpr: 'process.exit(1)' });
  assert.equal(validateLessonSpec(unsafeAst, { strictPedagogy: true }).ok, false);

  // Reject rescue with < 3 or > 6 slides
  const tooShort = makeRescueSpec({ withSpot: false });
  tooShort.slides = tooShort.slides.slice(0, 2);
  assert.equal(validateLessonSpec(tooShort).ok, false);

  const tooLong = makeRescueSpec({ withSpot: true });
  while (tooLong.slides.length < 7) {
    tooLong.slides.splice(2, 0, { beat: 'why', title: 'Extra', blocks: [{ t: 'text', md: 'Extra', say: 'Extra' }] });
  }
  assert.equal(validateLessonSpec(tooLong).ok, false);

  // Reject invalid metadata values
  const badMode = { ...makeRescueSpec(), mode: 'bogus' };
  assert.equal(validateLessonSpec(badMode).ok, false);
  const badTarget = { ...makeRescueSpec(), targetCardIds: [''] };
  assert.equal(validateLessonSpec(badTarget).ok, false);

  // Full mode remains 100% unchanged: 4 slides still rejected under strictPedagogy: true, 3 slides rejected under false
  const full4 = { ...makeRescueSpec({ withSpot: true }), mode: 'full' };
  const checkFull4Strict = validateLessonSpec(full4, { strictPedagogy: true });
  assert.equal(checkFull4Strict.ok, false);
  assert.ok(checkFull4Strict.errors.some(e => /at least 12 progressive slides/i.test(e)));
  const full3 = { ...makeRescueSpec({ withSpot: false }), mode: undefined };
  assert.equal(validateLessonSpec(full3, { strictPedagogy: false }).ok, false);
});

test('2. End-to-end fake-model pipeline: Stubborn card -> rescue build -> compile/mount -> card.companionRef & hid -> progress recorded', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'study-rescue-e2e-'));
  const storeDir = join(tmp, 'library');
  const workspaceDir = join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });

  const capturedPrompts = [];
  const fakeComplete = async (system, prompt) => {
    capturedPrompts.push({ system, prompt });
    const parsed = JSON.parse(prompt);
    // Verify the model received the student's actual wrong option, hid, C001 confusables, and original source passage
    assert.equal(parsed.mode, 'rescue');
    assert.equal(parsed.hid, 'H12');
    assert.equal(parsed.rescueContext.cards[0].chosenWrongAnswer, '逐点收敛即可交换极限与积分');
    assert.ok(parsed.rescueContext.confusables.some(c => c.id === 'C001'));
    assert.ok(parsed.materials.some(m => m.id === 'src-real-1' && m.excerpt.includes('一致收敛')));
    return JSON.stringify(makeRescueSpec({
      language: 'zh',
      withSpot: true,
      archetype: 'matrix',
      hid: 'H12',
      targetCardIds: ['card-stubborn-1'],
    }));
  };

  const service = new StudyService(storeDir, {
    complete: fakeComplete,
    completeLight: fakeComplete,
    ...switchOptions('runtime', { complete: fakeComplete }),
  });
  t.after(async () => {
    await service.dispose();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // Seed course, original material, courseNotes with hid H12 + C001 confusable, stubborn card + failed run/attempt
  await service.store.update(st => {
    st.courses.push({ id: 'course-ana', name: '数学分析', createdAt: '2026-10-01T00:00:00Z' });
    st.sources.push({
      id: 'src-real-1',
      title: '第 6 章 函数项级数',
      text: '定理 6.2：若函数列 f_n(x) 在闭区间 [a,b] 上一致收敛于 f(x)，且每个 f_n 连续，则极限与积分可以交换顺序。仅逐点收敛时，尖峰函数序列的面积可以逃逸，交换极限与积分会失效。',
      format: 'md',
      courses: ['数学分析'],
      createdAt: '2026-10-01T00:00:00Z',
    });
    st.sources.push({
      id: 'src-notes-1',
      title: '数学分析 · 复习全书',
      text: '# 数学分析复习全书',
      format: 'md',
      courses: ['数学分析'],
      provenance: 'course-outline-notes',
      createdAt: '2026-10-02T00:00:00Z',
      courseNotes: {
        version: 1,
        course: '数学分析',
        outlineId: 'out-1',
        leaves: [{
          id: 'H12',
          title: '一致收敛与积分交换',
          anchors: [{ sourceId: 'src-real-1' }],
          cards: [
            { item: 'it-pw', name: '逐点收敛', relations: [{ kind: 'opposite', item: 'it-unif', name: '一致收敛' }] },
            { item: 'it-unif', name: '一致收敛', relations: [{ kind: 'opposite', item: 'it-pw', name: '逐点收敛' }] },
          ],
        }],
        confusables: [{
          items: ['it-pw', 'it-unif'],
          print: '0123456789abcdef',
          rows: [
            { aspect: 'difference', cells: ['每个 x 各自收敛，N 依赖 x', '同一个 N 对区间所有 x 同时生效'] },
            { aspect: 'mistake', cells: ['误以为逐点收敛就能交换极限与积分', '忘记检验闭区间上的上确界收敛'] },
          ],
        }],
      },
    });
    st.decks.push({
      id: 'deck-ana-1',
      title: '函数项级数练习',
      course: '数学分析',
      cards: [{
        id: 'card-stubborn-1',
        kind: 'quiz',
        topic: '一致收敛',
        prompt: '在闭区间 [a,b] 上，什么条件保证极限与积分可以交换？',
        answer: '一致收敛',
        options: [
          { id: 'a', text: '逐点收敛即可交换极限与积分', correct: false, explanation: '反例：移动尖峰序列' },
          { id: 'b', text: '一致收敛', correct: true, explanation: '上确界一致归零保证积分误差归零' },
          { id: 'c', text: '单调有界即可', correct: false, explanation: '需区分函数列与数列' },
        ],
        explanation: '仅逐点收敛时尖峰面积会逃逸，必须一致收敛。',
        citations: [{ sourceId: 'src-real-1', quote: '若函数列 f_n(x) 在闭区间 [a,b] 上一致收敛于 f(x)' }],
        review: { reps: 4, lapses: 4, state: 3 },
      }],
    });
    st.runs.push({
      id: 'run-1',
      deckId: 'deck-ana-1',
      entries: [{
        card: st.decks[0].cards[0],
        feedback: { selected: ['a'], grade: 1 },
      }],
    });
    st.attempts.push({
      id: 'att-1',
      runId: 'run-1',
      deckId: 'deck-ana-1',
      quiz_id: 'card-stubborn-1',
      assessment: 'graded',
      grade: 1,
      timestamp: '2026-10-03T10:00:00Z',
    });
  });

  // 1. Plan & estimate (0 model calls)
  const stateBefore = await service.store.read();
  const plan = planCompanionBuild(stateBefore, {
    mode: 'rescue',
    course: '数学分析',
    deckId: 'deck-ana-1',
    cardIds: ['card-stubborn-1'],
    errorReason: 'concept',
    thinkingNote: '总是把逐点和一致混在一起',
    language: 'zh',
  });
  assert.equal(plan.mode, 'rescue');
  assert.equal(plan.hid, 'H12');
  assert.equal(plan.archetype, 'dialectic', 'concept error + C001 confusable selects dialectic matrix');
  assert.deepEqual(plan.targetCardIds, ['card-stubborn-1']);
  assert.equal(plan.steps, 2);
  const est = estimateOfCompanionPlan(plan);
  assert.deepEqual(est.calls, { low: 1, high: 2 });

  const estApi = await service.call('generation.companion.build', {
    mode: 'rescue',
    course: '数学分析',
    deckId: 'deck-ana-1',
    cardIds: ['card-stubborn-1'],
    estimate: true,
  });
  assert.equal(estApi.status, 'estimate');
  assert.deepEqual(estApi.estimate.calls, { low: 1, high: 2 });
  assert.equal(capturedPrompts.length, 0);

  // 2. Run rescue build job end-to-end
  const started = await service.call('generation.companion.build', {
    mode: 'rescue',
    course: '数学分析',
    deckId: 'deck-ana-1',
    cardIds: ['card-stubborn-1'],
    errorReason: 'concept',
    thinkingNote: '总是把逐点和一致混在一起',
    workspace: workspaceDir,
    language: 'zh',
  });
  assert.equal(started.status, 'running');
  assert.equal(started.steps, 2);

  let finalJob;
  await until(async () => {
    finalJob = await service.call('job.status', { jobId: started.jobId });
    return finalJob?.status === 'complete' || finalJob?.status === 'failed';
  }, 'rescue companion build to finish', 8000);
  assert.equal(finalJob.status, 'complete', `job failed: ${JSON.stringify(finalJob?.error)}`);
  assert.equal(capturedPrompts.length, 1, 'single-pass rescue authoring call');

  // 3. Verify course companion record, storage mode, lessonMode, hid, targetCardIds, and auto-written card.companionRef
  const stateAfterBuild = await service.store.read();
  const courseRec = stateAfterBuild.courses.find(c => c.name === '数学分析');
  assert.equal(courseRec.companions.length, 1);
  const compRec = courseRec.companions[0];
  assert.equal(compRec.mode, 'managed', 'storage mode must remain managed');
  assert.equal(compRec.lessonMode, 'rescue');
  assert.equal(compRec.hid, 'H12');
  assert.deepEqual(compRec.targetCardIds, ['card-stubborn-1']);
  assert.equal(compRec.slideCount, 4);

  const stubbornCard = stateAfterBuild.decks.find(d => d.id === 'deck-ana-1').cards[0];
  assert.equal(stubbornCard.companionRef?.companionId, compRec.id);
  assert.equal(stubbornCard.companionRef?.slide, 1);
  assert.equal(stubbornCard.companionRef?.mode, 'rescue');
  assert.equal(stubbornCard.companionRef?.hid, 'H12');
  assert.equal(stateAfterBuild.decks.length, 1, 'rescue auto mount must not spawn extra redundant decks');

  // 4. Record completion + interactive checks via companion.progress and verify in-state mirror for PointEvidence
  const prog = await service.call('companion.progress', {
    id: compRec.id,
    course: '数学分析',
    slide: 4,
    slideTotal: 4,
    completed: true,
    checkResults: { 'predict:pred-rescue-1': false, 'spot:flaw-1': true, 'check:0': true },
  });
  assert.equal(prog.progress.completed, true);
  assert.equal(prog.progress.checksPassed, 2);
  assert.equal(prog.progress.checksTotal, 3);
  assert.deepEqual(prog.progress.checkResults, { 'predict:pred-rescue-1': false, 'spot:flaw-1': true, 'check:0': true });

  const stateAfterProg = await service.store.read();
  const storedComp = stateAfterProg.courses.find(c => c.name === '数学分析').companions[0];
  assert.equal(storedComp.progress.checksPassed, 2);
  assert.equal(storedComp.progress.checksTotal, 3);
  assert.equal(storedComp.progress.checkResults['check:0'], true);

  // 5. Also verify direct zero-key companion.compile with rescue metadata writes companionRef + hid + lessonMode
  const directRes = await service.call('companion.compile', {
    course: '数学分析',
    mode: 'rescue',
    hid: 'H12',
    targetCardIds: ['card-stubborn-1'],
    workspace: workspaceDir,
    lesson: makeRescueSpec({ language: 'zh', withSpot: false, archetype: 'matrix', hid: 'H12', targetCardIds: ['card-stubborn-1'] }),
  });
  assert.equal(directRes.attached, true);
  assert.equal(directRes.companion.mode, 'managed');
  assert.equal(directRes.companion.lessonMode, 'rescue');
  assert.equal(directRes.companion.hid, 'H12');
  assert.deepEqual(directRes.companion.targetCardIds, ['card-stubborn-1']);
  const diskHtml = await readFile(directRes.htmlPath, 'utf8');
  assert.ok(diskHtml.includes('<!doctype html>'));
  const stateAfterDirect = await service.store.read();
  assert.equal(stateAfterDirect.decks[0].cards[0].companionRef.companionId, directRes.companion.id);
});

test('3. WrongBook UI: single highlighted recommendation, collapsed Other ways, inline progress, DSH vs Desktop fallback & CompanionViewer return path', () => {
  const noop = () => {};
  const decks = [{ id: 'd4', course: 'PE', title: 'Platform Engineering｜期末卷' }];
  const item = {
    deckId: 'd4', deckTitle: decks[0].title, cardId: 'c1', topic: 'Circuit Breaker',
    prompt: 'When does a circuit breaker open?', assessment: 'graded', lastGrade: 1,
    lastAt: '2026-10-01T10:00:00Z', kind: 'quiz', leech: true,
  };
  const details = { c1: { deckId: 'd4', cardId: 'c1', correctAnswer: 'On failure threshold', explanation: 'Trips open.', yourAnswer: 'On first timeout', missedAt: '2026-10-01T10:00:00Z' } };
  const coach = { enabled: true, consent: true, ready: 0, preparing: false, preparingCards: [], readyCards: [], failedCards: [], tasks: [] };
  const baseProps = {
    data: { root: 'r', decks, focus: { course: 'PE', courses: [{ name: 'PE' }] }, model: { ready: true }, settings: {} },
    course: 'PE', onCourse: noop, items: [item], counts: { total: 1, graded: 1, self: 0, oral: 0, rubric: 0 },
    loading: false, err: '', page: 0, pageSize: 100, hasMore: false, onReload: noop, onPage: noop,
    recs: null, coach, details, onLoadDetail: noop, onPractice: noop, onPracticePrepared: noop,
    onGenerate: async () => ({}), onOpenSettings: noop, onSettings: noop, onRescue: noop, onStartExperiment: noop,
  };
  const renderWb = (extra = {}, services = {}) => renderToStaticMarkup(
    withStudy(StudyServicesContext, React.createElement(WrongBookView, { ...baseProps, ...extra }), services),
  );

  // Control budget: default expanded Stubborn row has ONLY 1 highlighted recommendation + 1 collapsed 其他办法 toggle
  setUiLanguage('zh');
  const defaultHtml = renderWb({ initial: { expanded: ['c1'] } });
  const leechBox = defaultHtml.match(/<div class="wb-sub wb-leech"[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? '';
  assert.equal((leechBox.match(/<button\b/g) || []).length, 2, 'default stubborn section shows exactly 2 buttons (net -2 from 4)');
  assert.match(leechBox, /data-rescue="experiment"/);
  assert.match(leechBox, /data-rescue-other-toggle/);
  assert.match(leechBox, /aria-expanded="false"/);
  assert.doesNotMatch(leechBox, /data-rescue="fix"/);

  // Inline waiting indicator while rescue experiment is generating (non-blocking)
  const runningHtml = renderWb({
    initial: { expanded: ['c1'], experimentJobs: { c1: { status: 'running', stage: 'rescue-author' } } },
  });
  assert.match(runningHtml, /data-rescue-status="running"/);
  assert.match(text(runningHtml), /15–30 秒/);
  assert.ok(rescueExperimentStatusText('verify').includes('校验'));

  // Inline ready state switches highlighted action to 打开 4 页交互实验
  const readyHtml = renderWb({
    initial: { expanded: ['c1'], experimentJobs: { c1: { status: 'ready', companionId: 'comp-r1', course: 'PE' } } },
  });
  assert.match(readyHtml, /data-rescue="experiment-open"/);
  assert.match(text(readyHtml), /打开 4 页交互实验/);
  assert.match(text(readyHtml), /关闭窗口就会回到这道题/);

  // No-model fallback: DSH host mode -> rescue-handoff with Send to main chat (companion.rescue)
  assert.equal(rescueGate('experiment', { modelReady: false, canChat: true }).type, 'rescue-handoff');
  const dshFallbackHtml = renderWb({
    data: { ...baseProps.data, model: { ready: false } },
    initial: { expanded: ['c1'], rescuePrompt: { cardId: 'c1', type: 'rescue-handoff', kind: 'experiment' } },
  }, { host: { capabilities: { chat: true } } });
  assert.match(dshFallbackHtml, /data-hand-off="companion\.rescue"/);
  assert.match(text(dshFallbackHtml), /发给主会话/);
  assert.match(text(dshFallbackHtml), /回到这里刷新/);

  // No-model fallback: Standalone Desktop mode (capabilities.chat === false) -> model/CLI setup, ZERO dead main-chat button
  const desktopGate = rescueGate('experiment', { modelReady: false, canChat: false });
  assert.equal(desktopGate.type, 'no-model');
  const desktopFallbackHtml = renderWb({
    data: { ...baseProps.data, model: { ready: false } },
    initial: { expanded: ['c1'], rescuePrompt: { cardId: 'c1', ...desktopGate } },
  }, { host: { capabilities: { chat: false } } });
  assert.match(text(desktopFallbackHtml), /打开模型设置/);
  assert.doesNotMatch(desktopFallbackHtml, /data-hand-off="companion\.rescue"/);
  assert.doesNotMatch(text(desktopFallbackHtml), /发给主会话/);

  // Hand-off text for companion.rescue in zh & en
  const zhPrompt = handOffText('companion.rescue', { course: 'PE', deckId: 'd4', cardId: 'c1', topic: '熔断', prompt: '何时熔断？', yourAnswer: '第一次超时', correctAnswer: '达到阈值' }, 'zh');
  assert.match(zhPrompt, /study-companion/);
  assert.match(zhPrompt, /companion\.compile/);
  assert.match(zhPrompt, /mode: "rescue"/);

  // companion-ref resolves lessonMode: 'rescue' & passes returnLabel to CompanionViewer
  const target = resolveCompanionTarget({
    card: { companionRef: { companionId: 'comp-r1', slide: 1, mode: 'rescue' } },
    courses: [{ name: 'PE', companions: [{ id: 'comp-r1', title: 'Rescue Lab', lessonMode: 'rescue', slideCount: 4 }] }],
    sources: [],
  });
  assert.equal(target.lessonMode, 'rescue');
  assert.equal(companionSlideButtonLabel(target), '打开 4 页交互实验');
  let openedModal = null;
  openCompanionTarget((m) => { openedModal = m; }, target, { returnLabel: '返回错题', from: 'wrongbook' });
  assert.equal(openedModal.returnLabel, '返回错题');
  assert.equal(openedModal.from, 'wrongbook');

  // CompanionViewer renders explicit return button when launched from WrongBook
  const viewerHtml = renderToStaticMarkup(withStudy(StudyServicesContext, React.createElement(CompanionViewer, {
    modal: {
      ...openedModal,
      initialState: {
        status: 'ready',
        companion: { id: 'comp-r1', title: 'Rescue Lab', course: 'PE', lessonMode: 'rescue', slideCount: 4 },
        html: '<!doctype html><html><body></body></html>',
        lesson: { id: 'r1', title: 'Rescue Lab', slideCount: 4, slides: [{ title: 'Predict', beat: 'predict' }] },
        bootConfig: { channelToken: 'tok' },
        relatedCards: [],
      },
    },
    onClose: noop,
  }), {}));
  assert.match(viewerHtml, /data-companion-return/);
  assert.match(text(viewerHtml), /返回错题/);

  // English bilingual parity: ZERO Chinese characters across all new UI states & hand-off prompt
  setUiLanguage('en');
  try {
    const enDecks = [{ id: 'd4', course: 'PE', title: 'Final Exam' }];
    const enItem = { ...item, deckTitle: 'Final Exam' };
    const enBase = { data: { ...baseProps.data, decks: enDecks }, items: [enItem] };

    for (const [label, extra, services] of [
      ['default collapsed', { ...enBase, initial: { expanded: ['c1'] } }, {}],
      ['expanded other ways', { ...enBase, initial: { expanded: ['c1'], rescueOtherOpen: ['c1'] } }, {}],
      ['running progress', { ...enBase, initial: { expanded: ['c1'], experimentJobs: { c1: { status: 'running', stage: 'rescue-author' } } } }, {}],
      ['ready state', { ...enBase, initial: { expanded: ['c1'], experimentJobs: { c1: { status: 'ready', companionId: 'comp-r1', course: 'PE' } } } }, {}],
      ['DSH no-model handoff', { ...enBase, data: { ...enBase.data, model: { ready: false } }, initial: { expanded: ['c1'], rescuePrompt: { cardId: 'c1', type: 'rescue-handoff', kind: 'experiment' } } }, { host: { capabilities: { chat: true } } }],
      ['Desktop no-model setup', { ...enBase, data: { ...enBase.data, model: { ready: false } }, initial: { expanded: ['c1'], rescuePrompt: { cardId: 'c1', ...rescueGate('experiment', { modelReady: false, canChat: false }) } } }, { host: { capabilities: { chat: false } } }],
    ]) {
      const html = renderWb(extra, services);
      assert.doesNotMatch(text(html), HAN_RE, `English WrongBook (${label}) must contain zero Chinese`);
    }

    const enPrompt = handOffText('companion.rescue', { course: 'PE', deckId: 'd4', cardId: 'c1', topic: 'Circuit Breaker', prompt: 'When does it open?', yourAnswer: 'First timeout', correctAnswer: 'Threshold' }, 'en');
    assert.doesNotMatch(enPrompt, HAN_RE, 'English companion.rescue hand-off prompt must contain zero Chinese');
    assert.match(enPrompt, /study-companion/);
    assert.match(enPrompt, /companion\.compile/);
  } finally {
    setUiLanguage('zh');
  }
});
