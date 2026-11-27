import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../lib/store.js';
import { createMaterialsOperations, reanchorPosition, reanchorSelection, resolveSelectionState } from '../lib/contexts/materials/operations.js';
import { makeTextPdf } from './helpers/text-pdf.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const HAN_RE = /[\u3400-\u9fff]/;
const require = createRequire(import.meta.url);

const compiledUi = await build({
  stdin: {
    contents: `
      export * from './ui/i18n.js';
      export * from './ui/document-preview/marks-export.js';
      export * from './ui/document-preview/original-file.js';
      export { default as StaleAnnotations } from './ui/document-preview/StaleAnnotations.jsx';
      export { OriginalNotice, OriginalDialog } from './ui/document-preview/OriginalFile.jsx';
      export { MarksSummarySection, MarksSummaryDialog } from './ui/document-preview/MarksSummaryPanel.jsx';
      export { useReaderMarks } from './ui/document-preview/marks/useReaderMarks.jsx';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const uiMod = { exports: {} };
new Function('require', 'module', 'exports', compiledUi.outputFiles[0].text)(require, uiMod, uiMod.exports);
const uiLib = uiMod.exports;

const h = React.createElement;
const renderHtml = (component, props) => renderToStaticMarkup(h(component, props));
const plainText = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

async function createMaterialsFixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'materials-reanchor-'));
  const outside = await mkdtemp(join(tmpdir(), 'materials-reanchor-ext-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const store = new Store(root);
  const ops = createMaterialsOperations({
    root,
    read: async () => {
      const state = await store.read();
      return structuredClone({ sources: state.sources, documents: state.documents || [] });
    },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own);
      state.sources = own.sources;
      state.documents = own.documents;
      return result;
    }),
    ...options,
  });
  const call = (action, args = {}, req = {}) => ops.handlers[action](args, req);
  return { root, outside, store, call };
}

test('cross-revision re-anchoring relocates unchanged, shifted, whitespace-normalized and context-anchored quotes while marking deleted quotes stale', async t => {
  let bankCardsList = [];
  const f = await createMaterialsFixture(t, { bankCards: async () => bankCardsList });

  const v1Body = [
    '# Distributed Systems Lecture',
    'Linearizability guarantees that every operation appears to take effect atomically at a single point between invocation and response.',
    'First bounded context defines billing rules. Second bounded context defines shipping rules.',
    'Obsolete paragraph about two-phase commit blocking forever without coordinator recovery.',
  ].join('\n\n');

  const first = await f.call('materials.document.import', {
    filename: 'distributed.md',
    dataBase64: Buffer.from(v1Body).toString('base64'),
  });
  const docV1 = await f.call('materials.document.get', { id: first.documentId });

  const selLinear = (await f.call('materials.selection.resolve', {
    documentId: docV1.documentId,
    revision: docV1.revision,
    quote: 'every operation appears to take effect atomically',
  })).selection;
  const selRepeated = (await f.call('materials.selection.resolve', {
    documentId: docV1.documentId,
    revision: docV1.revision,
    quote: 'bounded context',
    prefix: 'Second ',
  })).selection;
  const selDeleted = (await f.call('materials.selection.resolve', {
    documentId: docV1.documentId,
    revision: docV1.revision,
    quote: 'two-phase commit blocking forever',
  })).selection;

  // Save annotations & marks on v1, plus card quote links in bank.
  await f.call('materials.annotation.save', {
    documentId: docV1.documentId,
    revision: docV1.revision,
    selection: selLinear,
    nodes: [{ id: 'ann-keep', parentId: null, question: 'What does linearizability guarantee?', answer: 'Real-time atomic ordering.', language: 'English' }],
  });
  await f.call('materials.annotation.save', {
    documentId: docV1.documentId,
    revision: docV1.revision,
    selection: selDeleted,
    nodes: [{ id: 'ann-del', parentId: null, question: 'Why does 2PC block?', answer: 'Participants wait if coordinator crashes.', language: 'English' }],
  });
  await f.call('materials.marks.save', {
    documentId: docV1.documentId,
    revision: docV1.revision,
    selection: selRepeated,
    style: 'highlight',
  });
  await f.call('materials.marks.save', {
    documentId: docV1.documentId,
    revision: docV1.revision,
    selection: selDeleted,
    style: 'underline',
  });

  bankCardsList = [
    { deckId: 'd1', deckTitle: 'DS Deck', id: 'c-keep', kind: 'quiz', prompt: 'Linearizability?', answer: 'Atomic', explanation: 'Exp 1', selections: [selLinear] },
    { deckId: 'd1', deckTitle: 'DS Deck', id: 'c-del', kind: 'quiz', prompt: '2PC?', answer: 'Blocks', explanation: 'Exp 2', selections: [selDeleted] },
  ];

  // Update material to v2: insert a new preface (shifting all offsets), wrap whitespace in linearizability quote,
  // edit earlier sentence before repeated "bounded context" while keeping immediate suffix " defines shipping rules.",
  // and delete the 2PC paragraph completely.
  const v2Body = [
    '# Distributed Systems Lecture (Revised)',
    'New preface paragraph added at the top of the lecture notes to shift every subsequent offset.',
    'Linearizability guarantees that every   operation\nappears to take effect atomically at a single point between invocation and response.',
    'Rewritten invoice domain rules. Updated second bounded context defines shipping rules.',
    'Raft consensus elects a single leader per term.',
  ].join('\n\n');

  const second = await f.call('materials.document.import', {
    documentId: docV1.documentId,
    filename: 'distributed.md',
    dataBase64: Buffer.from(v2Body).toString('base64'),
  });
  assert.notEqual(second.revision, docV1.revision);
  const state = await f.store.read();

  // Direct resolveSelectionState(..., { revalidate: true }) & reanchorSelection checks:
  const reanchoredLinear = resolveSelectionState(state, { ...selLinear, revalidate: true });
  assert.equal(reanchoredLinear.status, 'resolved');
  assert.equal(reanchoredLinear.selection.revision, second.revision);
  assert.ok(reanchoredLinear.selection.start > selLinear.start, 'offset shifted forward after added preface');
  assert.match(reanchoredLinear.selection.quote, /every\s+operation\s+appears to take effect atomically/);

  const reanchoredRepeated = reanchorSelection(state, selRepeated);
  assert.equal(reanchoredRepeated.status, 'resolved', 'unique suffix anchor disambiguates repeated phrase even after prefix edit');
  assert.equal(reanchoredRepeated.selection.revision, second.revision);
  const v2Text = second.document.sources[0].text;
  assert.match(v2Text.slice(reanchoredRepeated.selection.end, reanchoredRepeated.selection.end + 25), /defines shipping rules/);

  const reanchoredDeleted = reanchorSelection(state, selDeleted);
  assert.equal(reanchoredDeleted.status, 'stale');
  assert.equal(reanchoredDeleted.stale, true);
  assert.equal(reanchoredDeleted.selection.stale, true);
  assert.equal(reanchoredDeleted.selection.quote, selDeleted.quote, 'original quote is preserved on stale result');

  // Annotations automatically re-anchored on v2 vs honestly marked stale:
  const annList = await f.call('materials.annotation.list', { documentId: docV1.documentId, revision: second.revision });
  assert.equal(annList.items.length, 1);
  assert.equal(annList.items[0].id, 'ann-keep');
  assert.equal(annList.items[0].status, 'resolved');
  assert.equal(annList.stale.length, 1);
  assert.equal(annList.stale[0].threads[0].quote, selDeleted.quote);
  assert.equal(annList.stale[0].threads[0].answer, 'Participants wait if coordinator crashes.');

  // Marks automatically re-anchored on v2 vs surfaced in stale list:
  const marksList = await f.call('materials.marks.list', { documentId: docV1.documentId, revision: second.revision });
  assert.equal(marksList.items.length, 1);
  assert.equal(marksList.items[0].style, 'highlight');
  assert.equal(marksList.items[0].status, 'resolved');
  assert.equal(marksList.stale.length, 1);
  assert.equal(marksList.stale[0].items.length, 1);
  assert.equal(marksList.stale[0].items[0].quote, selDeleted.quote);
  assert.equal(marksList.stale[0].items[0].stale, true);

  // Card links automatically re-anchor surviving selections and mark deleted ones stale:
  const links = await f.call('materials.links.list', { documentId: docV1.documentId });
  const keepLink = links.links.find(item => item.cardId === 'c-keep');
  const delLink = links.links.find(item => item.cardId === 'c-del');
  assert.equal(keepLink.status, 'resolved');
  assert.equal(keepLink.selection.revision, second.revision);
  assert.equal(keepLink.selection.sourceId, second.sourceIds[0]);
  assert.equal(delLink.status, 'stale');
  assert.equal(delLink.stale, true);
  assert.equal(delLink.selection.quote, selDeleted.quote);
});

test('paged cross-revision re-anchoring updates page and section when a cover page shifts subsequent pages', () => {
  const rev1Sources = [
    { id: 'p1', text: 'Chapter 1: Consensus algorithms ensure safety.', document: { page: 1, section: 'ch1' } },
  ];
  const initial = reanchorPosition(rev1Sources, { quote: 'Consensus algorithms ensure safety' }, { documentId: 'doc-p', revision: 'r1' });
  assert.equal(initial.status, 'resolved');
  assert.equal(initial.selection.page, 1);
  assert.equal(initial.selection.section, 'ch1');

  const rev2Sources = [
    { id: 'p1-new', text: 'Cover page added for Fall semester.', document: { page: 1, section: 'cover' } },
    { id: 'p2-new', text: 'Chapter 1: Consensus algorithms ensure safety.', document: { page: 2, section: 'ch1-shifted' } },
  ];
  const shifted = reanchorPosition(rev2Sources, { ...initial.selection, revalidate: true }, { documentId: 'doc-p', revision: 'r2' });
  assert.equal(shifted.status, 'resolved');
  assert.equal(shifted.selection.revision, 'r2');
  assert.equal(shifted.selection.sourceId, 'p2-new');
  assert.equal(shifted.selection.page, 2);
  assert.equal(shifted.selection.section, 'ch1-shifted');
});

test('StaleAnnotations renders qa.answer, notes, and staleMarks with 1-click dismiss; useReaderMarks exposes staleMarks', async () => {
  uiLib.setUiLanguage('zh');
  const stale = [
    {
      revision: 'rev-old',
      count: 2,
      threads: [
        {
          key: 's1|0|20',
          ids: ['a1'],
          quote: 'Two-phase commit blocks when coordinator fails.',
          question: '为什么会阻塞？',
          note: '考前重点核对',
          qa: { question: '为什么会阻塞？', answer: '因为参与者处于不确定状态，必须等待协调者恢复。' },
          nodes: 1,
        },
      ],
    },
  ];
  const staleMarks = [
    { id: 'highlight|s1|30|55', style: 'highlight', quote: 'Deleted Raft pre-vote optimization note.', stale: true },
  ];
  const html = renderHtml(uiLib.StaleAnnotations, {
    stale,
    staleMarks,
    onClear() {},
    onDismissAnnotation() {},
    onDismissMark() {},
    onClearMarks() {},
  });
  const text = plainText(html);
  assert.match(text, /原文已更新 · 2 条批注、1 处划线/);
  assert.match(text, /Two-phase commit blocks when coordinator fails\./);
  assert.match(text, /考前重点核对/);
  assert.match(text, /因为参与者处于不确定状态，必须等待协调者恢复。/, 'renders qa.answer on stale Q&A annotations');
  assert.match(text, /Deleted Raft pre-vote optimization note\./, 'renders saved quote of stale highlight');
  assert.match(text, /移除这条划线/, 'renders 1-click dismiss action for stale mark');

  // Verify useReaderMarks surfaces both in-list stale marks and older-revision stale groups, and wires 1-click delete:
  const deletedCalls = [];
  const hooks = []; let cursor = 0, effects = [];
  const fakeReact = {
    ...React,
    useState: init => {
      const idx = cursor++;
      if (!(idx in hooks)) hooks[idx] = typeof init === 'function' ? init() : init;
      const set = val => { hooks[idx] = typeof val === 'function' ? val(hooks[idx]) : val; };
      return [hooks[idx], set];
    },
    useRef: val => ({ current: val }),
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useContext: () => ({ model: { ready: true } }),
    useEffect: fn => { effects.push(fn); },
  };
  fakeReact.default = fakeReact;
  const hookBuild = await build({
    stdin: { contents: `export { useReaderMarks } from './ui/document-preview/marks/useReaderMarks.jsx';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent',
  });
  const hookMod = { exports: {} };
  new Function('require', 'module', 'exports', hookBuild.outputFiles[0].text)(id => (id === 'react' ? fakeReact : require(id)), hookMod, hookMod.exports);

  const call = async (name, args) => {
    if (name === 'materials.marks.list') {
      return {
        items: [
          { id: 'm-ok', key: 's1|0|10', style: 'highlight', status: 'resolved', selection: { sourceId: 's1', start: 0, end: 10, quote: 'Active bit' } },
          { id: 'm-inline-stale', key: 's1|20|30', style: 'underline', status: 'stale', selection: { sourceId: 's1', start: 20, end: 30, quote: 'Inline stale quote' } },
        ],
        stale: [
          { revision: 'r0', count: 1, items: [{ id: 'm-old-rev', style: 'bold', quote: 'Older revision stale quote', stale: true }] },
        ],
        limits: { queue: 40 },
      };
    }
    if (name === 'materials.marks.delete') {
      deletedCalls.push(args);
      return { deleted: 1 };
    }
    return {};
  };
  const props = {
    call,
    document: { documentId: 'doc-1', revision: 'r1', sources: [{ id: 's1', text: 'Active bit and more words here.' }] },
    data: {},
    body: { current: null },
    rendered: 1,
    enabled: true,
  };
  let result;
  const runRender = () => {
    cursor = 0;
    effects = [];
    result = hookMod.exports.useReaderMarks(props);
    for (const eff of effects.splice(0)) eff();
  };
  runRender();
  await new Promise(resolve => setTimeout(resolve, 15));
  runRender();

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, 'm-ok');
  assert.deepEqual(
    result.staleMarks.map(item => [item.id, item.quote]),
    [['m-inline-stale', 'Inline stale quote'], ['m-old-rev', 'Older revision stale quote']],
  );
  await result.dismissStaleMark('m-old-rev');
  assert.deepEqual(deletedCalls[0], { documentId: 'doc-1', revision: 'r1', ids: ['m-old-rev'], stale: true });
});

test('external version.external.path 1-click sync preserves reference mode without copying into attachments/ and re-anchors notes', async t => {
  const f = await createMaterialsFixture(t);
  const extPdf = join(f.outside, 'OperatingSystems.pdf');
  const initialBytes = await makeTextPdf([
    ['Virtual memory isolates address spaces across processes in modern kernels.'],
    ['Legacy segmentation paragraph that will be removed in the next edition.'],
  ]);
  await writeFile(extPdf, initialBytes);

  // Simulate legacy/converted document whose original is attached ONLY by reference (version.external.path, NO document.externalPath).
  const imported = await f.call('materials.document.import', {
    filename: 'OperatingSystems.pdf',
    dataBase64: initialBytes.toString('base64'),
  });
  await f.store.update(state => {
    for (const doc of state.documents) {
      delete doc.externalPath;
      for (const ver of doc.versions) ver.attachment = null;
    }
  });
  await rm(join(f.root, 'attachments'), { recursive: true, force: true });

  const attached = await f.call('materials.original.attach', {
    documentId: imported.documentId,
    path: extPdf,
    mode: 'reference',
  });
  assert.equal(attached.status, 'attached');
  assert.equal(attached.mode, 'reference');
  assert.equal((await f.store.read()).documents[0].externalPath, undefined, 'only version.external.path is stored');

  // Save a highlight on page 1 (kept) and an annotation on page 2 (to be deleted).
  const docBefore = await f.call('materials.document.get', { documentId: imported.documentId });
  const selKeep = (await f.call('materials.selection.resolve', {
    documentId: imported.documentId,
    revision: docBefore.revision,
    quote: 'Virtual memory isolates address spaces',
  })).selection;
  const selDrop = (await f.call('materials.selection.resolve', {
    documentId: imported.documentId,
    revision: docBefore.revision,
    quote: 'Legacy segmentation paragraph',
  })).selection;
  await f.call('materials.marks.save', {
    documentId: imported.documentId,
    revision: docBefore.revision,
    selection: selKeep,
    style: 'highlight',
  });
  await f.call('materials.annotation.save', {
    documentId: imported.documentId,
    revision: docBefore.revision,
    selection: selDrop,
    nodes: [{ id: 'os-drop', parentId: null, question: 'Why removed?', answer: 'Replaced by paging.', language: 'English' }],
  });

  // Modify the external PDF on disk: insert a cover page (shifting Virtual memory to page 2) and replace segmentation page.
  const updatedBytes = await makeTextPdf([
    ['Preface to the Second Edition of Operating Systems.'],
    ['Virtual memory isolates address spaces across processes in modern kernels.'],
    ['Page tables translate virtual page numbers to physical frames.'],
  ]);
  await writeFile(extPdf, updatedBytes);

  const detectedChanged = await f.call('materials.document.get', { documentId: imported.documentId });
  assert.equal(detectedChanged.original.status, 'changed');
  assert.equal(detectedChanged.original.mode, 'reference');

  // UI notice offers 1-click 同步最新文件内容 when external file changed on disk:
  uiLib.setUiLanguage('zh');
  const noticeMarkup = renderHtml(uiLib.OriginalNotice, { document: detectedChanged, onAction() {} });
  assert.match(plainText(noticeMarkup), /同步最新文件内容/);

  // Run 1-click sync (`materials.document.get` with `refresh: true`):
  const synced = await f.call('materials.document.get', { documentId: imported.documentId, refresh: true });
  assert.notEqual(synced.revision, docBefore.revision);
  assert.equal(synced.original.mode, 'reference', 'reference storage mode is preserved');
  assert.equal(synced.original.status, 'ok');
  assert.equal(synced.original.path, extPdf);
  assert.equal(synced.sources.length, 3);
  assert.equal(existsSync(join(f.root, 'attachments')), false, 'external PDF was NEVER copied into attachments/');

  const storedAfter = await f.store.read();
  const activeVer = storedAfter.documents[0].versions.find(v => v.revision === synced.revision);
  assert.equal(activeVer.attachment, null);
  assert.equal(activeVer.external.path, extPdf);

  // Surviving highlight re-anchored onto page 2; removed annotation surfaced in stale with its answer:
  const marksAfter = await f.call('materials.marks.list', { documentId: imported.documentId, revision: synced.revision });
  assert.equal(marksAfter.items.length, 1);
  assert.equal(marksAfter.items[0].selection.page, 2);
  assert.equal(marksAfter.items[0].status, 'resolved');

  const annAfter = await f.call('materials.annotation.list', { documentId: imported.documentId, revision: synced.revision });
  assert.equal(annAfter.items.length, 0);
  assert.equal(annAfter.stale.length, 1);
  assert.equal(annAfter.stale[0].threads[0].answer, 'Replaced by paging.');
});

test('Markdown export formats document title, chapter/page headings, blockquotes, notes/Q&A answers, and [待核对原句] tags on stale items', () => {
  uiLib.setUiLanguage('zh');
  const summary = uiLib.collectMarksSummary({
    title: 'Database Internals',
    sources: [
      { id: 's-p1', title: 'Database Internals · p.1', document: { page: 1 } },
      { id: 's-p2', title: 'Database Internals · p.2', document: { page: 2 } },
    ],
    chapters: [
      { id: 'ch1', title: '第 1 章 存储引擎', sourceIds: ['s-p1', 's-p2'], startPage: 1, endPage: 2 },
    ],
    marks: [
      {
        id: 'highlight|s-p2|10|40',
        style: 'highlight',
        status: 'resolved',
        selection: { sourceId: 's-p2', start: 10, end: 40, page: 2, quote: 'LSM-trees batch writes sequentially in memory.' },
      },
    ],
    annotations: [
      {
        id: 'a-btree',
        key: 's-p1|5|35',
        parentId: null,
        question: '为什么 B-Tree 适合点查？',
        note: '和 LSM 对比记忆',
        answer: '因为层高固定在 3-4 层，磁盘随机读次数有上限。',
        status: 'resolved',
        selection: { sourceId: 's-p1', start: 5, end: 35, page: 1, quote: 'B-Trees bound point-lookup depth logarithmically.' },
      },
    ],
    staleMarks: [
      { id: 'underline|old|1|20', style: 'underline', quote: 'Deprecated mmap buffer manager paragraph.', stale: true },
    ],
    staleAnnotations: [
      {
        revision: 'old-rev',
        count: 1,
        threads: [
          {
            key: 'old|50|80',
            quote: 'Removed shadow-paging crash recovery note.',
            question: '影子分页的缺点？',
            answer: '会导致严重的页碎片化。',
            nodes: 1,
          },
        ],
      },
    ],
  });

  // Page 1 comes before Page 2, and unplaced stale items follow at the end:
  assert.equal(summary.total, 4);
  assert.equal(summary.staleCount, 2);
  assert.equal(summary.sections[0].heading, '第 1 章 存储引擎 · 第 1 页');
  assert.equal(summary.sections[1].heading, '第 1 章 存储引擎 · 第 2 页');
  assert.equal(summary.sections[2].heading, '旧版待核对');

  const md = uiLib.formatMarksMarkdown(summary);
  assert.match(md, /^# Database Internals\n/);
  assert.match(md, /## 第 1 章 存储引擎 · 第 1 页/);
  assert.match(md, /> B-Trees bound point-lookup depth logarithmically\./);
  assert.match(md, /- \*\*笔记\*\*：和 LSM 对比记忆/);
  assert.match(md, /- \*\*提问\*\*：为什么 B-Tree 适合点查？/);
  assert.match(md, /- \*\*回答\*\*：因为层高固定在 3-4 层，磁盘随机读次数有上限。/);
  assert.match(md, /## 第 1 章 存储引擎 · 第 2 页/);
  assert.match(md, /> LSM-trees batch writes sequentially in memory\./);
  assert.match(md, /- \*\*标记\*\*：荧光笔/);
  assert.match(md, /> Deprecated mmap buffer manager paragraph\. \[待核对原句\]/);
  assert.match(md, /> Removed shadow-paging crash recovery note\. \[待核对原句\]/);
  assert.match(md, /- \*\*回答\*\*：会导致严重的页碎片化。/);
  assert.equal(uiLib.marksExportFilename('Database: Internals?'), 'Database Internals-批注与划线.md');
});

test('offline-first HTML plugin copy is honest and English UI + Markdown export contain zero Han characters', async () => {
  const zhPlugin = JSON.parse(await readFile('locale/plugins/materials/zh.json', 'utf8'));
  const enPlugin = JSON.parse(await readFile('locale/plugins/materials/en.json', 'utf8'));
  assert.match(zhPlugin.meta.description, /\.html/);
  assert.match(zhPlugin.meta.description, /本地|离线/);
  assert.doesNotMatch(enPlugin.meta.description, /Import PDFs, notes and web pages as citable sources\./);
  assert.match(enPlugin.meta.description, /\.html/i);
  assert.doesNotMatch(enPlugin.meta.description, HAN_RE);

  const interactive = await loadInteractiveUi(`
    export { default as DocumentViewer } from './ui/document-preview/DocumentViewer.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { ToastContext } from './ui/components/Feedback.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  await withBrowserGlobals(async () => {
    const prevStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const storageMap = new Map();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
        setItem: (key, value) => { storageMap.set(key, String(value)); },
        removeItem: (key) => { storageMap.delete(key); },
      },
    });
    const {
      React: HarnessReact,
      mount,
      exports: { DocumentViewer, StudyServicesContext, ToastContext, setUiLanguage },
    } = interactive;
    setUiLanguage('zh');
    const doc = {
      documentId: 'doc-read-mode',
      id: 'doc-read-mode',
      revision: 'r2',
      format: 'pdf',
      title: 'Distributed Systems Lecture',
      filename: 'distributed.pdf',
      originalAvailable: false,
      sources: [{ id: 's1', text: 'Linearizability guarantees atomic ordering across replicas.', document: { format: 'pdf', page: 1, totalPages: 1 } }],
    };
    const keptUserAnnotation = {
      id: 'ann-keep-read-mode',
      key: 's1|0|15',
      parentId: null,
      question: 'What does linearizability guarantee?',
      answer: 'Real-time atomic ordering across replicas.',
      status: 'resolved',
      selection: {
        documentId: 'doc-read-mode',
        revision: 'r2',
        sourceId: 's1',
        start: 0,
        end: 15,
        quote: 'Linearizability',
      },
    };
    const staleGroup = {
      revision: 'r1',
      count: 1,
      threads: [
        {
          key: 's1|40|72',
          ids: ['ann-stale-1'],
          quote: 'Two-phase commit blocks without coordinator recovery.',
          question: 'Why does 2PC block?',
          answer: 'Participants wait while coordinator is down.',
          nodes: 1,
        },
      ],
    };
    const call = async (action) => {
      if (action === 'materials.document.get') return doc;
      if (action === 'materials.links.list') return { links: [] };
      if (action === 'materials.annotation.list') return { items: [keptUserAnnotation], stale: [staleGroup] };
      if (action === 'materials.marks.list') return { items: [], stale: [], limits: { queue: 40 } };
      if (action === 'runtime.capabilities') return [];
      if (action === 'snapshot') return { decks: [], settings: {} };
      return {};
    };
    const noop = () => {};
    const toast = { show: noop, error: noop, dismiss: noop };
    const studyServices = { call, act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
    const viewer = mount(() => HarnessReact.createElement(
      ToastContext.Provider,
      { value: toast },
      HarnessReact.createElement(
        StudyServicesContext.Provider,
        { value: studyServices },
        HarnessReact.createElement(DocumentViewer, {
          source: { id: 's1', title: 'Distributed Systems Lecture', text: doc.sources[0].text, document: { format: 'pdf', page: 1, totalPages: 1 } },
          call,
          data: { sources: [], decks: [], settings: {} },
          host: {},
        }),
      ),
    ));
    try {
      await viewer.flush(10);
      assert.equal(globalThis.localStorage.getItem('study-reader-annotation'), null, 'starts in default Read mode');
      const toolsAside = viewer.find((node) => node.type === 'aside' && typeof node.props?.className === 'string' && node.props.className.includes('reader-tools'));
      assert.ok(toolsAside, 'reader tools aside is mounted');
      assert.equal(toolsAside.props.hidden, true, 'tools panel is closed (toolsOn === false) in narrow Read mode');

      const aux = viewer.find((node) => node.type === 'div' && node.props?.className === 'reader-aux');
      assert.ok(aux, 'reader-aux container renders');
      const staleDetails = viewer.find(
        (node) => node.type === 'details' && typeof node.props?.className === 'string' && node.props.className.includes('reader-annotations-stale'),
        aux,
      );
      assert.ok(staleDetails, 'StaleAnnotations renders inside .reader-aux in Read mode without switching to Annotate mode');
      assert.match(
        viewer.text(staleDetails),
        /Two-phase commit blocks without coordinator recovery\./,
        'StaleAnnotations displays the stale quote in Read mode',
      );

      const linksSection = viewer.find((node) => node.type === 'section' && node.props?.className === 'reader-links');
      assert.ok(linksSection, 'PassageLinksPanel renders kept user annotations in Read mode');
      const annotationGroup = viewer.find(
        (node) => node.type === 'details' && node.props?.['data-kind'] === 'annotation',
        linksSection,
      );
      assert.ok(annotationGroup, 'kept user annotation group is present in PassageLinksPanel in Read mode');
      assert.match(viewer.text(annotationGroup), /Linearizability/);
      assert.match(viewer.text(annotationGroup), /批注 1/);
    } finally {
      viewer.unmount();
      setUiLanguage('zh');
      if (prevStorage) Object.defineProperty(globalThis, 'localStorage', prevStorage);
      else delete globalThis.localStorage;
    }
  });

  uiLib.setUiLanguage('en');
  try {
    const bookPath = 'D:\\Courses\\Systems\\Lecture.pdf';
    const staleHtml = renderHtml(uiLib.StaleAnnotations, {
      stale: [{ revision: 'old', count: 1, threads: [{ key: 'k1', ids: ['a1'], quote: 'Old quote', question: 'Why?', note: 'Check this', qa: { answer: 'Because of quorum.' }, nodes: 1 }] }],
      staleMarks: [{ id: 'm1', style: 'highlight', quote: 'Old mark quote', stale: true }],
      onClear() {},
      onDismissAnnotation() {},
      onDismissMark() {},
      onClearMarks() {},
    });
    assert.doesNotMatch(staleHtml, HAN_RE, 'StaleAnnotations in English has zero Han characters');
    assert.match(plainText(staleHtml), /Because of quorum\./);
    assert.match(plainText(staleHtml), /Dismiss highlight/);

    const noticeHtml = renderHtml(uiLib.OriginalNotice, {
      document: { format: 'pdf', original: { mode: 'reference', status: 'changed', reason: 'changed', path: bookPath, bytes: 2048 } },
      onAction() {},
      onSync() {},
    });
    assert.doesNotMatch(noticeHtml.replaceAll(bookPath, ''), HAN_RE, 'OriginalNotice in English has zero Han characters');
    assert.match(plainText(noticeHtml), /Sync latest file from disk/);

    const dialogStates = [
      { info: { mode: 'reference', status: 'ok', path: bookPath, bytes: 4096, format: 'pdf' } },
      { info: { mode: 'reference', status: 'changed', reason: 'changed', path: bookPath, bytes: 4096, format: 'pdf' } },
      { info: { mode: 'reference', status: 'ok', path: bookPath, bytes: 4096, format: 'pdf' }, phase: 'done', done: { mode: 'reference', synced: true } },
    ];
    for (const state of dialogStates) {
      const dialogHtml = renderHtml(uiLib.OriginalDialog, {
        target: { documentId: 'doc-1', title: 'Systems', format: 'pdf' },
        call: () => {},
        onClose: () => {},
        onChanged: () => {},
        initial: state,
      });
      assert.doesNotMatch(dialogHtml.replaceAll(bookPath, ''), HAN_RE, `OriginalDialog state has zero Han chars: ${JSON.stringify(state)}`);
    }

    const summary = uiLib.collectMarksSummary({
      title: 'Systems Notes',
      sources: [{ id: 's1', title: 'Systems Notes · p.1', document: { page: 1 } }],
      chapters: [{ id: 'c1', title: 'Chapter 1 Intro', sourceIds: ['s1'], startPage: 1, endPage: 1 }],
      marks: [{ id: 'm1', style: 'highlight', status: 'resolved', selection: { sourceId: 's1', start: 0, end: 10, page: 1, quote: 'Key quote' } }],
      annotations: [{ id: 'a1', key: 's1|0|10', parentId: null, question: 'What?', note: 'Important', answer: 'Answer text', status: 'resolved', selection: { sourceId: 's1', start: 0, end: 10, page: 1, quote: 'Key quote' } }],
      staleMarks: [{ id: 'ms1', style: 'underline', quote: 'Old quote', stale: true }],
    });
    const sectionHtml = renderHtml(uiLib.MarksSummarySection, { summary, onJump() {}, onOpenAnnotation() {}, onOpenSheet() {} });
    const modalHtml = renderHtml(uiLib.MarksSummaryDialog, { open: true, summary, onClose() {}, onJump() {}, onOpenAnnotation() {} });
    const enMarkdown = uiLib.formatMarksMarkdown(summary);
    const enFilename = uiLib.marksExportFilename('Systems Notes');

    assert.doesNotMatch(sectionHtml, HAN_RE, 'MarksSummarySection in English has zero Han characters');
    assert.doesNotMatch(modalHtml, HAN_RE, 'MarksSummaryDialog in English has zero Han characters');
    assert.doesNotMatch(enMarkdown, HAN_RE, 'Exported English Markdown has zero Han characters');
    assert.doesNotMatch(enFilename, HAN_RE, 'Exported English filename has zero Han characters');
    assert.match(enMarkdown, /\[Verify quote\]/);
    assert.match(plainText(sectionHtml), /Highlights & Notes/);
    assert.match(plainText(sectionHtml), /Copy Markdown/);
    assert.match(plainText(sectionHtml), /Export \.md/);
  } finally {
    uiLib.setUiLanguage('zh');
  }
});
