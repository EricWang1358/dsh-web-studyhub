/* global localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { makeTextPdf } from './helpers/text-pdf.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { chooseMore } from './helpers/reader-more.mjs';

/* 看原页 and 原始 PDF for a referenced original over the 40 MB copy limit, in the browser at 1280 and 420: the page is drawn from just that page (materials.document.pages), the
   file is never sent (no answer to the page is anywhere near its size), and turning the page asks for the next one. Screenshots go to STUDY_QA_SHOTS when it is set. */

const MB = 1024 * 1024;
const PAGES = 45;
const lines = number => [`Chapter page ${number} of the big book`, `Figure ${number} is drawn on this page.`];

test('a page of a referenced original over 40 MB is drawn from that page alone (看原页 and 原始 PDF)', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip('no Chromium to check the view with: ' + String(error.message).split('\n')[0]); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-bigpage-dist-'));
  await buildPreview({ outdir: dist });
  let fileSize = 0;
  const running = await startLateServer({ distDir: dist, seed: async (root) => {
    const runtime = createStudyRuntime(root);
    const files = join(root, '..', 'files');
    await mkdir(files, { recursive: true });
    const pages = Array.from({ length: PAGES }, (_, index) => lines(index + 1));
    // The converted book (its text only), and its original: the same pages with a megabyte of picture data hidden in each, so the file is over the copy limit.
    const text = await makeTextPdf(pages);
    const book = await runtime.call('materials.document.import', { filename: 'Atlas of Systems.pdf', dataBase64: text.toString('base64'), courses: ['QA'] });
    await runtime.call('materials.original.detach', { documentId: book.documentId });
    const big = await makeTextPdf(pages, { padBytes: MB });
    fileSize = big.length;
    const own = join(files, 'Atlas of Systems.pdf');
    await writeFile(own, big);
    await runtime.call('materials.original.attach', { documentId: book.documentId, mode: 'reference', path: own, confirm: true });
    runtime.dispose();
  } });
  assert.ok(fileSize > 40 * MB, `the original is over the copy limit (${fileSize})`);
  const shots = process.env.STUDY_QA_SHOTS || '';
  if (shots) await mkdir(shots, { recursive: true });
  try {
    const { context, page, errors } = await openPage(browser, running, { width: 1280, height: 900 });
    const sizes = [], pending = [];
    page.on('response', response => { if (response.request().method() === 'POST') pending.push(response.body().then(body => sizes.push(body.length), () => {})); });
    const open = async () => {
      await page.goto(running.server.url);
      await page.evaluate(() => localStorage.removeItem('studyhub-last-read:v1')); // each open starts fresh: a material reopens in the view and page it was left at (#1001)
      await (await revealNavRow(page, 'sources')).click().catch(() => {});
      await page.locator('.source-doc', { hasText: 'Atlas of Systems' }).first().locator('.source-main').click();
      await page.locator('.study-document-viewer').waitFor({ timeout: 30000 });
    };
    for (const width of [1280, 420]) {
      await page.setViewportSize({ width, height: 900 });
      await open();
      // 看原页 in the reading view: page 1 of the reading view is drawn from the host's one page.
      await page.locator('.study-document-viewer .reader-peek').first().click();
      const canvas = page.locator('.page-peek canvas');
      await canvas.waitFor({ timeout: 60000 });
      await until(() => canvas.evaluate(element => element.width > 0 && element.height > 0), 'page 1 to be drawn in 看原页');
      await until(async () => !(await page.locator('.page-peek').innerText()).includes('正在绘制'), 'page 1 to be finished');
      assert.equal(await page.locator('.page-peek .page-peek__state--note').count(), 0, 'no "original not found" note');
      if (shots) await page.screenshot({ path: join(shots, `original-bigpage-peek-${width}.png`) });
      await page.keyboard.press('Escape');
      // 原始 PDF: the page in place, with its words; the next page is the next request.
      await chooseMore(page, '原始 PDF');
      const view = page.locator('.reader-pdf-view');
      await view.waitFor({ timeout: 60000 });
      await until(async () => /Chapter page 1 of the big book/.test(await view.locator('.reader-pdf-text').innerText().catch(() => '')), 'page 1 and its words');
      await page.getByRole('button', { name: '下一页' }).first().click();
      await until(async () => /Chapter page 2 of the big book/.test(await view.locator('.reader-pdf-text').innerText().catch(() => '')), 'page 2 and its words');
      assert.equal(await page.locator('.reader-original iframe').count(), 0, 'no browser viewer: there is no file for it');
      if (shots) await page.screenshot({ path: join(shots, `original-bigpage-pdf-${width}.png`) });
    }
    await Promise.all(pending);
    assert.ok(Math.max(...sizes) < 6 * MB, `no answer is anywhere near the ${Math.round(fileSize / MB)} MB file (largest ${Math.max(...sizes)} bytes)`);
    assert.deepEqual(errors.filter(text => !/favicon/.test(text)), [], 'no page errors');
    await context.close();
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
