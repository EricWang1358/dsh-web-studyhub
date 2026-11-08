/* global document -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { startNavServer } from '../scripts/qa/nav-layout.mjs';

/* The sidebar of #654–#656 in a real browser: a main list of at most 7 entries (回到题目 and six pages), everything else in 「更多」 by content,
   every page still reachable through its anchor, 「更多」 remembered after a reload, a keyboard move between the main list and a section (and a
   refusal when the main list is full), an order saved by the sidebar of before migrated without loss, no dot on an empty library (#655), and a
   footer of three controls (#656). Needs a Chromium; without one the test says so instead of passing silently. */
const PAGES = ['library', 'wrongbook', 'notes', 'board', 'exam', 'dashboard', 'sources', 'generate', 'tasks', 'skeleton', 'audio', 'live', 'examprep', 'examcoach', 'book'];
const MAIN = ['library', 'sources', 'generate', 'wrongbook', 'exam', 'dashboard'];

test('the sidebar: seven main entries, 「更多」 by content, all fourteen pages reachable, no dot on an empty library, three footer controls', { timeout: 300000 }, async (t) => {
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
      label: group.querySelector('.nav-group-text')?.textContent,
      ids: [...group.querySelectorAll('[data-nav-id]')].map((row) => row.dataset.navId),
      shown: [...group.querySelectorAll('[data-nav-id]')].filter((row) => row.checkVisibility()).length,
    }])));
    const moreButton = page.locator('[data-tour="nav-more"]');
    const before = await state();
    assert.deepEqual(Object.keys(before), ['main', 'material', 'practice', 'exam', 'notes']);
    assert.deepEqual(Object.values(before).slice(1).map((group) => group.label), ['资料与出题', '练习与复习', '考试与统计', '任务、笔记与待办'], 'sections named by what they hold');
    assert.deepEqual(before.main.ids, MAIN);
    assert.deepEqual(Object.values(before).flatMap((group) => group.ids).sort(), [...PAGES].sort(), 'every page sits in exactly one group');
    for (const id of PAGES) assert.equal(await page.locator(`[data-tour="nav-${id}"]`).count(), 1, `${id} keeps its tour anchor`);
    assert.equal(await page.locator('[data-tour="nav-workflows"]').count(), 0, 'retired workflows page has no sidebar row');
    // Above 「更多」: 回到题目 and the six pages, nothing else (为你定制 joins only while prepared questions are ready).
    const visibleRows = await page.evaluate(() => [...document.querySelectorAll('.side-nav [data-nav-group="main"] button.nav')].filter((row) => row.checkVisibility()).length);
    assert.ok(visibleRows <= 7, `${visibleRows} main entries`);
    assert.equal(await moreButton.getAttribute('aria-expanded'), 'false', '「更多」 starts closed');
    assert.ok(Object.values(before).slice(1).every((group) => group.shown === 0), `its rows are folded away: ${JSON.stringify(before)}`);
    assert.equal(await page.locator('.sidebar .nav-dot').count(), 0, 'an empty library has nothing to act on, so no dot (#655)');
    const footer = await page.evaluate(() => [...document.querySelectorAll('.sidebar-bottom button.nav')].filter((row) => row.checkVisibility()).map((row) => row.dataset.tour));
    assert.deepEqual(footer, ['nav-finder', 'nav-help', 'nav-settings'], 'three footer controls (#656)');

    const top = (id) => page.locator(`[data-nav-id="${id}"]`).evaluate((row) => row.getBoundingClientRect().top);
    const rowsAbove = await Promise.all(MAIN.map(top));
    await moreButton.click();
    await page.waitForTimeout(300);
    const opened = await state();
    assert.equal(await moreButton.getAttribute('aria-expanded'), 'true');
    assert.ok(Object.values(opened).every((group) => group.shown === group.ids.length), 'every row is on screen');
    assert.deepEqual(await Promise.all(MAIN.map(top)), rowsAbove, 'the main rows do not move when 「更多」 opens');
    await page.reload();
    await page.locator('.sidebar').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(600);
    assert.equal(await moreButton.getAttribute('aria-expanded'), 'true', '「更多」 is still open after a reload');

    // The keyboard: the last main page goes down to the top of its section, a section's first page goes up into the main list, and a full
    // main list says so instead of moving.
    const live = () => page.locator('.side-nav [role="status"]').textContent();
    await page.locator('[data-nav-id="dashboard"]').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForTimeout(200);
    assert.deepEqual((await state()).exam.ids[0], 'dashboard');
    assert.match(await live(), /统计 已移到「更多 › 考试与统计」第 1 位/);
    await page.locator('[data-nav-id="book"]').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForTimeout(200);
    assert.deepEqual((await state()).main.ids, ['library', 'sources', 'generate', 'wrongbook', 'exam', 'book']);
    await page.locator('[data-nav-id="skeleton"]').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForTimeout(200);
    assert.equal((await state()).main.ids.length, 6, 'the main list stays at six');
    assert.match(await live(), /主导航最多放 6 项/);
    await page.reload();
    await page.locator('.sidebar').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(600);
    assert.deepEqual((await state()).main.ids, ['library', 'sources', 'generate', 'wrongbook', 'exam', 'book'], 'the order is kept');
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await running.close();
    await rm(dist, { recursive: true, force: true });
  }
});

test('an order saved by the sidebar of before (每天 / 阶段性 / 课程准备与管理) is migrated: the learner\'s sequence holds in every new group', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-groups-migrate-'));
  await buildPreview({ outdir: dist });
  const running = await startNavServer({ distDir: dist });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('study-ui-language', 'zh');
    localStorage.setItem('study-nav-order', JSON.stringify({
      daily: ['board', 'dashboard', 'library', 'notes', 'sources', 'generate', 'tasks', 'wrongbook', 'workflows'],
      periodic: ['book', 'exam', 'examprep'], setup: ['live', 'skeleton', 'audio'],
    }));
  });
  const page = await context.newPage();
  try {
    await page.goto(running.server.url);
    await page.locator('.sidebar').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(600);
    const ids = (group) => page.locator(`.sidebar [data-nav-group="${group}"] [data-nav-id]`).evaluateAll((rows) => rows.map((row) => row.dataset.navId));
    assert.deepEqual(await ids('main'), ['dashboard', 'library', 'sources', 'generate', 'wrongbook', 'exam']);
    assert.deepEqual(await ids('notes'), ['board', 'notes', 'tasks']);
    assert.deepEqual(await ids('practice'), ['book', 'skeleton']);
    assert.deepEqual(await ids('material'), ['live', 'audio']);
    // The first move writes the new key and forgets the old one.
    await page.locator('[data-tour="nav-more"]').click();
    await page.locator('[data-nav-id="notes"]').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForTimeout(200);
    const stored = await page.evaluate(() => ({ v2: JSON.parse(localStorage.getItem('study-nav-order:v2')), old: localStorage.getItem('study-nav-order') }));
    assert.deepEqual(stored.v2.notes, ['notes', 'board', 'tasks']);
    assert.equal(stored.old, null);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await running.close();
    await rm(dist, { recursive: true, force: true });
  }
});

test('sidebar footer stays clickable within the host at 100%, 150% and 200% interface size', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-scaled-nav-dist-'));
  let running;
  try {
    await buildPreview({ outdir: dist });
    running = await startNavServer({ distDir: dist });
    for (const width of [1280, 420]) for (const height of [900, 480]) for (const scale of [100, 150, 200]) {
      await t.test(`${width}x${height} at ${scale}%`, async () => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await context.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); });
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        try {
          await page.goto(running.server.url);
          const settings = page.locator('[data-tour="nav-settings"]').first();
          await settings.click();
          await page.locator('.settings-nav [data-category="appearance"]').click();
          await page.getByRole('button', { name: `${scale}%`, exact: true }).first().click();
          await page.waitForFunction(value => document.querySelector('.study-app')?.getAttribute('data-ui-scale') === String(value), scale);
          await page.setViewportSize({ width, height });
          // A workspace too narrow for the sidebar (#657) has it in a drawer behind the top bar's menu button; choosing a row closes the drawer.
          const drawer = async () => {
            await page.locator('.sidebar, .nav-menu-toggle').first().waitFor();
            if (await page.locator('.sidebar').count()) return false;
            await page.locator('.nav-menu-toggle').click();
            await page.locator('.nav-drawer .sidebar').waitFor();
            return true;
          };
          const inDrawer = await drawer();
          const bounds = await page.locator('.sidebar').first().evaluate(sidebar => {
            const side = (sidebar.closest('dialog') || sidebar).getBoundingClientRect(), host = sidebar.closest('.study-app').getBoundingClientRect();
            return { sidebarHeight: side.height, hostHeight: host.height };
          });
          assert.ok(bounds.sidebarHeight <= bounds.hostHeight + 1,
            `the sidebar (or its drawer) must fit its scaled host so its own scrolling can reach the footer: ${JSON.stringify(bounds)}`);
          // Use real pointer clicks in both directions: scrolling a row into view is not enough if a sticky column extends below its host.
          await page.locator('[data-tour="nav-library"]').first().click();
          await page.locator('.study-app[data-usage-area="library"]').waitFor();
          await drawer();
          await settings.scrollIntoViewIfNeeded();
          const footer = await settings.boundingBox();
          assert.ok(footer && footer.y >= -1 && footer.y + footer.height <= height + 1,
            `the Settings button must be visible inside ${height}px: ${JSON.stringify(footer)}`);
          await settings.click();
          await page.locator('.settings-nav').waitFor();
          if (inDrawer) assert.equal(await page.locator('.nav-drawer').count(), 0, 'choosing a page closes the drawer');
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }
  } finally {
    await browser.close().catch(() => {});
    await running?.close();
    await rm(dist, { recursive: true, force: true });
  }
});

test('a narrow workspace has no icon rail: a labelled drawer from the top bar, opened and closed by keyboard, focus back on the menu button (#657)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-drawer-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startNavServer({ distDir: dist });
  const context = await browser.newContext({ viewport: { width: 420, height: 800 } });
  await context.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); } catch { /* blocked */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.goto(running.server.url);
    const menu = page.locator('.nav-menu-toggle');
    await menu.waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.sidebar').count(), 0, 'no rail and no sidebar column');
    const main = await page.locator('main').first().evaluate((element) => Math.round(element.getBoundingClientRect().width));
    assert.ok(main >= 400, `the page has the width the rail took (62px): ${main}px`);
    assert.equal(await menu.getAttribute('aria-label'), '打开导航');
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    // The keyboard opens it: every row has its label, and the focus is inside.
    await menu.focus();
    await page.keyboard.press('Enter');
    const drawer = page.locator('dialog.nav-drawer');
    await drawer.waitFor();
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    assert.equal(await drawer.evaluate((element) => element.open && element.matches(':modal')), true, 'a modal dialog: the page behind is inert');
    assert.ok(await drawer.evaluate((element) => element.contains(document.activeElement)), 'the focus moves into the drawer');
    const labels = await drawer.locator('button.nav').evaluateAll((rows) => rows.filter((row) => row.checkVisibility()).map((row) => row.querySelector('.nav-label')?.textContent.trim() || ''));
    assert.ok(labels.length >= 10 && labels.every(Boolean), `every row is named: ${labels.join(' / ')}`);
    // Esc closes it, and the focus goes back to the menu button.
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('nav-menu-toggle')), true, 'the focus is back on the menu button');
    // Choosing a page closes it too.
    await page.keyboard.press('Enter');
    await drawer.waitFor();
    await drawer.locator('[data-tour="nav-sources"]').click();
    await drawer.waitFor({ state: 'detached' });
    await page.locator('.study-app[data-usage-area="sources"]').waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await running.close();
    await rm(dist, { recursive: true, force: true });
  }
});
