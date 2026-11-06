/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { makeTextPdf, LECTURE_PAGES } from './helpers/text-pdf.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* 补全原文件 for a very big file, in the browser at 1280 and 420: a file over the copy limit that is dropped or chosen is not read or sent; the dialog says so in one
   sentence and the keyboard is already in the path field. A document whose original is a reference opens in 原始 PDF. Screenshots go to STUDY_QA_SHOTS when it is set. */

test('a file over the copy limit sends the learner to the path field instead of being copied', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip('no Chromium to check the view with: ' + String(error.message).split('\n')[0]); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-original-path-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: async (root) => {
    const runtime = createStudyRuntime(root);
    const files = join(root, '..', 'files');
    await mkdir(files, { recursive: true });
    const bytes = await makeTextPdf(LECTURE_PAGES);
    // A converted book: its text only.
    const book = await runtime.call('materials.document.import', { filename: 'Software Engineering.pdf', dataBase64: bytes.toString('base64'), courses: ['QA'] });
    await runtime.call('materials.original.detach', { documentId: book.documentId });
    // A lecture whose original is a reference to the learner's own file.
    const lectureBytes = await makeTextPdf(LECTURE_PAGES.slice(0, 2));
    const lecture = await runtime.call('materials.document.import', { filename: 'Lecture.pdf', dataBase64: lectureBytes.toString('base64'), courses: ['QA'] });
    await runtime.call('materials.original.detach', { documentId: lecture.documentId });
    const own = join(files, 'Lecture.pdf');
    await writeFile(own, lectureBytes);
    await runtime.call('materials.original.attach', { documentId: lecture.documentId, mode: 'reference', path: own });
    runtime.dispose();
  } });
  const shots = process.env.STUDY_QA_SHOTS || '';
  if (shots) await mkdir(shots, { recursive: true });
  try {
    const { context, page, errors } = await openPage(browser, running, { width: 1280, height: 900 });
    const probes = [];
    page.on('request', request => { const body = request.postData() || ''; if (/materials\.original\.(probe|attach)/.test(body)) probes.push(body.slice(0, 80)); });
    const open = async name => {
      await page.goto(running.server.url);
      await (await revealNavRow(page, 'sources')).click().catch(() => {});
      await page.locator('.source-doc', { hasText: name }).first().locator('.source-main').click();
      await page.locator('.study-document-viewer').waitFor({ timeout: 30000 });
    };
    for (const width of [1280, 420]) {
      await page.setViewportSize({ width, height: 900 });
      await open('Software Engineering');
      await page.locator('.study-document-viewer .sh-seg__item', { hasText: '原始 PDF' }).click();
      const dialog = page.locator('dialog[open].original-dialog');
      await dialog.waitFor();
      await dialog.locator('.original-pathrow__input').waitFor();
      probes.length = 0;
      // 45 MB: over the copy limit of 40 MB. Only its name and size reach the page's logic; nothing is read into base64.
      await dialog.locator('input[type=file]').setInputFiles({ name: 'Software Engineering.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(45 * 1024 * 1024, 0x25) });
      const warning = dialog.locator('.original-status[role="alert"]');
      await warning.waitFor();
      assert.match(await warning.innerText(), /浏览器没法复制这么大的文件/);
      assert.match(await warning.innerText(), /45 MB/);
      await until(() => page.evaluate(() => document.activeElement?.classList.contains('original-pathrow__input')), 'the path field to have the focus');
      assert.deepEqual(probes, [], 'the big file was neither probed nor sent');
      assert.equal(await dialog.locator('.original-status[role="alert"] [title]').count(), 0, 'no title attribute carries the long explanation');
      // the long reason is in the hover card
      await warning.locator('span[tabindex="0"]').hover();
      await until(async () => /要先整个复制一遍/.test(await page.locator('body').innerText()), 'the hover card to show the reason');
      if (shots) await page.screenshot({ path: join(shots, `original-too-big-${width}.png`) });
      await dialog.getByRole('button', { name: '取消' }).click();
      await page.keyboard.press('Escape');
    }
    for (const width of [1280, 420]) {
      await page.setViewportSize({ width, height: 900 });
      await open('Lecture');
      await page.locator('.study-document-viewer .sh-seg__item', { hasText: '原始 PDF' }).click();
      await page.locator('.reader-scroll[data-mode="original"]').waitFor({ timeout: 30000 });
      await page.locator('.reader-pdf-view').waitFor({ timeout: 30000 });
      if (shots) await page.screenshot({ path: join(shots, `original-reader-${width}.png`) });
    }
    assert.deepEqual(errors.filter(text => !/favicon/.test(text)), [], 'no page errors');
    await context.close();
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
