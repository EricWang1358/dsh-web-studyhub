/* global document, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { frames, openPage, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { makeTextPdf } from './helpers/text-pdf.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { Store } from '../lib/store.js';
import { PAGE_EVIDENCE_MAX } from '../lib/ask-prompt.js';

/* #488 in the browser, at 1440 and 420: 连问后面几页 names the range and sends both ends, a page turn ends it, the limit is said; on a long page 接着读后面 asks the same
   question about the next part only. What travels to the model is asserted in tests/materials-ask-shape.test.mjs; here the panel and its requests. */

const PAGES = [1, 2, 3, 4, 5, 6, 7].map(page => [`Page ${page} explains part ${page} of the lecture.`]);

test('原始 PDF: a range and 接着读 in the panel, at 1440 and 420 (#488)', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip('no Chromium to check the panel with: ' + String(error.message).split('\n')[0]); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-range-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: async (root) => {
    const runtime = createStudyRuntime(root);
    const pdf = await runtime.call('materials.document.import', { filename: 'Lecture.pdf', dataBase64: (await makeTextPdf(PAGES)).toString('base64'), courses: ['QA'] });
    runtime.dispose();
    await new Store(root).update((state) => {
      state.sources.find(source => source.id === pdf.sourceIds[1]).text = 'long page. '.repeat(1500);
      state.sources.find(source => source.id === pdf.sourceIds[3]).text = '';
    });
  } });
  const shots = process.env.STUDY_QA_SHOTS || '';
  if (shots) await mkdir(shots, { recursive: true });
  try {
    const { context, page } = await openPage(browser, running, { width: 1440, height: 900 });
    const pageErrors = [], asked = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.route('**/api/call', async (route) => {
      try { const body = JSON.parse(route.request().postData() || '{}'); if (body.action === 'materials.selection.ask') asked.push(body.args); } catch { /* not JSON */ }
      return route.continue();
    });
    const panel = page.locator('.study-page-ask'), scopeLine = () => panel.locator('.study-page-ask__scope strong').innerText();
    const shot = async name => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
    const answers = () => panel.locator('[data-ask-node][data-status="answered"]').count();
    const waitAnswers = count => until(async () => (await answers()) >= count, `${count} answers`);
    for (const width of [1440, 420]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(running.server.url);
      await page.locator('[data-tour="nav-sources"]').first().click().catch(() => {});
      await page.locator('.source-doc').first().locator('.source-main').click();
      await page.locator('.study-document-viewer').waitFor({ timeout: 30000 });
      await page.locator('.study-document-viewer .sh-seg__item', { hasText: '原始 PDF' }).click();
      await page.locator('.reader-scroll[data-mode="original"]').waitFor({ timeout: 30000 });
      if (!(await page.locator('[data-tour="source-tools"]').isVisible().catch(() => false))) await page.locator('[data-tour="source-tools-toggle"]').click();
      await panel.waitFor({ timeout: 30000 });
      await until(() => panel.getByRole('button', { name: '讲解这一页' }).isEnabled(), 'the model to be ready');
      asked.length = 0;
      assert.equal(await scopeLine(), '正在问：第 1 页');
      await shot(`${width}-one-page`);

      // A range, typed once. Over the limit it is held and said; the page without text is named; the presets say these pages.
      await panel.getByRole('button', { name: '连问后面几页' }).click();
      const box = panel.getByRole('spinbutton', { name: '问到第几页' });
      await box.fill('99');
      await box.press('Enter');
      await until(async () => (await scopeLine()) === '正在问：第 1–5 页', 'the range to be held to five pages');
      assert.match(await panel.innerText(), /一次最多问 5 页，已改成第 1–5 页。/);
      await panel.getByRole('spinbutton', { name: '问到第几页' }).fill('4');
      await panel.getByRole('spinbutton', { name: '问到第几页' }).press('Enter');
      await until(async () => (await scopeLine()) === '正在问：第 1–4 页', 'the range to change');
      const said = await panel.innerText();
      assert.match(said, /第 4 页没有保存文字，模型读不到。/);
      assert.doesNotMatch(said, /一次最多问/, 'the limit note leaves with what caused it');
      assert.match(said, /一次回答最多读 16000 字/);
      await shot(`${width}-range`);
      await panel.getByRole('button', { name: '讲解这几页' }).click();
      await waitAnswers(1);
      assert.equal(asked.at(-1).selection.page, 1);
      assert.equal(asked.at(-1).selection.to, 4);
      assert.equal(asked.at(-1).intent, 'explain');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}: no page overflow with a range`);

      // Turning the page ends the range.
      await panel.locator('.study-page-ask__step').getByRole('button', { name: '下一页' }).click();
      await until(async () => (await scopeLine()) === '正在问：第 2 页', 'the page to turn');
      assert.equal(await panel.getByRole('spinbutton', { name: '问到第几页' }).count(), 0, 'one page again, and the box is put away');

      // The long page: the same question goes on from where it stopped, one press at a time; 重试-free path.
      await panel.getByRole('button', { name: '翻译这一页' }).click();
      const on = panel.locator('.study-page-ask__cut button');
      await on.waitFor({ timeout: 60000 });
      assert.match(await panel.locator('.study-page-ask__cut').innerText(), new RegExp(`回答只读了前 ${PAGE_EVIDENCE_MAX} 字（共 16500 字）`));
      assert.match(await on.innerText(), /接着读后面 8000 字/);
      await shot(`${width}-cut`);
      const first = asked.at(-1);
      assert.equal(first.offset, undefined);
      await on.click();
      await until(() => asked.at(-1).offset === PAGE_EVIDENCE_MAX, 'the next part to be asked');
      assert.equal(asked.at(-1).question, first.question, 'the same question');
      assert.equal(asked.at(-1).intent, 'translate');
      await until(async () => /这次读到第 16000 字（共 16500 字）/.test(await panel.innerText()), 'the panel to say where it stands');
      assert.match(await on.innerText(), /接着读后面 500 字/);
      await on.click();
      await until(() => asked.at(-1).offset === 2 * PAGE_EVIDENCE_MAX, 'the last part to be asked');
      await until(async () => (await panel.locator('.study-page-ask__cut').count()) === 0, 'the note to leave when nothing is left');
      assert.match(await panel.locator('.ask-thread').innerText(), /接着读第 16001–16500 字/, 'the answer is named after its part');
      await shot(`${width}-read-on`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${width}: no page overflow on the long page`);
      await frames(page, 2);
    }
    assert.deepEqual(pageErrors, []);
    await context.close();
  } finally {
    await browser.close();
    await running.close?.();
    await rm(dist, { recursive: true, force: true }).catch(() => {});
  }
});
