/* global document, window, getComputedStyle -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, holdActions, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { StudyService } from '../lib/service.js';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* #1084: the rows of 创建题组 › 01 / 选择资料 are as tall as what they say. A row has the checkbox, the title, one line of facts and, for a document of several pages, 选择页面; the line kept
   for an index badge (#205) is kept only while the answer is still coming, so a document with no badge has no empty block under its facts, at 1280 and at 420 px (where 选择页面 goes
   under the facts, on the rows that have it, and nowhere else). */

const STAMP = '2026-10-01T08:00:00.000Z';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    for (const [name, pages] of [['并发编程讲义.pdf', 3], ['网络协议讲义.pdf', 4]]) {
      for (let page = 1; page <= pages; page++) {
        state.sources.push({ id: `${name}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：线程、锁与死锁。`.repeat(20), createdAt: STAMP, courses: ['计算机'],
          document: { id: name, filename: name, page, totalPages: pages, extractionVersion: 2, format: 'pdf' } });
      }
    }
    for (const [id, title] of [['n1', '数据库索引笔记.md'], ['n2', '事务与并发.md']]) state.sources.push({ id, title, text: `${title} 的内容。`.repeat(30), createdAt: STAMP, courses: ['计算机'], chars: 300 });
    state.focus = { ...(state.focus || {}), course: '计算机', mode: 'class' };
  });
  service.dispose?.();
}

async function start(distDir) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-picker-rows-'));
  const root = join(base, 'library');
  await seed(root);
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir });
  return { server, base, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

/** Per row: how much of the row is below its last content (the padding is the most that may be there), whether the button sits beside or under the facts. */
const measure = page => page.evaluate(() => [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].map(item => {
  const row = item.querySelector('.source-picker__row'), style = getComputedStyle(row), box = item.getBoundingClientRect();
  // the text block is measured by its lines: a narrow row lends them to its grid (display: contents), so the block itself has no box there
  const lines = [...row.querySelectorAll('.source-picker__text strong, .source-picker__text small')].map(element => element.getBoundingClientRect());
  const text = { top: Math.min(...lines.map(r => r.top)), bottom: Math.max(...lines.map(r => r.bottom)), left: Math.min(...lines.map(r => r.left)), right: Math.max(...lines.map(r => r.right)) };
  const button = row.querySelector('.source-picker__expand')?.getBoundingClientRect() ?? null;
  const bottom = Math.max(text.bottom, button?.bottom ?? 0);
  const facts = row.querySelector('.source-picker__facts'), slot = row.querySelector('[data-index-slot]');
  return { title: item.querySelector('strong').textContent, height: box.height, below: box.bottom - bottom, padBottom: parseFloat(style.paddingBottom),
    slotAfterFacts: slot && facts ? !!(facts.compareDocumentPosition(slot) & 4) : false,
    // 选择页面 sits on no line of the text (round 11: in a picker with badges the facts line runs on under the button's end, below the title line)
    hasButton: !!button, buttonBesideText: button ? button.top < text.bottom - 1 : null,
    buttonOverlapsText: button ? lines.some(line => button.left < line.right && button.right > line.left && button.top < line.bottom - 1 && button.bottom > line.top + 1) : false };
}));

test('the rows of the material picker keep no empty block: height follows the content, 选择页面 only where a document has pages', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-picker-rows-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const [width, lang] of [[1280, 'zh'], [420, 'zh'], [420, 'en']]) {
      const { page, errors, context } = await openPage(browser, running, { lang, theme: 'dark', width, height: width < 600 ? 860 : 900 });
      await page.goto(running.server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      await (await revealNavRow(page, 'generate')).dispatchEvent('click');
      await page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });
      await settleAnimations(page);
      await frames(page, 6);
      const rows = await measure(page);
      assert.equal(rows.length, 4, `${width}px: two PDFs and two notes`);
      for (const row of rows) {
        assert.equal(row.slotAfterFacts, true, `${width}px: ${row.title}: the badge's slot follows the facts in the DOM (it ends the facts line)`);
        assert.ok(row.below <= row.padBottom + 1, `${width}px: ${row.title}: ${row.below}px under the content, the row's padding is ${row.padBottom}px`);
        assert.equal(row.buttonOverlapsText, false, `${width}px: ${row.title}: 选择页面 does not sit on the text`);
      }
      assert.deepEqual(rows.map(row => [row.title.includes('讲义'), row.hasButton]).filter(([pdf, button]) => pdf !== button), [], `${width}px: 选择页面 is on the documents with pages only`);
      for (const row of rows.filter(r => !r.hasButton)) assert.ok(row.height <= 72, `${width}px: ${row.title}: ${row.height}px for a title and one line of facts`);
      // the small quiet buttons of the bar stand on the list's edges: their words, not their boxes (wrapped under the count or beside it)
      await page.locator('[data-tour="generate-sources"] .source-picker__item input[type="checkbox"]').first().check();
      await frames(page, 3);
      const bar = await page.evaluate(() => {
        const edge = (element, side) => { const range = document.createRange(); range.selectNodeContents(element); const rect = range.getBoundingClientRect(); return side === 'left' ? rect.left : rect.right; };
        const list = document.querySelector('[data-tour="generate-sources"] .source-picker__list').getBoundingClientRect();
        const buttons = [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__actions button')], count = document.querySelector('.source-picker__count').getBoundingClientRect();
        return { n: buttons.length, wrapped: buttons[0].getBoundingClientRect().top > count.bottom - 1, firstLeft: edge(buttons[0], 'left'), lastRight: edge(buttons.at(-1), 'right'), listLeft: list.left, listRight: list.right };
      });
      assert.equal(bar.n, 2, `${width}px ${lang}: 选择当前范围 and 清空选择`);
      if (bar.wrapped) assert.ok(Math.abs(bar.firstLeft - bar.listLeft) <= 1.5, `${width}px ${lang}: wrapped, the first button's words start on the list's edge (${bar.firstLeft} vs ${bar.listLeft})`);
      else assert.ok(Math.abs(bar.lastRight - bar.listRight) <= 1.5, `${width}px ${lang}: beside the count, the last button's words end on the list's edge (${bar.lastRight} vs ${bar.listRight})`);
      if (width === 1280) for (const row of rows.filter(r => r.hasButton)) assert.equal(row.buttonBesideText, true, `1280px: ${row.title}: 选择页面 is beside the facts`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${width}px: no sideways scroll`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/** Heights of the rows and where 02 / 学习方式 starts: what the index answer must not move. */
const frame = page => page.evaluate(() => ({ rows: [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].map(item => Math.round(item.getBoundingClientRect().height * 10) / 10),
  options: Math.round(document.querySelector('[data-tour="generate-options"]').getBoundingClientRect().top * 10) / 10 }));

test('the index answer arriving moves nothing: every row is as tall before as after, with and without a badge, and 02 stays where it was', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-picker-late-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'dark', width, height: width < 600 ? 860 : 900 });
      const hold = await holdActions(page, ['retrieval.index.coverage']);
      await page.goto(running.server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      await (await revealNavRow(page, 'generate')).dispatchEvent('click');
      await page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });
      await until(() => hold.seen('retrieval.index.coverage'), 'the page to ask for index coverage');
      await settleAnimations(page);
      await frames(page, 4);
      const before = await frame(page);
      const snapshot = await previewCall(running.server, 'snapshot');
      const ids = snapshot.sources.map(source => source.id);
      // both PDFs are indexed, the notes are not (nothing to say about them: no badge, no line above the list either)
      hold.release('retrieval.index.coverage', { indexed: ids.filter(id => id.endsWith('.pdf') || /\.pdf-\d/.test(id)), stale: [], missing: [], hasIndex: true, canIndex: true, building: null });
      await until(async () => (await page.locator('[data-tour="generate-sources"] .source-picker__index [data-state]').count()) === 2, 'the two badges to appear');
      await settleAnimations(page);
      await frames(page, 6);
      const after = await frame(page);
      assert.deepEqual(after.rows, before.rows, `${width}px: no row changes height when the answer arrives (${before.rows} -> ${after.rows})`);
      assert.equal(after.options, before.options, `${width}px: 02 / 学习方式 does not move (${before.options} -> ${after.options})`);
      const states = await page.locator('[data-tour="generate-sources"] .source-picker__index [data-state]').evaluateAll(list => list.map(element => [element.getAttribute('data-state'), element.getBoundingClientRect().width <= element.closest('.source-picker__index').getBoundingClientRect().width + 0.5]));
      assert.deepEqual(states, [['indexed', true], ['indexed', true]], `${width}px: the badges fit their slot`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
