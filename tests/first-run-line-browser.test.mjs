/* global document, window -- page.evaluate callbacks run in the browser */
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
import { drainLayoutStability, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';

/* 3.6 D2 in the browser preview, on an empty temporary library: the first-run line from no model to the first question. No model (step 1 open with the gate's
   steps, 重新检查 the one primary, no bounce to the settings) → a model (the same library opened again with the fake model: step 1 ticked) → 添加资料 (the
   existing import, landing on 创建题组 with the file ticked) → generating (the run's card inside step 3, drawn once, no 查看进度) → the draft (发布并开始练
   with 先看看草稿, and nothing moved when the run finished) → publishing (the first question; back on the library the line is gone and the home is back).
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

        /* ---- 添加资料: the existing import, on to 创建题组 with the file ticked ---- */
        await page.locator('.first-run .sh-btn--primary').click();
        const dialog = page.locator('dialog[open], [role="dialog"]').first();
        await dialog.waitFor({ timeout: 30000 });
        await dialog.locator('.sh-drop input[type="file"]').first().setInputFiles({ name: '第3讲 进程与线程.md', mimeType: 'text/markdown',
          buffer: Buffer.from('# 第3讲 进程与线程\n\n## 进程\n\n进程是资源分配的单位，拥有独立的地址空间。\n\n## 线程\n\n线程是调度的单位，同一进程的线程共享地址空间。\n') });
        await page.locator('.generate-page').waitFor({ timeout: 60000 });
        await until(async () => (await page.locator('.generate-page input[type="checkbox"]:checked').count()) > 0, 'the material is ticked on 创建题组');

        // Back on the library before generating: step 2 ticked with the title, step 3 open with 出第一组题.
        await page.locator('[data-tour="nav-library"]').first().dispatchEvent('click');
        await page.locator('.first-run').waitFor({ timeout: 30000 });
        await until(async () => (await status(page, 'material')) === 'done', 'step 2 is ticked');
        assert.match(await page.locator('.frl-step[data-step="material"]').innerText(), /第3讲 进程与线程(\.md)? · 已添加/, 'the material by the title 资料 shows');
        assert.match(await page.locator('.frl-step[data-step="material"]').innerText(), /再加一份/);
        assert.equal(await openStep(page), 'deck');
        assert.equal(await primaries(page), 1);
        assert.equal((await page.locator('.first-run .sh-btn--primary').innerText()).trim(), '出第一组题');
        await settleAnimations(page);
        await shot(page, `03-material-added-${width}`);

        /* ---- 出第一组题 → 创建题组 (D4 will generate from the line) → the run's card inside step 3 ---- */
        await page.locator('.first-run .sh-btn--primary').click();
        await page.locator('.generate-page').waitFor({ timeout: 30000 });
        await until(async () => (await page.locator('.generate-page input[type="checkbox"]:checked').count()) > 0, 'the material is ticked again');
        await page.locator('[data-tour="generate-submit"]').first().click();
        await page.locator('.first-run').waitFor({ timeout: 30000 });
        await until(async () => (await status(page, 'deck')) === 'generating', 'step 3 says the run is going', { timeoutMs: 30000 });
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
        }
        await page.locator('.options .option').first().waitFor({ timeout: 60000 });
        await shot(page, `06-first-question-${width}`);
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
