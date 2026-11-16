/* global document, window, getComputedStyle -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, openPage, settleAnimations } from '../scripts/qa/layout-late.mjs';
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
  const parts = [...row.querySelectorAll('.source-picker__text, .source-picker__expand')].map(element => element.getBoundingClientRect());
  const bottom = Math.max(...parts.map(rect => rect.bottom));
  const text = row.querySelector('.source-picker__text').getBoundingClientRect(), button = row.querySelector('.source-picker__expand')?.getBoundingClientRect() ?? null;
  return { title: item.querySelector('strong').textContent, height: box.height, below: box.bottom - bottom, padBottom: parseFloat(style.paddingBottom), emptyBadgeLines: item.querySelectorAll('.source-picker__index:empty').length,
    hasButton: !!button, buttonBesideText: button ? button.top < text.bottom - 1 : null, buttonOverlapsText: button ? button.left < text.right && button.right > text.left && button.top < text.bottom - 1 && button.bottom > text.top : false };
}));

test('the rows of the material picker keep no empty block: height follows the content, 选择页面 only where a document has pages', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-picker-rows-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'dark', width, height: width < 600 ? 860 : 900 });
      await page.goto(running.server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      await (await revealNavRow(page, 'generate')).dispatchEvent('click');
      await page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });
      await settleAnimations(page);
      await frames(page, 6);
      const rows = await measure(page);
      assert.equal(rows.length, 4, `${width}px: two PDFs and two notes`);
      for (const row of rows) {
        assert.equal(row.emptyBadgeLines, 0, `${width}px: ${row.title}: no empty line kept for a badge that is not coming`);
        assert.ok(row.below <= row.padBottom + 1, `${width}px: ${row.title}: ${row.below}px under the content, the row's padding is ${row.padBottom}px`);
        assert.equal(row.buttonOverlapsText, false, `${width}px: ${row.title}: 选择页面 does not sit on the text`);
      }
      assert.deepEqual(rows.map(row => [row.title.includes('讲义'), row.hasButton]).filter(([pdf, button]) => pdf !== button), [], `${width}px: 选择页面 is on the documents with pages only`);
      if (width === 1280) for (const row of rows.filter(r => r.hasButton)) assert.equal(row.buttonBesideText, true, `1280px: ${row.title}: 选择页面 is beside the facts`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${width}px: no sideways scroll`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
