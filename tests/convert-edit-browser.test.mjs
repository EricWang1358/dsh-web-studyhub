/* global document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, settleAnimations, frames, until } from '../scripts/qa/layout-late.mjs';
import { startConsole } from '../scripts/qa/task-console.mjs';
import { StudyService } from '../lib/service.js';
import { makePdf } from './helpers/pdf.mjs';

/* 导入前先让我改 in a real browser, at 1280 and 420 px: a real service with the stand-in Marker converts a book and stops before the import; the preview app shows that job (its snapshot
   answer carries it) and sends the edit calls to the same service. The card says it waits, 修改并导入 opens the editor, a removed block is counted in characters and tokens, and 导入 puts
   the edited text in the library. CONVERT_EDIT_SHOTS=<folder> keeps the screenshots. */

const fake = fileURLToPath(new URL('./helpers/fake-marker-cli.mjs', import.meta.url));

async function realService(t) {
  const folder = await mkdtemp(join(tmpdir(), 'convert-edit-browser-')), statePath = join(folder, 'state.json'), log = join(folder, 'log.jsonl');
  await writeFile(statePath, '{}'); await writeFile(log, '');
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = join(folder, 'home');
  const service = new StudyService(join(folder, 'library'), { marker: { limits: { windowPages: 3 }, local: { cli: { file: process.execPath, prefix: [fake], env: { FAKE_MARKER_STATE: statePath, FAKE_MARKER_LOG: log } } } } });
  t.after(async () => { service.dispose(); if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before; await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return service;
}

async function convert(service, name, pages) {
  const bytes = await makePdf({ pages, title: name });
  const { uploadId, chunkBytes } = await service.call('mineru.upload.start', { name, size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) await service.call('mineru.upload.chunk', { uploadId, offset, data: bytes.subarray(offset, offset + chunkBytes).toString('base64') });
  await service.call('mineru.upload.finish', { uploadId });
  const { jobId } = await service.call('marker.import', { uploadId, reviewBeforeImport: true });
  for (let attempt = 0; attempt < 1500; attempt++) {
    const job = (await service.call('snapshot')).jobs.find(item => item.id === jobId);
    if (job?.held) return jobId;
    if (job?.status === 'failed') throw new Error(job.stage);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('the conversion did not stop before the import');
}

test('the editor of a conversion waiting before its import, at 1280 and 420 px', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  const service = await realService(t), shots = process.env.CONVERT_EDIT_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const dist = await mkdtemp(join(tmpdir(), 'study-convert-edit-dist-'));
  await buildPreview({ outdir: dist });
  const preview = await startConsole({ distDir: dist });
  const ids = {
    zh: { 1280: await convert(service, '有识别错误的教材.pdf', 6), 420: await convert(service, '窄屏教材.pdf', 6) },
    en: { 1280: await convert(service, 'Book with junk.pdf', 6) },
  };
  const inHub = await convert(service, '入口教材.pdf', 6);
  try {
    for (const [lang, width] of [['zh', 1280], ['zh', 420], ['en', 1280]]) {
      const jobId = ids[lang][width];
      const { page, errors, context } = await openPage(browser, preview, { lang, theme: 'light', width, height: 900 });
      const started = [];
      await page.route('**/api/call', async (route) => {
        let body = {};
        try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* not JSON */ }
        if (String(body.action).startsWith('mineru.') || String(body.action).startsWith('marker.') || ['job.delete', 'job.unarchive'].includes(body.action)) {
          if (String(body.action).endsWith('.import') && !body.action.includes('edit')) started.push(body);
          try { return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: await service.call(body.action, body.args ?? {}) }) }); }
          catch (error) { return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: error.message } }) }); }
        }
        if (body.action !== 'snapshot') return route.continue();
        // A poll still in flight when the page closes has nobody to answer.
        const fetched = await route.fetch().catch(() => null);
        if (!fetched) return undefined;
        const answer = await fetched.json();
        if (answer.ok) answer.value.jobs = [...(await service.call('snapshot', { uiLanguage: lang })).jobs.filter(job => job.id === jobId), ...(answer.value.jobs || [])];
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(answer) }).catch(() => {});
      });
      await page.goto(preview.server.url);
      // The card on the 资料 page: it says it waits, and the one way on leads to the editor.
      await page.locator('[data-tour="nav-sources"]').first().dispatchEvent('click');
      const card = page.locator(`.cjc[data-job-id="${jobId}"]`);
      await card.waitFor({ timeout: 30000 });
      await settleAnimations(page);
      const cardText = await card.innerText();
      assert.match(cardText, lang === 'en' ? /Waiting for you[\s\S]*Edit and import/ : /等你导入[\s\S]*修改并导入/);
      assert.doesNotMatch(cardText, lang === 'en' ? /Failed|Continue/ : /失败|接着做/);
      const fit = await card.evaluate(element => ({ inner: element.scrollWidth, room: element.clientWidth, title: element.querySelector('.cjc__title').getBoundingClientRect().width }));
      assert.ok(fit.inner <= fit.room + 1, `${lang} ${width}: the card holds its words (${fit.inner} > ${fit.room})`);
      assert.ok(fit.title > 40, `${lang} ${width}: the word beside it leaves room for the title (${fit.title})`);
      if (shots) await card.screenshot({ path: join(shots, `convert-edit-card-${lang}-${width}.png`) });
      // The history row's own way in, on the 资料 page: the same editor; once archived, it says so and offers the way back.
      if (lang === 'zh' && width === 1280) {
        const row = page.locator(`[data-record="${jobId}"]`);
        const history = page.locator('.pdf-history').first();
        await history.waitFor({ timeout: 15000 });
        await history.locator('summary').first().click();
        await row.getByRole('button', { name: /修改并导入/ }).click();
        await page.locator('[data-convert-edit] .convert-edit__block').first().waitFor({ timeout: 15000 });
        await page.keyboard.press('Escape');
        await page.locator('[data-convert-edit]').waitFor({ state: 'detached', timeout: 15000 });
        await service.call('job.archive', { jobId });
        await row.getByRole('button', { name: /修改并导入/ }).click();
        const back = page.locator('[data-held-unarchive]');
        await back.waitFor({ timeout: 15000 });
        await back.click();
        await page.locator('[data-convert-edit] .convert-edit__block').first().waitFor({ timeout: 15000 });
        await page.keyboard.press('Escape');
        await page.locator('[data-convert-edit]').waitFor({ state: 'detached', timeout: 15000 });
      }
      await page.locator('[data-tour="nav-tasks"]').first().dispatchEvent('click');
      await page.locator('.tc-detail').first().waitFor({ state: 'attached', timeout: 30000 });
      await page.locator(`.tc-row[data-task-id="${jobId}"]`).dispatchEvent('click');
      await page.locator(`.tc-detail[data-task-id="${jobId}"]`).waitFor({ timeout: 15000 });
      await settleAnimations(page); await frames(page, 4);

      const seen = await page.evaluate(() => document.querySelector('.tc-detail')?.innerText || '');
      assert.match(seen, lang === 'en' ? /Waiting for you/ : /等你导入/);
      assert.doesNotMatch(seen, lang === 'en' ? /Failed|Continue/ : /失败|接着做|发给主会话/);
      if (shots) await page.screenshot({ path: join(shots, `convert-edit-console-${lang}-${width}.png`), fullPage: width < 768 });

      await page.locator('[data-held-entry] button').click();
      const editor = page.locator('[data-convert-edit]');
      await editor.locator('.convert-edit__block').first().waitFor({ timeout: 15000 });
      await settleAnimations(page);
      const before = await page.evaluate(() => ({ line: document.querySelector('[data-removed-line]')?.innerText, width: document.documentElement.scrollWidth, inner: document.querySelector('[data-convert-edit]').scrollWidth, room: document.querySelector('[data-convert-edit]').clientWidth }));
      assert.ok(before.width <= width, `${lang} ${width}: nothing wider than the window (${before.width})`);
      assert.ok(before.inner <= before.room + 1, `${lang} ${width}: the editor does not scroll sideways (${before.inner} > ${before.room})`);
      assert.match(before.line, lang === 'en' ? /Nothing removed/ : /还没有去掉/);

      // Remove the first block: the line counts what it took out, by the same measure as the token estimates.
      await editor.locator('.convert-edit__block').first().locator('.convert-edit__meta button').click();
      await until(async () => /\d/.test(await page.locator('[data-removed-line]').innerText()), 'the removed count');
      if (lang === 'zh') assert.match(await page.locator('[data-removed-line]').innerText(), /已去掉 \d+ 字，约 \d+ tokens/);
      // Correct the next one, and leave it.
      const text = editor.locator('textarea').first();
      const corrected = `A corrected paragraph, ${lang} ${width}.`;
      await text.fill(corrected);
      await text.blur();
      if (shots) await page.screenshot({ path: join(shots, `convert-edit-dialog-${lang}-${width}.png`) });
      await until(async () => Object.values((await service.call('mineru.edit.read', { jobId })).edits).includes(corrected), 'the edit to reach the disk');

      await page.locator('.convert-edit__foot button').last().click();
      await until(async () => (await service.call('snapshot')).jobs.find(job => job.id === jobId)?.status === 'complete', 'the import');
      const sources = (await service.call('export')).sources.filter(source => source.document?.filename?.startsWith(lang === 'en' ? 'Book with junk' : width === 1280 ? '有识别错误' : '窄屏'));
      assert.ok(sources.some(source => source.text.includes(corrected)), 'the library has the edited text');
      // The switch: folded away, off by default; turned on, the start asks for it. A new book, chosen where a learner chooses one.
      if (lang === 'zh' && width === 1280) {
        await page.locator('[data-tour="nav-sources"]').first().dispatchEvent('click');
        await page.locator('[data-tour="sources-add"]').or(page.getByRole('button', { name: '＋ 添加资料' })).first().click();
        const picker = page.locator('input[type="file"][accept=".pdf,application/pdf"]').first();
        await picker.waitFor({ state: 'attached', timeout: 15000 });
        await picker.setInputFiles({ name: 'switch.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await makePdf({ pages: 2, title: 'switch' })) });
        await page.locator('.mineru-route-panel [data-route="marker"]').first().click();
        const more = page.locator('.mineru-more');
        await more.waitFor({ timeout: 30000 });
        // The history inside the add-material dialog: its row opens the editor too, and nothing claims a parse in the background.
        await page.locator('.mineru-history summary').first().click();
        await page.locator(`[data-record="${inHub}"]`).getByRole('button', { name: /修改并导入/ }).click();
        await page.locator('[data-convert-edit] .convert-edit__block').first().waitFor({ timeout: 15000 });
        await page.keyboard.press('Escape');
        await page.locator('[data-convert-edit]').waitFor({ state: 'detached', timeout: 15000 });
        assert.equal(await more.isVisible(), true, 'back in the add-material dialog');
        assert.equal(await page.locator('[data-review-before-import]').count(), 0, 'folded: not on the main path');
        await more.locator('summary').click();
        const box = page.locator('[data-review-before-import]');
        await box.waitFor({ state: 'attached', timeout: 5000 });
        assert.equal(await box.isChecked(), false, 'off by default');
        if (shots) await page.screenshot({ path: join(shots, 'convert-edit-switch-zh-1280.png') });
        await box.check({ force: true });
        assert.match(await page.locator('.mineru-route-panel__head').innerText(), /转换好后先等你改/, 'the panel does not promise an automatic save');
        await page.locator('.mineru-start button').first().click();
        await until(async () => started.length > 0, 'the conversion to start');
        assert.equal(started[0].action, 'marker.import');
        assert.equal(started[0].args.reviewBeforeImport, true);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await preview.close(); await rm(dist, { recursive: true, force: true }); }
});
