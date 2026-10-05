/* global localStorage, document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

// Issue #204: the estimate line must take the same box while it loads and once it is ready, and in an action column it must not widen the group.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { TokenEstimateView } from './ui/TokenUsage.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text', '.jsx': 'jsx' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { TokenEstimateView } = module.exports;
const h = React.createElement;
const html = props => renderToStaticMarkup(h(TokenEstimateView, props));
const estimate = { feature: 'generate', blocked: false, notes: [], calls: { low: 4, high: 11 }, totalTokens: { low: 32900, high: 57300 }, inputTokens: { low: 30000, high: 50000 },
  uncachedInputTokens: { low: 30000, high: 50000 }, cacheReadTokens: { low: 0, high: 0 }, outputTokens: { low: 2900, high: 7300 }, stages: [] };

test('the estimate line has one outer box and one reserved line whether it is loading or ready', () => {
  const loading = html({ state: { status: 'loading' } }), ready = html({ state: { status: 'ready', estimate } });
  const outer = markup => markup.match(/^<div class="([^"]*)"/)[1];
  assert.equal(outer(loading), outer(ready), 'the same classes on the outer box');
  for (const markup of [loading, ready]) assert.match(markup, /<p class="token-estimate__line[^"]*">/, 'both states draw the line');
  assert.match(loading, /data-status="loading"/);
  assert.match(ready, /data-status="ready"/);
  assert.match(loading, /token-estimate__info--slot/, 'the loading line keeps the room of the info button');
  assert.match(loading, /正在估算/);
});

test('align="end" is a class of the outer box, so an action column can right-align the line', () => {
  assert.match(html({ state: { status: 'loading' }, align: 'end' }), /^<div class="token-estimate token-estimate--end"/);
  assert.doesNotMatch(html({ state: { status: 'loading' } }), /token-estimate--end/);
  assert.equal(html({ state: { status: 'idle' } }).includes('token-estimate__line'), false, 'nothing to estimate draws no line');
});

let browser, unavailable = false;
try { browser = await launchChromium(); }
catch (error) { if (!/Executable doesn't exist|browserType\.launch/.test(String(error.message))) throw error; unavailable = true; }
test.after(() => browser?.close());

const shots = join(process.cwd(), 'output', 'wave5-c');

test('the 继续补齐 button and 打开 stay put when the estimate resolves (1280 and 420)', { skip: unavailable, timeout: 240000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'estimate-shift-'));
  const service = new StudyService(join(root, 'library'));
  const card = id => ({ id, kind: 'quiz', topic: 'Topic', objective: 'Recall', prompt: id, answer: 'A', hint: '', explanation: '', misconception: '', citations: [],
    options: [{ id: 'a', text: 'A', correct: true, explanation: '' }, { id: 'b', text: 'B', correct: false, explanation: '' }] });
  await service.store.update(state => {
    state.sources.push({ id: 's1', title: 'Lecture 1', text: 'Evidence about replication and consistency. '.repeat(40), createdAt: '2026-09-01T00:00:00Z' });
    state.drafts.push({ id: 'draft-short', title: 'A draft that came out short', cards: [card('c1'), card('c2')], createdAt: '2026-09-02T00:00:00Z', version: 1,
      editorial: { requested: 5, generation: { sourceIds: ['s1'], kind: 'quiz' }, parts: 1, completedParts: 1 } });
  });
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: createFakeModel({ latencyMs: 10, usage: true }), distDir });
  t.after(async () => { await server.close(); await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await mkdir(shots, { recursive: true });
  for (const width of [1280, 420]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let release; const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/call', async route => { if (/usage\.estimate/.test(route.request().postData() || '')) await gate; await route.continue(); });
    await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-autopilot', 'off'); });
    await page.goto(server.url);
    const topup = page.locator('.draft-row .draft-topup').first();
    await topup.waitFor({ timeout: 30000 });
    await page.locator('.draft-topup [data-token-estimate][data-status="loading"]').waitFor({ timeout: 30000 });
    const measure = () => page.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector)?.getBoundingClientRect(); return r && { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right }; };
      return { button: box('.draft-topup .sh-btn'), open: box('.draft-open > span:last-child'), topup: box('.draft-topup'), estimate: box('.draft-topup [data-token-estimate]'),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    await page.locator('.draft-row').first().scrollIntoViewIfNeeded();
    const before = await measure();
    await page.locator('.draft-row').first().screenshot({ path: join(shots, `estimate-before-${width}.png`) });
    release();
    await page.locator('.draft-topup .token-estimate__line:not(.token-estimate__line--loading)').waitFor({ timeout: 30000 });
    const after = await measure();
    await page.locator('.draft-row').first().screenshot({ path: join(shots, `estimate-after-${width}.png`) });
    const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 0.5, `${width}px: ${what} moved from ${a} to ${b}`);
    near(before.button.x, after.button.x, '继续补齐 x');
    near(before.button.right, after.button.right, '继续补齐 right edge');
    near(before.open.x, after.open.x, '打开 x');
    near(before.topup.w, after.topup.w, 'the action group width');
    near(before.estimate.h, after.estimate.h, 'the estimate line height');
    assert.ok(after.estimate.right <= after.button.right + 0.5 && after.estimate.x >= after.topup.x - 0.5, `${width}px: the estimate stays inside the action column`);
    assert.ok(after.overflow <= 0, `${width}px: no horizontal scroll`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
