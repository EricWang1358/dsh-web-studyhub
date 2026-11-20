import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StudyService } from '../lib/service.js';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { learnerFacts } from '../lib/learner-facts.js';
import { cardLevel } from '../lib/mastery.js';
import { evaluatePointEvidence } from '../lib/evidence/point-evidence.js';
import { pointEvidenceForCard } from '../lib/evidence/course-evidence.js';
import { sliceExamScope } from '../lib/contexts/generation/contracts.js';
import { customPreview } from '../lib/custom-preview.js';
import { planCompanionBuild } from '../lib/contexts/generation/companion/plan.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';

async function until(check, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeRescueLesson({ hid, targetCardIds }) {
  return {
    format: 'studyhub-lesson/1',
    mode: 'rescue',
    id: 'rescue-uniform-conv',
    title: '急救实验：逐点收敛 vs 一致收敛',
    course: '数学分析',
    language: 'zh',
    minutes: 4,
    hid,
    targetCardIds,
    lead: '用 3 分钟边界对照实验拆开逐点收敛与一致收敛。',
    terms: { 一致收敛: '同一个 N 对区间上所有 x 同时生效' },
    slides: [
      {
        beat: 'predict',
        title: '先猜一猜：尖峰面积会怎样？',
        say: '不提前剧透，先选你的直觉判断。',
        blocks: [
          {
            t: 'predict',
            id: 'pred-rescue-1',
            q: '逐点收敛但非一致收敛的尖峰函数列，其积分极限一定等于极限函数的积分吗？',
            options: ['一定相等', '不一定相等，面积可以逃逸'],
            answer: 1,
          },
        ],
      },
      {
        beat: 'run',
        title: '核心对比：逐点 vs 一致',
        say: '对照看看 N 是否依赖 x。',
        blocks: [
          {
            t: 'matrix',
            predictBeforeReveal: true,
            say: '把逐点收敛与一致收敛放在同一组边界里对照。',
            frameworks: [
              { id: 'f1', name: '逐点收敛' },
              { id: 'f2', name: '一致收敛' },
            ],
            scenarios: [
              {
                id: 's1',
                title: '移动尖峰函数序列',
                prompt: '极限的积分是否等于积分的极限？',
                cells: [
                  { badge: '会失效', tone: 'error', verdict: '面积逃逸', why: 'N(x, ε) 依赖 x，尖峰高度不降。' },
                  { badge: '成立', tone: 'success', verdict: '上确界归零', why: '统一 N(ε) 锁住了整体积分误差。' },
                ],
              },
            ],
          },
          {
            t: 'reveal',
            of: 'pred-rescue-1',
            say: '逐点收敛只管单个点，无法控制整个区间上的积分误差。',
          },
        ],
      },
      {
        beat: 'check',
        title: '边界迁移检验',
        say: '换一个新情境验证边界条件。',
        blocks: [
          {
            t: 'quiz',
            q: '在 [0, 1] 上若 f_n(x) 连续且一致收敛于 f(x)，以下哪项一定成立？',
            options: [
              { text: 'lim ∫ f_n = ∫ f 成立', ok: true, why: '闭区间上一致收敛保证极限与积分可交换。' },
              { text: '只需在有理点收敛即可', ok: false, why: '缺少一致收敛控制。' },
              { text: 'f_n 必须单调递增', ok: false, why: '单调不是必要条件。' },
              { text: '积分极限一定为 0', ok: false, why: '取决于极限函数本身。' },
            ],
          },
        ],
      },
    ],
  };
}

test('Batch 1 A+C integration: Stubborn card -> Rescue Companion build/mount -> companion.progress -> PointEvidence comprehension verified across all surfaces', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'study-batch1-ac-'));
  const storeDir = join(tmp, 'library');
  const workspaceDir = join(tmp, 'workspace');
  await mkdir(workspaceDir, { recursive: true });

  let expectedHid = '';
  const fakeComplete = async (_system, prompt) => {
    const parsed = JSON.parse(prompt);
    assert.equal(parsed.mode, 'rescue');
    return JSON.stringify(makeRescueLesson({
      hid: parsed.hid || expectedHid,
      targetCardIds: parsed.targetCardIds || ['card-stubborn-1'],
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

  await service.store.update(st => {
    st.courses.push({ id: 'course-ana', name: '数学分析', createdAt: '2026-10-01T00:00:00Z' });
    st.sources.push({
      id: 'src-real-1',
      title: '第 6 章 函数项级数',
      text: '定理 6.2：若函数列 f_n(x) 在闭区间 [a,b] 上一致收敛于 f(x)，则极限与积分可以交换顺序。',
      format: 'md',
      courses: ['数学分析'],
      createdAt: '2026-10-01T00:00:00Z',
    });
    const docKey = groupSourcesByDocument(st.sources)[0].key;
    const fp = materialsFingerprint(buildOutlineIndex({ ...st, documents: [], drafts: [], attempts: [] }, { course: '数学分析' }).allDocuments);
    const outlineSrc = {
      ...courseOutlineMaterial({
        title: '数学分析 · 总纲',
        course: '数学分析',
        orderBasis: { codes: ['numbering'] },
        fingerprint: fp,
        language: 'zh',
        nodes: [{
          id: 'ch-6',
          title: '函数项级数',
          children: [{
            id: 'node-unif',
            title: '一致收敛与积分交换',
            anchors: [docKey],
          }],
        }],
        other: { anchors: [] },
        counts: { units: 1, leftover: 0, invalid: 0, repeated: 0 },
      }),
      createdAt: '2026-10-02T00:00:00Z',
    };
    st.sources.push(outlineSrc);
    st.sources.push({
      ...courseNotesMaterial({
        title: '数学分析 · 复习全书',
        course: '数学分析',
        outlineId: outlineSrc.id,
        language: 'zh',
        papers: [],
        counts: {},
        leaves: [{
          id: 'node-unif',
          title: '一致收敛与积分交换',
          anchors: [docKey],
          body: {
            fingerprint: 'f'.repeat(16),
            points: ['一致收敛允许极限与积分交换 [^1].'],
            explain: '闭区间上一致收敛允许极限与积分交换。',
            cites: [{ n: 1, sourceId: 'src-real-1', quote: '若函数列 f_n(x) 在闭区间 [a,b] 上一致收敛于 f(x)', start: 0, end: 32 }],
          },
        }],
      }),
      createdAt: '2026-10-02T00:01:00Z',
    });
    st.decks.push({
      id: 'deck-ana-1',
      title: '函数项级数练习',
      course: '数学分析',
      cards: [{
        id: 'card-stubborn-1',
        kind: 'quiz',
        topic: '一致收敛与积分交换',
        prompt: '什么条件保证极限与积分可以交换？',
        answer: '一致收敛',
        options: [
          { id: 'a', text: '逐点收敛即可', correct: false },
          { id: 'b', text: '一致收敛', correct: true },
        ],
        explanation: '逐点收敛不足以保证积分极限可交换。',
        sourceId: 'src-real-1',
        citations: [{ sourceId: 'src-real-1', quote: '若函数列 f_n(x) 在闭区间 [a,b] 上一致收敛于 f(x)' }],
        review: { reps: 4, lapses: 4, state: 3 },
      }, {
        id: 'card-mastered-5',
        kind: 'flashcard',
        topic: '一致收敛与积分交换',
        prompt: '背诵一致收敛定义',
        answer: '对任意 ε>0 存在不依赖 x 的 N。',
        sourceId: 'src-real-1',
        citations: [{ sourceId: 'src-real-1', quote: '闭区间 [a,b] 上一致收敛' }],
        review: { repetitions: 1, interval_days: 4 },
      }],
    });
    st.attempts.push({
      id: 'att-stubborn-1',
      deckId: 'deck-ana-1',
      quiz_id: 'card-stubborn-1',
      assessment: 'graded',
      grade: 1,
      timestamp: '2026-10-03T10:00:00Z',
    }, {
      id: 'att-mastered-5',
      deckId: 'deck-ana-1',
      quiz_id: 'card-mastered-5',
      assessment: 'self',
      grade: 5,
      timestamp: '2026-10-03T10:05:00Z',
    });
  });

  // Open the real review book so manifest assigns the real hid
  const openedBook = await service.call('course.book.open', { course: '数学分析' });
  assert.equal(openedBook.status, 'ok');
  const leafNode = openedBook.nodes[0].children[0];
  expectedHid = leafNode.hid;
  assert.ok(expectedHid, 'review book assigned a real hid');

  // 0. Guardrail: self-rating 5 cardLevel() stays mastered
  const initialState = await service.store.read();
  assert.equal(cardLevel(initialState.decks[0].cards[1], 5), 'mastered');

  // 1. Before rescue companion: comprehension is unverified
  const beforeSummary = await service.call('course.evidence.summary', { course: '数学分析' });
  const beforePoint = beforeSummary.points.find(p => p.hid === expectedHid);
  assert.ok(beforePoint, 'point exists in course.evidence.summary');
  assert.equal(beforePoint.facets.comprehension, 'unverified');
  assert.equal(beforePoint.signals.companionChecksPassed, 0);

  // 2. Run Rescue Companion build end-to-end via StudyService job pipeline
  const started = await service.call('generation.companion.build', {
    mode: 'rescue',
    course: '数学分析',
    deckId: 'deck-ana-1',
    cardIds: ['card-stubborn-1'],
    hid: expectedHid,
    workspace: workspaceDir,
    language: 'zh',
  });
  assert.equal(started.status, 'running');
  let finalJob;
  await until(async () => {
    finalJob = await service.call('job.status', { jobId: started.jobId });
    return finalJob?.status === 'complete' || finalJob?.status === 'failed';
  }, 'rescue companion build job');
  assert.equal(finalJob.status, 'complete', `job failed: ${JSON.stringify(finalJob?.error)}`);

  const mountedState = await service.store.read();
  const compRec = mountedState.courses.find(c => c.name === '数学分析')?.companions?.[0];
  assert.ok(compRec?.id, 'rescue companion registered');
  assert.equal(compRec.mode, 'managed', 'storage mode stays managed');
  assert.equal(compRec.lessonMode, 'rescue');
  assert.equal(compRec.hid, expectedHid);
  assert.deepEqual(compRec.targetCardIds, ['card-stubborn-1']);

  const linkedCard = mountedState.decks[0].cards.find(c => c.id === 'card-stubborn-1');
  assert.equal(linkedCard.companionRef?.companionId, compRec.id);

  // 3. Complete rescue companion interactive checks (intentionally miss Slide 1 predict, pass final quiz)
  await service.call('companion.progress', {
    id: compRec.id,
    course: '数学分析',
    slide: 3,
    slideTotal: 3,
    completed: true,
    checkResults: { 'predict:pred-rescue-1': false, 'check:0': true },
  });

  // 4. Verify PointEvidence immediately flips comprehension -> 'verified' across ALL surfaces
  const afterSummary = await service.call('course.evidence.summary', { course: '数学分析' });
  const afterPoint = afterSummary.points.find(p => p.hid === expectedHid);
  assert.equal(afterPoint.facets.comprehension, 'verified');
  assert.equal(afterPoint.signals.companionChecksPassed, 1);
  assert.ok(afterPoint.signals.companionSlidesDone >= 3);

  const readiness = await service.call('course.custom.readiness', { course: '数学分析' });
  assert.equal(readiness.status, 'ok');
  const readinessPoint = readiness.chapters[0]?.pointEvidence?.find(p => p.hid === expectedHid);
  assert.equal(readinessPoint?.facets?.comprehension, 'verified');

  const crunch = await service.call('book.crunch', { course: '数学分析', date: '2026-10-04' });
  const crunchPoint = crunch.plan?.points?.find(p => p.id === expectedHid) || crunch.points?.find(p => p.id === expectedHid);
  assert.equal(crunchPoint?.evidence?.facets?.comprehension, 'verified');

  const finalState = await service.store.read();
  const facts = learnerFacts(finalState, '数学分析');
  assert.equal(facts.evidence?.points?.find(p => p.hid === expectedHid)?.facets?.comprehension, 'verified');
});

test('Batch 1 A+B integration: confirmed exam scope slices outline-basis course.custom.readiness and preserves PointEvidence gap hints', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'study-batch1-ab-'));
  const storeDir = join(tmp, 'library');
  const service = new StudyService(storeDir, switchOptions('runtime'));
  t.after(async () => {
    await service.dispose();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  await service.store.update(st => {
    st.courses.push({
      id: 'course-alg',
      name: '线性代数',
      focusTopics: ['特征值'],
      custom: {
        version: 1,
        purpose: 'exam',
        scope: { kind: 'exam', note: '只考特征值', resolvedChapters: ['ch-2'] },
        book: { make: true, parts: ['explain'], detail: 'standard' },
        questions: { make: true, kinds: ['quiz'], strength: 'normal' },
        variants: false,
        plan: { kind: 'none' },
      },
      createdAt: '2026-10-01T00:00:00Z',
    });
    st.sources.push({
      id: 'src-alg-1',
      title: '第 1 章 行列式',
      text: '第 1 章 行列式\n行列式性质',
      format: 'md',
      courses: ['线性代数'],
      createdAt: '2026-10-01T00:00:00Z',
    }, {
      id: 'src-alg-2',
      title: '第 2 章 特征值',
      text: '第 2 章 特征值\n特征值与特征向量',
      format: 'md',
      courses: ['线性代数'],
      createdAt: '2026-10-01T00:00:00Z',
    });
    const docs = groupSourcesByDocument(st.sources);
    const key1 = docs.find(d => d.sourceIds.includes('src-alg-1')).key;
    const key2 = docs.find(d => d.sourceIds.includes('src-alg-2')).key;
    const fp = materialsFingerprint(buildOutlineIndex({ ...st, documents: [], drafts: [], attempts: [] }, { course: '线性代数' }).allDocuments);
    st.sources.push({
      ...courseOutlineMaterial({
        title: '线性代数 · 总纲',
        course: '线性代数',
        orderBasis: { codes: ['numbering'] },
        fingerprint: fp,
        language: 'zh',
        nodes: [
          { id: 'ch-1', title: '行列式', children: [{ id: 'p-det', title: '行列式展开', anchors: [key1] }] },
          { id: 'ch-2', title: '特征值与特征向量', children: [{ id: 'p-eig', title: '特征值求解', anchors: [key2] }] },
        ],
        other: { anchors: [] },
        counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 },
      }),
      createdAt: '2026-10-02T00:00:00Z',
    });
    st.decks.push({
      id: 'deck-alg-1',
      title: '线代题组',
      course: '线性代数',
      cards: [{
        id: 'card-eig-weak',
        kind: 'quiz',
        topic: '特征值求解',
        prompt: '矩阵特征值满足什么方程？',
        answer: 'det(A - λI) = 0',
        sourceId: 'src-alg-2',
        citations: [{ sourceId: 'src-alg-2', quote: '特征值与特征向量' }],
        review: { reps: 1, lapses: 1, state: 3 },
      }],
    });
    st.attempts.push({
      id: 'att-eig-1',
      deckId: 'deck-alg-1',
      quiz_id: 'card-eig-weak',
      assessment: 'graded',
      grade: 1,
      timestamp: '2026-10-03T10:00:00Z',
    });
  });

  const readiness = await service.call('course.custom.readiness', { course: '线性代数' });
  assert.equal(readiness.status, 'ok');
  assert.equal(readiness.basis, 'outline');
  assert.deepEqual(readiness.chapters.map(ch => ch.id), ['ch-2'], 'outline-basis readiness strictly slices to confirmed exam resolvedChapters');
  assert.ok(readiness.chapters[0].gapHint, 'sliced exam chapter carries PointEvidence conditional gapHint for weak point');
});

test('Batch 1 audit regressions: predict coin-flip cannot override failed quiz, empty course falls back, Ch3/Lec/Roman refs, preview empty resolvedChapters, uncited card lookup', () => {
  // 1. Slide 1 predict:true + failed final quiz check:0:false must NOT verify comprehension; solo predict:true also stays unverified.
  const baseCard = { deckId: 'd1', cardId: 'c1', level: 'learning', solid: false, weak: false, answered: true, assistedOnly: false, slowCorrect: 0, unseenTransferPassed: false };
  const predictThenFailedQuiz = evaluatePointEvidence({
    hid: 'H1',
    cards: [baseCard],
    companions: [{ id: 'c1', hid: 'H1', progress: { slide: 3, slideTotal: 3, completed: true, checkResults: { 'predict:p1': true, 'check:0': false } } }],
  });
  assert.equal(predictThenFailedQuiz.facets.comprehension, 'unverified');

  const soloPredict = evaluatePointEvidence({
    hid: 'H1',
    cards: [baseCard],
    companions: [{ id: 'c1', hid: 'H1', progress: { slide: 1, slideTotal: 3, completed: false, checkResults: { 'predict:p1': true } } }],
  });
  assert.equal(soloPredict.facets.comprehension, 'unverified');

  // 2. planCompanionBuild with empty string args.course falls back to the card's resolved course.
  const miniState = {
    courses: [{ id: 'c-phys', name: 'Physics' }],
    sources: [{ id: 's1', title: 'Lecture 2 Kinematics', text: 'Velocity and acceleration.', format: 'md', courses: ['Physics'] }],
    decks: [{
      id: 'd-phys',
      title: 'Physics Deck',
      course: 'Physics',
      cards: [{ id: 'card-1', kind: 'quiz', topic: 'Kinematics', prompt: 'What is acceleration?', answer: 'dv/dt', review: { reps: 3, lapses: 3 } }],
    }],
    attempts: [],
    runs: [],
  };
  const rescuePlan = planCompanionBuild(miniState, { mode: 'rescue', course: '', deckId: 'd-phys', cardIds: ['card-1'] });
  assert.equal(rescuePlan.course, 'Physics');

  // 3. Exam-scope slicing handles Ch3, Ch.3, Lec 2, 第2讲, Roman numerals, and avoids false-matching "chi-square".
  const lecState = {
    courses: [{ id: 'c-stat', name: 'Stats', focusTopics: ['Ch3', 'Lec 2', 'Chapter IV', 'chi-square test'] }],
    sources: [
      { id: 's1', title: 'Lec 1 Intro', text: 'Intro', format: 'md', courses: ['Stats'] },
      { id: 's2', title: '第2讲 概率分布', text: 'Distribution', format: 'md', courses: ['Stats'] },
      { id: 's3', title: 'Ch.3 Hypothesis Testing', text: 'Testing', format: 'md', courses: ['Stats'] },
      { id: 's4', title: 'Chapter IV Regression', text: 'Regression', format: 'md', courses: ['Stats'] },
    ],
    decks: [{ id: 'd-stat', title: 'Manual Deck', course: 'Stats', cards: [{ id: 'manual-1', kind: 'flashcard', topic: 'Extra Notes', prompt: 'Q', answer: 'A' }] }],
    attempts: [],
    documents: [],
  };
  const sliced = sliceExamScope(lecState, 'Stats', { language: 'en' });
  const matchedTitles = sliced.matchedChapters.map(c => c.title);
  assert.ok(matchedTitles.some(t => t.includes('第2讲')));
  assert.ok(matchedTitles.some(t => t.includes('Ch.3')));
  assert.ok(matchedTitles.some(t => t.includes('Chapter IV')));
  assert.ok(!matchedTitles.some(t => t.includes('Lec 1')), 'chi-square must not falsely match Chapter I');
  assert.ok(sliced.unmatchedTopics.includes('chi-square test'));

  // 4. customPreview treats empty resolvedChapters: [] as unconfirmed rather than throwing.
  const preview = customPreview(lecState, { course: 'Stats', custom: { purpose: 'review', scope: { kind: 'exam', resolvedChapters: [] } } });
  assert.equal(preview.status, 'ok');
  assert.equal(preview.examScope.confirmed, false);

  // 5. pointEvidenceForCard finds manual/uncited cards even when the course has documents without an AI outline.
  const manualEv = pointEvidenceForCard(lecState, { course: 'Stats', deckId: 'd-stat', cardId: 'manual-1' });
  assert.ok(manualEv, 'uncited manual card has PointEvidence in document-fallback course');
  assert.equal(manualEv.hid, 'topic:d-stat:Extra Notes');
});
