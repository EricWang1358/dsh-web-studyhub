/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { Store } from '../lib/store.js';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, seedWrongBookLibrary, settleAnimations, startLateServer, wrongBookScenario } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
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
  assert.match(html, /开始重练 · 3 题/);
  assert.match(html, /错题 \+ 同类题 \(3\+0\)/);
  assert.doesNotMatch(text(render({ recs: null })), /为你推荐/, 'a view that was never told about recommendations shows no bar');
});

test('the bar is folded when recommendations are in, says what was found, and has no start of its own (#674); the list is behind its toggle', () => {
  const html = render({ recs: { items: recItems } });
  assert.match(text(html), /为你推荐/);
  assert.match(text(html), /共 4 道/);
  assert.doesNotMatch(text(html), /练这 \d+ 道/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /aria-controls="wb-recs-body"/);
  assert.doesNotMatch(text(html), /Similar 0/, 'folded by default');
  const open = render({ recs: { items: recItems }, initial: { recsOpen: true } });
  assert.match(text(open), /Similar 0/);
  assert.match(open, /aria-expanded="true"/);
  assert.match(open, /id="wb-recs-body"/);
  const none = text(render({ recs: { items: [] } }));
  assert.match(none, /题库里没有找到合适的同类题/, 'the bar stays, so an empty answer changes nothing either');
  assert.doesNotMatch(none, /练这 \d+ 道/);
});

test('with recommendations in at the first draw the default is still the richest, and the bar says they are in the round', () => {
  const html = render({ recs: { items: recItems } });
  assert.match(html, /aria-pressed="true"[^>]*>错题 \+ 同类题 \(3\+4\)/);
  assert.match(text(html), /开始重练 · 7 题/);
  assert.match(text(html), /共 4 道，已在这一轮重练里/);
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
      assert.match(before.note, /正在查找同类题/, `${width}px: the bar's second line is there from the first paint`);
      assert.match(after.note, /共 10 道/, 'the same line says what was found');
      assert.ok(cls <= 0.05, `${width}px: CLS ${cls}`);
      assert.equal(rowResizes, 0);
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

test('WrongBook headless Chromium shows retell signal on stubborn rows cleanly at 1280px and 420px (#1027)', async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to verify with: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), 'study-wb-retell-dist-'));
  let running;
  try {
    await buildPreview({ outdir: dist });
    running = await startLateServer({
      distDir: dist,
      seed: async (root) => {
        const { mkdir } = await import('node:fs/promises');
        await mkdir(root, { recursive: true });
        const service = new StudyService(root);
        await service.call('snapshot');
        await service.store.update((state) => {
          state.focus = { ...state.focus, course: 'PE', courses: [{ name: 'PE' }] };
          state.decks.push({
            id: 'd-retell',
            title: 'PE Retell Stubborn',
            course: 'PE',
            folder: '',
            cards: [
              { id: 'c-gap', kind: 'quiz', topic: 'Fences', prompt: 'Why use a memory fence?', options: ['Ordering', 'Size'], answer: 'Ordering', explanation: 'Orders memory operations.', misconception: '', citations: [], retell: { tries: 2, passes: 0, gap: 'missed', at: '2026-10-02T10:00:00Z' } },
              { id: 'c-explained', kind: 'quiz', topic: 'Locks', prompt: 'What is a spinlock?', options: ['Busy wait', 'Sleep'], answer: 'Busy wait', explanation: 'Spins in a loop.', misconception: '', citations: [], retell: { tries: 2, passes: 1, gap: 'none', at: '2026-10-02T10:00:00Z' } },
              { id: 'c-plain', kind: 'quiz', topic: 'Cache', prompt: 'What is false sharing?', options: ['Same cache line', 'Cold miss'], answer: 'Same cache line', explanation: 'Shared cache line.', misconception: '', citations: [] },
            ],
          });
          for (const cardId of ['c-gap', 'c-explained', 'c-plain']) {
            for (const n of [1, 2, 3]) {
              state.attempts.push({ id: `${cardId}-${n}`, quiz_id: cardId, deckId: 'd-retell', grade: 1, assessment: 'graded', timestamp: `2026-10-01T10:0${n}:00Z` });
            }
          }
        });
        await service.dispose();
      },
    });

    for (const width of [1280, 420]) {
      const { context, page, errors } = await openPage(browser, running, { lang: 'zh', width });
      try {
        await page.goto(running.server.url);
        await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
        const nav = await revealNavRow(page, 'wrongbook');
        await nav.dispatchEvent('click');
        await page.locator('.wb-row-toggle[data-card-id="c-gap"]').waitFor({ timeout: 30000 });

        await page.locator('.wb-row-toggle[data-card-id="c-gap"]').dispatchEvent('click');
        const gapNote = page.locator('[data-retell-signal="gap"]');
        await gapNote.waitFor({ timeout: 10000 });
        assert.ok((await gapNote.textContent()).includes('AI 反馈，不计入评分'));
        const gapBox = await gapNote.boundingBox();
        assert.ok(gapBox && gapBox.width > 0 && gapBox.x >= 0 && gapBox.x + gapBox.width <= width + 1, `gap note fits in ${width}px viewport`);

        await page.locator('.wb-row-toggle[data-card-id="c-explained"]').dispatchEvent('click');
        const explainedNote = page.locator('[data-retell-signal="explained"]');
        await explainedNote.waitFor({ timeout: 10000 });
        assert.ok((await explainedNote.textContent()).includes('AI 反馈，不计入评分'));
        const explainedBox = await explainedNote.boundingBox();
        assert.ok(explainedBox && explainedBox.width > 0 && explainedBox.x >= 0 && explainedBox.x + explainedBox.width <= width + 1, `explained note fits in ${width}px viewport`);

        await page.locator('.wb-row-toggle[data-card-id="c-plain"]').dispatchEvent('click');
        const plainRow = page.locator('.wb-row', { has: page.locator('[data-card-id="c-plain"]') });
        await plainRow.locator('.wb-leech').waitFor({ timeout: 10000 });
        assert.equal(await plainRow.locator('.wb-leech__retell').count(), 0);
        assert.deepEqual(errors, [], `no console/page errors at ${width}px`);
      } finally {
        await context.close();
      }
    }
  } finally {
    if (running) await running.close();
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('expanded recommendations with long prompts stay inside .wb-recs at 1280px and 420px', { timeout: 120000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) {
    t.skip(`no Chromium to verify with: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), 'study-wb-recs-fit-dist-'));
  let running;
  try {
    await buildPreview({ outdir: dist });
    running = await startLateServer({
      distDir: dist,
      seed: async (root) => {
        await seedWrongBookLibrary(root, { wrong: 6 });
        const store = new Store(root);
        await store.update((library) => {
          const longPrompt = '一台主机上同时存在 TCP 服务和 UDP 服务。收到一个 IP 包后，内核为什么不能只用目的端口号决定把它交给哪个服务？请按处理顺序说明协议栈如何一步步分流并最终交付给对应进程。';
          for (const deck of library.decks) {
            for (const card of deck.cards) card.prompt = longPrompt;
          }
        });
      },
    });

    for (const width of [1280, 420]) {
      const { context, page, errors } = await openPage(browser, running, { lang: 'zh', width });
      try {
        await page.goto(running.server.url);
        await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
        await (await revealNavRow(page, 'wrongbook')).dispatchEvent('click');
        const diagFold = page.locator('details.wb-diagnostics-fold');
        await diagFold.waitFor({ timeout: 30000 });
        if (!(await diagFold.evaluate((el) => el.open))) await diagFold.locator('> summary').click();
        const toggle = page.locator('.wb-recs-bar button[aria-expanded]');
        await toggle.waitFor({ timeout: 30000 });
        await toggle.click();
        await page.locator('.wb-rec-line').first().waitFor({ timeout: 10000 });
        await settleAnimations(page);
        const fit = await page.evaluate(() => {
          const panel = document.querySelector('.wb-recs').getBoundingClientRect();
          const lines = [...document.querySelectorAll('.wb-rec-line')].map((el) => {
            const r = el.getBoundingClientRect();
            const btn = el.querySelector('.sh-btn').getBoundingClientRect();
            return { lineRight: r.right, btnRight: btn.right };
          });
          return {
            panelRight: panel.right,
            maxLineRight: Math.max(...lines.map((l) => l.lineRight)),
            maxBtnRight: Math.max(...lines.map((l) => l.btnRight)),
            docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          };
        });
        assert.ok(fit.maxLineRight <= fit.panelRight + 0.5, `${width}px: .wb-rec-line (${fit.maxLineRight}) must fit inside .wb-recs (${fit.panelRight})`);
        assert.ok(fit.maxBtnRight <= fit.panelRight + 0.5, `${width}px: practice button (${fit.maxBtnRight}) must fit inside .wb-recs (${fit.panelRight})`);
        assert.equal(fit.docOverflow, 0, `${width}px: no horizontal document overflow`);
        assert.deepEqual(errors, [], `${width}px: no console/page errors`);
      } finally {
        await context.close();
      }
    }
  } finally {
    if (running) await running.close();
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
