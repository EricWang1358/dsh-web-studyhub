import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { reviewElement } from './helpers/review-render.mjs';

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

test('LetterpressNumber keeps @number-flow/react out of its static closure and avoids React.lazy', () => {
  const source = readFileSync(new URL('../ui/letterpress/LetterpressNumber.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from\s+['"]@number-flow\/react['"]/, 'never statically imports @number-flow/react');
  assert.doesNotMatch(source, /\bReact\.lazy\b|\blazy\s*\(/, 'never uses React.lazy (client-boundaries count)');
  assert.match(source, /import\(['"]\.\/letterpress-runtime\.jsx['"]\)/, 'dynamically imports runtime chunk on demand');
  assert.match(source, /useLiveEffect/, 'uses shared useLiveEffect rather than hand-written alive flag');
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
