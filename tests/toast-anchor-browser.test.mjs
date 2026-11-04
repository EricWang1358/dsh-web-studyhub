/* global document, window -- page.evaluate callbacks run in the browser */
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
import { openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { StudyService } from '../lib/service.js';

/* A toast has one anchor: the bottom edge of the visible viewport, however tall the page behind it is (ui/components/components.css, the page rail). It used
   to be a zero-height sticky rail at the END of the page, so on a page with three rows it floated right under the last row, in the middle of the screen (#677).
   Each case imports one file from the 资料 page (the toast says 已导入…) in a library of 3 sources (a short page) and of 80 (a long one), at 1440 and 420 px, and
   measures where the toast's bottom edge stands against the viewport's: the same few pixels in all four, on the first screen and scrolled to the end. */

const body = '进程与线程。'.repeat(40);

async function start(distDir, sources) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-toast-anchor-'));
  const root = join(base, 'library');
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    const at = new Date().toISOString();
    for (let index = 0; index < sources; index += 1) state.sources.push({ id: `s-${index}`, title: `第 ${index + 1} 讲`, text: body, createdAt: at, courses: [] });
  });
  service.dispose?.();
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir });
  return { server, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

/** How far the toast's bottom edge stands above the viewport's bottom edge, and whether the whole toast is inside the viewport. */
const place = page => page.evaluate(() => {
  const box = document.querySelector('.sh-toasts .sh-toast').getBoundingClientRect();
  return { gap: Math.round(window.innerHeight - box.bottom), inside: box.top >= 0 && box.bottom <= window.innerHeight };
});

test('a toast stays at the bottom edge of the viewport, on a page of 3 rows and on a page of 80, at 1440 and 420 px', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-toast-anchor-dist-'));
  await buildPreview({ outdir: dist });
  const gaps = [];
  try {
    for (const sources of [3, 80]) {
      const running = await start(dist, sources);
      try {
        for (const [width, height] of [[1440, 900], [420, 860]]) {
          const { page, context, errors } = await openPage(browser, running, { width, height });
          try {
            await page.goto(running.server.url);
            await page.locator('[data-tour="nav-sources"]').first().waitFor({ timeout: 30000 });
            await page.locator('[data-tour="nav-sources"]').first().dispatchEvent('click');
            await page.locator('.sources-page').waitFor({ timeout: 30000 });
            await page.locator('[data-tour="sources-add"]').first().click();
            const dialog = page.locator('dialog[open], [role="dialog"]').first();
            await dialog.waitFor({ timeout: 30000 });
            await dialog.locator('.sh-drop input[type="file"]').first().setInputFiles({ name: 'toast-anchor.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nProcesses and threads.\n') });
            await until(async () => (await page.locator('dialog[open]').count()) === 0, 'the dialog closed after the import', { timeoutMs: 60000 });
            await page.locator('.sh-toasts .sh-toast').first().waitFor({ timeout: 30000 });
            await settleAnimations(page);
            const first = await place(page);
            assert.ok(first.inside, `${sources} rows at ${width}px: the whole toast is inside the viewport`);
            // Scrolled to the end of the page: still the same anchor.
            await page.evaluate(() => { const root = document.querySelector('.study-app'); root.scrollTop = root.scrollHeight; });
            await page.waitForTimeout(150);
            const last = await place(page);
            assert.equal(last.gap, first.gap, `${sources} rows at ${width}px: scrolling does not move the toast`);
            gaps.push({ sources, width, gap: first.gap });
            assert.deepEqual(errors.filter(error => !/favicon/.test(error)), [], `${sources} rows at ${width}px: no page errors`);
          } finally { await context.close(); }
        }
      } finally { await running.close(); }
    }
    const values = gaps.map(item => item.gap);
    assert.ok(Math.min(...values) >= 0 && Math.max(...values) <= 40, `the toast hugs the bottom edge: ${JSON.stringify(gaps)}`);
    assert.ok(Math.max(...values) - Math.min(...values) <= 2, `the same anchor whatever the page height: ${JSON.stringify(gaps)}`);
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});
