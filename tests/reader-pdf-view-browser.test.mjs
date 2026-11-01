/* global document, window, getSelection */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { makeTextPdf } from './helpers/text-pdf.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';

/* #488, item 3, in the browser at 1440 and 420: a page turn in 原始 PDF changes the page in place. The same view stays (no new frame, no reload of the file), the zoom and
   the sideways place stay, the page shown is the page asked about, its text can be selected and copied. The browser's viewer stays one press away, and it is what a
   file that cannot be drawn here falls back to. */

// The most a PDF may have on import.
const PAGES = Array.from({ length: 200 }, (_, index) => [`Page ${index + 1} explains part ${index + 1} of the lecture in plain words.`]);

test('原始 PDF: turning the page keeps the view, the zoom and the sideways place; the viewer is one press away (#488)', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip('no Chromium to check the view with: ' + String(error.message).split('\n')[0]); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-pdf-view-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: async (root) => {
    const runtime = createStudyRuntime(root);
    const bytes = await makeTextPdf(PAGES);
    await runtime.call('materials.document.import', { filename: 'Lecture.pdf', dataBase64: bytes.toString('base64'), courses: ['QA'] });
    runtime.dispose();
  } });
  const shots = process.env.STUDY_QA_SHOTS || '';
  if (shots) await mkdir(shots, { recursive: true });
  try {
    const { context, page } = await openPage(browser, running, { width: 1440, height: 900 });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    const view = page.locator('.reader-pdf-view'), bar = page.locator('.reader-pdf-bar');
    const open = async (name) => {
      await page.goto(running.server.url);
      await page.locator('[data-tour="nav-sources"]').first().click().catch(() => {});
      await page.locator('.source-doc', { hasText: name }).first().locator('.source-main').click();
      await page.locator('.study-document-viewer').waitFor({ timeout: 30000 });
      await page.locator('.study-document-viewer .sh-seg__item', { hasText: '原始 PDF' }).click();
      await page.locator('.reader-scroll[data-mode="original"]').waitFor({ timeout: 30000 });
    };
    const shownPage = () => view.getAttribute('data-pdf-page');
    const textShown = () => view.locator('.reader-pdf-text').innerText();
    for (const width of [1440, 420]) {
      await page.setViewportSize({ width, height: 900 });
      await open('Lecture');
      await until(async () => /Page 1 explains/.test(await textShown().catch(() => '')), 'page 1 to be drawn with its text');
      assert.equal(await page.locator('.reader-original iframe').count(), 0, 'no frame: nothing reloads');
      await page.evaluate(() => { document.querySelector('.reader-pdf-view').dataset.qaSame = '1'; });

      // Zoom in and scroll sideways; the next page keeps both, and the view is the same element.
      await bar.getByRole('button', { name: '放大' }).click();
      await bar.getByRole('button', { name: '放大' }).click();
      assert.equal(await bar.locator('.reader-pdf-bar__zoom').innerText(), '200%');
      const wide = () => view.evaluate(element => element.querySelector('canvas').getBoundingClientRect().width);
      await until(async () => (await wide()) > (await view.evaluate(element => element.clientWidth)) * 1.5, 'the page to grow');
      await view.evaluate((element) => { element.scrollLeft = 120; element.scrollTop = 200; });
      const before = await wide();
      await bar.getByRole('button', { name: '下一页' }).click();
      await until(async () => (await shownPage()) === '2' && /Page 2 explains/.test(await textShown()), 'page 2 to be drawn in place');
      assert.equal(await view.getAttribute('data-qa-same'), '1', 'the same view, not a new one');
      assert.equal(await bar.locator('.reader-pdf-bar__zoom').innerText(), '200%', 'the zoom stays');
      assert.equal(Math.round(await wide()), Math.round(before), 'the drawn size stays');
      const place = await view.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop }));
      assert.equal(place.left, 120, 'the sideways place stays');
      assert.equal(place.top, 0, 'a new page starts at its top');
      if (shots) await page.screenshot({ path: join(shots, `${width}-zoomed.png`) });

      // A far page of a long file comes without reading the file again: time it.
      const box = bar.getByRole('spinbutton', { name: '页码' });
      const started = Date.now();
      await box.fill("180");
      await box.press('Enter');
      await until(async () => (await shownPage()) === "180" && /Page 180 explains/.test(await textShown()), 'page 180');
      t.diagnostic(`${width}px: a jump to page 180 of 200 drew in ${Date.now() - started} ms`);
      assert.equal(await view.getAttribute('data-qa-same'), '1');

      // The text can be selected and copied, for the question box.
      const selected = await view.evaluate((element) => {
        const range = document.createRange(); range.selectNodeContents(element.querySelector('.reader-pdf-text'));
        getSelection().removeAllRanges(); getSelection().addRange(range);
        return getSelection().toString();
      });
      assert.match(selected, /Page 180 explains part 180/);
      await page.evaluate(() => getSelection().removeAllRanges());

      // Back to fit, and PageDown turns the page from the view.
      await bar.getByRole('button', { name: '适合宽度' }).click();
      assert.equal(await bar.locator('.reader-pdf-bar__zoom').innerText(), '100%');
      await view.focus();
      await page.keyboard.press('PageDown');
      await until(async () => (await shownPage()) === "181", 'PageDown to turn the page');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}: no page overflow`);
      if (shots) await page.screenshot({ path: join(shots, `${width}-fit.png`) });

      // The zoom comes back with the view after a visit to 阅读.
      await bar.getByRole('button', { name: '放大' }).click();
      await page.locator('.study-document-viewer .sh-seg__item', { hasText: '阅读' }).click();
      await bar.waitFor({ state: 'detached', timeout: 10000 });
      await page.locator('.study-document-viewer .sh-seg__item', { hasText: '原始 PDF' }).click();
      await view.waitFor({ timeout: 30000 });
      assert.equal(await bar.locator('.reader-pdf-bar__zoom').innerText(), '150%');
      assert.equal(await shownPage(), "181");

      // The browser's viewer, one press away and at the same page; and back.
      await bar.getByRole('button', { name: '用浏览器的查看器' }).click();
      await page.locator('.reader-original iframe').waitFor({ timeout: 10000 });
      assert.match(await page.locator('.reader-original iframe').getAttribute('src'), /#page=181$/);
      assert.equal(await bar.locator('.reader-pdf-bar__zoom').count(), 0, 'its own zoom is the viewer\'s');
      await bar.getByRole('button', { name: '回到单页视图' }).click();
      await view.waitFor({ timeout: 10000 });
    }
    // A file this view cannot read or draw is not guessed at: the browser's viewer, and it says why (a page count that disagrees: tests/reader-page-image.test.mjs, pdfPageFor).
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => { const real = window.fetch; window.fetch = (url, ...rest) => (String(url).startsWith('blob:') ? Promise.reject(new Error('refused')) : real(url, ...rest)); });
    await open('Lecture');
    await page.locator('.reader-original iframe').waitFor({ timeout: 30000 });
    assert.match(await page.locator('.reader-original').innerText(), /这份文件在这里画不出来，已换成浏览器的查看器。/);
    assert.equal(await bar.getByRole('button', { name: '回到单页视图' }).count(), 0, 'no way back to a view that cannot draw it');
    assert.deepEqual(pageErrors, []);
    await context.close();
  } finally {
    await browser.close();
    await running.close?.();
    await rm(dist, { recursive: true, force: true }).catch(() => {});
  }
});
