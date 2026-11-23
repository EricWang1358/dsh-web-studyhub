// Consolidated Generate & Drafts Domain Suite (GenerateView, GeneratePathModal & DraftEditor):
// Merged from: round44-gen-suggest, round56-gen-weak-topics, round61-draft-plan,
//              round64-gen-path, round72-draft-ux, round73-gen-src-filter
// node --test tests/domain-generate-drafts.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { render } from 'ink';
import React from 'react';
import { StudyService } from '../../../lib/service.js';
import {
  UNICODE_UI_CHROME_RE,
  createTempTracker,
  createVirtualTty,
  disposeTerminalPool,
  distDir,
  findExportedBackupFile,
  loadDistRuntime,
} from './helpers/virtual-tty.mjs';

const runtime = await loadDistRuntime();
const { StudyHubTuiApp, createTuiHost, saveTuiPreferences, loadTuiPreferences } = runtime;
assert.ok(StudyHubTuiApp, 'dist/ must export StudyHubTuiApp');
assert.ok(createTuiHost, 'dist/ must export createTuiHost');
assert.ok(saveTuiPreferences, 'dist/ must export saveTuiPreferences');
assert.ok(loadTuiPreferences, 'dist/ must export loadTuiPreferences');

const distFiles = (await readdir(distDir)).filter((f) => f.endsWith('.mjs') && f !== 'cli.mjs');
const storeFile = distFiles.find((f) => f.startsWith('store-') && f.endsWith('.mjs'));
assert.ok(storeFile, 'dist/ must include store-*.mjs');
const { useTuiStore, DEFAULT_PREFERENCES } = await import(pathToFileURL(join(distDir, storeFile)).href);
assert.ok(useTuiStore, 'dist/store-*.mjs must export useTuiStore');
assert.ok(DEFAULT_PREFERENCES, 'dist/store-*.mjs must export DEFAULT_PREFERENCES');

// Load unit helpers directly from built dist chunks (zero tsx/esbuild overhead)
const genViewChunk = distFiles.find((f) => f.startsWith('GenerateView-') && f.endsWith('.mjs'));
assert.ok(genViewChunk, `dist/ must emit GenerateView-*.mjs chunk, found: ${distFiles.join(', ')}`);
const { formatWeakTopicNames, filterMaterialGroups } = await import(
  pathToFileURL(join(distDir, genViewChunk)).href
);
assert.equal(typeof formatWeakTopicNames, 'function', `${genViewChunk} must export formatWeakTopicNames`);
assert.equal(typeof filterMaterialGroups, 'function', `${genViewChunk} must export filterMaterialGroups`);

const draftEditorChunk = distFiles.find((f) => f.startsWith('DraftEditor-') && f.endsWith('.mjs'));
assert.ok(draftEditorChunk, `dist/ must emit DraftEditor-*.mjs chunk, found: ${distFiles.join(', ')}`);
const { formatDraftMarkdown } = await import(pathToFileURL(join(distDir, draftEditorChunk)).href);
assert.equal(typeof formatDraftMarkdown, 'function', `${draftEditorChunk} must export formatDraftMarkdown`);

const pathModalChunk = distFiles.find((f) => f.startsWith('GeneratePathModal-') && f.endsWith('.mjs'));
assert.ok(pathModalChunk, `dist/ must emit lazy GeneratePathModal-*.mjs chunk, found: ${distFiles.join(', ')}`);
const pathModalChunkCode = fs.readFileSync(join(distDir, pathModalChunk), 'utf8');
assert.equal(/\bmarked\b/.test(pathModalChunkCode), false, `${pathModalChunk} must be marked-free`);
assert.equal(/\bcli-highlight\b/.test(pathModalChunkCode), false, `${pathModalChunk} must not bundle cli-highlight`);
assert.equal(/src\/components\/MarkdownView\.tsx/.test(pathModalChunkCode), false, `${pathModalChunk} must not bundle MarkdownView`);
const { buildLocalPathSteps } = await import(pathToFileURL(join(distDir, pathModalChunk)).href);
assert.equal(typeof buildLocalPathSteps, 'function', `${pathModalChunk} must export buildLocalPathSteps`);

const PREV_DSH_HOME = process.env.DSH_HOME;
const temps = createTempTracker('studyhub-tui-dom-gen-drafts-');

after(async () => {
  disposeTerminalPool();
  if (PREV_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = PREV_DSH_HOME;
  await temps.cleanup();
});

function resetTuiStore(language = 'zh', asciiMode = false, extra = {}) {
  useTuiStore.setState({
    page: 'library',
    navContext: {},
    history: [],
    snapshot: null,
    binding: null,
    config: null,
    desktopConfig: null,
    loading: false,
    refreshing: false,
    lastError: null,
    toasts: [],
    footerHints: [],
    commandPaletteOpen: false,
    helpOpen: false,
    coursePickerOpen: false,
    inboxOpen: false,
    voicePackOpen: false,
    showLaunchpad: false,
    inputCaptured: false,
    activeRunId: null,
    preferences: {
      ...DEFAULT_PREFERENCES,
      recentCommands: [...DEFAULT_PREFERENCES.recentCommands],
      language,
      asciiMode,
    },
    ...extra,
  });
}

function fakeDiscovery() {
  const result = () => [
    { id: 'agy', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
    { id: 'claude', supported: false, status: 'coming-soon', executablePath: null, version: null, reasonCode: 'coming-soon-not-installed', reason: '' },
    { id: 'codex', supported: true, status: 'not-installed', executablePath: null, version: null, reasonCode: 'not-installed', reason: '' },
  ];
  return {
    async scan() {
      return result();
    },
    getCached: () => result(),
    findReadyPath: () => '',
    findReadyAgyPath: () => '',
    findReadyCodexPath: () => '',
  };
}

function todayLocalYmd(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function addTextSource(host, title, text, courses = []) {
  const res = await host.call('source.add', { title, text, ...(courses.length ? { courses } : {}) });
  assert.equal(res.ok, true, `source.add(${title}) failed: ${res.error?.message || ''}`);
  const id = res.value?.source?.id || res.value?.id;
  assert.ok(id, `source.add(${title}) must return source id`);
  return id;
}

async function seedLibraryWithWeakTopic(host, course = 'Algorithms') {
  const courseRes = await host.call('course.save', { name: course });
  assert.equal(courseRes.ok, true, `course.save(${course}) failed: ${courseRes.error?.message || ''}`);

  const deckRes = await host.call('deck.import', {
    text: JSON.stringify({
      title: 'Algorithms Core Deck',
      course,
      cards: [
        {
          kind: 'flashcard',
          prompt: 'What two properties characterize Dynamic Programming?',
          answer: 'Optimal substructure and overlapping subproblems.',
          topic: 'Dynamic Programming',
        },
        {
          kind: 'flashcard',
          prompt: 'What property enables Greedy Algorithms?',
          answer: 'Greedy choice property and optimal substructure.',
          topic: 'Greedy Algorithms',
        },
      ],
    }),
    folder: course,
  });
  assert.equal(deckRes.ok, true, `deck.import failed: ${deckRes.error?.message || ''}`);
  assert.equal(deckRes.value?.failed, 0, `deck.import had failures: ${JSON.stringify(deckRes.value?.results)}`);

  const srcRes = await host.call('source.add', {
    title: 'Algorithms Lecture Notes',
    text: '# Dynamic Programming\n## Optimal Substructure\n## Overlapping Subproblems\n',
    courses: [course],
  });
  assert.equal(srcRes.ok, true, `source.add failed: ${srcRes.error?.message || ''}`);

  const deckId = deckRes.value?.results?.[0]?.deckId;
  assert.ok(deckId, `deck.import must return deckId: ${JSON.stringify(deckRes.value)}`);

  const deckGet = await host.call('deck.get', { id: deckId });
  assert.equal(deckGet.ok, true, `deck.get failed: ${deckGet.error?.message || ''}`);
  const dpCard = (deckGet.value?.cards || []).find((c) => c.topic === 'Dynamic Programming');
  assert.ok(dpCard?.id, 'Dynamic Programming card must exist in imported deck');

  const startRes = await host.call('review.start', {
    mode: 'path',
    scope: [{ deckId, cardId: dpCard.id }],
    fresh: true,
  });
  assert.equal(startRes.ok, true, `review.start failed: ${startRes.error?.message || ''}`);
  const run = startRes.value;
  assert.ok(run?.id, 'review.start must return run id');

  const revRes = await host.call('review.reveal', { runId: run.id, cardId: dpCard.id });
  assert.equal(revRes.ok, true, `review.reveal failed: ${revRes.error?.message || ''}`);

  const ansRes = await host.call('review.answer', { runId: run.id, cardId: dpCard.id, grade: 1 });
  assert.equal(ansRes.ok, true, `review.answer(grade=1) failed: ${ansRes.error?.message || ''}`);

  await host.refreshSnapshot();
  return { deckId, dpCardId: dpCard.id };
}

async function seedMultiPagePdfLibrary(root, { course = 'Algorithms', docTitle = 'Graph Algorithms', totalPages = 25 } = {}) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    for (let p = 1; p <= totalPages; p += 1) {
      state.sources.push({
        id: `algo-p${p}`,
        title: `${docTitle} · p. ${p}`,
        createdAt: `2026-10-01T00:${String(p).padStart(2, '0')}:00.000Z`,
        courses: [course],
        text: `SECRET_RAW_PAGE_${p}_BODY: Dijkstra shortest paths and relaxation invariants.`,
        document: {
          materialId: 'doc-algo-25',
          page: p,
          totalPages,
          format: 'pdf',
          origin: 'converted',
          converter: 'marker',
          filename: 'graph-algorithms.pdf',
          extractionVersion: 2,
        },
      });
    }
  });
}

const DRAFT_SOURCE_ID = 'src-r61-algo';
const DRAFT_SOURCE_QUOTE_1 =
  'Binary search halves the sorted search interval at every midpoint comparison, achieving O(log n) worst-case time.';
const DRAFT_SOURCE_QUOTE_2 =
  'Contiguous arrays compute element addresses via base plus index times stride in O(1), while singly linked lists traverse pointers in O(n).';

function makeValidDraftDeck(id = 'draft-r61-plan', title = 'Algorithms Preflight Draft') {
  return {
    id,
    title,
    course: 'CS101',
    cards: [
      {
        id: 'card-r61-1',
        kind: 'open',
        topic: 'Binary Search',
        objective: 'Explain why binary search runs in O(log n) worst-case time',
        prompt: 'Why does binary search achieve O(log n) worst-case time complexity on a sorted array?',
        answer: 'Each midpoint comparison halves the remaining search interval, requiring at most ceil(log2(n + 1)) steps.',
        hint: 'Consider how the search interval size shrinks after each comparison.',
        explanation: 'Because the array is sorted, comparing with the midpoint eliminates half the remaining elements per step.',
        misconception: 'Assuming binary search works on an unsorted array without sorting first.',
        rubric: 'Must state that the array is sorted and each comparison halves the search space.',
        citations: [{ sourceId: DRAFT_SOURCE_ID, quote: DRAFT_SOURCE_QUOTE_1 }],
      },
      {
        id: 'card-r61-2',
        kind: 'open',
        topic: 'Linked Lists',
        objective: 'Compare random access complexity in arrays versus singly linked lists',
        prompt: 'Why is random access O(1) in a contiguous array yet O(n) in a singly linked list?',
        answer: 'Arrays compute element addresses via base + index * stride, whereas linked lists traverse pointers from the head.',
        hint: 'Compare contiguous memory layout against pointer traversal.',
        explanation: 'Contiguous memory allows direct offset arithmetic; linked list nodes must be visited sequentially.',
        misconception: 'Believing linked lists support constant-time offset indexing.',
        rubric: 'Must contrast direct offset arithmetic in arrays with sequential pointer traversal in linked lists.',
        citations: [{ sourceId: DRAFT_SOURCE_ID, quote: DRAFT_SOURCE_QUOTE_2 }],
      },
    ],
  };
}

describe('Domain Generate & Drafts: Suggest, Weak Topics, Path Planner, Source Filter & Draft UX/Preflight', () => {
  test('1) Unit: formatWeakTopicNames normalizes, deduplicates, skips invalid entries, and caps at 8', () => {
    assert.deepEqual(formatWeakTopicNames(null), []);
    assert.deepEqual(formatWeakTopicNames(undefined), []);
    assert.deepEqual(formatWeakTopicNames({}), []);
    assert.deepEqual(formatWeakTopicNames([]), []);
    assert.deepEqual(formatWeakTopicNames({ topics: 'not-an-array' }), []);

    const capped = formatWeakTopicNames({
      topics: [
        '  Dynamic Programming  ',
        { topic: 'Graph Traversal', weak: 3 },
        { name: 'Dynamic Programming' },
        { name: 'Divide and Conquer', wrong: 2, total: 4 },
        { topic: '' },
        { name: '   ' },
        {},
        '',
        '   ',
        42,
        null,
        'T1',
        'T2',
        'T3',
        'T4',
        'T5',
        'T6',
        'T7',
      ],
    });
    assert.equal(capped.length, 8, 'formatWeakTopicNames must cap output at 8 topics');
    assert.deepEqual(
      capped,
      ['Dynamic Programming', 'Graph Traversal', 'Divide and Conquer', 'T1', 'T2', 'T3', 'T4', 'T5'],
      'formatWeakTopicNames must normalize, deduplicate, skip empty entries, and cap at 8',
    );
    assert.deepEqual(
      formatWeakTopicNames(['Alpha', { topic: '  Beta  ' }, { name: 'Alpha' }, { name: '  Gamma  ' }]),
      ['Alpha', 'Beta', 'Gamma'],
    );
    assert.deepEqual(formatWeakTopicNames([{ topic: 'Raft', name: 'Ignored' }]), ['Raft']);
    assert.deepEqual(formatWeakTopicNames([{ name: 'Paxos' }]), ['Paxos']);
    assert.deepEqual(formatWeakTopicNames(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']), [
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
    ]);
  });

  test('2) Unit: filterMaterialGroups filters case-insensitively across title, courses, folder, and format', () => {
    const docs = [
      {
        key: 'doc:os-1',
        title: 'Virtual Memory & TLB',
        format: 'pdf',
        pageCount: 10,
        sourceIds: ['s1'],
        pages: [{ sourceId: 's1', page: 1, title: 'p1', chars: 500 }],
        courses: ['CS301', 'Systems'],
        folder: 'Lectures',
        cardCount: 0,
        chars: 500,
        pinned: false,
        archived: false,
      },
      {
        key: 'doc:net-2',
        title: 'Raft Consensus Lab',
        format: 'md',
        pageCount: 2,
        sourceIds: ['s2'],
        pages: [{ sourceId: 's2', page: 1, title: 'p1', chars: 400 }],
        courses: ['CS402'],
        folder: 'Labs',
        cardCount: 0,
        chars: 400,
        pinned: false,
        archived: false,
      },
      {
        key: 'doc:algo-3',
        title: 'Dynamic Programming Notes',
        format: 'txt',
        pageCount: 1,
        sourceIds: ['s3'],
        pages: [{ sourceId: 's3', page: 1, title: 'p1', chars: 300 }],
        courses: [],
        cardCount: 0,
        chars: 300,
        pinned: false,
        archived: false,
      },
    ];

    assert.equal(filterMaterialGroups(docs, '').length, 3);
    assert.equal(filterMaterialGroups(docs, '   ').length, 3);
    assert.deepEqual(filterMaterialGroups(docs, 'RAFT').map((d) => d.key), ['doc:net-2']);
    assert.deepEqual(filterMaterialGroups(docs, '  raft  ').map((d) => d.key), ['doc:net-2']);
    assert.deepEqual(filterMaterialGroups(docs, 'cs301').map((d) => d.key), ['doc:os-1']);
    assert.deepEqual(filterMaterialGroups(docs, 'systems').map((d) => d.key), ['doc:os-1']);
    assert.deepEqual(filterMaterialGroups(docs, 'lectures').map((d) => d.key), ['doc:os-1']);
    assert.deepEqual(filterMaterialGroups(docs, 'MD').map((d) => d.key), ['doc:net-2']);
    assert.deepEqual(filterMaterialGroups(docs, 'txt').map((d) => d.key), ['doc:algo-3']);
    assert.deepEqual(filterMaterialGroups(docs, 'LABS').map((d) => d.key), ['doc:net-2']);
    assert.deepEqual(filterMaterialGroups(docs, 'e').map((d) => d.key), ['doc:os-1', 'doc:net-2', 'doc:algo-3']);
    assert.deepEqual(filterMaterialGroups(docs, 'nonexistent'), []);
    assert.deepEqual(filterMaterialGroups([], 'raft'), []);
    assert.equal(filterMaterialGroups(docs, 'notes')[0]?.title, 'Dynamic Programming Notes');
  });

  test('3) Unit: buildLocalPathSteps partitions multi-page & single-page docs cleanly and clamps counts [5, 20]', () => {
    const doc45 = {
      key: 'pdf:doc-45',
      title: 'Distributed Systems',
      format: 'pdf',
      pageCount: 45,
      sourceIds: Array.from({ length: 45 }, (_, i) => `d45-p${i + 1}`),
      pages: Array.from({ length: 45 }, (_, i) => ({
        sourceId: `d45-p${i + 1}`,
        page: i + 1,
        title: `Distributed Systems p.${i + 1}`,
        chars: 4000,
      })),
      courses: ['CS401'],
      cardCount: 0,
      chars: 45 * 4000,
      pinned: false,
      archived: false,
    };
    const doc5 = {
      key: 'doc:notes-5',
      title: 'Consensus Notes',
      format: 'md',
      pageCount: 5,
      sourceIds: Array.from({ length: 5 }, (_, i) => `d5-p${i + 1}`),
      pages: Array.from({ length: 5 }, (_, i) => ({
        sourceId: `d5-p${i + 1}`,
        page: i + 1,
        title: `Consensus Notes p.${i + 1}`,
        chars: 1200,
      })),
      courses: ['CS401'],
      cardCount: 0,
      chars: 6000,
      pinned: false,
      archived: false,
    };

    const selectedIds = new Set([...doc45.sourceIds, ...doc5.sourceIds]);
    const steps = buildLocalPathSteps([doc45, doc5], selectedIds);
    assert.equal(steps.length, 4, '45p + 5p must partition into 4 sequential steps (20, 20, 5, 5)');
    assert.deepEqual(
      steps.map((s) => ({ id: s.id, pageScope: s.pageScope, pages: s.pages, documentTitle: s.documentTitle })),
      [
        { id: 'step-1', pageScope: '1-20', pages: 20, documentTitle: 'Distributed Systems' },
        { id: 'step-2', pageScope: '21-40', pages: 20, documentTitle: 'Distributed Systems' },
        { id: 'step-3', pageScope: '41-45', pages: 5, documentTitle: 'Distributed Systems' },
        { id: 'step-4', pageScope: '1-5', pages: 5, documentTitle: 'Consensus Notes' },
      ],
    );

    assert.equal(steps[0].order, 1);
    assert.ok(steps[0].count >= 5 && steps[0].count <= 20, 'step-1 count clamped to [5, 20]');
    assert.equal(steps[0].chars, 80_000);
    assert.ok(steps[0].title.includes('Distributed Systems'));
    assert.equal(steps[1].order, 2);
    assert.ok(steps[1].count >= 5 && steps[1].count <= 20, 'step-2 count clamped to [5, 20]');
    assert.equal(steps[1].chars, 80_000);
    assert.equal(steps[2].order, 3);
    assert.ok(steps[2].count >= 5 && steps[2].count <= 20, 'step-3 count clamped to [5, 20]');
    assert.equal(steps[2].chars, 20_000);
    assert.equal(steps[3].order, 4);
    assert.ok(steps[3].count >= 5 && steps[3].count <= 20, 'step-4 count clamped to [5, 20]');
    assert.equal(steps[3].chars, 6_000);
    assert.ok(steps[3].title.includes('Consensus Notes'));

    // Empty selections / empty docs
    assert.deepEqual(buildLocalPathSteps([doc45], new Set()), []);
    assert.deepEqual(buildLocalPathSteps([], selectedIds), []);

    // Partial selection subset on doc45 (pages 3..7 only)
    const partialSteps = buildLocalPathSteps(
      [doc45],
      new Set(['d45-p3', 'd45-p4', 'd45-p5', 'd45-p6', 'd45-p7']),
    );
    assert.equal(partialSteps.length, 1);
    assert.equal(partialSteps[0].pageScope, '3-7');
    assert.equal(partialSteps[0].pages, 5);

    // Count clamping at min=5 (tiny 1-page doc) and max=20 (dense 1-page doc)
    const tinyDoc = {
      key: 'doc:tiny',
      title: 'Tiny Sheet',
      format: 'md',
      pageCount: 1,
      sourceIds: ['tiny-1'],
      pages: [{ sourceId: 'tiny-1', page: 1, title: 'p1', chars: 120 }],
      courses: [],
      cardCount: 0,
      chars: 120,
      pinned: false,
      archived: false,
    };
    const tinySteps = buildLocalPathSteps([tinyDoc], new Set(['tiny-1']));
    assert.equal(tinySteps.length, 1);
    assert.equal(tinySteps[0].count, 5, 'tiny doc count must clamp up to 5');

    const denseDoc = {
      key: 'doc:dense',
      title: 'Dense Monograph',
      format: 'pdf',
      pageCount: 1,
      sourceIds: ['dense-1'],
      pages: [{ sourceId: 'dense-1', page: 1, title: 'p1', chars: 150_000 }],
      courses: [],
      cardCount: 0,
      chars: 150_000,
      pinned: false,
      archived: false,
    };
    const denseSteps = buildLocalPathSteps([denseDoc], new Set(['dense-1']));
    assert.equal(denseSteps.length, 1);
    assert.equal(denseSteps[0].count, 20, 'dense doc count must clamp down to 20');
  });

  test('4) Unit: formatDraftMarkdown formats zh & en study sheets, MCQ/multi, cloze, <details>, empty & ASCII-safe output', () => {
    const sampleDraft = {
      id: 'draft-r72-unit',
      title: 'Design Patterns Draft',
      course: 'CS301',
      draftVersion: 3,
      cards: [
        {
          id: 'c1',
          kind: 'quiz',
          topic: 'Memento',
          prompt: 'Which pattern saves state without exposing internals?',
          answer: 'A. Memento',
          hint: 'Think about snapshots.',
          explanation: 'Memento encapsulates state inside an opaque token.',
          options: [
            { id: 'a', text: 'Memento', correct: true },
            { id: 'b', text: 'Bridge', correct: false },
          ],
        },
        {
          id: 'c2',
          kind: 'cloze',
          topic: 'Bridge',
          cloze: {
            text: '{{c1::Bridge}} decouples abstraction from {{c2::implementation}}.',
            answers: [{ id: 'c1', value: 'Bridge' }, { id: 'c2', value: 'implementation' }],
          },
          hint: 'Two independent hierarchies.',
          explanation: 'Avoids Cartesian class explosion.',
        },
      ],
    };

    const zhMd = formatDraftMarkdown({
      draft: sampleDraft,
      cards: sampleDraft.cards,
      lang: 'zh',
      generatedAt: '2026-11-22 10:30',
    });
    assert.ok(zhMd.includes('# Design Patterns Draft'));
    assert.ok(zhMd.includes('**课程**: CS301'));
    assert.ok(zhMd.includes('**生成日期**: 2026-11-22 10:30'));
    assert.ok(zhMd.includes('**题目数量**: 2'));
    assert.ok(zhMd.includes('**草稿版本**: v3'));
    assert.ok(zhMd.includes('## 1. Memento'));
    assert.ok(zhMd.includes('`quiz` `Memento`'));
    assert.ok(zhMd.includes('- **A.** Memento'));
    assert.ok(zhMd.includes('- **B.** Bridge'));
    assert.ok(zhMd.includes('## 2. Bridge'));
    assert.ok(zhMd.includes('{{c1::Bridge}} decouples abstraction from {{c2::implementation}}.'));
    assert.ok(zhMd.includes('<details>\n<summary>参考答案与解析 / Answer & Explanation</summary>'));
    assert.ok(zhMd.includes('**参考答案**: Bridge; implementation'));
    assert.ok(zhMd.includes('**提示**: Think about snapshots.'));
    assert.ok(zhMd.includes('**解析**:\n\nMemento encapsulates state inside an opaque token.'));
    assert.ok(zhMd.includes('</details>'));

    const enMd = formatDraftMarkdown({
      draft: sampleDraft,
      cards: [sampleDraft.cards[0]],
      lang: 'en',
      generatedAt: '2026-11-22 10:30',
    });
    assert.ok(enMd.includes('**Course**: CS301'));
    assert.ok(enMd.includes('**Generated**: 2026-11-22 10:30'));
    assert.ok(enMd.includes('**Cards**: 1'));
    assert.ok(enMd.includes('**Draft Version**: v3'));
    assert.ok(enMd.includes('**Answer**: A. Memento'));
    assert.ok(enMd.includes('**Hint**: Think about snapshots.'));
    assert.ok(enMd.includes('**Explanation**:\n\nMemento encapsulates state inside an opaque token.'));
    assert.ok(!enMd.includes('## 2. Bridge'), 'filtered cards slice should exclude second card');
    assert.equal(UNICODE_UI_CHROME_RE.test(enMd), false, 'English draft export must contain zero Unicode UI chrome');

    const emptyZh = formatDraftMarkdown({
      draft: { id: 'empty-draft', title: 'Empty', cards: [] },
      cards: [],
      lang: 'zh',
      generatedAt: '2026-11-22 10:30',
    });
    assert.ok(emptyZh.includes('**题目数量**: 0'));
    assert.ok(emptyZh.includes('暂无匹配题目'));
    assert.ok(emptyZh.includes('**课程**: 未分课'));
    assert.ok(emptyZh.includes('**草稿版本**: 未定稿'));

    const emptyEn = formatDraftMarkdown({
      draft: { id: 'empty-draft', title: 'Empty', cards: [] },
      cards: [],
      lang: 'en',
      generatedAt: '2026-11-22 10:30',
    });
    assert.ok(emptyEn.includes('**Cards**: 0'));
    assert.ok(emptyEn.includes('No matching draft cards'));
    assert.ok(emptyEn.includes('**Course**: General'));
    assert.ok(emptyEn.includes('**Draft Version**: draft'));

    // Missing answer/hint/explanation fallback & rubric/multi fallback
    const fallbackMd = formatDraftMarkdown({
      draft: { id: 'fallback', title: 'Fallback Draft' },
      cards: [
        { id: 'f1', kind: 'open', prompt: 'Bare question' },
        {
          id: 'f2',
          kind: 'multi',
          prompt: 'Pick all valid invariants',
          options: [
            { id: 'a', text: 'First', correct: true },
            { id: 'b', text: 'Second', correct: false },
            { id: 'c', text: 'Third', correct: true },
          ],
        },
        { id: 'f3', kind: 'open', prompt: 'Explain consensus', rubric: 'Mention quorum intersection.' },
      ],
      lang: 'en',
      generatedAt: '2026-11-22 10:30',
    });
    assert.ok(fallbackMd.includes('## 1. Card 1'));
    assert.ok(fallbackMd.includes('_No answer or explanation._'));
    assert.ok(fallbackMd.includes('**Answer**: A. First; C. Third'));
    assert.ok(fallbackMd.includes('**Answer**: Mention quorum intersection.'));
  });

  test('5) Host integration: generate.suggest sends headings/goal (never body) and handles empty sourceIds (no-signal)', async () => {
    const base = await temps.make('suggest-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const observedPrompts = [];
    let modelCalls = 0;

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (system, prompt) => {
        modelCalls += 1;
        observedPrompts.push({ system: String(system || ''), prompt: String(prompt) });
        return JSON.stringify({
          focus: ['Raft Leader Election', 'Paxos Quorum', 'Log Replication'],
          coverage: 'standard',
          difficulty: 'application',
          kind: 'quiz',
          why: 'Prioritizes core consensus headings and exam focus.',
        });
      },
    });

    try {
      const secretBody = 'SECRET_BODY_LINE_NEVER_SENT_TO_LIGHT_MODEL';
      const srcId = await addTextSource(
        host,
        'Consensus Protocols',
        `# Distributed Consensus\n${secretBody}\n## Raft Leader Election\n${secretBody}\n## Paxos Quorum\n${secretBody}`,
        ['Distributed Systems'],
      );

      const res = await host.call('generate.suggest', {
        sourceIds: [srcId],
        course: 'Distributed Systems',
        goal: 'exam',
      });
      assert.equal(res.ok, true, `generate.suggest failed: ${res.error?.message || ''}`);
      assert.equal(modelCalls, 1, 'generate.suggest must invoke model once on valid reply');
      assert.equal(res.value?.source, 'model');
      assert.deepEqual(res.value?.focus, ['Raft Leader Election', 'Paxos Quorum', 'Log Replication']);
      assert.equal(res.value?.coverage, 'standard');
      assert.equal(res.value?.difficulty, 'application');
      assert.equal(res.value?.kind, 'quiz');
      assert.match(res.value?.why || '', /consensus/i);
      assert.equal(res.value?.basis?.sources, 1);

      const sentSystem = observedPrompts[0]?.system || '';
      const sentPrompt = observedPrompts[0]?.prompt || '';
      assert.ok(sentSystem.length > 0, 'System prompt must be non-empty');
      assert.ok(sentPrompt.includes('Consensus Protocols'), 'Prompt must include source title');
      assert.ok(sentPrompt.includes('Raft Leader Election'), 'Prompt must include headings');
      assert.ok(sentPrompt.includes('"goal":"exam"'), 'Prompt must forward goal');
      assert.ok(!sentPrompt.includes(secretBody), 'Prompt must never send full source body text');

      // Empty sourceIds -> unavailable.reason === 'no-signal' with 0 additional model calls
      const emptyRes = await host.call('generate.suggest', {
        sourceIds: [],
        course: 'Distributed Systems',
      });
      assert.equal(emptyRes.ok, true, 'Empty sourceIds returns structured local fallback rather than throwing');
      assert.equal(modelCalls, 1, 'no-signal must not invoke model');
      assert.equal(emptyRes.value?.source, 'local');
      assert.deepEqual(emptyRes.value?.focus, []);
      assert.equal(emptyRes.value?.unavailable?.reason, 'no-signal');
    } finally {
      await host.dispose();
    }
  });

  test('6) Host integration: generate.weakTopics returns failed review topics scoped & unscoped with 0 model calls', async () => {
    const base = await temps.make('weak-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    let modelCalls = 0;

    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('generate.weakTopics must never invoke model');
      },
    });

    try {
      await seedLibraryWithWeakTopic(host, 'Algorithms');
      assert.equal(modelCalls, 0, 'seeding failed review attempt must make 0 model calls');

      const scopedRes = await host.call('generate.weakTopics', { course: 'Algorithms' });
      assert.equal(scopedRes.ok, true, `generate.weakTopics failed: ${scopedRes.error?.message || ''}`);
      assert.equal(modelCalls, 0, 'generate.weakTopics must make 0 model calls');
      const scopedTopics = formatWeakTopicNames(scopedRes.value);
      assert.ok(scopedTopics.includes('Dynamic Programming'), `Expected Dynamic Programming in ${JSON.stringify(scopedRes.value)}`);
      assert.ok(!scopedTopics.includes('Greedy Algorithms'), 'Unattempted topic must not be marked weak');

      const allRes = await host.call('generate.weakTopics', {});
      assert.equal(allRes.ok, true, `generate.weakTopics({}) failed: ${allRes.error?.message || ''}`);
      assert.equal(modelCalls, 0, 'generate.weakTopics({}) must make 0 model calls');
      assert.ok(formatWeakTopicNames(allRes.value).includes('Dynamic Programming'));

      // Empty course returns empty weak topics with 0 model calls
      const emptyCourseRes = await host.call('course.save', { name: 'Empty Course' });
      assert.equal(emptyCourseRes.ok, true);
      const emptyWeakRes = await host.call('generate.weakTopics', { course: 'Empty Course' });
      assert.equal(emptyWeakRes.ok, true);
      assert.equal(modelCalls, 0);
      assert.deepEqual(formatWeakTopicNames(emptyWeakRes.value), []);
    } finally {
      await host.dispose();
    }
  });

  test('7) Host integration: generate.path.suggest sends step summaries (never raw body) and handles empty steps (no-steps)', async () => {
    const base = await temps.make('path-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');

    const doc45 = {
      key: 'pdf:doc-45',
      title: 'Distributed Systems',
      format: 'pdf',
      pageCount: 45,
      sourceIds: Array.from({ length: 45 }, (_, i) => `d45-p${i + 1}`),
      pages: Array.from({ length: 45 }, (_, i) => ({
        sourceId: `d45-p${i + 1}`,
        page: i + 1,
        title: `Distributed Systems p.${i + 1}`,
        chars: 4000,
      })),
      courses: ['CS401'],
      cardCount: 0,
      chars: 45 * 4000,
      pinned: false,
      archived: false,
    };
    const steps = buildLocalPathSteps([doc45], new Set(doc45.sourceIds));
    assert.equal(steps.length, 3);

    let modelCalls = 0;
    const seenPrompts = [];

    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'en',
      injectedComplete: async (system, prompt) => {
        modelCalls += 1;
        seenPrompts.push({ system: String(system || ''), prompt: String(prompt) });
        return JSON.stringify({
          steps: [
            {
              id: 'step-2',
              title: 'Fault Tolerance & Paxos',
              focus: 'Compare Paxos prepare/accept phases and split-brain prevention',
              count: 16,
              reason: 'High-yield exam core',
            },
            {
              id: 'step-1',
              title: 'Clocks & Consistency Foundations',
              focus: 'Lamport timestamps and vector clock partial ordering',
              count: 12,
              reason: 'Prerequisite concepts',
            },
          ],
        });
      },
    });

    try {
      const res = await host.call('generate.path.suggest', {
        course: 'CS401',
        goal: 'exam',
        steps: steps.slice(0, 2).map((s) => ({
          id: s.id,
          title: s.title,
          pages: s.pages,
          chars: s.chars,
          count: s.count,
          range: s.range,
          documentTitle: s.documentTitle,
        })),
      });
      assert.equal(res.ok, true, `generate.path.suggest failed: ${res.error?.message || ''}`);
      assert.equal(modelCalls, 1, 'generate.path.suggest must invoke model once');
      assert.equal(res.value?.source, 'model');
      assert.equal(res.value?.steps?.length, 2);
      assert.equal(res.value?.steps?.[0]?.id, 'step-2');
      assert.equal(res.value?.steps?.[0]?.title, 'Fault Tolerance & Paxos');
      assert.equal(res.value?.steps?.[0]?.count, 16);
      assert.match(res.value?.steps?.[0]?.focus || '', /Paxos/);
      assert.equal(res.value?.steps?.[0]?.reason, 'High-yield exam core');
      assert.equal(res.value?.steps?.[1]?.id, 'step-1');
      assert.equal(res.value?.steps?.[1]?.title, 'Clocks & Consistency Foundations');
      assert.equal(res.value?.steps?.[1]?.count, 12);

      const promptStr = seenPrompts[0]?.prompt || '';
      assert.ok(seenPrompts[0]?.system.length > 0, 'system prompt must be non-empty');
      assert.ok(promptStr.includes('Distributed Systems'), 'prompt includes step titles');
      assert.ok(!promptStr.includes('SECRET_RAW_PAGE'), 'prompt must never send raw source body text');

      // Empty steps -> local no-steps with 0 extra model calls
      const emptyRes = await host.call('generate.path.suggest', { steps: [] });
      assert.equal(emptyRes.ok, true);
      assert.equal(emptyRes.value?.source, 'local');
      assert.equal(emptyRes.value?.unavailable?.reason, 'no-steps');
      assert.equal(modelCalls, 1);
    } finally {
      await host.dispose();
    }
  });

  test('8) Host integration: draft.save -> draft.publish.plan (quick: true) is strict dry-run with stale guard & 0 model calls', async () => {
    const base = await temps.make('draft-plan-host');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });

    let modelCalls = 0;
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    try {
      const srcRes = await host.call('source.add', {
        id: DRAFT_SOURCE_ID,
        title: 'CS101 Lecture Notes',
        courses: ['CS101'],
        text: `${DRAFT_SOURCE_QUOTE_1}\n\n${DRAFT_SOURCE_QUOTE_2}`,
      });
      assert.equal(srcRes.ok, true, srcRes.error?.message);

      const saved = await host.call('draft.save', {
        deck: makeValidDraftDeck('draft-r61-plan', 'Algorithms Preflight Draft'),
      });
      assert.equal(saved.ok, true, saved.error?.message);
      const savedDraft = saved.value;
      assert.equal(savedDraft.id, 'draft-r61-plan');
      assert.ok((savedDraft.draftVersion ?? 0) >= 1, 'saved draft must carry draftVersion');

      const beforeSnap = await host.call('snapshot');
      assert.equal(beforeSnap.ok, true, beforeSnap.error?.message);
      const deckCountBefore = (beforeSnap.value.decks ?? []).length;
      const draftCountBefore = (beforeSnap.value.drafts ?? []).length;
      assert.ok(draftCountBefore >= 1, 'saved draft should be present in snapshot');

      const planRes = await host.call('draft.publish.plan', {
        id: savedDraft.id,
        draftVersion: savedDraft.draftVersion,
        quick: true,
      });
      assert.equal(planRes.ok, true, planRes.error?.message);
      assert.equal(planRes.value.expect.draftId, savedDraft.id);
      assert.equal(planRes.value.expect.before, null);
      assert.equal(planRes.value.expect.remaining, null);
      assert.equal(planRes.value.expect.receipt.accepted, 2);
      assert.equal(planRes.value.expect.receipt.added, 2);
      assert.equal(planRes.value.expect.receipt.rejected, 0);
      assert.equal(planRes.value.expect.receipt.total, 2);
      assert.equal(modelCalls, 0, 'draft.publish.plan (quick: true) must make 0 model calls');

      // Stale draftVersion returns error cleanly
      const stalePlan = await host.call('draft.publish.plan', {
        id: savedDraft.id,
        draftVersion: (savedDraft.draftVersion ?? 0) + 99,
        quick: true,
      });
      assert.equal(stalePlan.ok, false, 'stale draftVersion must fail validation cleanly');
      assert.ok(stalePlan.error?.message, 'stale error must carry message');
      assert.equal(modelCalls, 0);

      // Missing draft id fails cleanly with 0 model calls
      const missingPlan = await host.call('draft.publish.plan', {
        id: 'draft-does-not-exist',
        quick: true,
      });
      assert.equal(missingPlan.ok, false, 'missing draft id must fail cleanly');
      assert.ok(missingPlan.error?.message, 'missing draft error must carry message');
      assert.equal(modelCalls, 0);

      // Library snapshot STILL has 0 newly published decks and draft remains intact
      const afterSnap = await host.call('snapshot');
      assert.equal(afterSnap.ok, true, afterSnap.error?.message);
      assert.equal((afterSnap.value.decks ?? []).length, deckCountBefore, 'dry-run must NOT mutate decks');
      assert.equal((afterSnap.value.drafts ?? []).length, draftCountBefore, 'dry-run must keep draft in drafts');
      assert.ok((afterSnap.value.drafts ?? []).some((d) => d.id === savedDraft.id));
    } finally {
      await host.dispose();
    }
  });

  test('9) PTY E2E (GenerateView [S]): P2 ConfirmDialog guard, n/Esc cancel (0 calls), busyRef gate, y suggest, 80x24 resize & [a] apply', async () => {
    const base = await temps.make('pty-gen-suggest');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;

    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

    let modelCalls = 0;
    let releaseSuggest = null;
    let suggestGate = null;

    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        if (suggestGate) await suggestGate;
        return JSON.stringify({
          focus: ['Raft 领导者选举', 'Paxos 法定人数', '日志复制安全性'],
          coverage: 'standard',
          difficulty: 'application',
          kind: 'multi',
          why: '优先覆盖核心共识章节与高频考点。',
        });
      },
    });

    await addTextSource(
      host,
      '分布式系统讲义',
      '# 共识算法\n## Raft 领导者选举\n## Paxos 法定人数\n正文内容不会发送到轻量模型。',
    );

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'zh LibraryView ready',
      });

      // Navigate to GenerateView ('3')
      tty.send('3');
      const genInit = await tty.waitFor(
        (s) => useTuiStore.getState().page === 'generate' && s.includes('新建出题任务') && s.includes('分布式系统讲义'),
        { label: 'zh GenerateView ready' },
      );
      tty.assertHealthyScreen(genInit, 120, 36, 'zh GenerateView initial');
      assert.equal(modelCalls, 0, 'Entering GenerateView must make 0 AI calls');
      assert.equal(useTuiStore.getState().page, 'generate');
      await tty.flush();

      // Pressing 'S' with 0 selected sources shows friendly toast and makes 0 AI calls
      useTuiStore.setState({ toasts: [] });
      tty.send('S');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.tone === 'warning' && toast.text.includes('请至少选择一份资料')),
        { label: 'zh toast when pressing S with no sources selected' },
      );
      assert.equal(modelCalls, 0, 'Empty selection toast must make 0 AI calls');

      // Select source with Space
      tty.send(' ');
      const selectedScreen = await tty.waitFor(
        (s) => s.includes('☑ [TEXT] 分布式系统讲义') && s.includes('Space 勾选)  1p'),
        { label: 'zh source selected via Space' },
      );
      assert.ok(selectedScreen.includes('☑ [TEXT] 分布式系统讲义'));

      // Press 'S' -> ConfirmDialog opens with 0 AI calls
      tty.send('S');
      const confirm1 = await tty.waitFor(
        (s) => s.includes('AI 帮我想想') && s.includes('1 次轻量 AI 调用') && s.includes('不会立即出题'),
        { label: 'zh P2 ConfirmDialog open after S' },
      );
      tty.assertHealthyScreen(confirm1, 120, 36, 'zh ConfirmDialog 120x36');
      assert.equal(modelCalls, 0, 'P2 guard: 0 AI calls before ConfirmDialog confirmation');
      assert.ok(confirm1.includes('AI 帮我想想'));

      // Cancel with 'n' -> still 0 AI calls
      tty.send('n');
      const afterCancelN = await tty.waitFor(
        (s) => s.includes('新建出题任务') && !s.includes('1 次轻量 AI 调用'),
        { label: 'zh ConfirmDialog cancelled with n' },
      );
      assert.equal(modelCalls, 0, 'Cancelling ConfirmDialog with n must keep AI calls at 0');
      assert.ok(!afterCancelN.includes('1 次轻量 AI 调用'));

      // Reopen 'S' and cancel with Esc -> still 0 AI calls
      tty.send('S');
      await tty.waitFor((s) => s.includes('1 次轻量 AI 调用'), { label: 'zh ConfirmDialog reopened for Esc' });
      assert.equal(modelCalls, 0, 'Reopening ConfirmDialog must keep AI calls at 0');
      tty.send('\u001b');
      const afterCancelEsc = await tty.waitFor(
        (s) => s.includes('新建出题任务') && !s.includes('1 次轻量 AI 调用'),
        { label: 'zh ConfirmDialog cancelled with Esc' },
      );
      assert.equal(modelCalls, 0, 'Cancelling ConfirmDialog with Esc must keep AI calls at 0');
      assert.ok(!afterCancelEsc.includes('1 次轻量 AI 调用'));

      // Press 'S' -> 'y' with gate to verify busyRef blocks duplicate calls while loading
      suggestGate = new Promise((resolveFn) => {
        releaseSuggest = resolveFn;
      });
      tty.send('S');
      await tty.waitFor((s) => s.includes('1 次轻量 AI 调用'), { label: 'zh ConfirmDialog before gated y' });
      tty.send('y');
      await tty.waitFor(
        (s) => s.includes('正在分析资料目录与薄弱知识点') && modelCalls === 1,
        { label: 'zh loading modal while generating suggestion' },
      );
      tty.send('S');
      tty.send('\u001b');
      await tty.flush(25);
      assert.equal(modelCalls, 1, 'busyRef must prevent duplicate AI calls while suggest is running');

      releaseSuggest();
      suggestGate = null;

      // Verify suggestion summary modal renders cleanly at 120x36
      const suggestWide = await tty.waitFor(
        (s) =>
          s.includes('AI 出题重点建议') &&
          s.includes('Raft 领导者选举') &&
          s.includes('Paxos 法定人数') &&
          s.includes('优先覆盖核心共识章节'),
        { label: 'zh AI suggestion rendered at 120x36' },
      );
      tty.assertHealthyScreen(suggestWide, 120, 36, 'zh AI suggestion 120x36');
      assert.ok(suggestWide.includes('日志复制安全性'));

      // Resize to 80x24 while suggestion modal is visible
      tty.resize(80, 24);
      const suggestNarrow = await tty.waitFor(
        (s) => s.includes('AI 出题重点建议') && s.includes('Raft 领导者选举') && s.split('\n').length <= 24,
        { label: 'zh AI suggestion rendered at 80x24' },
      );
      tty.assertHealthyScreen(suggestNarrow, 80, 24, 'zh AI suggestion 80x24');
      assert.ok(suggestNarrow.split('\n').length <= 24);

      // Apply suggestion with [a] at 80x24, then verify applied form at 120x36
      useTuiStore.setState({ toasts: [] });
      tty.send('a');
      const appliedNarrow = await tty.waitFor(
        (s) =>
          !s.includes('AI 出题重点建议') &&
          s.includes('新建出题任务') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已将建议重点应用')),
        { label: 'zh [a] applies suggestion toast at 80x24' },
      );
      tty.assertHealthyScreen(appliedNarrow, 80, 24, 'zh GenerateView after apply 80x24');
      assert.ok(!appliedNarrow.includes('AI 出题重点建议'));

      tty.resize(120, 36);
      const appliedWide = await tty.waitFor(
        (s) => s.includes('Raft 领导者选举') && s.includes('多选'),
        { label: 'zh [a] applied focus & kind visible in right panel at 120x36' },
      );
      tty.assertHealthyScreen(appliedWide, 120, 36, 'zh GenerateView after apply 120x36');
      assert.equal(modelCalls, 1, 'Applying suggestion must make 0 additional AI calls');
      assert.ok(appliedWide.includes('Raft 领导者选举'));
      assert.ok(appliedWide.includes('多选'));
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();
    }
  });

  test('10) PTY E2E (GenerateView [W]): weak topic indicator, [W] quick-fill & dedup, and [c] empty course (0 model calls)', async () => {
    const base = await temps.make('pty-weak-topics');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env,
      home: base,
      documentsDir: base,
      providerDiscovery: fakeDiscovery(),
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        throw new Error('Weak topics quick-fill must make 0 model calls');
      },
    });

    await seedLibraryWithWeakTopic(host, 'Algorithms');
    const emptyCourseRes = await host.call('course.save', { name: 'Empty Course' });
    assert.equal(emptyCourseRes.ok, true);
    await host.refreshSnapshot();

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;
      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'zh LibraryView ready',
      });

      // Open GenerateView ('3')
      tty.send('3');
      const genScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'generate' &&
          s.includes('新建出题任务') &&
          s.includes('薄弱点:') &&
          s.includes('Dynamic Programming') &&
          s.includes('[W 填入]'),
        { label: 'zh GenerateView weak topic indicator visible at 120x36' },
      );
      tty.assertHealthyScreen(genScreen, 120, 36, 'zh GenerateView 120x36');
      assert.equal(modelCalls, 0, 'Entering GenerateView and loading weakTopics must make 0 model calls');
      assert.ok(
        useTuiStore.getState().footerHints.some((h) => h.key === 'W' && h.label.includes('填薄弱点')),
        'Footer hints must advertise W when not editing text',
      );
      assert.ok(genScreen.includes('Dynamic Programming'));

      // Press 'W' -> fills focus field + shows success toast, 0 model calls
      useTuiStore.setState({ toasts: [] });
      tty.send('W');
      const filledScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('已填入 1 个薄弱知识点到出题重点')) &&
          !s.includes('（无，按材料自动规划重点）') &&
          s.includes('Dynamic Programming'),
        { label: 'zh [W] fills Dynamic Programming into focus field' },
      );
      tty.assertHealthyScreen(filledScreen, 120, 36, 'zh GenerateView after [W] 120x36');
      assert.equal(modelCalls, 0, '[W] quick-fill must make 0 model calls');
      assert.ok(!filledScreen.includes('（无，按材料自动规划重点）'));

      // Pressing 'W' again deduplicates cleanly and shows info toast
      useTuiStore.setState({ toasts: [] });
      tty.send('W');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.tone === 'info' && toast.text.includes('出题重点中')),
        { label: 'zh duplicate [W] press notifies info without duplicating' },
      );
      assert.equal(modelCalls, 0);

      // Cycle course via 'c' to Empty Course -> weak topics empty -> [W] shows info toast with 0 model calls
      for (let i = 0; i < 4 && !tty.readScreen().includes('Empty Course'); i += 1) {
        tty.send('c');
        await tty.flush(10);
      }
      const emptyCourseScreen = await tty.waitFor(
        (s) => s.includes('Empty Course') && !s.includes('[W 填入]'),
        { label: 'zh switched to Empty Course with no weak topics' },
      );
      assert.ok(emptyCourseScreen.includes('Empty Course'));
      assert.ok(!emptyCourseScreen.includes('[W 填入]'));

      useTuiStore.setState({ toasts: [] });
      tty.send('W');
      const emptyToastScreen = await tty.waitFor(
        () =>
          useTuiStore
            .getState()
            .toasts.some((toast) => toast.tone === 'info' && toast.text.includes('当前课程暂无薄弱知识点记录')),
        { label: 'zh [W] on course with no weak topics shows info toast' },
      );
      tty.assertHealthyScreen(emptyToastScreen, 120, 36, 'zh empty weak topics 120x36');
      assert.equal(modelCalls, 0, '[W] on empty course must make 0 model calls');
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();
    }
  });

  test('11) PTY E2E (GenerateView [/]): live material filter preserving multi-selection across Space, [a] toggle & Esc clear (0 calls)', async () => {
    const base = await temps.make('pty-src-filter');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot: join(base, 'library'),
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    const add1 = await host.call('source.add', {
      title: 'A1 操作系统内存管理讲义',
      text: '# Virtual Memory\nPage table walk and TLB hit/miss.',
      courses: ['CS301'],
      format: 'md',
    });
    assert.equal(add1.ok, true, add1.error?.message);

    const add2 = await host.call('source.add', {
      title: 'B2 分布式系统 Raft 共识笔记',
      text: '# Raft Consensus\nLeader election and log replication invariants.',
      courses: ['CS301'],
      format: 'md',
    });
    assert.equal(add2.ok, true, add2.error?.message);

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'zh LibraryView ready',
      });

      // Navigate to GenerateView ('3')
      tty.send('3');
      const genScreen = await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'generate' &&
          s.includes('新建出题任务') &&
          s.includes('A1 操作系统内存管理讲义') &&
          s.includes('B2 分布式系统 Raft 共识笔记'),
        { label: 'zh GenerateView ready with both sources' },
      );
      tty.assertHealthyScreen(genScreen, 120, 36, 'zh GenerateView initial');
      assert.equal(modelCalls, 0);

      // Select source 1 (A1) with Space -> ☑ on A1 and 1p in Panel badge
      tty.send(' ');
      const sel1Screen = await tty.waitFor((s) => s.includes('☑ [MD] A1') && s.includes('Space 勾选)  1p'), {
        label: 'zh source 1 selected',
      });
      assert.ok(sel1Screen.includes('☑ [MD] A1'));

      // Press '/' to open live material filter
      tty.send('/');
      const filterOpen = await tty.waitFor((s) => s.includes('[筛选 2/2]'), { label: 'zh filter bar opened' });
      assert.ok(filterOpen.includes('[筛选 2/2]'));

      // Type 'raft' to filter to source 2 (case-insensitive)
      tty.send('raft');
      const filteredTyping = await tty.waitFor(
        (s) =>
          s.includes('[筛选 1/2]') &&
          s.includes('B2 分布式系统 Raft 共识笔记') &&
          !s.includes('A1 操作系统内存管理讲义'),
        { label: 'zh filtered to source 2 while typing' },
      );
      tty.assertHealthyScreen(filteredTyping, 120, 36, 'zh GenerateView filter typing');
      assert.ok(!filteredTyping.includes('A1 操作系统内存管理讲义'));

      // Press Enter to confirm filter (keeps filter active, blurs input)
      tty.send('\r');
      const filterConfirmed = await tty.waitFor((s) => s.includes('[筛选 1/2]') && s.includes('/ 编辑 | Esc 清除'), {
        label: 'zh filter confirmed with Enter',
      });
      assert.ok(filterConfirmed.includes('/ 编辑 | Esc 清除'));

      // Press Space to select source 2 -> 2p selected (source 1 preserved!)
      tty.send(' ');
      const sel2Screen = await tty.waitFor(
        (s) => s.includes('Space 勾选)  2p') && s.includes('☑ [MD] B2'),
        { label: 'zh source 2 selected while source 1 preserved (2p)' },
      );
      assert.ok(sel2Screen.includes('Space 勾选)  2p'));

      // Verify `a` toggles only visible filtered item without dropping hidden source 1
      tty.send('a');
      const toggledOff = await tty.waitFor(
        (s) => s.includes('Space 勾选)  1p') && s.includes('☐ [MD] B2'),
        { label: 'zh [a] deselects visible source 2 without dropping hidden source 1' },
      );
      assert.ok(toggledOff.includes('☐ [MD] B2'));

      tty.send('a');
      const toggledOn = await tty.waitFor(
        (s) => s.includes('Space 勾选)  2p') && s.includes('☑ [MD] B2'),
        { label: 'zh [a] re-selects visible source 2 (2p)' },
      );
      assert.ok(toggledOn.includes('☑ [MD] B2'));

      // Press Esc to clear filter -> both sources visible and BOTH remain selected (2p, two ☑)
      tty.send('\x1b');
      const restored = await tty.waitFor(
        (s) =>
          !s.includes('[筛选') &&
          s.includes('Space 勾选)  2p') &&
          s.includes('☑ [MD] A1') &&
          s.includes('☑ [MD] B2'),
        { label: 'zh Esc cleared filter and preserved both selections' },
      );
      tty.assertHealthyScreen(restored, 120, 36, 'zh GenerateView after Esc clear');
      assert.ok(restored.includes('☑ [MD] A1'));
      assert.ok(restored.includes('☑ [MD] B2'));
      assert.equal(modelCalls, 0, 'Filtering and selecting materials must make 0 model calls');
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();
    }
  });

  test('12) PTY E2E (GeneratePathModal [P]): 0-sel toast, [j] step 2 local apply (0 calls), [g] P2 ConfirmDialog (n/y) & Enter apply', async () => {
    const base = await temps.make('pty-gen-path');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    process.env.DSH_HOME = env.DSH_HOME;
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

    const libraryRoot = join(base, 'library');
    await seedMultiPagePdfLibrary(libraryRoot, {
      course: '图论算法',
      docTitle: '图论与最短路径讲义',
      totalPages: 25,
    });

    let modelCalls = 0;
    const host = await createTuiHost({
      libraryRoot,
      env,
      home: base,
      documentsDir: base,
      skipAutoProbe: true,
      language: 'zh',
      injectedComplete: async () => {
        modelCalls += 1;
        return JSON.stringify({
          steps: [
            {
              id: 'step-1',
              title: '核心：最短路径与松弛性质',
              focus: '掌握 Dijkstra 贪心不变量与负权边反例',
              count: 15,
              reason: '优先掌握基础最优化结构',
            },
            {
              id: 'step-2',
              title: '进阶：全源最短路与传递闭包',
              focus: '对比 Floyd-Warshall 动态规划状态转移',
              count: 10,
              reason: '承接单源路径延伸',
            },
          ],
        });
      },
    });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(React.createElement(StudyHubTuiApp, { host, asciiMode: false }), {
        stdin: tty.stdin,
        stdout: tty.stdout,
        stderr: tty.stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      await tty.firstFramePromise;

      await tty.waitFor(() => useTuiStore.getState().page === 'library' && Boolean(useTuiStore.getState().snapshot), {
        label: 'zh LibraryView ready',
      });

      // Navigate to GenerateView ('3')
      tty.send('3');
      const genScreen = await tty.waitFor(
        (s) => useTuiStore.getState().page === 'generate' && s.includes('新建出题任务') && s.includes('graph-algorithms.pdf'),
        { label: 'zh GenerateView ready' },
      );
      tty.assertHealthyScreen(genScreen, 120, 36, 'zh GenerateView initial');
      assert.equal(modelCalls, 0, 'Entering GenerateView must make 0 AI calls');

      // Press 'P' with no source selected -> warning toast, 0 AI calls
      useTuiStore.setState({ toasts: [] });
      tty.send('P');
      await tty.waitFor(
        () => useTuiStore.getState().toasts.some((toast) => toast.tone === 'warning' && toast.text.includes('请至少选择一份资料')),
        { label: 'zh warning toast when pressing P without selection' },
      );
      assert.equal(modelCalls, 0);

      // Select the 25-page PDF source with Space
      tty.send(' ');
      await tty.waitFor((s) => s.includes('☑ [PDF] graph-algorithms.pdf') && s.includes('Space 勾选)  25p'), {
        label: 'zh 25-page source selected',
      });

      // Press 'P' -> GeneratePathModal opens with 0 model calls
      tty.send('P');
      const pathOpenScreen = await tty.waitFor(
        (s) => s.includes('分步出题路径规划') && s.includes('p.1-20') && s.includes('p.21-25'),
        { label: 'zh GeneratePathModal opened with 2 local steps' },
      );
      tty.assertHealthyScreen(pathOpenScreen, 120, 36, 'zh GeneratePathModal open 120x36');
      assert.equal(modelCalls, 0, 'Opening GeneratePathModal must make 0 AI calls');
      assert.ok(pathOpenScreen.includes('p.1-20'));
      assert.ok(pathOpenScreen.includes('p.21-25'));

      // Navigate to step 2 with 'j' and apply locally via Enter -> sets pageScope 21-25 with 0 AI calls
      tty.send('j');
      const step2Screen = await tty.waitFor((s) => s.includes('当前步骤: p.21-25'), {
        label: 'zh j navigates to step 2',
      });
      assert.ok(step2Screen.includes('当前步骤: p.21-25'));

      useTuiStore.setState({ toasts: [] });
      tty.send('\r');
      const localAppliedScreen = await tty.waitFor(
        (s) =>
          !s.includes('分步出题路径规划') &&
          s.includes('21-25') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('p.21-25')),
        { label: 'zh Enter applies step 2 locally (21-25)' },
      );
      tty.assertHealthyScreen(localAppliedScreen, 120, 36, 'zh GenerateView after local step 2 apply');
      assert.equal(modelCalls, 0, 'Local step apply must make 0 model calls');
      assert.ok(localAppliedScreen.includes('21-25'));

      // Reopen GeneratePathModal via 'P' -> test [g] P2 ConfirmDialog -> [n] cancel -> [g]+[y] AI refine -> [Enter] apply
      tty.send('P');
      await tty.waitFor((s) => s.includes('分步出题路径规划') && s.includes('p.1-20'), {
        label: 'zh GeneratePathModal reopened',
      });
      assert.equal(modelCalls, 0);

      tty.send('g');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('AI 优化分步出题路径') && s.includes('仅发送步骤标题与页数'),
        { label: 'zh P2 ConfirmDialog open after g' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'zh Path ConfirmDialog 120x36');
      assert.equal(modelCalls, 0, 'ConfirmDialog must make 0 AI calls before confirmation');

      // Cancel with 'n' -> still 0 model calls, modal stays open
      tty.send('n');
      const afterCancel = await tty.waitFor(
        (s) => s.includes('分步出题路径规划') && !s.includes('仅发送步骤标题与页数'),
        { label: 'zh ConfirmDialog cancelled with n' },
      );
      assert.equal(modelCalls, 0, 'Cancelling ConfirmDialog with n must keep AI calls at 0');
      assert.ok(!afterCancel.includes('仅发送步骤标题与页数'));

      // Press 'g' then 'y' -> invokes generate.path.suggest once and shows refined title + focus
      tty.send('g');
      await tty.waitFor((s) => s.includes('仅发送步骤标题与页数'), { label: 'zh ConfirmDialog reopened' });
      tty.send('y');

      const refinedScreen = await tty.waitFor(
        (s) =>
          !s.includes('仅发送步骤标题与页数') &&
          s.includes('核心：最短路径与松弛性质') &&
          s.includes('Dijkstra 贪心不变量'),
        { label: 'zh AI refined path rendered' },
      );
      tty.assertHealthyScreen(refinedScreen, 120, 36, 'zh refined path 120x36');
      assert.equal(modelCalls, 1, 'Confirming y must invoke AI exactly once');
      assert.ok(refinedScreen.includes('核心：最短路径与松弛性质'));

      // Press Enter -> applies step scope (1-20), target count (15), focus note, closes modal, shows toast
      useTuiStore.setState({ toasts: [] });
      tty.send('\r');
      const appliedScreen = await tty.waitFor(
        (s) =>
          !s.includes('分步出题路径规划') &&
          s.includes('1-20') &&
          s.includes('Dijkstra 贪心不变量') &&
          useTuiStore.getState().toasts.some((toast) => toast.tone === 'success' && toast.text.includes('p.1-20')),
        { label: 'zh Enter applied step scope, focus and toast' },
      );
      tty.assertHealthyScreen(appliedScreen, 120, 36, 'zh GenerateView after step apply');
      assert.equal(modelCalls, 1, 'Applying step via Enter must make 0 additional AI calls');
      assert.ok(appliedScreen.includes('1-20'));
      assert.ok(appliedScreen.includes('Dijkstra 贪心不变量'));
    } finally {
      inkInstance?.unmount();
      inkInstance = null;
      tty.dispose();
      await host.dispose();
    }
  });

  test('13) PTY E2E (DraftEditor [V] preflight): Drafts -> [V] -> [Esc] close -> [V] -> [r] refresh -> [p] confirm -> [n] cancel (0 calls)', async () => {
    const base = await temps.make('pty-draft-plan');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = env.DSH_HOME;
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

    let modelCalls = 0;
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    const srcRes = await host.call('source.add', {
      id: DRAFT_SOURCE_ID,
      title: 'CS101 Lecture Notes',
      courses: ['CS101'],
      text: `${DRAFT_SOURCE_QUOTE_1}\n\n${DRAFT_SOURCE_QUOTE_2}`,
    });
    assert.equal(srcRes.ok, true, srcRes.error?.message);

    const saved = await host.call('draft.save', {
      deck: makeValidDraftDeck('draft-r61-plan', 'Algorithms Preflight Draft'),
    });
    assert.equal(saved.ok, true, saved.error?.message);

    const snapBefore = await host.call('snapshot');
    assert.equal(snapBefore.ok, true, snapBefore.error?.message);
    const deckCountBefore = (snapBefore.value.decks ?? []).length;

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialPage: 'library',
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: false,
          onExit: () => inkInstance?.unmount(),
        }),
        {
          stdin: tty.stdin,
          stdout: tty.stdout,
          stderr: tty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await tty.firstFramePromise;

      await tty.waitFor(
        (s) =>
          useTuiStore.getState().page === 'library' &&
          Boolean(useTuiStore.getState().snapshot) &&
          (s.includes('学习库') || s.includes('Library')),
        {
          label: 'Initial Library view rendered with snapshot (zh)',
        },
      );

      // Navigate to GenerateView ('3') -> Drafts tab ('Tab')
      tty.send('3');
      await tty.waitFor((s) => s.includes('新建出题任务') && s.includes('草稿箱'), {
        label: 'GenerateView rendered via 3 (zh)',
      });

      tty.send('\t');
      const draftsScreen = await tty.waitFor(
        (s) =>
          s.includes('Algorithms Preflight Draft') &&
          s.includes('1. [简答]') &&
          s.includes('Why does binary search') &&
          s.includes('预检'),
        { label: 'DraftEditor loaded in Drafts tab (120x36 zh)' },
      );
      tty.assertHealthyScreen(draftsScreen, 120, 36, 'DraftEditor 120x36 zh');
      assert.equal(modelCalls, 0, 'opening Drafts tab must trigger 0 model calls');
      await tty.flush();

      // Press 'V' to open Publish Preflight modal, then Esc to close cleanly
      tty.send('V');
      const firstPlanScreen = await tty.waitFor(
        (s) =>
          s.includes('发布预检') &&
          s.includes('新建题组') &&
          s.includes('通过 (accepted): 2') &&
          s.includes('拦截 (rejected): 0') &&
          s.includes('新增 (added): 2'),
        { label: 'Publish Preflight modal displays receipt counts (120x36 zh)' },
      );
      tty.assertHealthyScreen(firstPlanScreen, 120, 36, 'PublishPreflightModal 120x36 zh');
      assert.equal(modelCalls, 0, 'pressing [V] must trigger 0 model calls');
      assert.ok(firstPlanScreen.includes('通过 (accepted): 2'));

      tty.send('\x1b');
      const escClosedScreen = await tty.waitFor(
        (s) => !s.includes('发布预检') && s.includes('Algorithms Preflight Draft'),
        { label: 'Publish Preflight modal closed via Esc (120x36 zh)' },
      );
      tty.assertHealthyScreen(escClosedScreen, 120, 36, 'DraftEditor after Esc close 120x36 zh');
      assert.equal(modelCalls, 0, 'closing preflight modal via Esc must trigger 0 model calls');
      assert.ok(!escClosedScreen.includes('发布预检'));

      // Reopen 'V' -> 'r' refresh -> 'p' publish-confirm -> 'n' cancel
      tty.send('V');
      await tty.waitFor(
        (s) => !s.includes('正在运行发布预检') && s.includes('发布预检') && s.includes('通过 (accepted): 2'),
        { label: 'Publish Preflight modal reopened' },
      );

      tty.send('r');
      await tty.flush(40);
      const refreshedScreen = await tty.waitFor(
        (s) =>
          !s.includes('正在运行发布预检') &&
          s.includes('发布预检') &&
          s.includes('通过 (accepted): 2') &&
          s.includes('发布后总计 (total): 2'),
        { label: 'Publish Preflight modal refreshed via [r] (120x36 zh)' },
      );
      tty.assertHealthyScreen(refreshedScreen, 120, 36, 'PublishPreflightModal refreshed 120x36 zh');
      assert.equal(modelCalls, 0, 'refreshing preflight with [r] must trigger 0 model calls');
      assert.ok(refreshedScreen.includes('发布后总计 (total): 2'));

      tty.send('p');
      const confirmScreen = await tty.waitFor(
        (s) => s.includes('发布草稿到题组') && s.includes('立即发布'),
        { label: 'Transitioned to publish-confirm dialog via [p] (120x36 zh)' },
      );
      tty.assertHealthyScreen(confirmScreen, 120, 36, 'PublishConfirmDialog 120x36 zh');
      assert.equal(modelCalls, 0, 'opening publish-confirm dialog must trigger 0 model calls');

      tty.send('n');
      const afterCancelScreen = await tty.waitFor(
        (s) => !s.includes('发布草稿到题组') && !s.includes('发布预检') && s.includes('Algorithms Preflight Draft'),
        { label: 'Cancelled publish-confirm cleanly with [n] (120x36 zh)' },
      );
      tty.assertHealthyScreen(afterCancelScreen, 120, 36, 'DraftEditor after cancel 120x36 zh');
      assert.equal(modelCalls, 0, 'cancelling confirm must trigger 0 model calls');
      assert.ok(!afterCancelScreen.includes('发布草稿到题组'));

      // Verify draft is still unpublished
      const snapAfter = await host.call('snapshot');
      assert.equal(snapAfter.ok, true, snapAfter.error?.message);
      assert.equal((snapAfter.value.decks ?? []).length, deckCountBefore, 'library decks count must remain unchanged');
      assert.ok((snapAfter.value.drafts ?? []).some((d) => d.id === 'draft-r61-plan'), 'draft must remain unpublished');
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount error during teardown
      }
      tty.dispose();
      await host.dispose();
    }
  });

  test('14) PTY E2E (DraftEditor [/] & [X]): sample -> Drafts -> [/] filter -> Enter -> [e] mapping -> [X] export -> Esc clear (0 calls)', async () => {
    const base = await temps.make('pty-draft-ux');
    const env = { DSH_HOME: join(base, 'dsh-home') };
    const libraryRoot = join(base, 'library');
    await mkdir(libraryRoot, { recursive: true });
    process.env.DSH_HOME = env.DSH_HOME;
    await saveTuiPreferences({ language: 'zh', asciiMode: false }, { env });
    resetTuiStore('zh', false);

    let modelCalls = 0;
    const host = await createTuiHost({
      env,
      home: join(base, 'home'),
      libraryRoot,
      skipAutoProbe: true,
      language: 'zh',
      eventDebounceMs: 30,
      injectedComplete: async () => {
        modelCalls += 1;
        return '{}';
      },
    });

    const tty = createVirtualTty(120, 36);
    let inkInstance = null;
    try {
      inkInstance = render(
        React.createElement(StudyHubTuiApp, {
          host,
          initialLanguage: 'zh',
          initialAsciiMode: false,
          autoLaunchpad: true,
          onExit: () => inkInstance?.unmount(),
        }),
        {
          stdin: tty.stdin,
          stdout: tty.stdout,
          stderr: tty.stderr,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      await tty.firstFramePromise;

      await tty.waitFor((s) => s.includes('载入示例课程体验') || s.includes('Load the sample course'), {
        timeoutMs: 10_000,
        label: 'Launchpad render (zh)',
      });

      // Load sample course
      tty.send('s');
      await tty.waitFor(
        (s) => !s.includes('载入示例课程体验') && s.includes('示例 · Memento 与 Bridge'),
        { timeoutMs: 12_000, label: 'Sample course loaded into Library (zh)' },
      );

      // Navigate to GenerateView ('3') -> Drafts tab ('Tab')
      tty.send('3');
      await tty.waitFor((s) => s.includes('新建出题任务') && s.includes('草稿箱'), {
        label: 'GenerateView rendered via 3 (zh)',
      });

      tty.send('\t');
      const draftsScreen = await tty.waitFor(
        (s) => s.includes('示例草稿 · 选对设计模式') && s.includes('3 题') && s.includes('筛选') && s.includes('导出MD'),
        { label: 'DraftEditor loaded in Drafts tab (120x36 zh)' },
      );
      tty.assertHealthyScreen(draftsScreen, 120, 36, 'DraftEditor initial 120x36 zh');
      assert.equal(modelCalls, 0);
      assert.ok(draftsScreen.includes('3 题'));

      // Press '/' to open live filter bar and filter to card #2 ('svg')
      tty.send('/');
      const filterOpenScreen = await tty.waitFor((s) => s.includes('[筛选 3/3]'), {
        label: 'Filter bar opened via / (zh)',
      });
      assert.ok(filterOpenScreen.includes('[筛选 3/3]'));

      tty.send('svg');
      const liveFilteredScreen = await tty.waitFor(
        (s) => s.includes('[筛选 1/3]') && s.includes('#2 单选') && s.includes('SVG'),
        { label: 'Live filter matched card #2 (zh)' },
      );
      tty.assertHealthyScreen(liveFilteredScreen, 120, 36, 'DraftEditor live filtering 120x36 zh');
      assert.ok(liveFilteredScreen.includes('#2 单选'));

      // Press Enter to confirm/blur keeping filter active
      tty.send('\r');
      const confirmedFilterScreen = await tty.waitFor(
        (s) => s.includes('[已筛选 1/3]') && s.includes('#2 单选'),
        { label: 'Filter confirmed via Enter (zh)' },
      );
      tty.assertHealthyScreen(confirmedFilterScreen, 120, 36, 'DraftEditor filter confirmed 120x36 zh');
      assert.ok(confirmedFilterScreen.includes('[已筛选 1/3]'));

      // Verify original index mapping on 'e' (should open Edit Card #2, not #1)
      tty.send('e');
      const editModalScreen = await tty.waitFor(
        (s) => s.includes('编辑第 2 题'),
        { label: 'Edit modal targets original card #2 while filtered (zh)' },
      );
      tty.assertHealthyScreen(editModalScreen, 120, 36, 'Edit Card #2 modal 120x36 zh');
      assert.ok(editModalScreen.includes('编辑第 2 题'));

      tty.send('\x1b');
      await tty.waitFor(
        (s) => !s.includes('编辑第 2 题') && s.includes('[已筛选 1/3]'),
        { label: 'Closed clean edit modal immediately back to filtered DraftEditor (zh)' },
      );

      // Round 77: dirty Esc in DraftEditor edit-card opens ConfirmDialog (n preserves, y discards)
      tty.send('e');
      await tty.waitFor((s) => s.includes('编辑第 2 题') && !s.includes('未保存'), {
        label: 'Edit modal reopened clean (zh)',
      });
      tty.send('UNSAVED_R77_DRAFT');
      await tty.waitFor((s) => s.includes('UNSAVED_R77_DRAFT') && s.includes('未保存'), {
        label: 'DraftEditor edit modal shows unsaved badge',
      });
      tty.send('\x1b');
      const discardDraftDialog = await tty.waitFor(
        (s) => s.includes('放弃未保存的题目修改'),
        { label: 'DraftEditor dirty Esc opened ConfirmDialog' },
      );
      tty.assertHealthyScreen(discardDraftDialog, 120, 36, 'DraftEditor discard ConfirmDialog');
      tty.send('n');
      await tty.waitFor(
        (s) => !s.includes('放弃未保存的题目修改') && s.includes('编辑第 2 题') && s.includes('UNSAVED_R77_DRAFT'),
        { label: 'DraftEditor discard cancel preserved unsaved edit' },
      );
      tty.send('\x1b');
      await tty.waitFor((s) => s.includes('放弃未保存的题目修改'), {
        label: 'DraftEditor discard ConfirmDialog reopened',
      });
      tty.send('y');
      await tty.waitFor(
        (s) => !s.includes('编辑第 2 题') && !s.includes('放弃未保存的题目修改') && s.includes('[已筛选 1/3]'),
        { label: 'DraftEditor discard confirm closed edit modal cleanly' },
      );

      // Press 'X' to export filtered cards atomically to Markdown
      const backupsDir = join(libraryRoot, 'backups');
      tty.send('X');
      const exportedScreen = await tty.waitFor(
        (s) => s.includes('已导出 1 道草稿题'),
        { label: 'Toast shown for [X] draft export (zh)' },
      );
      tty.assertHealthyScreen(exportedScreen, 120, 36, 'DraftEditor after [X] export 120x36 zh');
      assert.ok(exportedScreen.includes('已导出 1 道草稿题'));

      const draftExport = await findExportedBackupFile(backupsDir, 'studyhub-draft', 'md', todayLocalYmd());
      assert.ok(draftExport, `expected studyhub-draft-${todayLocalYmd()}-HHmmss.md in ${backupsDir}`);
      const md = await readFile(draftExport.path, 'utf8');
      assert.ok(md.includes('示例草稿 · 选对设计模式'), 'markdown should include draft title');
      assert.ok(md.includes('**题目数量**: 1'), 'markdown should export only the 1 filtered card');
      assert.ok(md.includes('SVG'), 'markdown should include filtered card prompt');
      assert.ok(!md.includes('绘图应用'), 'markdown must not include filtered-out cards');
      assert.ok(md.includes('<details>\n<summary>参考答案与解析 / Answer & Explanation</summary>'));
      assert.ok(md.includes('</details>'));

      // Press Esc in normal mode to clear active filter
      tty.send('\x1b');
      const clearedScreen = await tty.waitFor(
        (s) => !s.includes('[已筛选 1/3]') && s.includes('1. [单选]') && s.includes('3 题'),
        { label: 'Esc cleared active filter in normal mode (zh)' },
      );
      tty.assertHealthyScreen(clearedScreen, 120, 36, 'DraftEditor after Esc clear 120x36 zh');
      assert.ok(clearedScreen.includes('1. [单选]'));
      assert.equal(modelCalls, 0, 'entire filter + export flow must trigger 0 model calls');
    } finally {
      try {
        inkInstance?.unmount();
      } catch {
        // Ignore unmount error during teardown
      }
      tty.dispose();
      await host.dispose();
    }
  });
});
