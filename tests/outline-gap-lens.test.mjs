import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { dom } from './helpers/usage-dom.mjs';

const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
const mountSync = (element) => {
  const previous = internals.H;
  let stateIndex = 0;
  const states = [], effects = [];
  const hookDispatcher = {
    useState(initial) {
      const idx = stateIndex++;
      if (!(idx in states)) states[idx] = typeof initial === 'function' ? initial() : initial;
      return [states[idx], (next) => { states[idx] = typeof next === 'function' ? next(states[idx]) : next; renderNow(); }];
    },
    useEffect(fn) { effects.push(fn); },
    useInsertionEffect() {},
    useLayoutEffect() {},
    useMemo(fn) { return fn(); },
    useCallback(fn) { return fn; },
    useRef(initial) {
      const idx = stateIndex++;
      if (!(idx in states)) states[idx] = { current: initial };
      return states[idx];
    },
    useContext(ctx) { return ctx._currentValue; },
    useId() { return 'gap-id'; },
    useMemoCache(size) {
      const idx = stateIndex++;
      if (!(idx in states)) states[idx] = new Array(size);
      return states[idx];
    },
  };
  let tree = null;
  const renderNow = () => {
    stateIndex = 0;
    const prevH = internals.H;
    internals.H = hookDispatcher;
    try { tree = element.type(element.props); } finally { internals.H = prevH; }
    return tree;
  };
  try { renderNow(); } finally { internals.H = previous; }
  return { getTree: () => tree, rerender: () => renderNow() };
};

const walkElements = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(item => walkElements(item, visit)); return; }
  visit(node);
  if (node.props?.children !== undefined) walkElements(node.props.children, visit);
};

const findElements = (node, predicate) => {
  const hits = [];
  walkElements(node, (item) => { if (predicate(item)) hits.push(item); });
  return hits;
};

const ui = await loadUi(`
  export { default as CourseOutline, CourseOutlineView } from './ui/outline/CourseOutline.jsx';
  export * from './ui/outline/gap-lens.js';
  export * from './ui/outline/model.js';
  export { default as PracticePane } from './ui/settings/PracticePane.jsx';
  export * from './lib/practice-settings.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { ToastContext } from './ui/components/Feedback.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);

const h = React.createElement;
const noop = () => {};
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const toastApi = { success: noop, info: noop, error: noop, warn: noop };
const renderWithServices = (el) => renderToStaticMarkup(
  h(ui.StudyServicesContext.Provider, { value: services }, h(ui.ToastContext.Provider, { value: toastApi }, el)),
);
const textOf = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const summary = ({ total = 0, weak = 0, due = 0, draftCards = 0 } = {}) => ({
  total, counts: { new: Math.max(0, total - weak), weak, learning: 0, familiar: 0, mastered: 0 }, due, weak, fresh: 0, inactive: 0,
  percent: total ? 50 : null, state: total ? 'learning' : 'none', ...(draftCards > 0 ? { draftCards } : {}),
});

const bookOutline = {
  status: 'ok', course: 'Physics', total: 5, placed: 4, summary: summary({ total: 5, weak: 1, due: 1 }), draftCards: 1, limit: 200,
  decks: [{ id: 'd1', title: 'Mechanics', total: 5 }], deckId: null,
  documents: [{ key: 'doc:1', title: 'ch1.pdf', total: 5, summary: summary({ total: 5, weak: 1, due: 1 }) }],
  book: {
    id: 'b1', title: 'Physics', createdAt: null, orderBasis: { codes: ['logic'] }, papers: 0, paperList: [],
    stale: false, counts: { chapters: 2, points: 3 }, notes: null,
    parts: [{ id: 'c1', title: 'Kinematics', points: 2, written: 0 }, { id: 'c2', title: 'Optics', points: 0, written: 0, pending: true }],
    nodes: [
      {
        key: 'bk:c1', id: 'c1', depth: 1, title: 'Kinematics', total: 4, summary: summary({ total: 4, weak: 1, due: 1 }), deckCount: 1,
        children: [
          { key: 'bk:p1', id: 'p1', depth: 2, title: 'Velocity', total: 2, summary: summary({ total: 2, weak: 1, due: 0 }), deckCount: 1 },
          { key: 'bk:p2', id: 'p2', depth: 2, title: 'Acceleration', total: 0, summary: summary({ total: 0 }), deckCount: 0 },
          { key: 'bk:p3', id: 'p3', depth: 2, title: 'Drafted Jerk', total: 0, summary: summary({ total: 0, draftCards: 1 }), deckCount: 0 },
        ],
      },
      { key: 'pending:c2', id: 'c2', depth: 1, title: 'Optics', children: [], pending: true, pages: 12, total: 0, summary: summary({ total: 0 }), deckCount: 0 },
    ],
    other: { key: 'bk:other', id: 'other', depth: 1, title: '其他', total: 0, summary: summary({ total: 0 }), deckCount: 0 },
  },
  unplaced: { key: 'unplaced', total: 1, summary: summary({ total: 1, due: 1 }), reasons: { none: 1, uncategorised: 0, elsewhere: 0, missing: 0 }, materials: [] },
  open: {},
};

const baseActions = {
  onBack: noop, onCreate: noop, onOpenSources: noop, retry: noop, toggle: noop, onPick: noop, onPickCard: noop,
  onPracticeRow: noop, clearPick: noop, practisePicked: noop, chooseDeck: noop,
};

test('outlineGapLens stays optional outside PRACTICE_DEFAULTS and validates strictly', () => {
  assert.equal(Object.hasOwn(ui.PRACTICE_DEFAULTS, 'outlineGapLens'), false);
  assert.equal(ui.outlineGapLens(undefined), false);
  assert.equal(ui.outlineGapLens({}), false);
  assert.equal(ui.outlineGapLens({ outlineGapLens: true }), true);
  assert.deepEqual(ui.mergePracticeSettings(undefined, { outlineGapLens: true }), { ...ui.PRACTICE_DEFAULTS, outlineGapLens: true });
  assert.deepEqual(ui.mergePracticeSettings({ outlineGapLens: true }, { outlineGapLens: null }), ui.PRACTICE_DEFAULTS);
  assert.throws(() => ui.validatePracticePatch({ outlineGapLens: 'yes' }), /outlineGapLens/);
});

test('collectOutlineGapStats & filterOutlineWithLens target lowest semantic gap units without double-counting, drafts, or pending nodes', () => {
  const stats = ui.collectOutlineGapStats(bookOutline, {});
  assert.deepEqual(stats.weakOrDueKeys, ['bk:p1', 'unplaced']);
  assert.equal(stats.weakOrDueCount, 2);
  assert.equal(stats.untestedCount, 1);

  const open = new Set();
  const weakFiltered = ui.filterOutlineWithLens(bookOutline, {}, open, '', 'weak-due', stats);
  assert.deepEqual(weakFiltered.rows.map(row => row.key), ['bk:c1', 'bk:p1', 'unplaced']);
  assert.equal(open.size, 0, 'caller fold Set must never be mutated');

  const untestedFiltered = ui.filterOutlineWithLens(bookOutline, {}, open, '', 'untested', stats);
  assert.deepEqual(untestedFiltered.rows.map(row => row.key), ['bk:c1', 'bk:p2']);

  const composedEmpty = ui.filterOutlineWithLens(bookOutline, {}, open, 'Velocity', 'untested', stats);
  assert.deepEqual(composedEmpty.rows, []);

  // Raw documents mode: expanded document uses chapter keys instead of pulling sibling healthy chapters
  const rawOutline = {
    status: 'ok', course: 'CS', total: 3, placed: 3, summary: summary({ total: 3, weak: 1 }), draftCards: 0, limit: 200,
    decks: [], deckId: null,
    documents: [
      { key: 'doc:big', title: 'Systems.pdf', format: 'pdf', chapters: 2, total: 3, summary: summary({ total: 3, weak: 1 }), deckCount: 1 },
      { key: 'doc:empty', title: 'Slides.pdf', format: 'pdf', chapters: 0, total: 0, summary: summary({ total: 0 }), deckCount: 0 },
    ],
    unplaced: { key: 'unplaced', total: 0, summary: summary(), reasons: {}, materials: [] },
  };
  const rawDetails = {
    'doc:big': {
      chapters: [
        { key: 'doc:big#0', kind: 'chapter', title: 'Healthy Ch1', total: 2, summary: summary({ total: 2, weak: 0, due: 0 }) },
        { key: 'doc:big#1', kind: 'chapter', title: 'Weak Ch2', total: 1, summary: summary({ total: 1, weak: 1, due: 0 }) },
        { key: 'doc:big#2', kind: 'chapter', title: 'Zero Ch3', total: 0, summary: summary({ total: 0 }) },
      ],
    },
  };
  const rawStats = ui.collectOutlineGapStats(rawOutline, rawDetails);
  assert.deepEqual(rawStats.weakOrDueKeys, ['doc:big#1']);
  assert.equal(rawStats.untestedCount, 2);

  // Expanded multi-material leaves (opensRows: true) and book.other preserve child anchor/chapter rows under active gap filter and search
  const opensRowsOutline = {
    status: 'ok', course: 'Bio', total: 3, placed: 3, summary: summary({ total: 3, weak: 1 }), draftCards: 0, limit: 200,
    decks: [], deckId: null, documents: [],
    book: {
      id: 'b2', title: 'Bio', createdAt: null, orderBasis: { codes: ['logic'] }, papers: 0, paperList: [],
      stale: false, counts: { chapters: 1, points: 2 }, notes: null,
      nodes: [{
        key: 'bk:sec1', id: 'sec1', depth: 1, title: 'Cells', total: 2, summary: summary({ total: 2, weak: 1 }), deckCount: 1,
        children: [
          { key: 'bk:p1', id: 'p1', depth: 2, title: 'Membrane', total: 2, opensRows: true, summary: summary({ total: 2, weak: 1 }), deckCount: 1 },
          { key: 'bk:p2', id: 'p2', depth: 2, title: 'Organelles', total: 0, opensRows: true, summary: summary({ total: 0 }), deckCount: 0 },
        ],
      }],
      other: { key: 'bk:other', id: 'other', depth: 1, title: '其他', total: 1, opensRows: true, summary: summary({ total: 1, due: 1 }), deckCount: 1 },
    },
    unplaced: { key: 'unplaced', total: 0, summary: summary(), reasons: {}, materials: [] },
  };
  const opensRowsDetails = {
    'bk:p1': { anchors: [{ key: 'doc:a', kind: 'document', title: 'Doc Alpha', format: 'pdf', chapters: 1, total: 2, summary: summary({ total: 2, weak: 1 }), deckCount: 1 }, { key: 'doc:b', kind: 'document', title: 'Doc Beta', format: 'pdf', chapters: 0, total: 0, summary: summary(), deckCount: 0 }] },
    'doc:a': { chapters: [{ key: 'doc:a#0', kind: 'chapter', index: 0, title: 'Lipid Bilayer', level: 1, total: 2, summary: summary({ total: 2, weak: 1 }), deckCount: 1 }] },
    'bk:p2': { anchors: [{ key: 'doc:c', kind: 'document', title: 'Doc Gamma', format: 'md', chapters: 0, total: 0, summary: summary(), deckCount: 0 }] },
    'bk:other': { anchors: [{ key: 'doc:o1', kind: 'document', title: 'Appendix', format: 'md', chapters: 0, total: 1, summary: summary({ total: 1, due: 1 }), deckCount: 1 }] },
  };
  const openAll = new Set(['bk:sec1', 'bk:p1', 'doc:a', 'bk:p2', 'bk:other']);
  const openStats = ui.collectOutlineGapStats(opensRowsOutline, opensRowsDetails);
  assert.deepEqual(openStats.weakOrDueKeys, ['bk:p1', 'bk:other']);
  assert.equal(openStats.untestedCount, 1);
  assert.deepEqual(ui.filterOutlineWithLens(opensRowsOutline, opensRowsDetails, openAll, '', 'weak-due', openStats).rows.map(r => r.key), ['bk:sec1', 'bk:p1', 'doc:a', 'doc:a#0', 'doc:b', 'bk:other', 'doc:o1']);
  assert.deepEqual(ui.filterOutlineWithLens(opensRowsOutline, opensRowsDetails, openAll, '', 'untested', openStats).rows.map(r => r.key), ['bk:sec1', 'bk:p2', 'doc:c']);
  assert.deepEqual(ui.filterOutlineWithLens(opensRowsOutline, opensRowsDetails, openAll, 'Doc Alpha', 'weak-due', openStats).rows.map(r => r.key), ['bk:sec1', 'bk:p1', 'doc:a', 'doc:a#0', 'doc:b']);
  assert.deepEqual(ui.filterOutlineWithLens(opensRowsOutline, opensRowsDetails, openAll, 'Appendix', 'untested', openStats).rows, []);
  assert.equal(ui.canGenerateRow({ kind: 'pending', node: { pending: true, total: 0 } }), false);
  assert.equal(ui.canGenerateRow({ kind: 'point', node: { total: 0, summary: { draftCards: 1 } } }), false);
  assert.equal(ui.canGenerateRow({ kind: 'point', node: { total: 0, summary: { draftCards: 0 } } }), true);
});

test('CourseOutlineView renders zero extra DOM when gapLensEnabled is false, and renders gap bar + 去出题 cleanly when enabled (ZH & EN)', () => {
  const disabledHtml = renderWithServices(h(ui.CourseOutlineView, {
    course: 'Physics', outline: bookOutline, details: {}, open: new Set(['bk:c1']), pick: ui.emptyPick(),
    actions: { ...baseActions, onPracticeWeakDue: noop, onGoGenerateRow: noop },
  }));
  assert.doesNotMatch(disabledHtml, /outline-gap-bar/);
  assert.doesNotMatch(textOf(disabledHtml), /去出题|专练薄弱与到期|薄弱与到期|尚无题目/);

  const enabledHtml = renderWithServices(h(ui.CourseOutlineView, {
    course: 'Physics', outline: bookOutline, details: {}, open: new Set(['bk:c1']), pick: ui.emptyPick(), gapLensEnabled: true,
    actions: { ...baseActions, onPracticeWeakDue: noop, onGoGenerateRow: noop },
  }));
  const enabledText = textOf(enabledHtml);
  assert.match(enabledText, /全部/);
  assert.match(enabledText, /薄弱与到期 \(2\)/);
  assert.match(enabledText, /尚无题目 \(1\)/);
  assert.match(enabledText, /专练薄弱与到期 \(2 处\)/);
  assert.match(enabledText, /Acceleration.*去出题/);
  assert.doesNotMatch(enabledText, /Optics.*去出题/);
  assert.doesNotMatch(enabledText, /Drafted Jerk.*去出题/);
  assert.equal(dom(enabledHtml).all.filter(node => (node.getAttribute('class') || '').includes('sh-btn--primary')).length, 1);

  ui.setUiLanguage('en');
  try {
    const enHtml = renderWithServices(h(ui.CourseOutlineView, {
      course: 'Physics', outline: bookOutline, details: {}, open: new Set(['bk:c1']), pick: ui.emptyPick(), gapLensEnabled: true,
      actions: { ...baseActions, onPracticeWeakDue: noop, onGoGenerateRow: noop },
    }));
    const enText = textOf(enHtml);
    assert.doesNotMatch(enText.replace(/其他/g, ''), /[㐀-鿿]/);
    assert.match(enText, /All/);
    assert.match(enText, /Weak &amp; due \(2\)|Weak & due \(2\)/);
    assert.match(enText, /No questions yet \(1\)/);
    assert.match(enText, /Practise weak & due \(2 sections\)/);
    assert.match(enText, /Generate questions/);
  } finally {
    ui.setUiLanguage('zh');
  }
});

test('interactive lens switching, 专练薄弱与到期, 去出题, and PracticePane toggle persistence', async () => {
  const calls = [];
  const viewActions = {
    ...baseActions,
    onPracticeWeakDue: (keys) => calls.push(['practiceWeakDue', keys]),
    onGoGenerateRow: (row) => calls.push(['generateRow', row.key]),
  };
  let mounted;
  ui.setUiLanguage('en');
  try {
    mounted = mountSync(h(ui.CourseOutlineView, {
      course: 'Physics', outline: bookOutline, details: {}, open: new Set(), pick: ui.emptyPick(), gapLensEnabled: true, actions: viewActions,
    }));
    const segs = findElements(mounted.getTree(), el => el.type?.name === 'SegmentedControl');
    assert.equal(segs.length, 1);

    segs[0].props.onChange('untested');
    let trees = findElements(mounted.getTree(), el => el.type?.name === 'OutlineTree');
    assert.deepEqual(trees[0].props.rows.map(r => r.key), ['bk:c1', 'bk:p2']);

    const treeMount = mountSync(trees[0]);
    const rowEl = findElements(treeMount.getTree(), el => el.props?.row?.key === 'bk:p2')[0];
    assert.ok(rowEl);
    const RowFn = typeof rowEl.type === 'function' ? rowEl.type : rowEl.type.type;
    const p2Row = mountSync(h(RowFn, rowEl.props));
    const genBtn = findElements(p2Row.getTree(), el => el.props?.className === 'outline-row__generate')[0];
    assert.equal(genBtn.props.iconEnd, 'arrow-right');
    assert.equal(genBtn.props.variant, 'link');
    genBtn.props.onClick();

    segs[0].props.onChange('weak-due');
    trees = findElements(mounted.getTree(), el => el.type?.name === 'OutlineTree');
    assert.deepEqual(trees[0].props.rows.map(r => r.key), ['bk:c1', 'bk:p1', 'unplaced']);

    const drillBtn = findElements(mounted.getTree(), el => el.props?.className === 'outline-gap-bar__practice')[0];
    drillBtn.props.onClick();
    assert.deepEqual(calls, [
      ['generateRow', 'bk:p2'],
      ['practiceWeakDue', ['bk:p1', 'unplaced']],
    ]);

    // Filter with matching query that misses all untested rows recovers via Show all without trap
    mounted = mountSync(h(ui.CourseOutlineView, {
      course: 'Physics', outline: bookOutline, details: {}, open: new Set(['bk:c1']), pick: ui.emptyPick(), gapLensEnabled: true,
      filterQuery: 'Velocity', gapFilter: 'untested',
      actions: { ...viewActions, onGapFilterChange: (next) => calls.push(['lens', next]) },
    }));
    const recoverBtn = findElements(mounted.getTree(), el => el.props?.children === 'Show all' && typeof el.props?.onClick === 'function')[0];
    recoverBtn.props.onClick();
    assert.deepEqual(calls[2], ['lens', 'all']);
  } finally {
    ui.setUiLanguage('zh');
  }

  // PracticePane switch dispatches true/null without altering PRACTICE_DEFAULTS reset check
  const actionsSent = [];
  const pane = mountSync(h(ui.PracticePane, {
    data: { settings: {} },
    busy: false,
    act: async (action, args) => { actionsSent.push([action, args]); },
  }));
  const gapSwitch = findElements(pane.getTree(), el => el.props?.name === 'outlineGapLens')[0];
  assert.equal(gapSwitch.props.checked, false);
  await gapSwitch.props.onChange(true);
  await gapSwitch.props.onChange(false);
  assert.deepEqual(actionsSent, [
    ['settings.practice.set', { patch: { outlineGapLens: true } }],
    ['settings.practice.set', { patch: { outlineGapLens: null } }],
  ]);
});
