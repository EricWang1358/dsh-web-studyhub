/* global document, innerHeight */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';

/* #1712 in a real browser. The three steps that introduce a page from its sidebar entry (任务, 备考补习, 学习笔记) neither cover the page's title nor its first
   block, with the sidebar there and put away, at 2000, 1440 and 420 px. With the sidebar put away they light the page's own heading, not the menu button.
   The reading of the page below is the test's own (not ui/tour/anchor.js), so a wrong reading in the product does not pass itself. */

const STEPS = ['tasks', 'examprep', 'notes'];
const VIEWS = [
  { name: '2000 px, sidebar put away', width: 2000, height: 1088, collapsed: true },
  { name: '1440 px, sidebar there', width: 1440, height: 900, collapsed: false },
  { name: '1440 px, sidebar put away', width: 1440, height: 900, collapsed: true },
  { name: '420 px', width: 420, height: 860, collapsed: false },
];

const measure = (page) => page.evaluate(() => {
  const rect = (element) => { const r = element?.getBoundingClientRect(); return r && r.width && r.height ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null; };
  const heading = [...document.querySelectorAll('main h1')].find((element) => rect(element));
  const range = document.createRange();
  if (heading) range.selectNodeContents(heading);
  const header = heading?.closest('.sh-page-header');
  let block = header?.nextElementSibling;
  while (block && !(rect(block)?.bottom - rect(block)?.top > 8)) block = block.nextElementSibling;
  // What is read in it: the drawn parts of a stretched empty state, or the card a list wrapper opens with (今日学习总结).
  const parts = [...(block?.children || [])].map((element) => [element, rect(element)]).filter(([, box]) => box);
  const readFirst = block?.classList.contains('sh-empty') ? parts.map(([, box]) => box).reduce((a, b) => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) })) : /^(SECTION|ARTICLE)$/.test(parts[0]?.[0].tagName) ? parts[0][1] : rect(block);
  const meets = (a, b) => !!a && !!b && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  const card = rect(document.querySelector('.tour-pop')), spot = rect(document.querySelector('.tour-spot'));
  const title = heading ? rect(range) : null, first = readFirst;
  return { card, spot, title, first, coversTitle: meets(card, title), coversFirst: meets(card, first) && first.top < innerHeight, coversSpot: meets(card, spot),
    headLit: !!document.querySelector('[data-tour$="-head"]') && !document.querySelector('.side-nav') };
});

test('#1712: the steps that open a page from the sidebar leave its title and first block uncovered', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const dist = await mkdtemp(join(tmpdir(), 'study-tour-cover-dist-'));
  await buildPreview({ outdir: dist });
  try {
    for (const view of VIEWS) {
      const base = await mkdtemp(join(tmpdir(), 'study-tour-cover-'));
      const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0,
        model: createFakeModel({ latencyMs: 20 }), distDir: dist, runtimePilot: { examBlueprint: true } });
      try {
        await previewCall(server, 'sample.load', { language: 'zh' });
        const { root } = await previewCall(server, 'snapshot', { uiLanguage: 'zh' });
        const { page, errors, context } = await openPage(browser, { server }, { lang: 'zh', theme: 'dark', width: view.width, height: view.height });
        await page.goto(server.url);
        await page.locator('.study-app').waitFor({ timeout: 30000 });
        if (view.collapsed) {
          await page.locator('[data-tour="nav-collapse"]').click();
          await page.locator('[data-tour="nav-menu"]').waitFor({ timeout: 10000 });
        }
        for (const id of STEPS) {
          // A paused full tour at this step, resumed from the sidebar-independent button in Settings.
          await page.evaluate(([key, value]) => localStorage.setItem(key, value), [`study-tour:${root}`, JSON.stringify({ stepId: id, done: false, full: true })]);
          await page.reload();
          await page.locator('.study-app').waitFor({ timeout: 30000 });
          await page.locator('[data-tour="nav-menu"], [data-tour="nav-settings"]').first().waitFor({ timeout: 30000 });
          if (await page.locator('[data-tour="nav-menu"]').isVisible()) await page.locator('[data-tour="nav-menu"]').click();
          await page.locator('[data-tour="nav-settings"]').click();
          await page.locator('.settings-nav__item[data-category="profile"]').click();
          await page.getByRole('button', { name: /^继续功能导览/ }).click();
          await page.locator('.tour-layer:not(.is-measuring) .tour-pop').waitFor({ timeout: 30000 });
          await page.locator('.tour-spot').waitFor({ timeout: 15000 });
          let seen = null;
          // The card settles once the page has drawn; what is measured is what stays.
          await until(async () => {
            await settleAnimations(page);
            await frames(page, 4);
            const now = await measure(page);
            const same = JSON.stringify(now) === JSON.stringify(seen);
            seen = now;
            return same && !!now.title && !!now.first;
          }, `${view.name}, ${id}: the page and the card settle`, { timeoutMs: 20000, intervalMs: 500 });
          const where = `${view.name}, ${id}: ${JSON.stringify(seen)}`;
          assert.ok(!seen.coversTitle, `the card covers the page title (${where})`);
          // A narrow panel docks the card along the bottom, and 备考补习's empty state (352–712 px at 420 × 860, under a 205 px header) cannot fit above a 256 px card:
          // there the block is shown from its top, at least 96 px of it above the card. Beside the page the card keeps off all of it.
          const firstShown = view.width < 600 ? !seen.coversFirst || seen.card.top - seen.first.top >= 96 : !seen.coversFirst;
          assert.ok(firstShown, `the card covers the first block (${where})`);
          assert.ok(!seen.coversSpot, `the card lies on the lit area (${where})`);
          if (view.collapsed || view.width < 600) assert.ok(seen.headLit && Math.abs(seen.spot.top - seen.title.top) < 80, `the page's own heading is lit (${where})`);
        }
        assert.deepEqual(errors, [], 'no console or page errors');
        await context.close();
      } finally {
        await server.close();
        await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      }
    }
  } finally {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
