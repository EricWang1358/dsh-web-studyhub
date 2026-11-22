// Large-Library 5,000-Card Scale Benchmark & NFR Budgets: `node --test tests/scale-nfr.test.mjs`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { tsImport } from 'tsx/esm/api';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');

const tempOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studyhub-scale-nfr-'));
const renderOutFile = path.join(tempOutDir, 'render.mjs');
const examUtilsOutFile = path.join(tempOutDir, 'exam-utils.mjs');

await build({
  entryPoints: {
    render: path.join(pkgRoot, 'src/render/index.ts'),
    'exam-utils': path.join(pkgRoot, 'src/views/exam/utils.ts'),
  },
  outdir: tempOutDir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
  absWorkingDir: pkgRoot,
});
fs.symlinkSync(path.join(pkgRoot, 'node_modules'), path.join(tempOutDir, 'node_modules'), 'junction');

const R = await import(pathToFileURL(renderOutFile).href);
const { buildScopeChoices } = await import(pathToFileURL(examUtilsOutFile).href);
const { fuzzyFilter } = await tsImport('../src/shell/fuzzy.ts', import.meta.url);
const { groupSourcesFromSnapshot } = await tsImport('../src/views/sources/source-helpers.ts', import.meta.url);
const { computeSnapshotFingerprint } = await tsImport('../src/state/snapshot-fingerprint.ts', import.meta.url);

after(() => {
  fs.rmSync(tempOutDir, { recursive: true, force: true });
});

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

function medianMs(fn, runs = 15) {
  fn(); // warm JIT
  const timings = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    timings.push(performance.now() - t0);
  }
  timings.sort((a, b) => a - b);
  return timings[Math.floor(timings.length / 2)];
}

function buildLargeLibrary() {
  const t0 = performance.now();

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

  const buildMs = performance.now() - t0;
  return { snapshot, searchableCards, buildMs, docCount, pagesPerDoc };
}

const { snapshot, searchableCards, buildMs, docCount, pagesPerDoc } = buildLargeLibrary();

describe('StudyHub TUI Large-Library Scale NFR Budgets (5,000 cards / 2,000 sources)', () => {
  test('0. Synthetic large library fixture (5,000 cards, 2,000 page sources, 200 notes) builds in < 200ms', () => {
    assert.equal(snapshot.decks.length, 250);
    const totalCards = snapshot.decks.reduce((acc, d) => acc + d.cards.length, 0);
    assert.equal(totalCards, 5000);
    assert.equal(searchableCards.length, 5000);
    assert.equal(snapshot.notes.length, 200);
    assert.ok(snapshot.sources.length >= 2000);
    assert.ok(buildMs < 200, `synthetic library build took ${buildMs.toFixed(2)}ms (budget < 200ms)`);
  });

  test('1. fuzzyFilter over 5,000 items (EN & CJK): median < 25ms and accurate ranking', () => {
    // Inject exact-prefix targets to assert ranking accuracy
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

    const enMedian = medianMs(() =>
      fuzzyFilter(pool, 'virtual memory page', (x) => x.label, (x) => x.keywords, 50),
    );
    const cjkMedian = medianMs(() =>
      fuzzyFilter(pool, '虚拟内存页表', (x) => x.label, (x) => x.keywords, 50),
    );

    assert.ok(enMedian < 25, `fuzzyFilter EN median ${enMedian.toFixed(2)}ms exceeded 25ms`);
    assert.ok(cjkMedian < 25, `fuzzyFilter CJK median ${cjkMedian.toFixed(2)}ms exceeded 25ms`);

    const enHits = fuzzyFilter(pool, 'virtual memory page', (x) => x.label, (x) => x.keywords, 50);
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
  });

  test('2. groupSourcesFromSnapshot over 2,000 page sources (400 docs + historical/list): median < 40ms & exact ordering', () => {
    const median = medianMs(() => groupSourcesFromSnapshot(snapshot));
    assert.ok(median < 40, `groupSourcesFromSnapshot median ${median.toFixed(2)}ms exceeded 40ms`);

    const groups = groupSourcesFromSnapshot(snapshot);
    assert.equal(groups.length, docCount, `expected exactly ${docCount} grouped documents`);

    // Verify historical and library-list items were excluded
    for (const g of groups) {
      assert.ok(!g.key.includes('src-hist-'), `historical source leaked: ${g.key}`);
      assert.ok(!g.key.includes('src-list-'), `library-list source leaked: ${g.key}`);
      assert.equal(g.pageCount, pagesPerDoc, `expected ${pagesPerDoc} pages for ${g.key}`);
      for (let p = 0; p < g.pages.length; p++) {
        assert.equal(g.pages[p].page, p + 1, `pages must be sorted ascending for ${g.key}`);
      }
    }

    // Verify pin order -> pinned flag -> active -> archived ordering
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

    // Verify buildCardCountIndex aggregated card references onto pages
    const totalCardHits = groups.reduce((acc, g) => acc + g.cardCount, 0);
    assert.equal(totalCardHits, 10000, 'each of 5,000 cards references 2 distinct pages = 10,000 cardCount hits');
  });

  test('3. computeSnapshotFingerprint over 5,000-card / 250-deck / 2,000-source snapshot: median < 10ms', () => {
    const median = medianMs(() => computeSnapshotFingerprint(snapshot));
    assert.ok(median < 10, `computeSnapshotFingerprint median ${median.toFixed(2)}ms exceeded 10ms`);

    const fp1 = computeSnapshotFingerprint(snapshot);
    const fp2 = computeSnapshotFingerprint(snapshot);
    assert.equal(fp1, fp2);

    const prevDue = snapshot.decks[123].due;
    snapshot.decks[123].due = prevDue + 1;
    const fpMutated = computeSnapshotFingerprint(snapshot);
    snapshot.decks[123].due = prevDue;
    assert.notEqual(fpMutated, fp1, 'deck mutation must invalidate fingerprint');
  });

  test('4. buildScopeChoices (written, oral, case) over 250 decks: median < 15ms', () => {
    const writtenMedian = medianMs(() => buildScopeChoices(snapshot, 'written', 'zh'));
    const oralMedian = medianMs(() => buildScopeChoices(snapshot, 'oral', 'zh'));
    const caseMedian = medianMs(() => buildScopeChoices(snapshot, 'case', 'zh'));

    assert.ok(writtenMedian < 15, `buildScopeChoices(written) median ${writtenMedian.toFixed(2)}ms exceeded 15ms`);
    assert.ok(oralMedian < 15, `buildScopeChoices(oral) median ${oralMedian.toFixed(2)}ms exceeded 15ms`);
    assert.ok(caseMedian < 15, `buildScopeChoices(case) median ${caseMedian.toFixed(2)}ms exceeded 15ms`);

    const written = buildScopeChoices(snapshot, 'written', 'zh');
    const oral = buildScopeChoices(snapshot, 'oral', 'zh');
    const caseChoices = buildScopeChoices(snapshot, 'case', 'zh');

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

    // Warm up lazy highlighter once so cold render measures markdown+LaTeX+highlight lex/render, not module load.
    R.renderMarkdown('```ts\nconst x = 1;\n```', { width: 80, theme: SAMPLE_THEME, mathUnicode: true });
    R.clearMarkdownCache();
    assert.equal(R.markdownCacheSize(), 0);

    const tCold0 = performance.now();
    const coldOut = R.renderMarkdown(doc200, { width: 80, theme: SAMPLE_THEME, mathUnicode: true });
    const coldMs = performance.now() - tCold0;

    assert.ok(coldOut.length > 0);
    assert.equal(R.markdownCacheSize(), 1);

    const hitRepeats = 50;
    const tWarm0 = performance.now();
    for (let i = 0; i < hitRepeats; i++) {
      const hitOut = R.renderMarkdown(doc200, { width: 80, theme: SAMPLE_THEME, mathUnicode: true });
      assert.equal(hitOut, coldOut);
    }
    const warmAvgMs = (performance.now() - tWarm0) / hitRepeats;

    assert.ok(
      warmAvgMs * 10 < coldMs,
      `expected >=10x LRU cache speedup for renderMarkdown (cold=${coldMs.toFixed(3)}ms, warmAvg=${warmAvgMs.toFixed(4)}ms)`,
    );

    // Verify wrapDisplay width invariant and warm graphemeWidth cache speedup on the 200-line doc
    const tWrapCold0 = performance.now();
    const wrappedCold = R.wrapDisplay(doc200, 80);
    const wrapColdMs = performance.now() - tWrapCold0;
    assert.ok(wrappedCold.length >= 200);
    for (const line of wrappedCold) {
      assert.ok(R.displayWidth(line) <= 80, `wrapDisplay line exceeded 80 cols: ${R.displayWidth(line)}`);
    }

    const tWrapWarm0 = performance.now();
    for (let i = 0; i < 20; i++) {
      const wrappedWarm = R.wrapDisplay(doc200, 80);
      assert.equal(wrappedWarm.length, wrappedCold.length);
    }
    const wrapWarmAvgMs = (performance.now() - tWrapWarm0) / 20;
    assert.ok(wrapWarmAvgMs < 15, `wrapDisplay warm avg ${wrapWarmAvgMs.toFixed(2)}ms exceeded 15ms`);
    assert.ok(
      wrapWarmAvgMs <= wrapColdMs * 1.5,
      `wrapDisplay warm (${wrapWarmAvgMs.toFixed(2)}ms) regressed vs cold (${wrapColdMs.toFixed(2)}ms)`,
    );
  });
});
