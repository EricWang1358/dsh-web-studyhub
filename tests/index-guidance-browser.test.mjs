/* global document, window -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { frames, holdActions, openPage, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* A book of 513 pages sits ticked on 创建题组 with no search index (owner 2026-11-06: nobody saw where the index is built, or what it is for). The shortcut line above
   the list says the index is not built, its hover says what it is for and that it runs on this computer and uses no tokens, and 去建立索引 opens 设置 › 检索扩展
   with the book's course already chosen, where the panel says the same in one line. Once the coverage says the book is indexed, the line is gone.
   INDEX_GUIDANCE_SHOTS=<dir> writes screenshots at 1280 and 420 px. */

const COURSE = 'Architecting Software Solutions', HASH = 'd'.repeat(64), SHOTS = process.env.INDEX_GUIDANCE_SHOTS;
const PAGES = 513;

async function seedBook(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const at = '2026-10-01T08:00:00.000Z';
  await service.store.update((state) => {
    for (let page = 1; page <= PAGES; page++)
      state.sources.push({ id: `bk-p${page}`, title: `Software Architecture · p.${page}`, text: `Page ${page} of the book: coupling, cohesion and the architecture characteristics.`, createdAt: at, courses: [COURSE],
        document: { id: HASH, page, totalPages: PAGES, format: 'pdf', filename: 'software-architecture.pdf', bookTitle: 'Software Architecture', extractionVersion: 2, materialId: `d${HASH}` } });
  });
}

const running = { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [], boot: 'boot-1',
  companion: { id: 'mcp:mcp__studyhub__query_documents', running: true }, extension: { canInstall: true, installed: true, enabled: true, version: '3.0.1', desktop: false } };
const plan = { course: COURSE, pages: PAGES, toIndex: PAGES, unchanged: 0, toRemove: 0, chars: 90000, firstRun: true, modelMb: 90, canIndex: true, documents: 1, missing: [{ title: 'Software Architecture', pages: PAGES }], missingDocuments: 1 };
const none = (ids) => ({ indexed: [], stale: [], missing: ids, hasIndex: false, canIndex: true, building: null });

test('a 513-page book with no index: the shortcut line on 创建题组 explains itself on hover; its button opens the index panel with the course chosen, and the panel says it is local and free of tokens (1280 and 420 px)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-index-guidance-dist-'));
  await buildPreview({ outdir: dist });
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  const server = await startLateServer({ distDir: dist, seed: seedBook });
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, server, { width, height: 1100 });
      const hold = await holdActions(page, ['retrieval.status', 'retrieval.index.coverage', 'retrieval.index.plan']);
      await page.goto(server.server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      await (await revealNavRow(page, 'generate')).dispatchEvent('click');
      await page.locator('.generate-page form').waitFor({ timeout: 30000 });
      await until(() => hold.seen('retrieval.index.coverage'), 'the page to ask for the coverage');
      const ids = (await server.api('snapshot')).sources.map((source) => source.id);
      hold.release('retrieval.status', running);
      hold.release('retrieval.index.coverage', none(ids));
      hold.release('retrieval.index.plan', plan);
      const gap = page.locator('[data-index-gap]').first();
      await gap.waitFor({ timeout: 30000 });
      await settleAnimations(page);
      await frames(page, 3);
      assert.match(await gap.innerText(), /有 1 份资料的索引还没建完/);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${width}px: no sideways scroll`);
      // The hover has the facts.
      await gap.locator('span[tabindex="0"]').hover();
      const tip = page.locator('.sh-tooltip:popover-open').first();
      await tip.waitFor({ timeout: 5000 });
      assert.match(await tip.innerText(), /先建立检索索引：整本出题时只读相关页面，本机计算、不耗 token[^]*约 90 MB[^]*主要针对英文/);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `generate-hint-${width}.png`) });
      await page.mouse.move(0, 0);
      // The button goes to 设置 › 检索扩展 with the book's course chosen, and the panel says what the index costs and is for.
      await gap.getByRole('button', { name: '去建立索引' }).click();
      const note = page.locator('[data-index-note]').first();
      await note.waitFor({ timeout: 30000 });
      await page.locator('.extension-panel__course').first().waitFor({ timeout: 30000 });
      await until(async () => (await page.locator('.extension-panel__course').first().innerText()).includes(COURSE), 'the course of the book to be chosen');
      assert.match(await note.innerText(), /在这台电脑上建索引：不调用 AI、不耗 token，资料不离开电脑。建好后，整本书出题只读相关页面。/);
      assert.match(await note.innerText(), /首次需要下载约 90 MB/);
      await settleAnimations(page);
      await note.scrollIntoViewIfNeeded();
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `panel-note-${width}.png`) });
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await server.close(); await rm(dist, { recursive: true, force: true }); }
});

test('an indexed book shows no shortcut line', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-index-guidance-dist-'));
  await buildPreview({ outdir: dist });
  const server = await startLateServer({ distDir: dist, seed: seedBook });
  try {
    const { page, errors, context } = await openPage(browser, server, { width: 1280, height: 1100 });
    const hold = await holdActions(page, ['retrieval.status', 'retrieval.index.coverage', 'retrieval.index.plan']);
    await page.goto(server.server.url);
    await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
    await (await revealNavRow(page, 'generate')).dispatchEvent('click');
    await page.locator('.generate-page form').waitFor({ timeout: 30000 });
    await until(() => hold.seen('retrieval.index.coverage'), 'the page to ask for the coverage');
    const ids = (await server.api('snapshot')).sources.map((source) => source.id);
    hold.release('retrieval.status', running);
    hold.release('retrieval.index.coverage', { indexed: ids, stale: [], missing: [], hasIndex: true, canIndex: true, building: null });
    hold.release('retrieval.index.plan', { ...plan, toIndex: 0, unchanged: PAGES, firstRun: false });
    await page.locator('.source-picker .index-badge').first().waitFor({ timeout: 30000 });
    await settleAnimations(page);
    assert.equal(await page.locator('[data-index-gap]').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); await server.close(); await rm(dist, { recursive: true, force: true }); }
});
