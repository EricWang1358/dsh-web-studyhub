// Round 71 Track 1: Bit-exact equivalence & large-library NFR benchmarks for fuzzy.ts & source-helpers.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { fuzzyScore, fuzzyFilter } = await tsImport('../src/shell/fuzzy.ts', import.meta.url);
const { groupSourcesFromSnapshot, normalizeFolderName } = await tsImport(
  '../src/views/sources/source-helpers.ts',
  import.meta.url,
);

// --- Reference (pre-optimization) fuzzy implementation for 100% bit-exact differential testing ---
const REF_BOUNDARY = /[\s\-_/.:·|()[\]]/;
const REF_SURROGATE_RE = /[\uD800-\uDFFF]/;

function refPrepareQuery(query) {
  const joined = query.toLowerCase().trim();
  if (joined.length === 0) return null;
  const hasSurrogate = REF_SURROGATE_RE.test(joined);
  const chars = [];
  if (!hasSurrogate) {
    for (let i = 0; i < joined.length; i++) {
      const ch = joined[i];
      if (ch !== ' ') chars.push(ch);
    }
  } else {
    for (const ch of joined) {
      if (ch !== ' ') chars.push(ch);
    }
  }
  return { joined, chars, hasSurrogate };
}

function refScorePrepared(pq, text) {
  const chars = pq.chars;
  if (chars.length === 0) return { score: 0, positions: [] };
  if (text.length === 0) return null;
  const lower = text.toLowerCase();
  if (!pq.hasSurrogate && !REF_SURROGATE_RE.test(lower)) {
    const positions = new Array(chars.length);
    let score = 0;
    let ti = 0;
    let prev = -2;
    for (let i = 0; i < chars.length; i++) {
      const found = lower.indexOf(chars[i], ti);
      if (found < 0) return null;
      let s = 1;
      if (found === prev + 1) s += 4;
      if (found === 0 || REF_BOUNDARY.test(lower[found - 1])) s += 3;
      if (found === 0) s += 2;
      score += s;
      positions[i] = found;
      prev = found;
      ti = found + 1;
    }
    const idx = lower.indexOf(pq.joined);
    if (idx >= 0) score += 8 + (idx === 0 ? 6 : 0);
    score -= Math.min(10, Math.floor(lower.length / 12));
    return { score, positions };
  }
  const t = Array.from(lower);
  const positions = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let i = 0; i < chars.length; i++) {
    const qc = chars[i];
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === qc) {
        found = ti;
        break;
      }
      ti += 1;
    }
    if (found < 0) return null;
    let s = 1;
    if (found === prev + 1) s += 4;
    if (found === 0 || REF_BOUNDARY.test(t[found - 1] ?? '')) s += 3;
    if (found === 0) s += 2;
    score += s;
    positions.push(found);
    prev = found;
    ti = found + 1;
  }
  const idx = lower.indexOf(pq.joined);
  if (idx >= 0) score += 8 + (idx === 0 ? 6 : 0);
  score -= Math.min(10, Math.floor(t.length / 12));
  return { score, positions };
}

function refFuzzyScore(query, text) {
  const pq = refPrepareQuery(query);
  if (!pq) return { score: 0, positions: [] };
  return refScorePrepared(pq, text);
}

function refFuzzyFilter(items, query, getText, getKeywords, limit = 200) {
  const pq = refPrepareQuery(query);
  if (!pq) return items.slice(0, limit).map((item) => ({ item, score: 0, positions: [] }));
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const label = getText(item);
    let best = refScorePrepared(pq, label);
    if (!best && getKeywords) {
      const kws = getKeywords(item);
      if (kws) {
        for (let j = 0; j < kws.length; j++) {
          const r = refScorePrepared(pq, kws[j]);
          if (r && (!best || r.score - 2 > best.score)) {
            best = { score: r.score - 2, positions: [] };
          }
        }
      }
    }
    if (best) out.push({ item, score: best.score, positions: best.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return out.length > limit ? out.slice(0, limit) : out;
}

function medianMs(fn, runs = 15) {
  for (let w = 0; w < 3; w++) fn();
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
  const docCount = 400;
  const pagesPerDoc = 5;
  const sources = [];
  const docFormats = ['pdf', 'pptx', 'md'];
  for (let d = 0; d < docCount; d++) {
    const fmt = docFormats[d % docFormats.length];
    const course = `COURSE-${d % 8}`;
    const hashHex = String(d).padStart(64, 'a');
    for (let p = pagesPerDoc; p >= 1; p--) {
      const isEn = d % 2 === 0;
      const baseTitle = isEn
        ? `Lecture ${String(d).padStart(3, '0')} Virtual Memory`
        : `讲义 ${String(d).padStart(3, '0')} 虚拟内存与页表`;
      sources.push({
        id: `src-doc-${d}-p${p}`,
        title: `${baseTitle} · p.${p}`,
        course,
        courses: [course],
        chars: 1400 + p * 25,
        pinned: d < 4 && p === 1,
        archived: d >= 380,
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
  for (let h = 0; h < 20; h++) {
    sources.push({
      id: `src-hist-${h}`,
      title: `Superseded Lecture ${h}`,
      course: `COURSE-${h % 8}`,
      historical: true,
      chars: 900,
    });
  }
  sources.push({
    id: 'src-list-blueprint',
    title: 'Exam Blueprint',
    course: 'COURSE-0',
    provenance: 'exam-blueprint',
    blueprint: { points: [] },
  });

  const decks = [];
  const searchableCards = [];
  for (let dIdx = 0; dIdx < 250; dIdx++) {
    const cards = [];
    for (let cIdx = 0; cIdx < 20; cIdx++) {
      const g = dIdx * 20 + cIdx;
      const srcDocIdx = g % docCount;
      const isEn = g % 2 === 0;
      const prompt = isEn
        ? `Explain virtual memory page table lookup #${g}`
        : `解析虚拟内存与多级页表地址转换机制 #${g}`;
      const topic = isEn ? `Paging-${dIdx % 16}` : `页表机制-${dIdx % 16}`;
      cards.push({
        id: `card-${g}`,
        selections: [{ sourceId: `src-doc-${srcDocIdx}-p1` }],
        citations: [{ selection: { sourceId: `src-doc-${srcDocIdx}-p2` } }],
      });
      searchableCards.push({
        id: `card-${g}`,
        label: prompt,
        keywords: [`COURSE-${dIdx % 8}`, topic, isEn ? 'tlb' : '缺页中断', `deck-${dIdx}`],
      });
    }
    decks.push({ id: `deck-${dIdx}`, cards });
  }

  const snapshot = {
    sources,
    decks,
    drafts: [],
    documents: Array.from({ length: 10 }, (_, i) => ({
      id: `versioned-doc-${i}`,
      currentRevision: 2,
      versions: [
        { revision: 1, sourceIds: [`src-hist-${i}`] },
        { revision: 2, sourceIds: [`src-doc-${i}-p1`] },
      ],
    })),
    settings: {
      materialPins: ['doc:mat-md-2', 'doc:mat-pptx-1'],
      materialFolders: {
        folders: ['Module-0', 'Module-1'],
        items: { 'doc:mat-pptx-4': 'Module-1' },
      },
    },
  };

  return { snapshot, searchableCards, docCount };
}

describe('Round 71 Track 1: Bit-Exact Equivalence & Large-Library Scale NFR', () => {
  test('1. Bit-exact equivalence for fuzzyScore & fuzzyFilter across EN, CJK, mixed, boundaries, keywords, Unicode, and astral emoji', () => {
    const queries = [
      '',
      '   ',
      'v',
      'VMP',
      'virtual memory',
      'virtual memory page',
      '虚拟',
      '虚拟内存页表',
      '页表 p1',
      'lecture-01',
      '🚀',
      '🚀 vm',
      'vm 🚀',
      '👨‍👩‍👧‍👦',
      '👨‍👩‍👧‍👦 family',
      'i',
      'k',
      '12',
      'a'.repeat(300),
    ];

    const texts = [
      '',
      'Virtual Memory Page Table',
      'virtual memory page exact match',
      'Lecture 001 Virtual Memory · p.1',
      'foo/bar_baz:qux|item(1)[2]',
      '讲义 001 虚拟内存与页表 · p.1',
      '全角\u3000虚拟内存',
      'NBSP\u00A0memory',
      '🚀 virtual memory',
      'virtual 🚀 memory page',
      '👨‍👩‍👧‍👦 family tree & virtual memory',
      'İstanbul Kelvin Kelvin',
      '12345 numeric lookup',
      'prefix_' + 'a'.repeat(300) + '_suffix',
    ];

    for (const q of queries) {
      for (const t of texts) {
        assert.deepEqual(
          fuzzyScore(q, t),
          refFuzzyScore(q, t),
          `fuzzyScore mismatch for query=${JSON.stringify(q)} text=${JSON.stringify(t)}`,
        );
      }
    }

    const items = texts.map((label, idx) => ({
      id: `item-${idx}`,
      label,
      keywords: [
        idx % 2 === 0 ? 'kw-virtual-memory' : 'kw-虚拟内存',
        idx === 3 ? '🚀 rocket-kw' : 'tlb-hit',
        'Kelvin-kw',
      ],
    }));

    for (const q of queries) {
      for (const limit of [5, 200]) {
        const actual = fuzzyFilter(items, q, (x) => x.label, (x) => x.keywords, limit);
        const expected = refFuzzyFilter(items, q, (x) => x.label, (x) => x.keywords, limit);
        assert.deepEqual(
          actual,
          expected,
          `fuzzyFilter mismatch for query=${JSON.stringify(q)} limit=${limit}`,
        );
      }
    }
  });

  test('1b. Exact grouping, multi-source cardCount deduplication (1, 2, 3+ distinct sources), and folder normalization', () => {
    assert.equal(normalizeFolderName('  Module   One \t '), 'Module One');
    assert.equal(normalizeFolderName('Module-1'), 'Module-1');
    assert.equal(normalizeFolderName('   '), '');

    const snapshot = {
      sources: [
        {
          id: 's-pdf-2',
          title: 'Book · p.2',
          course: 'CS101',
          chars: 200,
          document: { id: 'a'.repeat(64), materialId: `document-${'a'.repeat(64)}-pdf`, format: 'pdf', page: 2, bookTitle: 'dir/Book.pdf' },
        },
        {
          id: 's-pdf-1',
          title: 'Book · p.1',
          courses: ['CS101', 'CS102'],
          chars: 100,
          pinned: true,
          document: { id: 'a'.repeat(64), materialId: `document-${'a'.repeat(64)}-pdf`, format: 'pdf', page: 1, bookTitle: 'dir/Book.pdf' },
        },
        {
          id: 's-pptx-1',
          title: 'Slides · p.1',
          course: 'CS101',
          archived: true,
          chars: 300,
          folder: '  Week  1 ',
          document: { materialId: 'slides-1', format: 'pptx', page: 1, filename: 'Slides.pptx' },
        },
        {
          id: 's-audio-2',
          title: 'Track (2/2)',
          chars: 50,
          audio: { batch: { id: 'b1', volume: 2, title: 'Audio Lecture' } },
        },
        {
          id: 's-audio-1',
          title: 'Track (1/2)',
          chars: 40,
          audio: { batch: { id: 'b1', volume: 1, title: 'Audio Lecture' } },
        },
      ],
      decks: [
        {
          id: 'd1',
          cards: [
            // References 3 distinct sources + duplicate s-pdf-1: each distinct source counted once
            {
              id: 'c1',
              selections: [{ sourceId: 's-pdf-1' }, { sourceId: 's-pdf-1' }, { sourceId: 's-pdf-2' }],
              citations: [{ selection: { sourceId: 's-pptx-1' } }, { sourceId: 's-pdf-2' }],
            },
            // References 1 source
            {
              id: 'c2',
              selections: [{ sourceId: 's-audio-1' }],
              citations: [],
            },
          ],
        },
      ],
      drafts: [
        {
          id: 'dr1',
          cards: [
            {
              id: 'c3',
              selections: [{ sourceId: 's-pdf-1' }],
              citations: [{ selection: { sourceId: 's-audio-2' } }],
            },
          ],
        },
      ],
      settings: {
        materialPins: ['doc:slides-1'],
      },
    };

    const groups = groupSourcesFromSnapshot(snapshot);
    assert.equal(groups.length, 3);
    // materialPins puts doc:slides-1 first, then pinned PDF, then audio
    assert.deepEqual(
      groups.map((g) => g.key),
      ['doc:slides-1', `pdf:${'a'.repeat(64)}`, 'audio:b1'],
    );
    assert.equal(groups[0].folder, 'Week 1');
    assert.equal(groups[0].archived, true);
    assert.equal(groups[0].cardCount, 1);

    assert.equal(groups[1].title, 'Book.pdf');
    assert.deepEqual(groups[1].sourceIds, ['s-pdf-1', 's-pdf-2']);
    assert.deepEqual(groups[1].courses, ['CS101', 'CS102']);
    assert.equal(groups[1].cardCount, 3); // c1 hits s-pdf-1 + s-pdf-2 (2), c3 hits s-pdf-1 (1)
    assert.equal(groups[1].chars, 300);

    assert.equal(groups[2].title, 'Audio Lecture');
    assert.deepEqual(groups[2].sourceIds, ['s-audio-1', 's-audio-2']);
    assert.equal(groups[2].cardCount, 2); // c2 hits s-audio-1 (1), c3 hits s-audio-2 (1)
  });

  test('2. Large-scale NFR proof: fuzzyFilter 5,000 items median < 15ms & groupSourcesFromSnapshot 2,000 sources median < 25ms', () => {
    const { snapshot, searchableCards, docCount } = buildLargeLibrary();

    const enMedian = medianMs(() =>
      fuzzyFilter(searchableCards, 'virtual memory page', (x) => x.label, (x) => x.keywords, 50),
    );
    const cjkMedian = medianMs(() =>
      fuzzyFilter(searchableCards, '虚拟内存页表', (x) => x.label, (x) => x.keywords, 50),
    );
    const groupMedian = medianMs(() => groupSourcesFromSnapshot(snapshot));

    console.log(
      `[round71-scale-perf] fuzzyFilter EN median=${enMedian.toFixed(3)}ms, CJK median=${cjkMedian.toFixed(3)}ms, groupSourcesFromSnapshot median=${groupMedian.toFixed(3)}ms`,
    );

    assert.ok(enMedian < 15, `fuzzyFilter EN median ${enMedian.toFixed(2)}ms exceeded 15ms`);
    assert.ok(cjkMedian < 15, `fuzzyFilter CJK median ${cjkMedian.toFixed(2)}ms exceeded 15ms`);
    assert.ok(groupMedian < 25, `groupSourcesFromSnapshot median ${groupMedian.toFixed(2)}ms exceeded 25ms`);

    const groups = groupSourcesFromSnapshot(snapshot);
    assert.equal(groups.length, docCount);
    const totalCardHits = groups.reduce((acc, g) => acc + g.cardCount, 0);
    assert.equal(totalCardHits, 10000);
  });
});
