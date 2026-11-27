import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { click, loadInteractiveUi, syntheticEvent, withBrowserGlobals } from './helpers/react-harness.mjs';

test('a second completed exam has no practice-path notice from the first report', async () => {
  const ui = await loadInteractiveUi([
    "export {default as Exam} from './ui/Exam.jsx'",
    "export {default as WrittenReport} from './ui/exam/WrittenReport.jsx'",
    "export {default as WrittenSetup} from './ui/exam/WrittenSetup.jsx'",
    "export {StudyServicesContext} from './ui/study-context.jsx'",
  ].join(';'));
  const { Exam, WrittenReport, WrittenSetup, StudyServicesContext } = ui.exports;
  const card = { id: 'q', kind: 'quiz', prompt: 'Which index?', options: [{ id: 'a', text: 'B-tree', correct: true }, { id: 'b', text: 'Other' }] };
  const report = id => ({ runId: id, total: 1, correct: 1, answered: 1, wrong: [], skipped: [], byTopic: [], byDeck: [], byKind: [] });
  const calls = [];
  const call = async (action, args) => {
    calls.push([action, args]);
    if (action === 'review.get') return { id: 'first', complete: true, mode: 'exam' };
    if (action === 'exam.report' || action === 'exam.submit') return report(args.runId);
    if (action === 'review.start') return { id: 'second', mode: args.mode, deckId: 'd', index: 0, total: 1, card, picks: [{ deckId: 'd', cardId: 'q', selected: ['a'] }], startedAt: new Date().toISOString() };
    return {};
  };
  const data = { root: '/test/exams', focus: { course: '*', courses: [] }, decks: [{ id: 'd', title: 'Data', count: 1, available: 1, examCount: 1, examQuizCount: 1 }], sources: [], runs: [], settings: {} };
  await withBrowserGlobals(async () => {
    const h = ui.React.createElement;
    const mount = ui.mount(() => h(StudyServicesContext.Provider, { value: { call, act: async () => ({}), busy: false, host: {} } }, h(Exam, { data, initialRunId: 'first' })));
    try {
      await mount.flush(12);
      const node = type => mount.find(n => n.type === type);
      await mount.act(() => node(WrittenReport).props.onPracticeTopic({ deckId: 'd', topic: 'Trees' }));
      assert.match(node(WrittenReport).props.pathNote, /Trees/);
      await mount.act(() => node(WrittenReport).props.onAgain());
      await mount.act(() => node(WrittenSetup).props.onStart());
      const submit = mount.find(n => n.type === 'button' && ui.textOf(n).trim() === '交卷');
      assert.ok(submit, 'the second exam is running and can be submitted');
      await mount.act(() => click(submit));
      const confirm = mount.find(n => typeof n.props?.onConfirm === 'function' && n.props.onJumpFirstBlank);
      if (confirm) await mount.act(() => confirm.props.onConfirm());
      await mount.flush(12);
      assert.ok(calls.some(([action, args]) => action === 'exam.submit' && args.runId === 'second'));
      assert.equal(node(WrittenReport).props.report.runId, 'second');
      assert.equal(node(WrittenReport).props.pathNote, '', 'the second report must clear the first practice notice');
    } finally { mount.unmount(); }
  });
});

test('resolving the number animation after unmount attempts no state write', async () => {
  const writes = [];
  let loaded = false;
  const probe = '__studyLetterpressLoaded';
  const plugin = {
    name: 'observe-loaded-number-module',
    setup(builder) {
      builder.onResolve({ filter: /letterpress-runtime\.jsx$/ }, () => ({ path: 'runtime', namespace: 'counter-control' }));
      builder.onLoad({ filter: /.*/, namespace: 'counter-control' }, () => ({
        contents: 'globalThis.__studyLetterpressLoaded(); export default function Counter() { return null; }',
      }));
    },
  };
  const ui = await loadInteractiveUi("export {default as Counter} from './ui/letterpress/LetterpressNumber.jsx'", {
    plugins: [plugin], onUnmountedStateWrite: owner => writes.push(owner),
  });
  globalThis[probe] = () => { loaded = true; };
  try {
    await withBrowserGlobals(async () => {
      const mount = ui.mount(() => ui.React.createElement(ui.exports.Counter, { value: 9 }));
      assert.equal(loaded, false, 'the dynamic import is still pending at unmount');
      mount.unmount();
      await nextTurn();
      assert.equal(loaded, true, 'the real dynamic import settled after cleanup');
      assert.deepEqual(writes, [], 'the completed import must not call the unmounted counter setter');
    }, { document: { querySelector: () => ({ getAttribute: () => 'full' }) } });
  } finally { delete globalThis[probe]; }
});

test('a card drag reads its midpoint once and does not scan sibling cards on pointer moves', async () => {
  const targets = [];
  const probe = '__studyBoardDropTargets';
  const plugin = {
    name: 'observe-board-drag-registration',
    setup(builder) {
      builder.onResolve({ filter: /element-adapter$/ }, () => ({ path: 'adapter', namespace: 'drag-control' }));
      builder.onLoad({ filter: /.*/, namespace: 'drag-control' }, () => ({ contents: [
        'export const draggable = () => () => {}',
        'export const monitorForElements = () => () => {}',
        'export const dropTargetForElements = spec => { globalThis.__studyBoardDropTargets.push(spec); return () => {} }',
      ].join(';') }));
    },
  };
  globalThis[probe] = targets;
  try {
    const ui = await loadInteractiveUi("export {default as Board} from './ui/Board.jsx'", { plugins: [plugin] });
    const board = { version: 1, revision: 1, archived: [], columns: [{ id: 'todo', title: 'Todo', cardIds: ['a', 'b', 'c'] }], cards: {} };
    for (const id of board.columns[0].cardIds) board.cards[id] = { id, title: id, note: '', labels: [], due: '' };
    await withBrowserGlobals(async () => {
      const mount = ui.mount(() => ui.React.createElement(ui.exports.Board, { state: { board, mutate: async () => true }, library: { root: '/test/board' } }));
      try {
        const cards = targets.filter(t => t.getData().type === 'board-card');
        assert.equal(cards.length, 3);
        const card = cards[1];
        let reads = 0;
        let scans = 0;
        const parent = { querySelectorAll() { scans++; return cards.map(t => t.element); } };
        for (const { element } of cards) {
          element.parentElement = parent;
          element.getBoundingClientRect = () => { reads++; return { top: 20, height: 60 }; };
        }
        const event = y => ({ location: { current: { input: { clientY: y } } } });
        card.onDragEnter(event(21));
        assert.equal(reads, 1, 'enter measures the target card');
        for (const y of [24, 64, 22, 66]) card.onDrag(event(y));
        assert.deepEqual({ reads, scans }, { reads: 1, scans: 0 }, 'pointer moves must reuse the measured midpoint without scanning sibling cards');
      } finally { mount.unmount(); }
    });
  } finally { delete globalThis[probe]; }
});

test('changing only the skeleton ID resets the viewport, retaining it for the same ID', async () => {
  const ui = await loadInteractiveUi("export {ClassCanvas} from './ui/SkeletonCanvas.jsx'; export {StudyServicesContext} from './ui/study-context.jsx'");
  const { ClassCanvas, StudyServicesContext } = ui.exports;
  const h = ui.React.createElement;
  let skeleton = { id: 'first', nodes: [{ id: 'n', term: 'Tree', meaning: 'Index', attributes: [], cards: [] }], relations: [], sequences: [] };
  await withBrowserGlobals(async () => {
    const services = { call: async () => ({}), act: async () => undefined, host: {} };
    const onSelect = () => {};
    const mount = ui.mount(() => h(StudyServicesContext.Provider, { value: services }, h(ClassCanvas, { skeleton, selected: null, onSelect })));
    try {
      const element = name => mount.find(n => n.type === 'div' && String(n.props?.className || '').split(' ').includes(name));
      const transform = () => element('skc-world').props.style.transform;
      const initial = transform();
      const target = {};
      await mount.act(() => element('skc-view').props.onKeyDown(syntheticEvent({ key: 'ArrowLeft', target, currentTarget: target })));
      const panned = transform();
      assert.notEqual(panned, initial);
      skeleton = { ...skeleton };
      mount.rerender();
      assert.equal(transform(), panned, 'equivalent data for the same skeleton preserves the pan');
      skeleton = { ...skeleton, id: 'second' };
      mount.rerender();
      assert.equal(transform(), initial, 'switching only the skeleton ID must reset the viewport');
    } finally { mount.unmount(); }
  });
});
