import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { loadUi } from './helpers/ui-module.mjs';

// 删除这组批注 against the real annotation operations: the thread goes at once, by the ids kept when 删除 was pressed (ui/document-preview/annotation/delete-thread.js),
// so an answer kept on the same passage during the 撤销 time survives the notice leaving; 撤销 puts back exactly what was removed. (Review of #506: the first
// version sent "everything on this passage" 8 s later and took the new answer with it.)
const m = await loadUi(`export { deleteKeptThread, restoreKeptThread } from './ui/document-preview/annotation/delete-thread.js'; export { createUndoable } from './ui/undoable.js'; export { setUiLanguage } from './ui/i18n.js';`);

function fakeToast() {
  const log = { errors: [], current: null };
  const leave = () => { const was = log.current; log.current = null; was?.onLeave?.(); };
  return { log, show(notice) { leave(); log.current = notice; }, error(error) { log.errors.push(String(error?.message || error)); }, dismiss() { leave(); }, timeout() { leave(); } };
}

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-annotation-undo-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = new Store(root);
  const ops = createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: (fn) => store.update(async (state) => { const own = { sources: state.sources, documents: state.documents || [] }; const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result; }) });
  const call = (action, args = {}) => ops.handlers[action](args, {});
  const imported = await call('materials.document.import', { filename: 'n.md', dataBase64: Buffer.from('# N\n\nQuality attributes such as latency and availability shape tactics.\n').toString('base64') });
  const document = await call('materials.document.get', { id: imported.documentId });
  const selection = (await call('materials.selection.resolve', { documentId: document.documentId, revision: document.revision, quote: 'latency and availability' })).selection;
  return { call, documentId: document.documentId, revision: document.revision, selection };
}
const node = (id, parentId = null) => ({ id, parentId, question: `Q ${id}`, answer: `A ${id}`, language: 'English' });
const ids = async ({ call, documentId, revision }) => (await call('materials.annotation.list', { documentId, revision })).items.map((item) => item.id).sort();

test('delete, then keep a new answer on the same passage, then the notice leaves: the new answer survives', async (t) => {
  const lib = await library(t);
  const { call, documentId, revision, selection } = lib;
  await call('materials.annotation.save', { documentId, revision, selection, nodes: [node('old-1'), node('old-2', 'old-1')] });
  const toast = fakeToast(), unit = m.createUndoable({ toast });
  const { removed } = await m.deleteKeptThread({ call, documentId, revision, ids: ['old-1'], selection });
  assert.deepEqual(removed.map((item) => item.id).sort(), ['old-1', 'old-2'], 'a deleted answer takes the answers asked inside it');
  unit.restoreWith({ message: '已删除这组批注', restore: () => m.restoreKeptThread({ call, documentId, revision, removed }) });
  assert.equal((await call('materials.annotation.save', { documentId, revision, selection, nodes: [node('new-1')] })).status, 'saved');
  toast.timeout();
  assert.deepEqual(await ids(lib), ['new-1'], 'the answer kept after 删除 is still there');
});

test('撤销 puts back exactly what was removed, beside an answer kept meanwhile', async (t) => {
  const lib = await library(t);
  const { call, documentId, revision, selection } = lib;
  await call('materials.annotation.save', { documentId, revision, selection, nodes: [node('old-1')] });
  const toast = fakeToast(), unit = m.createUndoable({ toast });
  const { removed } = await m.deleteKeptThread({ call, documentId, revision, ids: ['old-1'], selection });
  unit.restoreWith({ message: '已删除这组批注', restore: () => m.restoreKeptThread({ call, documentId, revision, removed }) });
  await call('materials.annotation.save', { documentId, revision, selection, nodes: [node('new-1')] });
  assert.equal(await toast.log.current.action.onClick(), true);
  assert.deepEqual(await ids(lib), ['new-1', 'old-1']);
  assert.deepEqual(toast.log.errors, []);
});

test('撤销 that no longer fits (the passage filled up with new answers meanwhile) says why, in the learner\'s language', async (t) => {
  const lib = await library(t);
  const { call, documentId, revision, selection } = lib;
  await call('materials.annotation.save', { documentId, revision, selection, nodes: [node('old-1')] });
  const toast = fakeToast(), unit = m.createUndoable({ toast });
  const { removed } = await m.deleteKeptThread({ call, documentId, revision, ids: ['old-1'], selection });
  unit.restoreWith({ message: '已删除这组批注', restore: () => m.restoreKeptThread({ call, documentId, revision, removed }) });
  for (let n = 1; n <= 8; n++) await call('materials.annotation.save', { documentId, revision, selection, nodes: [node('new-' + n)] });
  assert.equal(await toast.log.current.action.onClick(), false);
  assert.match(toast.log.errors[0], /这段原文上的问答已经到了上限（最多 8 条），原来那组批注没能放回。/);
  m.setUiLanguage('en');
  try {
    await toast.log.current.action.onClick();
    assert.doesNotMatch(toast.log.errors[1], /does not fit its thread/);
    assert.doesNotMatch(toast.log.errors[1], /[一-鿿]/);
  } finally { m.setUiLanguage('zh'); }
});
