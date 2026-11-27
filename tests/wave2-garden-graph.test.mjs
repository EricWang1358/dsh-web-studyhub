import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import rough from 'roughjs';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`
  export * from './ui/charts/chart-math.js';
  export * from './ui/charts/ForecastInkTide.jsx';
  export { ForecastPanel } from './ui/charts/DashboardCharts.jsx';
  export * from './ui/graph-sketch/graph-sketch.js';
  export { default as Graph } from './ui/Graph.jsx';
  export { layoutStructure, layoutPath } from './ui/graph-layout.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const roughGen = rough.generator();
const HAN = /[\u3400-\u9fff]/;

function makeForecast(counts) {
  return {
    days: counts.map((count, i) => ({
      date: `2026-10-${String(2 + i).padStart(2, '0')}`,
      count,
      ...(i === 0 ? { overdue: Math.min(count, 2) } : {}),
      cards: Array.from({ length: count }, (_, k) => ({ deckId: 'd1', cardId: `c${i}-${k}` })),
    })),
    later: 3,
  };
}

function sampleGraphData() {
  const card = (id, label, level) => ({ id: `card:${JSON.stringify(['d1', id])}`, kind: 'card', label, level });
  const topic = (name) => ({ id: `topic:${JSON.stringify(['d1', name])}`, kind: 'topic', label: name, mastery: 62, due: 1, total: 2 });
  const c1 = card('c1', 'Base Induction', 'mastered');
  const c2 = card('c2', 'DP Recurrence', 'learning');
  const c3 = card('c3', 'Optimal Substructure', 'weak');
  const c4 = card('c4', 'Unrelated Graph Cut', 'new');
  const t1 = topic('Dynamic Programming');
  const t2 = topic('Network Flow');
  const d1 = { id: 'deck:d1', kind: 'deck', label: 'Algorithms', mastery: 58, due: 2, total: 4 };
  return {
    mode: 'structure',
    nodes: [d1, t1, t2, c1, c2, c3, c4],
    edges: [
      { from: d1.id, to: t1.id, type: 'tree', seq: 0 },
      { from: d1.id, to: t2.id, type: 'tree', seq: 1 },
      { from: t1.id, to: c1.id, type: 'tree', seq: 0 },
      { from: t1.id, to: c2.id, type: 'tree', seq: 1 },
      { from: t1.id, to: c3.id, type: 'tree', seq: 2 },
      { from: t2.id, to: c4.id, type: 'tree', seq: 0 },
      { from: c1.id, to: c2.id, type: 'prereq' },
      { from: c2.id, to: c3.id, type: 'prereq' },
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
          useId() { return 'w2-id'; },
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

test('ForecastInkTide math: monotone cubic Hermite spline never dips below baseline on 0-due troughs', () => {
  const baselineY = 192;
  const pts = [
    { x: 40, y: 80 },
    { x: 80, y: 192 },
    { x: 120, y: 192 },
    { x: 160, y: 60 },
    { x: 200, y: 192 },
    { x: 240, y: 120 },
  ];
  const d = m.monotoneSplinePath(pts, { minY: 22, maxY: baselineY });
  assert.match(d, /^M40 80 C/);
  // Extract every y coordinate from M/C commands and confirm none exceed baselineY (never below zero)
  const ys = [...d.matchAll(/(?:M|C|,)\s*[-\d.]+\s+([-\d.]+)/g)].map((hit) => Number(hit[1]));
  assert.ok(ys.length >= 6);
  for (const yVal of ys) {
    assert.ok(yVal <= baselineY + 0.01 && yVal >= 22 - 0.01, `y=${yVal} stays cleanly inside [22, ${baselineY}]`);
  }

  const area = m.monotoneAreaPath(pts, baselineY, { minY: 22, maxY: baselineY });
  assert.match(area, /L240 192 L40 192 Z$/);

  const forecast = makeForecast([4, 0, 0, 0, 11, 2, 0, 0, 3, 0, 0, 0, 0, 1]);
  const rhythm = m.summarizeTideRhythm(forecast.days);
  assert.equal(rhythm.peakIndex, 4);
  assert.equal(rhythm.peakCount, 11);
  assert.equal(rhythm.calmLength, 4);
  assert.equal(rhythm.calmStartIndex, 9);

  const strokes1 = m.buildPeakHatchStrokes(pts[3], baselineY, { accent: '#c93d22', inkMuted: '#a59d91' }, roughGen, 42);
  const strokes2 = m.buildPeakHatchStrokes(pts[3], baselineY, { accent: '#c93d22', inkMuted: '#a59d91' }, roughGen, 42);
  assert.deepEqual(strokes1, strokes2, 'roughjs peak hatch strokes are deterministic');
  assert.ok(strokes1.length >= 4);
});

test('ForecastPanel: defaults to bar view, toggles to Ink Tide, launches day review on click, and translates to English without Han', () => {
  const forecast = makeForecast([6, 0, 0, 0, 10, 0, 2, 0, 0, 4, 0, 0, 1, 0]);
  const barHtml = renderToStaticMarkup(React.createElement(m.ForecastPanel, { forecast, onStart: () => {} }));
  assert.match(barHtml, /aria-pressed="true"[^>]*>柱状<\/button>/);
  assert.match(barHtml, /墨潮<\/button>/);
  assert.doesNotMatch(barHtml, /data-testid="forecast-ink-tide"/);

  const started = [];
  const hookStore = new Map();
  const props = { forecast, onStart: (cards) => started.push(cards), roughGenerator: roughGen };
  const tree1 = renderTree(React.createElement(m.ForecastPanel, props), hookStore);
  const tideBtn = findAll(tree1, (n) => n.type === 'button' && textOf(n) === '墨潮')[0];
  assert.ok(tideBtn, 'located Ink Tide view toggle');
  tideBtn.props.onClick();

  const tree2 = renderTree(React.createElement(m.ForecastPanel, props), hookStore);
  const tideWrap = findAll(tree2, (n) => n.props?.['data-testid'] === 'forecast-ink-tide')[0];
  assert.ok(tideWrap, 'renders ForecastInkTide after toggling to 墨潮');
  const insight = findAll(tree2, (n) => n.props?.['data-testid'] === 'forecast-tide-insight')[0];
  assert.match(textOf(insight), /峰期：10\/6（10 题）/);
  assert.match(textOf(insight), /留白窗口：10\/3 起连歇 3 天/);

  const peakNode = findAll(tree2, (n) => n.type === 'g' && n.props?.['data-tide-day'] === '2026-10-06')[0];
  assert.ok(peakNode && peakNode.props.role === 'button');
  peakNode.props.onClick();
  assert.equal(started.length, 1);
  assert.equal(started[0].length, 10);

  const tideHtml = renderToStaticMarkup(React.createElement(m.ForecastPanel, { forecast, onStart: () => {}, defaultView: 'tide', roughGenerator: roughGen }));
  assert.doesNotMatch(tideHtml, /掌握度/, 'Forecast Ink Tide never outputs forbidden 掌握度 on Dashboard');

  try {
    m.setUiLanguage('en');
    const enHtml = renderToStaticMarkup(React.createElement(m.ForecastPanel, { forecast, onStart: () => {}, defaultView: 'tide', roughGenerator: roughGen }));
    assert.match(enHtml, /Ink tide/);
    assert.match(enHtml, /Peak:/);
    assert.match(enHtml, /Calm stretch:/);
    assert.doesNotMatch(enHtml.replace(/<[^>]+>/g, ' '), HAN, 'English Forecast Ink Tide contains zero Han characters');
  } finally {
    m.setUiLanguage('zh');
  }
});

test('Wave 3 ForecastPanel integer Y-axis: niceIntTicks eliminates fractional card ticks for small counts', () => {
  assert.deepEqual(m.niceIntTicks(0, 4), [0, 1]);
  assert.deepEqual(m.niceIntTicks(1, 4), [0, 1]);
  assert.deepEqual(m.niceIntTicks(2, 4), [0, 1, 2]);
  assert.deepEqual(m.niceIntTicks(3, 4), [0, 1, 2, 3]);
  assert.deepEqual(m.niceIntTicks(4, 4), [0, 1, 2, 3, 4]);
  assert.deepEqual(m.niceIntTicks(5, 4), [0, 2, 4, 6]);
  assert.deepEqual(m.niceIntTicks(23, 4), [0, 10, 20, 30]);
  for (let max = 0; max <= 50; max++) {
    const ticks = m.niceIntTicks(max, 4);
    assert.equal(ticks[0], 0);
    assert.ok(ticks.at(-1) >= Math.max(1, max));
    assert.ok(ticks.every((t) => Number.isInteger(t)), `niceIntTicks(${max}) yields integers only`);
  }

  const smallForecast = makeForecast([2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (const view of ['bar', 'tide']) {
    const html = renderToStaticMarkup(React.createElement(m.ForecastPanel, {
      forecast: smallForecast,
      onStart: () => {},
      defaultView: view,
      roughGenerator: roughGen,
    }));
    const yLabels = [...html.matchAll(/class="(?:dash-axis|forecast-tide__axis)"[^>]*text-anchor="end"[^>]*>([^<]+)<\/text>/g)].map((hit) => hit[1]);
    assert.deepEqual(yLabels, ['0', '1', '2'], `${view} view renders integer-only Y-axis labels for max=2`);
    assert.doesNotMatch(html, />0\.5<\/text>/);
    assert.doesNotMatch(html, />1\.5<\/text>/);
  }
});

test('graph-sketch: computeLineage traces multi-hop prerequisite chains safely and roughjs sketch geometry + SVG export are deterministic', () => {
  const data = sampleGraphData();
  const layout = m.layoutStructure(data.nodes, data.edges);
  const c2Id = `card:${JSON.stringify(['d1', 'c2'])}`;
  const c1Id = `card:${JSON.stringify(['d1', 'c1'])}`;
  const c3Id = `card:${JSON.stringify(['d1', 'c3'])}`;
  const c4Id = `card:${JSON.stringify(['d1', 'c4'])}`;

  const lineage = m.computeLineage(layout, c2Id, 'structure');
  assert.ok(lineage);
  assert.equal(lineage.upstreamCount, 1);
  assert.equal(lineage.downstreamCount, 1);
  assert.ok(lineage.connectedNodes.has(c1Id), 'upstream prerequisite included');
  assert.ok(lineage.connectedNodes.has(c3Id), 'downstream dependent included');
  assert.ok(lineage.connectedNodes.has('deck:d1'), 'parent deck included');
  assert.equal(lineage.connectedNodes.has(c4Id), false, 'unrelated card excluded from spotlight');
  assert.ok(lineage.highlightedEdges.has(m.edgeKey('prereq', c1Id, c2Id)));
  assert.ok(lineage.highlightedEdges.has(m.edgeKey('prereq', c2Id, c3Id)));

  // Cycle safety check
  const cyclicLayout = {
    posOf: new Map([['a', {}], ['b', {}]]),
    prereqEdges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
    treeEdges: [],
  };
  const cyc = m.computeLineage(cyclicLayout, 'a', 'structure');
  assert.equal(cyc.connectedNodes.size, 2);

  // Deterministic roughjs node & edge sketch strokes
  const palette = { ok: '#5fb58a', warn: '#d9a441', bad: '#d76c93', decorFaint: '#6f685e', lineStrong: '#4a443c', accent: '#c93d22', paper: '#1e1b18', ink: '#efe9df', inkMuted: '#a59d91', inkFaint: '#958e84', line: '#332f2a', isLight: false };
  const deckPlaced = layout.placed.find((p) => p.kind === 'deck');
  const s1 = m.sketchNodePaths(deckPlaced, 'mastered', palette, roughGen);
  const s2 = m.sketchNodePaths(deckPlaced, 'mastered', palette, roughGen);
  assert.deepEqual(s1, s2);
  assert.ok(s1.length >= 2, 'deck node renders double-ink frame + hachure');
  assert.ok(s1[0].opacity <= 0.28, 'hachure fill opacity stays gentle behind card labels');

  const edge1 = m.sketchBezierEdge(10, 20, 140, 80, 'prereq', palette, roughGen, 77);
  const edge2 = m.sketchBezierEdge(10, 20, 140, 80, 'prereq', palette, roughGen, 77);
  assert.deepEqual(edge1, edge2);
  assert.equal(edge1[0].dashArray, '5 4');

  // Standalone SVG export wraps XML, concrete background, and embedded theme stylesheet
  const xml = m.serializeGraphSvg('<svg viewBox="0 0 600 400"><rect class="gn-node gn-mastered" width="40" height="20" /></svg>', { width: 600, height: 400, palette });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(xml, /<style>[\s\S]*\.gn-mastered[\s\S]*<\/style>/);
  assert.match(xml, /<rect width="600" height="400" fill="#1e1b18" \/>/);
});

test('Graph: toggles crisp/sketch mode, illuminates prerequisite lineage spotlight, exposes Export SVG, and translates cleanly to English', () => {
  const data = sampleGraphData();
  const c2Key = `card:${JSON.stringify(['d1', 'c2'])}`;
  const c4Key = `card:${JSON.stringify(['d1', 'c4'])}`;

  const crispHtml = renderToStaticMarkup(React.createElement(m.Graph, {
    library: { root: 'g-w2', focus: { course: '*' } },
    initialData: data,
    onClose: () => {},
  }));
  assert.match(crispHtml, /data-graph-style="crisp"/);
  assert.match(crispHtml, /手绘墨线/);
  assert.match(crispHtml, /导出 SVG/);

  // Interactive spotlight + switch to sketch mode
  const hookStore = new Map();
  const props = {
    library: { root: 'g-w2', focus: { course: '*' } },
    initialData: data,
    onClose: () => {},
    onStudyCard: () => {},
    roughGenerator: roughGen,
  };
  const tree1 = renderTree(React.createElement(m.Graph, props), hookStore);
  const c2Node = findAll(tree1, (n) => n.type === 'g' && n.props?.['data-node-key'] === c2Key)[0];
  assert.ok(c2Node, 'located DP Recurrence card node');
  c2Node.props.onMouseEnter();

  const tree2 = renderTree(React.createElement(m.Graph, props), hookStore);
  const c4NodeAfterHover = findAll(tree2, (n) => n.type === 'g' && n.props?.['data-node-key'] === c4Key)[0];
  const c2NodeAfterHover = findAll(tree2, (n) => n.type === 'g' && n.props?.['data-node-key'] === c2Key)[0];
  assert.match(c4NodeAfterHover.props.className, /gn-spotlight-dim/, 'unrelated node dims under spotlight');
  assert.doesNotMatch(c2NodeAfterHover.props.className, /gn-spotlight-dim/, 'focused node stays bright');
  const lineageHint = findAll(tree2, (n) => n.props?.['data-testid'] === 'graph-lineage-hint')[0];
  assert.match(textOf(lineageHint), /前置 1 项 · 后续 1 项/);

  // Toggle to sketch mode
  const sketchBtn = findAll(tree2, (n) => n.type === 'button' && textOf(n) === '手绘墨线')[0];
  assert.ok(sketchBtn);
  sketchBtn.props.onClick();

  const tree3 = renderTree(React.createElement(m.Graph, props), hookStore);
  const section = findAll(tree3, (n) => n.type === 'section' && n.props?.['data-graph-style'])[0];
  assert.equal(section.props['data-graph-style'], 'sketch');
  const sketchNodes = findAll(tree3, (n) => n.type === 'g' && n.props?.className === 'graph-sketch-node');
  assert.equal(sketchNodes.length, data.nodes.length, 'every placed node renders hand-drawn roughjs frame');

  // English localization check (zero Han outside user data)
  try {
    m.setUiLanguage('en');
    const enHtml = renderToStaticMarkup(React.createElement(m.Graph, {
      library: { root: 'g-w2', focus: { course: '*' } },
      initialData: data,
      defaultStyle: 'sketch',
      roughGenerator: roughGen,
      onClose: () => {},
    }));
    assert.match(enHtml, /Hand-drawn ink/);
    assert.match(enHtml, /Export SVG/);
    assert.doesNotMatch(enHtml.replace(/<[^>]+>/g, ' '), HAN, 'English Graph sketch view has zero Han characters');
  } finally {
    m.setUiLanguage('zh');
  }
});

test('Wave 2 stylesheets (forecast-tide.css, graph-sketch.css) satisfy all token, weight, and motion guardrails', async () => {
  // Repo-wide layer/scope and raw-colour guards also run in tests/css-layers.test.mjs,
  // tests/css-token-guard.test.mjs, and tests/ui-guardrails.test.mjs. Here we verify the
  // Wave 2 feature sheets' @layer study.features placement, reduced-motion rules, token bans, and spotlight dim opacities.
  const splitSelectors = (sel) => sel.split(/,(?![^(]*\))/).map((s) => s.trim());
  const parsed = new Map();
  for (const rel of ['../ui/charts/forecast-tide.css', '../ui/graph-sketch/graph-sketch.css']) {
    const ast = parseCss(await readFile(new URL(rel, import.meta.url), 'utf8'));
    parsed.set(rel, ast);
    const { declarations, blocks } = ast;
    assert.ok(declarations.length > 0, `${rel} declares styles`);
    assert.equal(blocks.some((b) => b.prelude === '@layer study.features'), true, `${rel} belongs to @layer study.features`);
    assert.equal(declarations.every((d) => d.ctx.includes('@layer study.features')), true, `${rel} keeps every declaration inside @layer study.features`);
    assert.equal(
      blocks.some((b) => /@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(b.prelude))
        && declarations.some(
          (d) => d.ctx.some((c) => /prefers-reduced-motion:\s*reduce/.test(c))
            && d.prop === 'transition'
            && d.value === 'none',
        ),
      true,
      `${rel} disables transitions under prefers-reduced-motion: reduce`,
    );
    assert.equal(
      declarations.some(
        (d) => d.ctx.some((c) => /\[data-motion=["']reduced["']\]/.test(c))
          && d.prop === 'transition'
          && d.value === 'none',
      ),
      true,
      `${rel} disables transitions under data-motion="reduced"`,
    );
    assert.deepEqual(
      declarations.filter((d) => /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/i.test(d.value)),
      [],
      `${rel} uses token-only colours`,
    );
    assert.deepEqual(declarations.filter((d) => /\bvar\(\s*--fw-strong\b/.test(d.value)), [], `${rel} avoids --fw-strong`);
    assert.deepEqual(declarations.filter((d) => /\bvar\(\s*--fs-xs\b/.test(d.value)), [], `${rel} avoids --fs-xs`);
    assert.deepEqual(declarations.filter((d) => /\bvar\(\s*--paper\s*[,)]/.test(d.value)), [], `${rel} avoids --paper`);
    assert.deepEqual(declarations.filter((d) => /\bvar\(\s*--shadow-(?:card|sm)\b/.test(d.value)), [], `${rel} avoids --shadow-card and --shadow-sm`);
    assert.deepEqual(declarations.filter((d) => d.important), [], `${rel} avoids !important`);
  }
  const graphDecls = parsed.get('../ui/graph-sketch/graph-sketch.css').declarations;
  const isDefaultRule = (d, selector) => (
    splitSelectors(d.ctx.at(-1) || '').includes(selector)
    && !d.ctx.some((c) => c.startsWith('@media'))
  );
  assert.equal(
    graphDecls.some((d) => isDefaultRule(d, '.gn-spotlight-dim') && d.prop === 'opacity' && d.value === '0.42'),
    true,
    '.gn-spotlight-dim sets opacity: 0.42',
  );
  assert.equal(
    graphDecls.some((d) => isDefaultRule(d, '.gn-spotlight-edge-dim') && d.prop === 'opacity' && d.value === '0.24'),
    true,
    '.gn-spotlight-edge-dim sets opacity: 0.24',
  );
});
