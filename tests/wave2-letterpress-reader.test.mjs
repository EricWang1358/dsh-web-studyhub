import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { reviewElement } from './helpers/review-render.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

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
  const runtimeEvents = { renders: 0, disconnects: 0, mediaRemoved: 0 };
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
      const cancelUi = await loadInteractiveUi(`
        export { default as LetterpressNumber } from './ui/letterpress/LetterpressNumber.jsx';
      `, { plugins: [runtimeSpyPlugin] });
      const earlyUnmount = cancelUi.mount(() => cancelUi.React.createElement(cancelUi.exports.LetterpressNumber, { value: 99, suffix: '%' }));
      assert.equal(earlyUnmount.text(), '99%', 'renders plain text synchronously on first paint without React.lazy suspension');
      assert.equal(earlyUnmount.find((n) => n.type === '__lazy_pending__'), null, 'never suspends with React.lazy');
      assert.equal(earlyUnmount.find((n) => n.props?.['data-testid'] === 'letterpress-runtime'), null, 'runtime not mounted synchronously before dynamic import settles');

      earlyUnmount.unmount();
      assert.equal(runtimeEvents.disconnects, 1, 'unmount disconnects MutationObserver');
      assert.equal(runtimeEvents.mediaRemoved, 1, 'unmount removes matchMedia change listener');
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      assert.equal(runtimeEvents.renders, 0, 'cancelled async load never renders into unmounted component');

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

test('reader moreItems and DocumentViewer stay uncluttered after InkScratchpad removal', () => {
  const base = {
    view: 'read', format: 'pdf', fileUrl: true, localMode: false, find: { on: false },
    translate: true, display: true, tools: { on: false, count: 0 },
    quality: null, assist: false, download: false, hostPreview: false, attach: false, extra: [],
  };
  const handlers = {
    setView: () => {}, find: () => {}, translate: () => {}, display: () => {},
    tools: () => {}, quality: () => {}, assist: () => {}, download: () => {}, hostPreview: () => {}, attach: () => {},
  };

  m.setUiLanguage('zh');
  const zhItems = m.moreItems(base, handlers);
  assert.equal(zhItems.some((item) => item.id === 'scratchpad'), false);

  const viewerSrc = readFileSync(new URL('../ui/document-preview/DocumentViewer.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(viewerSrc, /LazyInkScratchpadDialog|scratchpadOpen|毛笔草稿纸/);
});
