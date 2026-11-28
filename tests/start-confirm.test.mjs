import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInteractiveUi, withBrowserGlobals, textOf } from './helpers/react-harness.mjs';

/* A mis-click must not start a round: it would take over the home's card, the sidebar's 回到题目 and the deck row. Three places ask first, with one
   dialog: a deck row's ▶, a topic row's ▶ (both only without an open run) and S / 回到题目 when there is no round to resume. Mounted here: the
   real intents, the real library state, the real modal router and the real deck row; only the host call and the page change are faked. */

const ui = await loadInteractiveUi(`
  export { useIntents } from './ui/app/use-intents.js';
  export { dailyPathArgs } from './ui/study-map/home-plan.js';
  export { useLibraryState } from './ui/app/library-state.js';
  export { ModalRouter } from './ui/app/AppModalHost.jsx';
  export { topDialog } from './ui/components/dialog-stack.js';
  export { default as DeckRow } from './ui/study-map/DeckRow.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const m = ui.exports, h = ui.React.createElement;

const deck = { id: 'd1', title: '行为型模式', available: 5, quizCount: 3, wrong: 2 };
const progress = { counts: { mastered: 1, familiar: 1, learning: 1, weak: 1, new: 1 }, total: 5, mastery: 60, due: 1, status: 'active',
  topics: [{ name: 'Memento', total: 3, due: 1, mastery: 60, status: 'active', counts: { mastered: 1, familiar: 0, learning: 0, weak: 1, new: 1 } }] };
const today = { course: 'CS3219', scope: [{ deckId: 'd1' }], due: 1, weak: 1, new: 1, size: 3 };
const tree = { selected: new Set(), toggleOpen() {}, toggleSelect() {} };
const deckArgs = { mode: 'path', scope: [{ deckId: 'd1' }] };
const topicArgs = { mode: 'path', scope: [{ deckId: 'd1', topic: 'Memento' }] };

function makeFocusable(name) {
  return {
    name,
    tagName: 'BUTTON',
    isConnected: true,
    focus() { globalThis.document.activeElement = this; },
  };
}

/** The three places, wired as the app wires them. `world` is what changes under the page: the snapshot, the open runs, the busy flag. */
function mountPlaces({ data = {}, runs = [], busy = false, page = 'library', run = null } = {}) {
  const calls = [], leaves = [], generated = [];
  const enterRun = () => {};
  const world = { data: { root: '/lib/a', decks: [deck], sources: [], today, lastRun: null, ...data }, runs, busy };
  const dataRef = { current: world.data };
  const core = { call: async () => ({}), act: (...args) => { calls.push(args); return Promise.resolve(); }, notify() {}, refresh: async () => {}, setError() {}, refs: { dataRef } };
  const nav = { page, leaving: (go) => { leaves.push(go); }, navigate: (to) => { generated.push(to); }, show: { deck() {} } };
  const session = { run, enterRun };
  const learn = { rememberContext() {} };
  let app;
  function Rows({ actions }) {
    const runFor = (scope) => world.runs.find((item) => JSON.stringify(item.scope) === JSON.stringify(scope));
    return h(m.DeckRow, { deck, progress, open: true, tree, runFor, actions });
  }
  function Places() {
    const [lib, set] = m.useLibraryState({ gen: {}, settings: {} });
    const intents = m.useIntents({ core, lib: { state: lib, set }, nav, session, learn });
    app = { data: world.data, host: {}, dailyPlan: null, selectionNotices: {}, settingsEntry: { openSettings() {}, openModelSettings() {} }, drafts: {}, lib, set, intents, session, core, nav, learn };
    const actions = { start: intents.startReview, confirmStart: intents.confirmStart, resume: intents.openRun, manage: () => {} };
    return h(m.StudyServicesContext.Provider, { value: { busy: world.busy, call: async () => ({}), act: async () => {}, notify() {}, askInChat() {}, host: {} } },
      h(m.AppContext.Provider, { value: app }, h(Rows, { actions }), h(m.ModalRouter)));
  }
  const mounted = ui.mount(() => h(Places));
  const nodes = (pred) => mounted.findAll(pred);
  const dialog = () => nodes((node) => node.type === 'dialog' && String(node.props.className || '').includes('confirm-start'))[0] || null;
  const readerDialog = () => nodes((node) => node.type === 'dialog' && String(node.props.className || '').includes('source-preview'))[0] || null;
  const buttonIn = (root, label) => mounted.find((node) => node.type === 'button' && textOf(node).trim() === label, root);
  return {
    mounted, calls, leaves, generated, enterRun, world,
    get app() { return app; },
    dialog,
    readerDialog,
    dialogs: () => nodes((node) => node.type === 'dialog'),
    /** The ▶ of the deck row, or of its topic row. */
    play: (row) => nodes((node) => node.type === 'button' && String(node.props.className || '').startsWith('map-play'))[row === 'topic' ? 1 : 0],
    confirmButton: (label = '开始练习') => buttonIn(dialog(), label),
    cancelButton: (label = '取消') => buttonIn(dialog(), label),
    menu: () => mounted.find((node) => typeof node.type === 'function' && node.type.name === 'Menu'),
    /** Change the snapshot under the page, as a poll or another library does. */
    snapshot(patch) { world.data = { ...world.data, ...patch }; dataRef.current = world.data; },
    async click(node, extra = {}) { await mounted.act(() => node.props.onClick({ preventDefault() {}, stopPropagation() {}, ...extra })); await mounted.flush(8); },
    async act(fn) { await mounted.act(fn); await mounted.flush(8); },
  };
}

const withZh = (run) => withBrowserGlobals(async () => {
  m.setUiLanguage('zh');
  try {
    await run();
  } finally {
    m.setUiLanguage('zh');
  }
});

const rows = [
  { row: 'deck', args: deckArgs, title: '开始练「行为型模式」？' },
  { row: 'topic', args: topicArgs, title: '开始练主题「Memento」？' },
];

for (const { row, args, title } of rows) {
  test(`${row} row ▶ without an open run asks first and sends nothing`, () => withZh(async () => {
    const places = mountPlaces();
    try {
      await places.click(places.play(row));
      assert.ok(places.dialog(), 'the confirmation is open');
      assert.match(textOf(places.dialog()), new RegExp(title.replace('？', '？')));
      // No question count: review.start pulls unlearned prerequisites into the round, so the row's N is not always what the round holds.
      assert.doesNotMatch(textOf(places.dialog()), /\d+\s*题/);
      assert.ok(places.cancelButton() && places.confirmButton(), 'Cancel and 开始练习');
      assert.match(String(places.confirmButton().props.className), /primary/, 'a start is not drawn as a destructive action');
      assert.deepEqual(places.calls, [], 'nothing was sent');
    } finally { places.mounted.unmount(); }
  }));

  test(`${row} row ▶: confirming sends the same review.start once, however often the button is hit`, () => withZh(async () => {
    const places = mountPlaces();
    try {
      await places.click(places.play(row));
      const button = places.confirmButton();
      await places.act(() => { const first = button.props.onClick({}), second = button.props.onClick({}); return Promise.all([first, second]); });
      assert.deepEqual(places.calls, [['review.start', args, places.enterRun, undefined]]);
      assert.equal(places.dialog(), null, 'the dialog closed');
      assert.deepEqual(places.leaves, [], 'a row start does not add a leave gate it did not have');
    } finally { places.mounted.unmount(); }
  }));

  test(`${row} row ▶: Cancel, Escape and a press outside send nothing`, () => withZh(async () => {
    const places = mountPlaces();
    try {
      await places.click(places.play(row));
      await places.click(places.cancelButton());
      assert.equal(places.dialog(), null, 'Cancel closes');
      await places.click(places.play(row));
      await places.act(() => places.dialog().props.onCancel({ cancelable: true, preventDefault() {} }));
      assert.equal(places.dialog(), null, 'Escape closes');
      await places.click(places.play(row));
      const open = places.dialog(), sheet = open.ref.current;
      await places.act(() => { open.props.onPointerDown({ target: sheet }); open.props.onClick({ target: sheet, clientX: 0, clientY: 0 }); });
      assert.equal(places.dialog(), null, 'a press outside closes');
      assert.deepEqual(places.calls, []);
    } finally { places.mounted.unmount(); }
  }));

  test(`${row} row with an open run resumes at once, without a dialog`, () => withZh(async () => {
    const places = mountPlaces({ runs: [{ id: 'run-7', mode: 'path', scope: args.scope, index: 1, total: 4 }] });
    try {
      await places.click(places.play(row));
      assert.equal(places.dialog(), null);
      assert.deepEqual(places.calls, [['review.get', { runId: 'run-7' }, places.enterRun, { refreshAfter: false }]]);
    } finally { places.mounted.unmount(); }
  }));
}

test('S / 回到题目 with a round to resume resumes it with no dialog, behind the leave gate as before', () => withZh(async () => {
  const places = mountPlaces({ data: { lastRun: { id: 'run-42' } } });
  try {
    await places.act(() => places.app.intents.resumeOrStart());
    assert.equal(places.dialog(), null);
    assert.equal(places.leaves.length, 1, 'the gate is asked at once');
    assert.deepEqual(places.calls, []);
    await places.act(() => places.leaves[0]());
    assert.deepEqual(places.calls, [['review.get', { runId: 'run-42' }, places.enterRun, { refreshAfter: false }]]);
  } finally { places.mounted.unmount(); }
}));

test('S / 回到题目 with nothing to resume asks before today\'s study: no start and no leave gate until confirmed', () => withZh(async () => {
  const places = mountPlaces();
  try {
    await places.act(() => places.app.intents.resumeOrStart());
    assert.ok(places.dialog(), 'the confirmation is open');
    assert.match(textOf(places.dialog()), /开始今日学习？/);
    assert.match(textOf(places.dialog()), /现在没有没做完的练习。/);
    assert.deepEqual(places.leaves, [], 'the unsaved-work gate waits for the answer');
    assert.deepEqual(places.calls, []);
    const button = places.confirmButton();
    await places.act(() => Promise.all([button.props.onClick({}), button.props.onClick({})]));
    assert.equal(places.dialog(), null);
    assert.equal(places.leaves.length, 1, 'then the gate is asked, once');
    assert.deepEqual(places.calls, [], 'and the start waits for the gate');
    await places.act(() => places.leaves[0]());
    assert.deepEqual(places.calls, [['review.start', m.dailyPathArgs(today), places.enterRun, undefined]]);
  } finally { places.mounted.unmount(); }
}));

test('S / 回到题目: cancelling asks no leave gate and starts nothing', () => withZh(async () => {
  const places = mountPlaces();
  try {
    await places.act(() => places.app.intents.resumeOrStart());
    await places.click(places.cancelButton());
    await places.act(() => places.app.intents.resumeOrStart());
    await places.act(() => places.dialog().props.onCancel({ cancelable: true, preventDefault() {} }));
    assert.equal(places.dialog(), null);
    assert.deepEqual(places.leaves, []);
    assert.deepEqual(places.calls, []);
  } finally { places.mounted.unmount(); }
}));

test('S / 回到题目 with no decks still goes to 创建题组, with no dialog', () => withZh(async () => {
  const places = mountPlaces({ data: { decks: [] } });
  try {
    await places.act(() => places.app.intents.resumeOrStart());
    assert.equal(places.dialog(), null);
    assert.equal(places.leaves.length, 1);
    await places.act(() => places.leaves[0]());
    assert.deepEqual(places.generated, ['generate']);
    assert.deepEqual(places.calls, []);
  } finally { places.mounted.unmount(); }
}));

test('S on an unfinished practice page does nothing, as before', () => withZh(async () => {
  const places = mountPlaces({ page: 'review', run: { id: 'r', complete: false } });
  try {
    await places.act(() => places.app.intents.resumeOrStart());
    assert.equal(places.dialog(), null);
    assert.deepEqual([places.leaves.length, places.calls.length], [0, 0]);
  } finally { places.mounted.unmount(); }
}));

test('a pending confirmation does not survive another library, and starts nothing there', () => withZh(async () => {
  for (const open of [(places) => places.click(places.play('deck')), (places) => places.act(() => places.app.intents.resumeOrStart())]) {
    const places = mountPlaces();
    try {
      await open(places);
      const stale = places.confirmButton();
      places.snapshot({ root: '/lib/b' });
      await places.act(() => {});
      assert.equal(places.dialog(), null, 'the dialog is gone with the library it asked about');
      assert.equal(places.app.lib.startConfirm, null, 'and no hidden confirmation is left to hold the keys');
      assert.equal(places.app.lib.modal, null, 'and no hidden modal is left to hold the keys');
      // A press that was already under way still starts nothing.
      await places.act(() => stale.props.onClick({}));
      for (const go of places.leaves.splice(0)) await places.act(go);
      assert.deepEqual(places.calls, []);
    } finally { places.mounted.unmount(); }
  }
}));

test('while another write runs, the confirm button waits (Cancel does not): a press would otherwise be dropped silently', () => withZh(async () => {
  const places = mountPlaces();
  try {
    await places.click(places.play('deck'));
    places.world.busy = true;
    await places.act(() => {});
    assert.equal(places.confirmButton().props.disabled, true);
    assert.notEqual(places.cancelButton().props.disabled, true);
  } finally { places.mounted.unmount(); }
}));

test('the ⋯ menu items still start without a dialog', () => withZh(async () => {
  const places = mountPlaces();
  try {
    for (const id of ['new', 'flashcard', 'quiz', 'wrong']) await places.act(() => places.menu().props.onSelect(id));
    assert.equal(places.dialog(), null);
    assert.deepEqual(places.calls.map(([action, sent]) => [action, sent]), [
      ['review.start', { deckId: 'd1', mode: 'new', fresh: true }],
      ['review.start', { deckId: 'd1', mode: 'flashcard' }],
      ['review.start', { deckId: 'd1', mode: 'quiz' }],
      ['review.start', { deckId: 'd1', mode: 'wrong' }],
    ]);
  } finally { places.mounted.unmount(); }
}));

test('the dialog speaks English on an English page', () => withBrowserGlobals(async () => {
  m.setUiLanguage('en');
  try {
    const seen = [];
    for (const open of [(places) => places.click(places.play('deck')), (places) => places.click(places.play('topic')), (places) => places.act(() => places.app.intents.resumeOrStart())]) {
      const places = mountPlaces();
      try {
        await open(places);
        assert.ok(places.confirmButton('Start practising') && places.cancelButton('Cancel'));
        seen.push(textOf(places.dialog()));
      } finally { places.mounted.unmount(); }
    }
    assert.match(seen[0], /Start practising “行为型模式”\?/);
    assert.match(seen[1], /Start practising the topic “Memento”\?/);
    assert.match(seen[2], /Start today’s study\?/);
    assert.match(seen[2], /There is no unfinished practice right now\./);
    // Also check English when an unfinished round appears while the dialog is open.
    const livePlaces = mountPlaces();
    try {
      await livePlaces.act(() => livePlaces.app.intents.resumeOrStart());
      livePlaces.snapshot({ lastRun: { id: 'run-en' } });
      await livePlaces.act(() => {});
      assert.ok(livePlaces.confirmButton('Continue learning') && livePlaces.cancelButton('Cancel'));
      const resumeText = textOf(livePlaces.dialog());
      assert.match(resumeText, /Resume unfinished practice\?/);
      assert.match(resumeText, /An unfinished practice round just appeared\./);
      seen.push(resumeText);
    } finally { livePlaces.mounted.unmount(); }
    // The only Chinese left is the learner's own deck title.
    for (const text of seen) assert.doesNotMatch(text.replace('行为型模式', ''), /[㐀-鿿]/);
  } finally { m.setUiLanguage('zh'); }
}));

test('S / 回到题目: today\'s plan changing while the dialog is open uses fresh dailyPathArgs at confirm time', () => withZh(async () => {
  const places = mountPlaces();
  try {
    await places.act(() => places.app.intents.resumeOrStart());
    assert.ok(places.dialog(), 'confirmation is open');
    const updatedToday = { course: 'CS2100', scope: [{ deckId: 'd2' }], due: 2, weak: 0, new: 1, size: 3 };
    places.snapshot({ today: updatedToday });
    await places.act(() => {});
    await places.click(places.confirmButton());
    assert.equal(places.dialog(), null);
    assert.equal(places.leaves.length, 1);
    await places.act(() => places.leaves[0]());
    assert.deepEqual(places.calls, [['review.start', m.dailyPathArgs(updatedToday), places.enterRun, undefined]]);
  } finally { places.mounted.unmount(); }
}));

test('S / 回到题目: if an unfinished round appears while the dialog is open, the dialog updates and confirming resumes it', () => withZh(async () => {
  const places = mountPlaces();
  try {
    await places.act(() => places.app.intents.resumeOrStart());
    assert.match(textOf(places.dialog()), /现在没有没做完的练习。/);
    places.snapshot({ lastRun: { id: 'run-99' } });
    await places.act(() => {});
    assert.doesNotMatch(textOf(places.dialog()), /现在没有没做完的练习。/, 'no longer claims there is no unfinished practice');
    assert.match(textOf(places.dialog()), /继续未完成的练习？/);
    const resumeBtn = places.confirmButton('继续学习');
    assert.ok(resumeBtn, 'confirm button updates to 继续学习');
    await places.click(resumeBtn);
    assert.equal(places.dialog(), null);
    assert.equal(places.leaves.length, 1);
    await places.act(() => places.leaves[0]());
    assert.deepEqual(places.calls, [['review.get', { runId: 'run-99' }, places.enterRun, { refreshAfter: false }]]);
  } finally { places.mounted.unmount(); }
}));

for (const { row, args } of rows) {
  test(`${row} row ▶: if a matching open run appears while the dialog is open, confirming resumes it instead of starting another`, () => withZh(async () => {
    const places = mountPlaces();
    try {
      await places.click(places.play(row));
      assert.ok(places.dialog());
      places.snapshot({ runs: [{ id: 'run-55', mode: 'path', scope: args.scope, index: 1, total: 4 }] });
      await places.act(() => {});
      assert.match(textOf(places.dialog()), /继续未完成的练习？/);
      await places.click(places.confirmButton('继续学习'));
      assert.equal(places.dialog(), null);
      assert.deepEqual(places.calls, [['review.get', { runId: 'run-55' }, places.enterRun, { refreshAfter: false }]]);
    } finally { places.mounted.unmount(); }
  }));
}

for (const { label, open } of [
  { label: 'deck row ▶', open: (places) => places.click(places.play('deck')) },
  { label: 'topic row ▶', open: (places) => places.click(places.play('topic')) },
  { label: '回到题目', open: (places) => places.act(() => places.app.intents.resumeOrStart()) },
]) {
  test(`${label}: default focus lands on 取消 and returns to the trigger after Cancel or Escape`, () => withZh(async () => {
    const places = mountPlaces();
    try {
      const trigger = makeFocusable(label);
      globalThis.document.activeElement = trigger;
      await open(places);
      assert.equal(globalThis.document.activeElement, places.cancelButton().ref.current, 'default focus lands on 取消');
      await places.click(places.cancelButton());
      assert.equal(places.dialog(), null);
      assert.equal(globalThis.document.activeElement, trigger, 'focus returns to trigger after Cancel');

      globalThis.document.activeElement = trigger;
      await open(places);
      assert.equal(globalThis.document.activeElement, places.cancelButton().ref.current, 'default focus lands on 取消 on reopen');
      await places.act(() => places.dialog().props.onCancel({ cancelable: true, preventDefault() {} }));
      assert.equal(places.dialog(), null);
      assert.equal(globalThis.document.activeElement, trigger, 'focus returns to trigger after Escape');
    } finally { places.mounted.unmount(); }
  }));
}

test('opening StartConfirm while the reader is open stacks on top without unmounting the reader; Cancel and Escape leave the reader intact', () => withZh(async () => {
  const places = mountPlaces();
  try {
    await places.act(() => places.app.set.setModal({ type: 'source', quote: '原文节选' }));
    const readerBefore = places.readerDialog();
    assert.ok(readerBefore, 'reader dialog is mounted');
    const readerNode = readerBefore.ref.current;
    assert.equal(m.topDialog()?.dialog, readerNode, 'reader is top of dialog stack');

    const trigger = makeFocusable('回到题目');
    globalThis.document.activeElement = trigger;
    await places.act(() => places.app.intents.resumeOrStart());

    assert.equal(places.dialogs().length, 2, 'both reader and StartConfirm dialogs are mounted');
    assert.equal(places.readerDialog().ref.current, readerNode, 'reader stayed mounted with the same dialog instance');
    assert.equal(m.topDialog()?.dialog, places.dialog().ref.current, 'StartConfirm is stacked on top of dialog-stack');
    assert.equal(globalThis.document.activeElement, places.cancelButton().ref.current, 'default focus lands on 取消');

    await places.click(places.cancelButton());
    assert.equal(places.dialog(), null, 'StartConfirm closed on Cancel');
    assert.equal(places.readerDialog().ref.current, readerNode, 'reader remained mounted and untouched after Cancel');
    assert.equal(places.app.lib.modal?.type, 'source');
    assert.equal(m.topDialog()?.dialog, readerNode, 'reader is top of dialog stack again');
    assert.equal(globalThis.document.activeElement, trigger, 'focus returned to trigger after Cancel');

    globalThis.document.activeElement = trigger;
    await places.act(() => places.app.intents.resumeOrStart());
    assert.equal(places.dialogs().length, 2);
    await places.act(() => places.dialog().props.onCancel({ cancelable: true, preventDefault() {} }));
    assert.equal(places.dialog(), null, 'Escape closed only StartConfirm');
    assert.equal(places.readerDialog().ref.current, readerNode, 'reader stayed mounted and intact after Escape');
    assert.equal(m.topDialog()?.dialog, readerNode);
    assert.equal(globalThis.document.activeElement, trigger, 'focus returned to trigger after Escape');
    assert.deepEqual(places.calls, []);
    assert.deepEqual(places.leaves, []);
  } finally { places.mounted.unmount(); }
}));

test('confirming StartConfirm stacked over the reader clears both dialogs once leaving succeeds and starts the round', () => withZh(async () => {
  const places = mountPlaces();
  try {
    await places.act(() => places.app.set.setModal({ type: 'source', quote: '原文节选' }));
    assert.ok(places.readerDialog());
    await places.act(() => places.app.intents.resumeOrStart());
    assert.equal(places.dialogs().length, 2);
    await places.click(places.confirmButton());
    assert.equal(places.dialog(), null, 'StartConfirm closed');
    assert.equal(places.leaves.length, 1);
    assert.ok(places.readerDialog(), 'reader stays until leave gate approves');
    await places.act(() => places.leaves[0]());
    assert.equal(places.readerDialog(), null, 'reader is cleared once leaving succeeds');
    assert.equal(places.app.lib.modal, null);
    assert.deepEqual(places.calls, [['review.start', m.dailyPathArgs(today), places.enterRun, undefined]]);
  } finally { places.mounted.unmount(); }
}));
