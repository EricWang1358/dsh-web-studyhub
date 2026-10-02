/* global document -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { startNavServer } from '../scripts/qa/nav-layout.mjs';

/* The grouped sidebar in a real browser: every page is still reachable through its anchor, a folded group hides only its
   own rows and is still folded after a reload, the rows above and below keep their height, and a keyboard move stays inside
   the group. Needs a Chromium; without one the test says so instead of passing silently. */
const PAGES = ['library', 'wrongbook', 'workflows', 'notes', 'board', 'exam', 'dashboard', 'sources', 'generate', 'skeleton', 'audio', 'live'];

test('the grouped sidebar: all twelve pages reachable, folding remembered, keyboard reorder inside a group', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-groups-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startNavServer({ distDir: dist });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-theme', 'dark'); } catch { /* blocked */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.goto(running.server.url);
    await page.locator('.sidebar').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);

    const state = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.sidebar [data-nav-group]')].map((group) => [group.dataset.navGroup, {
      open: group.dataset.open, expanded: group.querySelector('.nav-group-label')?.getAttribute('aria-expanded') ?? null,
      label: group.querySelector('.nav-group-text')?.textContent,
      ids: [...group.querySelectorAll('[data-nav-id]')].map((row) => row.dataset.navId),
      shown: [...group.querySelectorAll('[data-nav-id]')].filter((row) => row.getBoundingClientRect().height > 0).length,
    }])));
    const before = await state();
    assert.deepEqual(Object.keys(before), ['daily', 'periodic', 'setup']);
    assert.deepEqual(Object.values(before).map((group) => group.label), ['每天', '阶段性', '课程准备与管理']);
    assert.deepEqual(Object.values(before).flatMap((group) => group.ids).sort(), [...PAGES].sort(), 'every page sits in exactly one group');
    for (const id of PAGES) assert.equal(await page.locator(`[data-tour="nav-${id}"]`).count(), 1, `${id} keeps its tour anchor`);
    assert.equal(before.daily.expanded, null, 'the daily group is a heading, not a button');
    assert.ok(Object.values(before).every((group) => group.open === 'true' && group.shown === group.ids.length), 'everything is open at first');

    const top = (id) => page.locator(`[data-nav-id="${id}"]`).evaluate((row) => row.getBoundingClientRect().top);
    const rowsAbove = await Promise.all(['library', 'board', 'exam'].map(top));
    await page.locator('#nav-group-setup-label').click();
    await page.waitForTimeout(300);
    const folded = await state();
    assert.equal(folded.setup.open, 'false');
    assert.equal(folded.setup.shown, 0, 'a folded group shows none of its rows');
    assert.equal(folded.periodic.shown, 2, 'the other groups are untouched');
    assert.deepEqual(await Promise.all(['library', 'board', 'exam'].map(top)), rowsAbove, 'rows above the folded group do not move');
    assert.equal(await page.locator('[data-tour="nav-sources"]').count(), 1, 'the folded rows stay in the page');
    assert.equal(await page.evaluate(() => localStorage.getItem('study-nav-groups')), '{"setup":true}');

    await page.reload();
    await page.locator('.sidebar').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(600);
    assert.equal((await state()).setup.open, 'false', 'the group is still folded after a reload');
    await page.locator('#nav-group-setup-label').click();
    await page.waitForTimeout(300);
    assert.equal((await state()).setup.shown, 5);
    assert.equal(await page.evaluate(() => localStorage.getItem('study-nav-groups')), null, 'nothing folded, nothing kept');

    // A keyboard move stays inside the group: the last row of the daily group cannot go down into the next group.
    await page.locator('[data-nav-id="board"]').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForTimeout(200);
    assert.deepEqual((await state()).daily.ids, ['library', 'wrongbook', 'workflows', 'notes', 'board']);
    await page.locator('[data-nav-id="board"]').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForTimeout(300);
    assert.deepEqual((await state()).daily.ids, ['library', 'wrongbook', 'workflows', 'board', 'notes']);
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await running.close();
    await rm(dist, { recursive: true, force: true });
  }
});
