import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`
  export { default as GuidedStudyWorkbench, handleGuidedWorkbenchKeyDown } from './ui/guided-study/GuidedStudyWorkbench.jsx';
  export { StudyProgressPanel } from './ui/guided-study/StudyProgressPanel.jsx';
  export { default as Sources } from './ui/Sources.jsx';
  export { ScrollWindow } from './ui/components/index.js';
  export { default as Inbox, moveMailboxFocus, handleMailboxKeyDown } from './ui/Inbox.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const noop = () => {};

function mountSync(Component, initialProps) {
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const hooks = [];
  let cursor = 0;
  let currentProps = initialProps;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const render = (nextProps = currentProps) => {
    currentProps = nextProps;
    cursor = 0;
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
      useEffect: () => {},
      useLayoutEffect: () => {},
      useInsertionEffect: () => {},
      useId: () => { const i = cursor++; if (!(i in hooks)) hooks[i] = `:w6${i}:`; return hooks[i]; },
      useDeferredValue: (v) => v,
      useSyncExternalStore: (_sub, getSnap) => getSnap(),
    };
    let tree;
    try { tree = Component(currentProps); } finally { internals.H = prev; }
    return tree;
  };
  const unmount = () => {};
  return { render, unmount };
}

function walkEls(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) walkEls(c, visit); return; }
  if (node.props) {
    visit(node);
    walkEls(node.props.children, visit);
  }
}

function findEl(tree, pred) {
  let found = null;
  walkEls(tree, (n) => { if (!found && pred(n)) found = n; });
  return found;
}

function makeKeyEvent(key, extra = {}) {
  let prevented = false;
  let stopped = false;
  let blurred = 0;
  const event = {
    key,
    defaultPrevented: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    nativeEvent: { isComposing: false },
    target: { tagName: 'DIV', closest: () => null },
    currentTarget: { blur: () => { blurred += 1; }, closest: () => null },
    ...extra,
    preventDefault() { prevented = true; event.defaultPrevented = true; },
    stopPropagation() { stopped = true; },
  };
  return { event, state: () => ({ prevented, stopped, blurred }) };
}

test('Wave 6: GuidedStudyWorkbench keyboard retrieval loop handles choices, reveals, self-rating, next, and input/IME guards', () => {
  const opts = [{ id: 'o1', text: 'A' }, { id: 'o2', text: 'B' }, { id: 'o3', text: 'C' }];
  const quizCard = { id: 'c1', kind: 'quiz', prompt: 'Pick one', options: opts };
  const multiCard = { id: 'c2', kind: 'multi', prompt: 'Pick many', options: opts };
  const flashCard = { id: 'c3', kind: 'flashcard', prompt: 'Recall it' };

  // Choice digit & letter selection + Enter submit
  let picked = [];
  const submitted = [];
  const e2 = makeKeyEvent('2');
  assert.equal(m.handleGuidedWorkbenchKeyDown(e2.event, {
    currentCard: quizCard, choice: true, selected: picked, setSelected: (v) => { picked = v; },
    run: { id: 'r1' }, onAnswer: (v) => submitted.push(v),
  }), true);
  assert.deepEqual(picked, ['o2']);
  assert.equal(e2.state().prevented, true);

  const eC = makeKeyEvent('C');
  assert.equal(m.handleGuidedWorkbenchKeyDown(eC.event, {
    currentCard: quizCard, choice: true, selected: picked, setSelected: (v) => { picked = v; },
    run: { id: 'r1' }, onAnswer: (v) => submitted.push(v),
  }), true);
  assert.deepEqual(picked, ['o3']);

  const eOut = makeKeyEvent('9');
  assert.equal(m.handleGuidedWorkbenchKeyDown(eOut.event, {
    currentCard: quizCard, choice: true, selected: picked, setSelected: (v) => { picked = v; },
    run: { id: 'r1' }, onAnswer: (v) => submitted.push(v),
  }), false);
  assert.equal(eOut.state().prevented, false);

  const eSubmit = makeKeyEvent('Enter');
  assert.equal(m.handleGuidedWorkbenchKeyDown(eSubmit.event, {
    currentCard: quizCard, choice: true, selected: picked, setSelected: noop,
    run: { id: 'r1' }, onAnswer: (v) => submitted.push(v),
  }), true);
  assert.deepEqual(submitted, [{ selected: ['o3'] }]);

  // Radio/checkbox targets allow number keys + Enter
  const eRadio = makeKeyEvent('1', { target: { tagName: 'INPUT', type: 'radio', closest: () => null } });
  assert.equal(m.handleGuidedWorkbenchKeyDown(eRadio.event, {
    currentCard: quizCard, choice: true, selected: [], setSelected: (v) => { picked = v; },
  }), true);
  assert.deepEqual(picked, ['o1']);

  // Multi toggles options
  let multiPicked = [];
  m.handleGuidedWorkbenchKeyDown(makeKeyEvent('1').event, {
    currentCard: multiCard, choice: true, selected: multiPicked, setSelected: (v) => { multiPicked = v; },
  });
  m.handleGuidedWorkbenchKeyDown(makeKeyEvent('a').event, {
    currentCard: multiCard, choice: true, selected: multiPicked, setSelected: (v) => { multiPicked = v; },
  });
  assert.deepEqual(multiPicked, []);

  // Flashcard reveal via Space / Enter, then 1 / 2 self-check, then Space / Enter advance
  const revealed = [];
  const ratings = [];
  const nexts = [];
  assert.equal(m.handleGuidedWorkbenchKeyDown(makeKeyEvent(' ').event, {
    currentCard: flashCard, choice: false, isRevealed: false, run: { id: 'r9' }, onReveal: (id) => revealed.push(id),
  }), true);
  assert.deepEqual(revealed, ['r9']);

  assert.equal(m.handleGuidedWorkbenchKeyDown(makeKeyEvent('1').event, {
    currentCard: flashCard, choice: false, isRevealed: true, run: { id: 'r9' }, onAnswer: (q) => ratings.push(q),
  }), true);
  assert.equal(m.handleGuidedWorkbenchKeyDown(makeKeyEvent('2').event, {
    currentCard: flashCard, choice: false, isRevealed: true, run: { id: 'r9' }, onAnswer: (q) => ratings.push(q),
  }), true);
  assert.deepEqual(ratings, [1, 3]);

  assert.equal(m.handleGuidedWorkbenchKeyDown(makeKeyEvent('Enter').event, {
    currentCard: flashCard, hasFeedback: true, run: { id: 'r9' }, onNext: (id) => nexts.push(id),
  }), true);
  assert.deepEqual(nexts, ['r9']);

  // Guards: IME composition, button, text input, preparing state
  assert.equal(m.handleGuidedWorkbenchKeyDown(makeKeyEvent('1', { nativeEvent: { isComposing: true } }).event, {
    currentCard: flashCard, isRevealed: true, onAnswer: () => { throw new Error('must ignore IME'); },
  }), false);
  assert.equal(m.handleGuidedWorkbenchKeyDown(makeKeyEvent(' ', { keyCode: 229 }).event, {
    currentCard: flashCard, isRevealed: false, onReveal: () => { throw new Error('must ignore keyCode 229'); },
  }), false);
  assert.equal(m.handleGuidedWorkbenchKeyDown(makeKeyEvent('Enter', { target: { tagName: 'BUTTON', closest: (s) => (/button/.test(s) ? {} : null) } }).event, {
    currentCard: flashCard, hasFeedback: true, onNext: () => { throw new Error('must not hijack button Enter'); },
  }), false);
  assert.equal(m.handleGuidedWorkbenchKeyDown(makeKeyEvent('1', { target: { tagName: 'INPUT', type: 'text', closest: () => null } }).event, {
    currentCard: flashCard, isRevealed: true, onAnswer: () => { throw new Error('must not hijack text input'); },
  }), false);
  assert.equal(m.handleGuidedWorkbenchKeyDown(makeKeyEvent('Enter').event, {
    currentCard: flashCard, isPreparing: true, onReveal: () => { throw new Error('must ignore while preparing'); },
  }), false);

  // Component mounts onKeyDown + tabIndex={-1}
  const wb = mountSync(m.GuidedStudyWorkbench, {
    session: { id: 's1', status: 'active', focus: { kind: 'card', id: 'c3' } },
    run: { id: 'r9', index: 0, entries: [{ card: flashCard, revealed: false }] },
    onReveal: noop,
  });
  try {
    const tree = wb.render();
    assert.equal(typeof tree.props.onKeyDown, 'function');
    const cardView = findEl(tree, (n) => String(n.props?.className || '').includes('guided-study-card-view'));
    assert.equal(cardView?.props?.tabIndex, -1);
  } finally {
    wb.unmount();
  }
  const wbHtml = renderToStaticMarkup(React.createElement(m.GuidedStudyWorkbench, {
    session: { id: 's1', status: 'active', focus: { kind: 'card', id: 'c3' } },
    run: { id: 'r9', index: 0, entries: [{ card: flashCard, revealed: false }] },
    onReveal: noop,
  }));
  assert.match(wbHtml, /tabindex="-1"/i);
});

test('Wave 6: StudyProgressPanel add-item input guards IME Enter and implements Escape clear/blur', () => {
  const added = [];
  const panel = mountSync(m.StudyProgressPanel, {
    progress: { items: [], totalCount: 0 },
    defaultExpanded: true,
    onAddItem: (title) => added.push(title),
  });
  let tree = panel.render();
  let input = findEl(tree, (n) => n.props?.className === 'progress-add-input');
  assert.equal(typeof input?.props?.onKeyDown, 'function');

  // IME Enter calls preventDefault and does not submit
  const imeEnter = makeKeyEvent('Enter', { nativeEvent: { isComposing: true } });
  input.props.onKeyDown(imeEnter.event);
  assert.equal(imeEnter.state().prevented, true);

  // Type something, Escape clears + stops propagation without blurring
  input.props.onChange({ target: { value: 'Check Binary Tree' } });
  tree = panel.render();
  input = findEl(tree, (n) => n.props?.className === 'progress-add-input');
  assert.equal(input.props.value, 'Check Binary Tree');

  const escClear = makeKeyEvent('Escape');
  input.props.onKeyDown(escClear.event);
  assert.deepEqual(escClear.state(), { prevented: true, stopped: true, blurred: 0 });
  tree = panel.render();
  input = findEl(tree, (n) => n.props?.className === 'progress-add-input');
  assert.equal(input.props.value, '');

  // Second Escape when empty outside dialog blurs; inside dialog stays bubbling
  const escBlur = makeKeyEvent('Escape');
  input.props.onKeyDown(escBlur.event);
  assert.deepEqual(escBlur.state(), { prevented: false, stopped: false, blurred: 1 });

  const escDialog = makeKeyEvent('Escape', { currentTarget: { blur: () => { throw new Error('must not blur inside dialog'); }, closest: (s) => (/role=['"]dialog['"]|dialog\[open\]/.test(s) ? {} : null) } });
  input.props.onKeyDown(escDialog.event);
  assert.deepEqual(escDialog.state(), { prevented: false, stopped: false, blurred: 0 });
  assert.deepEqual(added, []);
  panel.unmount();
});

test('Wave 6: Sources and ScrollWindow filter inputs guard IME composition and distinguish dialog Escape handling', () => {
  m.setUiLanguage('zh');
  const prevApp = m.AppContext._currentValue;
  m.AppContext._currentValue = null;
  const sourcesComp = mountSync(m.Sources, {
    data: {
      sources: [{ id: 's1', title: 'Kernel Notes', text: 'abc', createdAt: new Date().toISOString(), courses: ['OS'], usedBy: [] }],
      decks: [], drafts: [], jobs: [], focus: { course: '*', courses: [{ name: 'OS' }] }, modelReady: true,
    },
    setModal: noop,
  });
  try {
    let sTree = sourcesComp.render();
    let sInput = findEl(sTree, (n) => n.props?.className === 'sources-filter__input');
    sInput.props.onChange({ target: { value: 'kernel' } });
    sTree = sourcesComp.render();
    sInput = findEl(sTree, (n) => n.props?.className === 'sources-filter__input');
    assert.equal(sInput.props.value, 'kernel');

    // IME Escape is ignored
    const sIme = makeKeyEvent('Escape', { keyCode: 229 });
    sInput.props.onKeyDown(sIme.event);
    assert.deepEqual(sIme.state(), { prevented: false, stopped: false, blurred: 0 });

    // Non-empty Escape clears query
    const sClear = makeKeyEvent('Escape');
    sInput.props.onKeyDown(sClear.event);
    assert.deepEqual(sClear.state(), { prevented: true, stopped: true, blurred: 0 });
    sTree = sourcesComp.render();
    sInput = findEl(sTree, (n) => n.props?.className === 'sources-filter__input');
    assert.equal(sInput.props.value, '');

    // Empty Escape blurs
    const sBlur = makeKeyEvent('Escape');
    sInput.props.onKeyDown(sBlur.event);
    assert.deepEqual(sBlur.state(), { prevented: true, stopped: false, blurred: 1 });
  } finally {
    sourcesComp.unmount();
    m.AppContext._currentValue = prevApp;
  }

  // ScrollWindow controlled query test
  const queries = [];
  const baseScrollProps = {
    label: 'List',
    items: [{ id: '1', name: 'Alpha' }],
    filterable: true,
    onQueryChange: (next) => queries.push(next),
  };
  const swComp = mountSync(m.ScrollWindow, { ...baseScrollProps, query: 'alp' });
  try {
    let swInput = findEl(swComp.render({ ...baseScrollProps, query: 'alp' }), (n) => n.props?.className === 'sh-scroll__filter');
    const swIme = makeKeyEvent('Escape', { nativeEvent: { isComposing: true } });
    swInput.props.onKeyDown(swIme.event);
    assert.deepEqual(swIme.state(), { prevented: false, stopped: false, blurred: 0 });

    const swClear = makeKeyEvent('Escape');
    swInput.props.onKeyDown(swClear.event);
    assert.deepEqual(swClear.state(), { prevented: true, stopped: true, blurred: 0 });
    assert.deepEqual(queries, ['']);

    swInput = findEl(swComp.render({ ...baseScrollProps, query: '' }), (n) => n.props?.className === 'sh-scroll__filter');
    const swBlur = makeKeyEvent('Escape');
    swInput.props.onKeyDown(swBlur.event);
    assert.deepEqual(swBlur.state(), { prevented: false, stopped: false, blurred: 1 });

    const swDialog = makeKeyEvent('Escape', {
      currentTarget: { blur: () => { throw new Error('ScrollWindow inside dialog must let Escape close dialog'); }, closest: (s) => (/role=['"]dialog['"]|dialog\[open\]/.test(s) ? {} : null) },
    });
    swInput.props.onKeyDown(swDialog.event);
    assert.deepEqual(swDialog.state(), { prevented: false, stopped: false, blurred: 0 });
  } finally {
    swComp.unmount();
  }
});

test('Wave 6: Inbox guards IME on arrow focus and toggles read/unread with R key', () => {
  const items = [
    { id: 'm1', kind: 'improve', label: '改好题干', prompt: 'Card 1', deckTitle: 'Deck', at: new Date().toISOString(), read: false },
    { id: 'm2', kind: 'followup', label: '讲解追问', prompt: 'Card 2', deckTitle: 'Deck', at: new Date().toISOString(), read: true },
  ];
  const toggled = [];
  const fakeRow = (id) => ({
    getAttribute: (name) => (name === 'data-scroll-key' ? id : null),
    querySelector: () => ({ getAttribute: (name) => (name === 'data-letter-id' ? id : null) }),
  });
  const fakePanel = { querySelectorAll: () => [] };

  // IME ArrowDown ignored
  const imeMove = makeKeyEvent('ArrowDown', { isComposing: true, target: { closest: () => ({}) } });
  assert.equal(m.moveMailboxFocus(fakePanel, imeMove.event), false);

  // IME 'r' ignored
  const imeR = makeKeyEvent('r', { keyCode: 229, target: { tagName: 'BUTTON', closest: () => fakeRow('m1') } });
  assert.equal(m.handleMailboxKeyDown(fakePanel, imeR.event, { items, onToggleRead: (it) => toggled.push(it.id) }), false);

  // 'r' and 'R' toggle read on active row
  const rLower = makeKeyEvent('r', { target: { tagName: 'BUTTON', closest: (s) => (s === '.mailbox__row' ? fakeRow('m1') : null) } });
  assert.equal(m.handleMailboxKeyDown(fakePanel, rLower.event, { items, onToggleRead: (it) => toggled.push(it.id) }), true);
  assert.equal(rLower.state().prevented, true);

  const rUpper = makeKeyEvent('R', {
    target: {
      tagName: 'BUTTON',
      closest: (s) => (s === '.mailbox__row' ? { getAttribute: () => null, querySelector: () => ({ getAttribute: () => 'm2' }) } : null),
    },
  });
  assert.equal(m.handleMailboxKeyDown(fakePanel, rUpper.event, { items, onToggleRead: (it) => toggled.push(it.id) }), true);
  assert.deepEqual(toggled, ['m1', 'm2']);

  // Busy or text input skips 'R'
  assert.equal(m.handleMailboxKeyDown(fakePanel, makeKeyEvent('r', { target: { tagName: 'BUTTON', closest: () => fakeRow('m1') } }).event, {
    items, busy: true, onToggleRead: (it) => toggled.push(it.id),
  }), false);
  assert.equal(m.handleMailboxKeyDown(fakePanel, makeKeyEvent('r', { target: { tagName: 'INPUT', closest: () => fakeRow('m1') } }).event, {
    items, onToggleRead: (it) => toggled.push(it.id),
  }), false);
  assert.deepEqual(toggled, ['m1', 'm2']);

  // Rendered Inbox mounts onKeyDown and renders data-letter-id attributes
  const inboxComp = mountSync(m.Inbox, {
    inbox: { unread: 1, items },
    onOpen: noop,
    onReadAll: noop,
    onToggleRead: noop,
    defaultOpen: true,
  });
  try {
    const tree = inboxComp.render();
    const panelEl = findEl(tree, (n) => n.props?.className === 'mailbox__panel');
    assert.equal(typeof panelEl?.props?.onKeyDown, 'function');
  } finally {
    inboxComp.unmount();
  }
  const inboxHtml = renderToStaticMarkup(React.createElement(m.Inbox, {
    inbox: { unread: 1, items },
    onOpen: noop,
    onReadAll: noop,
    onToggleRead: noop,
    defaultOpen: true,
  }));
  assert.match(inboxHtml, /data-letter-id="m1"/);
  assert.match(inboxHtml, /data-letter-id="m2"/);
});

test('Wave 6 CSS U27-U30: single-ring focus normalization and tabular-nums alignment', async () => {
  const [graphCss, selectCss, tourCss, skeletonCss, sourcesCss, inboxCss, guidedCss] = await Promise.all([
    readFile('ui/graph.css', 'utf8'),
    readFile('ui/components/select.css', 'utf8'),
    readFile('ui/tour/tour.css', 'utf8'),
    readFile('ui/skeleton.css', 'utf8'),
    readFile('ui/sources.css', 'utf8'),
    readFile('ui/inbox.css', 'utf8'),
    readFile('ui/guided-study/guided-study.css', 'utf8'),
  ]);

  assert.match(graphCss, /\.cloze-blank--input\.cloze-blank--input:focus-visible\s*\{[^}]*outline-offset:\s*-1px;[^}]*box-shadow:\s*none;/s);
  assert.match(graphCss, /\.cloze-blank:not\(\.cloze-blank--input\):focus-visible\s*\{[^}]*outline-offset:\s*2px;[^}]*\}/s);
  assert.doesNotMatch(graphCss, /\.cloze-blank:not\(\.cloze-blank--input\):focus-visible\s*\{[^}]*box-shadow:/s);

  assert.doesNotMatch(selectCss, /\.sh-combobox__action:focus-visible\s*\{[^}]*box-shadow:/s);
  assert.doesNotMatch(tourCss, /\.tour-pop:focus-visible\s*\{[^}]*var\(--ring\)/s);
  assert.doesNotMatch(skeletonCss, /\.skc-class\.skc-class:focus-visible\s*\{[^}]*var\(--ring\)/s);
  assert.doesNotMatch(skeletonCss, /\.sqc-actor\.sqc-actor:focus-visible[^{]*\{[^}]*box-shadow:/s);

  assert.match(guidedCss, /\.guided-study-card-view:focus\s*\{\s*outline:\s*none;\s*\}/);
  assert.match(guidedCss, /\.guided-study-card-option:has\(input:focus-visible\)\s*\{[^}]*outline:\s*2px solid var\(--accent-soft\);[^}]*outline-offset:\s*-1px;/s);
  assert.match(guidedCss, /\.guided-study-card-option\[data-verdict="correct"\]\s*\{[^}]*background:\s*var\(--ok-bg\);/s);
  assert.match(guidedCss, /\.guided-study-card-option\[data-verdict="wrong"\]\s*\{[^}]*background:\s*var\(--bad-bg\);/s);

  assert.match(sourcesCss, /\.sources-filter__count[^}]*tabular-nums/);
  assert.match(sourcesCss, /\.source-doc__meta[^}]*tabular-nums/);
  assert.match(inboxCss, /\.mailbox__count[^}]*tabular-nums/s);
  assert.match(inboxCss, /\.mailbox__sub[^}]*tabular-nums/);
  assert.match(inboxCss, /\.mailbox__time[^}]*tabular-nums/);
  assert.match(inboxCss, /\.mailbox__multi[^}]*tabular-nums/);
  assert.match(guidedCss, /\.progress-main-line[^}]*tabular-nums/s);
  assert.match(guidedCss, /\.progress-sub-line,[^}]*tabular-nums/s);
  assert.match(guidedCss, /\.progress-cost-list[^}]*tabular-nums/s);
  assert.match(guidedCss, /\.guided-study-footer-status[^}]*tabular-nums/s);
});
