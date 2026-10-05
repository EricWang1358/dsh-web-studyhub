import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { seedWrongBookLibrary, startLateServer, wrongBookScenario } from '../scripts/qa/layout-late.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* #206: the mistakes page. Recommendations are found after the list is drawn. They must not move the list (a one-line bar is there from the first
   paint), must not switch the practice mode the learner already sees, and must not change the number on the start button. */

const { WrongBookView, setUiLanguage } = await loadUi(`export { WrongBookView } from './ui/WrongBook.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const noop = () => {};
const decks = [{ id: 'd4', course: 'PE', title: 'Final 04' }];
const row = (cardId, topic) => ({ deckId: 'd4', deckTitle: 'Final 04', cardId, topic, prompt: `Question ${cardId}`, assessment: 'graded', lastGrade: 1, lastAt: '2026-10-01T10:00:00Z', kind: 'quiz' });
const items = [row('c1', 'A'), row('c2', 'B'), row('c3', 'C')];
const recItems = Array.from({ length: 4 }, (_, i) => ({ deckId: 'd4', deckTitle: 'Final 04', cardId: `r${i}`, topic: 'A', kind: 'quiz', prompt: `Similar ${i}`, score: 5, forCardIds: ['c1'], reasons: [{ type: 'topic', topic: 'A' }] }));
const base = { data: { root: 'r', decks, focus: { course: 'PE', courses: [{ name: 'PE' }] }, model: { ready: true } }, course: 'PE', onCourse: noop, items,
  counts: { total: 3, graded: 3, self: 0, oral: 0, rubric: 0 }, loading: false, err: '', page: 0, pageSize: 100, hasMore: false, onReload: noop, onPage: noop,
  recs: null, coach: null, details: {}, onLoadDetail: noop, onPractice: noop, onPracticePrepared: noop, onGenerate: noop, onOpenSettings: noop, busy: false };
const render = (extra = {}) => renderToStaticMarkup(React.createElement(WrongBookView, { ...base, ...extra }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('while recommendations are being found the bar is already there, and nothing else says "similar"', () => {
  const html = text(render({ recsLoading: true }));
  assert.match(html, /为你推荐/);
  assert.match(html, /正在查找同类题/);
  assert.doesNotMatch(html, /练这 \d+ 道/);
  assert.match(html, /开始重练 \(3\)/);
  assert.match(html, /错题 \+ 同类题 \(3\+0\)/);
  assert.doesNotMatch(text(render({ recs: null })), /为你推荐/, 'a view that was never told about recommendations shows no bar');
});

test('the bar is one folded line when recommendations are in; the list is behind its toggle', () => {
  const html = render({ recs: { items: recItems } });
  assert.match(text(html), /为你推荐/);
  assert.match(text(html), /练这 4 道/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="wb-recs-body"/);
  assert.doesNotMatch(text(html), /Similar 0/, 'folded by default');
  const open = render({ recs: { items: recItems }, initial: { recsOpen: true } });
  assert.match(text(open), /Similar 0/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /id="wb-recs-body"/);
  const none = text(render({ recs: { items: [] } }));
  assert.match(none, /暂时没有合适的同类题/, 'the bar stays, so an empty answer changes nothing either');
  assert.doesNotMatch(none, /练这/);
});

test('with recommendations in at the first draw the default is still the richest, and a note says what was found', () => {
  const html = render({ recs: { items: recItems } });
  assert.match(html, /aria-pressed="true"[^>]*>错题 \+ 同类题 \(3\+4\)/);
  assert.match(text(html), /开始重练 \(7\)/);
});

test('English: the new bar and note are translated', () => {
  try {
    setUiLanguage('en');
    const loading = renderToStaticMarkup(React.createElement(WrongBookView, { ...base, recsLoading: true }));
    assert.doesNotMatch(loading, /\p{Script=Han}/u);
    assert.match(text(loading), /Finding similar questions/);
    const none = renderToStaticMarkup(React.createElement(WrongBookView, { ...base, recs: { items: [] } }));
    assert.doesNotMatch(none, /\p{Script=Han}/u);
  } finally { setUiLanguage('zh'); }
});

test('recommendations arriving late move nothing and switch nothing (mistakes page, 48 mistakes)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-late-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: (root) => seedWrongBookLibrary(root) });
  try {
    for (const width of [1280, 420]) {
      const { before, after, cls, rowResizes, errors } = await wrongBookScenario({ browser, running, width });
      t.diagnostic(`wrongbook ${width}px: selected "${before.selected}" → "${after.selected}", start "${before.startText}" → "${after.startText}", list y ${before.group.y} → ${after.group.y}, CLS ${cls}`);
      assert.deepEqual(errors, []);
      assert.equal(after.selected, before.selected, `${width}px: the selected mode must not switch under the learner`);
      assert.equal(after.startText, before.startText, `${width}px: the start button keeps its number`);
      assert.ok(Math.abs(after.group.y - before.group.y) <= 1, `${width}px: the list moved from ${before.group.y} to ${after.group.y}`);
      assert.ok(Math.abs(after.firstRow.y - before.firstRow.y) <= 1, `${width}px: the first row moved`);
      assert.ok(Math.abs(after.retrain.y - before.retrain.y) <= 1 && Math.abs(after.retrain.height - before.retrain.height) <= 1, `${width}px: the retrain bar moved or changed height`);
      assert.ok(Math.abs(after.start.x - before.start.x) <= 1 && Math.abs(after.start.y - before.start.y) <= 1, `${width}px: the start button moved`);
      assert.ok(before.recs && after.recs && Math.abs(after.recs.height - before.recs.height) <= 1, `${width}px: the recommendations bar keeps its height`);
      const similar = (state) => state.options.find((label) => /同类题/.test(label));
      assert.match(similar(before), /\(\d+\+0\)/);
      assert.match(similar(after), /\(\d+\+10\)/, 'the count on the option is updated');
      assert.match(after.note, /找到 10 道同类题/, 'a quiet note says what was found');
      assert.ok(cls <= 0.05, `${width}px: CLS ${cls}`);
      assert.equal(rowResizes, 0);
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
