import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { locateQuote, locateVisibleQuote, selectionRequest, sessionFileAddress, groupPassageLinks } from '../ui/document-preview/selection.js';
import { click, loadInteractiveUi, textOf, withBrowserGlobals } from './helpers/react-harness.mjs';

test('citation navigation does not choose the first repeated passage', () => {
  assert.equal(locateQuote('same passage; same passage', 'same passage').status, 'ambiguous');
  assert.deepEqual(locateQuote('same passage; same passage', 'same passage', { start: 14 }), { status: 'resolved', start: 14, end: 26 });
  assert.equal(locateQuote('edited passage', 'same passage', { start: 0 }).status, 'missing');
  assert.equal(locateQuote('new prefix; same passage', 'same passage', { start: 0 }).status, 'stale');
});

test('a selected passage carries its revision and page without inventing a byte offset', () => {
  assert.deepEqual(selectionRequest({ documentId: 'm1', revision: 'r2' }, { quote: 'visible words', prefix: 'before ', suffix: ' after', page: 3 }),
    { documentId: 'm1', revision: 'r2', quote: 'visible words', prefix: 'before ', suffix: ' after', page: 3 });
  assert.equal(selectionRequest({ documentId: 'm1', revision: 'r2' }, { quote: '   ' }), null);
});

test('host file resource addresses encode filename and session while retaining Windows drive', () => {
  assert.equal(sessionFileAddress('session 1', 'D:\\Notes\\资料 #1.pdf'), 'dsh-resource://file/session/session%201/D:/Notes/%E8%B5%84%E6%96%99%20%231.pdf');
});

test('one passage groups all related cards across decks without hiding stale links', () => {
  const selection = { documentId: 'm1', revision: 'r1', sourceId: 's1', start: 2, end: 7, quote: 'words' };
  const links = [{ deckId: 'a', cardId: 'q1', selection, status: 'resolved' }, { deckId: 'b', cardId: 'q2', selection, status: 'stale' }];
  const groups = groupPassageLinks(links);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].links.length, 2);
  assert.equal(groups[0].links[1].status, 'stale');
});

test('legacy extracted material selections retain the source identity', () => {
  assert.equal(selectionRequest({ documentId: 'source-old', sourceId: 'old', revision: 'r1' }, { quote: 'old notes' }).sourceId, 'old');
});

test('rendered table marks use context across source separators and keep repeated passages ambiguous', () => {
  assert.deepEqual(locateVisibleQuote('Headingleft rightEnding', { quote: 'left\tright', prefix: 'Heading\n', suffix: '\nEnding' }), { status: 'resolved', start: 7, end: 17 });
  assert.equal(locateVisibleQuote('left right; left right', { quote: 'left\tright' }).status, 'ambiguous');
});

const compiled = await build({ stdin: { contents: `export { registerDocumentLearning } from './ui/document-preview/native.jsx';
  export { default as CitationDisclosure } from './ui/CitationDisclosure.jsx';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { registerDocumentLearning, CitationDisclosure } = module.exports;

test('native document extension uses the public toolbar and renderer registrations and disposes both', () => {
  const registrations = [], definitions = [], effects = [], disposed = [];
  const slots = { inject: (_name, initialize) => initialize(), register: (definition, component) => {
    registrations.push({ definition, component }); return () => disposed.push(definition.name);
  } };
  const ctx = { slots, effect: initialize => { const dispose = initialize(); if (dispose) effects.push(dispose); },
    inject: (_dependencies, initialize) => {
      const dispose = initialize({ slots, documentPreviews: { register: definition => {
        definitions.push(definition); return () => disposed.push(definition.id);
      } } }); effects.push(dispose);
    } };
  globalThis.window = { document: { createElement: () => ({ remove: () => disposed.push('style') }), head: { append: () => {} } } };
  try {
    registerDocumentLearning(ctx, () => {}, () => {});
    assert.deepEqual(registrations.map(item => item.definition.name), ['sidebar.right.tab.document.actions', 'sidebar.right.tab.document']);
    assert.deepEqual(definitions[0].extensions, ['html', 'htm']);
    assert.equal(definitions[0].loading, 'text-pages');
    effects.reverse().forEach(dispose => dispose());
    assert.ok(disposed.includes('study-html'));
    assert.ok(disposed.includes('sidebar.right.tab.document.actions'));
    assert.ok(disposed.includes('sidebar.right.tab.document'));
  } finally { delete globalThis.window; }
});

test('card selections expose a source entry', () => {
  const citations = renderToStaticMarkup(React.createElement(CitationDisclosure, { card: { selections: [{ sourceId: 's1', quote: 'passage', revision: 'r1' }] },
    sources: [{ id: 's1', text: 'passage' }], onOpenSource: () => {} }));
  assert.match(citations, /引用与来源核对/);
  assert.match(citations, /1.*条/);
  const selection = { sourceId: 's1', quote: 'passage', revision: 'r1' };
  const copied = renderToStaticMarkup(React.createElement(CitationDisclosure, { card: { selections: [selection], citations: [{ sourceId: 's1', quote: 'passage', selection: structuredClone(selection) }] }, sources: [], onOpenSource: () => {} }));
  assert.match(copied, /1.*条/);
});

/* #456: the page a question in 原始 PDF is about comes from the page the reader's own controls show. */
test('the page scope names the page source, a page without saved text, and the page selection without a quote', async () => {
  const { pageScopeOf, pageSelection, pageCount, clampPage, pageKey } = await import('../ui/document-preview/page-scope.js');
  const sources = [{ id: 'p1', text: 'One', document: { page: 1, totalPages: 4 } }, { id: 'p2', text: '  \n', document: { page: 2, totalPages: 4 } },
    { id: 'p4', text: 'Four', document: { page: 4, totalPages: 4 } }];
  assert.deepEqual(pageScopeOf(sources, 1), { kind: 'page', page: 1, sourceId: 'p1', empty: false });
  assert.equal(pageScopeOf(sources, 2).empty, true, 'a page of blanks has nothing to answer from');
  assert.deepEqual(pageScopeOf(sources, 3), { kind: 'page', page: 3, sourceId: '', empty: true }, 'a page skipped on import');
  assert.equal(pageScopeOf([{ id: 'c', chars: 40, document: { page: 1 } }], 1).empty, false, 'a converted page without its text still counts its characters');
  assert.equal(pageCount(sources), 4); assert.equal(pageCount([{ id: 'a' }, { id: 'b' }]), 2);
  const document = { documentId: 'doc', revision: 'r1' };
  assert.deepEqual(pageSelection(document, pageScopeOf(sources, 4)), { documentId: 'doc', revision: 'r1', sourceId: 'p4', page: 4 });
  assert.equal(pageSelection(document, pageScopeOf(sources, 3)), null);
  assert.equal(pageSelection(document, null), null);
  assert.equal(clampPage('3', 4), 3); assert.equal(clampPage(9, 4), 4); assert.equal(clampPage(0, 4), 1); assert.equal(clampPage('2.6', 4), 3);
  assert.equal(clampPage('', 4), null); assert.equal(clampPage('abc', 4), null);
  assert.notEqual(pageKey({ documentId: 'doc', revision: 'r1', sourceId: 'p1', page: 1 }), pageKey({ documentId: 'doc', revision: 'r1', sourceId: 'p4', page: 4 }));
});

const interactivePreview = await loadInteractiveUi(`
  export { default as DocumentViewer } from './ui/document-preview/DocumentViewer.jsx';
  export { default as DocumentLearning } from './ui/document-preview/DocumentLearning.jsx';
  export { default as PdfOriginal } from './ui/document-preview/reader/PdfOriginal.jsx';
  export { ReaderModelContext } from './ui/document-preview/ReaderModelGate.jsx';
  export { ToastContext } from './ui/components/Feedback.jsx';
`);

const flushAsync = async (turns = 6) => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

test('原始 PDF: a selection is never captured or shown there, the reading panel is kept for the way back, and the frame follows the page controls', async () => {
  const { React, mount, exports: { DocumentViewer, PdfOriginal, ToastContext } } = interactivePreview;
  await withBrowserGlobals(async () => {
    const prevCreate = URL.createObjectURL;
    const prevRevoke = URL.revokeObjectURL;
    let selectionLookups = 0;
    const prevGetSelection = globalThis.window.getSelection;
    URL.createObjectURL = () => 'blob:pdf-doc-1';
    URL.revokeObjectURL = () => {};
    globalThis.window.getSelection = () => {
      selectionLookups += 1;
      return { isCollapsed: true, rangeCount: 0, toString: () => '' };
    };
    const calls = [];
    const doc = {
      documentId: 'doc-1',
      id: 'doc-1',
      revision: 'r1',
      format: 'pdf',
      originalAvailable: true,
      title: 'Slides.pdf',
      filename: 'Slides.pdf',
      sources: [
        { id: 'p1', text: 'Alpha passage on page one.', document: { page: 1, totalPages: 2 } },
        { id: 'p2', text: 'Beta passage on page two.', document: { page: 2, totalPages: 2 } },
      ],
    };
    const keptAnnotation = {
      id: 'ann-1',
      key: 'p1:0:13',
      status: 'resolved',
      selection: { documentId: 'doc-1', revision: 'r1', sourceId: 'p1', start: 0, end: 13, quote: 'Alpha passage', page: 1 },
      question: 'What is alpha?',
      answer: 'Alpha answer',
      parentId: null,
    };
    const call = async (action, args) => {
      calls.push({ action, args });
      if (action === 'materials.document.get') return doc;
      if (action === 'materials.links.list') return { links: [] };
      if (action === 'materials.document.bytes') return { mime: 'application/pdf', dataBase64: Buffer.from('%PDF-1.4').toString('base64') };
      if (action === 'materials.annotation.list') return { items: [keptAnnotation], stale: [] };
      if (action === 'materials.selection.resolve') return { status: 'resolved', selection: keptAnnotation.selection };
      if (action === 'runtime.capabilities') {
        return [
          { id: 'materials', operations: [{ name: 'selection.ask', available: true }, { name: 'annotation.save', available: true }] },
          { id: 'generation', operations: [{ name: 'selection.start', available: true }, { name: 'selection.jobs', available: true }] },
        ];
      }
      if (action === 'generation.selection.jobs') {
        return { jobs: [{ id: 'job-1', operationId: 'op-1', status: 'running', deckId: 'd1', deckTitle: 'Deck 1', selection: keptAnnotation.selection }] };
      }
      if (action === 'bank.decks.list') return { decks: [{ id: 'd1', title: 'Deck 1' }] };
      if (action === 'snapshot') return { decks: [{ id: 'd1', title: 'Deck 1' }], settings: {} };
      return {};
    };
    const toast = { show: () => {}, dismiss: () => {} };
    const Harness = () => React.createElement(
      ToastContext.Provider,
      { value: toast },
      React.createElement(DocumentViewer, {
        source: doc.sources[0],
        call,
        data: { root: 'lib-1', decks: [{ id: 'd1', title: 'Deck 1' }], sources: doc.sources, model: { ready: true } },
        onCaseFromPassage: () => {},
      }),
    );

    const view = mount(() => React.createElement(Harness));
    try {
      await view.flush(8);

      // 更多 menu contains 学习工具 and opens/closes the tools panel.
      const moreTrigger = view.find((n) => n.type === 'button' && (n.props?.['aria-label'] === '更多' || textOf(n).includes('更多')));
      assert.ok(moreTrigger, '更多 toolbar trigger is rendered');
      const layoutBefore = view.find((n) => String(n.props?.className || '').includes('reader-layout'));
      const toolsInitiallyOn = layoutBefore.props['data-tools'] === 'on';
      click(moreTrigger);
      view.rerender();
      const toolsMenuItem = view.find((n) => n.type === 'button' && textOf(n).includes('学习工具'));
      assert.ok(toolsMenuItem, '学习工具 is an item of 更多');
      click(toolsMenuItem);
      view.rerender();
      const layoutAfterToggle = view.find((n) => String(n.props?.className || '').includes('reader-layout'));
      assert.equal(layoutAfterToggle.props['data-tools'], toolsInitiallyOn ? 'off' : 'on', '学习工具 toggles the tools panel');
      if (layoutAfterToggle.props['data-tools'] === 'off') {
        click(view.find((n) => n.type === 'button' && (n.props?.['aria-label'] === '更多' || textOf(n).includes('更多'))));
        view.rerender();
        click(view.find((n) => n.type === 'button' && textOf(n).includes('学习工具')));
        view.rerender();
      }

      // In 阅读 view, 使用当前选区 and 围绕这段出案例题 are offered; open the kept annotation to populate capture + thread.
      assert.ok(view.find((n) => n.type === 'button' && textOf(n).includes('使用当前选区')), '使用当前选区 is offered in 阅读');
      assert.ok(view.find((n) => n.type === 'button' && textOf(n).includes('围绕这段出案例题')), '围绕这段出案例题 is offered in 阅读');
      const linkGroup = view.find((n) => n.type === 'details' && String(n.props?.className || '').includes('reader-link-group'));
      assert.ok(linkGroup, 'kept annotation group is listed in PassageLinksPanel');
      linkGroup.props.onToggle({ currentTarget: { open: true } });
      view.rerender();
      const annotationBtn = view.find((n) => n.type === 'button' && textOf(n).includes('打开问答'));
      assert.ok(annotationBtn, 'kept annotation offers 打开问答');
      click(annotationBtn);
      await view.flush(8);
      const selPanelInRead = view.find((n) => n.props?.className === 'reader-learning' && n.props?.['data-scope'] === 'selection');
      assert.ok(textOf(selPanelInRead).includes('Alpha passage'), 'reading panel displays captured selection');

      // Switch to 原始 PDF.
      const pdfSwitchBtn = view.find((n) => n.type === 'button' && textOf(n).trim() === '原始 PDF');
      assert.ok(pdfSwitchBtn, 'toolbar offers 原始 PDF switch');
      click(pdfSwitchBtn);
      await view.flush(8);

      const rootEl = view.find((n) => String(n.props?.className || '').includes('study-document-viewer'));
      assert.equal(rootEl.props['data-mode'], 'original', 'viewer switched to original PDF mode');
      assert.equal(view.find((n) => n.type === 'button' && textOf(n).includes('使用当前选区')), null, '使用当前选区 is hidden in 原始 PDF');
      assert.equal(view.find((n) => n.type === 'button' && textOf(n).includes('围绕这段出案例题')), null, '围绕这段出案例题 is hidden in 原始 PDF');
      assert.doesNotMatch(view.text(), /要选中文字提问或补题，请切换到「阅读」/, 'old dead-end hint is absent');
      const helpBtn = view.find((n) => n.props?.['aria-label'] === '在原始 PDF 里怎么提问');
      assert.ok(helpBtn, 'HelpTip 「?」 explains how asking works in 原始 PDF');

      // Two panels: selection panel stays mounted in jobsOnly mode; page panel asks about the active page.
      const selPanelInPdf = view.find((n) => n.props?.className === 'reader-learning' && n.props?.['data-scope'] === 'selection');
      const pagePanelInPdf = view.find((n) => n.props?.className === 'reader-learning' && n.props?.['data-scope'] === 'page');
      assert.equal(selPanelInPdf.props.hidden, false, 'selection panel remains visible for its job cards');
      assert.ok(view.find((n) => n.props?.['data-jobs-only'] === 'true', selPanelInPdf), 'selection panel renders jobs-only mode in 原始 PDF');
      assert.doesNotMatch(textOf(selPanelInPdf), /针对这段原文提问/, 'selection ask form is not shown in 原始 PDF');
      assert.equal(pagePanelInPdf.props.hidden, false, 'page panel is visible in 原始 PDF');
      assert.match(textOf(pagePanelInPdf), /正在问：第 1 页/, 'page panel targets page 1');

      // select() ignores mouse/key selection events while in 原始 PDF.
      selectionLookups = 0;
      const resolveCountBefore = calls.filter((c) => c.action === 'materials.selection.resolve').length;
      const bodyEl = view.find((n) => n.props?.className === 'study-document-body');
      bodyEl.props.onMouseUp?.();
      await flushAsync();
      assert.equal(selectionLookups, 0, 'select() ignores mouseup in 原始 PDF without reading window selection');
      assert.equal(calls.filter((c) => c.action === 'materials.selection.resolve').length, resolveCountBefore);

      // Page controls advance the active page in both PdfOriginal and PageAsk.
      const nextPageBtn = view.find((n) => n.type === 'button' && n.props?.['aria-label'] === '下一页', pagePanelInPdf);
      assert.ok(nextPageBtn, '下一页 control exists');
      click(nextPageBtn);
      await view.flush(8);
      const pagePanelPage2 = view.find((n) => n.props?.className === 'reader-learning' && n.props?.['data-scope'] === 'page');
      assert.match(textOf(pagePanelPage2), /正在问：第 2 页/, 'page panel follows page controls to page 2');

      // Switch back to 文字 (阅读): page panel hides while the selection & thread are still intact.
      const textSwitchBtn = view.find((n) => n.type === 'button' && textOf(n).trim() === '文字');
      click(textSwitchBtn);
      await view.flush(8);
      const pagePanelBack = view.find((n) => n.props?.className === 'reader-learning' && n.props?.['data-scope'] === 'page');
      const selPanelBack = view.find((n) => n.props?.className === 'reader-learning' && n.props?.['data-scope'] === 'selection');
      assert.equal(pagePanelBack.props.hidden, true, 'page panel hides on return to 阅读');
      assert.ok(textOf(selPanelBack).includes('Alpha passage'), 'selection of 阅读 is preserved across visit to 原始 PDF');

      // Re-enter 原始 PDF and open a kept annotation from PassageLinksPanel → returns to 阅读.
      click(view.find((n) => n.type === 'button' && textOf(n).trim() === '原始 PDF'));
      await view.flush(8);
      assert.equal(view.find((n) => String(n.props?.className || '').includes('study-document-viewer')).props['data-mode'], 'original');
      click(view.find((n) => n.type === 'button' && textOf(n).includes('打开问答')));
      await view.flush(8);
      assert.equal(view.find((n) => String(n.props?.className || '').includes('study-document-viewer')).props['data-mode'], 'read', 'opening a kept annotation switches back to 阅读');

      // Native browser PDF viewer in PdfOriginal creates a keyed iframe per page so #page= updates always navigate.
      let pdfPageNum = 1;
      const pdfView = mount(() => React.createElement(PdfOriginal, {
        fileUrl: 'blob:pdf-doc-1',
        title: 'Slides.pdf',
        page: pdfPageNum,
        total: 3,
        onPage: () => {},
        settings: { zoom: 1, native: true },
        onSettings: () => {},
      }));
      try {
        const frame1 = pdfView.find((n) => n.type === 'iframe');
        assert.ok(frame1, 'native PdfOriginal renders an iframe');
        assert.equal(frame1.props.src, 'blob:pdf-doc-1#page=1');
        assert.equal(frame1.key, '1', 'iframe is keyed by page 1');
        pdfPageNum = 2;
        pdfView.rerender();
        const frame2 = pdfView.find((n) => n.type === 'iframe');
        assert.equal(frame2.props.src, 'blob:pdf-doc-1#page=2');
        assert.equal(frame2.key, '2', 'changing page remounts iframe with new key');
      } finally {
        pdfView.unmount();
      }
    } finally {
      view.unmount();
      URL.createObjectURL = prevCreate;
      URL.revokeObjectURL = prevRevoke;
      globalThis.window.getSelection = prevGetSelection;
    }
  });
});

test('原始 PDF: a page answer keeps its page scope on 重试 and its cut note when the page comes back', async () => {
  const { React, mount, exports: { DocumentLearning, ReaderModelContext, ToastContext } } = interactivePreview;
  await withBrowserGlobals(async () => {
    const calls = [];
    let askAttempt = 0;
    const doc = {
      documentId: 'doc-1',
      id: 'doc-1',
      revision: 'r1',
      title: 'Slides.pdf',
      sources: [
        { id: 'p1', text: 'First page long text content.', document: { page: 1, totalPages: 2 } },
        { id: 'p2', text: 'Second page text content.', document: { page: 2, totalPages: 2 } },
      ],
    };
    const call = async (action, args) => {
      calls.push({ action, args });
      if (action === 'runtime.capabilities') {
        return [
          { id: 'materials', operations: [{ name: 'selection.ask', available: true }] },
          { id: 'generation', operations: [{ name: 'selection.start', available: true }, { name: 'selection.jobs', available: true }] },
        ];
      }
      if (action === 'bank.decks.list') return { decks: [{ id: 'd1', title: 'Deck 1' }] };
      if (action === 'snapshot') return { decks: [{ id: 'd1', title: 'Deck 1' }], settings: {} };
      if (action === 'generation.selection.jobs') return { jobs: [] };
      if (action === 'materials.selection.ask') {
        askAttempt += 1;
        if (askAttempt === 1) return { status: 'unavailable' };
        return {
          status: 'answered',
          answer: 'Page 1 summary answer',
          evidence: { truncated: true, offset: 0, used: 2000, chars: 5000 },
        };
      }
      return {};
    };
    const toast = { show: () => {}, dismiss: () => {} };
    const readerServices = { model: { ready: true }, openModelSettings: () => {}, openSettings: () => {} };
    const Wrapper = ({ scope, callFn = call }) => React.createElement(
      ToastContext.Provider,
      { value: toast },
      React.createElement(
        ReaderModelContext.Provider,
        { value: readerServices },
        React.createElement(DocumentLearning, {
          call: callFn,
          document: doc,
          capture: null,
          scope,
          pageTotal: 2,
          data: { decks: [{ id: 'd1', title: 'Deck 1' }], settings: {} },
        }),
      ),
    );

    const page1 = { kind: 'page', page: 1, sourceId: 'p1', empty: false };
    const page2 = { kind: 'page', page: 2, sourceId: 'p2', empty: false };
    let activeScope = page1;
    const pageView = mount(() => React.createElement(Wrapper, { scope: activeScope }));
    try {
      await pageView.flush(8);

      // Page panel never polls generation.selection.jobs a second time (the hidden reading panel owns job polling).
      assert.equal(calls.filter((c) => c.action === 'generation.selection.jobs').length, 0, 'page panel does not list selection jobs');

      // Submit a question on page 1; server refuses with unavailable.
      const textarea = pageView.find((n) => n.type === 'textarea');
      assert.ok(textarea, 'page ask textarea is rendered');
      textarea.props.onChange({ target: { value: 'Summarize page 1' } });
      pageView.rerender();
      const form = pageView.find((n) => n.type === 'form');
      await form.props.onSubmit({ preventDefault() {} });
      await pageView.flush(8);

      const askCallsAfterFirst = calls.filter((c) => c.action === 'materials.selection.ask');
      assert.equal(askCallsAfterFirst.length, 1);
      assert.equal(askCallsAfterFirst[0].args.scope, 'page', 'initial ask uses page scope');
      assert.equal(askCallsAfterFirst[0].args.selection.page, 1);
      assert.match(pageView.text(), /现在没有可用的模型/, 'refusal notice is displayed beside the page');

      // Click 重试: page resolution must still be intact and retry must keep page scope.
      const retryBtn = pageView.find((n) => n.type === 'button' && textOf(n).trim() === '重试');
      assert.ok(retryBtn, 'failed page ask node offers 重试');
      click(retryBtn);
      await pageView.flush(8);

      const askCallsAfterRetry = calls.filter((c) => c.action === 'materials.selection.ask');
      assert.equal(askCallsAfterRetry.length, 2);
      assert.equal(askCallsAfterRetry[1].args.scope, 'page', 'retry preserves page scope even after refusal');
      assert.equal(askCallsAfterRetry[1].args.selection.page, 1);
      assert.match(pageView.text(), /Page 1 summary answer/, 'retried page answer renders');
      assert.match(pageView.text(), /2000/, 'cut note shows read character count');
      assert.match(pageView.text(), /5000/, 'cut note shows total character count');

      // Turn to page 2 and then return to page 1: held thread and cut note both come back.
      activeScope = page2;
      pageView.rerender();
      await pageView.flush(8);
      assert.doesNotMatch(pageView.text(), /Page 1 summary answer/, 'page 1 answer is hidden on page 2');
      assert.doesNotMatch(pageView.text(), /5000/, 'page 1 cut note is hidden on page 2');

      activeScope = page1;
      pageView.rerender();
      await pageView.flush(8);
      assert.match(pageView.text(), /Page 1 summary answer/, 'held page 1 answer returns');
      assert.match(pageView.text(), /5000/, 'held page 1 cut note returns with the thread');
    } finally {
      pageView.unmount();
    }

    // Contrast: selection panel (scope=null) DOES call generation.selection.jobs once.
    const selCalls = [];
    const selCall = async (action, args) => {
      selCalls.push({ action, args });
      return call(action, args);
    };
    const selMounted = mount(() => React.createElement(Wrapper, {
      scope: null,
      callFn: selCall,
    }));
    try {
      await selMounted.flush(8);
      assert.equal(selCalls.filter((c) => c.action === 'generation.selection.jobs').length, 1, 'selection panel polls generation.selection.jobs');
    } finally {
      selMounted.unmount();
    }
  });
});
