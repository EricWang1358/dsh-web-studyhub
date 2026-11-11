/* global localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import * as workbench from '../lib/index.js';
import * as materialsPlugin from '../lib/plugins/materials.js';
import { createHostHandler } from '../lib/host.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

test('materials-only plugin composition lands directly on Materials and opens large-book advice + reader + translation without calling disabled contexts', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'modular-materials-only-'));
  const libraryRoot = join(root, 'library');
  const home = join(root, 'home');
  const ctx = new Context();
  const sessions = new Map([['study-preview', { header: { cwd: libraryRoot } }]]);
  ctx.provide('sessions', sessions);
  ctx.sessions = sessions;
  await ctx.plugin(workbench, { modular: true, libraryRoot });
  await ctx.plugin(materialsPlugin);
  assert.equal(ctx.studyRuntime.contextIds().includes('materials'), true);
  assert.equal(ctx.studyRuntime.contextIds().some(id => ['bank', 'study', 'authoring', 'generation', 'audio'].includes(id)), false);
  const runtime = ctx.studyRuntime.runtimeForLibrary(libraryRoot);
  await runtime.call('materials.document.import', {
    filename: 'paging.md',
    dataBase64: Buffer.from('# Virtual Memory\n\nPage tables map virtual pages to physical frames.\n\nTranslation lookaside buffers cache recent translations.\n', 'utf8').toString('base64'),
  });
  await runtime.call('materials.document.import', {
    filename: 'big-textbook.json',
    dataBase64: Buffer.from(JSON.stringify([
      { type: 'text', text: '# Chapter 1\n\nLarge textbook intro.', page_idx: 0 },
      { type: 'text', text: '# Chapter 35\n\nDeep chapter beyond page 300.', page_idx: 350 },
    ]), 'utf8').toString('base64'),
  });
  const handle = createHostHandler(ctx, { libraryRoot, modular: true });

  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot, home, port: 0, model: null, distDir });
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }

  const calledActions = [];
  const failedActions = [];
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    if (url.pathname === '/api/call' && route.request().method() === 'POST') {
      const payload = JSON.parse(route.request().postData() || '{}');
      const { action, args = {} } = payload;
      calledActions.push(action);
      if (action === 'binding.get' || action === 'binding.set') return route.continue();
      const res = await handle('call', { sessionId: 'study-preview', action, args });
      if (res.ok) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value: res.value }) });
      }
      failedActions.push({ action, message: res.error?.message || 'failed' });
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: res.error?.message || 'Study request failed', code: res.error?.code }) });
    }
    return route.continue();
  });

  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'en'); localStorage.setItem('study-autopilot', 'off'); });
  await page.goto(server.url);

  // Should land directly on Materials ('sources'), NOT on a FeatureDisabled page for 'library'!
  await page.locator('.sources-page').waitFor();
  const item = page.locator('.source-row, .source-doc').filter({ hasText: /Virtual Memory|paging/i }).first();
  await item.waitFor();
  assert.equal(await page.locator('[data-tour="nav-library"]').count(), 0, 'disabled Library nav entry is hidden');

  // Expand the >300-page LargeDocumentCard advice disclosure and nested PDF converter advice to verify zero retrieval.* / mineru.* leaks!
  const advice = page.locator('.source-doc__advice > summary').first();
  await advice.waitFor();
  await advice.click();
  await page.locator('.large-doc').waitFor();
  await page.locator('.large-doc__more > summary').first().click();

  // Open the document in SourceReaderDialog.
  await item.locator('.source-main').click();
  const viewer = page.locator('.study-document-viewer');
  await viewer.waitFor();
  await viewer.getByText('Page tables map virtual pages').waitFor();

  // Disabled cross-plugin actions (AI Generate button, WrongPanel) must not be rendered in reader toolbar.
  assert.equal(await viewer.locator('[data-tour="reader-generate"]').count(), 0, 'AI generate button hidden when generation/bank disabled');

  // Open More › Translate… dialog: single-passage / glossary / display remain available, while generation.translation.* is never called!
  await viewer.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: /Translate/i }).click();
  const trDialog = page.locator('.tr-dialog');
  await trDialog.waitFor();
  assert.equal(await trDialog.locator('.tr-scope').count(), 0, 'batch page/chapter scopes hidden when generation context is disabled');

  assert.equal(
    calledActions.some(a =>
      a.startsWith('generation.') ||
      a.startsWith('retrieval.') ||
      a.startsWith('mineru.') ||
      a.startsWith('wrongbook.') ||
      a.startsWith('audio.') ||
      a.startsWith('bank.')
    ),
    false,
    `disabled contexts must not be called, saw: ${calledActions.join(', ')}`,
  );
  assert.deepEqual(failedActions, []);
  assert.deepEqual(pageErrors, []);
});
