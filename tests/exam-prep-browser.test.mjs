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
import { drainLayoutStability, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { StudyService } from '../lib/service.js';
import { library, pointList } from './helpers/exam-prep-fixtures.mjs';

/* 备考补习 in the browser preview, on a seeded temporary library (the real module's point list, written to the library as the build job writes it) with the
   host's switch turned on: the sidebar entry, the list, one list opened (keyboard on the points, 看原页 opens the reader on the quote), the create form with its
   estimate, hover explanations on keyboard focus, at 1280 and 420 px with no sideways scroll and no layout shift. The page does not exist with the switch off. */

const SHOTS = process.env.EXAM_PREP_SHOTS || '';

async function seed(root, { off = false } = {}) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push(...structuredClone(library()), structuredClone(pointList({ orphan: true, many: 40 })));
    if (off) state.settings.examPrep = { enabled: false }; // the learner turned the page off in Settings
  });
  service.dispose?.();
}

async function start(distDir, pilot, options) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-exam-prep-'));
  const root = join(base, 'library');
  await seed(root, options);
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir, runtimePilot: pilot });
  return { server, base, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

async function openApp(browser, running, { lang = 'zh', width = 1280, height = 900 } = {}) {
  const opened = await openPage(browser, running, { lang, theme: 'dark', width, height });
  await opened.page.goto(running.server.url);
  await opened.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  return opened;
}

const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };

test('turned off in Settings the page has no sidebar entry and one switch there brings it back; on, it lists, opens, explains itself and builds, at 1280 and 420 px', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-exam-prep-dist-'));
  await buildPreview({ outdir: dist });
  try {
    // on by default: no host switch is needed
    const byDefault = await start(dist, null);
    try {
      const { page, context } = await openApp(browser, byDefault);
      await page.locator('[data-tour="nav-examprep"]').first().waitFor({ state: 'attached', timeout: 30000 });
      await context.close();
    } finally { await byDefault.close(); }

    // off (the learner turned it off): nothing in the sidebar, and the switch in Settings brings it back at once
    const off = await start(dist, null, { off: true });
    try {
      const { page, context } = await openApp(browser, off);
      await page.locator('[data-tour="nav-sources"]').first().waitFor({ state: 'attached' });
      assert.equal(await page.locator('[data-tour="nav-examprep"]').count(), 0, 'no sidebar entry while the learner has it off');
      await page.locator('[data-tour="nav-sources"]').first().dispatchEvent('click');
      await page.locator('.sources-page').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.sources-page').innerText(), /传输层/, 'the slides are materials');
      await page.locator('aside').getByText('设置', { exact: true }).first().click();
      await page.getByText('工作区设置').first().waitFor({ timeout: 30000 });
      await page.getByText('备考补习', { exact: true }).last().click();
      const switchOn = page.getByLabel('开启备考补习');
      await switchOn.waitFor({ timeout: 30000 });
      assert.equal(await switchOn.isChecked(), false, 'the switch shows it is off');
      await switchOn.click();
      await page.locator('[data-tour="nav-examprep"]').first().waitFor({ state: 'attached', timeout: 30000 });
      assert.equal(await switchOn.isChecked(), true);
      await shot(page, 'settings-switch');
      await context.close();
    } finally { await off.close(); }

    const on = await start(dist, { examBlueprint: true });
    try {
      for (const width of [1280, 420]) {
        const { page, errors, context } = await openApp(browser, on, { width });
        const entry = page.locator('[data-tour="nav-examprep"]').first();
        await entry.waitFor({ state: 'attached', timeout: 30000 });
        await entry.dispatchEvent('click');
        await page.locator('.exam-prep-row').first().waitFor({ timeout: 30000 });
        await settleAnimations(page);
        await frames(page, 4);
        await drainLayoutStability(page);
        assert.equal(await page.locator('.exam-prep-row').count(), 1, 'one list');
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll on the list`);
        await shot(page, `list-${width}`);
        // the 资料 page does not list it
        // hover explanation on keyboard focus: hidden before, shown on focus, hidden after
        const basis = page.locator('.exam-prep-row__basis').first();
        const tip = page.locator('.exam-prep-row__basis + [role="tooltip"]').first();
        assert.equal(await tip.isVisible(), false, 'hidden by default');
        await basis.focus();
        await until(async () => tip.isVisible(), 'the basis explanation on focus');
        assert.match(await tip.innerText(), /样卷/);
        await shot(page, `tip-${width}`);
        await page.keyboard.press('Escape');
        await page.locator('.exam-prep-row__open').first().click();
        // the points: the summary is there at once, the points when the record has been read
        await page.locator('.exam-prep-point').first().waitFor({ timeout: 30000 });
        await settleAnimations(page);
        await frames(page, 4);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll on a list`);
        const toggles = page.locator('[data-point-toggle]');
        await toggles.first().focus();
        await page.keyboard.press('ArrowRight');
        assert.equal(await toggles.first().getAttribute('aria-expanded'), 'true', 'right opens a big point');
        await page.keyboard.press('ArrowDown');
        assert.match(await page.evaluate(() => document.activeElement?.getAttribute('data-point-toggle') || ''), /^p/, 'down moves to the next row');
        assert.equal(await page.locator('[data-point-toggle][tabindex="0"]').count(), 1, 'one tab stop for the whole tree');
        await page.keyboard.press('Enter');
        await shot(page, `detail-${width}`);
        // 看原页 opens the reader on the quote
        const peek = page.locator('.exam-prep-place button').first();
        await peek.waitFor({ timeout: 10000 });
        await peek.click();
        await until(async () => (await page.locator('dialog[open], [role="dialog"]').count()) > 0, 'the reader');
        await until(async () => /三次握手建立连接/.test(await page.locator('dialog[open], [role="dialog"]').first().innerText()), 'the quote in the reader', { timeoutMs: 30000 });
        await shot(page, `reader-${width}`);
        await page.keyboard.press('Escape');
        await until(async () => (await page.locator('dialog[open]').count()) === 0, 'the reader closed');
        // nothing on the page is offered and cannot be pressed: the always-off 针对这些考点出题 is gone
        assert.equal(await page.locator('.exam-prep-soon').count(), 0);
        assert.equal(await page.getByText('针对这些考点出题').count(), 0);
        // search
        await page.locator('.exam-prep-search').fill('补充考点 3');
        await frames(page, 3);
        assert.ok((await page.locator('.exam-prep-point').count()) > 0 && (await page.locator('.exam-prep-point').count()) < 40);
        const detailVerdict = judgeLayoutStability(await drainLayoutStability(page), { maxCls: 0.05 });
        assert.ok(detailVerdict.ok, `${width}px list: ${detailVerdict.message}`);
        // the short flow: the form opens filled in, and 开始生成 is the one thing left to press
        await page.locator('.sh-page-header__back').first().click();
        await page.locator('[data-usage="examprep.create"]').first().click();
        await page.locator('.exam-prep-form').waitFor({ timeout: 30000 });
        await page.locator('[data-doc]').first().waitFor({ timeout: 30000 });
        await settleAnimations(page);
        await drainLayoutStability(page);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll on the form`);
        assert.ok((await page.locator('[data-doc]').count()) >= 3, 'the documents of the course are in one table');
        assert.match(await page.locator('.exam-prep-docs__counts').innerText(), /\d+ 份课件 · \d+ 份样卷/, 'the sentence counts them');
        assert.equal(await page.locator('[data-doc][data-role="past-paper"]').count() > 0, true, 'the sample paper was told by its name');
        assert.match(await page.locator('[data-doc][data-role="past-paper"]').first().innerText(), /文件名含「样卷」/, 'and says why');
        assert.equal(await page.locator('.source-picker').count(), 0, 'no picker on the main path');
        assert.equal(await page.locator('.exam-prep-more').evaluate(element => element.open), false, '更多设置 is closed');
        assert.equal(await page.locator('.exam-prep-more input').first().isVisible(), false, 'the name is not asked');
        await until(async () => (await page.locator('[data-token-estimate][data-status="ready"]').count()) > 0, 'the estimate', { timeoutMs: 60000 });
        assert.match(await page.locator('[data-token-estimate]').first().innerText(), /预计/);
        assert.equal(await page.locator('.exam-prep-plan').count(), 0, 'the counts are said once, above the table: no second plan line');
        await shot(page, `form-${width}`);
        const startButton = page.locator('[data-usage="examprep.start"]');
        await until(async () => !(await startButton.isDisabled()), 'the start button, with nothing pressed', { timeoutMs: 30000 });
        // a wrong guess is one click: the paper becomes 不用, the sentence follows, and a click brings it back
        const paper = page.locator('[data-doc][data-role="past-paper"]').first();
        const before = await page.locator('.exam-prep-docs__counts').innerText();
        await paper.getByRole('button', { name: '不用' }).click();
        await until(async () => (await page.locator('.exam-prep-docs__counts').innerText()) !== before, 'the sentence follows the role');
        assert.match(await page.locator('.exam-prep-docs__counts').innerText(), /0 份样卷/);
        assert.match(await page.locator('.exam-prep-docs__none').innerText(), /没有样卷/);
        // only some pages of a deck: the page list sits behind its row, and the row says how many are used
        const deck = page.locator('[data-doc][data-role="lecture"]').first();
        await deck.getByRole('button', { name: /选择页面/ }).click();
        const pages = deck.locator('.source-picker__pages input[type="checkbox"]');
        await pages.first().waitFor({ timeout: 10000 });
        await pages.first().uncheck();
        await until(async () => /已选 \d+ \/ \d+ 页/.test(await deck.locator('.exam-prep-doc__meta').innerText()), 'the row says how many pages are used');
        await pages.first().check();
        await deck.locator('.exam-prep-doc__why').getByRole('button', { name: '收起' }).click();
        // stepping out to Settings and back keeps the form as it was
        await page.locator('.exam-prep-more > summary').click();
        await shot(page, `form-more-${width}`);
        await page.locator('.exam-prep-more__settings button').click();
        await page.locator('[data-tour="nav-examprep"]').first().waitFor({ state: 'attached', timeout: 30000 });
        await page.locator('.exam-prep-form').waitFor({ state: 'detached', timeout: 30000 });
        await page.locator('[data-tour="nav-examprep"]').first().dispatchEvent('click');
        await page.locator('.exam-prep-form').waitFor({ timeout: 30000 });
        assert.match(await page.locator('.exam-prep-docs__counts').innerText(), /0 份样卷/, 'the change survived the detour');
        assert.equal(await page.locator('.exam-prep-more').evaluate(element => element.open), true, 'and so did the fold');
        await page.locator('[data-doc]').first().waitFor({ timeout: 30000 });
        const formVerdict = judgeLayoutStability(await drainLayoutStability(page), { maxCls: 0.1 });
        assert.ok(formVerdict.ok, `${width}px form: ${formVerdict.message}`);
        if (width === 1280) {
          // start: the build is a job of the runtime; the page answers in words (a running row, or the refusal of the operation), never with a raw error
          await until(async () => !(await startButton.isDisabled()), 'the start button again', { timeoutMs: 30000 });
          await startButton.click();
          await until(async () => (await page.locator('.exam-prep-row.is-building, .exam-prep-row[data-list]').count()) > 1 || (await page.locator('.exam-prep-check').innerText()).trim().length > 0, 'the answer to start', { timeoutMs: 30000 });
          const said = (await page.locator('.exam-prep-check').count()) ? (await page.locator('.exam-prep-check').innerText()).trim() : '';
          assert.ok(said ? /执行器|后台|额度/.test(said) : true, `a refusal says why in plain words: ${said}`);
          await shot(page, 'started');
        }
        // the one refusal the preview gives (it has no background task service) arrives as a 400; nothing else may be logged
        assert.deepEqual(errors.filter(message => !/status of 400/.test(message)), []);
        await context.close();
      }
    } finally { await on.close(); }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});
