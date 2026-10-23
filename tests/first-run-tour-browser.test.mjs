/* global document, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { drainLayoutStability, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { TOUR_STEPS, CORE_TOUR_LENGTH } from '../ui/tour/steps.js';

/* The first run in the browser preview, on an empty temporary library with the host's 备考补习 switch on: the welcome page, the default tour
   (CORE_TOUR_LENGTH steps, every anchored step lit), its last step offering the full tour, the full tour from there to its end (every anchored
   step lit, including the sidebar's 任务, 学习笔记 and 备考补习 and the reader's two controls), and, on the way out, one name for Settings and the
   library chip landing on the folder control. At 1280 and 420 px with no sideways scroll. FIRST_RUN_SHOTS=<dir> keeps a screenshot of every step. */

const SHOTS = process.env.FIRST_RUN_SHOTS || '';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
// A step by what its card says: the title, and the body where two steps share a title (the short tour's two last steps).
// The control a core step's body tells the learner to press, where it is smaller than the lit area (otherwise the lit area itself).
const KEY_CONTROL = { 'generate-quick': 'generate-submit' };
const stepOf = (title, body) => TOUR_STEPS.find(step => step.title === title && step.body === body) || TOUR_STEPS.find(step => step.title === title);

async function start(distDir) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-first-run-'));
  const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir,
    runtimePilot: { examBlueprint: true } });
  return { server, base, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

/** The card of the step on screen, once it is placed: { at, total, title, lit }. */
async function card(page) {
  await page.locator('.tour-layer:not(.is-measuring) .tour-pop').waitFor({ timeout: 30000 });
  const read = async () => {
    const [at, total] = (await page.locator('.tour-pop__count').first().innerText()).split('/').map(part => Number(part.trim()));
    const title = (await page.locator('.tour-pop__title').first().innerText()).trim();
    const body = (await page.locator('.tour-pop__body').first().innerText()).trim();
    return { at, total, title, step: stepOf(title, body) };
  };
  const first = await read();
  // The popover is placed when the anchor is found, or after the wait for it ends; the spotlight is the sign that it was found.
  const anchored = !!first.step?.anchor;
  if (anchored) await until(async () => (await page.locator('.tour-spot').count()) > 0, `the spotlight of 「${first.title}」`, { timeoutMs: 15000 }).catch(() => {});
  await settleAnimations(page);
  await frames(page, 3);
  return { ...first, lit: (await page.locator('.tour-spot').count()) > 0 };
}

/* 载入示例并开始导览 when the library is slow: the app's own refresh after sample.load is overtaken by a poll (its answer comes back first and is dropped, the
   poll's comes 2 s later), and the sample takes well over the 500 ms during which a shift still counts as the learner's own doing. The tour's home replaces the
   line as a whole: it is not drawn on the old snapshot (the banner and the sample course coming in above and inside it later), and the line's page is not the
   same element as the home's, so the banner inserted above the home moves nothing that was on screen. At 420 and 1440 px. */
test('载入示例并开始导览 moves nothing when a poll overtakes the refresh after the sample is loaded', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-first-run-race-dist-'));
  await buildPreview({ outdir: dist });
  try {
    for (const width of [420, 1440]) {
      const running = await start(dist);
      try {
        const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'dark', width, height: 900 });
        let phase = 'idle', releaseOurs = null;
        await page.route('**/api/call', async (route) => {
          let action = '';
          try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
          if (action === 'sample.load') {
            const response = await route.fetch();
            await new Promise((done) => setTimeout(done, 700));
            phase = 'ours';
            return route.fulfill({ response });
          }
          if (action === 'snapshot' && phase === 'ours') { // the app's own refresh: answered only once a poll has overtaken it
            phase = 'poll';
            const response = await route.fetch();
            await new Promise((done) => { releaseOurs = done; setTimeout(done, 4000); });
            return route.fulfill({ response });
          }
          if (action === 'snapshot' && phase === 'poll') { // the poll that overtook it, answered 2 s later
            phase = 'done';
            const response = await route.fetch();
            releaseOurs?.();
            await new Promise((done) => setTimeout(done, 2000));
            return route.fulfill({ response });
          }
          return route.continue();
        });
        await page.goto(running.server.url);
        await page.locator('.first-run').waitFor({ timeout: 30000 });
        await settleAnimations(page);
        await drainLayoutStability(page);
        await page.getByRole('button', { name: '载入示例并开始导览' }).click();
        await page.locator('.tour-layer:not(.is-measuring) .tour-pop').waitFor({ timeout: 30000 });
        await until(async () => phase === 'done', 'the overtaking poll');
        await page.waitForTimeout(2500);
        await settleAnimations(page);
        await frames(page, 3);
        assert.equal(await page.locator('.sample-banner').count(), 1, `${width}px: the sample banner is there`);
        const log = await drainLayoutStability(page);
        log.shifts = log.shifts.filter((shift) => !shift.sources.length || !shift.sources.every((source) => /sh-toast|top-right|topbar/.test(source.element)));
        const layout = judgeLayoutStability(log, { maxCls: 0.01 });
        assert.ok(layout.ok, `${width}px: the tour's home came in by moving the page: ${layout.message}`);
        assert.deepEqual(errors, [], 'no console or page errors');
        await context.close();
      } finally { await running.close(); }
    }
  } finally {
    await browser.close().catch(() => {});
    await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});

test('the default tour is short and lit, the full tour is one button away, and Settings has one name', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-first-run-dist-'));
  await buildPreview({ outdir: dist });
  try {
    for (const width of [1280, 420]) {
      const running = await start(dist);
      try {
        const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'dark', width, height: 900 });
        await page.goto(running.server.url);
        // The first screen is the first-run line (3.6 D2): with the fake model, step 2 is open; the sample tour is a quiet link at the bottom.
        await page.locator('.first-run').waitFor({ timeout: 30000 });
        await settleAnimations(page);
        const welcome = await page.locator('.first-run').innerText();
        assert.doesNotMatch(welcome, /三分钟|导入我的第一份资料/);
        assert.match(welcome, /网页文件（\.html）/);
        assert.equal(await page.locator('.first-run [data-first-run="sample"]').count(), 1);
        await page.locator('.first-run [data-first-run="sample"]').hover();
        await until(async () => new RegExp(`导览 ${CORE_TOUR_LENGTH} 步、一两分钟`).test(await page.locator('body').innerText()), 'the sample link says the tour\'s steps and time on hover', { timeoutMs: 10000 });
        await page.mouse.move(1, 1);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll on the welcome page`);
        await shot(page, `welcome-${width}`);

        // ---- the default tour: one click to start, one per step ----
        let actions = 0;
        await page.getByRole('button', { name: '载入示例并开始导览' }).click();
        actions++;
        const seen = [];
        for (let guard = 0; guard < 20; guard++) {
          const now = await card(page);
          seen.push(now);
          await shot(page, `tour-${String(now.at).padStart(2, '0')}-of-${now.total}-${width}`);
          // On a narrow panel the card is docked along the bottom: the control a step names ends above the card, never underneath it.
          if (width <= 560 && now.step?.anchor && now.lit) {
            const key = KEY_CONTROL[now.step.id];
            let control = null, pop = null;
            // A lit area taller than the room above the card (a whole Settings section) starts at the top of the view instead. The scroll is smooth: give it time.
            const above = async () => {
              [control, pop] = await Promise.all([
                key ? page.locator(`[data-tour="${key}"]`).first().boundingBox() : page.locator('.tour-spot').boundingBox(),
                page.locator('.tour-pop').boundingBox()]);
              const room = pop.y - 51 - 8;
              return !!control && (control.height <= room ? control.y + control.height <= pop.y : control.y >= 51 && control.y <= 51 + 120);
            };
            await until(above, 'the control above the docked card', { timeoutMs: 4000 }).catch(() => {});
            assert.ok(await above(), `${width}px: 「${now.title}」's ${key || 'spotlight'} ends above the docked card (control ${JSON.stringify(control)}, card ${JSON.stringify(pop)})`);
          }
          if (now.step?.final) break;
          await page.locator('.tour-pop').getByRole('button', { name: '下一步', exact: true }).click();
          actions++;
          await until(async () => (await page.locator('.tour-pop__count').first().innerText().catch(() => '')).split('/')[0].trim() !== String(now.at), `the tour leaves step ${now.at}`);
        }
        assert.equal(seen.length, CORE_TOUR_LENGTH, `${width}px: the default tour has ${CORE_TOUR_LENGTH} steps`);
        assert.ok(seen.every(item => item.total === CORE_TOUR_LENGTH), 'the counter says the same total all the way');
        // 3.6 D5: the first-run line's order, 任务 only in the full tour, and the last step on the line's step 2 (the sample never counts in the line).
        assert.deepEqual(seen.map(item => item.step?.id), ['welcome', 'settings-model', 'sources', 'generate-quick', 'draft', 'practice', 'finish-line']);
        assert.equal(CORE_TOUR_LENGTH, 7);
        assert.ok(await page.locator('[data-first-run="compact"] [data-tour="first-run-material"]').isVisible(), `${width}px: the last step shows the line's step 2`);
        assert.equal(await page.locator('[data-first-run="compact"] .frl-step[data-step="material"]').getAttribute('data-status'), 'todo', 'the sample material does not tick step 2');
        assert.equal(await page.locator('.tour-spot').count() > 0, true, 'and lights it');
        const [row, pop] = await Promise.all([page.locator('[data-first-run="compact"] [data-tour="first-run-material"]').boundingBox(), page.locator('.tour-pop').boundingBox()]);
        assert.ok(row.y + row.height <= pop.y || row.y >= pop.y + pop.height || row.x + row.width <= pop.x || row.x >= pop.x + pop.width,
          `${width}px: the card does not cover the line's step 2 (row ${JSON.stringify(row)}, card ${JSON.stringify(pop)})`);
        assert.deepEqual(seen.filter(item => item.step?.anchor && !item.lit).map(item => item.title), [], `${width}px: every anchored step finds its element`);
        assert.ok(actions <= CORE_TOUR_LENGTH + 1, `${actions} clicks to take the default tour (was 22)`);
        const last = page.locator('.tour-pop');
        assert.equal(await last.getByRole('button', { name: '添加资料' }).count(), 1);
        assert.equal(await last.getByRole('button', { name: '看完整导览' }).count(), 1, 'the full tour is offered at the end');

        // ---- the full tour: the explicit extra ----
        await last.getByRole('button', { name: '看完整导览' }).click();
        const full = [];
        for (let guard = 0; guard < 40; guard++) {
          const now = await card(page);
          full.push(now);
          await shot(page, `full-${String(now.at).padStart(2, '0')}-of-${now.total}-${width}`);
          if (now.step?.final) break;
          await page.locator('.tour-pop').getByRole('button', { name: '下一步', exact: true }).click();
          await until(async () => (await page.locator('.tour-pop__count').first().innerText().catch(() => '')).split('/')[0].trim() !== String(now.at), `the full tour leaves step ${now.at}`);
        }
        assert.equal(full[0].step.id, 'nav', 'it carries on past the welcome step the learner has already read');
        assert.equal(full[0].at, 2);
        const ids = full.map(item => item.step?.id);
        for (const id of ['tasks', 'notes', 'examprep', 'reader-practice', 'translation', 'settings-model']) assert.ok(ids.includes(id), `${id} is in the full tour`);
        assert.ok(ids.indexOf('settings-model') > ids.indexOf('practice'));
        assert.equal(full.at(-1).total, TOUR_STEPS.filter(step => step.only !== 'core').length);
        assert.deepEqual(full.filter(item => item.step?.anchor && !item.lit).map(item => `${item.at}. ${item.title}`), [], `${width}px: every anchored step of the full tour finds its element`);
        assert.equal(await page.locator('.tour-pop').getByRole('button', { name: '看完整导览' }).count(), 0, 'the full tour does not offer itself again');
        await page.locator('.tour-pop').getByRole('button', { name: '完成导览', exact: true }).click();
        await page.locator('.tour-layer').waitFor({ state: 'detached', timeout: 15000 });

        // ---- Settings: one name, and the library chip lands on the folder control ----
        await page.locator('[data-tour="nav-settings"]').first().dispatchEvent('click');
        await page.locator('.settings-page').waitFor({ timeout: 30000 });
        const entry = (await page.locator('[data-tour="nav-settings"]').first().innerText()).trim();
        assert.equal((await page.locator('.settings-page h1').first().innerText()).trim(), '设置');
        assert.ok(entry === '设置' || width < 800, 'the sidebar entry says the same');
        assert.equal((await page.locator('.crumb[aria-current="page"]').innerText()).trim(), '设置');
        assert.equal(await page.getByText('工作区设置').count(), 0);
        await page.locator('.settings-nav__item[data-category="profile"]').first().click();
        await page.locator('[data-tour="settings-sample"]').first().waitFor({ timeout: 15000 });
        assert.equal(await page.getByRole('button', { name: '看完整导览' }).count(), 1, 'Settings › 学习画像与导览 starts the full tour too');
        await shot(page, `settings-tour-${width}`);
        // the last category the learner used is something else than the library: the chip still goes to the folder control
        await page.locator('.settings-nav__item[data-category="appearance"]').first().click();
        await page.locator('.settings-nav__item[data-category="appearance"][aria-current="page"]').waitFor({ timeout: 15000 });
        await page.locator('[data-tour="nav-library"]').first().dispatchEvent('click');
        await page.locator('.library-location').first().click();
        await page.locator('.binding-panel').waitFor({ timeout: 30000 });
        assert.equal(await page.locator('.settings-nav__item[data-category="model"]').first().getAttribute('aria-current'), 'page');
        assert.ok(await page.locator('.binding-panel').getByRole('button', { name: '更换目录…' }).isVisible(), 'the folder control is on screen');
        await shot(page, `settings-folder-${width}`);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll on Settings`);
        assert.deepEqual(errors, [], 'no console or page errors');
        await context.close();
      } finally { await running.close(); }
    }
  } finally {
    await browser.close().catch(() => {});
    await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
