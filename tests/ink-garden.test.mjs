import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import rough from 'roughjs';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`
  export * from './ui/ink-garden/seed-prng.js';
  export * from './ui/ink-garden/herbarium-svg.js';
  export * from './ui/ink-garden/shanshui-svg.js';
  export * from './ui/ink-garden/astrolabe-svg.js';
  export * from './ui/ink-garden/export-poster.js';
  export { default as InkGardenSection, EDITIONS } from './ui/ink-garden/InkGardenSection.jsx';
  export { StatsView } from './ui/Dashboard.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const roughGen = rough.generator();
const HAN = /[\u3400-\u9fff]/;

function sampleDecks() {
  return [
    { id: 'deck-alg', title: 'CS3230｜Dynamic Programming｜30题', course: 'CS3230', total: 30 },
    { id: 'deck-net', title: 'CS3230｜Graph Flows｜24题', course: 'CS3230', total: 24 },
    { id: 'deck-db', title: 'CS2102｜Query Optimization｜18题', course: 'CS2102', total: 18 },
    { id: 'deck-new', title: 'CS2102｜Concurrency Control｜15题', course: 'CS2102', total: 15 },
  ];
}

function sampleProgress() {
  return {
    'deck-alg': {
      total: 30, mastery: 94, due: 0, status: 'done',
      counts: { mastered: 27, familiar: 3, learning: 0, weak: 0, new: 0 },
    },
    'deck-net': {
      total: 24, mastery: 56, due: 4, status: 'active',
      counts: { mastered: 6, familiar: 8, learning: 10, weak: 0, new: 0 },
    },
    'deck-db': {
      total: 18, mastery: 32, due: 3, status: 'active',
      counts: { mastered: 2, familiar: 2, learning: 8, weak: 4, new: 2 },
    },
    'deck-new': {
      total: 15, mastery: 0, due: 0, status: 'todo',
      counts: { mastered: 0, familiar: 0, learning: 0, weak: 0, new: 15 },
    },
  };
}

function sampleStats() {
  const heatmap = Array.from({ length: 84 }, (_, i) => ({
    date: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
    count: (i % 5 === 0) ? 0 : ((i * 7) % 19) + 2,
  }));
  return {
    today: '2026-10-02',
    totals: {
      attempts: 112, activeDays: 24, streak: 6, due: 7,
      gradedRate: 78, gradedAttempts: 64, selfRate: 84, selfAttempts: 48,
      oralAttempts: 0, oralStrong: 0, cards: 87, mastered: 35, weak: 4,
    },
    heatmap,
    trend: [],
    forecast: { days: [{ date: '2026-10-02', count: 7, overdue: 1, cards: [{ deckId: 'deck-net', cardId: 'c1' }] }], later: 0 },
    mastery: { windowDays: 30, minAnswers: 3, levels: [], kinds: [] },
    weakTopics: [
      {
        deckId: 'deck-db',
        deckTitle: 'CS2102｜Query Optimization｜18题',
        course: 'CS2102',
        topic: 'Join Ordering',
        wrong: 3,
        cards: [{ deckId: 'deck-db', cardId: 'q1' }, { deckId: 'deck-db', cardId: 'q2' }],
      },
    ],
  };
}

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
        let sIdx = 0, rIdx = 0;
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
          useId() { return 'ig-id'; },
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
  if (Array.isArray(tree)) { for (const x of tree) findAll(x, pred, out); return out; }
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

test('seed-prng: deterministic hashing, PRNG sequence, and fbm1D noise', () => {
  const s1 = m.hashString('deck-alg');
  const s2 = m.hashString('deck-alg');
  const s3 = m.hashString('deck-net');
  assert.equal(s1, s2);
  assert.notEqual(s1, s3);
  assert.ok(s1 > 0);

  const rA = m.createSeededRandom(s1);
  const rB = m.createSeededRandom(s2);
  const seqA = Array.from({ length: 8 }, () => rA.next());
  const seqB = Array.from({ length: 8 }, () => rB.next());
  assert.deepEqual(seqA, seqB);
  assert.ok(seqA.every((v) => v >= 0 && v < 1));

  const n1 = m.fbm1D(1.75, s1);
  const n2 = m.fbm1D(1.75, s1);
  assert.equal(n1, n2);
  assert.ok(n1 >= 0 && n1 <= 1);
});

test('normalizeGardenData: classifies all 4 botanical stages cleanly and handles empty libraries', () => {
  const garden = m.normalizeGardenData({
    stats: sampleStats(),
    decks: sampleDecks(),
    progress: sampleProgress(),
  });
  assert.equal(garden.isEmpty, false);
  assert.equal(garden.items.length, 4);
  assert.deepEqual(
    Object.fromEntries(garden.items.map((d) => [d.id, d.stage])),
    { 'deck-alg': 'mastered', 'deck-net': 'learning', 'deck-db': 'weak', 'deck-new': 'fresh' },
  );
  assert.equal(garden.items.find((d) => d.id === 'deck-db').weakCards.length, 2);
  assert.equal(garden.totals.due, 7);
  assert.ok(garden.totals.overallMastery > 0);

  const empty = m.normalizeGardenData({ stats: { totals: { attempts: 0 } }, decks: [], progress: {} });
  assert.equal(empty.isEmpty, true);
  assert.equal(empty.items.length, 0);
  assert.equal(empty.totals.overallMastery, 0);
});

test('all 3 print editions generate deterministic roughjs scenes and serene empty states', () => {
  const garden = m.normalizeGardenData({
    stats: sampleStats(),
    decks: sampleDecks(),
    progress: sampleProgress(),
  });
  const emptyGarden = m.normalizeGardenData({ stats: { totals: { attempts: 0 } }, decks: [], progress: {} });
  const lightPalette = { ...m.DEFAULT_PALETTE, paper: '#faf8f4', ink: '#1e1a15', isLight: true };

  // Edition I: Ink Herbarium
  const herb1 = m.buildHerbariumScene(garden, m.DEFAULT_PALETTE, roughGen);
  const herb2 = m.buildHerbariumScene(garden, m.DEFAULT_PALETTE, roughGen);
  assert.deepEqual(herb1, herb2, 'herbarium scene is strictly deterministic for the same decks');
  assert.equal(herb1.nodes.length, 4);
  assert.ok(herb1.branchPaths.length > 10, 'ArtPlum branching generates organic plum boughs');
  assert.ok(herb1.nodes.every((n) => n.strokes.length >= 2), 'each deck specimen draws roughjs strokes');
  const herbEmpty = m.buildHerbariumScene(emptyGarden, m.DEFAULT_PALETTE, roughGen);
  assert.equal(herbEmpty.nodes.length, 0);
  assert.ok(herbEmpty.branchPaths.length > 0 && herbEmpty.emptyBuds.length > 0, 'empty herbarium draws a serene winter bough');

  // Edition II: Ink-Wash Shan-Shui
  const ss1 = m.buildShanshuiScene(garden, m.DEFAULT_PALETTE, roughGen);
  const ss2 = m.buildShanshuiScene(garden, m.DEFAULT_PALETTE, roughGen);
  assert.deepEqual(ss1, ss2, 'shan-shui scene is strictly deterministic');
  assert.equal(ss1.ranges.length, 3);
  assert.equal(ss1.nodes.length, 4);
  assert.ok(ss1.cunfaPaths.length > 0 && ss1.pavilionPaths.length > 0 && ss1.boatPaths.length > 0);
  const ssEmpty = m.buildShanshuiScene(emptyGarden, lightPalette, roughGen);
  assert.equal(ssEmpty.nodes.length, 0);
  assert.ok(ssEmpty.boatPaths.length > 0, 'empty shan-shui still offers a calm waiting sailboat');

  // Edition III: Engraved Astrolabe
  const astro1 = m.buildAstrolabeScene(garden, m.DEFAULT_PALETTE, roughGen);
  const astro2 = m.buildAstrolabeScene(garden, m.DEFAULT_PALETTE, roughGen);
  assert.deepEqual(astro1, astro2, 'astrolabe scene is strictly deterministic');
  assert.equal(astro1.nodes.length, 4);
  assert.equal(astro1.tickPaths.length, 36);
  assert.ok(astro1.filamentPaths.length >= 2, 'course-grouped decks link with constellation filaments');
  assert.ok(astro1.ringPaths.length >= 5);
  assert.deepEqual(astro1.cardinalMarks.map((c) => c.text), ['0°', '90°', '180°', '270°']);
  assert.ok(astro1.wingPaths.length >= 14, 'astrolabe renders symmetric copperplate wing arcs & sighting rules');
  assert.match(astro1.colophon, /^2026\.10 · \d+%$/);
  const astroLight = m.buildAstrolabeScene(garden, lightPalette, roughGen);
  assert.notEqual(astroLight.framePaths[0].stroke, '', 'light palette resolves cleanly');
});

test('Wave 3 visual craft: 1-deck Herbarium richness, Shan-Shui water-mist & nestled peaks, colophon, and 34-char SVG halo tag', () => {
  const oneDeck = [{ id: 'deck-only', title: 'CS3230｜Algorithmic Graph Theory Notes｜24题', course: 'CS3230', total: 24 }];
  const oneProgress = {
    'deck-only': {
      total: 24, mastery: 58, due: 3, status: 'active',
      counts: { mastered: 8, familiar: 6, learning: 8, weak: 2, new: 0 },
    },
  };
  const oneStats = sampleStats();
  const oneGarden = m.normalizeGardenData({ stats: oneStats, decks: oneDeck, progress: oneProgress });
  const herb = m.buildHerbariumScene(oneGarden, m.DEFAULT_PALETTE, roughGen);
  assert.equal(herb.nodes.length, 1, '1-deck library keeps exactly 1 interactive node (zero fake decks)');
  assert.ok(herb.branchPaths.length >= 16, '1-deck herbarium grows sweeping primary + companion boughs');
  assert.ok(herb.companionStrokes.length > 0, 'progress-driven companion blossoms/buds/petals enrich sparse plate');
  assert.equal(herb.colophon, '2026.10 · 58%');

  const fullGarden = m.normalizeGardenData({ stats: sampleStats(), decks: sampleDecks(), progress: sampleProgress() });
  const ss = m.buildShanshuiScene(fullGarden, m.DEFAULT_PALETTE, roughGen);
  assert.ok(ss.waterFadeBand && ss.waterFadeBand.height > 60, 'shan-shui emits bottom water-mist fade band');
  assert.ok(ss.pinePaths.length > 0, 'shan-shui adds subtle foreground mastery pines');
  assert.match(ss.colophon, /^2026\.10 · \d+%$/);
  for (const node of ss.nodes) {
    assert.ok(node.ridgeY - node.y <= 8, `${node.id} (${node.item.stage}) nestles closely onto ridge contour`);
  }

  // Rendered Shan-Shui includes bottom water-mist gradient + colophon; Astrolabe includes cardinal degree marks
  const ssHtml = renderToStaticMarkup(React.createElement(m.InkGardenSection, {
    stats: sampleStats(), decks: sampleDecks(), progress: sampleProgress(), defaultEdition: 'shanshui', roughGenerator: roughGen,
  }));
  assert.equal((ssHtml.match(/<linearGradient/g) || []).length, 2, 'shan-shui defines mist + bottom water-mist gradients');
  assert.match(ssHtml, /class="ink-garden__colophon"[^>]*>2026\.10 · \d+%</);

  const astroHtml = renderToStaticMarkup(React.createElement(m.InkGardenSection, {
    stats: sampleStats(), decks: sampleDecks(), progress: sampleProgress(), defaultEdition: 'astrolabe', roughGenerator: roughGen,
  }));
  for (const deg of ['0°', '90°', '180°', '270°']) {
    assert.ok(astroHtml.includes(`>${deg}</text>`), `astrolabe renders cardinal ${deg}`);
  }

  // ActiveNodeLabel supports 34 chars before ellipsis and carries SVG stroke-halo presentation attrs
  const longTitle = 'CS3230｜Algorithmic Graph Theory & Flow Optimization Deep Dive｜24题';
  const twoDecks = [
    oneDeck[0],
    { id: 'deck-long', title: longTitle, course: 'CS3230', total: 24 },
  ];
  const twoProg = {
    ...oneProgress,
    'deck-long': { total: 24, mastery: 40, due: 1, status: 'active', counts: { mastered: 4, familiar: 4, learning: 10, weak: 4, new: 2 } },
  };
  const hookStore = new Map();
  const el = () => React.createElement(m.InkGardenSection, {
    stats: oneStats, decks: twoDecks, progress: twoProg, roughGenerator: roughGen,
  });
  const t1 = renderTree(el(), hookStore);
  const mediumNode = findAll(t1, (n) => n.type === 'g' && n.props?.['data-deck-id'] === 'deck-only')[0];
  mediumNode.props.onMouseEnter();
  const t2 = renderTree(el(), hookStore);
  const tagMedium = findAll(t2, (n) => n.type === 'text' && n.props?.className === 'ink-garden__node-tag')[0];
  assert.equal(textOf(tagMedium), 'Algorithmic Graph Theory Notes', '30-char title renders untruncated under 34-char budget');
  assert.equal(tagMedium.props.paintOrder, 'stroke');
  assert.equal(tagMedium.props.strokeLinejoin, 'round');
  assert.equal(tagMedium.props.strokeWidth, 4);
  assert.equal(tagMedium.props.stroke, m.DEFAULT_PALETTE.paper);

  const longNode = findAll(t2, (n) => n.type === 'g' && n.props?.['data-deck-id'] === 'deck-long')[0];
  longNode.props.onMouseEnter();
  const t3 = renderTree(el(), hookStore);
  const tagLong = findAll(t3, (n) => n.type === 'text' && n.props?.className === 'ink-garden__node-tag')[0];
  assert.equal(textOf(tagLong).length, 34, 'titles over 34 chars truncate cleanly to 33 chars + ellipsis');
  assert.ok(textOf(tagLong).endsWith('…'));
});

test('export-poster: builds clean ASCII filenames and standalone XML SVG with theme background', () => {
  assert.equal(m.buildPosterFilename('shanshui', 'png', '2026-10-02'), 'studyhub-ink-gallery-shanshui-2026-10-02.png');
  const rawSvg = '<svg viewBox="0 0 960 440"><path d="M0 0 L10 10" stroke="#efe9df" /></svg>';
  const xml = m.serializePlateSvg(rawSvg, { palette: { ...m.DEFAULT_PALETTE, paper: '#faf8f4' } });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(xml, /<rect width="960" height="440" fill="#faf8f4" \/>/);
});

test('InkGardenSection: renders all 3 editions in zh and en (zero Han in en), supports click -> inspect -> onStartScope, and honors busy lock', () => {
  const stats = sampleStats();
  const decks = sampleDecks();
  const progress = sampleProgress();

  // Render all 3 editions in Chinese & English
  for (const edition of m.EDITIONS) {
    const zh = renderToStaticMarkup(React.createElement(m.InkGardenSection, {
      stats, decks, progress, defaultEdition: edition, roughGenerator: roughGen,
    }));
    assert.match(zh, /data-testid="ink-garden-section"/);
    assert.match(zh, new RegExp(`data-edition="${edition}"`));
    assert.equal((zh.match(/data-deck-id="/g) || []).length, 4, `${edition} renders all 4 interactive deck specimens`);
    assert.match(zh, /<table class="sh-visually-hidden"/);
  }

  try {
    m.setUiLanguage('en');
    for (const edition of m.EDITIONS) {
      const enEmpty = renderToStaticMarkup(React.createElement(m.InkGardenSection, {
        stats: { totals: { attempts: 0 }, heatmap: [] },
        decks: [],
        progress: {},
        defaultEdition: edition,
        roughGenerator: roughGen,
      }));
      assert.match(enEmpty, /Living Ink Gallery/);
      assert.doesNotMatch(enEmpty.replace(/<[^>]+>/g, ' '), HAN, `en empty ${edition} contains zero Han characters`);
    }
    // Decks with English titles produce zero Han across the entire section
    const enDecks = [
      { id: 'd1', title: 'Linear Algebra', course: 'Math', total: 20 },
      { id: 'd2', title: 'Probability', course: 'Math', total: 16 },
    ];
    const enProg = {
      d1: { total: 20, mastery: 88, due: 1, status: 'done', counts: { mastered: 18, familiar: 2, learning: 0, weak: 0, new: 0 } },
      d2: { total: 16, mastery: 45, due: 2, status: 'active', counts: { mastered: 2, familiar: 4, learning: 8, weak: 2, new: 0 } },
    };
    const enPopulated = renderToStaticMarkup(React.createElement(m.InkGardenSection, {
      stats: { ...stats, weakTopics: [{ deckId: 'd2', deckTitle: 'Probability', course: 'Math', topic: 'Bayes', wrong: 2, cards: [{ deckId: 'd2', cardId: 'c1' }] }] },
      decks: enDecks,
      progress: enProg,
      roughGenerator: roughGen,
    }));
    assert.doesNotMatch(enPopulated.replace(/<[^>]+>/g, ' '), HAN, 'en populated gallery contains zero Han characters');
  } finally {
    m.setUiLanguage('zh');
  }

  // Interactive selection -> SpecimenInspector -> launch deck practice & weak cards practice
  const started = [];
  const hookStore = new Map();
  const props = {
    stats, decks, progress,
    onStartScope: (scope) => started.push(scope),
    roughGenerator: roughGen,
  };
  const withStudy = (busy) => React.createElement(
    m.StudyServicesContext.Provider,
    { value: { busy } },
    React.createElement(m.InkGardenSection, props),
  );
  const tree1 = renderTree(withStudy(false), hookStore);
  const weakNode = findAll(tree1, (n) => n.type === 'g' && n.props?.['data-deck-id'] === 'deck-db')[0];
  assert.ok(weakNode, 'located clickable deck-db specimen node');

  // Hover updates caption bar cleanly (zero bare title= needed)
  weakNode.props.onMouseEnter();
  const hoverTree = renderTree(withStudy(false), hookStore);
  const hoverCaption = findAll(hoverTree, (n) => n.props?.['data-testid'] === 'ink-garden-caption')[0];
  assert.match(textOf(hoverCaption), /Query Optimization/);
  assert.match(textOf(hoverCaption), /32%/);

  // Click opens SpecimenInspector and fires onStartScope
  weakNode.props.onClick();
  const tree2 = renderTree(withStudy(false), hookStore);
  const inspector = findAll(tree2, (n) => n.props?.['data-testid'] === 'ink-garden-inspector')[0];
  assert.ok(inspector, 'clicking a deck specimen opens the inspector');
  assert.match(textOf(inspector), /Query Optimization/);
  assert.match(textOf(inspector), /Join Ordering/);

  const buttons = findAll(inspector, (n) => typeof n.props?.onClick === 'function' && (n.type === 'button' || n.type?.render));
  const practiseDeckBtn = buttons.find((b) => textOf(b).includes('练这组题'));
  const practiseWeakBtn = buttons.find((b) => textOf(b).includes('先练薄弱题'));
  assert.ok(practiseDeckBtn && practiseWeakBtn);
  practiseDeckBtn.props.onClick();
  practiseWeakBtn.props.onClick();
  assert.deepEqual(started[0], [{ deckId: 'deck-db' }]);
  assert.deepEqual(started[1], [{ deckId: 'deck-db', cardId: 'q1' }, { deckId: 'deck-db', cardId: 'q2' }]);

  // Busy context locks inspector buttons cleanly
  const busyTree = renderTree(withStudy(true), hookStore);
  const busyInspector = findAll(busyTree, (n) => n.props?.['data-testid'] === 'ink-garden-inspector')[0];
  assert.ok(busyInspector, 'inspector remains mounted while busy');
  const busyPractice = findAll(busyInspector, (n) => n.type === 'button' && textOf(n).includes('练这组题'))[0];
  assert.equal(busyPractice.props.disabled, true, 'busy StudyServicesContext disables practice launch button');

  // Edition switcher changes active edition cleanly
  const shanshuiBtn = findAll(tree2, (n) => n.type === 'button' && textOf(n) === '千里山水卷')[0];
  assert.ok(shanshuiBtn, 'located Shan-Shui edition toggle');
  shanshuiBtn.props.onClick();
  const tree3 = renderTree(withStudy(false), hookStore);
  const sectionAfterSwitch = findAll(tree3, (n) => n.props?.['data-testid'] === 'ink-garden-section')[0];
  assert.equal(sectionAfterSwitch.props['data-edition'], 'shanshui');

  // Collapse toggle folds gallery body cleanly
  const foldBtn = findAll(tree3, (n) => n.type === 'button' && String(n.props?.['aria-label'] || '').includes('收起'))[0];
  assert.ok(foldBtn, 'located collapse disclosure button');
  foldBtn.props.onClick({ currentTarget: null });
  const foldedTree = renderTree(withStudy(false), hookStore);
  assert.equal(findAll(foldedTree, (n) => n.type === 'svg' && String(n.props?.className || '').includes('ink-garden__svg')).length, 0, 'collapsed gallery hides SVG stage');
});

test('StatsView mounts InkGardenSection directly below dash-hero', () => {
  const html = renderToStaticMarkup(React.createElement(m.StatsView, {
    stats: sampleStats(),
    course: '*',
    data: { decks: sampleDecks(), progress: sampleProgress(), focus: { course: '*' } },
    onStartScope: () => {},
    onLibrary: () => {},
    onCreate: () => {},
    onSources: () => {},
  }));
  const heroIdx = html.indexOf('class="dash-hero"');
  const gardenIdx = html.indexOf('data-testid="ink-garden-section"');
  const chartsIdx = html.indexOf('class="dash-charts"');
  assert.ok(heroIdx > 0 && gardenIdx > heroIdx && chartsIdx > gardenIdx, 'Living Ink Gallery sits cleanly between dash-hero and dash-charts');
  assert.doesNotMatch(html, /掌握度/, 'Dashboard avoids 掌握度 copy (feedback-lite guardrail)');
});

test('ink-garden stylesheet contains zero raw hex/rgb/hsl colors and obeys motion & token contracts', async () => {
  const css = await readFile(new URL('../ui/ink-garden/ink-garden.css', import.meta.url), 'utf8');
  assert.match(css, /@layer study\.features/);
  assert.match(css, /@keyframes sh-ink-garden-fade/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /data-motion="reduced"/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /\b(?:rgba?|hsla?)\(/i);
  assert.doesNotMatch(css, /!important/);
  assert.doesNotMatch(css, /var\(--radius-card\)/);
});
