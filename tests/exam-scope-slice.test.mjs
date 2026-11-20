/* StudyHub 5.0.0 Batch 1 · Part B (Evolution 2 Item #4): True Exam-Scope Slicing (`custom.scope.kind === 'exam'`).
   Verifies:
   1. Pure 0-token `sliceExamScope` (exported via `lib/contexts/generation/contracts.js`) matches `focusTopics`, `scope.note`,
      and `guidanceSourceIds` against material TOC / `courseInventory` / `courseOutline` using deterministic term + heading + alias
      matching, and honestly surfaces every unmatched topic in `unmatchedTopics`.
   2. `pick-pages.js` (`scopePages`, `readsRange`), `book/plan.js`, `course.custom.preview`, `course.custom.apply`, and
      `course.custom.fill` strictly slice book & question generation to confirmed `scope.resolvedChapters`, while gating
      generation until confirmation.
   3. Confirmation UI (`ui/CustomPlanCard.jsx` & `ui/custom-plan-model.js`) shows matched chapters and unmatched topics on the
      same screen, gates readiness/fill until confirmed, keeps bilingual en/zh-CN parity with zero Chinese in English paths,
      and adds 0 controls for non-exam scopes. No real model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { checkedCustom, customDefaults } from '../lib/custom-plan.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { courseRanges } from '../lib/contexts/generation/inventory/ranges.js';
import { planBook } from '../lib/contexts/generation/book/plan.js';
import { readsRange, scopePages, sliceExamScope } from '../lib/contexts/generation/contracts.js';
import { inventoryMaterial } from '../lib/course-book-inventory.js';
import { fillPlan } from '../lib/custom-fill.js';
import { COURSE as BOOK_COURSE, service as bookService } from './helpers/crunch-library.mjs';
import { held, questionJobs } from './helpers/custom-apply-world.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

const CHAPTERS_10 = [
  { title: 'Chapter 1: Course Overview', body: 'Introduction to computer systems, syllabus logistics, and grading criteria.' },
  { title: 'Chapter 2: Processes and Threads', body: 'Process states, context switch, PCB layout, and user-level vs kernel threads.' },
  { title: 'Chapter 3: CPU Scheduling', body: 'Round-robin, shortest job first, multilevel feedback queue, and response time.' },
  { title: 'Chapter 4: Synchronization', body: 'Mutex locks, semaphores, condition variables, and critical section problem.' },
  { title: 'Chapter 5: Deadlocks', body: 'Mutual exclusion, hold and wait, circular wait, and Banker algorithm for deadlock avoidance.' },
  { title: 'Chapter 6: Main Memory', body: 'Contiguous allocation, paging hardware, TLB hit ratio, and segmentation.' },
  { title: 'Chapter 7: Virtual Memory', body: 'Demand paging, page replacement policies including LRU and Clock, and thrashing.' },
  { title: 'Chapter 8: File Systems', body: 'Inodes, directory structure, journaling, and block allocation strategies.' },
  { title: 'Chapter 9: I/O Systems', body: 'Polling, interrupts, DMA controllers, and disk scheduling algorithms.' },
  { title: 'Chapter 10: Protection and Security', body: 'Access control lists, capability lists, and authentication mechanisms.' },
];

/** Create a 10-chapter textbook (40 pages, 4 pages/chapter) for course `OS`. */
async function openTenChapterBook(t, { complete = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'study-exam-scope-'));
  let study;
  t.after(async () => {
    await study?.dispose?.().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  study = new StudyService(root, complete ? { complete, light: complete, ...switchOptions('runtime', { complete, paths: [] }) } : {});
  await study.call('snapshot');
  const sources = [];
  for (let ch = 0; ch < CHAPTERS_10.length; ch++) {
    const info = CHAPTERS_10[ch];
    for (let p = 0; p < 4; p++) {
      const page = ch * 4 + p + 1;
      sources.push({
        id: `os-p${page}`,
        title: `OS Textbook · p. ${page}`,
        text: `# ${info.title}\n\n${info.body}\n\n${`Detailed discussion of ${info.title}. `.repeat(90)}`,
        createdAt: '2026-10-01T08:00:00.000Z',
        courses: ['OS'],
        document: {
          materialId: 'document-os10',
          page,
          totalPages: 40,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'OS Textbook.pdf',
          chapter: { index: ch, title: info.title, level: 1 },
          extractionVersion: 2,
        },
      });
    }
  }
  await study.store.update(own => {
    own.sources.push(...sources);
    own.focus = { mode: 'class', course: 'OS', role: '', jd: '', targetTopics: [] };
  });
  return study;
}

const examPlan = (over = {}) => checkedCustom({
  ...customDefaults('review'),
  scope: { kind: 'exam', ...(over.scope || {}) },
  book: { make: true, coverage: 'standard', parts: ['explain', 'terms'], ...(over.book || {}) },
  questions: { make: true, kinds: ['quiz'], strength: 'lean', variants: false, ...(over.questions || {}) },
  plan: { make: false, by: 'exam', ...(over.plan || {}) },
  sampleFirst: over.sampleFirst ?? false,
});

/* ---------- 1. Pure 0-token slicer tests ---------- */

test('sliceExamScope matches 3 of 10 chapters via headings, bilingual aliases, and chapter refs, and honestly surfaces unmatched topics', async t => {
  const study = await openTenChapterBook(t);
  await study.call('course.save', {
    name: 'OS',
    focusTopics: ['CPU Scheduling', '死锁（Deadlocks）', 'Quantum Entanglement', '区块链共识'],
  });
  const state = await study.store.read();
  const res = sliceExamScope(state, 'OS', {
    scope: { kind: 'exam', note: '期末范围：第 7 章，重点考 Page Replacement' },
    language: 'zh',
  });

  assert.equal(res.basis, 'documents');
  assert.equal(res.totalChapters, 10);
  assert.deepEqual(
    res.matchedChapters.map(ch => ch.id),
    ['pdf:document-os10#2', 'pdf:document-os10#4', 'pdf:document-os10#6'],
    'strictly matches Chapters 3, 5, and 7 in reading order',
  );
  assert.deepEqual(res.unmatchedTopics, ['Quantum Entanglement', '区块链共识'], 'never silently drops unmatched exam topics');
  assert.match(res.coverageNote, /3 \/ 10/);
  assert.match(res.coverageNote, /2/);

  const enRes = sliceExamScope(state, 'OS', {
    scope: { kind: 'exam', note: 'Midterm covers Chapter 7 and Page Replacement' },
    language: 'en',
  });
  assert.doesNotMatch(enRes.coverageNote, /[\u3400-\u9fff]/, 'English coverageNote has zero Chinese');
  assert.match(enRes.coverageNote, /Matched 3 of 10 chapters/);
});

test('sliceExamScope reads guidanceSourceIds bullet topics and courseInventory items, and respects ASCII word boundaries', async t => {
  const study = await openTenChapterBook(t);
  await study.store.update(own => {
    own.sources.push({
      id: 'guidance-syllabus',
      title: 'Final Exam Syllabus',
      text: '# Final Exam Scope\n- TLB hit ratio\n- Inodes\n- Missing Exotic Topic\n- IP',
      courses: ['OS'],
      createdAt: '2026-10-05T08:00:00.000Z',
    });
    // Add an inventory item whose alias lives in Chapter 9 (pages 33..36) even though heading is "I/O Systems".
    own.sources.push(inventoryMaterial({
      title: 'Inventory · OS',
      course: 'OS',
      language: 'en',
      ranges: [{ key: 'r9', doc: 'pdf:document-os10', print: '0123456789abcdef', status: 'read', chars: 1000, from: 33, to: 36 }],
      items: [{
        kind: 'concept',
        name: 'Direct Memory Access (直接内存访问)',
        gist: 'Hardware transfer bypassing CPU',
        places: [{ range: 'r9', doc: 'pdf:document-os10', sourceId: 'os-p33', start: 0, end: 20, page: 33, quote: 'DMA controllers', verified: true }],
      }],
      documents: [{ key: 'pdf:document-os10', title: 'OS Textbook', pages: 40, ranges: 1, read: 1, pagesRead: 4 }],
      cache: { clusters: [], order: null },
    }));
  });
  await study.call('course.save', {
    name: 'OS',
    focusTopics: ['直接内存访问'],
    guidanceSourceIds: ['guidance-syllabus'],
  });
  const state = await study.store.read();
  const res = sliceExamScope(state, 'OS', { language: 'en' });
  const ids = res.matchedChapters.map(ch => ch.id);
  // Ch 6 (TLB hit ratio), Ch 8 (Inodes), Ch 9 (Direct Memory Access via inventory bilingual alias)
  assert.deepEqual(ids, ['pdf:document-os10#5', 'pdf:document-os10#7', 'pdf:document-os10#8']);
  // "IP" must NOT false-match words like "clip" or "relationship" (none of the chapters contain standalone "IP").
  assert.ok(res.unmatchedTopics.includes('IP'), 'short ASCII token respects word boundaries');
  assert.ok(res.unmatchedTopics.includes('Missing Exotic Topic'));
});

test('sliceExamScope works on outline basis (returns top-level outline node ids)', async t => {
  const { study } = await bookService(t);
  await study.call('course.save', { name: BOOK_COURSE, focusTopics: ['Introduction', 'Unrelated Topic Z'] });
  const state = await study.store.read();
  const res = sliceExamScope(state, BOOK_COURSE, { language: 'en' });
  assert.equal(res.basis, 'outline');
  assert.deepEqual(res.matchedChapters.map(ch => ch.id), ['c1']);
  assert.deepEqual(res.unmatchedTopics, ['Unrelated Topic Z']);
});

/* ---------- 2. Schema & backward compatibility ---------- */

test('checkedCustom keeps optional scope.resolvedChapters for exam scope while remaining backward compatible with store v5', async t => {
  const legacy = checkedCustom({ ...customDefaults('review'), scope: { kind: 'exam', note: '期末范围' } });
  assert.deepEqual(legacy.scope, { kind: 'exam', note: '期末范围' }, 'legacy exam scope without resolvedChapters stays valid');

  const confirmed = checkedCustom({
    ...customDefaults('review'),
    scope: { kind: 'exam', note: '期末范围', resolvedChapters: ['doc#2', 'doc#4', 'doc#2'] },
  });
  assert.deepEqual(confirmed.scope, { kind: 'exam', resolvedChapters: ['doc#2', 'doc#4'], note: '期末范围' });

  assert.throws(
    () => checkedCustom({ ...customDefaults('review'), scope: { kind: 'exam', resolvedChapters: [] } }),
    /考试范围章节需选 1 到/,
  );

  // course.save pins scope.titles for confirmed exam scope chapters.
  const study = await openTenChapterBook(t);
  const saved = await study.call('course.save', {
    name: 'OS',
    custom: examPlan({ scope: { resolvedChapters: ['pdf:document-os10#2', 'pdf:document-os10#4'] } }),
  });
  assert.deepEqual(saved.custom.scope.titles, ['Chapter 3: CPU Scheduling', 'Chapter 5: Deadlocks']);
});

/* ---------- 3. §3.2.5 Integration: pick-pages.js, preview, gating, and confirmed apply ---------- */

test('§3.2.5 integration: 3 of 10 chapters matched => pick-pages.js & course.custom.preview strictly cover those 3 chapters, unmatched topics surfaced, generation gated until confirmation', async t => {
  const study = await openTenChapterBook(t, { complete: held });
  await study.call('course.save', {
    name: 'OS',
    focusTopics: ['CPU Scheduling', 'Banker algorithm', 'Virtual Memory', 'Nonexistent Topic A', 'Nonexistent Topic B'],
  });

  // Step A: Preview BEFORE confirmation (unconfirmed exam scope)
  const wholePreview = await study.call('course.custom.preview', {
    course: 'OS',
    custom: examPlan({ scope: { kind: 'all' } }),
  });
  const examPreview = await study.call('course.custom.preview', {
    course: 'OS',
    custom: examPlan({ scope: { kind: 'exam', note: 'Midterm' } }),
    language: 'en',
  });
  const matchedIds = examPreview.examScope.matchedChapters.map(ch => ch.id);
  assert.deepEqual(matchedIds, ['pdf:document-os10#2', 'pdf:document-os10#4', 'pdf:document-os10#6'], 'matched 3 of 10 chapters');
  assert.deepEqual(examPreview.examScope.unmatchedTopics, ['Nonexistent Topic A', 'Nonexistent Topic B']);
  assert.equal(examPreview.examScope.confirmed, false);
  assert.equal(examPreview.examScope.resolvedChapters, null);

  // Preview estimate must strictly match an explicit 3-chapter pick and be strictly smaller than the 10-chapter book.
  const explicit3Preview = await study.call('course.custom.preview', {
    course: 'OS',
    custom: examPlan({ scope: { kind: 'chapters', chapters: matchedIds } }),
  });
  assert.deepEqual(examPreview.estimate, explicit3Preview.estimate, 'exam preview estimate strictly covers the 3 matched chapters');
  assert.ok(examPreview.estimate.book.inventory < wholePreview.estimate.book.inventory, 'inventory calls strictly reduced');
  assert.ok(examPreview.estimate.book.calls < wholePreview.estimate.book.calls, 'book calls strictly reduced');
  assert.ok(examPreview.estimate.questions.count < wholePreview.estimate.questions.count, 'question count strictly reduced');
  assert.ok(examPreview.estimate.total.calls < wholePreview.estimate.total.calls, 'total calls strictly reduced');

  // Step B: Save UNCONFIRMED exam scope => generation MUST be gated in apply AND fill!
  await study.call('course.save', {
    name: 'OS',
    custom: examPlan({ scope: { kind: 'exam', note: 'Midterm' } }),
  });
  const gatedApply = await study.call('course.custom.apply', { course: 'OS', language: 'en' });
  assert.equal(gatedApply.status, 'ok');
  assert.deepEqual(gatedApply.started, [], 'unconfirmed exam scope starts ZERO jobs');
  assert.equal(gatedApply.recorded.filter(item => item.step === 'scope').length, 0, 'no longer silently recorded-only');
  assert.equal(gatedApply.waiting.length, 1);
  assert.equal(gatedApply.waiting[0].step, 'scope');
  assert.match(gatedApply.waiting[0].what, /not confirmed/i);
  assert.match(gatedApply.waiting[0].what, /Nonexistent Topic A/);
  assert.equal(gatedApply.examScope.confirmed, false);
  assert.equal([...study.runtime.work.jobs.values()].length, 0, 'zero background jobs created before confirmation');

  const gatedFill = fillPlan(await study.store.read(), { course: 'OS' }, { language: 'en' });
  assert.equal(gatedFill.status, 'exam-scope-unconfirmed');
  assert.equal(gatedFill.book, null);
  assert.equal(gatedFill.questions, null);

  // Step C: Confirm `resolvedChapters` via course.save => pick-pages.js, planBook, preview, and apply strictly slice to those 3 chapters!
  await study.call('course.save', {
    name: 'OS',
    custom: examPlan({ scope: { kind: 'exam', note: 'Midterm', resolvedChapters: matchedIds } }),
  });

  const confirmedState = await study.store.read();
  const docs = buildOutlineIndex(confirmedState, { course: 'OS' }).allDocuments;
  const pageScope = scopePages(docs, confirmedState.courses[0].custom.scope);
  const allowedPages = pageScope.get('pdf:document-os10');
  // Ch 3 = pages 9..12, Ch 5 = pages 17..20, Ch 7 = pages 25..28 => exactly 12 pages out of 40.
  const expectedSourceIds = [
    'os-p9', 'os-p10', 'os-p11', 'os-p12',
    'os-p17', 'os-p18', 'os-p19', 'os-p20',
    'os-p25', 'os-p26', 'os-p27', 'os-p28',
  ];
  assert.deepEqual([...allowedPages].sort(), [...expectedSourceIds].sort(), 'pick-pages.js scopePages covers strictly the 3 chapters');

  const allRanges = courseRanges(confirmedState, docs, { language: 'en' }).ranges;
  const readRanges = allRanges.filter(range => readsRange(pageScope, range));
  assert.ok(readRanges.length > 0 && readRanges.length < allRanges.length);
  for (const range of readRanges) {
    assert.ok(range.pieces.some(piece => allowedPages.has(piece.sourceId)), 'every read range intersects the 3 confirmed chapters');
  }

  // planBook without explicit chapters ALSO respects confirmed exam resolvedChapters!
  const directBookPlan = planBook(confirmedState, { course: 'OS', language: 'en', sample: 'skip' });
  assert.deepEqual(directBookPlan.chapters, matchedIds, 'planBook honors confirmed scope.resolvedChapters');
  assert.equal(directBookPlan.inventory.calls.length, explicit3Preview.estimate.book.inventory);

  // Confirmed preview reports confirmed: true and exact 3-chapter estimate.
  const confirmedPreview = await study.call('course.custom.preview', { course: 'OS', language: 'en' });
  assert.equal(confirmedPreview.examScope.confirmed, true);
  assert.deepEqual(confirmedPreview.examScope.resolvedChapters, matchedIds);
  assert.deepEqual(confirmedPreview.estimate, explicit3Preview.estimate);

  // Confirmed apply starts ONLY jobs covering those 3 chapters (book + questions), zero pages from the other 7 chapters!
  const applied = await study.call('course.custom.apply', { course: 'OS', language: 'en' });
  assert.equal(applied.status, 'ok');
  assert.equal(applied.recorded.filter(item => item.step === 'scope').length, 0);
  const bookStarted = applied.started.filter(item => item.step === 'book');
  const qStarted = applied.started.filter(item => item.step === 'questions');
  assert.equal(bookStarted.length, 1, 'book build started for confirmed exam chapters');
  assert.ok(qStarted.length >= 1, 'question generation started for confirmed exam chapters');

  const qJobs = questionJobs(study);
  assert.ok(qJobs.length >= 1, 'question jobs created');
  const generatedPages = [...new Set(qJobs.flatMap(job => job.sourceIds))].sort();
  assert.deepEqual(generatedPages, [...expectedSourceIds].sort(), 'question generation strictly slices to the 12 pages of the 3 confirmed chapters');

  // Verify stale resolvedChapters are caught and gated (not silently widened to whole book).
  await study.call('course.save', {
    name: 'OS',
    custom: examPlan({ scope: { kind: 'exam', resolvedChapters: ['pdf:document-os10#99'] } }),
  });
  const staleApply = await study.call('course.custom.apply', { course: 'OS', language: 'en' });
  assert.deepEqual(staleApply.started, []);
  assert.ok(staleApply.waiting.some(item => item.step === 'book' && /#99/.test(item.what)));
  assert.ok(staleApply.waiting.some(item => item.step === 'questions' && /#99/.test(item.what)));
});

/* ---------- 4. Confirmation UI & Bilingual i18n tests ---------- */

const uiMod = await loadUi(`
  export { default as CustomPlanCard } from './ui/CustomPlanCard.jsx';
  export * as model from './ui/custom-plan-model.js';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const stripTags = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();
const renderCard = (props, language = 'zh') => {
  uiMod.setUiLanguage(language);
  try {
    return renderToStaticMarkup(inApp(uiMod, h(uiMod.CustomPlanCard, props), { call: async () => props.initialPreview }));
  } finally {
    uiMod.setUiLanguage('zh');
  }
};

const samplePreview = (confirmed = false) => ({
  status: 'ok',
  course: 'OS',
  skeleton: {
    basis: 'documents',
    documents: [{
      key: 'pdf:doc1',
      title: 'OS Textbook',
      pages: 40,
      chars: 40000,
      chapters: [
        { id: 'pdf:doc1#0', title: 'Chapter 1: Intro', pages: [1, 4], chars: 4000 },
        { id: 'pdf:doc1#2', title: 'Chapter 3: CPU Scheduling', pages: [9, 12], chars: 4000 },
        { id: 'pdf:doc1#4', title: 'Chapter 5: Deadlocks', pages: [17, 20], chars: 4000 },
        { id: 'pdf:doc1#6', title: 'Chapter 7: Virtual Memory', pages: [25, 28], chars: 4000 },
      ],
    }],
  },
  estimate: { book: { points: 6, calls: 15, readTokens: { low: 1000, high: 1500 } }, questions: { count: 12, runs: 1, calls: 8, readTokens: { low: 500, high: 750 } }, total: { calls: 23, readTokens: { low: 1500, high: 2250 } }, rough: true },
  unknownChapters: [],
  examScope: {
    basis: 'documents',
    matchedChapters: [
      { id: 'pdf:doc1#2', title: 'Chapter 3: CPU Scheduling', pages: [9, 12], confidence: 'high', matchedTopics: ['CPU Scheduling'], reasons: ['heading'] },
      { id: 'pdf:doc1#4', title: 'Chapter 5: Deadlocks', pages: [17, 20], confidence: 'high', matchedTopics: ['Deadlocks'], reasons: ['heading'] },
      { id: 'pdf:doc1#6', title: 'Chapter 7: Virtual Memory', pages: [25, 28], confidence: 'high', matchedTopics: ['Virtual Memory'], reasons: ['heading'] },
    ],
    unmatchedTopics: ['Quantum Entanglement', 'Distributed Consensus'],
    topics: ['CPU Scheduling', 'Deadlocks', 'Virtual Memory', 'Quantum Entanglement', 'Distributed Consensus'],
    totalChapters: 4,
    confirmed,
    resolvedChapters: confirmed ? ['pdf:doc1#2', 'pdf:doc1#4', 'pdf:doc1#6'] : null,
    coverageNote: 'Matched 3 of 4 chapters; 2 topics unmatched.',
  },
});

test('confirmation UI shows matched chapters and unmatched topics on the same screen, gates readiness before confirm, and has full en/zh-CN parity', () => {
  const unconfirmedCustom = examPlan({ scope: { kind: 'exam', note: 'Midterm' } });
  const courseObj = custom => ({ id: 'course-os', name: 'OS', aliases: [], guidanceSourceIds: [], focusTopics: [], decks: 0, sources: 0, custom });

  // Unconfirmed (Chinese)
  const zhHtml = renderCard({ course: courseObj(unconfirmedCustom), initialPreview: samplePreview(false) }, 'zh');
  const zhText = stripTags(zhHtml);
  assert.match(zhText, /确认考试范围章节/);
  assert.match(zhText, /Chapter 3: CPU Scheduling/);
  assert.match(zhText, /Chapter 5: Deadlocks/);
  assert.match(zhText, /Chapter 7: Virtual Memory/);
  assert.match(zhText, /Quantum Entanglement/, 'unmatched topics shown on the same screen');
  assert.match(zhText, /Distributed Consensus/);
  assert.match(zhText, /确认考试范围（3 章）/);
  assert.doesNotMatch(zhText, /章节准备度/, 'readiness / fill gaps hidden while exam scope is unconfirmed');
  assert.doesNotMatch(zhHtml, /\btitle="/, 'no native title attribute');

  // Unconfirmed (English) — zero Chinese characters!
  const enHtml = renderCard({ course: courseObj(unconfirmedCustom), initialPreview: samplePreview(false) }, 'en');
  const enText = stripTags(enHtml);
  assert.doesNotMatch(enText, /[\u3400-\u9fff]/, `English exam-scope UI has zero Chinese: ${enText}`);
  assert.match(enText, /Confirm exam-scope chapters/);
  assert.match(enText, /Unmatched exam topics/);
  assert.match(enText, /Quantum Entanglement/);
  assert.match(enText, /Confirm exam scope \(3 chapters\)/);

  // Confirmed (Chinese & English)
  const confirmedCustom = uiMod.model.setExamResolvedChapters(unconfirmedCustom, ['pdf:doc1#2', 'pdf:doc1#4', 'pdf:doc1#6']);
  assert.doesNotThrow(() => checkedCustom(confirmedCustom));
  const zhConfirmed = renderCard({ course: courseObj(confirmedCustom), initialPreview: samplePreview(true) }, 'zh');
  assert.match(stripTags(zhConfirmed), /考试范围（第 3、5、7 章）/);
  assert.match(stripTags(zhConfirmed), /调整考试范围章节/);
  assert.doesNotMatch(zhConfirmed, /is-unconfirmed/);

  const enConfirmed = renderCard({ course: courseObj(confirmedCustom), initialPreview: samplePreview(true) }, 'en');
  const enConfirmedText = stripTags(enConfirmed);
  assert.doesNotMatch(enConfirmedText, /[\u3400-\u9fff]/, `English confirmed UI has zero Chinese: ${enConfirmedText}`);
  assert.match(enConfirmedText, /Exam range \(Chapter 3, 5, 7\)/);
  assert.match(enConfirmedText, /Adjust exam-scope chapters/);

  // Non-exam scope adds 0 exam-scope controls (§2.1 control budget).
  const allScopeHtml = renderCard({ course: courseObj(examPlan({ scope: { kind: 'all' } })), initialPreview: { ...samplePreview(false), examScope: undefined } }, 'zh');
  assert.doesNotMatch(allScopeHtml, /custom-card__exam-scope|custom-card__exam-disclosure/);

  // Pure toggle helper keeps skeleton reading order.
  const order = ['pdf:doc1#0', 'pdf:doc1#2', 'pdf:doc1#4', 'pdf:doc1#6'];
  assert.deepEqual(uiMod.model.toggleExamChapter(['pdf:doc1#2', 'pdf:doc1#6'], 'pdf:doc1#0', order), ['pdf:doc1#0', 'pdf:doc1#2', 'pdf:doc1#6']);
  assert.deepEqual(uiMod.model.toggleExamChapter(['pdf:doc1#0', 'pdf:doc1#2'], 'pdf:doc1#0', order), ['pdf:doc1#2']);
});
