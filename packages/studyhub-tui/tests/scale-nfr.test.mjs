// Large-Library 5,000-Card Scale Benchmark, Snapshot Fingerprint & NFR Budgets:
// `node --test tests/scale-nfr.test.mjs`
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';
import {
  assertPerfBudget,
  assertRelativePerf,
  cpuClock,
  createJitteredClock,
  wallClock,
} from './helpers/perf-gate.mjs';

const R = await tsImport('../src/render/index.ts', import.meta.url);
const { buildScopeChoices } = await tsImport('../src/views/exam/utils.ts', import.meta.url);
const { fuzzyFilter, fuzzyScore } = await tsImport('../src/shell/fuzzy.ts', import.meta.url);
const { groupSourcesFromSnapshot } = await tsImport('../src/views/sources/source-helpers.ts', import.meta.url);
const { computeSnapshotFingerprint } = await tsImport('../src/state/snapshot-fingerprint.ts', import.meta.url);

const SAMPLE_THEME = {
  id: 'dsh-dark',
  label: 'DSH Dark',
  dark: true,
  primary: '#4b6fff',
  accent: '#7da1de',
  success: '#38d39f',
  warning: '#f5b841',
  error: '#f06478',
  ai: '#a78bfa',
  info: '#7da1de',
  text: '#e6edf3',
  muted: '#8b949e',
  dim: '#565f6b',
  border: '#30363d',
  borderActive: '#4b6fff',
  bg: '#0d1117',
  surface: '#161b22',
  selectionBg: '#1f2a4d',
  selectionFg: '#ffffff',
  heading: '#9fb4ff',
  code: '#f5b841',
  codeBg: '#1c2230',
  link: '#7da1de',
  quote: '#8b949e',
  track: '#262c36',
  heat: ['#21262d', '#1d3b6e', '#2f56c4', '#4b6fff', '#9fb4ff'],
};

function buildLargeLibrary() {

  const courses = Array.from({ length: 8 }, (_, i) => ({
    id: `course-${i}`,
    name: `COURSE-${i}`,
    title: i % 2 === 0 ? `Systems Architecture ${i}` : `操作系统与体系结构 ${i}`,
    active: true,
    dueCount: 25 + i,
    deckCount: 31,
    cardCount: 625,
    masteredCount: 200,
    sourceCount: 250,
    updatedAt: 1700000000000 + i * 1000,
  }));

  // 400 multi-page documents (5 pages each = 2,000 active page-level sources)
  // Plus historical & library-list items that must be filtered out by groupSourcesFromSnapshot.
  const sources = [];
  const docCount = 400;
  const pagesPerDoc = 5;
  const docFormats = ['pdf', 'pptx', 'md'];

  for (let d = 0; d < docCount; d++) {
    const fmt = docFormats[d % docFormats.length];
    const course = `COURSE-${d % 8}`;
    const isArchived = d >= 380;
    const isPinned = d < 4;
    const hashHex = String(d).padStart(64, 'a');
    // Insert pages in reverse order to verify per-document page sorting.
    for (let p = pagesPerDoc; p >= 1; p--) {
      const id = `src-doc-${d}-p${p}`;
      const isEn = d % 2 === 0;
      const baseTitle = isEn
        ? `Lecture ${String(d).padStart(3, '0')} Virtual Memory`
        : `讲义 ${String(d).padStart(3, '0')} 虚拟内存与页表`;
      sources.push({
        id,
        title: `${baseTitle} · p.${p}`,
        course,
        courses: [course],
        chars: 1400 + p * 25,
        pinned: isPinned && p === 1,
        archived: isArchived,
        folder: d % 5 === 0 ? `Module-${d % 4}` : undefined,
        updatedAt: '2026-11-20T08:00:00Z',
        document:
          fmt === 'pdf'
            ? {
                id: hashHex,
                materialId: `document-${hashHex}-pdf`,
                format: 'pdf',
                page: p,
                bookTitle: baseTitle,
              }
            : fmt === 'pptx'
              ? {
                  materialId: `mat-${fmt}-${d}`,
                  format: fmt,
                  page: p,
                  filename: `${baseTitle}.${fmt}`,
                }
              : {
                  materialId: `mat-${fmt}-${d}`,
                  format: fmt,
                  filename: `${baseTitle}.${fmt}`,
                },
      });
    }
  }

  // Historical / superseded & library-list sources (must be excluded).
  for (let h = 0; h < 20; h++) {
    sources.push({
      id: `src-hist-${h}`,
      title: `Superseded Lecture ${h}`,
      course: `COURSE-${h % 8}`,
      historical: true,
      chars: 900,
    });
  }
  sources.push(
    {
      id: 'src-list-blueprint',
      title: 'Exam Blueprint',
      course: 'COURSE-0',
      provenance: 'exam-blueprint',
      blueprint: { points: [{ title: 'TLB' }] },
    },
    {
      id: 'src-list-outline',
      title: 'Course Outline',
      course: 'COURSE-1',
      provenance: 'course-outline',
      courseOutline: { version: 1, nodes: [] },
    },
  );

  const documentsMeta = Array.from({ length: 10 }, (_, i) => ({
    id: `versioned-doc-${i}`,
    currentRevision: 2,
    versions: [
      { revision: 1, sourceIds: [`src-hist-${i}`] },
      { revision: 2, sourceIds: [`src-doc-${i}-p1`] },
    ],
  }));

  // 250 decks * 20 cards = 5,000 cards
  const decks = [];
  const progress = {};
  const searchableCards = [];
  const deckCount = 250;
  const cardsPerDeck = 20;

  for (let dIdx = 0; dIdx < deckCount; dIdx++) {
    const deckId = `deck-${dIdx}`;
    const course = `COURSE-${dIdx % 8}`;
    const isCase = dIdx % 25 === 0; // 10 case-study decks
    const cards = [];
    for (let cIdx = 0; cIdx < cardsPerDeck; cIdx++) {
      const globalIdx = dIdx * cardsPerDeck + cIdx;
      const srcDocIdx = globalIdx % docCount;
      const page1 = `src-doc-${srcDocIdx}-p1`;
      const page2 = `src-doc-${srcDocIdx}-p2`;
      const isEn = globalIdx % 2 === 0;
      const prompt = isEn
        ? `Explain virtual memory page table lookup #${globalIdx}`
        : `解析虚拟内存与多级页表地址转换机制 #${globalIdx}`;
      const topic = isEn ? `Paging-${dIdx % 16}` : `页表机制-${dIdx % 16}`;
      cards.push({
        id: `card-${globalIdx}`,
        kind: isCase ? 'case' : cIdx % 3 === 0 ? 'quiz' : 'short',
        topic,
        prompt,
        front: prompt,
        back: `Detailed explanation for card ${globalIdx}`,
        selections: [{ sourceId: page1 }],
        citations: [{ selection: { sourceId: page2 } }],
      });
      searchableCards.push({
        id: `card-${globalIdx}`,
        label: prompt,
        keywords: [course, topic, isEn ? 'tlb' : '缺页中断', deckId],
      });
    }

    decks.push({
      id: deckId,
      title: dIdx % 2 === 0 ? `Deck ${dIdx}: OS Kernel` : `题组 ${dIdx}: 操作系统内核`,
      course,
      folder: `Folder-${dIdx % 5}`,
      count: cardsPerDeck,
      cardCount: cardsPerDeck,
      due: dIdx % 7,
      wrong: dIdx % 3,
      archived: false,
      format: isCase ? 'case-study' : undefined,
      caseMarks: isCase ? 40 : undefined,
      examCount: isCase ? 0 : 14,
      examQuizCount: isCase ? 0 : 10,
      examMultiCount: isCase ? 0 : 4,
      updatedAt: '2026-11-22T07:00:00Z',
      cards,
    });

    progress[deckId] = {
      mastery: (dIdx * 17) % 101,
      total: cardsPerDeck,
      due: dIdx % 7,
      counts: { new: 2, weak: 3, learning: 5, familiar: 5, mastered: 5 },
    };
  }

  // 200 notes
  const notes = Array.from({ length: 200 }, (_, nIdx) => ({
    id: `note-${nIdx}`,
    title: nIdx % 2 === 0 ? `Study Note ${nIdx}: TLB` : `学习笔记 ${nIdx}: 缺页处理`,
    course: `COURSE-${nIdx % 8}`,
    content: `Summary note ${nIdx} covering page replacement and cache coherence.`,
    updatedAt: '2026-11-21T12:00:00Z',
  }));

  const snapshot = {
    root: '/tmp/scale-nfr-library',
    revision: 100,
    fingerprint: 'scale-nfr-base',
    modelReady: true,
    focus: { course: '' },
    today: { due: 120, reviewed: 45, done: 45, streak: 12, goal: 100, new: 15 },
    courses,
    decks,
    progress,
    sources,
    documents: documentsMeta,
    notes,
    drafts: [],
    runs: [],
    jobs: [],
    settings: {
      materialPins: ['doc:mat-md-2', 'doc:mat-pptx-1'],
      materialFolders: {
        folders: ['Module-0', 'Module-1'],
        items: { 'doc:mat-pptx-4': 'Module-1' },
      },
    },
  };

  return { snapshot, searchableCards, docCount, pagesPerDoc };
}

const { snapshot, searchableCards, docCount, pagesPerDoc } = buildLargeLibrary();

describe('StudyHub TUI Large-Library Scale NFR Budgets (5,000 cards / 2,000 sources)', () => {
  test('0. Synthetic large library fixture (5,000 cards, 2,000 page sources, 200 notes) has exact structure and builds in < 200ms CPU', () => {
    assert.equal(snapshot.decks.length, 250);
    const totalCards = snapshot.decks.reduce((acc, d) => acc + d.cards.length, 0);
    assert.equal(totalCards, 5000);
    assert.equal(searchableCards.length, 5000);
    assert.equal(snapshot.notes.length, 200);
    assert.equal(snapshot.courses.length, 8);
    assert.equal(snapshot.documents.length, 10);
    assert.equal(snapshot.sources.length, docCount * pagesPerDoc + 20 + 2);
    assertPerfBudget('buildLargeLibrary fixture', buildLargeLibrary, 200, { warmup: 1, samples: 5 });
  });

  test('1. fuzzyFilter over 5,000 items (EN & CJK): median < 25ms CPU and accurate ranking', () => {
    const pool = searchableCards.slice();
    pool[3210] = {
      id: 'card-exact-en',
      label: 'virtual memory page table exact match',
      keywords: ['os'],
    };
    pool[4123] = {
      id: 'card-exact-cjk',
      label: '虚拟内存与页表精确匹配',
      keywords: ['os'],
    };

    const { lastValue: enHits } = assertPerfBudget(
      'fuzzyFilter EN (5,000 items)',
      () => fuzzyFilter(pool, 'virtual memory page', (x) => x.label, (x) => x.keywords, 50),
      25,
      { warmup: 3, samples: 9 },
    );
    assertPerfBudget(
      'fuzzyFilter CJK (5,000 items)',
      () => fuzzyFilter(pool, '虚拟内存页表', (x) => x.label, (x) => x.keywords, 50),
      25,
      { warmup: 3, samples: 9 },
    );

    assert.equal(enHits.length, 50);
    assert.equal(enHits[0].item.id, 'card-exact-en', 'exact prefix match must rank #1 for EN query');
    for (let i = 1; i < enHits.length; i++) {
      assert.ok(enHits[i - 1].score >= enHits[i].score, 'EN fuzzy results must be sorted descending by score');
    }

    const cjkHits = fuzzyFilter(pool, '虚拟内存与页表精确', (x) => x.label, (x) => x.keywords, 50);
    assert.ok(cjkHits.length >= 1);
    assert.equal(cjkHits[0].item.id, 'card-exact-cjk', 'exact prefix match must rank #1 for CJK query');
    for (let i = 1; i < cjkHits.length; i++) {
      assert.ok(cjkHits[i - 1].score >= cjkHits[i].score, 'CJK fuzzy results must be sorted descending by score');
    }

    // Seeded differential check (500 mixed ASCII/CJK/İ/K/emoji items): verify fuzzyFilter's
    // candidate ranking path matches fuzzyScore identically with and without keywords.
    const seedTokens = [
      'Virtual Memory',
      'Page_Table',
      '虚拟内存',
      '页表机制',
      'İstanbul',
      'Kelvin',
      '🚀TLB',
      'Cache/Hit',
      'OS-Kernel',
      '缺页中断',
      '👨‍👩‍👧‍👦Group',
      'sched.c',
    ];
    let prng = 0x51a7f319;
    const nextRand = () => {
      prng = (Math.imul(prng, 1664525) + 1013904223) >>> 0;
      return prng;
    };
    const diffItems = Array.from({ length: 500 }, (_, idx) => {
      const a = seedTokens[nextRand() % seedTokens.length];
      const b = seedTokens[nextRand() % seedTokens.length];
      const c = seedTokens[nextRand() % seedTokens.length];
      const kw1 = seedTokens[nextRand() % seedTokens.length];
      const kw2 = seedTokens[nextRand() % seedTokens.length];
      return {
        id: `diff-${idx}`,
        label: `${a} ${b} ${c} #${idx}`,
        keywords: [kw1, kw2, `tag-${idx % 17}`],
      };
    });
    const diffQueries = ['vmp', 'page', '虚拟内存', 'i', 'k', 'tlb', '🚀', 'os-k', '缺页'];
    for (const q of diffQueries) {
      // Without keywords: every result must match fuzzyScore(q, label) exactly.
      const noKwActual = fuzzyFilter(diffItems, q, (x) => x.label, undefined, diffItems.length);
      const noKwExpected = [];
      for (const item of diffItems) {
        const res = fuzzyScore(q, item.label);
        if (res) noKwExpected.push({ item, score: res.score, positions: res.positions });
      }
      noKwExpected.sort((a, b) => b.score - a.score);
      assert.deepEqual(noKwActual, noKwExpected, `fuzzyFilter (no keywords) diverged from fuzzyScore for "${q}"`);

      // With keywords: label match wins, else best keyword score - 2 with empty positions.
      const withKwActual = fuzzyFilter(diffItems, q, (x) => x.label, (x) => x.keywords, diffItems.length);
      const withKwExpected = [];
      for (const item of diffItems) {
        let best = fuzzyScore(q, item.label);
        if (!best) {
          for (const kw of item.keywords) {
            const r = fuzzyScore(q, kw);
            if (r && (!best || r.score - 2 > best.score)) {
              best = { score: r.score - 2, positions: [] };
            }
          }
        }
        if (best) withKwExpected.push({ item, score: best.score, positions: best.positions });
      }
      withKwExpected.sort((a, b) => b.score - a.score);
      assert.deepEqual(withKwActual, withKwExpected, `fuzzyFilter (with keywords) diverged from fuzzyScore for "${q}"`);
    }
  });

  test('2. groupSourcesFromSnapshot over 2,000 page sources (400 docs + historical/list): median < 40ms CPU & exact ordering', () => {
    const { lastValue: groups } = assertPerfBudget(
      'groupSourcesFromSnapshot (2,000 sources)',
      () => groupSourcesFromSnapshot(snapshot),
      40,
      { warmup: 3, samples: 9 },
    );

    assert.equal(groups.length, docCount, `expected exactly ${docCount} grouped documents`);

    for (const g of groups) {
      assert.ok(!g.key.includes('src-hist-'), `historical source leaked: ${g.key}`);
      assert.ok(!g.key.includes('src-list-'), `library-list source leaked: ${g.key}`);
      assert.equal(g.pageCount, pagesPerDoc, `expected ${pagesPerDoc} pages for ${g.key}`);
      for (let p = 0; p < g.pages.length; p++) {
        assert.equal(g.pages[p].page, p + 1, `pages must be sorted ascending for ${g.key}`);
      }
    }

    assert.equal(groups[0].key, 'doc:mat-md-2', 'materialPins[0] must be first');
    assert.equal(groups[1].key, 'doc:mat-pptx-1', 'materialPins[1] must be second');

    let seenArchived = false;
    let seenUnpinned = false;
    for (const g of groups) {
      if (!g.pinned) seenUnpinned = true;
      else assert.equal(seenUnpinned, false, 'pinned groups must precede unpinned groups');

      if (g.archived) seenArchived = true;
      else if (!g.pinned) assert.equal(seenArchived, false, 'active groups must precede archived groups');
    }

    const totalCardHits = groups.reduce((acc, g) => acc + g.cardCount, 0);
    assert.equal(totalCardHits, 10000, 'each of 5,000 cards references 2 distinct pages = 10,000 cardCount hits');
  });

  test('3. computeSnapshotFingerprint over 5,000-card / 250-deck / 2,000-source snapshot: median < 10ms CPU', () => {
    const { lastValue: fp1 } = assertPerfBudget(
      'computeSnapshotFingerprint (5k cards / 2k sources)',
      () => computeSnapshotFingerprint(snapshot),
      10,
      { warmup: 3, samples: 9, batch: 3 },
    );

    const fp2 = computeSnapshotFingerprint(snapshot);
    assert.equal(fp1, fp2);

    const prevDue = snapshot.decks[123].due;
    snapshot.decks[123].due = prevDue + 1;
    const fpMutated = computeSnapshotFingerprint(snapshot);
    snapshot.decks[123].due = prevDue;
    assert.notEqual(fpMutated, fp1, 'deck mutation must invalidate fingerprint');
  });

  test('4. buildScopeChoices (written, oral, case) over 250 decks: median < 15ms CPU', () => {
    const { lastValue: written } = assertPerfBudget(
      'buildScopeChoices(written)',
      () => buildScopeChoices(snapshot, 'written', 'zh'),
      15,
      { warmup: 3, samples: 9, batch: 5 },
    );
    const { lastValue: oral } = assertPerfBudget(
      'buildScopeChoices(oral)',
      () => buildScopeChoices(snapshot, 'oral', 'zh'),
      15,
      { warmup: 3, samples: 9, batch: 5 },
    );
    const { lastValue: caseChoices } = assertPerfBudget(
      'buildScopeChoices(case)',
      () => buildScopeChoices(snapshot, 'case', 'zh'),
      15,
      { warmup: 3, samples: 9, batch: 5 },
    );

    assert.equal(written.length, 241, 'written: 1 aggregate choice + 240 non-case decks');
    assert.equal(oral.length, 251, 'oral: 1 aggregate choice + 250 active decks');
    assert.equal(caseChoices.length, 10, 'case: 10 case-study decks');
  });

  test('5. renderMarkdown & wrapDisplay LRU cache hit speedup on repeated 200-line doc with LaTeX & code blocks', () => {
    const docLines = [];
    for (let i = 0; i < 40; i++) {
      docLines.push(`## Section ${i}: 页表与缓存一致性`);
      docLines.push(
        `Derivation: $\\lambda_${i} = \\frac{1}{\\mu + ${i}}$ and $$E[T_${i}] = \\sum_{k=1}^{n} p_k \\cdot t_k$$.`,
      );
      docLines.push('```ts');
      docLines.push(`export function lookup${i}(vpn: number): number { return (vpn >> 12) + ${i}; }`);
      docLines.push('```');
    }
    assert.equal(docLines.length, 200);
    const doc200 = docLines.join('\n');
    const mdOpts = { width: 80, theme: SAMPLE_THEME, mathUnicode: true };

    R.renderMarkdown('```ts\nconst x = 1;\n```', mdOpts);
    R.clearMarkdownCache();
    assert.equal(R.markdownCacheSize(), 0);

    const coldOut = R.renderMarkdown(doc200, mdOpts);
    assert.ok(coldOut.length > 0);
    assert.equal(R.markdownCacheSize(), 1);
    assert.equal(R.renderMarkdown(doc200, mdOpts), coldOut);
    assert.equal(R.markdownCacheSize(), 1, 'LRU cache hit must not grow cache size');

    assertRelativePerf(
      'renderMarkdown LRU cache hit vs cold render',
      () => {
        const hitOut = R.renderMarkdown(doc200, mdOpts);
        assert.equal(hitOut, coldOut);
        return hitOut;
      },
      () => R.renderMarkdown(doc200, mdOpts),
      {
        warmup: 1,
        samples: 5,
        fastBatch: 50,
        refBatch: 1,
        minSpeedup: 10,
        beforeFast: () => {
          if (R.markdownCacheSize() === 0) R.renderMarkdown(doc200, mdOpts);
        },
        beforeRef: () => {
          R.clearMarkdownCache();
        },
      },
    );

    const wrappedCold = R.wrapDisplay(doc200, 80);
    assert.ok(wrappedCold.length >= 200);
    for (const line of wrappedCold) {
      assert.ok(R.displayWidth(line) <= 80, `wrapDisplay line exceeded 80 cols: ${R.displayWidth(line)}`);
    }

    assertRelativePerf(
      'wrapDisplay sustained vs initial CPU stability',
      () => {
        const wrapped = R.wrapDisplay(doc200, 80);
        assert.equal(wrapped.length, wrappedCold.length);
        return wrapped;
      },
      () => R.wrapDisplay(doc200, 80),
      {
        warmup: 2,
        samples: 9,
        fastBatch: 3,
        refBatch: 3,
        fastBudgetMs: 15,
        maxRatio: 1.5,
      },
    );
  });
});

// --- O(K) Structural Snapshot Fingerprinting ---

function createBaseSnapshot() {
  return {
    root: '/tmp/studyhub-library',
    revision: 42,
    fingerprint: 'rev-42-base',
    modelReady: true,
    sample: { loaded: true },
    focus: { course: 'OS', mode: 'daily' },
    today: { due: 12, reviewed: 8, done: 8, streak: 5, goal: 20, new: 4 },
    inbox: {
      unread: 2,
      items: [
        { id: 'msg-1', read: false, at: '2026-11-22T07:00:00Z', prompt: 'Review overdue' },
        { id: 'msg-2', read: true, at: '2026-11-21T18:00:00Z', prompt: 'Deck published' },
      ],
    },
    courses: [
      { id: 'c-os', name: 'OS', title: 'Operating Systems', active: true, dueCount: 12, deckCount: 2, updatedAt: 1000 },
      { id: 'c-db', name: 'DB', title: 'Databases', active: false, dueCount: 3, deckCount: 1, updatedAt: 900 },
    ],
    decks: [
      {
        id: 'd-1',
        title: 'Virtual Memory',
        course: 'OS',
        folder: 'Core',
        count: 30,
        cardCount: 30,
        due: 7,
        wrong: 2,
        archived: false,
        flagged: 1,
        publishedAt: '2026-11-20T10:00:00Z',
        updatedAt: '2026-11-22T07:30:00Z',
        cards: [{ id: 'card-1', front: 'What is TLB?' }],
      },
      {
        id: 'd-2',
        title: 'Transactions',
        course: 'DB',
        folder: 'ACID',
        count: 20,
        cardCount: 20,
        due: 5,
        wrong: 1,
        archived: false,
        flagged: 0,
        publishedAt: '2026-11-19T10:00:00Z',
        updatedAt: '2026-11-21T12:00:00Z',
        cards: [{ id: 'card-2', front: 'Explain 2PL.' }],
      },
    ],
    progress: {
      'd-1': {
        mastery: 72,
        total: 30,
        due: 7,
        counts: { new: 3, weak: 2, learning: 5, familiar: 8, mastered: 12 },
      },
      'd-2': {
        mastery: 85,
        total: 20,
        due: 5,
        counts: { new: 1, weak: 1, learning: 2, familiar: 4, mastered: 12 },
      },
    },
    sources: [
      {
        id: 's-1',
        title: 'Lecture 04 Paging.pdf',
        archived: false,
        pinned: true,
        folder: 'Lectures',
        updatedAt: '2026-11-20T09:00:00Z',
        chars: 18500,
        courses: ['OS'],
      },
    ],
    drafts: [
      {
        id: 'draft-1',
        title: 'Page Replacement Draft',
        course: 'OS',
        status: 'ready',
        draftVersion: 3,
        editingDeckId: 'd-1',
        cards: [{ id: 'dc-1' }, { id: 'dc-2' }],
        updatedAt: '2026-11-22T06:00:00Z',
      },
    ],
    runs: [
      {
        id: 'run-1',
        mode: 'review',
        status: 'active',
        index: 4,
        total: 20,
        closedAt: null,
        submittedAt: null,
      },
    ],
    jobs: [
      {
        id: 'job-1',
        type: 'generate',
        status: 'running',
        progress: 0.45,
        updatedAt: '2026-11-22T07:55:00Z',
      },
    ],
    oralExams: [
      { id: 'oral-1', runId: 'run-oral-1', status: 'completed', updatedAt: '2026-11-21T20:00:00Z' },
    ],
    attempts: [
      { id: 'att-1', at: '2026-11-22T07:40:00Z', deckId: 'd-1', cardId: 'card-1' },
    ],
    settings: {
      practice: { roundSize: 20, newPerDay: 15, autoReveal: false },
      materialFolders: { folders: ['Lectures'], items: { 'source:s-1': 'Lectures' } },
      pinnedSources: ['s-1'],
    },
  };
}

describe('computeSnapshotFingerprint', () => {
  test('returns deterministic fingerprints for null, undefined, and identical deep-cloned snapshots', () => {
    assert.equal(computeSnapshotFingerprint(null), 'empty');
    assert.equal(computeSnapshotFingerprint(undefined), 'empty');

    const a = createBaseSnapshot();
    const b = structuredClone(a);
    const fpA = computeSnapshotFingerprint(a);
    const fpB = computeSnapshotFingerprint(b);

    assert.equal(typeof fpA, 'string');
    assert.ok(fpA.length > 0 && fpA !== 'empty');
    assert.equal(fpA, fpB);
  });

  test('detects single-field mutations across every tracked structural slice', () => {
    const base = createBaseSnapshot();
    const baseFp = computeSnapshotFingerprint(base);

    const mutations = [
      ['revision', (s) => { s.revision = 43; }],
      ['modelReady', (s) => { s.modelReady = false; }],
      ['sample.loaded', (s) => { s.sample.loaded = false; }],
      ['deck rename', (s) => { s.decks[0].title = 'Virtual Memory v2'; }],
      ['deck due change', (s) => { s.decks[0].due = 8; }],
      ['deck wrong change', (s) => { s.decks[0].wrong = 3; }],
      ['deck archived change', (s) => { s.decks[0].archived = true; }],
      ['deck flagged change', (s) => { s.decks[0].flagged = 2; }],
      ['deck folder change', (s) => { s.decks[0].folder = 'Archived'; }],
      ['progress mastery change', (s) => { s.progress['d-1'].mastery = 73; }],
      ['progress counts.weak change', (s) => { s.progress['d-1'].counts.weak = 4; }],
      ['source archive change', (s) => { s.sources[0].archived = true; }],
      ['source pin change', (s) => { s.sources[0].pinned = false; }],
      ['source folder change', (s) => { s.sources[0].folder = 'Slides'; }],
      ['source chars change', (s) => { s.sources[0].chars = 18501; }],
      ['source courses change', (s) => { s.sources[0].courses.push('CS'); }],
      ['course focus switch', (s) => { s.focus.course = 'DB'; }],
      ['focus mode switch', (s) => { s.focus.mode = 'exam'; }],
      ['course active switch', (s) => { s.courses[1].active = true; }],
      ['course dueCount change', (s) => { s.courses[0].dueCount = 13; }],
      ['draft version bump', (s) => { s.drafts[0].draftVersion = 4; }],
      ['draft cards length change', (s) => { s.drafts[0].cards.push({ id: 'dc-3' }); }],
      ['job status change', (s) => { s.jobs[0].status = 'completed'; }],
      ['job progress change', (s) => { s.jobs[0].progress = 0.8; }],
      ['inbox unread change (object)', (s) => { s.inbox.unread = 3; }],
      ['inbox unread change (array)', (s) => {
        s.inbox = [
          { id: 'msg-1', read: false, at: '2026-11-22T07:00:00Z' },
          { id: 'msg-2', read: false, at: '2026-11-21T18:00:00Z' },
        ];
      }],
      ['today due change', (s) => { s.today.due = 13; }],
      ['today reviewed change', (s) => { s.today.reviewed = 9; }],
      ['today done change', (s) => { s.today.done = 9; }],
      ['today streak change', (s) => { s.today.streak = 6; }],
      ['today goal change', (s) => { s.today.goal = 25; }],
      ['run status change', (s) => { s.runs[0].status = 'completed'; }],
      ['run index change', (s) => { s.runs[0].index = 5; }],
      ['run closedAt change', (s) => { s.runs[0].closedAt = '2026-11-22T08:00:00Z'; }],
      ['oralExam status change', (s) => { s.oralExams[0].status = 'grading'; }],
      ['attempt latest change', (s) => {
        s.attempts.push({ id: 'att-2', at: '2026-11-22T08:01:00Z', deckId: 'd-1', cardId: 'card-1' });
      }],
      ['settings practice change', (s) => { s.settings.practice.roundSize = 30; }],
      ['settings materialFolders change', (s) => {
        s.settings.materialFolders.items['source:s-1'] = 'Exams';
      }],
      ['settings pinnedSources change', (s) => { s.settings.pinnedSources.push('s-2'); }],
    ];

    for (const [label, mutate] of mutations) {
      const copy = structuredClone(base);
      mutate(copy);
      const nextFp = computeSnapshotFingerprint(copy);
      assert.notEqual(nextFp, baseFp, `expected mutation "${label}" to change fingerprint`);
    }

    const arrInboxBase = createBaseSnapshot();
    arrInboxBase.inbox = [{ id: 'm1', read: false, at: '2026-11-22T07:00:00Z' }];
    const arrInboxRead = structuredClone(arrInboxBase);
    arrInboxRead.inbox[0].read = true;
    assert.notEqual(
      computeSnapshotFingerprint(arrInboxBase),
      computeSnapshotFingerprint(arrInboxRead),
      'expected array-shaped inbox read toggle to change fingerprint',
    );
  });

  test('runs in < 5ms CPU median on a 5,000-card / 250-deck / 500-source snapshot and beats JSON.stringify', () => {
    const longFront = 'Explain virtual memory page table walk, TLB shootdown, and copy-on-write semantics. '.repeat(4);
    const longBack = 'Detailed solution with multi-level page tables, ASID tagging, and fault handling. '.repeat(5);

    const decks = Array.from({ length: 250 }, (_, dIdx) => ({
      id: `deck-${dIdx}`,
      title: `Deck ${dIdx}: Systems Module`,
      course: `COURSE-${dIdx % 8}`,
      folder: `Folder-${dIdx % 5}`,
      count: 20,
      cardCount: 20,
      due: dIdx % 7,
      wrong: dIdx % 3,
      archived: false,
      flagged: dIdx % 2,
      publishedAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-22T07:00:00Z',
      cards: Array.from({ length: 20 }, (_, cIdx) => ({
        id: `card-${dIdx}-${cIdx}`,
        front: `${longFront} [${dIdx}:${cIdx}]`,
        back: `${longBack} [${dIdx}:${cIdx}]`,
        explanation: longBack,
      })),
    }));

    const progress = {};
    for (let i = 0; i < decks.length; i++) {
      progress[decks[i].id] = {
        mastery: (i * 13) % 101,
        total: 20,
        due: i % 7,
        counts: { new: 2, weak: i % 3, learning: 4, familiar: 6, mastered: 8 },
      };
    }

    const sources = Array.from({ length: 500 }, (_, sIdx) => ({
      id: `source-${sIdx}`,
      title: `Source Material ${sIdx}.pdf`,
      archived: false,
      pinned: sIdx < 10,
      folder: `Folder-${sIdx % 6}`,
      updatedAt: '2026-11-20T00:00:00Z',
      chars: 25000 + sIdx,
      courses: [`COURSE-${sIdx % 8}`],
      text: longBack.repeat(8),
    }));

    const bigSnapshot = {
      ...createBaseSnapshot(),
      decks,
      progress,
      sources,
    };

    const { fast, ref } = assertRelativePerf(
      'computeSnapshotFingerprint vs JSON.stringify',
      () => {
        const fp = computeSnapshotFingerprint(bigSnapshot);
        assert.ok(fp.length > 0);
        return fp;
      },
      () => {
        const serialized = JSON.stringify(bigSnapshot);
        assert.ok(serialized.length > 1000);
        return serialized;
      },
      {
        warmup: 2,
        samples: 7,
        fastBatch: 2,
        refBatch: 1,
        fastBudgetMs: 5,
        minSpeedup: 3,
      },
    );
    assert.ok(fast.lastValue.length > 0);
    assert.ok(ref.lastValue.length > 1000);
  });

  test('flake-reproduction: wall-clock preemption spikes flake single-shot scale checks while CPU+relative gates stay green and catch regressions', () => {
    // (a) Reproduce CI high-load wall-clock preemption (+25ms stall): naive single-shot wall-clock check FLAKES.
    const jitteredWall = createJitteredClock([25], wallClock);
    assert.throws(
      () =>
        assertPerfBudget('naive wall-clock computeSnapshotFingerprint', () => computeSnapshotFingerprint(snapshot), 10, {
          warmup: 0,
          samples: 1,
          clock: jitteredWall,
        }),
      /exceeded budget < 10ms/,
      'single-shot wall-clock scale check must flake under injected 25ms preemption stall',
    );

    // (b) Hardened CPU-time + multi-sample median and paired relative gates STAY GREEN under the same jitter
    //     and under isolated outlier spikes (2 of 7 samples spiked +30ms / +45ms).
    assertPerfBudget('hardened CPU computeSnapshotFingerprint', () => computeSnapshotFingerprint(snapshot), 10, {
      warmup: 2,
      samples: 7,
      batch: 2,
      clock: cpuClock,
    });

    const spikedSampleClock = createJitteredClock([0, 30, 0, 45, 0, 0, 0], cpuClock);
    assertPerfBudget(
      'sampled median computeSnapshotFingerprint with outlier spikes',
      () => computeSnapshotFingerprint(snapshot),
      10,
      { warmup: 0, samples: 7, batch: 2, clock: spikedSampleClock },
    );

    assertRelativePerf(
      'hardened CPU fingerprint vs JSON.stringify',
      () => computeSnapshotFingerprint(snapshot),
      () => JSON.stringify(snapshot),
      {
        warmup: 1,
        samples: 5,
        fastBatch: 2,
        refBatch: 1,
        clock: cpuClock,
        fastBudgetMs: 10,
        minSpeedup: 3,
      },
    );

    // (c) Genuine slowdown regression: wrapping the real `computeSnapshotFingerprint` with an
    //     accidental full `JSON.stringify(snapshot)` still FAILS both the `< 10ms` CPU budget
    //     and the `>= 3x` relative speedup gate against `JSON.stringify`.
    const regressedFingerprint = () => {
      const structural = computeSnapshotFingerprint(snapshot);
      return `${structural}:${JSON.stringify(snapshot).length}`;
    };
    assert.throws(
      () =>
        assertPerfBudget('regressed fingerprint CPU budget', regressedFingerprint, 10, {
          warmup: 1,
          samples: 3,
          clock: cpuClock,
        }),
      /exceeded budget < 10ms/,
      'hardened CPU gate must fail when computeSnapshotFingerprint regresses to O(N) serialization',
    );
    assert.throws(
      () =>
        assertRelativePerf(
          'regressed fingerprint vs JSON.stringify',
          regressedFingerprint,
          () => JSON.stringify(snapshot),
          {
            warmup: 1,
            samples: 3,
            fastBatch: 1,
            refBatch: 1,
            clock: cpuClock,
            fastBudgetMs: 10,
            minSpeedup: 3,
          },
        ),
      /exceeded budget < 10ms|expected >=3x speedup/,
      'hardened relative gate must fail when computeSnapshotFingerprint regresses to O(N) serialization',
    );
  });
});
