/* global localStorage, getComputedStyle, document */
// The 资料 page measures its own column, not the window (#1083): a half-screen window with the sidebar docked gets the narrow rows and the one 更多,
// and typing in 筛选资料 moves neither control (#1085).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

test('资料 at a docked half-screen width uses the narrow rows, and the filter keeps both controls still while typing', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sources-narrow-'));
  const service = new StudyService(join(root, 'library'));
  const stamp = new Date().toISOString();
  await service.store.update(s => {
    s.sources.push(
      { id: 's-1', title: 'Kernel Notes', text: 'Kernel evidence', createdAt: stamp, courses: ['OS'] },
      { id: 's-2', title: 'Virtual Memory', text: 'Paging evidence', createdAt: stamp, courses: ['OS'] },
    );
  });
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await service.dispose(); await rm(root, { recursive: true, force: true }); });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }

  const open = async width => {
    const page = await browser.newPage({ viewport: { width, height: 860 } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'en'); localStorage.setItem('study-autopilot', 'off'); });
    await page.goto(server.url);
    const toggle = page.locator('.nav-menu-toggle').first();
    if (await toggle.isVisible().catch(() => false)) await toggle.click();
    await page.locator('[data-tour="nav-sources"]').first().click();
    await page.locator('.source-doc').first().waitFor();
    return { page, errors };
  };
  const look = page => page.evaluate(() => {
    // Positions inside the page: the app above it (top bar, notices) may still settle, which is not the filter's doing.
    const sources = document.querySelector('.sources-page'), origin = sources.getBoundingClientRect();
    const box = el => { const r = el.getBoundingClientRect(); return [r.left - origin.left, r.right - origin.left, r.top - origin.top]; };
    const style = getComputedStyle(sources);
    return {
      column: sources.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      archiveButton: document.querySelectorAll('[data-archive-toggle]').length,
      narrowClass: sources.classList.contains('is-narrow'),
      statusSlots: document.querySelectorAll('.source-doc__status .source-doc__index').length,
      actionsOpacity: getComputedStyle(document.querySelector('.source-doc__actions')).opacity,
      select: box(document.querySelector('.page-scope__select')),
      filter: box(document.querySelector('.sources-filter__input')),
    };
  });

  // 720 and 880–930 are the docked half-screen band where a row used to keep a blank badge slot and typing used to narrow both controls; 1000 and 1280 are wide.
  const still = (now, was, what) => assert.ok(now.every((edge, i) => Math.abs(edge - was[i]) < 1), `${what}: ${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
  for (const width of [720, 880, 930, 1000, 1280]) {
    const { page, errors } = await open(width);
    const before = await look(page);
    const narrow = before.column < 681;
    assert.equal(before.narrowClass, narrow, `${width}: the page is narrow exactly when its column is under 681px (${before.column}px)`);
    assert.equal(before.archiveButton, narrow ? 0 : 1, `${width}: 已归档 is a button only in a wide header`);
    assert.equal(before.statusSlots, narrow ? 0 : before.statusSlots, `${width}: a narrow row keeps no badge slot in its status line`);
    if (narrow) assert.equal(before.actionsOpacity, '1', `${width}: the row actions sit on their own line, always shown`);
    await page.locator('.sources-filter__input').fill('kernel');
    await page.locator('.sources-filter__state').waitFor();
    const typing = await look(page);
    // Within a pixel: the edges are fractional, and a moved or narrowed control (the old fault) was off by tens of pixels.
    still(typing.select, before.select, `${width}: the scope select does not move or shrink while typing`);
    still(typing.filter, before.filter, `${width}: nor does the filter`);
    assert.deepEqual(errors, []);
    await page.close();
  }
});
