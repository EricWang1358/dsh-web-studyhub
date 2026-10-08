/* global document, window, Node -- page.evaluate callbacks run in the browser */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, openPage, seedPickerLibrary, until } from '../scripts/qa/layout-late.mjs';

/* Model setup in the browser preview, on a library with no model (the preview host offers no DSH model panel, like DSH 0.2): Settings › 学习库与模型 says
   the model is not connected with the exact steps and no key field; 重新检查 reads the library again, says so when nothing changed and shows the new state
   when something did (here the answer to the next snapshot is changed at the network edge: DSH has the key now); 创建题组 shows the gate on top and
   its 前往设置 lands on that pane. At 1280 and 420 px with no sideways scroll. Screenshots go to MODEL_SETUP_SHOTS when it is set. */

const SHOTS = process.env.MODEL_SETUP_SHOTS || '';
const NOT_CONNECTED = { model: { ready: false, reason: 'no-credential', label: 'DeepSeek · V4 Flash', provider: 'deepseek', model: 'v4' }, modelReady: false };
const CONNECTED = { model: { ready: true, reason: 'ok', label: 'DeepSeek · V4 Flash', provider: 'deepseek', model: 'v4' }, modelReady: true };

/* One build, one browser and one preview on a library with no model, shared by the tests below and closed after them. */
let shared;
async function environment(t) {
  if (shared === undefined) {
    shared = (async () => {
      let browser;
      try { browser = await launchChromium(); } catch (error) { return { skip: `no Chromium to measure with: ${String(error.message).split('\n')[0]}` }; }
      scrubProcessEnv();
      const dist = await mkdtemp(join(tmpdir(), 'study-model-setup-dist-'));
      await buildPreview({ outdir: dist });
      const base = await mkdtemp(join(tmpdir(), 'study-model-setup-'));
      const root = join(base, 'library');
      await seedPickerLibrary(root, { documents: 8 });
      const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: null, distDir: dist });
      return { browser, server, close: async () => {
        await browser.close();
        await server.close();
        await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
        await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
      } };
    })();
  }
  const found = await shared;
  if (found.skip) { t.skip(found.skip); return null; }
  return found;
}
after(async () => { if (shared) await (await shared).close?.(); });

/** The snapshot answers as `state.patch` says; the page cannot tell it from the host's own answer. The real host changes its answer when a key is stored in DSH
 *  (the model status is part of what the snapshot's fingerprint covers), so the request is sent without the page's fingerprint: the full answer comes back. */
async function patched(page, state) {
  await page.route('**/api/call', async route => {
    let request = {};
    try { request = JSON.parse(route.request().postData() || '{}'); } catch { /* not JSON */ }
    if (request.action !== 'snapshot' || !state.patch) return route.continue();
    const response = await route.fetch({ postData: JSON.stringify({ ...request, args: { ...request.args, since: undefined } }) });
    const body = await response.json();
    if (body?.ok && body.value) Object.assign(body.value, state.patch);
    return route.fulfill({ response, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const shot = async (page, name) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); } };
const openApp = async (running, state, { width }) => {
  const opened = await openPage(running.browser, running, { lang: 'zh', theme: 'dark', width, height: 900 });
  await patched(opened.page, state);
  await opened.page.goto(running.server.url);
  await opened.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  return opened;
};
const go = async (page, name) => { await page.locator(`[data-tour="nav-${name}"]`).first().dispatchEvent('click'); await frames(page, 6); };
const modelPane = async page => {
  await go(page, 'settings');
  await page.locator('[data-category="model"]').first().dispatchEvent('click');
  await page.locator('[data-tour="settings-model"]').first().waitFor({ timeout: 30000 });
};

test('Settings › 学习库与模型: not connected with the steps, a re-check that says what it found, and the new state without a reload', { timeout: 600000 }, async t => {
  const running = await environment(t);
  if (!running) return;
  for (const width of [1280, 420]) {
    const state = { patch: NOT_CONNECTED };
    const { page, errors, context } = await openApp(running, state, { width });
    await modelPane(page);
    const status = page.locator('[data-model-status="missing"]');
    await status.waitFor({ timeout: 30000 });
    const words = await status.innerText();
    assert.match(words, /模型未连接/);
    assert.match(words, /已选择「DeepSeek · V4 Flash」，但 DSH 里还没有它的 API Key。/);
    assert.match(words, /在 DSH 打开「设置 › 模型」，在「DeepSeek」卡片填入 API Key 并保存/);
    assert.equal(await status.locator('li').count(), 2, 'the key, then coming back');
    assert.equal(await page.locator('[data-tour="settings-model"] input[type="password"], [data-tour="settings-model"] input[name*="key" i]').count(), 0, 'StudyHub has no key field');
    assert.equal(await status.getByRole('button', { name: /前往设置|打开模型设置/ }).count(), 0, 'this host cannot open DSH, so no button that would only land here');
    assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll`);
    await shot(page, `pane-not-connected-${width}`);

    // Nothing changed: the click says so.
    await status.getByRole('button', { name: '重新检查' }).click();
    await until(async () => /已重新检查，目前还没有连上。/.test(await status.innerText()), 'the re-check says nothing changed');
    await shot(page, `pane-checked-${width}`);

    // DSH has the key now: the next snapshot says so; the re-check shows it in place.
    state.patch = CONNECTED;
    await status.getByRole('button', { name: '重新检查' }).click();
    const connected = page.locator('[data-model-status="connected"]');
    await connected.waitFor({ timeout: 30000 });
    assert.match(await connected.innerText(), /模型已连接：DeepSeek · V4 Flash/);
    assert.equal(await page.locator('[data-model-status="missing"]').count(), 0, 'the gate is gone');
    assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll when connected`);
    await shot(page, `pane-connected-${width}`);
    assert.deepEqual(errors, [], 'no page errors');
    await context.close();
  }
});

test('创建题组 without a model: the gate on top, the submit off, and 前往设置 lands on the pane with the steps', { timeout: 600000 }, async t => {
  const running = await environment(t);
  if (!running) return;
  for (const width of [1280, 420]) {
    const { page, errors, context } = await openApp(running, { patch: null }, { width });
    await go(page, 'generate');
    const form = page.locator('.generate-page form').first();
    await form.waitFor({ timeout: 30000 });
    const banner = page.locator('.generate-page .sh-banner--warning').first();
    assert.match(await banner.innerText(), /还没有可用的 AI 模型/);
    const above = await page.evaluate(() => {
      const first = document.querySelector('.generate-page .sh-banner--warning'), second = document.querySelector('.generate-page form');
      return !!first && !!second && !!(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    assert.ok(above, 'the banner is above the form');
    assert.equal(await page.locator('.generate-page .sh-setup').count(), 0, 'no block gate under the form');
    assert.equal(await page.locator('[data-tour="generate-submit"]').first().isDisabled(), true, 'the submit is off');
    assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll`);
    await shot(page, `generate-${width}`);
    await banner.getByRole('button', { name: '前往设置' }).click();
    await page.locator('[data-tour="settings-model"]').first().waitFor({ timeout: 30000 });
    const missing = page.locator('[data-model-status="missing"]');
    await missing.waitFor({ timeout: 30000 });
    assert.match(await missing.innerText(), /还没有选择 AI 模型。/);
    assert.equal(await missing.locator('li').count(), 3, 'a key, a model, coming back');
    assert.deepEqual(errors, [], 'no page errors');
    await context.close();
  }
});
