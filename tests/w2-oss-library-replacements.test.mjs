/* Wave 2 OSS library replacements & hardening unit tests:
   1. ts-fsrs in lib/sm2.js (fuzz control, same-day difficulty isolation, local days)
   2. temml in lib/companion-template/mathml.js (XML MathML, trust:false, error fallback, currency & dedup)
   3. jsonrepair in lib/generation.js (tier-2 fallback after repairTexEscapes: truncated/trailing-comma/unescaped quotes)
   4. minisearch + Intl.Segmenter('zh') in lib/contexts/materials/retrieval-lexical.js (CJK, pre-filters, incremental sync, highlights)
   5. approx-string-match in lib/quote-locate.js (<=10% edit rate, context disambiguation, UTF-16 alignment)
   6. zustand in ui/app/store.js + ui/app/app-context.js (slice isolation & backward-compatible useApp facade)
   7. @atlaskit/pragmatic-drag-and-drop in ui/Board.jsx + ui/board/Card.jsx (no dragover reflow loop, drag handle, a11y fallbacks)
   8. lib/runtime/schema.js hardening (circular schema guard, nesting depth guard, Object.hasOwn required check) */

import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { schedule, initialReview, previewSchedule, checkSettings } from '../lib/sm2.js';
import { renderTexToMathMl, compileMathInLesson } from '../lib/companion-template/mathml.js';
import { parseJson } from '../lib/generation.js';
import { createLexicalIndex, tokenizeLexical, extractHighlightSnippet } from '../lib/contexts/materials/retrieval-lexical.js';
import { createLocator, locateQuote, locateQuoteDetailed } from '../lib/quote-locate.js';
import { resolveQuote } from '../ui/document-preview/selection.js';
import { schemaProblems, validate } from '../lib/runtime/schema.js';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const uiMod = await loadUi(`
  export { AppContext, AppStoreContext, AppStoreProvider, createAppStore, syncAppStore, useApp, useAppSelector, useAppSlice } from './ui/app/app-context.js';
  export { default as Board } from './ui/Board.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

/* ---------- 1. ts-fsrs (lib/sm2.js) ---------- */

test('1. ts-fsrs scheduler: previewSchedule fixes enable_fuzz=false, schedule supports explicit fuzz & isolate_same_day prevents difficulty drift', () => {
  // previewSchedule must remain 100% deterministic even when caller passes enable_fuzz: true.
  const detA = previewSchedule({ request_retention: 0.9, maximum_interval: 36500, enable_fuzz: true }, { grade: 4, reviews: 5 });
  const detB = previewSchedule({ request_retention: 0.9, maximum_interval: 36500, enable_fuzz: false }, { grade: 4, reviews: 5 });
  assert.deepEqual(detA, detB);
  assert.deepEqual(detA.map(p => p.interval), [3, 14, 57, 196, 586]);

  // Explicit enable_fuzz: true on schedule runs ts-fsrs fuzzing within valid bounds (and checkSettings validates boolean flags).
  assert.throws(() => checkSettings({ enable_fuzz: 'yes' }), /enable_fuzz/);
  assert.throws(() => checkSettings({ isolate_same_day: 1 }), /isolate_same_day/);
  let mature = initialReview();
  let t = Date.parse('2026-01-01T09:00:00.000Z');
  for (let i = 0; i < 3; i++) {
    mature = schedule(mature, 4, new Date(t).toISOString());
    t = Date.parse(mature.due_at);
  }
  const fuzzed = schedule(mature, 4, new Date(t).toISOString(), { enable_fuzz: true });
  assert.ok(Number.isInteger(fuzzed.interval_days) && fuzzed.interval_days >= 1);

  // Explicit same-day isolation (elapsed === 0) freezes difficulty across repeated same-day answers.
  const first = schedule(initialReview(), 4, '2026-06-01T08:00:00.000Z', { isolate_same_day: true });
  let cur = first;
  for (const [hour, grade] of [[9, 3], [10, 5], [11, 3], [12, 4]]) {
    cur = schedule(cur, grade, `2026-06-01T${String(hour).padStart(2, '0')}:00:00.000Z`, { isolate_same_day: true });
    assert.equal(cur.elapsed_days, 0);
    assert.equal(cur.difficulty, first.difficulty, 'same-day repeat must not drift difficulty when isolate_same_day is enabled');
    assert.equal(cur.stability, first.stability);
  }
});

/* ---------- 2. temml (lib/companion-template/mathml.js) ---------- */

test('2. temml MathML compiler: well-formed XML output, trust:false safety, graceful fallback & _math dedup', () => {
  const mml = renderTexToMathMl('\\frac{a+b}{c} + \\sqrt[3]{x^2}', true);
  assert.ok(mml.startsWith('<math xmlns="http://www.w3.org/1998/Math/MathML"'));
  assert.ok(mml.endsWith('</math>'));
  assert.match(mml, /display="block"/);
  assert.match(mml, /<mfrac>/);
  assert.match(mml, /<mroot>/);

  // trust: false must never emit javascript: href attributes.
  const untrusted = renderTexToMathMl('\\href{javascript:alert(1)}{click}', false);
  assert.ok(untrusted.startsWith('<math') && untrusted.endsWith('</math>'));
  assert.ok(!untrusted.includes('javascript:alert'), 'trust:false must block javascript: hrefs');

  // ParseError falls back cleanly to <math><mtext>...</mtext></math> (never raw <span class="temml-error">).
  const broken = renderTexToMathMl('a & b \\left(', false);
  assert.ok(broken.startsWith('<math') && broken.endsWith('</math>'));
  assert.ok(!broken.includes('temml-error'));
  assert.ok(broken.includes('&amp;'));

  // Currency avoidance + _math deduplication preserved.
  const compiled = compileMathInLesson({
    title: 'Cost $50 vs $x^2$ and again $x^2$',
    slides: [{ beat: 'open', title: 'S1', blocks: [{ t: 'text', md: 'Pay $100 for $$\\int_0^1 x\\,dx$$', expr: '$x^2$' }] }],
  });
  assert.match(compiled.title, /\$50/);
  assert.equal(compiled._math.length, 2, 'duplicate inline $x^2$ is interned once');
  assert.equal(compiled.slides[0].blocks[0].expr, '$x^2$', 'RAW_SOURCE_KEYS expr stays untouched');
});

/* ---------- 3. jsonrepair (lib/generation.js) ---------- */

test('3. jsonrepair tier-2 fallback: rescues trailing commas, unescaped quotes, truncated JSON while preserving LaTeX & rejecting bad escapes', () => {
  // Trailing commas in objects and arrays.
  assert.deepEqual(parseJson('{"title": "Algorithms", "cards": [{"id": "q1", "score": 1,},],}'), {
    title: 'Algorithms',
    cards: [{ id: 'q1', score: 1 }],
  });

  // Unescaped interior double quotes inside string values.
  assert.deepEqual(parseJson('{"prompt": "Explain the "Single Responsibility" principle"}'), {
    prompt: 'Explain the "Single Responsibility" principle',
  });

  // Truncated JSON container rescued cleanly when explicitly allowed.
  assert.deepEqual(parseJson('{"title": "Deck", "cards": [{"id": "q1", "prompt": "What is O(n)?"', { allowTruncated: true }), {
    title: 'Deck',
    cards: [{ id: 'q1', prompt: 'What is O(n)?' }],
  });

  // Tier-1 repairTexEscapes runs BEFORE tier-2 jsonrepair, so valid LaTeX survives even with trailing commas!
  const latexWithComma = String.raw`{"prompt": "Compute $\alpha + \frac{1}{2}$ and $\ce{H2O}$",}`;
  assert.deepEqual(parseJson(latexWithComma), {
    prompt: String.raw`Compute $\alpha + \frac{1}{2}$ and $\ce{H2O}$`,
  });

  // Non-JSON prose, dangling-colon stubs, and illegal non-TeX escapes still throw SyntaxError.
  for (const invalid of ['Sorry, I cannot comply.', '{"issues":', String.raw`{"a":"bad\qescape"}`]) {
    assert.throws(() => parseJson(invalid), SyntaxError, invalid);
  }
});

/* ---------- 4. minisearch + Intl.Segmenter (lib/contexts/materials/retrieval-lexical.js) ---------- */

test('4. minisearch lexical retrieval: CJK word segmentation, course/sourceIds pre-filtering, incremental sync & highlight snippets', () => {
  const tokens = tokenizeLexical('分布式系统的 Raft 共识算法与 B-tree 索引');
  assert.ok(tokens.includes('分布式') || tokens.includes('分布'));
  assert.ok(tokens.includes('raft'));
  assert.ok(tokens.includes('tree'));

  const index = createLexicalIndex();
  const initial = index.upsertMany([
    {
      id: 's1-p1',
      sourceId: 's1',
      course: 'Distributed Systems',
      page: 1,
      title: 'Raft 共识协议',
      text: '在分布式系统中，Raft 通过领导者选举和日志复制保证强一致性与高可用性。',
    },
    {
      id: 's2-p1',
      sourceId: 's2',
      course: 'Database Internals',
      page: 4,
      title: 'B+ 树与 LSM-Tree',
      text: '数据库引擎使用 B+ 树保持键有序，同时写多读少场景常用 LSM-Tree 顺序追加写日志。',
    },
    {
      id: 's3-p2',
      sourceId: 's3',
      course: 'Distributed Systems',
      page: 2,
      title: 'Paxos 对比',
      text: '与 Paxos 相比，Raft 协议把共识拆解为选主、日志复制和安全性三个独立子问题。',
    },
  ]);
  assert.deepEqual(initial, { added: 3, updated: 0, unchanged: 0 });
  assert.equal(index.size, 3);

  // Chinese lexical query + highlight snippet.
  const hits = index.search('Raft 日志复制');
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].course, 'Distributed Systems');
  assert.ok(hits[0].highlights.length > 0);
  assert.match(hits[0].highlighted, /<mark>.*<\/mark>/);

  // Native pre-filtering by course and sourceIds.
  const dbOnly = index.search('日志', { course: 'Database Internals' });
  assert.equal(dbOnly.length, 1);
  assert.equal(dbOnly[0].sourceId, 's2');

  const scoped = index.search('Raft', { sourceIds: ['s3'] });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].sourceId, 's3');

  assert.deepEqual(index.search('Raft', { sourceIds: [] }), []);

  // Incremental syncSources: update s1, remove s2, keep s3 unchanged, add s4.
  const sync = index.syncSources([
    {
      id: 's1-p1',
      sourceId: 's1',
      course: 'Distributed Systems',
      page: 1,
      title: 'Raft 共识协议（修订）',
      text: '新增快照压缩机制防止日志无限增长。',
    },
    {
      id: 's3-p2',
      sourceId: 's3',
      course: 'Distributed Systems',
      page: 2,
      title: 'Paxos 对比',
      text: '与 Paxos 相比，Raft 协议把共识拆解为选主、日志复制和安全性三个独立子问题。',
    },
    {
      id: 's4-p1',
      sourceId: 's4',
      course: 'Operating Systems',
      page: 1,
      title: '虚拟内存分页',
      text: '多级页表配合 TLB 快表加速虚实地址转换。',
    },
  ]);
  assert.deepEqual(sync, { added: 1, updated: 1, removed: 1, total: 3 });
  assert.equal(index.has('s2-p1'), false);
  assert.equal(index.search('快照压缩')[0]?.id, 's1-p1');
  assert.equal(index.search('TLB 快表')[0]?.id, 's4-p1');

  // Highlight helper never nests tags or breaks surrogate pairs.
  const snip = extractHighlightSnippet('Prefix 😀🚀 Raft consensus protocol ensures safety across replicas.', ['raft', 'safety'], { maxLength: 40 });
  assert.ok(snip.highlights.length >= 1);
  assert.doesNotMatch(snip.highlighted, /<mark>[^<]*<mark>/);
});

/* ---------- 5. approx-string-match (lib/quote-locate.js) ---------- */

test('5. approx-string-match quote-locate: <=10% edit rate, context disambiguation, ambiguity guard & UTF-16 alignment', () => {
  // Exact 10% edit-rate boundary on a 20-letter key: 2 edits (10%) matches, 3 edits (15%) is rejected even if caller asks for a higher rate.
  const boundaryText = 'Intro: distributedconsensus ensures replicated safety.';
  const atBoundary = locateQuoteDetailed(boundaryText, 'distributxxconsensus');
  assert.equal(atBoundary.status, 'approx');
  assert.equal(atBoundary.errors, 2);
  assert.equal(atBoundary.editRate, 0.1);
  assert.equal(boundaryText.slice(atBoundary.start, atBoundary.end), 'distributedconsensus');

  const overBoundary = locateQuoteDetailed(boundaryText, 'distribuxxxconsensus');
  assert.equal(overBoundary.status, 'missing');
  assert.equal(locateQuote(boundaryText, 'distribuxxxconsensus'), null);
  assert.equal(locateQuoteDetailed(boundaryText, 'distribuxxxconsensus', { maxEditRate: 0.25 }).status, 'missing', 'edit rate is hard-capped at 10%');

  // Single OCR/typo drift (1 edit out of 36 key chars = 2.8% <= 10%) with astral emoji prefix (UTF-16 alignment check!).
  const textWithEmoji = '📘🌟 The distributed consensus protocol guarantees linearizability under network partitions.';
  const driftedQuote = 'The distributd consensus protocol guarantees linearizability';
  const hit = locateQuoteDetailed(textWithEmoji, driftedQuote);
  assert.equal(hit.status, 'approx');
  assert.ok(hit.editRate <= 0.1);
  assert.equal(textWithEmoji.slice(hit.start, hit.end), 'The distributed consensus protocol guarantees linearizability');

  // Edit rate > 10% MUST be rejected as missing (never mis-anchor).
  const tooFar = locateQuoteDetailed(textWithEmoji, 'The distxxxxxxx consensxx protocxx guarantees');
  assert.equal(tooFar.status, 'missing');
  assert.equal(locateQuote(textWithEmoji, 'The distxxxxxxx consensxx protocxx guarantees'), null);

  // Multiple disjoint approximate occurrences: ambiguous without context, uniquely resolved with distinguishing prefix/suffix!
  const repeated = 'Chapter 1 intro: The consensus protocol guarantees safety today. Chapter 9 appendix: The consensus protocol guarantees safety later.';
  const noisy = 'The consensuz protocol guarantees safety';
  assert.equal(locateQuoteDetailed(repeated, noisy).status, 'ambiguous');
  assert.equal(locateQuote(repeated, noisy), null, 'ambiguous approx match must return null');

  const disambiguated = locateQuoteDetailed(repeated, noisy, { prefix: 'Chapter 9 appendix:', suffix: 'later.' });
  assert.equal(disambiguated.status, 'approx');
  assert.ok(disambiguated.start > repeated.indexOf('Chapter 9'));
  assert.equal(repeated.slice(disambiguated.start, disambiguated.end), 'The consensus protocol guarantees safety');

  // Contradicting context on a single approx hit refuses to mis-anchor.
  assert.equal(locateQuoteDetailed(textWithEmoji, driftedQuote, { prefix: 'Completely unrelated prefix words' }).status, 'missing');

  // Selection resolver surfaces ambiguous & context-disambiguated approx hits cleanly.
  assert.equal(resolveQuote(repeated, noisy).status, 'ambiguous');
  const resolved = resolveQuote(repeated, noisy, { prefix: 'Chapter 9 appendix:', suffix: 'later.' });
  assert.equal(resolved.status, 'fuzzy');
  assert.ok(resolved.start > repeated.indexOf('Chapter 9'));
  assert.ok(createLocator(textWithEmoji)(driftedQuote));
});

/* ---------- 6. zustand (ui/app/store.js & ui/app/app-context.js) ---------- */

test('6. zustand App store: fine-grained slice isolation and backward-compatible useApp() facade', () => {
  const { AppContext, AppStoreProvider, createAppStore, syncAppStore, useApp, useAppSelector, useAppSlice } = uiMod;
  const navA = { page: 'library' };
  const boardA = { count: 2 };
  const store = createAppStore({ nav: navA, board: boardA, language: 'zh' });

  let navEvents = 0;
  let boardEvents = 0;
  const unsub = store.subscribe((next, prev) => {
    if (next.nav !== prev.nav) navEvents++;
    if (next.board !== prev.board) boardEvents++;
  });

  // Updating only `board` leaves `nav` reference untouched (zero nav notifications!).
  const boardB = { count: 3 };
  assert.equal(syncAppStore(store, { nav: navA, board: boardB }), true);
  assert.equal(navEvents, 0);
  assert.equal(boardEvents, 1);
  assert.equal(store.getState().board.count, 3);

  // Syncing identical references is a pure no-op.
  assert.equal(syncAppStore(store, { nav: navA, board: boardB }), false);
  assert.equal(boardEvents, 1);
  unsub();

  // SSR render with AppStoreProvider: both useAppSelector/useAppSlice and legacy useApp() read the initial store state.
  const ssrStore = createAppStore({ nav: navA, board: boardB, language: 'zh' });
  function Probe() {
    const page = useAppSelector((s) => s.nav.page);
    const board = useAppSlice('board');
    const full = useApp();
    return React.createElement('div', null, `${page}:${board.count}:${full.language}`);
  }
  const html = renderToStaticMarkup(
    React.createElement(AppStoreProvider, { store: ssrStore }, React.createElement(Probe)),
  );
  assert.equal(html, '<div>library:3:zh</div>');

  // Backward compatibility: standalone <AppContext.Provider> without Zustand store still works via useApp().
  function LegacyProbe() {
    const { language } = useApp();
    return React.createElement('span', null, language);
  }
  const legacyHtml = renderToStaticMarkup(
    React.createElement(AppContext.Provider, { value: { language: 'en' } }, React.createElement(LegacyProbe)),
  );
  assert.equal(legacyHtml, '<span>en</span>');
});

/* ---------- 7. @atlaskit/pragmatic-drag-and-drop (ui/Board.jsx) ---------- */

test('7. pragmatic-drag-and-drop Board: removes dragover reflow loop, renders explicit drag handles & keeps keyboard/menu fallbacks', async () => {
  // Verify real module graph imports @atlaskit/pragmatic-drag-and-drop/adapter/element-adapter via esbuild metafile.
  const graph = await build({
    entryPoints: ['ui/Board.jsx'],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'esm',
    external: ['react', 'react-dom', 'react/*', 'react-dom/*', '@atlaskit/pragmatic-drag-and-drop/*', '@base-ui/*'],
    loader: { '.css': 'text' },
    logLevel: 'silent',
  });
  const boardImports = graph.metafile.inputs['ui/Board.jsx']?.imports?.map((entry) => entry.path) || [];
  assert.ok(
    boardImports.includes('@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter'),
    `expected ui/Board.jsx module graph to import pragmatic-drag-and-drop element-adapter, got: ${boardImports.join(', ')}`,
  );

  // Mount Board interactively with an element-adapter probe to verify zero native onDragOver handlers,
  // explicit drag handles, and drop-to-move wiring without DOM querySelectorAll reflow loops.
  const dndState = { draggables: [], dropTargets: [], monitors: [] };
  globalThis.__TEST_BOARD_DND__ = dndState;
  const dndSpyPlugin = {
    name: 'board-dnd-probe',
    setup(builder) {
      builder.onResolve({ filter: /^@atlaskit\/pragmatic-drag-and-drop\/adapter\/element-adapter$/ }, () => ({
        path: 'element-adapter',
        namespace: 'board-dnd-probe',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'board-dnd-probe' }, () => ({
        contents: `
          const s = globalThis.__TEST_BOARD_DND__;
          export function draggable(cfg) { s.draggables.push(cfg); return () => {}; }
          export function dropTargetForElements(cfg) { s.dropTargets.push(cfg); return () => {}; }
          export function monitorForElements(cfg) { s.monitors.push(cfg); return () => {}; }
        `,
        loader: 'js',
      }));
    },
  };

  const sampleBoard = {
    version: 1,
    revision: 1,
    columns: [
      { id: 'todo', title: '待办', done: false, cardIds: ['c1'] },
      { id: 'done', title: '已完成', done: true, cardIds: [] },
    ],
    cards: {
      c1: { id: 'c1', title: 'Review FSRS', note: '', due: '', labels: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
    },
    archived: [],
  };
  const mutations = [];
  const noop = () => {};
  const state = {
    board: sampleBoard,
    error: '',
    conflict: false,
    busy: false,
    mutate: async (action, args) => { mutations.push({ action, args }); return true; },
    refresh: noop,
    clearError: noop,
  };

  try {
    const interactive = await loadInteractiveUi(`
      export { default as Board } from './ui/Board.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `, { plugins: [dndSpyPlugin] });

    await withBrowserGlobals(async () => {
      interactive.exports.setUiLanguage('zh');
      const mounted = interactive.mount(() => interactive.React.createElement(interactive.exports.Board, {
        state,
        library: { root: '/lib' },
        today: '2026-10-02',
      }));
      try {
        // Zero native onDragOver handlers anywhere in the rendered Board tree.
        const dragOverNodes = mounted.findAll((node) => typeof node.props?.onDragOver === 'function');
        assert.equal(dragOverNodes.length, 0, 'must not attach native 60-120Hz onDragOver handlers');

        // Pragmatic drag-and-drop registers the card draggable with a dragHandle, column drop targets, and the board monitor.
        assert.equal(dndState.draggables.length, 1);
        assert.ok(dndState.draggables[0].dragHandle, 'draggable must wire an explicit dragHandle');
        assert.equal(dndState.monitors.length, 1);
        const doneColTarget = dndState.dropTargets.find((t) => t.getData().type === 'board-column' && t.getData().columnId === 'done');
        assert.ok(doneColTarget, 'done column registers as a pragmatic drop target');

        // Dropping card c1 onto the done column triggers board.card.move without any DOM reflow query.
        await mounted.act(() => {
          dndState.monitors[0].onDrop({
            source: { data: dndState.draggables[0].getInitialData() },
            location: { current: { dropTargets: [{ data: doneColTarget.getData() }] } },
          });
        });
        assert.deepEqual(mutations, [{ action: 'board.card.move', args: { id: 'c1', column: 'done', index: 0 } }]);
      } finally {
        mounted.unmount();
      }
    });
  } finally {
    delete globalThis.__TEST_BOARD_DND__;
  }

  const { Board, setUiLanguage } = uiMod;
  setUiLanguage('zh');
  const zhHtml = renderToStaticMarkup(React.createElement(Board, { state, library: { root: '/lib' }, today: '2026-10-02' }));
  assert.match(zhHtml, /data-drag-handle="true"/, 'explicit drag handle must be rendered');
  assert.match(zhHtml, /aria-label="拖动卡片：Review FSRS"/);
  assert.match(zhHtml, /aria-label="更多操作：Review FSRS"/, 'menu fallback must remain available');

  setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(React.createElement(Board, { state, library: { root: '/lib' }, today: '2026-10-02' }));
    assert.match(enHtml, /aria-label="Drag card: Review FSRS"/);
  } finally {
    setUiLanguage('zh');
  }
});

/* ---------- 8. lib/runtime/schema.js hardening ---------- */

test('8. runtime/schema.js hardening: circular schema protection, nesting depth guard & Object.hasOwn required check', () => {
  // Circular schema must report a clean problem instead of throwing RangeError (stack overflow).
  const cyclic = { type: 'object', properties: {} };
  cyclic.properties.self = cyclic;
  const problems = schemaProblems(cyclic, 'probe.run input');
  assert.ok(problems.some(msg => msg.includes('circular schema reference')), problems.join('; '));

  // Pathological nesting depth throws a clean descriptive error instead of stack overflow.
  let deepSchema = { type: 'string' };
  let deepValue = 'leaf';
  for (let i = 0; i < 70; i++) {
    deepSchema = { type: 'object', properties: { next: deepSchema } };
    deepValue = { next: deepValue };
  }
  assert.throws(() => validate(deepValue, deepSchema), /exceeds maximum nesting depth/);

  // Inherited Object.prototype properties (like toString) must NOT satisfy `required`.
  assert.throws(() => validate({}, { type: 'object', required: ['toString'] }), /arguments\.toString is required/);
});
