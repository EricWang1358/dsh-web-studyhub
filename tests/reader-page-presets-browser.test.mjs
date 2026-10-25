/* global document, getComputedStyle, localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { frames, openPage, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { makeTextPdf, LECTURE_PAGES } from './helpers/text-pdf.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';

/* #485 in the browser: a preset of the learner's own in the 原始 PDF panel — added, asking with its exact words, kept across a reload,
   wrapping in the two-column row at 420 px, and gone at once when deleted. The wording of the four built-ins is asserted in
   tests/reader-page-presets.test.mjs; here the row itself is measured. */

const NAME = '三句话总结';
const PROMPT = '用三句话总结这一页，先说结论。';

test('原始 PDF: a preset of one\'s own is added, asks with its exact words, survives a reload and is deleted at once, at 1440 and 420 (#485)', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip('no Chromium to check the panel with: ' + String(error.message).split('\n')[0]); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-presets-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: async (root) => {
    const runtime = createStudyRuntime(root);
    const pdf = await makeTextPdf(LECTURE_PAGES);
    await runtime.call('materials.document.import', { filename: 'Database indexes.pdf', dataBase64: pdf.toString('base64'), courses: ['QA'] });
    runtime.dispose();
  } });
  try {
    const { context, page, errors } = await openPage(browser, running, { width: 1440, height: 900 });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    /** Open the imported PDF in 原始 PDF with its learning panel (the panel the presets sit in). */
    const openOriginal = async () => {
      await page.locator('[data-tour="nav-sources"]').first().click().catch(() => {});
      await page.locator('.source-doc').first().locator('.source-main').click();
      await page.locator('.study-document-viewer').waitFor({ timeout: 30000 });
      await page.locator('.study-document-viewer .sh-seg__item', { hasText: '原始 PDF' }).click();
      await page.locator('.reader-scroll[data-mode="original"]').waitFor({ timeout: 30000 });
      if (!(await page.locator('[data-tour="source-tools"]').isVisible().catch(() => false)))
        await page.locator('[data-tour="source-tools-toggle"]').click();
      await page.locator('.study-page-ask').waitFor({ timeout: 30000 });
    };
    const chip = label => page.locator('.study-page-ask .ask-quick button', { hasText: label });
    try {
      await page.goto(running.server.url);
      await openOriginal();
      assert.equal(await page.locator('.study-page-ask .ask-quick button').count(), 5, 'four built-ins and the way to manage them');

      // Add a preset of one's own through the entry at the end of the row.
      await chip('自定义预设…').click();
      const dialog = page.getByRole('dialog', { name: '按页提问的预设' });
      await dialog.waitFor({ timeout: 15000 });
      await dialog.getByRole('button', { name: '添加预设', exact: true }).click();
      await dialog.getByLabel('名称').fill(NAME);
      await dialog.getByLabel('提示词').fill(PROMPT);
      await dialog.locator('form button[type="submit"]').click();
      await dialog.getByRole('button', { name: '完成', exact: true }).click();
      await dialog.waitFor({ state: 'detached' });
      await chip(NAME).waitFor({ timeout: 15000 });
      assert.equal(await page.locator('.study-page-ask .ask-quick button').count(), 6, 'the preset of one\'s own joins the four built-ins');

      // A click asks at once, with the prompt exactly as written.
      const asked = [];
      await page.route('**/api/call', async (route) => {
        try { const body = JSON.parse(route.request().postData() || '{}'); if (body.action === 'materials.selection.ask') asked.push(body.args); } catch { /* not JSON */ }
        return route.continue();
      });
      await chip(NAME).click();
      const sent = await until(() => asked[0], 'the ask request of the preset');
      assert.equal(sent.question, PROMPT, 'the prompt goes out exactly as written');
      assert.equal(sent.scope, 'page', 'it is still a question about the page');
      assert.ok(!sent.intent, 'a preset of one\'s own carries no built-in instruction');
      await until(() => chip(NAME).isEnabled(), 'the answer to arrive');
      assert.match(await page.locator('.study-page-ask .ask-thread').innerText(), new RegExp(NAME), 'the thread keeps the name of the preset');

      // Kept in this browser: a reload finds it again.
      await page.reload();
      await openOriginal();
      await chip(NAME).waitFor({ timeout: 20000 });

      // 420 px: the two-column row still holds, and the presets wrap onto new rows without overflow.
      await page.setViewportSize({ width: 420, height: 900 });
      await until(() => page.evaluate(() => getComputedStyle(document.querySelector('.reader-tools')).position === 'absolute'), 'the narrow reader layout');
      await frames(page, 3);
      assert.equal(await page.locator('[data-tour="source-tools"]').isVisible(), false, 'a narrow reader keeps the panel closed until it is asked for');
      await page.locator('[data-tour="source-tools-toggle"]').click();
      await page.locator('.study-page-ask').waitFor({ timeout: 20000 });
      await chip(NAME).waitFor();
      const row = await page.evaluate(() => {
        const grid = document.querySelector('.study-page-ask .ask-quick'), panel = document.querySelector('.study-page-ask');
        const box = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, width: rect.width }; };
        return { panel: box(panel), grid: box(grid), chips: [...grid.querySelectorAll('.sh-btn')].map(box) };
      });
      assert.equal(row.chips.length, 6, 'every preset is in the row');
      assert.ok(row.grid.left >= row.panel.left - 1 && row.grid.right <= row.panel.right + 1, 'the row itself stays inside the panel at 420 px');
      assert.ok(Math.abs(row.chips[0].top - row.chips[1].top) < 1 && row.chips[1].left >= row.chips[0].right - 1, 'the first two presets share a row');
      assert.ok(Math.abs(row.chips[0].width - row.chips[1].width) < 1, 'two even columns');
      assert.ok(row.chips.every(chipBox => chipBox.left >= row.panel.left - 1 && chipBox.right <= row.panel.right + 1), 'every preset stays inside the panel');
      assert.ok(row.chips[4].top > row.chips[2].top, 'the presets wrap onto new rows');

      // Deleted at once, from this browser too.
      await chip('自定义预设…').click();
      const again = page.getByRole('dialog', { name: '按页提问的预设' });
      await again.waitFor({ timeout: 15000 });
      await again.getByRole('button', { name: '删除「' + NAME + '」', exact: true }).click();
      await again.getByRole('button', { name: '完成', exact: true }).click();
      await chip(NAME).waitFor({ state: 'detached', timeout: 15000 });
      const stored = await page.evaluate(() => localStorage.getItem('study-reader-page-presets'));
      assert.doesNotMatch(String(stored), new RegExp(NAME), 'deleted from this browser as well');
      assert.deepEqual(pageErrors, [], 'no page errors');
      assert.deepEqual(errors.filter(error => !/PDF|pdf|blob:/i.test(error)), [], 'no console errors beyond the headless PDF frame');
    } finally { await context.close(); }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});