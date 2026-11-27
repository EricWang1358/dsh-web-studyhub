import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';

const m = await loadUi(`
  export * from './ui/mastery-map/model.js';
  export { default as MasteryMap } from './ui/mastery-map/MasteryMap.jsx';
  export { default as Graph } from './ui/Graph.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const HAN = /[\u3400-\u9fff]/;
const stripTags = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const inLanguage = (lang, fn) => { m.setUiLanguage(lang); try { return fn(); } finally { m.setUiLanguage('zh'); } };

function renderTree(element, hookStore = new Map()) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const prev = internals.H;
  function walk(node, path = 'root') {
    if (node == null || typeof node === 'boolean' || typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map((child, idx) => walk(child, `${path}.${idx}`));
    if (typeof node === 'object' && node.type) {
      if (node.type?.$$typeof === Symbol.for('react.context') || node.type?.$$typeof === Symbol.for('react.provider') || node.type?._context) {
        const ctx = node.type._context || node.type;
        const old = ctx._currentValue;
        ctx._currentValue = node.props.value;
        try { return walk(node.props.children, `${path}.ctx`); } finally { ctx._currentValue = old; }
      }
      if (typeof node.type === 'function') {
        let bucket = hookStore.get(path);
        if (!bucket) hookStore.set(path, bucket = { states: [], refs: [] });
        let sIdx = 0;
        let rIdx = 0;
        internals.H = {
          useState(init) {
            const i = sIdx++;
            if (!(i in bucket.states)) bucket.states[i] = typeof init === 'function' ? init() : init;
            return [bucket.states[i], (next) => { bucket.states[i] = typeof next === 'function' ? next(bucket.states[i]) : next; }];
          },
          useRef(init) {
            const i = rIdx++;
            if (!(i in bucket.refs)) bucket.refs[i] = { current: init };
            return bucket.refs[i];
          },
          useMemo(fn) { return fn(); },
          useCallback(fn) { return fn; },
          useEffect() {},
          useLayoutEffect() {},
          useInsertionEffect() {},
          useContext(ctx) { return ctx._currentValue; },
          useSyncExternalStore(_sub, getSnap) { return getSnap(); },
          useId() { return 'mm-test-id'; },
          useMemoCache(size) {
            const i = sIdx++;
            if (!(i in bucket.states)) bucket.states[i] = new Array(size);
            return bucket.states[i];
          },
        };
        const rendered = node.type(node.props);
        return { ...node, props: { ...node.props, children: walk(rendered, `${path}>fn`) } };
      }
      if (node.type?.$$typeof === Symbol.for('react.forward_ref') && typeof node.type.render === 'function') {
        const rendered = node.type.render(node.props, null);
        return { ...node, props: { ...node.props, children: walk(rendered, `${path}>fwd`) } };
      }
      if (node.props && 'children' in node.props) {
        return { ...node, props: { ...node.props, children: walk(node.props.children, `${path}.c`) } };
      }
    }
    return node;
  }
  try { return walk(element); } finally { internals.H = prev; }
}

function findAll(tree, pred, out = []) {
  if (tree == null || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { for (const item of tree) findAll(item, pred, out); return out; }
  if (pred(tree)) out.push(tree);
  if (tree.props && 'children' in tree.props) findAll(tree.props.children, pred, out);
  return out;
}

const textOf = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
};

function sampleOutline() {
  return {
    status: 'ok',
    course: 'Algorithms',
    total: 10,
    placed: 9,
    summary: {
      total: 10,
      counts: { mastered: 4, familiar: 1, learning: 2, weak: 2, new: 1 },
      due: 2,
      weak: 2,
      fresh: 1,
      inactive: 0,
      percent: 60,
      state: 'familiar',
    },
    unplaced: { total: 1 },
    documents: [],
    book: {
      id: 'bk-algo',
      stale: false,
      papers: 2,
      notes: { id: 'notes-1' },
      nodes: [
        {
          key: 'bk:ch1',
          id: 'ch1',
          depth: 1,
          title: 'Dynamic Programming',
          intro: 'Optimal substructure and state transitions.',
          total: 6,
          summary: { total: 6, counts: { mastered: 2, familiar: 1, learning: 1, weak: 2, new: 0 }, due: 2, weak: 2, fresh: 0, percent: 58, state: 'learning' },
          children: [
            {
              key: 'bk:sec1',
              id: 'sec1',
              depth: 2,
              title: 'Core Patterns',
              total: 6,
              summary: { total: 6, counts: { mastered: 2, familiar: 1, learning: 1, weak: 2, new: 0 }, due: 2, weak: 2, fresh: 0, percent: 58, state: 'learning' },
              children: [
                {
                  key: 'bk:p1',
                  id: 'p1',
                  depth: 3,
                  title: 'State Transition Equations',
                  total: 4,
                  tier: 'must',
                  summary: { total: 4, counts: { mastered: 2, familiar: 1, learning: 1, weak: 0, new: 0 }, due: 0, weak: 0, fresh: 0, percent: 80, state: 'mastered' },
                  evidence: { hid: '1.1.1', overall: 'solid', facets: { retention: 'solid', comprehension: 'verified', transfer: 'verified' }, prereqGaps: [] },
                },
                {
                  key: 'bk:p2',
                  id: 'p2',
                  depth: 3,
                  title: 'Knapsack Space Optimization',
                  total: 2,
                  tier: 'often',
                  summary: { total: 2, counts: { mastered: 0, familiar: 0, learning: 0, weak: 2, new: 0 }, due: 2, weak: 2, fresh: 0, percent: 15, state: 'learning' },
                  evidence: {
                    hid: '1.1.2',
                    overall: 'shaky',
                    facets: { retention: 'weak', comprehension: 'gap', transfer: 'unverified' },
                    prereqGaps: [{ hid: '1.1.1', title: 'State Transition Equations', overall: 'in_progress' }],
                    gapHint: { kind: 'weak_cards' },
                  },
                },
                {
                  key: 'bk:p3',
                  id: 'p3',
                  depth: 3,
                  title: 'Bitmask DP',
                  total: 0,
                  summary: { total: 0, counts: { mastered: 0, familiar: 0, learning: 0, weak: 0, new: 0 }, due: 0, weak: 0, fresh: 0, percent: null, state: 'none' },
                },
              ],
            },
          ],
        },
        {
          key: 'bk:ch2',
          id: 'ch2',
          depth: 1,
          title: 'Graph Algorithms',
          total: 4,
          summary: { total: 4, counts: { mastered: 2, familiar: 0, learning: 1, weak: 0, new: 1 }, due: 0, weak: 0, fresh: 1, percent: 61, state: 'familiar' },
          children: [
            {
              key: 'bk:p4',
              id: 'p4',
              depth: 2,
              title: 'Shortest Paths (Dijkstra)',
              total: 4,
              summary: { total: 4, counts: { mastered: 2, familiar: 0, learning: 1, weak: 0, new: 1 }, due: 0, weak: 0, fresh: 1, percent: 61, state: 'familiar' },
            },
            {
              key: 'bk:p5',
              id: 'p5',
              depth: 2,
              title: 'Minimum Spanning Tree',
              total: 0,
              summary: { total: 0, counts: { mastered: 0, familiar: 0, learning: 0, weak: 0, new: 0 }, due: 0, weak: 0, fresh: 0, percent: null, state: 'none', draftCards: 2 },
            },
          ],
        },
      ],
    },
  };
}

function sampleDeckLibrary(chapterCount = 3) {
  const decks = [];
  const progress = {};
  for (let i = 0; i < chapterCount; i++) {
    const id = `d${i + 1}`;
    decks.push({ id, title: `Chapter ${i + 1} Concepts`, course: 'Systems', available: 10 });
    const weak = i % 4 === 0 ? 2 : 0;
    const mastery = i % 4 === 0 ? 30 : i % 4 === 1 ? 85 : i % 4 === 2 ? 0 : 62;
    const newCount = mastery === 0 ? 10 : 1;
    progress[id] = {
      total: 10,
      mastery,
      due: i % 3 === 0 ? 1 : 0,
      counts: {
        mastered: mastery >= 80 ? 8 : 2,
        familiar: mastery >= 60 ? 1 : 0,
        learning: mastery === 0 ? 0 : 5,
        weak,
        new: newCount,
      },
      topics: [
        { name: `Topic ${i + 1}A`, total: 5, mastery, due: i % 3 === 0 ? 1 : 0, counts: { mastered: 2, familiar: 0, learning: 1, weak, new: newCount === 10 ? 5 : 0 } },
        { name: `Topic ${i + 1}B`, total: 5, mastery: 85, due: 0, counts: { mastered: 4, familiar: 1, learning: 0, weak: 0, new: 0 } },
      ],
    };
  }
  return { root: 'lib-test', focus: { course: 'Systems', courses: [{ name: 'Systems', count: chapterCount }] }, decks, progress };
}

test('model: combines outline hierarchy, coverage gaps, FSRS counts, and PointEvidence signals accurately', () => {
  const model = m.buildMasteryMapModel({ outline: sampleOutline(), course: 'Algorithms' });
  assert.equal(model.basis, 'outline');
  assert.equal(model.chapters.length, 2);
  assert.equal(model.totals.pointsCount, 5);
  assert.equal(model.totals.coveredPoints, 3);
  assert.equal(model.totals.uncoveredPoints, 1, 'Bitmask DP has 0 published and 0 draft cards');
  assert.equal(model.totals.draftOnlyPoints, 1, 'Minimum Spanning Tree has 2 draft cards');
  assert.equal(model.totals.overallMastery, 60);
  assert.deepEqual(model.weakKeys, ['bk:p2']);
  assert.deepEqual(model.uncoveredTitles, ['Bitmask DP']);
  assert.equal(model.countsByFilter.weak, 1);
  assert.equal(model.countsByFilter.uncovered, 1);

  const ch1 = model.chapters[0];
  assert.equal(ch1.points.length, 3);
  assert.equal(ch1.points[0].sectionTitle, 'Core Patterns');
  assert.equal(ch1.points[1].state, 'weak');
  assert.equal(ch1.points[2].state, 'uncovered');
  assert.equal(ch1.points[2].tier, 'gap');

  const dots = m.chapterPreviewDots(ch1);
  assert.deepEqual(dots.map((d) => d.state), ['mastered', 'weak', 'uncovered']);

  // Filtering and search
  const uncoveredOnly = m.filterMasteryChapters(model.chapters, { filter: 'uncovered' });
  assert.equal(uncoveredOnly.length, 1);
  assert.equal(uncoveredOnly[0].id, 'bk:ch1');
  assert.deepEqual(uncoveredOnly[0].matchedPoints.map((p) => p.title), ['Bitmask DP']);

  const searched = m.filterMasteryChapters(model.chapters, { query: 'dijkstra' });
  assert.equal(searched.length, 1);
  assert.equal(searched[0].id, 'bk:ch2');
  assert.deepEqual(searched[0].matchedPoints.map((p) => p.title), ['Shortest Paths (Dijkstra)']);
});

test('model: falls back cleanly to deck/topic progress and surfaces uncovered course documents', () => {
  const lib = sampleDeckLibrary(2);
  const docOutline = {
    status: 'ok',
    course: 'Systems',
    book: null,
    documents: [
      { key: 'doc:1', title: 'Lecture 5 Virtual Memory', total: 0, summary: { total: 0, counts: { mastered: 0, familiar: 0, learning: 0, weak: 0, new: 0 } } },
    ],
  };
  const model = m.buildMasteryMapModel({ outline: docOutline, decks: lib.decks, progress: lib.progress, course: 'Systems' });
  assert.equal(model.basis, 'decks');
  assert.equal(model.chapters.length, 3, '2 decks + 1 uncovered document');
  assert.equal(model.chapters[2].kind, 'document-gap');
  assert.equal(model.chapters[2].tier, 'gap');
  assert.deepEqual(model.uncoveredTitles, ['Lecture 5 Virtual Memory']);
  assert.equal(model.hasOutlineMaterials, true);
});

test('model: roving grid index navigation respects bounds and row strides', () => {
  assert.equal(m.nextMasteryGridIndex(0, 'ArrowRight', 10, 4), 1);
  assert.equal(m.nextMasteryGridIndex(0, 'ArrowLeft', 10, 4), 0);
  assert.equal(m.nextMasteryGridIndex(1, 'ArrowDown', 10, 4), 5);
  assert.equal(m.nextMasteryGridIndex(5, 'ArrowUp', 10, 4), 1);
  assert.equal(m.nextMasteryGridIndex(5, 'Home', 10, 4), 0);
  assert.equal(m.nextMasteryGridIndex(5, 'End', 10, 4), 9);
  assert.equal(m.nextMasteryGridIndex(5, 'Enter', 10, 4), null);
});

test('MasteryMap interactive drill-down: filters, chapter inspector, PointEvidence hints, practice & gap-fill callbacks', () => {
  const practisedChapters = [];
  const practisedPoints = [];
  const practisedWeak = [];
  const gapFills = [];
  const openedBooks = [];
  const hookStore = new Map();

  const props = {
    outline: sampleOutline(),
    course: 'Algorithms',
    onPracticeChapter: (ch) => practisedChapters.push(ch.key),
    onPracticePoint: (pt) => practisedPoints.push(pt.key),
    onPracticeWeakAll: (arg) => practisedWeak.push(arg),
    onGoGenerate: (titles) => gapFills.push(titles),
    onOpenBook: (key) => openedBooks.push(key),
    onOpenOutline: () => {},
  };

  const renderWithContext = () => renderTree(
    withStudy(m.StudyServicesContext, React.createElement(m.MasteryMap, props)),
    hookStore,
  );

  // Initial render: summary telemetry + quick actions
  const tree1 = renderWithContext();
  const weakBtn = findAll(tree1, (n) => n.props?.['data-mm-practice-weak'] !== undefined)[0];
  assert.ok(weakBtn, 'shows one-click weak & due practice button');
  weakBtn.props.onClick();
  assert.deepEqual(practisedWeak, [{ keys: ['bk:p2'], scopes: [] }]);

  const gapAllBtn = findAll(tree1, (n) => n.props?.['data-mm-gapfill-all'] !== undefined)[0];
  assert.ok(gapAllBtn, 'shows course-level gap-fill button');
  gapAllBtn.props.onClick();
  assert.deepEqual(gapFills, [['Bitmask DP']]);

  // Click chapter 1 to open inline drill-down inspector
  const ch1Cell = findAll(tree1, (n) => n.props?.['data-mm-chapter'] === 'bk:ch1')[0];
  assert.ok(ch1Cell, 'renders chapter 1 heatmap cell');
  ch1Cell.props.onClick();

  const tree2 = renderWithContext();
  const inspector = findAll(tree2, (n) => n.props?.['data-mm-inspector'] === 'bk:ch1')[0];
  assert.ok(inspector, 'clicking chapter opens inline drill-down inspector');

  // Verify PointEvidence hint and prereq gap appear inside inspector
  const hintNode = findAll(inspector, (n) => n.props?.['data-mm-gap-hint'] !== undefined)[0];
  assert.match(textOf(hintNode), /还差：重练薄弱题/);
  const prereqNode = findAll(inspector, (n) => n.props?.['data-mm-prereqs'] !== undefined)[0];
  assert.match(textOf(prereqNode), /前置待补：State Transition Equations/);

  // Trigger chapter practice, point practice, point gap-fill, and open book
  findAll(inspector, (n) => n.props?.['data-mm-practice-chapter'] !== undefined)[0].props.onClick();
  assert.deepEqual(practisedChapters, ['bk:ch1']);

  findAll(inspector, (n) => n.props?.['data-mm-practice-point'] === 'bk:p2')[0].props.onClick();
  assert.deepEqual(practisedPoints, ['bk:p2']);

  findAll(inspector, (n) => n.props?.['data-mm-generate-point'] === 'bk:p3')[0].props.onClick();
  assert.deepEqual(gapFills[1], ['Bitmask DP']);

  findAll(inspector, (n) => n.props?.['data-mm-book-point'] === 'bk:p1')[0].props.onClick();
  assert.deepEqual(openedBooks, ['bk:p1']);

  // Switch to Hierarchy Spine layout and click a point pill
  const spineToggle = findAll(tree2, (n) => n.type === 'button' && textOf(n) === '层级图谱')[0];
  assert.ok(spineToggle, 'renders hierarchy spine layout switch');
  spineToggle.props.onClick();

  const tree3 = renderWithContext();
  const p4Pill = findAll(tree3, (n) => n.props?.['data-mm-spine-point'] === 'bk:p4')[0];
  assert.ok(p4Pill, 'renders point pill in hierarchy spine layout');
  p4Pill.props.onClick();

  const tree4 = renderWithContext();
  const focusedPoint = findAll(tree4, (n) => n.props?.['data-point-id'] === 'bk:p4' && n.props?.['data-focused'] === 'true')[0];
  assert.ok(focusedPoint, 'clicking spine point pill opens its chapter inspector and focuses the point');
});

test('MasteryMap scales to 30+ chapters cleanly with INITIAL_VISIBLE_CHAPTERS window and expand-all', () => {
  const lib = sampleDeckLibrary(30);
  const html = renderToStaticMarkup(withStudy(
    m.StudyServicesContext,
    React.createElement(m.MasteryMap, { decks: lib.decks, progress: lib.progress, course: 'Systems' }),
  ));
  const renderedCells = (html.match(/data-mm-chapter="/g) || []).length;
  assert.equal(renderedCells, 24, 'initially renders 24 chapter cells for high-density scan');
  assert.match(html, /展开全部 30 章/);
  assert.match(html, /class="mm-grid" role="group"/, 'chapter grid uses role="group"');
  assert.doesNotMatch(html, /role="listitem"[^>]*aria-pressed=/, 'chapter buttons preserve native button role for aria-pressed');
});

test('Graph integrates mastery mode cleanly while keeping structure mode default', () => {
  const lib = sampleDeckLibrary(2);
  const masteryHtml = renderToStaticMarkup(withStudy(
    m.StudyServicesContext,
    React.createElement(m.Graph, {
      library: lib,
      defaultMode: 'mastery',
      initialOutline: sampleOutline(),
      onClose: () => {},
      onPracticeScope: () => {},
      onGoGenerateTopic: () => {},
    }),
  ));
  assert.match(masteryHtml, /data-testid="mastery-map"/);
  assert.match(masteryHtml, /aria-pressed="true"[^>]*>掌握图谱<\/button>/);
  assert.match(masteryHtml, /知识点覆盖 3\/5/);
  assert.doesNotMatch(masteryHtml, /导出 SVG/, 'SVG-only controls stay hidden in mastery map mode');
});

test('MasteryMap renders in English with zero Han characters outside user data', () => inLanguage('en', () => {
  const outlineHtml = renderToStaticMarkup(withStudy(
    m.StudyServicesContext,
    React.createElement(m.MasteryMap, {
      outline: { ...sampleOutline(), book: { ...sampleOutline().book, stale: true } },
      course: 'Algorithms',
      onPracticeChapter: () => {},
      onPracticePoint: () => {},
      onPracticeWeakAll: () => {},
      onGoGenerate: () => {},
      onOpenOutline: () => {},
      onOpenBook: () => {},
      onOpenWrongBook: () => {},
    }),
  ));
  const outlineText = stripTags(outlineHtml);
  assert.ok(!HAN.test(outlineText), `Untranslated Han in outline MasteryMap: ${outlineText.match(new RegExp(`.{0,30}${HAN.source}.{0,30}`))?.[0]}`);
  assert.match(outlineText, /Points covered 3\/5/);
  assert.match(outlineText, /Practise weak & due/);
  assert.match(outlineText, /Fill gap questions \(1\)/);

  const emptyHtml = renderToStaticMarkup(withStudy(
    m.StudyServicesContext,
    React.createElement(m.MasteryMap, { decks: [], progress: {}, course: '*', onOpenOutline: () => {} }),
  ));
  const emptyText = stripTags(emptyHtml);
  assert.ok(!HAN.test(emptyText), `Untranslated Han in empty MasteryMap: ${emptyText}`);

  const graphEnHtml = renderToStaticMarkup(withStudy(
    m.StudyServicesContext,
    React.createElement(m.Graph, {
      library: sampleDeckLibrary(2),
      defaultMode: 'mastery',
      initialOutline: sampleOutline(),
      onClose: () => {},
    }),
  ));
  const graphEnText = stripTags(graphEnHtml);
  assert.ok(!HAN.test(graphEnText), `Untranslated Han in Graph mastery mode: ${graphEnText.match(new RegExp(`.{0,30}${HAN.source}.{0,30}`))?.[0]}`);
  assert.match(graphEnText, /Mastery map/);
}));

test('MasteryMap modules obey client boundaries (zero lib/ imports) and CSS token/weight/motion guardrails', async () => {
  for (const rel of ['../ui/mastery-map/model.js', '../ui/mastery-map/MasteryMap.jsx']) {
    const src = await readFile(new URL(rel, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from\s+['"][^'"]*lib\//, `${rel} must not import from lib/`);
    assert.doesNotMatch(src, /<(?:button|Button|span|div|li|p)\b[^>]*\stitle=/, `${rel} uses Tooltip/aria-label instead of native title=`);
    assert.doesNotMatch(src, /eslint-disable/, `${rel} contains no eslint-disable comments`);
  }
  // Repo-wide @layer/:where(.study-app, .study-seat) structure, raw hex/rgb/hsl colors, and !important
  // are enforced across all ui/**/*.css by tests/css-layers.test.mjs, tests/ui-guardrails.test.mjs,
  // and tests/css-token-guard.test.mjs. Here we inspect parsed AST rules for mastery-map-specific
  // layer placement, motion-reduction declarations, and typographic token restraints.
  const { declarations, blocks } = parseCss(await readFile(new URL('../ui/mastery-map/mastery-map.css', import.meta.url), 'utf8'));
  assert.ok(blocks.some((b) => b.prelude === '@layer study.features'), 'mastery-map.css belongs to @layer study.features');
  const disablesMotionIn = (ctxPattern) => {
    const turnedOff = declarations.filter(
      (d) => d.prop === 'transition' && d.value === 'none' && ctxPattern.test(d.ctx.join(' | ')),
    );
    return ['.mm-cell', '.mm-spine__fill', '.mm-point__bar-fill'].every(
      (sel) => turnedOff.some((d) => d.ctx.at(-1).includes(sel)),
    );
  };
  assert.equal(disablesMotionIn(/@media \(prefers-reduced-motion:\s*reduce\)/), true, 'disables transitions under prefers-reduced-motion: reduce');
  assert.equal(disablesMotionIn(/\[data-motion=['"]reduced['"]\]/), true, 'disables transitions under data-motion="reduced"');
  assert.equal(disablesMotionIn(/\[data-motion=['"]off['"]\]/), true, 'disables transitions under data-motion="off"');
  assert.equal(declarations.some((d) => /var\(\s*--fw-strong\b/.test(d.value)), false, 'mastery-map.css must not use var(--fw-strong)');
  assert.equal(declarations.some((d) => /var\(\s*--fs-xs\b/.test(d.value)), false, 'mastery-map.css must not use var(--fs-xs)');
});
