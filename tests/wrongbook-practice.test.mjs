/* 错题与待巩固: practising one topic is one click on its group (not one 练 per question), the retrain button says what it takes (the scope's count),
   and with a filter on there is a second, quieter button for just what the filter shows. A page with one group has no group-level repeats (#675). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { withStudy } from './helpers/study-services.mjs';
import { checkScope } from '../lib/prereq.js';

const m = await loadUi(`
  export { WrongBookView } from './ui/WrongBook.jsx';
  export { capPracticeScope, practiceCappedText } from './ui/wrongbook-model.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage, errorMessage, uiCatalogue } from './ui/i18n.js';
`);
Object.assign(m.uiCatalogue(), JSON.parse(readFileSync(new URL('../ui/locales/en.polish-results.json', import.meta.url), 'utf8')));
const { WrongBookView, setUiLanguage, errorMessage } = m;
const noop = () => {};
const decks = [{ id: 'd4', course: 'PE', title: 'Platform Engineering｜期末综合卷04｜90题' }, { id: 'd2', course: 'PE', title: 'Platform Engineering｜期末综合卷02｜90题' }];
const row = (cardId, deckId, topic, prompt, assessment = 'graded') => ({ deckId, deckTitle: decks.find((d) => d.id === deckId).title, cardId, topic, prompt, assessment, lastGrade: 1,
  lastAt: '2026-10-01T10:00:00Z', kind: 'quiz' });
const items = [row('c1', 'd4', '保护状态', '熔断器？'), row('c2', 'd4', '集成收益', '集成收益？'), row('c3', 'd4', '组织与架构', '平台团队？', 'self'),
  row('c4', 'd2', '保护状态', '半开状态？'), row('c5', 'd2', '恢复探测', '探测依赖？')];
const base = { data: { root: 'r', decks, focus: { course: 'PE', courses: [{ name: 'PE' }] }, model: { ready: true } }, course: 'PE', onCourse: noop,
  items, counts: { total: 5, graded: 4, self: 1, oral: 0, rubric: 0 }, loading: false, err: '', page: 0, pageSize: 100, hasMore: false,
  onReload: noop, onPage: noop, recs: null, coach: null, details: {}, onLoadDetail: noop, onPractice: noop, onPracticePrepared: noop,
  onGenerate: async () => ({}), onOpenSettings: noop, filterMin: 1 };
// `busy` is the app's (useStudy), so a test that wants a busy page gives it through the services.
const render = ({ busy = false, ...extra } = {}) => renderToStaticMarkup(withStudy(m.StudyServicesContext, React.createElement(WrongBookView, { ...base, ...extra }), { busy }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const buttons = (html) => (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) || []);
const labelled = (html, pattern) => buttons(html).filter((tag) => pattern.test(text(tag)));

test('every group has a button that practises the whole group, folded or open', () => {
  setUiLanguage('zh');
  const html = render();
  const heads = html.match(/<div class="wb-group-head">[\s\S]*?<\/div><\/div>/g) || [];
  assert.equal(heads.length, 2, 'two decks have mistakes');
  for (const head of heads) assert.match(head, /练这一组/);
  assert.match(html, /aria-label="练这一组：期末综合卷04"/);
  assert.equal(labelled(html, /练这一组/).length, 2);
  assert.equal(labelled(render({ initial: { groups: 'all' } }), /练这一组/).length, 2, 'open groups too');
  assert.equal(labelled(render({ initial: { groupBy: 'topic' } }), /练这一组/).length, 4, 'and by topic: one per topic');
});

test('the group button is not offered while the page is busy', () => {
  assert.ok(labelled(render({ busy: true }), /练这一组/).every((tag) => /disabled/.test(tag)));
  assert.ok(labelled(render(), /练这一组/).every((tag) => !/disabled/.test(tag)));
});

test('the retrain button counts the whole page, not what a filter shows', () => {
  setUiLanguage('zh');
  const plain = text(render());
  assert.match(plain, /开始重练 · 5 题/);
  assert.doesNotMatch(plain, /开始重练 \(|全部 5 题/);
  assert.doesNotMatch(plain, /练筛选的/, 'no filter, no second button');
  const filtered = render({ initial: { filter: { status: 'self' } } });
  assert.match(text(filtered), /开始重练 · 5 题/, 'the filter does not change what the main button practises');
  assert.match(text(filtered), /练筛选的 1 道/);
  assert.equal(labelled(filtered, /练筛选的/).length, 1);
});

test('the second button counts what the filter shows, and is not there when the filter shows nothing or everything', () => {
  setUiLanguage('zh');
  assert.match(text(render({ initial: { filter: { deck: 'd4' } } })), /练筛选的 3 道/);
  assert.match(text(render({ initial: { filter: { query: '状态' } } })), /练筛选的 2 道/);
  assert.doesNotMatch(text(render({ initial: { filter: { query: '没有这个词' } } })), /练筛选的/, 'nothing shown: the page offers 清除筛选 instead');
  assert.doesNotMatch(text(render({ initial: { filter: { status: 'graded', deck: '' } }, items: items.filter((row) => row.assessment === 'graded'), counts: { total: 4, graded: 4, self: 0, oral: 0, rubric: 0 } })),
    /练筛选的/, 'the filter lets everything through: it would say the same as the main button');
});

test('English: the new buttons are translated', () => {
  setUiLanguage('en');
  try {
    const html = render({ initial: { filter: { deck: 'd4' } } });
    assert.doesNotMatch(text(html).replace(/期末综合卷0\d/g, ''), /\p{Script=Han}/u);
    assert.match(text(render()), /Practise this group/);
    assert.match(text(html), /Start retraining · 5/);
    assert.match(text(html), /Practise the 3 filtered/);
  } finally { setUiLanguage('zh'); }
});

test('the consent note points to the setting with a real link, not with a path to look for', () => {
  setUiLanguage('zh');
  const opened = [];
  const html = render({ initial: { askConsent: true }, coach: { enabled: true, consent: null, ready: 0, readyCards: [], failedCards: [], tasks: [] }, onSettings: (section) => opened.push(section) });
  assert.match(text(html), /要让 AI 为错题备变式题吗/);
  assert.doesNotMatch(text(html), /设置 › 学习画像与导览/);
  assert.equal(labelled(html, /前往设置/).length, 1);
  const without = render({ initial: { askConsent: true }, coach: { enabled: true, consent: null, ready: 0, readyCards: [], failedCards: [], tasks: [] } });
  assert.equal(labelled(without, /前往设置/).length, 0, 'a page that cannot open Settings draws no dead link');
});

test('#928: groups over 200 questions cap scope to the first 200 with a plain notice, and checkScope distinguishes over-limit from non-array', () => {
  setUiLanguage('zh');
  const bigCards = Array.from({ length: 201 }, (_, i) => ({ id: `b${i}`, prompt: `Q${i}`, answer: 'A' }));
  const state = { decks: [{ id: 'd4', title: decks[0].title, cards: bigCards }, { id: 'd2', title: decks[1].title, cards: [{ id: 'x1', prompt: 'X', answer: 'A' }] }] };

  assert.throws(() => checkScope(state, 'not-an-array'), /Scope must be a list/);
  let overErr;
  assert.throws(() => checkScope(state, bigCards.map((c) => ({ deckId: 'd4', cardId: c.id }))), (e) => { overErr = e; return /一次范围练习最多选 200 道题（这次传了 201 道）/.test(e.message); });
  setUiLanguage('en');
  try {
    assert.equal(errorMessage(overErr), 'A scoped practice round accepts at most 200 questions (got 201)');
  } finally { setUiLanguage('zh'); }

  const atCap = m.capPracticeScope(bigCards.slice(0, 200).map((c) => ({ deckId: 'd4', cardId: c.id })));
  assert.equal(atCap.capped, false);
  assert.equal(atCap.total, 200);
  assert.equal(atCap.limit, 200);
  assert.equal(atCap.scope.length, 200);
  assert.equal(atCap.scope[0].cardId, 'b0');
  assert.equal(atCap.scope[199].cardId, 'b199');
  assert.doesNotThrow(() => checkScope(state, atCap.scope), 'an exact 200-card scope is accepted by checkScope');

  const capped = m.capPracticeScope(bigCards.map((c) => ({ deckId: 'd4', cardId: c.id })));
  assert.equal(capped.capped, true);
  assert.equal(capped.total, 201);
  assert.equal(capped.limit, 200);
  assert.equal(capped.scope.length, 200);
  assert.equal(capped.scope[0].cardId, 'b0');
  assert.equal(capped.scope[199].cardId, 'b199');
  assert.doesNotThrow(() => checkScope(state, capped.scope), 'the capped 200-card scope is accepted by checkScope');
  assert.equal(m.practiceCappedText(201, { group: true }), '这一组有 201 道题，一次最多 200 道：先练前 200 道。');
  assert.equal(m.practiceCappedText(201, { group: false }), '共选了 201 道题，一次最多 200 道：先练前 200 道。');

  const atCapItems = [
    ...bigCards.slice(0, 200).map((c) => row(c.id, 'd4', '保护状态', c.prompt)),
    row('x1', 'd2', '恢复探测', 'X'),
  ];
  const htmlAtCapZh = render({ items: atCapItems, counts: { total: 201, graded: 201, self: 0, oral: 0, rubric: 0 } });
  assert.doesNotMatch(text(htmlAtCapZh), /这一组有 \d+ 道题，一次最多/, 'a 200-question group is not capped and omits the group cap tooltip');

  const bigItems = [
    ...bigCards.map((c) => row(c.id, 'd4', '保护状态', c.prompt)),
    row('x1', 'd2', '恢复探测', 'X'),
  ];
  const htmlZh = render({ items: bigItems, counts: { total: 202, graded: 202, self: 0, oral: 0, rubric: 0 } });
  assert.match(text(htmlZh), /这一组有 201 道题，一次最多 200 道：先练前 200 道。/, 'the >200 group button carries a tooltip explaining the cap');

  setUiLanguage('en');
  try {
    const htmlEn = render({ items: bigItems, counts: { total: 202, graded: 202, self: 0, oral: 0, rubric: 0 } });
    assert.doesNotMatch(text(htmlEn).replace(/期末综合卷0\d/g, ''), /\p{Script=Han}/u);
    assert.match(text(htmlEn), /This group has 201 questions \(up to 200 at a time\): practising the first 200\./);
  } finally { setUiLanguage('zh'); }
});

function mountSync(Component, initialProps) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  const cleanups = [];
  let cursor = 0;
  let pending = [];
  let currentProps = initialProps;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const render = (nextProps = currentProps) => {
    currentProps = nextProps;
    cursor = 0;
    pending = [];
    const prev = internals.H;
    internals.H = {
      useContext: (ctx) => ctx._currentValue,
      useState: (init) => {
        const i = cursor++;
        if (!(i in hooks)) hooks[i] = [typeof init === 'function' ? init() : init, (val) => {
          hooks[i][0] = typeof val === 'function' ? val(hooks[i][0]) : val;
        }];
        return hooks[i];
      },
      useRef: (init) => { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: init }; return hooks[i]; },
      useMemo: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
      useCallback: (fn, deps) => internals.H.useMemo(() => fn, deps),
      useEffect: (fn, deps) => { const i = cursor++; if (!(i in hooks) || !sameDeps(hooks[i].deps, deps)) pending.push({ i, fn, deps }); },
      useLayoutEffect: (fn, deps) => internals.H.useEffect(fn, deps),
      useInsertionEffect: (fn, deps) => internals.H.useEffect(fn, deps),
      useId: () => { const i = cursor++; if (!(i in hooks)) hooks[i] = `:wp${i}:`; return hooks[i]; },
      useDeferredValue: (v) => v,
    };
    let tree;
    try { tree = Component(currentProps); } finally { internals.H = prev; }
    for (const eff of pending) {
      cleanups[eff.i]?.();
      cleanups[eff.i] = undefined;
      const done = eff.fn();
      hooks[eff.i] = { deps: eff.deps };
      if (typeof done === 'function') cleanups[eff.i] = done;
    }
    return tree;
  };
  const unmount = () => { for (const c of cleanups) c?.(); };
  return { render, unmount };
}

function walkEls(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) walkEls(c, visit); return; }
  if (node.props) {
    visit(node);
    walkEls(node.props.children, visit);
    walkEls(node.props.description, visit);
  }
}

const elText = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(elText).join('');
  return typeof node === 'object' && node.props ? elText(node.props.children) : '';
};

test('#47: open group with >= 2 rows offers bulk expand/collapse capped at 20 details', () => {
  setUiLanguage('zh');
  const manyCards = Array.from({ length: 24 }, (_, i) => row(`x${i}`, 'd4', '保护状态', `问题 ${i}`));
  assert.doesNotMatch(text(render({ items: manyCards, counts: { total: 24, graded: 24, self: 0, oral: 0, rubric: 0 } })), /展开各题解析/, 'folded group hides detail bulk toggle');
  assert.doesNotMatch(text(render({ items: [row('only1', 'd4', '保护状态', '唯一题')], counts: { total: 1, graded: 1, self: 0, oral: 0, rubric: 0 }, initial: { groups: 'all' } })), /展开各题解析/, '<2 rows omits detail bulk toggle');

  const loaded = [];
  const app = mountSync(WrongBookView, {
    ...base,
    items: manyCards,
    counts: { total: 24, graded: 24, self: 0, oral: 0, rubric: 0 },
    details: {},
    onLoadDetail: (cardId) => loaded.push(cardId),
    initial: { groups: 'all' },
  });
  let tree = app.render();
  const findBtn = (label) => {
    let found = null;
    walkEls(tree, (n) => { if (!found && typeof n.type !== 'string' && elText(n).trim() === label) found = n; });
    return found;
  };
  const expandBtn = findBtn('展开各题解析');
  assert.ok(expandBtn, 'open group with >= 2 rows shows 展开各题解析');
  expandBtn.props.onClick();
  tree = app.render();
  assert.equal(loaded.length, 20, 'expanding group details caps at first 20 rows');
  assert.equal(loaded[0].cardId, 'x0');
  assert.equal(loaded[19].cardId, 'x19');

  const collapseBtn = findBtn('收起各题解析');
  assert.ok(collapseBtn, 'label flips to 收起各题解析 once first 20 are expanded');
  collapseBtn.props.onClick();
  tree = app.render();
  assert.ok(findBtn('展开各题解析'), 'clicking again collapses group details back');

  setUiLanguage('en');
  try {
    tree = app.render();
    assert.ok(findBtn('Expand explanations'), 'English expand label');
    findBtn('Expand explanations').props.onClick();
    tree = app.render();
    assert.ok(findBtn('Collapse explanations'), 'English collapse label');
  } finally {
    setUiLanguage('zh');
    app.unmount();
  }
});

test('#48: .wb-rows arrow keys navigate row toggles and L triggers practice on focused row', () => {
  setUiLanguage('zh');
  const practiced = [];
  const app = mountSync(WrongBookView, {
    ...base,
    onPractice: (scope) => practiced.push(scope),
    initial: { groups: ['deck:d4'] },
  });
  const tree = app.render();
  let rowsUl = null;
  walkEls(tree, (n) => { if (!rowsUl && n.type === 'ul' && n.props.className === 'wb-rows') rowsUl = n; });
  assert.ok(rowsUl?.props?.onKeyDown, '.wb-rows attaches keyboard handler');

  const focused = [];
  const makeBtn = (cardId) => ({
    dataset: { cardId },
    closest: (sel) => (sel === '.wb-row-toggle' ? btnMap.get(cardId) : null),
    focus: () => focused.push(cardId),
  });
  const btnMap = new Map([['c1', makeBtn('c1')], ['c2', makeBtn('c2')], ['c3', makeBtn('c3')]]);
  const buttonsList = [...btnMap.values()];
  const currentTarget = { querySelectorAll: (sel) => (sel === '.wb-row-toggle' ? buttonsList : []) };
  const fire = (key, cardId, extra = {}) => {
    let prevented = false;
    rowsUl.props.onKeyDown({
      key,
      metaKey: false, ctrlKey: false, altKey: false, isComposing: false,
      ...extra,
      target: btnMap.get(cardId),
      currentTarget,
      preventDefault: () => { prevented = true; },
    });
    return prevented;
  };

  assert.equal(fire('ArrowDown', 'c1'), true);
  assert.equal(fire('End', 'c1'), true);
  assert.equal(fire('ArrowUp', 'c3'), true);
  assert.equal(fire('Home', 'c2'), true);
  assert.deepEqual(focused, ['c2', 'c3', 'c2', 'c1']);

  assert.equal(fire('l', 'c2'), true);
  assert.equal(fire('L', 'c3'), true);
  assert.equal(fire('l', 'c1', { ctrlKey: true }), false, 'modified shortcut is ignored');
  assert.deepEqual(practiced, [[{ deckId: 'd4', cardId: 'c2' }], [{ deckId: 'd4', cardId: 'c3' }]]);
  app.unmount();
});

test('Wave 5: .wb-rows Escape collapses an open row and restores focus, and O opens cited source', () => {
  setUiLanguage('zh');
  const openedModals = [];
  const prevServices = m.StudyServicesContext._currentValue;
  m.StudyServicesContext._currentValue = { ...(prevServices || {}), busy: false, openModal: (modal) => openedModals.push(modal) };
  try {
    const citedSource = { id: 's1', title: 'Lecture 1', text: '熔断器保护下游服务' };
    const decksWithCards = [
      { ...decks[0], cards: [{ id: 'c1', citations: [{ sourceId: 's1', quote: '熔断器保护下游服务' }] }, { id: 'c2' }] },
      decks[1],
    ];
    const app = mountSync(WrongBookView, {
      ...base,
      data: { ...base.data, decks: decksWithCards, sources: [citedSource] },
      initial: { groups: ['deck:d4'], expanded: ['c1'] },
    });
    const findRowsUl = (tree) => {
      let rowsUl = null;
      walkEls(tree, (n) => { if (!rowsUl && n.type === 'ul' && n.props.className === 'wb-rows') rowsUl = n; });
      return rowsUl;
    };
    const isCardOpen = (rowsUl, cardId) => {
      let chunked = null;
      walkEls(rowsUl, (n) => { if (!chunked && typeof n.type !== 'string' && typeof n.props?.render === 'function') chunked = n; });
      const targetItem = items.find((item) => item.cardId === cardId);
      return Boolean(chunked && targetItem && chunked.props.render(targetItem).props.isOpen);
    };

    let tree = app.render();
    let rowsUl = findRowsUl(tree);
    assert.ok(rowsUl?.props?.onKeyDown, '.wb-rows attaches keyboard handler');
    assert.equal(isCardOpen(rowsUl, 'c1'), true, 'c1 starts open');

    const focused = [];
    const btnMap = new Map();
    const rowEl = { querySelector: (q) => (q === '.wb-row-toggle' ? btnMap.get('c1') : null) };
    const insideOpenRow = {
      closest: (sel) => (sel === '.wb-row' ? rowEl : null),
    };
    const makeBtn = (cardId) => ({
      dataset: { cardId },
      closest: (sel) => (sel === '.wb-row-toggle' ? btnMap.get(cardId) : sel === '.wb-row' ? (cardId === 'c1' ? rowEl : null) : null),
      focus: () => focused.push(cardId),
    });
    btnMap.set('c1', makeBtn('c1'));
    btnMap.set('c2', makeBtn('c2'));
    btnMap.set('c3', makeBtn('c3'));

    const fireEvent = (key, targetEl, extra = {}) => {
      let prevented = false;
      let stopped = false;
      rowsUl.props.onKeyDown({
        key,
        metaKey: false, ctrlKey: false, altKey: false, isComposing: false,
        ...extra,
        target: targetEl,
        currentTarget: { querySelectorAll: () => [...btnMap.values()] },
        preventDefault: () => { prevented = true; },
        stopPropagation: () => { stopped = true; },
      });
      return { prevented, stopped };
    };

    assert.equal(fireEvent('o', btnMap.get('c1'), { isComposing: true }).prevented, false, 'IME composition ignores O');
    assert.equal(fireEvent('o', btnMap.get('c2')).prevented, false, 'uncited c2 does not open source');
    assert.equal(fireEvent('o', btnMap.get('c1')).prevented, true);
    assert.equal(fireEvent('O', btnMap.get('c1')).prevented, true);
    assert.equal(openedModals.length, 2);
    assert.equal(openedModals[0].type, 'source');
    assert.equal(openedModals[0].source.id, 's1');
    assert.equal(openedModals[0].quote, '熔断器保护下游服务');
    assert.equal(openedModals[0].back, true);

    const escOpen = fireEvent('Escape', insideOpenRow);
    assert.equal(escOpen.prevented, true);
    assert.equal(escOpen.stopped, true);
    assert.deepEqual(focused, ['c1']);

    tree = app.render();
    rowsUl = findRowsUl(tree);
    assert.equal(isCardOpen(rowsUl, 'c1'), false, 'Escape collapsed c1');
    assert.equal(fireEvent('Escape', insideOpenRow).prevented, false, 'already collapsed row leaves Escape alone');
    app.unmount();
  } finally {
    m.StudyServicesContext._currentValue = prevServices;
  }
});

