/* global localStorage -- page callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { startNavServer } from '../scripts/qa/nav-layout.mjs';

/* Issue 569 in a real browser: the sidebar's tooltips say what a page is for; 「长按并拖动可调整顺序（键盘：Alt+↑/↓）」 is in the first one the
   learner opens and in no other, not even after a reload; wide, the tooltip does not repeat the label beside it; in the 420px rail, where the
   row is an icon, it names the page. Needs a Chromium; without one the test says so instead of passing silently. */
const LINE = '长按并拖动可调整顺序（键盘：Alt+↑/↓）';

test('the reorder line is said once, the label only where it is not on screen', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-reorder-hint-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startNavServer({ distDir: dist });
  const open = async (width) => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); } catch { /* blocked */ } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(running.server.url);
    await page.locator('[data-nav-id="library"]:not([disabled])').waitFor({ timeout: 30000 });
    return { context, page, errors };
  };
  /** Hover a row and read its open tooltip, line by line; then move away so it closes. */
  const hover = async (page, id) => {
    await page.locator(`[data-nav-id="${id}"]`).hover();
    const tip = page.locator('.nav-tooltip:popover-open');
    await tip.waitFor({ timeout: 5000 });
    const lines = (await tip.innerText()).split('\n').map((line) => line.trim()).filter(Boolean);
    await page.mouse.move(900, 600);
    await page.locator('.nav-tooltip:popover-open').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(100);
    return lines;
  };
  try {
    await t.test('1440: the first tooltip says it, the next ones and those after a reload do not; no label twice', async () => {
      const { context, page, errors } = await open(1440);
      try {
        const first = await hover(page, 'library');
        assert.ok(first.includes(LINE), `the first tooltip tells how to reorder: ${JSON.stringify(first)}`);
        assert.ok(first.some((line) => line.startsWith('每次打开先看这里')), 'and what the page is for');
        assert.ok(!first.includes('学习库'), `the label is on screen beside it, so not in the tooltip: ${JSON.stringify(first)}`);
        assert.equal(await page.evaluate(() => localStorage.getItem('study-nav-reorder-hint:v1')), 'true');
        for (const id of ['sources', 'board', 'library']) {
          const lines = await hover(page, id);
          assert.ok(!lines.includes(LINE), `${id}: said once is enough: ${JSON.stringify(lines)}`);
          assert.ok(lines.length >= 1, `${id}: still says what it is for`);
        }
        await page.reload();
        await page.locator('[data-nav-id="library"]:not([disabled])').waitFor({ timeout: 30000 });
        assert.ok(!(await hover(page, 'sources')).includes(LINE), 'not after a reload either');
        assert.equal(await page.locator('[data-nav-id="sources"]').getAttribute('aria-keyshortcuts'), 'Alt+ArrowUp Alt+ArrowDown', 'the keys stay on the row');
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    await t.test('420: the rail is icons, so the tooltip names the page', async () => {
      const { context, page, errors } = await open(420);
      try {
        assert.equal(await page.locator('.sidebar.is-narrow').count(), 1, 'the narrow window draws the rail');
        const lines = await hover(page, 'library');
        assert.ok(lines.slice(0, 2).includes('学习库'), `the page is named first: ${JSON.stringify(lines)}`);
        assert.ok(lines.includes(LINE), 'and the first tooltip still says how to reorder');
        const next = await hover(page, 'notes');
        assert.equal(next[0], '学习笔记', `the next row is named too: ${JSON.stringify(next)}`);
        assert.ok(!next.includes(LINE));
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally {
    await browser.close().catch(() => {});
    await running.close();
    await rm(dist, { recursive: true, force: true });
  }
});
