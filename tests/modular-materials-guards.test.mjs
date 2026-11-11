/* global localStorage, File */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { Context } from '@deepseek-ai/cordis';
import * as workbench from '../lib/index.js';
import * as materialsPlugin from '../lib/plugins/materials.js';
import { createHostHandler } from '../lib/host.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

const uiMod = await loadUi(`
  export { fallbackLandingPage } from './ui/app/use-initial-landing.js';
  export { runImport } from './ui/ImportHub.jsx';
  export { selectionMenu } from './ui/document-preview/marks/model.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const { fallbackLandingPage, runImport, selectionMenu, setUiLanguage } = uiMod;

test('fallbackLandingPage chooses the first available main or grouped page when library is disabled', () => {
  assert.equal(fallbackLandingPage({ contexts: ['library', 'bank', 'study'] }), 'library');
  assert.equal(fallbackLandingPage({ contexts: ['library', 'materials'] }), 'sources');
  assert.equal(fallbackLandingPage({ contexts: ['library', 'notes'] }), 'tasks');
  assert.equal(fallbackLandingPage({ contexts: ['library'] }), 'tasks');
});

test('runImport blocks deck JSON with a clear permanent message when deckImport is disabled, while allowing converted textbook JSON', async () => {
  const calls = [];
  const call = async (action, args) => {
    calls.push(action);
    if (action === 'materials.document.import') {
      return { documentId: 'doc-1', sourceIds: ['src-1'], document: { title: args.filename, format: 'json', sources: [{ id: 'src-1', document: { converter: 'mineru' } }] } };
    }
    throw new Error(`Unexpected call: ${action}`);
  };

  const deckFile = new File([JSON.stringify({ title: 'OS Quiz', cards: [{ prompt: 'Q', answer: 'A' }] })], 'os-deck.json', { type: 'application/json' });
  setUiLanguage('zh');
  const zhRes = await runImport([deckFile], { call, deckImport: false });
  assert.equal(zhRes[0].status, 'error');
  assert.equal(zhRes[0].permanent, true);
  assert.match(zhRes[0].error, /需要启用题库与出题组件/);
  assert.deepEqual(calls, [], 'draft.import.propose must not be called when deckImport is false');

  setUiLanguage('en');
  try {
    const enRes = await runImport([deckFile], { call, deckImport: false });
    assert.match(enRes[0].error, /turn on the question bank and authoring components/i);
  } finally {
    setUiLanguage('zh');
  }

  const convertedJson = JSON.stringify([
    { type: 'text', text: 'Chapter 1 Operating Systems', page_idx: 0 },
    { type: 'text', text: 'Processes and threads overview.', page_idx: 1 },
  ]);
  const bookFile = new File([convertedJson], 'os-book.json', { type: 'application/json' });
  const bookRes = await runImport([bookFile], { call, deckImport: false });
  assert.equal(bookRes[0].status, 'done');
  assert.equal(bookRes[0].result.kind, 'document');
  assert.deepEqual(calls, ['materials.document.import']);
});

test('selectionMenu hides mark:queue when canQueue is false while preserving strokes, explain, and existing unmark:queue', () => {
  const withoutQueue = selectionMenu({ here: [], explain: 'ready', canQueue: false });
  assert.equal(withoutQueue.some(item => item.id === 'mark:queue'), false);
  assert.equal(withoutQueue.some(item => item.id === 'mark:underline'), true);
  assert.equal(withoutQueue.some(item => item.id === 'explain'), true);

  const existingQueue = selectionMenu({ here: [{ id: 'q1', style: 'queue' }], explain: 'ready', canQueue: false });
  assert.equal(existingQueue.some(item => item.id === 'unmark:queue'), true, 'existing queue mark can still be removed');
});

test('ESLint context-boundaries/no-private-context-import blocks cross-context private imports and permits contracts.js', async () => {
  const eslint = new ESLint({ cwd: repoRoot });
  const filePath = join(repoRoot, 'lib/contexts/notes/jobs/note-generate.js');
  const rootContextFile = join(repoRoot, 'lib/contexts/notes/index.js');

  const badStatic = await eslint.lintText(`import { view } from '../../audio/jobs/view.js';\nexport const x = view;\n`, { filePath });
  assert.ok(badStatic[0].messages.some(m => m.ruleId === 'context-boundaries/no-private-context-import'), 'static relative import into sibling context must fail');

  const badDynamic = await eslint.lintText(`export const load = () => import('../../audio/index.js');\n`, { filePath });
  assert.ok(badDynamic[0].messages.some(m => m.ruleId === 'context-boundaries/no-private-context-import'), 'dynamic import into sibling context must fail');

  const badRootDynamic = await eslint.lintText(`export const load = () => import('../audio/index.js');\n`, { filePath: rootContextFile });
  assert.ok(badRootDynamic[0].messages.some(m => m.ruleId === 'context-boundaries/no-private-context-import'), '1-level dynamic import into sibling context must fail');

  const goodContract = await eslint.lintText(`import * as audioContract from '../../audio/contracts.js';\nimport * as own from '../note-generation.js';\nexport const ok = [audioContract, own];\n`, { filePath });
  assert.deepEqual(goodContract[0].messages.filter(m => m.ruleId === 'context-boundaries/no-private-context-import'), []);
});

test('materials-only plugin composition lands directly on Materials and opens reader + translation without calling disabled contexts', { timeout: 120000 }, async t => {
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

  assert.equal(calledActions.some(a => a.startsWith('generation.') || a.startsWith('wrongbook.') || a.startsWith('audio.')), false,
    `disabled contexts must not be called, saw: ${calledActions.join(', ')}`);
  assert.deepEqual(failedActions, []);
  assert.deepEqual(pageErrors, []);
});
