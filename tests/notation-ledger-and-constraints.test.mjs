import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { switchOptions } from './helpers/runtime-switch.mjs';
import {
  NOTATION_LEDGER_MAX,
  buildNotationLedger,
  classifyPrioritySource,
  formatNotationFence,
  mergeNotationLedger,
  resolveCourseNotationLedger,
} from '../lib/contexts/generation/contracts.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { itemId } from '../lib/course-book-inventory.js';
import { bookConstraintsForSources, courseGenerationContext } from '../lib/contexts/generation/generate/book-constraints.js';
import { blueprintPrompts, planPrompts } from '../lib/assessment-quality.js';
import { authorPrompts, generateDeck } from '../lib/generation.js';
import { caseAuthorPrompt } from '../lib/case-study.js';
import { writePrompt, reviewPrompt, repairPrompt } from '../lib/contexts/generation/book/prompts.js';
import { planCompanionBuild } from '../lib/contexts/generation/companion/plan.js';
import { act1Prompt, act2Prompt, blueprintPrompt, rescueLessonPrompt } from '../lib/contexts/generation/companion/prompts.js';
import { learnerFacts } from '../lib/learner-facts.js';
import { learnerBrief, writeVariants } from '../lib/coach.js';

const uiCompiled = await build({
  stdin: {
    contents: [
      "export { draftFromCourse, payloadFromDraft } from './ui/CourseSettings.jsx';",
      "export { default as CourseNotationEditor } from './ui/course-rules/CourseNotationEditor.jsx';",
      "export { StudyServicesContext } from './ui/study-context.jsx';",
      "export { setUiLanguage } from './ui/i18n.js';",
    ].join('\n'),
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom', 'react-dom/*', '@base-ui/*'],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const req = createRequire(import.meta.url);
const uiMod = { exports: {} };
new Function('require', 'module', 'exports', uiCompiled.outputFiles[0].text)(req, uiMod, uiMod.exports);
const { draftFromCourse, payloadFromDraft, CourseNotationEditor, StudyServicesContext, setUiLanguage } = uiMod.exports;

const HAN_RE = /[\u4e00-\u9fff]/;

test('1. Course Notation Ledger: priority slides/exam > textbook > live, cap 40, and manual overrides win', () => {
  assert.equal(classifyPrioritySource({ title: 'Midterm Sample Paper 2025' }), 'exam');
  assert.equal(classifyPrioritySource({ title: 'Lecture 03 Slides - Convergence', format: 'pptx' }), 'slides');
  assert.equal(classifyPrioritySource({ title: 'Week 3 Live Recording', hasAudio: true }), 'live');
  assert.equal(classifyPrioritySource({ title: 'Analysis Textbook Chapter 2', format: 'pdf' }), 'textbook');

  const sources = [
    { id: 'src-live', title: '第 3 讲课堂实录', hasAudio: true },
    { id: 'src-book', title: '数学分析教材第 2 章', format: 'pdf' },
    { id: 'src-slides', title: 'Lecture 03 Slides · 收敛性', format: 'pptx' },
    { id: 'src-exam', title: '2025 期末样卷', role: 'past-paper' },
  ];
  const inventory = {
    documents: [],
    items: [
      {
        id: 'i11111111111',
        kind: 'term',
        name: '一致性收敛 (Uniform convergence)',
        gist: '课堂口述：区间上统一靠近极限',
        places: [{ sourceId: 'src-live', doc: 'd-live', range: 'r1', start: 0, end: 10, quote: '一致性收敛', verified: true }],
      },
      {
        id: 'i22222222222',
        kind: 'definition',
        name: '一致收敛 (Uniform convergence)',
        gist: '教材定义：存在不依赖 x 的 N',
        places: [{ sourceId: 'src-book', doc: 'd-book', range: 'r2', start: 0, end: 10, quote: '一致收敛', verified: true }],
      },
      {
        id: 'i33333333333',
        kind: 'formula',
        name: 'Uniform Convergence $f_n \\rightrightarrows f$',
        gist: '课件标准：sup |f_n(x) - f(x)| -> 0',
        key: true,
        places: [{ sourceId: 'src-slides', doc: 'd-slides', range: 'r3', start: 0, end: 20, quote: 'Uniform Convergence', verified: true }],
      },
      {
        id: 'i44444444444',
        kind: 'term',
        name: '特征值 $\\lambda$',
        gist: '样卷标准记法',
        places: [{ sourceId: 'src-exam', doc: 'd-exam', range: 'r4', start: 0, end: 10, quote: '特征值', verified: true }],
      },
      {
        id: 'i55555555555',
        kind: 'example',
        name: '普通示例（非术语/公式）',
        gist: '不应进入符号口径表',
        places: [{ sourceId: 'src-slides', doc: 'd-slides', range: 'r3', start: 30, end: 40, quote: '普通示例', verified: true }],
      },
    ],
  };

  const built = buildNotationLedger(inventory, { sources });
  assert.equal(built.length, 2, 'near-duplicate live/textbook/slides entries merge into 1; example kind excluded');
  const uc = built.find(e => /Uniform Convergence/i.test(e.canonical));
  assert.ok(uc, 'slides entry wins canonical over textbook and live');
  assert.equal(uc.prioritySource, 'slides');
  assert.equal(uc.symbol, 'f_n \\rightrightarrows f');
  assert.ok(uc.aliases.some(a => a.includes('一致收敛')), 'textbook/live names preserved in aliases');
  const eig = built.find(e => e.canonical.includes('特征值'));
  assert.equal(eig?.prioritySource, 'exam');
  assert.equal(eig?.symbol, '\\lambda');

  // Cap at 40 entries
  const manyItems = Array.from({ length: 55 }, (_, i) => ({
    id: `i${String(i).padStart(11, '0')}`,
    kind: 'term',
    name: `Term-${i}`,
    gist: `Meaning ${i}`,
    places: [{ sourceId: 'src-book', doc: 'd-book', range: 'r', start: 0, end: 5, quote: 'q', verified: true }],
  }));
  assert.equal(buildNotationLedger({ items: manyItems }, { sources }).length, NOTATION_LEDGER_MAX);

  // Manual override always takes highest priority and merges superseded canonical into aliases
  const merged = mergeNotationLedger(built, [
    { canonical: '一致收敛', symbol: 'f_n \\to f\\text{ (unif.)}', aliases: ['UC'], meaning: '手写标准：全区间统一收敛' },
  ]);
  assert.equal(merged[0].canonical, '一致收敛');
  assert.equal(merged[0].symbol, 'f_n \\to f\\text{ (unif.)}');
  assert.equal(merged[0].meaning, '手写标准：全区间统一收敛');
  assert.ok(merged[0].aliases.some(a => /Uniform Convergence/i.test(a)));
  assert.equal(merged.length, 2);
});

test('2. Store v5 compat, course.save/course.merge notationOverrides, and outline id stability', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'study-notation-store-'));
  const service = new StudyService(join(tmp, 'library'), switchOptions('runtime'));
  t.after(async () => {
    await service.dispose();
    await rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // Outline id without notationLedger stays backward compatible
  const baseOutlineInput = {
    title: '数学分析 · 总纲',
    course: '数学分析',
    orderBasis: { codes: ['numbering'] },
    fingerprint: '12345678',
    nodes: [{ id: 'ch-1', title: '收敛', children: [{ id: 'p-1', title: '一致收敛', anchors: ['doc-1'] }] }],
    other: { anchors: [] },
  };
  const withoutLedger = courseOutlineMaterial(baseOutlineInput);
  const withEmptyLedger = courseOutlineMaterial({ ...baseOutlineInput, notationLedger: [] });
  assert.equal(withoutLedger.id, withEmptyLedger.id);
  assert.equal(withoutLedger.courseOutline.notationLedger, undefined);

  const withLedger = courseOutlineMaterial({
    ...baseOutlineInput,
    notationLedger: [{ canonical: '一致收敛', symbol: 'f_n \\rightrightarrows f', aliases: ['Uniform convergence'], meaning: '统一 N', prioritySource: 'slides' }],
  });
  assert.equal(withLedger.courseOutline.notationLedger.length, 1);

  // Save manual overrides via existing course.save (0 new actionGrants)
  const saved = await service.call('course.save', {
    name: '数学分析',
    notationOverrides: [
      { canonical: '一致收敛', symbol: '\\rightrightarrows', aliases: ['UC'], meaning: '闭区间统一逼近' },
    ],
  });
  assert.equal(saved.notationOverrides.length, 1);
  assert.equal(saved.notationOverrides[0].symbol, '\\rightrightarrows');

  // Merge another course's overrides cleanly
  const other = await service.call('course.save', {
    name: '数学分析旧班',
    notationOverrides: [
      { canonical: '柯西列', symbol: '(x_n)', aliases: ['Cauchy sequence'], meaning: '任意 eps 存在 N' },
    ],
  });
  const mergedCourse = await service.call('course.merge', { from: [other.id], into: saved.id });
  assert.equal(mergedCourse.course.notationOverrides.length, 2);

  // Clearing overrides with [] deletes field cleanly
  const cleared = await service.call('course.save', { id: saved.id, name: '数学分析', notationOverrides: [] });
  assert.equal(cleared.notationOverrides, undefined);
});

test('3. Prompt injection across all 5 surfaces + zero regression when absent', async () => {
  const itemA = itemId('逐点收敛', 'term');
  const itemB = itemId('一致收敛', 'term');
  const rawSrc = {
    id: 'src-raw-1',
    title: 'Lecture 03 Slides',
    format: 'pptx',
    courses: ['数学分析'],
    text: '第 1 节 收敛性\n若对每个固定点 x 都有 lim f_n(x) = f(x)，则称函数列逐点收敛。若存在不依赖 x 的 N(ε) 使 sup |f_n(x)-f(x)| < ε，则称函数列一致收敛，闭区间连续函数列一致收敛可交换极限与积分。',
    createdAt: '2026-10-01T00:00:00Z',
  };
  const state = {
    courses: [{
      id: 'course-ma',
      name: '数学分析',
      aliases: ['Math Analysis'],
      notationOverrides: [
        { canonical: '一致收敛', symbol: 'f_n \\rightrightarrows f', aliases: ['Uniform convergence'], meaning: 'N 只依赖 ε 不依赖 x' },
      ],
      createdAt: '2026-10-01T00:00:00Z',
    }],
    sources: [rawSrc],
    decks: [{
      id: 'deck-ma',
      title: '收敛性练习',
      course: '数学分析',
      cards: [{
        id: 'card-1',
        kind: 'quiz',
        topic: '一致收敛',
        prompt: '一致收敛与逐点收敛的核心区别是什么？',
        answer: 'N 不依赖 x',
        citations: [{ sourceId: 'src-raw-1', quote: '若存在不依赖 x 的 N(ε) 使 sup |f_n(x)-f(x)| < ε，则称函数列一致收敛' }],
      }],
    }],
    attempts: [],
  };
  const docs = groupSourcesByDocument(state.sources);
  const docKey = docs[0].key;
  const fp = materialsFingerprint(buildOutlineIndex({ ...state, documents: [], drafts: [] }, { course: '数学分析' }).allDocuments);
  const outlineRec = {
    ...courseOutlineMaterial({
      title: '数学分析 · 总纲',
      course: '数学分析',
      orderBasis: { codes: ['numbering'] },
      fingerprint: fp,
      language: 'zh',
      nodes: [{ id: 'ch-1', title: '函数列收敛', children: [{ id: 'leaf-uc', title: '一致收敛', anchors: [docKey], items: [itemA, itemB] }] }],
      other: { anchors: [] },
      notationLedger: [
        { canonical: 'Uniform Convergence', symbol: 'u.c.', aliases: ['一致收敛'], meaning: 'slides', prioritySource: 'slides' },
        { canonical: '逐点收敛', symbol: 'f_n \\to f', aliases: ['Pointwise convergence'], meaning: 'N 依赖 x', prioritySource: 'textbook' },
      ],
    }),
    createdAt: '2026-10-02T00:00:00Z',
  };
  const notesRec = {
    ...courseNotesMaterial({
      title: '数学分析 · 复习全书',
      course: '数学分析',
      language: 'zh',
      outlineId: outlineRec.id,
      leaves: [{
        id: 'leaf-uc',
        title: '一致收敛',
        anchors: [docKey],
        body: {
          fingerprint: '1111111111111111',
          status: 'ok',
          coverage: { must: 2, covered: [itemA, itemB], missing: [], optional: 0 },
          units: [{
            text: '复习全书专属改写正文：逐点收敛管单点，一致收敛锁住整个区间上确界。[^1]',
            cites: [{ n: 1, sourceId: 'src-raw-1', quote: '若对每个固定点 x 都有 lim f_n(x) = f(x)，则称函数列逐点收敛' }],
            covered: [itemA, itemB],
            read: [{ sourceId: 'src-raw-1', start: 0, end: 90 }],
            status: 'ok',
            cards: [
              { item: itemA, name: '逐点收敛', plain: '固定 x 后收敛', pitch: 'N 依赖 x 与 ε', relations: [{ kind: 'opposite', item: itemB, name: '一致收敛' }] },
              { item: itemB, name: '一致收敛', plain: '整区间同步收敛', pitch: 'N 仅依赖 ε', relations: [{ kind: 'opposite', item: itemA, name: '逐点收敛' }] },
            ],
          }],
        },
      }],
      confusables: [{
        items: [itemA, itemB],
        print: 'aaaaaaaaaaaaaaaa',
        rows: [
          { aspect: 'what', cells: ['固定 x 后数列收敛', '上确界误差趋于 0'] },
          { aspect: 'difference', cells: ['N 依赖 x', 'N 与 x 无关'] },
          { aspect: 'mistake', cells: ['误以为逐点收敛即可交换积分极限', '忽略闭区间连续前提'] },
        ],
      }],
      examKit: {
        fingerprint: 'bbbbbbbbbbbbbbbb',
        language: 'zh',
        questions: [{ id: '123456789abc', paper: 'p1', title: '2025 期末样卷', label: 'Q2', quote: '证明函数列在 [0,1] 上一致收敛并求积分极限', sourceId: 'src-raw-1' }],
        types: [{
          print: 'cccccccccccccccc',
          name: '一致收敛判定与极限交换',
          family: 'proof',
          signals: ['一致收敛', '交换极限与积分'],
          asks: '先用 M 判别法或上确界证明一致收敛，再验证连续性以交换极限与积分',
          template: '步骤 1：计算 [上确界表达式]；步骤 2：证明趋于 0；步骤 3：援引 [定理名称] 交换运算。',
          questions: ['123456789abc'],
          fills: [],
          leaves: ['leaf-uc'],
        }],
      },
    }),
    createdAt: '2026-10-03T00:00:00Z',
  };
  state.sources.push(outlineRec, notesRec);

  // 1) Resolved ledger merges manual override > outline
  const resolved = resolveCourseNotationLedger(state, 'Math Analysis');
  assert.equal(resolved[0].canonical, '一致收敛');
  assert.equal(resolved[0].symbol, 'f_n \\rightrightarrows f');
  assert.ok(resolved.some(e => e.canonical === '逐点收敛'));

  // 2) T01 + C001 read-only generation constraints
  const constraints = bookConstraintsForSources(state, { course: '数学分析', sources: [rawSrc], kind: 'quiz' });
  assert.equal(constraints?.confusables?.length, 1);
  assert.equal(constraints.confusables[0].code, 'C001');
  assert.ok(constraints.confusables[0].mistake[0].includes('误以为逐点收敛即可交换积分极限'));
  assert.equal(constraints?.templates?.length, 1);
  assert.equal(constraints.templates[0].code, 'T01');
  assert.deepEqual(constraints.templates[0].signals, ['一致收敛', '交换极限与积分']);

  const genCtx = courseGenerationContext(state, { course: '数学分析', sources: [rawSrc], kind: 'quiz' });
  const planP = planPrompts({ kind: 'quiz', count: 1, language: 'zh', sources: [rawSrc], ...genCtx });
  assert.ok(planP.prompt.includes('courseNotationLedger'));
  const bpP = blueprintPrompts({ kind: 'quiz', count: 1, language: 'zh', sources: [rawSrc], ...genCtx }, { targets: [{ targetId: 'target-1', objective: '区分一致收敛', knowledge: 'N 不依赖 x', citations: [] }] });
  assert.ok(bpP.prompt.includes('bookConstraints') && bpP.prompt.includes('C001') && bpP.prompt.includes('NEVER from review book prose'));
  const openBpP = blueprintPrompts({ kind: 'open', count: 1, language: 'zh', sources: [rawSrc], ...genCtx }, { targets: [{ targetId: 'target-1', objective: '证明一致收敛', knowledge: '上确界归零', citations: [] }] });
  assert.ok(openBpP.prompt.includes('T01.signals'));
  const authP = authorPrompts({ kind: 'quiz', count: 1, language: 'zh', sources: [rawSrc], ...genCtx }, { targets: [] }, { items: [] });
  assert.ok(authP.prompt.includes('courseNotationLedger') && authP.prompt.includes('bookConstraints'));
  const caseP = caseAuthorPrompt({ language: 'zh', questions: 2, totalMarks: 20, sources: [rawSrc], ...genCtx });
  assert.ok(caseP.prompt.includes('courseNotationLedger') && caseP.prompt.includes('T01.signals'));

  // 3) Review book build prompts
  const ledgerFence = formatNotationFence(resolved);
  const unit = { n: 1, of: 1, checklist: [{ alias: 'c1', kind: 'term', name: '一致收敛', priority: 'must' }], segments: [{ material: 'Lecture 03 Slides', text: rawSrc.text }] };
  const leaf = { title: '一致收敛', path: ['函数列收敛'] };
  const bookPlan = { language: 'zh', pitchLanguage: 'zh', notationLedger: ledgerFence };
  assert.ok(writePrompt(unit, leaf, bookPlan).prompt.includes('COURSE NOTATION LEDGER'));
  assert.ok(reviewPrompt(unit, leaf, { text: 'test', cards: [] }, bookPlan).prompt.includes('COURSE NOTATION LEDGER'));
  assert.ok(repairPrompt(unit, leaf, { text: 'test', cites: [], cards: [] }, { round: 1, missing: [], issues: [] }, bookPlan).prompt.includes('COURSE NOTATION LEDGER'));
  // Zero regression when notationLedger absent
  assert.ok(!writePrompt(unit, leaf, { language: 'zh', pitchLanguage: 'zh' }).prompt.includes('COURSE NOTATION LEDGER'));

  // 4) Companion build (full + rescue)
  const fullCompPlan = planCompanionBuild(state, { course: '数学分析', topic: '一致收敛', sourceIds: ['src-raw-1'], language: 'zh' });
  assert.ok(fullCompPlan.notationLedger?.length >= 2);
  assert.ok(blueprintPrompt(fullCompPlan).prompt.includes('courseNotationLedger'));
  assert.ok(act1Prompt(fullCompPlan, {}).prompt.includes('courseNotationLedger'));
  assert.ok(act2Prompt(fullCompPlan, {}, []).prompt.includes('courseNotationLedger'));
  const rescueCompPlan = planCompanionBuild(state, { mode: 'rescue', course: '数学分析', deckId: 'deck-ma', cardIds: ['card-1'], language: 'zh' });
  assert.ok(rescueCompPlan.notationLedger?.length >= 2);
  assert.ok(rescueLessonPrompt(rescueCompPlan).prompt.includes('courseNotationLedger'));

  // 5) Study (learnerFacts) + Coach (learnerBrief & writeVariants)
  const facts = learnerFacts(state, '数学分析');
  assert.ok(facts?.notationLedger?.length >= 2);
  assert.equal(facts.notationLedger[0].symbol, 'f_n \\rightrightarrows f');
  const brief = learnerBrief({}, facts, 'zh');
  assert.equal(brief.courseNotationLedger?.[0]?.canonical, '一致收敛');
  let capturedCoachPrompt = '';
  await writeVariants(
    async (_sys, prompt) => { capturedCoachPrompt = prompt; return JSON.stringify({ cards: [] }); },
    { targets: [{ deck: state.decks[0], card: state.decks[0].cards[0], kind: 'quiz', reason: 'wrong' }], sources: [rawSrc], learner: {}, facts, language: 'zh' },
  );
  assert.ok(capturedCoachPrompt.includes('courseNotationLedger'));
  assert.ok(capturedCoachPrompt.includes('f_n \\\\rightrightarrows f'));
});

test('4. Fake-model generation with C001/T01 strictly enforces verbatim raw source citations (rejects review book prose)', async () => {
  const rawSource = {
    id: 'src-raw-1',
    title: 'Lecture 03 Slides',
    text: 'Uniform convergence requires a single N(epsilon) independent of x across the whole interval so that sup |f_n(x) - f(x)| < epsilon. Pointwise convergence allows N(x, epsilon) to vary with x.',
  };
  const bookConstraints = {
    confusables: [{
      code: 'C001',
      names: ['Pointwise convergence', 'Uniform convergence'],
      difference: ['N depends on x', 'Single N independent of x'],
      mistake: ['Assuming pointwise convergence preserves integral limits'],
    }],
  };
  const notationLedger = [{ canonical: 'Uniform convergence', symbol: 'f_n \\rightrightarrows f', aliases: ['UC'], meaning: 'Single N independent of x' }];

  // Case A: Fake model tries to quote review-book prose instead of rawSource -> rejected by planAssessment!
  const fakeCitingBookProse = async () => JSON.stringify({
    targets: [{
      objective: 'Distinguish uniform from pointwise convergence',
      knowledge: 'Uniform convergence uses a single N independent of x',
      citations: [{ sourceId: 'src-raw-1', quote: 'Review book prose: pointwise manages one point while uniform locks the supremum' }],
    }],
  });
  await assert.rejects(
    () => generateDeck(fakeCitingBookProse, {
      kind: 'quiz', count: 1, language: 'en', sources: [rawSource], bookConstraints, notationLedger,
    }),
    /Assessment plan is not usable|quote|source/i,
    'quotes from review book prose MUST be rejected; only verbatim raw sources pass',
  );

  // Case B: Fake model uses C001 trap as distractor AND quotes verbatim rawSource -> passes!
  const seenPrompts = [];
  let stageCall = 0;
  const fakeValidModel = async (_sys, prompt) => {
    seenPrompts.push(prompt);
    stageCall++;
    if (stageCall === 1) {
      return JSON.stringify({
        targets: [{
          objective: 'Distinguish uniform convergence from pointwise convergence',
          knowledge: 'Uniform convergence requires a single N(epsilon) independent of x across the whole interval',
          citations: [{ sourceId: 'src-raw-1', quote: 'Uniform convergence requires a single N(epsilon) independent of x across the whole interval' }],
        }],
      });
    }
    if (stageCall === 2) {
      return JSON.stringify({
        items: [{
          targetId: 'target-1',
          answer: 'A single N(epsilon) works simultaneously for all x on the interval',
          reasoning: 'Uniform convergence requires a single N(epsilon) independent of x, whereas pointwise convergence allows N(x, epsilon) to vary with x.',
          scenario: { kind: 'none', facts: [], decisiveConditions: [] },
          comparisonAxis: 'Dependence of threshold index N on x',
          options: [
            { id: 'a', text: 'A single N(epsilon) works simultaneously for all x on the interval', correct: true, explanation: 'Matches the uniform convergence requirement that N is independent of x.' },
            { id: 'b', text: 'N(x, epsilon) is allowed to depend on each individual point x', correct: false, explanation: 'That describes pointwise convergence (C001 confusable trap), not uniform convergence.' },
            { id: 'c', text: 'Convergence only needs to hold at the endpoints of the interval', correct: false, explanation: 'Uniform convergence requires control across the whole interval.' },
          ],
        }],
      });
    }
    if (stageCall === 3) {
      return JSON.stringify({
        deck: {
          title: 'Uniform Convergence',
          cards: [{
            id: 'q1',
            targetId: 'target-1',
            kind: 'quiz',
            topic: 'Uniform convergence',
            objective: 'Distinguish uniform convergence from pointwise convergence',
            prompt: 'Which condition distinguishes uniform convergence from pointwise convergence on an interval?',
            answer: 'A single N(epsilon) works simultaneously for all x on the interval',
            hint: 'Check whether the threshold index depends on the point x.',
            explanation: 'Uniform convergence requires one N(epsilon) independent of x; allowing N to vary with x is only pointwise convergence.',
            misconception: 'Confusing pointwise convergence N(x, epsilon) with uniform convergence.',
            citations: [{ sourceId: 'src-raw-1', quote: 'Uniform convergence requires a single N(epsilon) independent of x across the whole interval' }],
            options: [
              { id: 'a', text: 'A single N(epsilon) works simultaneously for all x on the interval', correct: true, explanation: 'Matches the uniform convergence requirement that N is independent of x.' },
              { id: 'b', text: 'N(x, epsilon) is allowed to depend on each individual point x', correct: false, explanation: 'That describes pointwise convergence (C001 confusable trap), not uniform convergence.' },
              { id: 'c', text: 'Convergence only needs to hold at the endpoints of the interval', correct: false, explanation: 'Uniform convergence requires control across the whole interval.' },
            ],
          }],
        },
        changes: [],
        checks: [{ cardId: 'q1', selfContained: 'pass', answerLeak: 'pass', optionQuality: 'pass', learningValue: 'pass', sourceSupport: 'pass', explanationQuality: 'pass', explanation: 'All options grounded in raw source and distinguish pointwise vs uniform convergence.' }],
      });
    }
    return JSON.stringify({
      issues: [],
      suggestions: [],
      checks: [{ cardId: 'q1', selfContained: 'pass', answerLeak: 'pass', optionQuality: 'pass', learningValue: 'pass', sourceSupport: 'pass', explanationQuality: 'pass', explanation: 'Verified against verbatim raw source quote and C001 distractor axis.' }],
      summary: 'Grounded in raw source.',
    });
  };

  const generated = await generateDeck(fakeValidModel, {
    kind: 'quiz', count: 1, language: 'en', sources: [rawSource], bookConstraints, notationLedger,
  });
  assert.equal(generated.cards.length, 1);
  assert.equal(generated.cards[0].citations[0].sourceId, 'src-raw-1');
  assert.ok(seenPrompts.some(p => p.includes('C001') && p.includes('courseNotationLedger')));
});

test('5. CourseSettings draft/payload round-trip and CourseNotationEditor en/zh rendering', () => {
  const course = {
    id: 'course-1',
    name: '数学分析',
    notationOverrides: [{ canonical: '一致收敛', symbol: 'f_n \\rightrightarrows f', aliases: ['Uniform convergence', 'UC'], meaning: 'N 不依赖 x' }],
  };
  const draft = draftFromCourse(course);
  assert.equal(draft.notationOverrides.length, 1);
  assert.equal(draft.notationOverrides[0].aliases, 'Uniform convergence; UC');
  const payload = payloadFromDraft(course, draft);
  assert.deepEqual(payload.notationOverrides, [{
    canonical: '一致收敛',
    symbol: 'f_n \\rightrightarrows f',
    aliases: ['Uniform convergence', 'UC'],
    meaning: 'N 不依赖 x',
  }]);

  // Empty course omits notationOverrides from payload
  const emptyPayload = payloadFromDraft({ id: 'c2', name: 'Empty' }, draftFromCourse({ id: 'c2', name: 'Empty' }));
  assert.equal(emptyPayload.notationOverrides, undefined);

  const wrap = element => renderToStaticMarkup(React.createElement(StudyServicesContext.Provider, { value: { busy: false } }, element));
  setUiLanguage('zh');
  const zhHtml = wrap(React.createElement(CourseNotationEditor, { value: draft.notationOverrides, onChange: () => {} }));
  assert.ok(zhHtml.includes('data-course-notation') && zhHtml.includes('添加口径'));

  setUiLanguage('en');
  const enHtml = wrap(React.createElement(CourseNotationEditor, { value: [], onChange: () => {} }));
  assert.ok(enHtml.includes('Add override'));
  assert.equal(HAN_RE.test(enHtml), false, 'English CourseNotationEditor must contain zero Chinese characters');
  setUiLanguage('zh');
});
