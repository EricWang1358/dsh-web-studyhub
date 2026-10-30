import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

// 3.7.x delete track, D2: the entries to 归档 are closer. A deck row's ⋯ menu archives directly, the Sources page archives the checked materials in one go,
// and every archive notice offers 撤销 and (where it is allowed after archiving) the shortcut to the one permanent-delete dialog the app already has.
const m = await loadUi(`
  export { archiveMenuItem, idsOfDocuments, offerDeckArchived, offerDocumentsArchived, openRunsOn } from './ui/archive-entries.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const han = /[㐀-鿿]/;
const inLanguage = (language, work) => { m.setUiLanguage(language); try { return work(); } finally { m.setUiLanguage('zh'); } };

/** The app's one notice slot, as the learner sees it: what the last notice said and which buttons it carries. */
function fakeToast() {
  const log = { shown: [], errors: [], dismissed: 0 };
  return { log, show: (notice) => { log.shown.push(notice); }, error: (error) => { log.errors.push(typeof error === 'string' ? error : error?.message); }, dismiss: () => { log.dismissed++; } };
}
const last = (toast) => toast.log.shown.at(-1);

test('a deck row menu has 归档 (last, after 管理题组), disabled while the app is busy, and names the practice runs it ends', () => {
  const deck = { id: 'd1', title: '期中复习' };
  assert.deepEqual(m.archiveMenuItem(deck, { busy: false, runs: 0 }), { id: 'archive', label: '归档', disabled: false });
  assert.equal(m.archiveMenuItem(deck, { busy: true, runs: 0 }).disabled, true);
  assert.equal(m.archiveMenuItem(deck, { busy: false, runs: 2 }).hint, '会结束 2 轮练习', 'the cost is on the menu before the click, not only in the notice');
  assert.equal(m.archiveMenuItem(deck, { busy: false, runs: 0 }).hint, undefined, 'nothing to end, nothing to say');
  assert.equal(inLanguage('en', () => m.archiveMenuItem(deck, { busy: false, runs: 1 }).label), 'Archive');
  assert.match(inLanguage('en', () => m.archiveMenuItem(deck, { busy: false, runs: 1 }).hint), /^Ends 1 practice run/);
});

test('a system deck (为你定制) has no 归档 entry: its archived row offers neither restore nor delete', () => {
  assert.equal(m.archiveMenuItem({ id: 'c', title: '为你定制', systemKind: 'coach' }, { busy: false, runs: 0 }), null);
});

test('runs on a deck are counted the way the Manage page counts them: by deckId or deckIds', () => {
  const runs = [{ deckId: 'd1' }, { deckIds: ['d2', 'd1'] }, { deckId: 'd2' }, { scope: [] }];
  assert.equal(m.openRunsOn(runs, 'd1'), 2);
  assert.equal(m.openRunsOn(runs, 'd9'), 0);
  assert.equal(m.openRunsOn(undefined, 'd1'), 0);
});

test('the deck notice says what was archived and how many runs ended, offers 撤销 and then 永久删除… that opens the existing dialog for this deck', async () => {
  const toast = fakeToast(), asked = [], restored = [];
  m.offerDeckArchived({ toast, deck: { id: 'd1', title: '期中复习' }, done: { ok: true, closedRuns: 2 }, runs: [],
    restore: async () => { restored.push('d1'); return true; }, focus: () => null, onRemove: (id, options) => asked.push([id, options]), returnFocus: '.back' });
  const notice = last(toast);
  assert.match(notice.message, /已归档「期中复习」，结束了 2 轮进行中的练习；撤销只恢复题组，结束的练习不会重新打开。/);
  assert.equal(notice.action.label, '撤销');
  assert.equal(notice.secondary.label, '永久删除…');
  notice.secondary.onClick();
  assert.deepEqual(asked, [['d1', { returnFocus: '.back' }]], 'the dialog opens for the deck just archived, and says where the focus returns');
  assert.equal(toast.log.dismissed, 1, 'the offer is closed when its second action is used');
  const fresh = fakeToast();
  m.offerDeckArchived({ toast: fresh, deck: { id: 'd1', title: '期中复习' }, done: { ok: true, closedRuns: 0 }, runs: [], restore: async () => true, onRemove() {} });
  assert.equal(last(fresh).message.startsWith('已归档「期中复习」'), true);
  assert.doesNotMatch(last(fresh).message, /结束了/);
  assert.equal(await last(fresh).action.onClick(), true, '撤销 runs restore()');
});

test('a host that does not count the ended runs falls back to the open runs the snapshot lists', () => {
  const toast = fakeToast();
  m.offerDeckArchived({ toast, deck: { id: 'd1', title: 'A' }, done: { ok: true }, runs: [{ deckId: 'd1' }, { deckId: 'd2' }], restore: async () => true, onRemove() {} });
  assert.match(last(toast).message, /结束了 1 轮/);
});

test('a deck that cannot be permanently deleted (a system deck) gets 撤销 and no 永久删除… shortcut', () => {
  const toast = fakeToast();
  m.offerDeckArchived({ toast, deck: { id: 'c', title: '为你定制', systemKind: 'coach' }, done: { closedRuns: 0 }, runs: [], restore: async () => true, onRemove() {} });
  assert.equal(last(toast).secondary, undefined);
  assert.equal(last(toast).action.label, '撤销');
});

test('the deck notice reads in English with no Chinese left, and its 撤销 puts the deck back with the same words as the Manage page', async () => {
  inLanguage('en', () => {
    const toast = fakeToast();
    m.offerDeckArchived({ toast, deck: { id: 'd1', title: 'Midterm' }, done: { closedRuns: 1 }, runs: [], restore: async () => true, onRemove() {} });
    assert.doesNotMatch(last(toast).message, han);
    assert.equal(last(toast).action.label, 'Undo');
    assert.equal(last(toast).secondary.label, 'Permanently delete…');
  });
});

test('materials: one document names itself and keeps the shortcut to its own permanent-delete dialog; several say how many and where they are', () => {
  const one = { key: 'k1', title: '第 1 讲', sourceIds: ['a', 'b'], archived: false }, two = { key: 'k2', title: '第 2 讲', sourceIds: ['c'], archived: false };
  const toast = fakeToast(), removing = [];
  m.offerDocumentsArchived({ toast, items: [one], restore: async () => true, focus: () => null, onRemove: (item) => removing.push(item) });
  assert.match(last(toast).message, /^已归档「第 1 讲」：在「已归档」里，可以恢复或永久删除。（8 秒内、下一次删除前可撤销）$/);
  last(toast).secondary.onClick();
  assert.deepEqual(removing.map((item) => item.key), ['k1']);
  assert.equal(removing[0].archived, true, 'the dialog is told the document is archived now');
  assert.equal(removing[0].fromNotice, true, 'and that it opened from the notice, so the focus goes back');
  const many = fakeToast();
  m.offerDocumentsArchived({ toast: many, items: [one, two], restore: async () => true, focus: () => null, onRemove() { throw new Error('no single dialog for several'); } });
  assert.match(last(many).message, /^已归档 2 份资料：在「已归档」里，可以恢复或永久删除。（8 秒内/);
  assert.equal(last(many).action.label, '撤销');
  assert.equal(last(many).secondary, undefined, 'permanent delete stays one document at a time');
  assert.equal(inLanguage('en', () => { const t = fakeToast(); m.offerDocumentsArchived({ toast: t, items: [one, two], restore: async () => true, onRemove() {} }); return han.test(last(t).message); }), false);
});

test('the checked documents go out as one list of page ids, each page once', () => {
  assert.deepEqual(m.idsOfDocuments([{ sourceIds: ['a', 'b'] }, { sourceIds: ['b', 'c'] }, { sourceIds: ['d'] }]), ['a', 'b', 'c', 'd']);
  assert.deepEqual(m.idsOfDocuments([]), []);
});
