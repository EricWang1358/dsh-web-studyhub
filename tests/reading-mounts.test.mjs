/* Where the shared reading setting is mounted: an Aa button and a .study-reading container on each long-form surface of the study
   content, in Chinese and English. Components that render alone are checked by their markup; the big pages (review, notes, the
   exam report, the skeleton canvas) by what their source mounts, and the real layout by scripts/qa/reading.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { spineFixture } from '../scripts/qa/spine-fixture.mjs';

const compiled = await build({ stdin: { contents: `
  export { default as ReviewToolbar } from './ui/ReviewToolbar.jsx';
  export { TeachingArticle } from './ui/WorkflowLesson.jsx';
  export { default as SkeletonSpine } from './ui/SkeletonSpine.jsx';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const lib = module.exports;
const h = React.createElement;
const inLanguage = (language, run) => { try { lib.setUiLanguage(language); return run(); } finally { lib.setUiLanguage('zh'); } };
const noop = () => {};
const source = async path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const toolbar = () => renderToStaticMarkup(h(lib.ReviewToolbar, { run: { index: 0, total: 3, feedback: null, revealed: false, mode: 'path', card: {} }, busy: false,
  onToggleHelp: noop, onAsk: noop, onImprove: noop, onSlay: noop, onNote: noop, onReviewAction: noop }));

test('the review toolbar has the Aa button beside 帮我弄懂, without the underline row, and it is not a card control', () => {
  const html = toolbar();
  assert.match(html, /class="reader-popover/);
  assert.match(html, /aria-label="显示设置"/);
  assert.ok(html.indexOf('帮我弄懂') < html.indexOf('reader-popover'), 'after the help button');
  inLanguage('en', () => assert.match(toolbar(), /aria-label="Display settings"/));
});

test('a lesson article is a reading block whose own size is the reading size, in both languages', () => {
  const html = renderToStaticMarkup(h(lib.TeachingArticle, { content: '## Heading\n\nSome **text**.' }));
  assert.match(html, /<div class="study-reading study-reading--prose wf-prose"/);
  assert.match(html, /data-face="sans"/);
  assert.match(html, /--reader-size:16px/);
});

test('the skeleton spine keeps its stations and gains the Aa button in its toolbar', () => {
  const skeleton = spineFixture('zh');
  const html = renderToStaticMarkup(h(lib.SkeletonSpine, { skeleton, stepKind: 'skeleton' }));
  assert.match(html, /study-reading/);
  assert.match(html, /class="spine-detail[^"]*study-reading|study-reading[^"]*spine-detail/);
  assert.match(html, /class="reader-popover/);
  inLanguage('en', () => assert.match(renderToStaticMarkup(h(lib.SkeletonSpine, { skeleton: spineFixture('en'), stepKind: 'skeleton' })), /aria-label="Display settings"/));
});

test('review, results, notes, the skeleton canvas and the exam report mount the shared setting on their long-form text', async () => {
  const review = await source('ui/Review.jsx');
  assert.equal((review.match(/<ReadingBlock[^>]*className="explanation"/g) || []).length, 2, 'the explanation panel (理解这道题, Q&A, citations) and the guided-understanding panel');
  assert.match(review, /<ReadingSettingsButton/, 'the results page has the button');
  const coach = await source('ui/CoachDebrief.jsx');
  assert.match(coach, /<ReadingBlock[^>]*className="coach-debrief"/);
  const notes = await source('ui/BlogNotes.jsx');
  assert.equal((notes.match(/<ReadingBlock[^>]*className="note-preview"/g) || []).length, 2, 'the editor preview and the server version');
  assert.match(notes, /<ReadingSettingsButton/);
  const canvas = await source('ui/SkeletonCanvas.jsx');
  assert.match(canvas, /<ReadingBlock[^>]*className="skc-detail"/);
  assert.match(canvas, /<ReadingSettingsButton/);
  const exam = await source('ui/Exam.jsx');
  assert.match(exam, /<ReadingBlock[^>]*className="exam-report"/);
  assert.match(exam, /<ReadingSettingsButton/);
  const lesson = await source('ui/WorkflowLesson.jsx');
  assert.match(lesson, /<ReadingSettingsButton/, 'the lesson heading');
});

test('card faces keep their own designed typography: nothing in the card face or the controls is a reading block', async () => {
  const review = await source('ui/Review.jsx');
  for (const face of ['question-card', 'flash-prompt', 'flip-back', 'question-toolbar'])
    assert.doesNotMatch(review, new RegExp(`<ReadingBlock[^>]*${face}`), face);
});
