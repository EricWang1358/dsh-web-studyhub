import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { CARD_KIND_IDS, EXAM_KIND_IDS, GENERATE_KIND_IDS, INGEST_KIND_IDS, isExamKind, isGraded, kindOf, practiceCost } from '../lib/card-kinds.js';
import { CARD_KINDS, publicCard, validateDeck } from '../lib/domain.js';
import { normalizeEditableDraftCard, omitInapplicableNullFields } from '../lib/draft-fields.js';
import { autofixDeck } from '../lib/card-autofix.js';
import { prepareJsonImport } from '../lib/json-import.js';
import { importExample } from '../lib/deck-format.js';
import { TASK_RULE, blueprintPrompts, qualityCriteriaFor } from '../lib/assessment-quality.js';
import { authorPrompts, reviewPrompts } from '../lib/generation.js';
import { generateBatched } from '../lib/batch.js';
import { MAX_TASK_ISSUES, normalizeTaskStaticCheck, publicTaskRubric, renderRubric } from '../lib/case-study.js';
import { gradeTaskStatic } from '../lib/rubric-grading.js';
import { stageGate } from '../lib/course-method-gate.js';
import { methodProgress } from '../lib/course-method-progress.js';
import { deriveItemStatus } from '../lib/study-progress.js';
import { libraryContracts } from '../lib/study-contracts.js';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { reviewChoiceKind, shortcutAction } from '../ui/review/session-logic.js';
import { daysAgo, service as readinessService } from './helpers/readiness-library.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const uiMod = await loadUi(`
  export { default as TaskCardRun } from './ui/TaskCardRun.jsx';
  export { default as QuestionRun } from './ui/review/QuestionRun.jsx';
  export { default as Draft } from './ui/Draft.jsx';
  export { CriteriaEditor } from './ui/CaseWorkspace.jsx';
  export { NextDue, nextDueWord } from './ui/NextDue.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { handOffText } from './ui/agent-prompts/index.js';
  export { importPrompt, importExample as uiImportExample } from './ui/json-prompts.js';
  export { kindNote } from './ui/generate-form.js';
  export { customSummary } from './ui/custom-plan-model.js';
  export { readableQualityIssue } from './ui/quality.js';
  export { setUiLanguage, ui } from './ui/i18n.js';
`);
uiMod.setUiLanguage('zh');

const han = /[\u3400-\u9fff]/;

const REDIS_QUOTE = 'To prevent overselling under concurrent requests, check current stock and decrement inside one atomic Redis Lua script.';
const THERMO_QUOTE = 'Starting from the first law dU = TdS - PdV and H = U + PV, apply a Legendre transformation to derive dH = TdS + VdP.';

const sources = [
  { id: 's-code', title: 'Distributed Inventory Notes', text: `${REDIS_QUOTE}\nAlways reject non-positive deduction quantities before mutating keys.` },
  { id: 's-math', title: 'Thermodynamics Lecture 4', text: `${THERMO_QUOTE}\nState every measurability or reversibility assumption explicitly.` },
];

function makeTaskCard(id = 'task-redis', overrides = {}) {
  return {
    id,
    kind: 'task',
    topic: 'Inventory deduction',
    objective: `Implement atomic stock deduction without overselling (${id})`,
    prompt: 'Implement a Redis + Lua stock deduction routine `deductStock(skuKey, qty)` that never oversells under concurrency.',
    answer: '```lua\nlocal qty = tonumber(ARGV[1])\nif not qty or qty <= 0 then return -2 end\nlocal cur = tonumber(redis.call("GET", KEYS[1]) or "0")\nif cur < qty then return -1 end\nreturn redis.call("DECRBY", KEYS[1], qty)\n```',
    hint: 'Check input bounds and stock sufficiency inside the same `EVAL` script before `DECRBY`.',
    explanation: `"${REDIS_QUOTE}" Keeping validation, comparison and decrement in one Lua script makes the check-and-act atomic.`,
    misconception: 'Reading stock with `GET` in application code and calling `DECRBY` in a separate network round-trip.',
    marks: 6,
    rubric: '1. Atomic check-and-decrement (2 marks); 2. Reject non-positive quantity (2 marks); 3. Clear insufficient-stock return code (2 marks).',
    rubricCriteria: [
      { id: 'c1', label: 'Atomic check-and-decrement', marks: 2, descriptor: 'Reads stock and decrements inside one Lua script without split round-trips.', keyPoints: ['Single EVAL script', 'No separate GET then DECRBY'] },
      { id: 'c2', label: 'Input validation', marks: 2, descriptor: 'Rejects zero, negative or non-numeric quantities before touching Redis state.', keyPoints: ['tonumber check', 'qty <= 0 guard'] },
      { id: 'c3', label: 'Insufficient-stock handling', marks: 2, descriptor: 'Returns a distinct sentinel when stock is lower than requested quantity.', keyPoints: ['cur < qty branch'] },
    ],
    citations: [{ sourceId: 's-code', quote: REDIS_QUOTE }],
    ...overrides,
  };
}

function makeDerivationTaskCard(id = 'task-thermo') {
  return {
    id,
    kind: 'task',
    topic: 'Enthalpy differential',
    objective: `Derive the fundamental differential of enthalpy from internal energy (${id})`,
    prompt: 'Starting from $dU = TdS - PdV$ and $H = U + PV$, derive $dH$ step by step on paper or in Markdown and state when $dH = \\delta Q_P$.',
    answer: 'Differentiate $H = U + PV$: $dH = dU + PdV + VdP = (TdS - PdV) + PdV + VdP = TdS + VdP$. At constant pressure ($dP = 0$) for a reversible process ($TdS = \\delta Q_{\\text{rev}}$), $dH = \\delta Q_P$.',
    hint: 'Expand $d(PV)$ using the product rule before substituting $dU$.',
    explanation: `"${THERMO_QUOTE}" Cancelling $-PdV$ and $+PdV$ switches the natural variables from $(S,V)$ to $(S,P)$.`,
    misconception: 'Dropping the $VdP$ term when differentiating $PV$ without first assuming constant pressure.',
    marks: 4,
    rubric: '1. Product rule expansion d(PV) = PdV + VdP (2 marks); 2. Substitution of dU and constant-pressure reversible condition (2 marks).',
    rubricCriteria: [
      { id: 'c1', label: 'Product rule on PV', marks: 2, descriptor: 'Expands d(PV) = PdV + VdP and cancels -PdV cleanly.' },
      { id: 'c2', label: 'Constant-pressure condition', marks: 2, descriptor: 'States dP = 0 and reversible heat condition for dH = delta Q_P.' },
    ],
    citations: [{ sourceId: 's-math', quote: THERMO_QUOTE }],
  };
}

async function setupLibrary(t, cards = [makeTaskCard(), makeDerivationTaskCard()]) {
  const root = await mkdtemp(join(tmpdir(), 'study-task-s4-'));
  const service = new StudyService(root);
  t.after(async () => {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  for (const src of sources) await service.call('source.add', src);
  await service.call('draft.save', { deck: { id: 'd-tasks', title: 'Hands-on Workshop', course: 'CS4224', cards } });
  await service.call('draft.publish', { id: 'd-tasks' });
  return { root, service };
}

test('registry, validator, publicCard, draft conversion and math autofix support universal hands-on task cards', () => {
  const entry = kindOf('task');
  assert.ok(entry);
  assert.deepEqual([entry.label, entry.short], ['动手任务', '动手']);
  assert.equal(entry.options, null);
  assert.equal(entry.answers, null);
  assert.equal(entry.graded, false);
  assert.equal(entry.exam, false);
  assert.equal(entry.generate, true);
  assert.equal(entry.ingest, false);
  assert.equal(practiceCost('task'), 8);
  assert.ok(CARD_KIND_IDS.includes('task') && CARD_KINDS.includes('task') && GENERATE_KIND_IDS.includes('task'));
  assert.ok(!EXAM_KIND_IDS.includes('task') && !INGEST_KIND_IDS.includes('task'));
  assert.equal(isGraded('task'), false);
  assert.equal(isExamKind('task'), false);

  // Both coding and non-coding (math derivation) task cards pass strict validation.
  const valid = validateDeck({ title: 'Workshop', cards: [makeTaskCard(), makeDerivationTaskCard()] }, sources);
  assert.deepEqual(valid.errors, []);

  // Missing acceptance criteria fails with clear English and localized Chinese quality issue.
  const missingRubric = validateDeck({ title: 'Bad', cards: [makeTaskCard('t-bad', { rubric: '', rubricCriteria: undefined })] }, sources);
  assert.match(missingRubric.errors.join('\n'), /hands-on task needs acceptance criteria \(rubric\)/);
  uiMod.setUiLanguage('zh');
  assert.equal(uiMod.readableQualityIssue('Card 1: hands-on task needs acceptance criteria (rubric)'), '第 1 题：动手任务需要验收标准');

  // publicCard shows acceptance criteria (prompt, rubric, rubricCriteria descriptors) while hiding reference solution & keyPoints.
  const pub = publicCard(makeTaskCard());
  assert.equal(pub.kind, 'task');
  assert.equal(pub.marks, 6);
  assert.ok(pub.rubric.includes('Atomic'));
  assert.equal(pub.rubricCriteria.length, 3);
  assert.equal(pub.rubricCriteria[0].descriptor.includes('Lua script'), true);
  assert.equal('keyPoints' in pub.rubricCriteria[0], false, 'keyPoints stay server-side before completion');
  assert.equal('answer' in pub, false, 'reference solution stays folded/hidden before reveal or completion');
  assert.equal('explanation' in pub, false);

  // Draft field normalization & math autofix preserve task fields and sanitize LaTeX in rubricCriteria.
  const keptNullRubric = omitInapplicableNullFields({ kind: 'task', rubric: null, options: null });
  assert.equal('options' in keptNullRubric, false);
  assert.equal(keptNullRubric.rubric, null, 'task retains null rubric so missing rubric stays visible for repair');
  const editable = normalizeEditableDraftCard({ kind: 'task', prompt: 'Write query', rubric: 123, marks: -2 });
  assert.equal(editable.rubric, '');
  assert.equal('marks' in editable, false);

  const { deck: fixedDeck } = autofixDeck(
    {
      title: 'Thermo',
      cards: [{
        ...makeDerivationTaskCard(),
        targetId: 't1',
        rubric: 'Check x^2 + y^2',
        rubricCriteria: [{ id: 'c1', label: 'Derive x^2', marks: 2, descriptor: 'Shows \\alpha + \\beta', keyPoints: ['Uses x^2'] }],
      }],
    },
    {
      assessmentPlan: { targets: [{ targetId: 't1', objective: 'Derive dH' }] },
      answerBlueprint: { items: [{ targetId: 't1', comparisonAxis: 'Legendre transform', reasoning: 'Product rule' }] },
      expectedKind: 'task',
      notation: 'latex',
    },
  );
  assert.match(fixedDeck.cards[0].rubric, /\$x\^\{?2\}? \+ y\^\{?2\}?\$/);
  assert.match(fixedDeck.cards[0].rubricCriteria[0].descriptor, /\$\\alpha \+ \\beta\$/);
});

test('generation, TASK_RULE, fake model and JSON import cover coding and non-coding disciplines without leaking into other kinds', async () => {
  const plan = { targets: [{ targetId: 't1', objective: 'Design an experiment or script', citations: [{ sourceId: 's-code', quote: REDIS_QUOTE }] }] };
  const taskReq = { kind: 'task', count: 1, sources: [sources[0]], language: 'English' };
  for (const stageText of [
    JSON.stringify(blueprintPrompts(taskReq, plan)),
    JSON.stringify(authorPrompts(taskReq, plan)),
    JSON.stringify(reviewPrompts({ sources: [sources[0]], deck: { cards: [makeTaskCard()] }, kind: 'task', count: 1 })),
  ]) {
    assert.ok(stageText.includes('Hands-on task (kind task):'), 'every generation/review stage receives TASK_RULE');
    assert.ok(stageText.includes(TASK_RULE.slice(0, 48)));
    assert.match(stageText, /SQL|derivation|experimental|modeling/i, 'TASK_RULE explicitly spans multiple disciplines beyond coding');
    assert.match(stageText, /has no in-app code editor and never runs tests/i);
  }
  // Other kinds never receive TASK_RULE so their prompts stay byte-identical.
  const quizReq = { ...taskReq, kind: 'quiz' };
  assert.equal(JSON.stringify(blueprintPrompts(quizReq, plan)).includes('Hands-on task (kind task):'), false);
  assert.equal(JSON.stringify(authorPrompts(quizReq, plan)).includes('Hands-on task (kind task):'), false);
  assert.equal(qualityCriteriaFor(['quiz']).includes('Hands-on task'), false);

  // End-to-end generation + independent review using deterministic fake model.
  const fakeComplete = createFakeModel();
  const generated = await generateBatched(fakeComplete, {
    sources,
    count: 2,
    kind: 'task',
    language: '中文',
    performance: { concurrency: 1, batchSize: 2, fillRounds: 0 },
  });
  assert.equal(generated.cards.length, 2);
  for (const card of generated.cards) {
    assert.equal(card.kind, 'task');
    assert.ok(card.prompt.length > 0 && card.rubric.length > 0 && card.answer.length > 0);
    assert.ok(Array.isArray(card.rubricCriteria) && card.rubricCriteria.length >= 2);
    assert.ok(card.citations.length >= 1);
  }
  assert.deepEqual(validateDeck(generated, sources).errors, []);

  // JSON import examples (zh & en) and multi-discipline JSON import (SQL + experimental design).
  for (const lang of ['zh', 'en']) {
    const exampleText = importExample('task', lang);
    const { deck } = prepareJsonImport(exampleText);
    assert.deepEqual(deck.quality.errors, []);
    assert.equal(deck.cards[0].kind, 'task');
    assert.ok(deck.cards[0].rubric.length > 0);
    const promptText = uiMod.importPrompt('task', lang === 'en' ? 'Hands-on task' : '动手任务', lang);
    if (lang === 'en') assert.doesNotMatch(promptText, han);
  }

  const multiDisciplineJson = JSON.stringify({
    title: 'Cross-Discipline Tasks',
    cards: [
      {
        kind: 'task',
        topic: 'Window Functions',
        objective: 'Write a SQL query ranking top-3 products per category without dropping ties',
        prompt: 'Write `top_products.sql` returning the top 3 products by revenue per category using `DENSE_RANK()`.',
        rubric: '1. Partitions by category and orders by revenue DESC; 2. Uses DENSE_RANK <= 3 in outer filter.',
        rubricCriteria: [
          { id: 'sql1', label: 'Window specification', marks: 2, descriptor: 'PARTITION BY category_id ORDER BY revenue DESC' },
          { id: 'sql2', label: 'Tie preservation', marks: 2, descriptor: 'Uses DENSE_RANK() and filters rank <= 3 in CTE/subquery' },
        ],
        answer: 'WITH ranked AS (SELECT *, DENSE_RANK() OVER (PARTITION BY category_id ORDER BY revenue DESC) AS rk FROM sales) SELECT * FROM ranked WHERE rk <= 3;',
        hint: 'Window functions cannot appear directly in WHERE.',
        explanation: 'Filtering on a CTE preserves standard SQL evaluation order and keeps tied ranks.',
        misconception: 'Using LIMIT 3 which drops per-category grouping and ties.',
      },
      {
        kind: 'task',
        topic: 'Randomized Controlled Trial',
        objective: 'Design a double-blind enzyme inhibition assay protocol with negative and positive controls',
        prompt: 'Draft a 1-page lab protocol in `protocol.md` to test competitive vs non-competitive inhibition across 5 substrate concentrations.',
        rubric: '1. Includes vehicle negative control and known inhibitor positive control; 2. Varies [S] across at least 5 concentrations straddling Km; 3. Specifies blinding and replicate count.',
        answer: 'Use 5 substrate concentrations (0.25x to 4x Km), 3 inhibitor levels, vehicle control, known inhibitor control, n=3 technical replicates, coded tubes.',
        hint: 'To distinguish Vmax vs Km shifts on a Lineweaver-Burk or nonlinear fit, bracket Km.',
        explanation: 'Bracketing Km separates apparent Km increase (competitive) from Vmax decrease (non-competitive).',
        misconception: 'Testing only saturating substrate concentration where competitive inhibition disappears.',
      },
    ],
  });
  const imported = prepareJsonImport(multiDisciplineJson);
  assert.deepEqual(imported.deck.quality.errors, []);
  assert.equal(imported.deck.cards.length, 2);
  assert.equal(imported.deck.cards[0].rubricCriteria.length, 2);
});

test('task.check hand-off prompt, study-tutor skill and study-contracts enforce all 4 hard static-check constraints in zh & en', async () => {
  const inputWithFile = {
    deckId: 'd-tasks',
    cardId: 'task-redis',
    runId: 'run-42',
    deckTitle: 'Hands-on Workshop',
    topic: 'Inventory deduction',
    prompt: 'Implement atomic stock deduction with Redis + Lua without overselling.',
    rubric: '1. Atomic check-and-decrement; 2. Reject non-positive qty; 3. Return -1 when stock is insufficient.',
    rubricCriteria: makeTaskCard().rubricCriteria,
    filePath: 'src/stock.lua',
    note: 'Please check concurrency edge cases',
  };

  const zh = uiMod.handOffText('task.check', inputWithFile, 'zh');
  const en = uiMod.handOffText('task.check', inputWithFile, 'en');

  // 1) Scope constraint: read ONLY user-specified file(s), never scan whole repo, never judge unspecified files, never run tests.
  assert.match(zh, /只读我在消息或主会话里明确指定的文件/);
  assert.match(zh, /绝不扫描整个仓库/);
  assert.match(zh, /不运行测试/);
  assert.match(en, /read only the exact file or files I specify/);
  assert.match(en, /never scan the whole repository/);
  assert.match(en, /do not run tests/);

  // 2) Criterion verdicts + max 3 concrete issues.
  assert.match(zh, /满足 \/ 缺失 \/ 有问题（第几行）/);
  assert.match(zh, /satisfied、missing 或 issue/);
  assert.match(zh, /最多指出 3 处具体问题/);
  assert.match(en, /satisfied, missing or issue/);
  assert.match(en, /at most 3 concrete issues/);

  // 3) Strict agency guard: never edit files or output rewritten complete code/derivation/work.
  assert.match(zh, /严禁替我修改文件，严禁直接给出改好的完整代码、完整推导或完整成品/);
  assert.match(en, /never edit my files and never output rewritten complete code, full derivations or finished work/);

  // 4) Write-back via card.grade with exact deckId, cardId, runId.
  assert.match(zh, /card\.grade/);
  assert.match(zh, /"deckId":"d-tasks","cardId":"task-redis","runId":"run-42"/);
  assert.match(en, /card\.grade/);
  assert.match(en, /"deckId":"d-tasks","cardId":"task-redis","runId":"run-42"/);
  assert.doesNotMatch(en, han, 'zero Chinese characters in English hand-off message');

  // Tail behavior: with filePath given, filePath sits inside request fence and no @ tail is appended; without filePath, appends @ file picker tail.
  assert.match(zh, /```request 我的文件与说明\n指定文件：src\/stock\.lua\n补充说明：Please check concurrency edge cases\n```/);
  assert.equal(zh.endsWith('@'), false);
  const zhWithoutFile = uiMod.handOffText('task.check', { ...inputWithFile, filePath: '', note: '' }, 'zh');
  const enWithoutFile = uiMod.handOffText('task.check', { ...inputWithFile, filePath: '', note: '' }, 'en');
  assert.ok(zhWithoutFile.endsWith('文件（不在工作区就粘贴完整路径）：@'));
  assert.ok(enWithoutFile.endsWith('File (paste the full path if it is outside the workspace): @'));

  // Skill & runtime contracts carry the same hard rules.
  const tutorSkill = await readFile(new URL('../skills/study-tutor/SKILL.md', import.meta.url), 'utf8');
  assert.match(tutorSkill, /task\.check/);
  assert.match(tutorSkill, /只读指定文件.*绝不扫描整个仓库/s);
  assert.match(tutorSkill, /最多指出 3 处具体问题/);
  assert.match(tutorSkill, /严禁替学习者改代码或改文件，严禁直接给出改好的完整代码/);
  assert.match(tutorSkill, /card\.grade/);
  assert.match(libraryContracts.cards, /read ONLY the exact file\(s\) specified by the learner/);
  assert.match(libraryContracts.cards, /at most 3 concrete issues/);
  assert.match(libraryContracts.cards, /NEVER edit the learner's files/);
});

test('card.grade writes per-criterion static check back to run & attempts, advances FSRS-6, and strictly caps concrete issues at <= 3', async (t) => {
  const fiveCriteriaCard = makeTaskCard('task-5c', {
    marks: 10,
    rubricCriteria: [
      { id: 'c1', label: 'Atomicity', marks: 2, descriptor: 'Single Lua script execution' },
      { id: 'c2', label: 'Positive qty', marks: 2, descriptor: 'Rejects qty <= 0' },
      { id: 'c3', label: 'Missing key', marks: 2, descriptor: 'Handles nil key safely' },
      { id: 'c4', label: 'Underflow guard', marks: 2, descriptor: 'Never decrements below zero' },
      { id: 'c5', label: 'Return contract', marks: 2, descriptor: 'Returns remaining stock or error sentinel' },
    ],
  });
  const { service } = await setupLibrary(t, [fiveCriteriaCard]);

  const run = await service.call('review.start', { deckId: 'd-tasks', mode: 'quiz' });
  assert.equal(run.card.id, 'task-5c');
  assert.equal(run.dueReview, false, 'brand-new task card is not a due review yet');

  // Invalid status is rejected cleanly.
  await assert.rejects(
    service.call('card.grade', {
      deckId: 'd-tasks',
      cardId: 'task-5c',
      runId: run.id,
      checks: [{ id: 'c1', status: 'passed' }],
    }),
    /satisfied.*missing.*issue/,
  );

  // Submit 5 concrete issues: must strictly truncate concrete issues to MAX_TASK_ISSUES (3)!
  assert.equal(MAX_TASK_ISSUES, 3);
  const graded = await service.call('card.grade', {
    deckId: 'd-tasks',
    cardId: 'task-5c',
    runId: run.id,
    files: ['src/stock.lua'],
    summary: 'Found several concurrency and boundary issues in src/stock.lua.',
    checks: [
      { id: 'c1', status: 'issue', line: 12, feedback: 'GET and DECRBY are split across two client calls instead of one Lua script.', evidence: 'const cur = await redis.get(key)' },
      { id: 'c2', status: 'issue', line: '19-21', feedback: 'Zero quantity passes through without early rejection.' },
      { id: 'c3', status: 'issue', line: 27, feedback: 'tonumber(nil) is not defaulted to 0 before comparison.' },
      { id: 'c4', status: 'issue', line: 34, feedback: 'Comparison uses <= instead of <, blocking exact-stock purchase.' },
      { id: 'c5', status: 'issue', line: 41, feedback: 'Returns boolean true instead of remaining integer stock.' },
    ],
  });

  assert.equal(graded.taskCheck.issues.length, 3, 'concrete issue list strictly capped at 3');
  assert.equal(graded.taskCheck.issueCount, 3);
  assert.equal(graded.taskCheck.totalIssuesFound, 5);
  assert.equal(graded.taskCheck.omittedIssueCount, 2);
  assert.equal(graded.taskCheck.issuesTruncated, true);
  assert.deepEqual(graded.taskCheck.files, ['src/stock.lua']);
  assert.equal(graded.taskCheck.checks[0].line, 12);
  assert.equal(graded.taskCheck.checks[1].line, '19-21');
  assert.equal(graded.taskCheck.checks[3].issueTruncated, true, '4th issue detail is omitted');
  assert.equal(graded.taskCheck.checks[3].detail, undefined);
  assert.equal(graded.taskCheck.checks[4].issueTruncated, true, '5th issue detail is omitted');

  // Verify run projection received the feedback and FSRS-6 schedule advanced.
  const updatedRun = await service.call('review.get', { runId: run.id });
  assert.ok(updatedRun.feedback?.taskCheck);
  assert.equal(updatedRun.feedback.taskCheck.issues.length, 3);
  assert.ok(updatedRun.feedback.nextDue);
  const located = await service.call('card.locate', { deckId: 'd-tasks', cardId: 'task-5c' });
  assert.equal(located.card.review.reps, 1, 'FSRS-6 recorded first review');
  assert.ok(located.card.review.last_review, 'FSRS-6 recorded last_review');
  assert.ok(located.card.review.due_at, 'FSRS-6 scheduled due_at');
  assert.ok(located.card.review.stability > 0, 'FSRS-6 stability computed');

  // Model-backed static grading fallback (gradeTaskStatic) also caps concrete issues at 3 and never runs tests.
  const modelChecked = await gradeTaskStatic(
    async () => JSON.stringify({
      summary: 'Good atomicity; two criteria still missing.',
      checks: [
        { id: 'c1', status: 'satisfied', detail: 'Single EVAL script used.' },
        { id: 'c2', status: 'satisfied', detail: 'Rejects non-positive qty.' },
        { id: 'c3', status: 'missing', detail: 'Missing nil-key default.' },
        { id: 'c4', status: 'satisfied', detail: 'Checks cur < qty.' },
        { id: 'c5', status: 'issue', line: 16, detail: 'Returns string instead of integer.' },
      ],
    }),
    { card: fiveCriteriaCard, title: 'Workshop', answer: 'local cur = tonumber(redis.call("GET", KEYS[1]))', files: ['src/stock.lua'], language: 'en' },
  );
  assert.deepEqual(modelChecked.taskCheck.counts, { satisfied: 3, missing: 1, issue: 1 });
  assert.equal(modelChecked.taskCheck.issues[0].line, 16);
});

test('viewing reference solution before completion marks attempt as 看过答案 (revealedBeforeAnswer) and assisted, never independent', async (t) => {
  const { service } = await setupLibrary(t, [makeTaskCard('task-peek')]);
  const run0 = await service.call('review.start', { deckId: 'd-tasks', mode: 'quiz' });
  assert.equal(run0.revealed, false);
  assert.equal(run0.solution ?? null, null, 'reference solution is hidden initially');

  // Learner clicks 「看参考实现」 (review.reveal) BEFORE completing static check.
  const revealedRun = await service.call('review.reveal', { runId: run0.id, cardId: 'task-peek' });
  assert.equal(revealedRun.revealed, true);
  assert.ok(revealedRun.solution?.answer.includes('DECRBY'), 'reference solution is now visible');
  assert.equal(revealedRun.assistance?.revealedBeforeAnswer, true, 'marked as revealedBeforeAnswer immediately');

  // Even if every criterion is later satisfied in card.grade, assistance.revealedBeforeAnswer stays recorded!
  await service.call('card.grade', {
    deckId: 'd-tasks',
    cardId: 'task-peek',
    runId: run0.id,
    files: ['src/stock.lua'],
    summary: 'All criteria satisfied.',
    checks: [
      { id: 'c1', status: 'satisfied', feedback: 'Atomic.' },
      { id: 'c2', status: 'satisfied', feedback: 'Validated.' },
      { id: 'c3', status: 'satisfied', feedback: 'Handled.' },
    ],
  });

  const afterGrade = await service.call('review.get', { runId: run0.id });
  assert.equal(afterGrade.feedback.correct, true);
  assert.equal(afterGrade.feedback.revealedBeforeAnswer, true);
  const locatedPeek = await service.call('card.locate', { deckId: 'd-tasks', cardId: 'task-peek' });
  assert.equal(locatedPeek.card.review.repetitions, 1, 'FSRS-6 repetitions incremented on passing check');

  const rawState = await service.store.read();
  const lastAttempt = rawState.attempts.at(-1);
  assert.equal(lastAttempt.quiz_id, 'task-peek');
  assert.equal(lastAttempt.assistance?.revealedBeforeAnswer, true, 'stored attempt preserves revealedBeforeAnswer');

  // Study-progress check item classification: viewing reference solution BEFORE answering counts as 'assisted', NEVER 'independent'!
  const itemStatus = deriveItemStatus({ id: 'item-1', targetCardIds: ['task-peek'] }, rawState.attempts, [revealedRun]);
  assert.equal(itemStatus.status, 'assisted');
});

test('self-report fallback (写完了（自报）) records 自报，未验收 honestly in feedback & history, schedules FSRS-6, and shows 不看答案重写一遍 when due', async (t) => {
  const { service } = await setupLibrary(t, [makeDerivationTaskCard('task-self')]);

  // First-time new study: dueReview is false.
  const firstRun = await service.call('review.start', { deckId: 'd-tasks', mode: 'quiz' });
  assert.equal(firstRun.card.id, 'task-self');
  assert.equal(firstRun.dueReview, false, 'first-time study does not show due rewrite reminder');

  // Learner clicks 「写完了（自报）」 -> review.answer { selfReport: true }.
  const reported = await service.call('review.answer', {
    runId: firstRun.id,
    cardId: 'task-self',
    selfReport: true,
    note: 'Derived on paper in notebook p.14',
  });

  assert.equal(reported.feedback.assessment, 'self-report');
  assert.equal(reported.feedback.selfReported, true);
  assert.equal(reported.feedback.unverified, true);
  assert.equal(reported.correct, 0, 'self-report does not increment verified correct counter');
  assert.equal(reported.navigation?.[0]?.passed, false, 'self-report is not shown as verified pass dot in round rail');
  assert.ok(reported.feedback.nextDue, 'FSRS-6 nextDue scheduled');

  // NextDue word is honest in both zh and en, never "答对了" / "Right".
  uiMod.setUiLanguage('zh');
  assert.equal(uiMod.nextDueWord(reported.feedback), '自报，未验收');
  uiMod.setUiLanguage('en');
  assert.equal(uiMod.nextDueWord(reported.feedback), 'Self-reported, unverified');
  uiMod.setUiLanguage('zh');

  // Stored attempt in history is marked self-report + unverified, and never counts as 'independent' AI-verified completion.
  const stateAfterSelf = await service.store.read();
  const attempt = stateAfterSelf.attempts.at(-1);
  assert.equal(attempt.assessment, 'self-report');
  assert.equal(attempt.selfReported, true);
  assert.equal(attempt.unverified, true);
  assert.equal(deriveItemStatus({ id: 'item-deriv', targetCardIds: ['task-self'] }, stateAfterSelf.attempts, []).status, 'self_reported');

  // Close first run and bring card due in FSRS-6 to verify due-review reminder & honest history badge!
  await service.call('review.end', { runId: firstRun.id });
  await service.store.update((s) => {
    const card = s.decks.find((d) => d.id === 'd-tasks').cards.find((c) => c.id === 'task-self');
    assert.ok(card.review.repetitions >= 1, 'FSRS-6 recorded at least 1 repetition');
    card.review.due_at = new Date(Date.now() - 60_000).toISOString();
  });

  const dueRun = await service.call('review.start', { deckId: 'd-tasks', mode: 'due' });
  assert.equal(dueRun.card.id, 'task-self');
  assert.equal(dueRun.dueReview, true, 'due FSRS-6 task card flags dueReview: true');
  assert.equal(dueRun.lastRubric ?? null, null, 'self-report never masquerades as a rubric score');
  assert.equal(dueRun.lastTaskAttempt?.selfReported, true);
  assert.equal(dueRun.lastTaskAttempt?.unverified, true);
});

test('UI rendering: bilingual zh/en (zero Han leakage), hand-off dispatch, Draft editor, keyboard neutrality, and 420px/1280px Ink-desk CSS', async (t) => {
  const { service } = await setupLibrary(t, [makeTaskCard('task-ui')]);
  const freshRun = await service.call('review.start', { deckId: 'd-tasks', mode: 'quiz' });

  // Keyboard shortcuts 1-9 and Space do not accidentally grade or flip a task card.
  const choiceState = reviewChoiceKind(freshRun);
  assert.deepEqual(choiceState, { choice: false, isCloze: false, rubricCard: false });
  for (const key of ['1', '2', ' ']) {
    const act = shortcutAction(
      { key, code: key === ' ' ? 'Space' : key, shiftKey: false, repeat: false, defaultPrevented: false },
      { inside: true, page: 'review', run: freshRun, busy: false, ...choiceState, selected: [], clozeValues: {} },
    );
    assert.equal(act?.action ?? null, null, `key "${key}" should not trigger choice/flip action on task card`);
  }

  // Due-review run state in both Chinese and English: renders 「不看答案重写一遍」 / English equivalent, 「在主会话里检查」, 「看参考实现」, 「写完了（自报）」.
  const dueRunView = {
    ...freshRun,
    dueReview: true,
    lastTaskAttempt: { assessment: 'self-report', selfReported: true, unverified: true, revealedBeforeAnswer: false },
  };
  const decksData = { decks: [{ id: 'd-tasks', title: 'Hands-on Workshop' }] };

  uiMod.setUiLanguage('zh');
  const zhHtml = renderToStaticMarkup(
    React.createElement(uiMod.TaskCardRun, { run: dueRunView, data: decksData, value: 'src/stock.lua' }),
  );
  for (const expected of ['动手任务', '不看答案重写一遍', '上次记录：自报，未验收', '验收标准', '在主会话里检查', '看参考实现', '写完了（自报）']) {
    assert.ok(zhHtml.includes(expected), `zh TaskCardRun includes "${expected}"`);
  }
  assert.equal(zhHtml.includes('data-testid="task-reference-solution"'), false, 'reference solution folded before reveal');

  uiMod.setUiLanguage('en');
  const enHtml = renderToStaticMarkup(
    React.createElement(uiMod.TaskCardRun, { run: dueRunView, data: decksData, value: 'src/stock.lua' }),
  );
  for (const expected of [
    'Hands-on task',
    'Try doing it again from scratch without looking at the solution',
    'Last attempt: self-reported, unverified',
    'Acceptance criteria',
    'Check in main chat',
    'View reference solution',
    'Done (self-report)',
  ]) {
    assert.ok(enHtml.includes(expected), `en TaskCardRun includes "${expected}"`);
  }
  assert.doesNotMatch(enHtml, han, 'zero Chinese characters leak in English TaskCardRun');

  // Rendered static check feedback (with truncated >3 issues note & line badge) in English has zero Chinese leakage.
  const normalized = normalizeTaskStaticCheck({
    files: ['src/stock.lua'],
    summary: 'Fix the race condition and boundary check first.',
    checks: [
      { id: 'c1', status: 'issue', line: 14, feedback: 'Split GET and DECRBY calls.' },
      { id: 'c2', status: 'satisfied', feedback: 'Rejects qty <= 0.' },
      { id: 'c3', status: 'missing', feedback: 'No insufficient-stock return sentinel.' },
    ],
    issues: [
      { criterionId: 'c1', line: 22, detail: 'Extra non-atomic TTL update.' },
      { criterionId: 'c3', line: 30, detail: 'Nil stock crashes arithmetic.' },
      { criterionId: 'c3', line: 35, detail: 'Fourth issue triggers cap.' },
    ],
  }, makeTaskCard('task-ui'), { language: 'en' });

  const gradedRunView = {
    ...freshRun,
    revealed: true,
    assistance: { revealedBeforeAnswer: true },
    solution: { answer: makeTaskCard('task-ui').answer, explanation: makeTaskCard('task-ui').explanation },
    feedback: {
      correct: false,
      grade: 2,
      revealedBeforeAnswer: true,
      nextDue: new Date(Date.now() + 86_400_000).toISOString(),
      rubric: { total: normalized.total, max: normalized.max, criteria: normalized.questions[0].criteria, summary: normalized.summary },
      taskCheck: normalized.taskCheck,
    },
  };
  const enGradedHtml = renderToStaticMarkup(
    React.createElement(uiMod.TaskCardRun, { run: gradedRunView, data: decksData, value: 'src/stock.lua' }),
  );
  assert.ok(enGradedHtml.includes('Viewed solution'));
  assert.ok(enGradedHtml.includes('Issue (line 14)'));
  assert.ok(enGradedHtml.includes('Satisfied 1 · Missing 1 · Issues 1'));
  assert.ok(enGradedHtml.includes('Capped at 3 concrete issues'));
  assert.ok(enGradedHtml.includes('Reference solution'));
  assert.doesNotMatch(enGradedHtml, han, 'zero Chinese characters leak in English graded TaskCardRun');

  // QuestionRun routes task cards in quiz/due mode to TaskCardRun, while flashcard mode still uses FlashcardRun.
  const noop = () => {};
  const makeSession = (runObj) => ({
    run: runObj,
    entry: { selected: [], hint: false, explain: false, response: 'src/stock.lua', teaching: null, teachAnswer: '', clozeValues: {} },
    showBack: false,
    showEn: false,
    enBusyKey: null,
    keyGrade: null,
    teachingBusy: false,
    teachingError: '',
    choice: false,
    isCloze: false,
    autopilot: { active: false },
    actions: {
      reviewAct: noop,
      choose: noop,
      flipCard: noop,
      assistCard: noop,
      slayCard: noop,
      studyPrerequisites: noop,
      teachingAct: noop,
      cancelTeaching: noop,
      retryTeaching: noop,
      toggleEn: noop,
      setResponse: noop,
      setClozeValue: noop,
      setTeachAnswer: noop,
    },
  });
  const qRunHtml = renderToStaticMarkup(
    React.createElement(uiMod.QuestionRun, {
      session: makeSession(dueRunView),
      data: decksData,
    }),
  );
  assert.ok(qRunHtml.includes('data-testid="task-card-run"'));
  const flashQRunHtml = renderToStaticMarkup(
    React.createElement(uiMod.QuestionRun, {
      session: makeSession({ ...dueRunView, mode: 'flashcard' }),
      data: decksData,
    }),
  );
  assert.equal(flashQRunHtml.includes('data-testid="task-card-run"'), false, 'flashcard mode stays flip-card, not TaskCardRun');

  // Draft editor renders task-specific field labels (任务说明 / Task description, 验收标准 / Acceptance criteria, 参考实现 / Reference solution) in zh & en.
  for (const [lang, expectedLabels] of [
    ['zh', ['动手任务', '任务说明', '参考实现']],
    ['en', ['Hands-on task', 'Task description', 'Reference solution']],
  ]) {
    uiMod.setUiLanguage(lang);
    assert.ok(uiMod.kindNote(['task'], 5).length > 10);
    const planSummary = uiMod.customSummary({
      purpose: 'follow',
      scope: { kind: 'all' },
      book: { make: false, coverage: 'standard', parts: [] },
      questions: { make: true, kinds: ['task'], strength: 'standard', variants: false },
      plan: { make: false, by: 'weekly', chaptersPerWeek: 2 },
    });
    assert.ok(planSummary.includes(lang === 'en' ? 'Hands-on' : '动手'));
    const draftObj = { id: 'dr1', title: 'Workshop Draft', cards: [{ ...makeTaskCard('d-c1'), rubricCriteria: undefined }], quality: { errors: [], warnings: [] } };
    const draftHtml = renderToStaticMarkup(
      React.createElement(uiMod.Draft, {
        draft: draftObj,
        data: { root: '/tmp/lib', sources, decks: [], drafts: [draftObj], jobs: [], courses: [], settings: {} },
      }),
    );
    for (const label of expectedLabels) assert.ok(draftHtml.includes(label), `${lang} Draft includes "${label}"`);
    if (lang === 'en') assert.doesNotMatch(draftHtml, han, 'zero Chinese leakage in English Draft editor for task card');
  }
  uiMod.setUiLanguage('zh');

  // CSS craftsmanship & 420px / 1280px responsive layout contract check on ui/task-card.css.
  const cssText = await readFile(new URL('../ui/task-card.css', import.meta.url), 'utf8');
  assert.match(cssText, /@layer\s+study\.features/);
  assert.doesNotMatch(cssText, /--bg-glass|backdrop-filter|#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/, 'uses Ink-desk semantic tokens only');
  assert.match(cssText, /flex-wrap:\s*wrap/, 'actions and metadata wrap cleanly at 420px narrow width');
  assert.match(cssText, /overflow-wrap:\s*anywhere/, 'long file paths and identifiers wrap without horizontal overflow at 420px and 1280px');
  assert.match(cssText, /@media\s*\(max-width:\s*480px\)/, 'narrow-screen adaptation rule is present for 420px viewports');
});

test('re-checking an active task run after fixing issues updates checks, keeps UI re-check controls visible, normalizes blank runId, localizes en output, and increments FSRS reps once', async (t) => {
  const { root, service } = await setupLibrary(t, [makeTaskCard('task-recheck')]);
  const run = await service.call('review.start', { deckId: 'd-tasks', mode: 'quiz' });

  // 1. Initial check with blank runId: "" normalizes cleanly and binds to the active task run.
  const firstGrade = await service.call('card.grade', {
    deckId: 'd-tasks',
    cardId: 'task-recheck',
    runId: '   ',
    files: ['src/stock.lua'],
    summary: 'Two criteria still have issues.',
    checks: [
      { id: 'c1', status: 'issue', line: 12, feedback: 'GET and DECRBY are split across two calls.' },
      { id: 'c2', status: 'satisfied', feedback: 'Validates positive integer.' },
      { id: 'c3', status: 'missing', feedback: 'Missing insufficient-stock sentinel.' },
    ],
  });
  assert.equal(firstGrade.runId, run.id, 'blank runId normalizes and resolves the active task run');
  assert.equal(firstGrade.taskCheck.counts.satisfied, 1);
  assert.equal(firstGrade.taskCheck.counts.issue, 1);
  assert.equal(firstGrade.taskCheck.counts.missing, 1);

  const afterFirstRun = await service.call('review.get', { runId: run.id });
  assert.equal(afterFirstRun.revealed, false, 'incomplete static check keeps reference solution unrevealed');

  // UI keeps re-check button & optional file input visible after static-check feedback in both zh and en.
  const decksData = { decks: [{ id: 'd-tasks', title: 'Hands-on Workshop' }] };
  uiMod.setUiLanguage('zh');
  const zhFeedbackHtml = renderToStaticMarkup(
    React.createElement(uiMod.TaskCardRun, { run: afterFirstRun, data: decksData, value: '' }),
  );
  assert.ok(zhFeedbackHtml.includes('data-testid="task-check-main-chat"'), 're-check button remains visible after static check');
  assert.ok(zhFeedbackHtml.includes('重新在主会话里检查'), 'zh shows re-check label');
  assert.ok(zhFeedbackHtml.includes('data-testid="task-file-input"'), 'file path input remains visible for revision');
  assert.ok(zhFeedbackHtml.includes('看参考实现'), 'View reference solution button stays available while unrevealed');

  uiMod.setUiLanguage('en');
  const enFeedbackHtml = renderToStaticMarkup(
    React.createElement(uiMod.TaskCardRun, { run: afterFirstRun, data: decksData, value: '' }),
  );
  assert.ok(enFeedbackHtml.includes('Re-check in main chat'));
  assert.doesNotMatch(enFeedbackHtml, han, 'zero Chinese characters in English re-check TaskCardRun');
  uiMod.setUiLanguage('zh');

  // Exact duplicate check on the same runId is idempotent (no duplicate attempt or extra reps).
  const attemptsAfterFirst = (await service.store.read()).attempts.length;
  await service.call('card.grade', {
    deckId: 'd-tasks',
    cardId: 'task-recheck',
    runId: run.id,
    files: ['src/stock.lua'],
    summary: 'Two criteria still have issues.',
    checks: [
      { id: 'c1', status: 'issue', line: 12, feedback: 'GET and DECRBY are split across two calls.' },
      { id: 'c2', status: 'satisfied', feedback: 'Validates positive integer.' },
      { id: 'c3', status: 'missing', feedback: 'Missing insufficient-stock sentinel.' },
    ],
  });
  assert.equal((await service.store.read()).attempts.length, attemptsAfterFirst, 'identical static check is idempotent');

  // 2. Learner fixes c1 in the SAME file (src/stock.lua -> same fallback answer string!) and re-checks on the same runId.
  const secondGrade = await service.call('card.grade', {
    deckId: 'd-tasks',
    cardId: 'task-recheck',
    runId: run.id,
    files: ['src/stock.lua'],
    summary: 'Atomic EVAL fixed; sentinel still missing.',
    checks: [
      { id: 'c1', status: 'satisfied', feedback: 'Now atomic inside one EVAL script.' },
      { id: 'c2', status: 'satisfied', feedback: 'Validates positive integer.' },
      { id: 'c3', status: 'missing', feedback: 'Still missing -1 sentinel.' },
    ],
  });
  assert.equal(secondGrade.taskCheck.counts.satisfied, 2, 'updated checks on same file are applied, never silently dropped');
  assert.equal(secondGrade.taskCheck.counts.missing, 1);
  const afterSecondRun = await service.call('review.get', { runId: run.id });
  assert.equal(afterSecondRun.correct, 0, 'partial 4/6 static check with missing criterion does not increment correct');
  assert.equal(afterSecondRun.navigation?.[0]?.passed, false, 'partial 4/6 static check shows as not-yet-passed in rail');

  const stateAfterSecond = await service.store.read();
  const cardAfterSecond = stateAfterSecond.decks.find((d) => d.id === 'd-tasks').cards.find((c) => c.id === 'task-recheck');
  assert.equal(cardAfterSecond.review.reps, 1, 're-check on same runId recomputes from reviewBefore (reps stays 1)');
  const practiceProgress = { index: 1, total: 3, own: false, stage: { name: '课后：出题，按批练习', activity: 'practice', level: 'medium' } };
  assert.equal(stageGate(stateAfterSecond, 'CS4224', practiceProgress).passed, 0, 'task static check with >50% partial marks (4/6) but a missing criterion does NOT pass medium stageGate');
  assert.equal(deriveItemStatus({ id: 'i-re', targetCardIds: ['task-recheck'] }, stateAfterSecond.attempts).status, 'pending');

  // 3. Learner refactors across CHANGED files and re-checks under English service language.
  const enService = new StudyService(root, { language: 'en' });
  t.after(() => enService.dispose());
  const thirdGrade = await enService.call('card.grade', {
    deckId: 'd-tasks',
    cardId: 'task-recheck',
    runId: run.id,
    files: ['src/stock.lua', 'src/sentinel.lua'],
    summary: 'All acceptance criteria satisfied.',
    checks: [
      { id: 'c1', status: 'satisfied', feedback: 'Atomic Lua script.' },
      { id: 'c2', status: 'satisfied', feedback: 'Rejects non-positive quantities.' },
      { id: 'c3', status: 'satisfied', feedback: 'Returns -1 when stock < qty.' },
    ],
  });
  assert.equal(thirdGrade.total, 6);
  assert.equal(thirdGrade.message, 'Static check complete: 6/6 marks');
  assert.doesNotMatch(thirdGrade.message, han, 'English card.grade message has zero Chinese leakage');
  assert.deepEqual(thirdGrade.taskCheck.files, ['src/stock.lua', 'src/sentinel.lua']);

  const afterThirdRun = await enService.call('review.get', { runId: run.id });
  assert.equal(afterThirdRun.revealed, true, 'all-satisfied static check reveals reference solution for comparison');
  assert.equal(afterThirdRun.feedback.taskCheck.counts.satisfied, 3);
  assert.equal(afterThirdRun.correct, 1);
  assert.equal(afterThirdRun.navigation?.[0]?.passed, true);

  const finalState = await enService.store.read();
  const finalCard = finalState.decks.find((d) => d.id === 'd-tasks').cards.find((c) => c.id === 'task-recheck');
  assert.equal(finalCard.review.reps, 1, 'FSRS reps incremented only once across initial check + two re-checks on same run');
  assert.equal(finalCard.review.repetitions, 1);
  assert.equal(stageGate(finalState, 'CS4224', practiceProgress).passed, 1, 'task static check with ALL criteria satisfied passes medium stageGate');
  assert.equal(deriveItemStatus({ id: 'i-re', targetCardIds: ['task-recheck'] }, finalState.attempts).status, 'passed');
  assert.equal(finalState.attempts.at(-1).learnerAnswer, '[Static check files] src/stock.lua, src/sentinel.lua');
  assert.doesNotMatch(finalState.attempts.at(-1).learnerAnswer, han);

  // Contract documents rubricCriteria & marks on card.update.
  assert.match(libraryContracts.cards, /card\.update[\s\S]*rubricCriteria\/marks/);
});

test('unverified self-report NEVER counts as verified pass in creditPrerequisites, course-method gates, study.scene.get, or custom-readiness', async (t) => {
  const prereqCard = {
    id: 'pre-lua',
    kind: 'flashcard',
    topic: 'Redis EVAL basics',
    objective: 'State atomicity guarantee of Redis EVAL',
    prompt: 'Why is a single Redis Lua script atomic with respect to other commands?',
    answer: 'Redis executes the entire Lua script sequentially without interleaving other client commands.',
    hint: 'Think about single-threaded command execution.',
    explanation: `"${REDIS_QUOTE}" Redis runs the script atomically.`,
    misconception: 'Assuming Lua scripts run in parallel threads.',
    citations: [{ sourceId: 's-code', quote: REDIS_QUOTE }],
  };
  const { service } = await setupLibrary(t, [makeTaskCard('task-self-gate'), prereqCard]);
  await service.call('card.link', {
    deckId: 'd-tasks',
    cardId: 'task-self-gate',
    requires: { deckId: 'd-tasks', cardId: 'pre-lua' },
  });

  // Start guided study session to inspect study.scene.get after self-report.
  const session = await service.call('study.session.start', {
    courseId: 'CS4224',
    scope: [{ kind: 'deck', id: 'd-tasks' }],
  });

  const run = await service.call('review.start', {
    deckId: 'd-tasks',
    mode: 'new',
    ordered: true,
  });
  const selfRes = await service.call('review.answer', {
    runId: run.id,
    cardId: 'task-self-gate',
    selfReport: true,
    note: 'sketched locally without checking',
  });

  // 1. creditPrerequisites is NEVER called for selfReport, and feedback.correct is false.
  assert.equal(selfRes.feedback.correct, false);
  assert.equal(selfRes.feedback.credited, 0);
  const stateAfterSelf = await service.store.read();
  const preLive = stateAfterSelf.decks.find((d) => d.id === 'd-tasks').cards.find((c) => c.id === 'pre-lua');
  assert.equal(preLive.review.repetitions, 0, 'prerequisite card schedule was NOT implicitly credited by self-report');
  assert.equal(preLive.review.due_at, null);
  assert.equal(stateAfterSelf.attempts.some((a) => a.quiz_id === 'pre-lua'), false, 'zero implicit attempts pushed');

  // 2. course-method progress & stageGate exclude self-report under BOTH medium (right) and loose (answered) stage gates.
  await service.call('course.method.save', {
    name: 'CS4224',
    method: {
      version: 1,
      name: 'Workshop Method',
      stages: [
        { name: '动手闯关', activity: 'practice', level: 'medium' },
        { name: '间隔复习', activity: 'review', level: 'medium' },
      ],
    },
  });
  let stateForGate = await service.store.read();
  let progMedium = methodProgress(stateForGate, 'CS4224');
  let gateMedium = stageGate(stateForGate, 'CS4224', progMedium);
  assert.equal(progMedium.counts.right, 0, 'self-report does not count as right in methodProgress');
  assert.equal(progMedium.counts.answered, 0, 'self-report does not count as verified answered in methodProgress');
  assert.equal(gateMedium.passed, 0, 'medium stageGate passed stays 0');
  assert.equal(gateMedium.checkPassed, false);

  await service.call('course.method.save', {
    name: 'CS4224',
    method: {
      version: 1,
      name: 'Loose Workshop Method',
      stages: [
        { name: '初练', activity: 'practice', level: 'loose' },
        { name: '复习', activity: 'review', level: 'medium' },
      ],
    },
  });
  stateForGate = await service.store.read();
  const progLoose = methodProgress(stateForGate, 'CS4224');
  const gateLoose = stageGate(stateForGate, 'CS4224', progLoose);
  assert.equal(gateLoose.counts, 'answered');
  assert.equal(gateLoose.passed, 0, 'loose stageGate also excludes unverified self-report');
  assert.equal(progLoose.index, 0, 'stage does not advance on unverified self-reports');

  // 3. study.scene.get marks recentAttempts with correct: false, selfReported: true, unverified: true, assessment: 'self-report'.
  const scene = await service.call('study.scene.get', { sessionId: session.id });
  const latestSceneAttempt = scene.recentAttempts.find((a) => a.assessment === 'self-report') || scene.recentAttempts.at(-1);
  assert.ok(latestSceneAttempt);
  assert.equal(latestSceneAttempt.correct, false, 'study.scene.get never reports an unverified self-report as correct');
  assert.equal(latestSceneAttempt.selfReported, true);
  assert.equal(latestSceneAttempt.unverified, true);
  assert.equal(latestSceneAttempt.assessment, 'self-report');

  // 4. custom-readiness never counts unverified self-reports toward solid or practised, even across multiple days / high interval.
  const { study: rStudy, ids: rIds } = await readinessService(t);
  await rStudy.store.update((own) => {
    own.attempts = own.attempts.filter((a) => !rIds.who.includes(a.quiz_id));
    own.attempts.push(
      { id: 'sr-w1-d2', quiz_id: rIds.who[0], deckId: 'deck-l1', timestamp: daysAgo(2), grade: 3, correct: false, assessment: 'self-report', selfReported: true, unverified: true },
      { id: 'sr-w1-d0', quiz_id: rIds.who[0], deckId: 'deck-l1', timestamp: daysAgo(0), grade: 3, correct: false, assessment: 'self-report', selfReported: true, unverified: true },
      { id: 'sr-w2-d3', quiz_id: rIds.who[1], deckId: 'deck-l1', timestamp: daysAgo(3), grade: 3, correct: false, assessment: 'self-report', selfReported: true, unverified: true },
      { id: 'sr-w2-d1', quiz_id: rIds.who[1], deckId: 'deck-l1', timestamp: daysAgo(1), grade: 3, correct: false, assessment: 'self-report', selfReported: true, unverified: true },
    );
  });
  const readinessAfterSelf = await rStudy.call('course.custom.readiness');
  const c1Self = readinessAfterSelf.chapters.find((ch) => ch.id === 'c1');
  assert.equal(c1Self.solid, 0, 'point with only unverified self-reports is NOT solid in custom-readiness');
  assert.equal(c1Self.practised, 1, 'only the other verified point (what) is practised; self-reported point (who) is not');
});

test('upgrading a self-report via card.grade on the same runId schedules FSRS-6 once and preserves revealedBeforeAnswer if solution was viewed', async (t) => {
  const prereqA = {
    id: 'pre-a',
    kind: 'flashcard',
    topic: 'Atomicity A',
    objective: 'Atomicity prerequisite A',
    prompt: 'Prerequisite A?',
    answer: 'Answer A.',
    hint: 'Hint A.',
    explanation: `"${REDIS_QUOTE}" Explanation A.`,
    misconception: 'Misconception A.',
    citations: [{ sourceId: 's-code', quote: REDIS_QUOTE }],
  };
  const prereqB = {
    ...prereqA,
    id: 'pre-b',
    topic: 'Atomicity B',
    objective: 'Atomicity prerequisite B',
    prompt: 'Prerequisite B?',
  };
  const { service } = await setupLibrary(t, [
    makeTaskCard('task-up-clean', { prompt: 'Implement atomic Redis + Lua stock deduction (clean path) without overselling.' }),
    makeTaskCard('task-up-peek', { prompt: 'Implement atomic Redis + Lua stock deduction (peek path) without overselling.' }),
    prereqA,
    prereqB,
  ]);
  await service.call('card.link', { deckId: 'd-tasks', cardId: 'task-up-clean', requires: { deckId: 'd-tasks', cardId: 'pre-a' } });
  await service.call('card.link', { deckId: 'd-tasks', cardId: 'task-up-peek', requires: { deckId: 'd-tasks', cardId: 'pre-b' } });

  // Path A: Self-report (without viewing reference solution) -> card.grade pass on same runId.
  const runA = await service.call('review.start', { deckId: 'd-tasks', mode: 'new', ordered: true });
  const selfA = await service.call('review.answer', { runId: runA.id, cardId: 'task-up-clean', selfReport: true });
  assert.equal(selfA.revealed, false, 'self-report does NOT auto-reveal reference solution');
  assert.equal(selfA.solution, undefined, 'solution stays hidden after self-report');

  const gradeA = await service.call('card.grade', {
    deckId: 'd-tasks',
    cardId: 'task-up-clean',
    runId: runA.id,
    files: ['src/stock.lua'],
    checks: [
      { id: 'c1', status: 'satisfied', feedback: 'Atomic.' },
      { id: 'c2', status: 'satisfied', feedback: 'Validated.' },
      { id: 'c3', status: 'satisfied', feedback: 'Sentinel returned.' },
    ],
  });
  assert.equal(gradeA.credited, 1, 'verified unassisted upgrade credits prerequisite once');
  const stateA = await service.store.read();
  const cardA = stateA.decks.find((d) => d.id === 'd-tasks').cards.find((c) => c.id === 'task-up-clean');
  assert.equal(cardA.review.reps, 1, 'FSRS-6 scheduled from reviewBefore (reps === 1, never 2)');
  assert.equal(cardA.review.repetitions, 1);
  const attA = stateA.attempts.filter((a) => a.quiz_id === 'task-up-clean').at(-1);
  assert.equal(attA.assistance.used, false);
  assert.equal(attA.assistance.revealedBeforeAnswer, false);
  assert.equal(deriveItemStatus({ id: 'i-a', targetCardIds: ['task-up-clean'] }, stateA.attempts.filter((a) => a.quiz_id === 'task-up-clean')).status, 'passed');

  // Path B: Self-report -> learner clicks 看参考实现 (review.reveal) -> card.grade pass on same runId.
  const idxB = (await service.store.read()).runs.find((r) => r.id === runA.id).entries.findIndex((e) => e.card.id === 'task-up-peek');
  const runB = await service.call('review.move', { runId: runA.id, index: idxB });
  await service.call('review.answer', { runId: runB.id, cardId: 'task-up-peek', selfReport: true });
  const revealedB = await service.call('review.reveal', { runId: runB.id, cardId: 'task-up-peek' });
  assert.equal(revealedB.revealed, true);
  assert.equal(revealedB.assistance?.revealedBeforeAnswer, true, 'revealing after self-report records revealedBeforeAnswer');

  const gradeB = await service.call('card.grade', {
    deckId: 'd-tasks',
    cardId: 'task-up-peek',
    runId: runB.id,
    files: ['src/stock.lua'],
    checks: [
      { id: 'c1', status: 'satisfied', feedback: 'Atomic.' },
      { id: 'c2', status: 'satisfied', feedback: 'Validated.' },
      { id: 'c3', status: 'satisfied', feedback: 'Sentinel returned.' },
    ],
  });
  assert.equal(gradeB.credited ?? 0, 0, 'assisted upgrade (viewed reference solution) does NOT credit prerequisites');
  const stateB = await service.store.read();
  const cardB = stateB.decks.find((d) => d.id === 'd-tasks').cards.find((c) => c.id === 'task-up-peek');
  assert.equal(cardB.review.reps, 1, 'FSRS-6 reps still 1 after self-report + reveal + card.grade');
  const attB = stateB.attempts.filter((a) => a.quiz_id === 'task-up-peek').at(-1);
  assert.equal(attB.assistance.used, true);
  assert.equal(attB.assistance.revealedBeforeAnswer, true, 'revealedBeforeAnswer preserved in commitRubricGrade');
  assert.equal(deriveItemStatus({ id: 'i-b', targetCardIds: ['task-up-peek'] }, stateB.attempts.filter((a) => a.quiz_id === 'task-up-peek')).status, 'assisted');
});

test('publicCard, task.check prompt, and CriteriaEditor (variant="task") never leak keyPoints after renderRubric edits', () => {
  const base = makeTaskCard('task-noleak');
  const zhRenderedCard = { ...base, rubric: renderRubric(base.rubricCriteria, 'zh') };
  const enRenderedCard = { ...base, rubric: renderRubric(base.rubricCriteria, 'en') };
  assert.ok(zhRenderedCard.rubric.includes('要点：Single EVAL script'), 'sanity: renderRubric zh embeds 要点');
  assert.ok(enRenderedCard.rubric.includes('Key points: Single EVAL script'), 'sanity: renderRubric en embeds Key points');

  for (const candidate of [
    zhRenderedCard,
    enRenderedCard,
    { ...zhRenderedCard, rubricCriteria: undefined },
    { ...enRenderedCard, rubricCriteria: undefined },
  ]) {
    const pub = publicCard(candidate);
    assert.ok(pub.rubric.includes('Atomic check-and-decrement'), 'criterion label preserved');
    assert.equal(pub.rubric.includes('Single EVAL script'), false, 'keyPoint never leaks in publicCard.rubric');
    assert.equal(pub.rubric.includes('tonumber check'), false, 'second keyPoint never leaks in publicCard.rubric');
    assert.equal(pub.rubric.includes('要点：'), false);
    assert.equal(pub.rubric.includes('Key points:'), false);
    if (pub.rubricCriteria) {
      assert.equal(pub.rubricCriteria.some((c) => 'keyPoints' in c), false);
    }
  }

  // Hand-off prompt in zh and en never leaks keyPoints whether rubricCriteria is present or rubric-only fallback is used.
  for (const lang of ['zh', 'en']) {
    uiMod.setUiLanguage(lang);
    for (const criteriaArg of [base.rubricCriteria, []]) {
      const promptText = uiMod.handOffText('task.check', {
        deckId: 'd-tasks',
        cardId: 'task-noleak',
        runId: 'run-1',
        deckTitle: 'Hands-on Workshop',
        topic: base.topic,
        prompt: base.prompt,
        rubric: renderRubric(base.rubricCriteria, lang),
        rubricCriteria: criteriaArg,
        filePath: 'src/stock.lua',
      });
      assert.ok(promptText.includes('Atomic check-and-decrement'));
      assert.equal(promptText.includes('Single EVAL script'), false, `${lang} task.check prompt never leaks keyPoints`);
      assert.equal(promptText.includes('tonumber check'), false);
      assert.equal(promptText.includes('要点：'), false);
      assert.equal(promptText.includes('Key points:'), false);
    }
  }

  // Draft editor with rubricCriteria renders CriteriaEditor(variant="task") using 验收标准 terminology in zh & en, and edited criteria strip keyPoints in publicCard.
  uiMod.setUiLanguage('zh');
  const draftWithCriteria = { id: 'dr-crit', title: 'Task Criteria Draft', cards: [zhRenderedCard], quality: { errors: [], warnings: [] } };
  const zhDraftCriteriaHtml = renderToStaticMarkup(
    React.createElement(uiMod.Draft, {
      draft: draftWithCriteria,
      data: { root: '/tmp/lib', sources, decks: [], drafts: [draftWithCriteria], jobs: [], courses: [], settings: {} },
    }),
  );
  for (const term of ['验收标准 · 共 6 分', '验收项', '验收要求', '添加验收项']) {
    assert.ok(zhDraftCriteriaHtml.includes(term), `zh Draft CriteriaEditor uses "${term}"`);
  }
  assert.equal(zhDraftCriteriaHtml.includes('评分标准 · 共'), false, 'task card Draft does not show exam-marking legend');

  uiMod.setUiLanguage('en');
  const enDraftCriteriaHtml = renderToStaticMarkup(
    React.createElement(uiMod.Draft, {
      draft: draftWithCriteria,
      data: { root: '/tmp/lib', sources, decks: [], drafts: [draftWithCriteria], jobs: [], courses: [], settings: {} },
    }),
  );
  for (const term of ['Acceptance criteria · 6 marks', 'Criterion', 'Requirement', 'Add criterion']) {
    assert.ok(enDraftCriteriaHtml.includes(term), `en Draft CriteriaEditor uses "${term}"`);
  }
  assert.doesNotMatch(enDraftCriteriaHtml, han, 'zero Chinese characters in English Draft CriteriaEditor for task card');
  uiMod.setUiLanguage('zh');

  // Simulate CriteriaEditor edit adding a brand-new secret keyPoint -> renderRubric -> publicCard & publicTaskRubric strip it.
  const editedCriteria = zhRenderedCard.rubricCriteria.map((c, idx) => (
    idx === 0 ? { ...c, keyPoints: [...c.keyPoints, 'HIDDEN_REDIS_SECRET_TOKEN'] } : c
  ));
  const editedCard = {
    ...zhRenderedCard,
    rubricCriteria: editedCriteria,
    rubric: renderRubric(editedCriteria, 'zh'),
  };
  assert.ok(editedCard.rubric.includes('HIDDEN_REDIS_SECRET_TOKEN'));
  const editedPub = publicCard(editedCard);
  assert.equal(editedPub.rubric.includes('HIDDEN_REDIS_SECRET_TOKEN'), false, 'edited keyPoint stripped from publicCard');
  assert.equal(publicTaskRubric(editedCard).includes('HIDDEN_REDIS_SECRET_TOKEN'), false);
});
