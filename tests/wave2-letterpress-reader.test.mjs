import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { reviewElement } from './helpers/review-render.mjs';
import { loadInteractiveUi, withBrowserGlobals, click } from './helpers/react-harness.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const require = createRequire(import.meta.url);
const compiled = await build({
  stdin: {
    contents: `
      export { default as LetterpressNumber, formatPlainNumber, isFullMotionBrowser } from './ui/letterpress/LetterpressNumber.jsx';
      export { default as LetterpressRuntime, resetLetterpressSeenKeys } from './ui/letterpress/letterpress-runtime.jsx';
      export { default as TodayCard } from './ui/study-map/TodayCard.jsx';
      export { default as DeskIntro } from './ui/study-map/DeskIntro.jsx';
      export { default as Review } from './ui/Review.jsx';
      export { moreItems } from './ui/document-preview/reader/more-items.js';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react', 'react-dom'],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});

const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const m = mod.exports;
const h = React.createElement;

test('LetterpressNumber renders plain formatted text on SSR (zero Shadow DOM) and handles non-finite fallbacks', () => {
  assert.equal(m.formatPlainNumber(42), '42');
  assert.equal(m.formatPlainNumber(78, { suffix: '%' }), '78%');
  assert.equal(m.formatPlainNumber(null), '—');
  assert.equal(m.formatPlainNumber(Number.NaN, { fallback: '--' }), '--');
  assert.equal(m.formatPlainNumber('N/A'), 'N/A');

  const ssrPlain = renderToStaticMarkup(h('strong', null, h(m.LetterpressNumber, { value: 12 })));
  assert.equal(ssrPlain, '<strong>12</strong>', 'SSR stays plain text inside host heading/strong');
  assert.doesNotMatch(ssrPlain, /number-flow-react/i, 'never emits Shadow DOM custom element in SSR');

  const ssrClass = renderToStaticMarkup(h(m.LetterpressNumber, { value: 85, suffix: '%', className: 'counter' }));
  assert.equal(ssrClass, '<span class="counter">85%</span>');

  const ssrFallback = renderToStaticMarkup(h(m.LetterpressNumber, { value: undefined }));
  assert.equal(ssrFallback, '—');
});

test('isFullMotionBrowser enables letterpress only when data-motion="full" and OS reduced-motion is off', () => {
  assert.equal(m.isFullMotionBrowser(undefined, undefined), false, 'SSR returns false');

  const mkDoc = (motion) => ({
    querySelector: () => (motion == null ? null : { getAttribute: (attr) => (attr === 'data-motion' ? motion : null) }),
  });
  const mkWin = (reduced) => ({
    matchMedia: () => ({ matches: reduced }),
  });

  assert.equal(m.isFullMotionBrowser(mkDoc('full'), mkWin(false)), true);
  assert.equal(m.isFullMotionBrowser(mkDoc('reduced'), mkWin(false)), false);
  assert.equal(m.isFullMotionBrowser(mkDoc('off'), mkWin(false)), false);
  assert.equal(m.isFullMotionBrowser(mkDoc('full'), mkWin(true)), false, 'OS prefers-reduced-motion suppresses rolling digits');
  assert.equal(m.isFullMotionBrowser(mkDoc(null), mkWin(false)), false);
});

test('LetterpressNumber keeps @number-flow/react out of its static closure, splits runtime dynamically, upgrades in full motion, and cleans up on unmount', async () => {
  // Real bundler code-split verification via esbuild metafile
  const entryPoint = 'ui/letterpress/LetterpressNumber.jsx';
  const result = await build({
    entryPoints: [resolve(process.cwd(), entryPoint)],
    bundle: true,
    splitting: true,
    format: 'esm',
    write: false,
    metafile: true,
    outdir: 'out',
    external: ['react', 'react-dom', 'react/*', 'react-dom/*', '@number-flow/react'],
    loader: { '.css': 'text' },
    logLevel: 'silent',
  });
  const outputs = Object.entries(result.metafile.outputs);
  const entryOutput = outputs.find(([, meta]) => meta.entryPoint === entryPoint);
  const dynamicChunks = outputs.filter(([, meta]) => meta.entryPoint && meta.entryPoint !== entryPoint);
  const entryInputs = Object.keys(entryOutput?.[1]?.inputs || {});
  const entryImports = entryOutput?.[1]?.imports || [];

  assert.ok(entryOutput, 'entry chunk exists in esbuild metafile');
  assert.equal(entryInputs.some((f) => f.includes('letterpress-runtime')), false, 'entry chunk must not statically bundle letterpress-runtime.jsx');
  assert.equal(entryImports.some((imp) => imp.path === '@number-flow/react'), false, 'entry chunk must not statically import @number-flow/react');
  assert.equal(dynamicChunks.some(([, meta]) => meta.entryPoint === 'ui/letterpress/letterpress-runtime.jsx'), true, 'letterpress-runtime.jsx splits into a dynamic chunk');
  assert.ok(entryImports.some((imp) => imp.kind === 'dynamic-import' && imp.path.includes('letterpress-runtime')), 'entry chunk loads letterpress-runtime via dynamic import()');
  const runtimeChunk = dynamicChunks.find(([, meta]) => meta.entryPoint === 'ui/letterpress/letterpress-runtime.jsx');
  assert.ok((runtimeChunk?.[1]?.imports || []).some((imp) => imp.path === '@number-flow/react'), 'dynamic runtime chunk owns the @number-flow/react import');

  const entryFile = result.outputFiles.find((file) => file.path.replaceAll('\\', '/').endsWith(`/${entryOutput[0]}`));
  assert.ok(entryFile, 'bundled entry chunk text exists');
  assert.doesNotMatch(entryFile.text, /\bReact\.lazy\b|\blazy\s*\(/, 'bundled entry chunk never uses React.lazy (client-boundaries count)');

  // Interactive runtime verification: dynamic upgrade in data-motion="full" + safe unmount cancellation (useLiveEffect)
  const runtimeEvents = { renders: 0, disconnects: 0, mediaRemoved: 0, loaded: 0 };
  const runtimeSpyPlugin = {
    name: 'spy-letterpress-runtime',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/letterpress-runtime\.jsx$/ }, () => ({
        path: 'letterpress-runtime-spy',
        namespace: 'letterpress-spy',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'letterpress-spy' }, () => ({
        contents: `
          import React from 'react';
          globalThis.__LP_EVENTS__.loaded += 1;
          export default function FakeLetterpressRuntime({ value, prefix = '', suffix = '', className = '' }) {
            globalThis.__LP_EVENTS__.renders += 1;
            return React.createElement('span', {
              'data-testid': 'letterpress-runtime',
              className: className ? 'sh-letterpress ' + className : 'sh-letterpress',
            }, prefix + String(value) + suffix);
          }
        `,
        loader: 'js',
      }));
    },
  };

  let motionAttr = 'reduced';
  const prevMutationObserver = globalThis.MutationObserver;
  globalThis.__LP_EVENTS__ = runtimeEvents;
  globalThis.MutationObserver = class MockMutationObserver {
    observe() {}
    disconnect() { runtimeEvents.disconnects += 1; }
  };

  try {
    await withBrowserGlobals(async () => {
      // 1. Safe unmount before dynamic import resolves: observer/media listeners cleaned up and no post-unmount state update
      motionAttr = 'full';
      const unmountedWrites = [];
      const cancelUi = await loadInteractiveUi(`
        export { default as LetterpressNumber } from './ui/letterpress/LetterpressNumber.jsx';
      `, { plugins: [runtimeSpyPlugin], onUnmountedStateWrite: (owner) => unmountedWrites.push(owner) });
      const earlyUnmount = cancelUi.mount(() => cancelUi.React.createElement(cancelUi.exports.LetterpressNumber, { value: 99, suffix: '%' }));
      assert.equal(earlyUnmount.text(), '99%', 'renders plain text synchronously on first paint without React.lazy suspension');
      assert.equal(earlyUnmount.find((n) => n.type === '__lazy_pending__'), null, 'never suspends with React.lazy');
      assert.equal(earlyUnmount.find((n) => n.props?.['data-testid'] === 'letterpress-runtime'), null, 'runtime not mounted synchronously before dynamic import settles');

      assert.equal(runtimeEvents.loaded, 0, 'the dynamic import is still pending at unmount');
      earlyUnmount.unmount();
      assert.equal(runtimeEvents.disconnects, 1, 'unmount disconnects MutationObserver');
      assert.equal(runtimeEvents.mediaRemoved, 1, 'unmount removes matchMedia change listener');
      await nextTurn();
      assert.equal(runtimeEvents.loaded, 1, 'the real dynamic import settled after cleanup');
      assert.equal(runtimeEvents.renders, 0, 'cancelled async load never renders into unmounted component');
      assert.deepEqual(unmountedWrites, [], 'resolving the number animation after unmount attempts no state write');

      // 2. Reduced motion stays on plain text and never upgrades to runtime
      motionAttr = 'reduced';
      const ui = await loadInteractiveUi(`
        export { default as LetterpressNumber } from './ui/letterpress/LetterpressNumber.jsx';
      `, { plugins: [runtimeSpyPlugin] });
      const reducedMount = ui.mount(() => ui.React.createElement(ui.exports.LetterpressNumber, { value: 42, suffix: '%' }));
      try {
        await reducedMount.flush(5);
        assert.equal(reducedMount.text(), '42%');
        assert.equal(reducedMount.find((n) => n.props?.['data-testid'] === 'letterpress-runtime'), null, 'reduced motion stays plain text');
      } finally {
        reducedMount.unmount();
      }

      // 3. Full motion dynamically upgrades to letterpress runtime
      motionAttr = 'full';
      const fullMount = ui.mount(() => ui.React.createElement(ui.exports.LetterpressNumber, { value: 42, suffix: '%', className: 'counter' }));
      try {
        await fullMount.flush(5);
        const rtNode = fullMount.find((n) => n.props?.['data-testid'] === 'letterpress-runtime');
        assert.ok(rtNode, 'data-motion="full" upgrades to dynamically loaded LetterpressRuntime');
        assert.match(rtNode.props.className, /sh-letterpress/);
        assert.match(rtNode.props.className, /counter/);
        assert.equal(fullMount.text(), '42%');
      } finally {
        fullMount.unmount();
      }
    }, {
      document: {
        querySelector: (sel) => (sel.includes('.study-app') ? { getAttribute: (attr) => (attr === 'data-motion' ? motionAttr : null) } : null),
      },
      window: {
        matchMedia: () => ({
          matches: false,
          addEventListener() {},
          removeEventListener() { runtimeEvents.mediaRemoved += 1; },
        }),
      },
    });
  } finally {
    delete globalThis.__LP_EVENTS__;
    if (prevMutationObserver === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = prevMutationObserver;
  }
});

test('LetterpressRuntime wraps @number-flow/react with sh-letterpress class and respects mount roll', () => {
  m.resetLetterpressSeenKeys();
  const rendered = renderToStaticMarkup(h(m.LetterpressRuntime, { value: 9, animateOnMount: true, mountKey: 'run-9' }));
  assert.match(rendered, /sh-letterpress/);
  const staticVal = renderToStaticMarkup(h(m.LetterpressRuntime, { value: 42, suffix: '%' }));
  assert.match(staticVal, /42%/);
});

test('TodayCard, DeskIntro, and Review result hero preserve exact numeric SSR markup with LetterpressNumber mounted', () => {
  m.setUiLanguage('zh');
  const noop = () => {};

  const todayHtml = renderToStaticMarkup(
    h(m.StudyServicesContext.Provider, { value: { act: async () => {}, busy: false } },
      h(m.TodayCard, {
        plan: { kind: 'path', eyebrow: '今日学习', count: 7, unit: '题待学', depth: 2, action: { label: '开始今日学习', run: noop } },
        todayLabel: '10 月 15 日',
      })),
  );
  assert.match(todayHtml, /<div class="today-count"><strong>7<\/strong><span>题待学<\/span><\/div>/);
  assert.doesNotMatch(todayHtml, /number-flow-react/i);

  const introHtml = renderToStaticMarkup(
    h(m.StudyServicesContext.Provider, { value: { act: async () => {}, busy: false } },
      h(m.DeskIntro, {
        data: { decks: [], focus: { course: 'CS3219', courses: [{ name: 'CS3219' }] }, next: null },
        home: { headline: '今天', plan: { kind: 'path', also: [] }, alternatives: [], otherRuns: [], otherCourse: () => '' },
        mastery: {
          primary: { value: 64, node: { counts: { mastered: 2, familiar: 1, learning: 1, weak: 0, new: 1 }, total: 5 } },
          course: { value: 64, cards: 5 },
          name: 'CS3219',
        },
        start: noop, resume: noop, endRun: noop, onFocus: noop,
      })),
  );
  assert.match(introHtml, /<span class="desk-mastery-value">64<small>%<\/small><\/span>/);

  const reviewHtml = renderToStaticMarkup(reviewElement(m.Review, m.StudyServicesContext, {
    run: {
      id: 'run-hero-1', mode: 'path', complete: true, index: 5, total: 5, questions: 5, answered: 5, correct: 5,
      weakTopics: [], scope: [], card: { id: 'q1', kind: 'quiz', topic: 'T', prompt: 'P', options: [] },
    },
    data: { sources: [] }, host: {}, choice: true, isCloze: false, selected: [], clozeValues: {},
    shellTitle: 'Review', busy: false, act: noop, enterRun: noop, setPage: noop, askInChat: noop,
  }));
  assert.match(reviewHtml, /<div class="result-headline"><strong>5<\/strong>/);
  assert.doesNotMatch(reviewHtml, /number-flow-react/i);
});

test('reader moreItems and DocumentViewer stay uncluttered after InkScratchpad removal', async () => {
  // 1) Bundler metafile verification: neither static inputs nor lazy/dynamic chunks of DocumentViewer reference InkScratchpad/scratchpad.
  const viewerEntry = 'ui/document-preview/DocumentViewer.jsx';
  const viewerBundle = await build({
    entryPoints: [resolve(process.cwd(), viewerEntry)],
    bundle: true,
    splitting: true,
    format: 'esm',
    write: false,
    metafile: true,
    outdir: 'out',
    external: ['react', 'react-dom', 'react/*', 'react-dom/*', 'dompurify', 'katex', 'katex/*', 'pdfjs-dist', 'pdfjs-dist/*'],
    loader: { '.css': 'text' },
    logLevel: 'silent',
  });
  const inputPaths = Object.keys(viewerBundle.metafile.inputs);
  const outputEntries = Object.entries(viewerBundle.metafile.outputs);
  const allImports = outputEntries.flatMap(([, meta]) => (meta.imports || []).map((imp) => imp.path));
  assert.ok(inputPaths.some((file) => file.endsWith(viewerEntry)), 'metafile includes DocumentViewer entry');
  assert.equal(inputPaths.some((file) => /InkScratchpad|scratchpad/i.test(file)), false, 'no bundled input references InkScratchpad or scratchpad');
  assert.equal(outputEntries.some(([file]) => /InkScratchpad|scratchpad/i.test(file)), false, 'no bundled output chunk references InkScratchpad or scratchpad');
  assert.equal(allImports.some((imp) => /InkScratchpad|scratchpad/i.test(imp)), false, 'no static or dynamic import references InkScratchpad or scratchpad');

  // 2) Bilingual moreItems verification for both PDF and Markdown formats.
  const pdfState = {
    view: 'read', format: 'pdf', fileUrl: true, localMode: false, find: { on: false },
    translate: true, display: true, tools: { on: false, count: 0 },
    quality: null, assist: false, download: false, hostPreview: false, attach: false, extra: [],
  };
  const mdState = {
    ...pdfState, format: 'md', fileUrl: false, translate: false,
  };
  const handlers = {
    setView: () => {}, find: () => {}, translate: () => {}, display: () => {},
    tools: () => {}, quality: () => {}, assist: () => {}, download: () => {}, hostPreview: () => {}, attach: () => {},
  };

  const hanRe = /[\u3400-\u9fff]/;
  const { DocumentViewer, setUiLanguage: setViewerLang } = await loadUi(`
    export { default as DocumentViewer } from './ui/document-preview/DocumentViewer.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const interactiveViewer = await loadInteractiveUi(`
    export { default as DocumentViewer } from './ui/document-preview/DocumentViewer.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const hi = interactiveViewer.React.createElement;
  const nonLocalSource = {
    id: 'src-1',
    title: 'Linear Algebra Notes',
    text: 'Chapter 1: Vector spaces and linear independence.',
    format: 'pdf',
    document: { page: 1, totalPages: 1, format: 'pdf' },
  };
  const nonLocalCall = async (action) => {
    if (action === 'materials.document.get') {
      return {
        id: 'doc-1',
        documentId: 'doc-1',
        revision: 'rev-1',
        title: 'Linear Algebra Notes',
        format: 'pdf',
        originalAvailable: false,
        sources: [nonLocalSource],
      };
    }
    if (action === 'materials.links.list') return { links: [] };
    if (action === 'materials.annotation.list') return { items: [], stale: [] };
    if (action === 'materials.marks.list') return { items: [], stale: [] };
    if (action === 'runtime.capabilities') return [];
    if (action === 'snapshot') return { sources: [nonLocalSource], courses: [], decks: [] };
    return {};
  };
  const viewerStudy = { call: nonLocalCall, act: async () => undefined, busy: false, notify: () => {}, host: {} };

  try {
    for (const lang of ['zh', 'en']) {
      m.setUiLanguage(lang);
      const pdfItems = m.moreItems(pdfState, handlers);
      const mdItems = m.moreItems(mdState, handlers);
      const pdfIds = pdfItems.map((item) => item.id).filter(Boolean);
      const mdIds = mdItems.map((item) => item.id).filter(Boolean);

      assert.deepEqual(pdfIds, ['view:read', 'view:text', 'view:original', 'find', 'translate', 'display', 'tools']);
      assert.deepEqual(mdIds, ['view:read', 'view:text', 'find', 'display', 'tools']);
      for (const item of [...pdfItems, ...mdItems]) {
        assert.doesNotMatch(String(item.id || ''), /scratchpad/i, `${lang}: no scratchpad item id`);
        assert.doesNotMatch(String(item.label || ''), /scratchpad|草稿纸/i, `${lang}: no scratchpad label`);
        if (lang === 'en') {
          assert.doesNotMatch(String(item.label || ''), hanRe, `en moreItems label "${item.label}" has no Han characters`);
        }
      }

      // 3) SSR render of DocumentViewer in localContent mode renders .reader-toolbar with zero scratchpad controls.
      setViewerLang(lang);
      const viewerHtml = renderToStaticMarkup(
        h(DocumentViewer, {
          source: { id: 'local-1', title: 'Local Notes' },
          localContent: { id: 'local-1', title: 'Local Notes', markdown: '' },
          data: { sources: [], courses: [], decks: [] },
        }),
      );
      assert.match(viewerHtml, /class="reader-toolbar"/, `${lang}: DocumentViewer renders .reader-toolbar`);
      assert.doesNotMatch(viewerHtml, /毛笔草稿纸|scratchpad/i, `${lang}: DocumentViewer renders zero scratchpad controls`);
      if (lang === 'en') {
        assert.doesNotMatch(viewerHtml.replace(/<[^>]*>/g, ' '), hanRe, 'en DocumentViewer localContent SSR has zero Han characters');
      }

      // 4) Interactive mount of DocumentViewer in non-local mode (!localMode) with 更多 menu opened.
      await withBrowserGlobals(async () => {
        interactiveViewer.exports.setUiLanguage(lang);
        const mounted = interactiveViewer.mount(() => hi(
          interactiveViewer.exports.StudyServicesContext.Provider,
          { value: viewerStudy },
          hi(interactiveViewer.exports.DocumentViewer, {
            source: nonLocalSource,
            call: nonLocalCall,
            data: { sources: [nonLocalSource], courses: [], decks: [] },
            onGenerate: () => {},
            onOpenCompanion: () => {},
          }),
        ));
        try {
          await mounted.flush(6);
          const toolbar = mounted.find((n) => n.type === 'div' && n.props?.className === 'reader-toolbar');
          assert.ok(toolbar, `${lang}: non-local DocumentViewer mounts .reader-toolbar`);
          const moreBtn = mounted.find((n) => n.type === 'button' && n.props?.['aria-haspopup'] === 'menu', toolbar);
          assert.ok(moreBtn, `${lang}: non-local DocumentViewer renders 更多 menu trigger`);

          await mounted.act(() => click(moreBtn));
          await mounted.flush(4);

          const menuEl = mounted.find((n) => n.type === 'div' && n.props?.role === 'menu');
          assert.ok(menuEl, `${lang}: clicking 更多 opens the reader menu`);
          const menuItems = mounted.findAll(
            (n) => n.type === 'button' && (n.props?.role === 'menuitem' || n.props?.role === 'menuitemcheckbox'),
            menuEl,
          );
          assert.ok(menuItems.length >= 4, `${lang}: 更多 menu lists reader items (got ${menuItems.length})`);

          const toolbarText = mounted.text(toolbar);
          const menuText = mounted.text(menuEl);
          assert.doesNotMatch(toolbarText, /毛笔草稿纸|草稿纸|scratchpad/i, `${lang}: non-local toolbar has zero scratchpad controls`);
          assert.doesNotMatch(menuText, /毛笔草稿纸|草稿纸|scratchpad/i, `${lang}: non-local 更多 menu has zero scratchpad items`);
          for (const btn of mounted.findAll((n) => n.type === 'button')) {
            const label = [mounted.text(btn), btn.props?.['aria-label'] || '', btn.props?.title || ''].join(' ');
            assert.doesNotMatch(label, /毛笔草稿纸|草稿纸|scratchpad/i, `${lang}: no button carries scratchpad label/aria`);
          }
          if (lang === 'en') {
            assert.doesNotMatch(toolbarText, hanRe, 'en non-local DocumentViewer toolbar has zero Han characters');
            assert.doesNotMatch(menuText, hanRe, 'en non-local DocumentViewer 更多 menu has zero Han characters');
          }
        } finally {
          mounted.unmount();
        }
      });
    }
  } finally {
    m.setUiLanguage('zh');
    setViewerLang('zh');
    interactiveViewer.exports.setUiLanguage('zh');
  }
});
