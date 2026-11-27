import test from 'node:test';
import assert from 'node:assert/strict';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

/* 发给主会话 from the 问 AI panel names a point of the book. When that point is no longer among the book's rows (another writer rebuilt the outline while
   the panel was open), pressing it must say so, like every other action on a gone point (ui/book/use-book-actions.js), and not leave a button that does nothing. */

test('发给主会话 on a point the book no longer has says so and keeps the panel (and what was typed); a live point hands over and closes it', async () => {
  const interactive = await loadInteractiveUi(`
    export { default as BookAskLayer } from './ui/book/BookAskLayer.jsx';
    export { default as BookAsk } from './ui/book/BookAsk.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
  `);
  const { BookAskLayer, BookAsk, StudyServicesContext } = interactive.exports;
  const h = interactive.React.createElement;
  const noop = () => {};
  await withBrowserGlobals(async () => {
    const notices = [], asked = [];
    let closed = 0;
    const services = { call: async () => ({ status: 'none' }), act: async () => undefined, busy: false, notify: (notice) => notices.push(notice),
      askInChat: async (text) => { asked.push(text); return 'filled'; }, host: { chat: true }, openSettings: noop, navigate: noop, openModal: noop };
    const point = { hid: 'p-1', title: 'Point one', files: { gen: 'p-1.gen.md', mine: 'p-1.mine.md' } };
    const rows = [{ hid: 'p-1', key: 'k-1', node: point }];
    const ai = { ask: { heading: 'p-gone', anchor: { getClientRects: () => [] } }, closeAsk: () => { closed += 1; }, openAsk: noop, start: noop };
    const book = { files: {}, language: 'zh' };
    const view = () => h(StudyServicesContext.Provider, { value: services },
      h(BookAskLayer, { ai, rows, book, course: 'C', model: { ready: true }, pageRef: { current: null } }));
    const mounted = interactive.mount(view);
    try {
      const panel = () => mounted.find((node) => node.type === BookAsk);
      assert.ok(panel(), 'the panel is open');
      await mounted.act(() => panel().props.onSend({ words: '', instruction: 'make it simpler' }));
      assert.equal(asked.length, 0, 'nothing is handed over for a point that is gone');
      assert.equal(closed, 0, 'the panel stays, with what the learner typed');
      assert.equal(notices.length, 1, `the learner is told why nothing happened, got ${JSON.stringify(notices)}`);
      assert.match(typeof notices[0] === 'string' ? notices[0] : notices[0].text, /这一节已不在总纲里/);

      ai.ask = { heading: 'p-1', anchor: { getClientRects: () => [] } };
      mounted.rerender(view);
      await mounted.act(() => panel().props.onSend({ words: '', instruction: 'make it simpler' }));
      assert.equal(asked.length, 1, 'a live point is handed over');
      assert.equal(closed, 1, 'and the panel closes');
    } finally {
      mounted.unmount();
    }
  });
});
