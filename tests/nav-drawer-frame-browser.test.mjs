/* global document, localStorage, getComputedStyle -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { startNavServer } from '../scripts/qa/nav-layout.mjs';
import { frameOf } from '../ui/app/use-drawer-frame.js';

/* The navigation drawer opens inside StudyHub's own page, never along the edge of the whole host window (owner, 2026-11-05: inside DSH it
   covered DSH's own sidebar), and the sidebar is docked by default: the old 'study-sidebar' = 'collapsed' of the icon rail no longer puts it away.
   The host is imitated by pushing the app 300 px to the right inside a wider window. Needs a Chromium; without one the test says so. */

test('frameOf: the root box as the four --nav-frame-* properties', () => {
  assert.deepEqual(frameOf({ left: 300, top: 40, width: 500, height: 760 }),
    { '--nav-frame-left': '300px', '--nav-frame-top': '40px', '--nav-frame-width': '500px', '--nav-frame-height': '760px' });
});

test('the drawer opens inside the app, not at the host window edge; the sidebar is docked by default', { timeout: 240000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-drawer-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startNavServer({ distDir: dist });
  try {
    // A learner of the icon-rail version: 'study-sidebar' = 'collapsed' is left over. Wide workspace: the sidebar is docked anyway.
    const wide = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wide.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-sidebar', 'collapsed'); } catch { /* blocked */ } });
    const page = await wide.newPage();
    await page.goto(running.server.url);
    await page.locator('.sidebar').first().waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.nav-menu-toggle').count(), 0, 'docked: no menu button');
    assert.equal(await page.locator('aside.sidebar').count(), 1, 'the sidebar is the docked column');
    // 回到题目 and its count on one line at the compact width (1050 and below).
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(300);
    const resume = await page.evaluate(() => {
      const label = document.querySelector('aside.sidebar .nav .nav-label');
      return label ? Math.round(label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight)) : null;
    });
    assert.equal(resume, 1, 'the first row label is one line');
    await wide.close();

    // A narrow workspace placed 300 px from the window's left edge, as inside a host: the drawer opens at the app's edge.
    const narrow = await browser.newContext({ viewport: { width: 900, height: 800 } });
    await narrow.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); } catch { /* blocked */ } });
    const host = await narrow.newPage();
    await host.goto(running.server.url);
    await host.addStyleTag({ content: '.study-app { position: fixed !important; left: 300px !important; top: 40px !important; width: 500px !important; height: 720px !important; }' });
    await host.locator('.nav-menu-toggle').first().waitFor({ timeout: 30000 });
    await host.locator('.nav-menu-toggle').first().click();
    await host.locator('.nav-drawer[open]').waitFor();
    await host.waitForTimeout(400);
    const box = await host.evaluate(() => {
      const rect = document.querySelector('.nav-drawer[open]').getBoundingClientRect(), app = document.querySelector('.study-app').getBoundingClientRect();
      return { left: rect.left, top: rect.top, bottom: rect.bottom, appLeft: app.left, appTop: app.top, appBottom: app.bottom };
    });
    assert.ok(Math.abs(box.left - box.appLeft) <= 2, `the drawer starts at the app's left edge, not the window's (${JSON.stringify(box)})`);
    assert.ok(Math.abs(box.top - box.appTop) <= 2 && Math.abs(box.bottom - box.appBottom) <= 2, `the drawer is as tall as the app (${JSON.stringify(box)})`);
    await host.keyboard.press('Escape');
    await host.locator('.nav-drawer[open]').waitFor({ state: 'detached' });
    assert.equal(await host.evaluate(() => document.querySelector('.study-app').style.getPropertyValue('--nav-frame-left')), '', 'the frame is cleared on close');
    await narrow.close();
  } finally {
    await running.close?.();
    await browser.close();
    await rm(dist, { recursive: true, force: true });
  }
});
