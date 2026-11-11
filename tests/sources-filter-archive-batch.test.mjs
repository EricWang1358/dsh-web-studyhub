import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const uiMod = await loadUi(`
  export { default as Sources, removeDocuments, RemoveDialog, BatchRemoveDialog } from './ui/Sources.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { documentSearchText } from './ui/SourcePicker.jsx';
  export { filterItems } from './ui/components/index.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const { Sources, removeDocuments, RemoveDialog, BatchRemoveDialog, AppContext, documentSearchText, filterItems, setUiLanguage } = uiMod;

test('removeDocuments submits deduplicated sourceIds in a single confirmed transaction and rolls back on failure', async () => {
  const items = [
    { key: 'doc-1', sourceIds: ['p1', 'p2'] },
    { key: 'doc-2', sourceIds: ['p2', 'p3'] },
  ];
  const calls = [];
  const ok = await removeDocuments(items, {
    act: async (action, args) => { calls.push({ action, args }); return { ok: true }; },
  });
  assert.deepEqual(calls, [{ action: 'source.remove', args: { sourceIds: ['p1', 'p2', 'p3'], confirm: true } }]);
  assert.deepEqual(ok, { removed: ['p1', 'p2', 'p3'], failed: [] });

  const failed = await removeDocuments(items, {
    act: async () => { throw new Error('Source is referenced'); },
  });
  assert.deepEqual(failed.removed, []);
  assert.equal(failed.failed.length, 3);
});

test('BatchRemoveDialog and RemoveDialog block deletion when cited, unarchived, or missing bank/study contexts in zh and en', () => {
  const citedBatch = [
    { key: 'a', title: 'Lecture A', archived: true, usedBy: [{ id: 'd1', title: 'OS Midterm' }], pages: [{ sourceId: 's1' }], sourceIds: ['s1'] },
    { key: 'b', title: 'Lecture B', archived: true, usedBy: [], pages: [{ sourceId: 's2' }], sourceIds: ['s2'] },
  ];
  setUiLanguage('zh');
  const zhHtml = renderToStaticMarkup(React.createElement(BatchRemoveDialog, { items: citedBatch, onClose() {}, onRemoved() {} }));
  assert.match(zhHtml, /永久删除这 2 份资料？/);
  assert.match(zhHtml, /其中 1 份资料有题组引用，不能永久删除/);
  assert.match(zhHtml, /Lecture A/);
  assert.match(zhHtml, /disabled=""[^>]*>确认永久删除/);

  const cleanBatch = [
    { key: 'a', title: 'Lecture A', archived: true, usedBy: [], pages: [{ sourceId: 's1' }], sourceIds: ['s1'] },
    { key: 'b', title: 'Lecture B', archived: true, usedBy: [], pages: [{ sourceId: 's2' }], sourceIds: ['s2'] },
  ];
  const modularCtx = { data: { contexts: ['library', 'materials'] } };
  const zhModularSingle = renderToStaticMarkup(
    React.createElement(AppContext.Provider, { value: modularCtx },
      React.createElement(RemoveDialog, { item: cleanBatch[0], onClose() {}, onRemoved() {} })),
  );
  assert.match(zhModularSingle, /删除资料前请启用题库和学习组件/);
  assert.match(zhModularSingle, /disabled=""[^>]*>确认永久删除/);

  setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(React.createElement(BatchRemoveDialog, { items: citedBatch, onClose() {}, onRemoved() {} }));
    assert.match(enHtml, /Permanently delete these 2 sources\?/);
    assert.match(enHtml, /1 selected source\(s\) are cited by decks/);
    assert.doesNotMatch(enHtml.replace(/Lecture [AB]|OS Midterm/g, ''), /[\u3400-\u9fff]/);

    const enModularBatch = renderToStaticMarkup(
      React.createElement(AppContext.Provider, { value: modularCtx },
        React.createElement(BatchRemoveDialog, { items: cleanBatch, onClose() {}, onRemoved() {} })),
    );
    assert.match(enModularBatch, /Turn on the question bank and study components before permanently deleting sources/);
    assert.match(enModularBatch, /disabled=""[^>]*>Confirm permanent deletion/);
    assert.doesNotMatch(enModularBatch.replace(/Lecture [AB]/g, ''), /[\u3400-\u9fff]/);
  } finally {
    setUiLanguage('zh');
  }
});

test('documentSearchText + filterItems match NFKC case-insensitively across title, renamedFrom, filename, course, and format', () => {
  const items = [
    { key: '1', title: '虚拟内存讲义', renamedFrom: 'LEC05_VM.pdf', filename: 'lec05_vm.pdf', courses: ['操作系统'], format: 'pdf', pages: [{}, {}], sourceIds: ['1a', '1b'] },
    { key: '2', title: '进程调度笔记', filename: 'sched.md', courses: ['操作系统'], format: 'md', pages: [{}], sourceIds: ['2a'] },
  ];
  assert.deepEqual(filterItems(items, 'ＬＥＣ０５ pdf', documentSearchText).map(i => i.key), ['1']);
  assert.deepEqual(filterItems(items, 'markdown 操作系统', documentSearchText).map(i => i.key), ['2']);
  assert.deepEqual(filterItems(items, '不存在的关键词', documentSearchText), []);

  const data = {
    root: 'lib',
    sources: [{ id: 's1', title: '虚拟内存讲义', text: '分页', createdAt: new Date().toISOString(), courses: ['操作系统'], usedBy: [] }],
    decks: [], drafts: [], jobs: [], focus: { course: '*', courses: [{ name: '操作系统' }] }, modelReady: true,
  };
  setUiLanguage('zh');
  assert.match(renderToStaticMarkup(React.createElement(Sources, { data, setModal() {} })), /筛选资料…/);
});
