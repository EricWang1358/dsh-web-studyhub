import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MATERIAL_SCOPE_LIMIT,
  compareMaterialReview,
  pickPracticeRefs,
  reviewUrgencyOf,
} from '../lib/contexts/materials/material-practice.js';
import { loadUi } from './helpers/ui-module.mjs';
import { withOpenSourcesTools } from './helpers/sources-tools.mjs';

const m = await loadUi(`
  export { default as Sources, RowMenuItems } from './ui/Sources.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { ToastContext } from './ui/components/index.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

test('reviewUrgencyOf keeps overlapping weak and due metrics separate without double-counting', () => {
  const overlap = reviewUrgencyOf({ total: 10, weak: 3, due: 4, fresh: 2, draftCards: 1, percent: 45 });
  assert.deepEqual(overlap, { total: 10, weak: 3, due: 4, fresh: 2, draftCards: 1, percent: 45, hasUrgent: true });
  const none = reviewUrgencyOf({ percent: Number.NaN });
  assert.equal(none.hasUrgent, false);
  assert.equal(none.percent, null);
});

test('compareMaterialReview ranks urgent materials before unmastered, draft-only, mastered, and empty docs', () => {
  const mastery = {
    empty: { document: { total: 0, weak: 0, due: 0, percent: null, state: 'none' } },
    mastered: { document: { total: 5, weak: 0, due: 0, percent: 90, state: 'mastered' } },
    draftOnly: { document: { total: 0, weak: 0, due: 0, draftCards: 4, percent: null, state: 'none' } },
    learning: { document: { total: 6, weak: 0, due: 0, percent: 50, state: 'learning' } },
    dueOnly: { document: { total: 8, weak: 0, due: 2, percent: 70, state: 'familiar' } },
    weakMost: { document: { total: 8, weak: 3, due: 1, percent: 40, state: 'learning' } },
  };
  const docs = [
    { key: 'empty', title: 'E', createdAt: '2026-10-05T00:00:00Z' },
    { key: 'mastered', title: 'M', createdAt: '2026-10-05T00:00:00Z' },
    { key: 'draftOnly', title: 'D', createdAt: '2026-10-05T00:00:00Z' },
    { key: 'learning', title: 'L', createdAt: '2026-10-05T00:00:00Z' },
    { key: 'dueOnly', title: 'U', createdAt: '2026-10-05T00:00:00Z' },
    { key: 'weakMost', title: 'W', createdAt: '2026-10-01T00:00:00Z' },
  ];
  const sorted = [...docs].sort((a, b) => compareMaterialReview(a, b, mastery, 'zh-CN')).map(d => d.key);
  assert.deepEqual(sorted, ['weakMost', 'dueOnly', 'learning', 'draftOnly', 'mastered', 'empty']);
});

test('pickPracticeRefs deduplicates, filters urgent cards, prefers active weak/due cards, and caps at 200', () => {
  const cards = [
    { deckId: 'd1', cardId: 'mastered-1', level: 'mastered', due: false, inactive: false },
    { deckId: 'd1', cardId: 'parked-weak', level: 'weak', due: false, inactive: true },
    { deckId: 'd1', cardId: 'active-due', level: 'familiar', due: true, inactive: false },
    { deckId: 'd1', cardId: 'active-weak', level: 'weak', due: true, inactive: false },
    // Duplicate card across links merges to higher urgency and active course:
    { deckId: 'd1', cardId: 'active-weak', level: 'familiar', due: false, inactive: true },
    ...Array.from({ length: 220 }, (_, i) => ({ deckId: 'd2', cardId: `new-${i}`, level: 'new', due: false, inactive: false })),
  ];

  const whole = pickPracticeRefs(cards);
  assert.equal(whole.totalUnique, 224);
  assert.equal(whole.capped, true);
  assert.equal(whole.refs.length, MATERIAL_SCOPE_LIMIT);
  assert.deepEqual(whole.refs.slice(0, 3), [
    { deckId: 'd1', cardId: 'active-weak' },
    { deckId: 'd1', cardId: 'parked-weak' },
    { deckId: 'd1', cardId: 'active-due' },
  ]);

  const urgent = pickPracticeRefs(cards, { only: 'urgent' });
  assert.equal(urgent.capped, false);
  assert.deepEqual(urgent.refs, [
    { deckId: 'd1', cardId: 'active-weak' },
    { deckId: 'd1', cardId: 'parked-weak' },
    { deckId: 'd1', cardId: 'active-due' },
  ]);
});

function walkTree(el) {
  if (el == null || typeof el !== 'object') return el;
  if (Array.isArray(el)) return el.map(walkTree);
  const fn = typeof el.type === 'function' ? el.type
    : el.type?.$$typeof === Symbol.for('react.memo') && typeof el.type.type === 'function' ? el.type.type
      : null;
  if (fn) {
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const prev = internals.H;
    const states = [], refs = [];
    let s = 0, r = 0;
    internals.H = {
      useState(init) { const i = s++; states[i] = typeof init === 'function' ? init() : init; return [states[i], () => {}]; },
      useRef(init) { const i = r++; refs[i] = { current: init }; return refs[i]; },
      useMemo(fnMemo) { return fnMemo(); },
      useCallback(fnCb) { return fnCb; },
      useEffect() {},
      useLayoutEffect() {},
      useInsertionEffect() {},
      useContext(ctx) { return ctx._currentValue; },
      useSyncExternalStore(_sub, getSnap) { return getSnap(); },
      useId() { return 'u-id'; },
      useMemoCache(n) { const i = s++; states[i] = new Array(n); return states[i]; },
    };
    try {
      return { ...el, props: { ...el.props, children: walkTree(fn(el.props)) } };
    } finally { internals.H = prev; }
  }
  if (el.type?.$$typeof === Symbol.for('react.forward_ref') && typeof el.type.render === 'function') {
    return { ...el, props: { ...el.props, children: walkTree(el.type.render(el.props, null)) } };
  }
  if (el.props && 'children' in el.props) return { ...el, props: { ...el.props, children: walkTree(el.props.children) } };
  return el;
}

function findNodes(tree, pred, out = []) {
  if (tree == null || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { for (const x of tree) findNodes(x, pred, out); return out; }
  if (pred(tree)) out.push(tree);
  if (tree.props && 'children' in tree.props) findNodes(tree.props.children, pred, out);
  return out;
}

const plainText = n => (n == null || typeof n === 'boolean') ? '' : Array.isArray(n) ? n.map(plainText).join('') : typeof n === 'object' ? plainText(n.props?.children) : String(n);

test('Sources renders 待巩固优先 sort, 只看待巩固 chip, neutral urgency badges, and document practice menu actions in zh and en', async () => {
  const data = {
    root: 'r',
    sources: [
      { id: 's1', title: 'DistributedConsensusNotes.md', text: 'Raft notes. '.repeat(20), createdAt: '2026-10-01T08:00:00.000Z', courses: ['CS'] },
      { id: 's2', title: 'MasteredNote.md', text: 'Basics. '.repeat(20), createdAt: '2026-10-02T08:00:00.000Z', courses: ['CS'] },
    ],
    decks: [],
    drafts: [],
    jobs: [],
    materialMastery: {
      'source:s1': { document: { total: 5, weak: 2, due: 3, fresh: 0, percent: 50, state: 'learning', counts: { new: 0, weak: 2, learning: 1, familiar: 2, mastered: 0 } }, pages: {}, chapters: {} },
      'source:s2': { document: { total: 4, weak: 0, due: 0, fresh: 0, percent: 95, state: 'mastered', counts: { new: 0, weak: 0, learning: 0, familiar: 0, mastered: 4 } }, pages: {}, chapters: {} },
    },
    focus: { course: '*', courses: [{ name: 'CS' }] },
  };
  const calls = [];
  const started = [];
  const events = [];
  let cardsToReturn = [
    { deckId: 'd1', cardId: 'c-mastered', level: 'mastered', due: false, inactive: false },
    { deckId: 'd1', cardId: 'c-weak', level: 'weak', due: true, inactive: false },
    ...Array.from({ length: 205 }, (_, i) => ({ deckId: 'd1', cardId: `c-extra-${i}`, level: 'new', due: false, inactive: false })),
  ];
  let practiceMode = 'resolve';
  const toast = {
    show(entry) { events.push({ kind: 'toast', entry }); },
    success(msg) { events.push({ kind: 'toast:success', msg }); },
    info(msg) { events.push({ kind: 'toast:info', msg }); },
    warning(msg) { events.push({ kind: 'toast:warning', msg }); },
    error(msg) { events.push({ kind: 'toast:error', msg }); },
    dismiss() {},
  };
  const onPractice = async (scope) => {
    started.push(scope);
    events.push({ kind: 'practice:call', len: scope.length });
    if (practiceMode === 'undefined') return undefined;
    if (practiceMode === 'reject') throw new Error('busy or archived');
    await Promise.resolve();
    events.push({ kind: 'nav:review' });
    return { id: 'run-1' };
  };
  const study = {
    busy: false,
    call: async () => ({}),
    act: async (name, args) => {
      calls.push({ name, args });
      if (name === 'materials.pages.cards') {
        return {
          status: 'ok',
          cards: cardsToReturn,
        };
      }
      return {};
    },
    notify: () => {},
    askInChat: () => {},
    host: {},
    openSettings: () => {},
    navigate: () => {},
    openModal: () => {},
  };

  m.setUiLanguage('zh');
  const prevStudy = m.StudyServicesContext._currentValue;
  const prevToast = m.ToastContext._currentValue;
  m.StudyServicesContext._currentValue = study;
  m.ToastContext._currentValue = toast;
  try {
    // The sort and 只看待巩固 are behind 「筛选与分组」, here left open.
    const zhHtml = withOpenSourcesTools(data.root, () => renderToStaticMarkup(React.createElement(m.Sources, {
      data, setModal() {}, onGenerate() {}, onPractice,
    })));
    assert.match(zhHtml, /待巩固优先/);
    assert.match(zhHtml, /只看待巩固（1）/);
    assert.match(zhHtml, /2 题薄弱 · 3 题到期/);
    assert.match(zhHtml, /练待巩固的题/);
    assert.match(zhHtml, /练整份资料/);

    const tree = walkTree(React.createElement(m.Sources, {
      data, setModal() {}, onGenerate() {}, onPractice,
    }));
    const urgentBtn = findNodes(tree, n => typeof n.props?.onClick === 'function' && plainText(n).includes('练待巩固的题'))[0];
    assert.ok(urgentBtn);
    await urgentBtn.props.onClick({ currentTarget: { closest: () => null } });
    assert.deepEqual(calls[0], { name: 'materials.pages.cards', args: { documentId: 'source:s1', sourceId: 's1' } }, 'document-level call omits chapter');
    assert.deepEqual(started[0], [{ deckId: 'd1', cardId: 'c-weak' }], 'only urgent cards started for 练待巩固的题');
    assert.equal(events.filter(e => e.kind === 'toast:info').length, 0, 'non-truncated round emits no cap toast');

    events.length = 0;
    const wholeBtn = findNodes(tree, n => typeof n.props?.onClick === 'function' && plainText(n).includes('练整份资料'))[0];
    assert.ok(wholeBtn);
    await wholeBtn.props.onClick({ currentTarget: { closest: () => null } });
    assert.equal(started[1].length, 200, 'whole-document drill caps at 200 and puts weak first');
    assert.deepEqual(started[1][0], { deckId: 'd1', cardId: 'c-weak' });
    assert.deepEqual(events, [
      { kind: 'practice:call', len: 200 },
      { kind: 'nav:review' },
      { kind: 'toast:info', msg: '这份资料可练题目较多，本次先练最需巩固的 200 道（共 207 道）。' },
    ], 'truncation toast fires only after async onPractice navigates to review');

    for (const failMode of ['undefined', 'reject']) {
      events.length = 0;
      practiceMode = failMode;
      await wholeBtn.props.onClick({ currentTarget: { closest: () => null } });
      assert.equal(events.some(e => e.kind === 'toast:info'), false, `no truncation toast when onPractice ${failMode}s`);
    }

    cardsToReturn = [];
    events.length = 0;
    await urgentBtn.props.onClick({ currentTarget: { closest: () => null } });
    assert.equal(events.at(-1)?.msg, '这份资料暂时没有薄弱或到期题，可以在菜单里选「练整份资料」。');

    events.length = 0;
    await wholeBtn.props.onClick({ currentTarget: { closest: () => null } });
    assert.equal(events.at(-1)?.msg, '这份资料现在没有可练的题（已斩或已归档的不算）。可以先从它出题。');

    m.setUiLanguage('en');
    const enHtml = withOpenSourcesTools(data.root, () => renderToStaticMarkup(React.createElement(m.Sources, {
      data, setModal() {}, onGenerate() {}, onPractice() {},
    })));
    assert.match(enHtml, /Needs review first/);
    assert.match(enHtml, /Needs review \(1\)/);
    assert.match(enHtml, /2 weak · 3 due/);
    assert.match(enHtml, /Practise due &amp; weak/);
    assert.match(enHtml, /Practise whole source/);
    assert.doesNotMatch(enHtml.replace(/<[^>]+>/g, ' '), /[\u3400-\u9fff]/);
  } finally {
    m.ToastContext._currentValue = prevToast;
    m.StudyServicesContext._currentValue = prevStudy;
    m.setUiLanguage('zh');
  }
});
