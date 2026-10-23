/* global document, window, getComputedStyle -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { drainLayoutStability, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';

/* 3.6 D2 in the browser preview, on an empty temporary library: the first-run line from no model to the first question. No model (step 1 open with the gate's
   steps, 重新检查 the one primary, no bounce to the settings) → a model (the same library opened again with the fake model: step 1 ticked) → 添加资料 (the
   existing import, back on the line, 3.6 D4) → step 3 says what will be made and its estimate before anything is spent, on the first screen, and the estimate's
   arrival moves nothing → 出第一组题 (创建题组's own request, from the line) → generating (the run's card inside step 3, drawn once, no 查看进度) → the draft
   (发布并开始练 with 先看看草稿, and nothing moved from the ready step through the run) → publishing (the first question; back on the library the line is
   gone and the home is back).
   Every state has at most one primary button on the page. At 1280 and 390 px, light. FIRST_RUN_LINE_SHOTS=<dir> keeps a screenshot of each state. */

const SHOTS = process.env.FIRST_RUN_LINE_SHOTS || '';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const primaries = (page) => page.locator('main .sh-btn--primary:visible, .first-run .sh-btn--primary:visible').count();
const openStep = (page) => page.locator('.first-run .frl-step[data-open]').getAttribute('data-step');
const status = (page, step) => page.locator(`.first-run .frl-step[data-step="${step}"]`).getAttribute('data-status');

async function server(root, home, model) {
  return createPreviewServer({ libraryRoot: root, home, port: 0, model, distDir: process.env.__FRL_DIST });
}

async function open(browser, running, width) {
  const opened = await openPage(browser, running, { lang: 'zh', theme: 'light', width, height: width < 700 ? 844 : 800 });
  await opened.page.goto(running.server.url);
  await opened.page.locator('.first-run').waitFor({ timeout: 30000 });
  await settleAnimations(opened.page);
  return opened;
}

test('the first-run line from no model to the first question: one primary per state, the run inside step 3, nothing moves', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const dist = await mkdtemp(join(tmpdir(), 'study-first-run-line-dist-'));
  await buildPreview({ outdir: dist });
  process.env.__FRL_DIST = dist;
  try {
    for (const width of [1280, 390]) {
      const base = await mkdtemp(join(tmpdir(), 'study-first-run-line-'));
      const root = join(base, 'library'), home = join(base, 'home');
      let running = null;
      try {
        /* ---- no model: step 1 open, in the gate's words ---- */
        running = { server: await server(root, home, null) };
        let { page, errors, context } = await open(browser, running, width);
        assert.equal(await openStep(page), 'model');
        assert.equal(await primaries(page), 1, `${width}px no model: one primary`);
        assert.equal((await page.locator('.first-run .sh-btn--primary').innerText()).trim(), '重新检查');
        assert.match(await page.locator('.first-run [data-body="model"]').innerText(), /在 DSH 打开「设置 › 模型」/);
        assert.equal(await page.locator('.first-run .sh-btn:not(.sh-btn--link)', { hasText: /前往设置|打开模型设置/ }).count(), 0, 'no button that bounces to the settings');
        assert.equal(await page.locator('.first-run [data-body="model"] .sh-btn--link', { hasText: '前往设置' }).count(), 1, 'one quiet link, inside the step that picks a model');
        assert.equal(await page.locator('.frl-step[data-step="material"] .sh-btn--link', { hasText: '添加资料' }).count(), 1, 'step 2 is never locked');
        for (const hidden of ['.desk', '.home-drafts', '.daily-plan', '[data-setup-checklist]', '.course-heading', '.map-empty'])
          assert.equal(await page.locator(hidden).count(), 0, `${width}px: ${hidden} waits for the first deck`);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll`);
        await shot(page, `01-no-model-${width}`);
        assert.deepEqual(errors, [], 'no console or page errors');
        await context.close();
        await running.server.close();

        /* ---- a model (the learner came back from DSH): step 1 ticked, step 2 open ---- */
        running = { server: await server(root, home, createFakeModel({ latencyMs: 250 })) };
        ({ page, errors, context } = await open(browser, running, width));
        assert.equal(await status(page, 'model'), 'done');
        assert.match(await page.locator('.frl-step[data-step="model"]').innerText(), /已(连接|选择模型)/);
        assert.equal(await openStep(page), 'material');
        assert.equal(await primaries(page), 1, `${width}px model ready: one primary`);
        assert.equal((await page.locator('.first-run .sh-btn--primary').innerText()).trim(), '添加资料');
        await shot(page, `02-model-ready-${width}`);

        /* ---- 添加资料: the existing import, and back on the line (3.6 D4), not on 创建题组 ---- */
        let clicks = 0;
        await page.locator('.first-run .sh-btn--primary').click();
        clicks++;
        const dialog = page.locator('dialog[open], [role="dialog"]').first();
        await dialog.waitFor({ timeout: 30000 });
        await dialog.locator('.sh-drop input[type="file"]').first().setInputFiles({ name: '第3讲 进程与线程.md', mimeType: 'text/markdown',
          buffer: Buffer.from('# 第3讲 进程与线程\n\n## 进程\n\n进程是资源分配的单位，拥有独立的地址空间。\n\n## 线程\n\n线程是调度的单位，同一进程的线程共享地址空间。\n') });
        clicks++;
        await until(async () => !(await page.locator('dialog[open]').count()) && (await status(page, 'material')) === 'done', 'the import closes on the line, step 2 ticked');
        assert.equal(await page.locator('.generate-page').count(), 0, 'the first import does not hop to 创建题组');
        assert.match(await page.locator('.frl-step[data-step="material"]').innerText(), /第3讲 进程与线程(\.md)? · 已添加/, 'the material by the title 资料 shows');
        assert.match(await page.locator('.frl-step[data-step="material"]').innerText(), /再加一份/);
        assert.equal(await openStep(page), 'deck');
        assert.equal(await primaries(page), 1);
        assert.equal((await page.locator('.first-run .sh-btn--primary').innerText()).trim(), '出第一组题');
        assert.equal(await page.locator('.first-run [data-first-run="tune"]').innerText(), '改题型和题数', 'the full form is one quiet link away');

        /* ---- what will be made and its estimate, on screen before anything is spent; its arrival moves nothing ---- */
        const plan = page.locator('.first-run [data-first-run="plan"]');
        await plan.waitFor({ timeout: 30000 });
        await drainLayoutStability(page);
        await until(async () => (await plan.locator('[data-token-estimate][data-status="ready"]').count()) > 0, 'the estimate arrives', { timeoutMs: 30000 });
        await frames(page, 3);
        const arrival = await drainLayoutStability(page);
        arrival.shifts = arrival.shifts.filter((shift) => !shift.sources.length || !shift.sources.every((source) => /sh-toast|top-right|topbar/.test(source.element)));
        const arrived = judgeLayoutStability(arrival, { maxCls: 0.01 });
        assert.ok(arrived.ok, `${width}px: the estimate's arrival moved the page: ${arrived.message}`);
        const planText = (await plan.innerText()).replace(/\s+/g, ' ');
        assert.match(planText, /将从 1 份资料出 \d+ 题 · 混合难度 · 中文 · 单选测验/, '创建题组\'s summary sentence and the types');
        assert.match(planText, /预计 [\d.]+K?–[\d.]+K? tok · [\d–]+ 次模型调用/, '创建题组\'s estimate line');
        const onScreen = (locator) => locator.evaluate((element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.top >= 0 && box.bottom <= window.innerHeight; });
        assert.ok(await onScreen(plan.locator('[data-token-estimate]')), `${width}px: the estimate is on the first screen`);
        assert.ok(await onScreen(page.locator('.first-run [data-first-run="generate"]')), `${width}px: 出第一组题 is on the first screen, no scrolling (创建题组's button was 1.75 screens down at 390)`);
        // Nothing is spent by itself: no run starts until the button is pressed.
        await page.waitForTimeout(1500);
        assert.equal(await status(page, 'deck'), 'ready', 'no run starts on its own');
        assert.equal(await page.locator('.cjc').count(), 0);
        await settleAnimations(page);
        await shot(page, `03-material-added-${width}`);
        const ready = await page.evaluate(() => {
          const rect = (selector) => { const box = document.querySelector(selector)?.getBoundingClientRect(); return box ? { top: Math.round(box.top), height: Math.round(box.height) } : null; };
          return { body: rect('.first-run [data-body="deck"]'), footer: rect('.first-run__footer') };
        });

        /* ---- 出第一组题: 创建题组's own request, from the line → the run's card inside step 3 ---- */
        await page.locator('.first-run [data-first-run="generate"]').click();
        clicks++;
        await until(async () => (await status(page, 'deck')) === 'generating', 'step 3 says the run is going', { timeoutMs: 30000 });
        assert.equal(await page.locator('.generate-page').count(), 0, 'generated from the line, not from the form');
        const card = page.locator('.first-run [data-body="deck"] .cjc');
        await card.waitFor({ timeout: 30000 });
        assert.equal(await page.locator('.cjc').count(), 1, 'the run\'s card is drawn once, inside step 3');
        assert.equal(await page.getByRole('button', { name: '查看进度' }).count(), 0, 'no 查看进度 beside the card');
        assert.equal(await primaries(page), 0, 'a run in progress has nothing cinnabar to press');
        await frames(page, 3);
        await shot(page, `04-generating-${width}`);
        const before = await page.evaluate(() => {
          const rect = (selector) => { const box = document.querySelector(selector)?.getBoundingClientRect(); return box ? { top: Math.round(box.top), height: Math.round(box.height) } : null; };
          return { body: rect('.first-run [data-body="deck"]'), footer: rect('.first-run__footer') };
        });
        for (const part of ['body', 'footer']) for (const side of ['top', 'height'])
          assert.ok(Math.abs(before[part][side] - ready[part][side]) <= 2, `${width}px: the run's card coming in keeps step 3's place and height (${part} ${side} ${ready[part][side]} → ${before[part][side]})`);
        await drainLayoutStability(page);

        /* ---- the draft: 发布并开始练 (clean) or 检查草稿, and nothing moved when the run finished ---- */
        await until(async () => /draft-/.test(await status(page, 'deck') || ''), 'the run finished with a draft', { timeoutMs: 180000 });
        await until(async () => (await status(page, 'deck')) === 'draft-clean', 'the coverage says the draft is clean', { timeoutMs: 30000 }).catch(() => {});
        await frames(page, 3);
        // What is measured is the page: the toast that said the run started floats over it and leaves on its own, and the top bar's status (正在生成… → 已连接)
        // is the shell's, outside the line.
        const log = await drainLayoutStability(page);
        log.shifts = log.shifts.filter((shift) => !shift.sources.length || !shift.sources.every((source) => /sh-toast|top-right|topbar/.test(source.element)));
        const layout = judgeLayoutStability(log, { maxCls: 0.01 });
        assert.ok(layout.ok, `${width}px: the run finishing moved the page: ${layout.message} ${JSON.stringify(layout.shifts.map((shift) => shift.sources))}`);
        const after = await page.evaluate(() => {
          const rect = (selector) => { const box = document.querySelector(selector)?.getBoundingClientRect(); return box ? { top: Math.round(box.top), height: Math.round(box.height) } : null; };
          return { body: rect('.first-run [data-body="deck"]'), footer: rect('.first-run__footer') };
        });
        for (const part of ["body", "footer"]) for (const side of ["top", "height"])
          assert.ok(Math.abs(after[part][side] - before[part][side]) <= 2, `${width}px: step 3 keeps its place and height from the run to the draft (${part} ${side} ${before[part][side]} → ${after[part][side]})`);
        assert.equal(await page.locator('.cjc').count(), 0, 'the finished run\'s card leaves; the step\'s own button is the one');
        assert.equal(await primaries(page), 1, `${width}px draft: one primary`);
        const state = await status(page, 'deck');
        const label = (await page.locator('.first-run .sh-btn--primary').innerText()).trim();
        if (state === 'draft-clean') {
          assert.equal(label, '发布并开始练');
          assert.equal(await page.locator('.first-run [data-body="deck"] .sh-btn--link', { hasText: '先看看草稿' }).count(), 1);
        } else assert.equal(label, '检查草稿');
        await settleAnimations(page);
        await shot(page, `05-draft-${state}-${width}`);

        /* ---- publish: the first question; the library is the ordinary home again ---- */
        if (state === 'draft-clean') await page.locator('.first-run .sh-btn--primary').click();
        else {
          await page.locator('.first-run .sh-btn--primary').click();
          await page.getByRole('button', { name: '发布并开始练 →' }).first().click();
          clicks++;
        }
        clicks++;
        await page.locator('.options .option').first().waitFor({ timeout: 60000 });
        await shot(page, `06-first-question-${width}`);
        // From the line's first screen with a model to the first question: 添加资料, the file, 出第一组题, 发布并开始练 (检查草稿 adds one), no scrolling.
        assert.ok(clicks <= (state === 'draft-clean' ? 4 : 5), `${width}px: ${clicks} presses to the first question`);
        await page.locator('[data-tour="nav-library"]').first().dispatchEvent('click');
        await page.locator('.desk').waitFor({ timeout: 30000 });
        assert.equal(await page.locator('.first-run, [data-first-run]').count(), 0, 'the line is gone after the first publish');
        assert.equal(await page.locator('.today-count').count(), 1, 'the today card is back');
        await settleAnimations(page);
        await shot(page, `07-after-publish-${width}`);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll`);
        assert.deepEqual(errors.filter((error) => !/favicon|Failed to load resource/.test(error)), [], `${width}px: no console or page errors`);
        await context.close();
      } finally {
        await running?.server.close().catch(() => {});
        await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      }
    }
  } finally {
    delete process.env.__FRL_DIST;
    await browser.close().catch(() => {});
    await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});

/* The compact card (after 以后再说) with a long model label (a real provider's): every row stays inside the card and is cut with an ellipsis, and the rows sit
   on the card's 32px ruling, at 1280 and 390 px. Then sources more than one run takes: 出第一组题 is greyed on the card with the reason and 改题型和题数 in
   place of the summary (no 将从…, no estimate), still on the ruling. */
test('the compact card keeps its rows inside the card and on its ruling, with a long model label', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const dist = await mkdtemp(join(tmpdir(), 'study-first-run-compact-dist-'));
  await buildPreview({ outdir: dist });
  process.env.__FRL_DIST = dist;
  const LONG = 'SiliconFlow · Qwen/Qwen3-235B-A22B-Instruct-2507';
  try {
    for (const width of [1280, 390]) {
      const base = await mkdtemp(join(tmpdir(), 'study-first-run-compact-'));
      const root = join(base, 'library'), home = join(base, 'home');
      let running = null;
      try {
        running = { server: await server(root, home, createFakeModel({ latencyMs: 0 })) };
        const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'light', width, height: width < 700 ? 844 : 800 });
        // The provider's label as DSH reports it for a real model (the fake model's is short).
        await page.route('**/api/call', async (route) => {
          let action = '';
          try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
          if (action !== 'snapshot') return route.continue();
          const response = await route.fetch(), body = await response.json();
          if (body?.value?.model && typeof body.value.model === 'object') body.value.model.label = LONG;
          return route.fulfill({ response, json: body });
        });
        await page.goto(running.server.url);
        await page.locator('.first-run').waitFor({ timeout: 30000 });
        // A material of the learner's own, so the second row has a long title too.
        await page.locator('.first-run .sh-btn--primary').click();
        const dialog = page.locator('dialog[open], [role="dialog"]').first();
        await dialog.waitFor({ timeout: 30000 });
        await dialog.locator('.sh-drop input[type="file"]').first().setInputFiles({ name: '第3讲 进程与线程：调度、同步与死锁的完整讲义.md', mimeType: 'text/markdown',
          buffer: Buffer.from('# 第3讲\n\n## 进程\n\n进程是资源分配的单位。\n') });
        await until(async () => !(await page.locator('dialog[open]').count()) && (await page.locator('.first-run .frl-step[data-step="deck"][data-open]').count()) > 0,
          'back on the line after the import');
        await page.locator('.first-run [data-first-run="later"]').click();
        const card = page.locator('[data-first-run="compact"]');
        await card.waitFor({ timeout: 30000 });
        await until(async () => /SiliconFlow/.test(await card.innerText()), 'the long label is on the card');
        await settleAnimations(page);
        const box = await card.evaluate((element) => {
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
          const inner = { left: rect.left + parseFloat(style.paddingLeft), right: rect.right - parseFloat(style.paddingRight) };
          const rows = [...element.querySelectorAll('.frl-step')].map((li) => {
            const text = li.querySelector('.frl-step__text'), row = li.querySelector('.frl-step__row').getBoundingClientRect(), own = text.getBoundingClientRect();
            return { right: Math.round(own.right), liRight: Math.round(li.getBoundingClientRect().right), top: Math.round(row.top - rect.top), height: Math.round(row.height), cut: text.scrollWidth > text.clientWidth };
          });
          // The first deck's summary and estimate (3.6 D4): two more ruled lines under the rows.
          const planLines = [...element.querySelectorAll('.frl-compact-plan__line')].map((line) => { const own = line.getBoundingClientRect();
            return { top: Math.round(own.top - rect.top), height: Math.round(own.height), right: Math.round(own.right) }; });
          return { inner: { left: Math.round(inner.left), right: Math.round(inner.right) }, rows, planLines, overflow: document.documentElement.scrollWidth - window.innerWidth };
        });
        for (const row of box.rows) {
          assert.ok(row.right <= box.inner.right + 1 && row.liRight <= box.inner.right + 1, `${width}px: a row stays inside the card: ${JSON.stringify(box)}`);
          assert.equal(row.height, 32, `${width}px: one 32px ruled line per row: ${JSON.stringify(box)}`);
          // The ruling (ui/study-map/desk.css) starts 52px down the card and repeats every 32px: each row starts on a rule.
          assert.equal((row.top - 52) % 32, 0, `${width}px: the row sits on the ruling: ${JSON.stringify(box)}`);
        }
        assert.ok(box.rows[0].cut, `${width}px: the long label is cut with an ellipsis, not spilled: ${JSON.stringify(box)}`);
        assert.equal(box.planLines.length, 2, `${width}px: the summary and the estimate under the rows: ${JSON.stringify(box)}`);
        for (const line of box.planLines) {
          assert.equal(line.height, 32, `${width}px: one ruled line each: ${JSON.stringify(box)}`);
          assert.equal((line.top - 52) % 32, 0, `${width}px: on the ruling: ${JSON.stringify(box)}`);
          assert.ok(line.right <= box.inner.right + 1, `${width}px: inside the card: ${JSON.stringify(box)}`);
        }
        await until(async () => /预计 .+ tok/.test(await card.innerText()), 'the estimate is on the card before 出第一组题', { timeoutMs: 30000 });
        assert.equal((await card.locator('.sh-btn--primary').innerText()).trim(), '出第一组题');
        assert.ok(box.overflow <= 0, `${width}px: no sideways scroll`);
        await shot(page, `09-later-compact-long-label-${width}`);

        /* ---- sources more than one run takes: never a button that does nothing when pressed ---- */
        const half = '进程是资源分配的单位，线程是调度的单位。'.repeat(17500); // 350 000 characters each, 700 000 together: over the one-run limit
        for (const title of ['整本教材 上册', '整本教材 下册']) await previewCall(running.server, 'source.add', { title, text: half });
        await until(async () => (await card.locator('[data-first-run="blocked"]').count()) > 0, 'the card says why 出第一组题 is off', { timeoutMs: 30000 });
        await settleAnimations(page);
        const go = card.locator('.sh-btn--primary');
        assert.equal((await go.innerText()).trim(), '出第一组题');
        assert.ok(await go.isDisabled(), `${width}px: 出第一组题 is disabled over sources that are too big`);
        const said = await card.innerText();
        assert.match(said, /超过一次出题的上限/);
        assert.doesNotMatch(said, /将从|正在估算|预计/, `${width}px: no summary or estimate over a selection that cannot be sent`);
        assert.equal(await card.locator('[data-first-run="tune"]').innerText(), '改题型和题数');
        const ruled = await card.evaluate((element) => {
          const top = element.getBoundingClientRect().top, at = (selector) => { const own = element.querySelector(selector).getBoundingClientRect();
            return { top: Math.round(own.top - top), height: Math.round(own.height), right: Math.round(own.right) }; };
          return { reason: at('[data-first-run="blocked"]'), tune: at('[data-first-run="tune"]'), card: Math.round(element.getBoundingClientRect().right) };
        });
        for (const part of ['reason', 'tune']) {
          assert.equal((ruled[part].top - 52) % 32, 0, `${width}px: the ${part} sits on the ruling: ${JSON.stringify(ruled)}`);
          assert.equal(ruled[part].height % 32, 0, `${width}px: the ${part} takes whole ruled lines: ${JSON.stringify(ruled)}`);
        }
        assert.ok(ruled.reason.right <= ruled.card, `${width}px: the reason stays inside the card`);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll`);
        await shot(page, `10-later-compact-too-big-${width}`);
        assert.deepEqual(errors.filter((error) => !/favicon|Failed to load resource/.test(error)), [], `${width}px: no console or page errors`);
        await context.close();
      } finally {
        await running?.server.close().catch(() => {});
        await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      }
    }
  } finally {
    delete process.env.__FRL_DIST;
    await browser.close().catch(() => {});
    await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
