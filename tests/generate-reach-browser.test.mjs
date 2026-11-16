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

/* 创建题组 on an ordinary library of five materials, two of them with long titles (#1082, #1084).
   - #1082: with all five ticked, 生成并检查题组 is on the first screen at 1440×900 (zh, en) and at 420: one primary in view, nothing on top of it, and
     Tab through the form never puts the focused control under the bar that holds it. At the end of the page the bar is back in its place, above the estimate.
   - #1084: at 420 a long title has the row's text column, not 203 of 368 px beside an empty badge slot: at least 80% of the column (the slot of 6.5rem beside
     it left about 64%; 80% leaves room for nothing else on the title's line), before the index answer (an empty slot) and after it (badges). The rows are as tall
     before the answer as after, with no empty band under their content, and the badge ends the row's last line (the 选择页面 line, else the facts). */

const STAMP = '2026-10-01T08:00:00.000Z';
const COURSE = '设计模式';
const LONG_PDF = '网络协议与分布式系统一致性原理讲义（第二版，含习题与参考答案）.pdf';
const LONG_NOTE = 'A very long English lecture title about distributed consensus protocols and their failure modes.md';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    for (const [id, title] of [['n1', '设计模式讲义.md'], ['n2', '案例：墨笺笔记应用.md']]) state.sources.push({ id, title, text: `${title} 的内容。观察者模式与策略模式。`.repeat(30), createdAt: STAMP, courses: [COURSE], chars: 600 });
    for (const [name, pages] of [[LONG_PDF, 4], ['并发编程讲义.pdf', 3]]) {
      for (let page = 1; page <= pages; page++) state.sources.push({ id: `${name}-${page}`, title: `${name} · ${page}`, text: `第 ${page} 页：线程、锁与死锁。`.repeat(20), createdAt: STAMP, courses: [COURSE],
        document: { id: name, filename: name, page, totalPages: pages, extractionVersion: 2, format: 'pdf' } });
    }
    state.sources.push({ id: 'n3', title: LONG_NOTE, text: 'Consensus needs a quorum. '.repeat(30), createdAt: STAMP, courses: [COURSE], chars: 780 });
    state.focus = { ...(state.focus || {}), course: COURSE, mode: 'class' };
  });
  service.dispose?.();
}

async function start(distDir) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-generate-reach-'));
  const root = join(base, 'library');
  await seed(root);
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir });
  return { server, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

async function openGenerate(browser, running, options) {
  const opened = await openPage(browser, running, options);
  const hold = options.hold ? await holdActions(opened.page, options.hold) : null;
  await opened.page.goto(running.server.url);
  await opened.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  await (await revealNavRow(opened.page, 'generate')).dispatchEvent('click');
  await opened.page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });
  return { ...opened, hold };
}

/** The scrolling box of the page (the app's shell scrolls, not the document). */
const scrollTo = (page, where) => page.evaluate(to => {
  const button = document.querySelector('[data-tour="generate-submit"]');
  for (let node = button.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) { node.scrollTop = to === 'end' ? node.scrollHeight : 0; return true; }
  }
  document.scrollingElement.scrollTop = to === 'end' ? document.scrollingElement.scrollHeight : 0;
  return false;
}, where);

/** Where the one button is, whether something else is drawn on it, and how many primaries are in view. */
const reach = page => page.evaluate(() => {
  const button = document.querySelector('[data-tour="generate-submit"]'), box = button.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  const inView = element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight; };
  const primaries = [...document.querySelectorAll('.generate-page .sh-btn--primary')].filter(inView).length;
  const count = document.querySelector('.generate-summary')?.getBoundingClientRect();
  return { top: box.top, bottom: box.bottom, vh: window.innerHeight, onTop: !!hit && button.contains(hit), primaries,
    countInView: !!count && count.top >= 0 && count.bottom <= window.innerHeight };
});

test('#1082: with five materials ticked, 生成并检查题组 is on the first screen, alone, uncovered, and Tab never hides a control under it', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-generate-reach-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const [lang, theme, width, height] of [['zh', 'light', 1440, 900], ['en', 'light', 1440, 900], ['zh', 'dark', 420, 860]]) {
      const tag = `${lang} ${width}`;
      const { page, errors, context } = await openGenerate(browser, running, { lang, theme, width, height });
      const boxes = page.locator('[data-tour="generate-sources"] .source-picker__item input[type="checkbox"]');
      assert.equal(await boxes.count(), 5, `${tag}: five materials`);
      for (let i = 0; i < 5; i++) await boxes.nth(i).check();
      await until(async () => (await page.locator('.source-picker__item.is-selected').count()) === 5, 'all five ticked');
      await until(async () => (await page.locator('[data-generate-estimate] [data-token-estimate][data-status="ready"]').count()) > 0, 'the estimate', { timeoutMs: 60000 });
      await scrollTo(page, 'top');
      await settleAnimations(page);
      await frames(page, 4);
      const first = await reach(page);
      assert.ok(first.top >= 0 && first.bottom <= first.vh, `${tag}: the button is on the first screen (${Math.round(first.top)}–${Math.round(first.bottom)} of ${first.vh})`);
      assert.equal(first.onTop, true, `${tag}: nothing is drawn over the button`);
      assert.equal(first.primaries, 1, `${tag}: one primary in view`);
      assert.equal(first.countInView, true, `${tag}: the one-line count is in view with it`);

      // Tab from the first material to the button: every control on the way is in view and not under the bar
      await boxes.first().focus();
      const covered = [];
      for (let step = 0; step < 80; step++) {
        const state = await page.evaluate(() => {
          const active = document.activeElement, bar = document.querySelector('[data-tour="generate-submit"]').closest('[data-generate-bar]') || document.querySelector('[data-tour="generate-submit"]');
          if (active?.matches('[data-tour="generate-submit"]') || !document.querySelector('.generate-page form')?.contains(active)) return { done: true };
          const r = active.getBoundingClientRect(), b = bar.getBoundingClientRect();
          return { done: false, under: r.bottom > b.top + 1 && r.top < b.bottom - 1 && !bar.contains(active), name: (active.getAttribute('aria-label') || active.textContent || active.tagName).trim().slice(0, 24) };
        });
        if (state.done) break;
        if (state.under) covered.push(state.name);
        await page.keyboard.press('Tab');
        await frames(page, 2);
      }
      assert.deepEqual(covered, [], `${tag}: no focused control sits under the bar`);

      // at the end of the page the bar is in its place: above the estimate, which is in view and uncovered
      await scrollTo(page, 'end');
      await frames(page, 4);
      const end = await page.evaluate(() => {
        const button = document.querySelector('[data-tour="generate-submit"]').getBoundingClientRect(), estimate = document.querySelector('[data-generate-estimate]').getBoundingClientRect();
        const hit = document.elementFromPoint(estimate.left + 4, estimate.top + 4);
        return { button: button.bottom, estimate: estimate.top, estimateOnTop: !!hit && document.querySelector('[data-generate-estimate]').contains(hit) };
      });
      assert.ok(end.button <= end.estimate, `${tag}: at the end the button stands above the estimate (${end.button} ≤ ${end.estimate})`);
      assert.equal(end.estimateOnTop, true, `${tag}: and nothing covers the estimate`);
      assert.equal((await reach(page)).primaries, 1, `${tag}: one primary in view at the end too`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${tag}: no sideways scroll`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/** Per row: the title's share of the text column, the row's height, the empty band under it, where the badge sits. */
const rows = page => page.evaluate(() => [...document.querySelectorAll('[data-tour="generate-sources"] .source-picker__item')].map(item => {
  const row = item.querySelector('.source-picker__row'), style = getComputedStyle(row), box = row.getBoundingClientRect();
  const title = item.querySelector('strong'), t = title.getBoundingClientRect();
  const column = box.right - parseFloat(style.paddingRight) - t.left;
  const lines = Math.round(t.height / parseFloat(getComputedStyle(title).lineHeight));
  // the badge's slot is content: it is the room the badge will take, kept from the first paint
  const parts = [...row.querySelectorAll('.source-picker__text strong, .source-picker__text small, .source-picker__expand, [data-index-slot], [data-index-slot] [data-state]')].map(element => element.getBoundingClientRect()).filter(r => r.height > 0);
  const slot = row.querySelector('[data-index-slot]')?.getBoundingClientRect() ?? null, badge = row.querySelector('[data-index-slot] [data-state]')?.getBoundingClientRect() ?? null;
  const expand = row.querySelector('.source-picker__expand')?.getBoundingClientRect() ?? null, facts = [...row.querySelectorAll('.source-picker__text small')].at(-1).getBoundingClientRect();
  const last = expand ?? facts;
  return { title: title.textContent.slice(0, 16), share: t.width / column, lines, height: item.getBoundingClientRect().height,
    below: box.bottom - parseFloat(style.paddingBottom) - Math.max(...parts.map(r => r.bottom)),
    slotOnLastLine: slot ? slot.top < last.bottom - 1 && slot.bottom > last.top + 1 : null,
    badgeFits: badge && slot ? badge.width <= slot.width + 0.5 && badge.height <= slot.height + 0.5 : null, badge: !!badge };
}));

test('#1084: at 420 a long title has the row, before and after the index badges, and the answer moves no row', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-generate-rows420-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const lang of ['zh', 'en']) {
      const { page, errors, context, hold } = await openGenerate(browser, running, { lang, theme: 'dark', width: 420, height: 860, hold: ['retrieval.index.coverage'] });
      await until(() => hold.seen('retrieval.index.coverage'), 'the page to ask for index coverage');
      await settleAnimations(page);
      await frames(page, 4);
      const before = await rows(page);
      const ids = (await previewCall(running.server, 'snapshot')).sources.map(source => source.id);
      const partial = ids.filter(id => id.startsWith(LONG_PDF)).slice(0, 2);
      hold.release('retrieval.index.coverage', { indexed: ids.filter(id => !partial.includes(id)), stale: [], missing: partial, hasIndex: true, canIndex: true, building: null });
      await until(async () => (await page.locator('[data-tour="generate-sources"] [data-index-slot] [data-state]').count()) === 5, 'a badge on every row');
      await settleAnimations(page);
      await frames(page, 6);
      const after = await rows(page);
      for (const [when, list] of [['without badges', before], ['with badges', after]]) {
        for (const row of list) {
          if (row.lines > 1 || row.title.startsWith('网络') || row.title.startsWith('A very')) assert.ok(row.share >= 0.8, `${lang} ${when}: ${row.title}: the title has ${Math.round(row.share * 100)}% of the text column`);
          assert.ok(row.below <= 1, `${lang} ${when}: ${row.title}: ${Math.round(row.below)}px of empty band under the content`);
          assert.equal(row.slotOnLastLine, true, `${lang} ${when}: ${row.title}: the badge's place ends the row's last line`);
        }
      }
      assert.deepEqual(after.map(row => Math.round(row.height * 10) / 10), before.map(row => Math.round(row.height * 10) / 10), `${lang}: no row changes height when the badges arrive`);
      assert.deepEqual(after.map(row => row.badgeFits), after.map(() => true), `${lang}: every badge fits its slot`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${lang}: no sideways scroll`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
