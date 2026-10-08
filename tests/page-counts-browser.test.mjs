import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { frames, holdActions, openPage, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';

/* One book, one number. A converted textbook of 404 pages with text whose original PDF has 422 sits on the 资料 page with its 大教材建议 open, in a course that
   has 4 more pages in other materials without an index. The row, the index badge, the advice title and the card all say 404; the original's 422 is said once,
   beside the count; the course line counts the course and names the materials; the button under a finished book is the quiet one. */

const COURSE = 'Architecting Software Solutions', HASH = 'e'.repeat(64);

async function seedBook(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const at = '2026-10-01T08:00:00.000Z';
  await service.store.update((state) => {
    for (let page = 1; page <= 404; page++)
      state.sources.push({ id: `bk-p${page}`, title: `Software Architecture · p.${page}`, text: `Page ${page} of the book: coupling, cohesion and the architecture characteristics.`, createdAt: at, courses: [COURSE],
        document: { id: HASH, page, totalPages: 422, format: 'pdf', filename: 'software-architecture.md', bookTitle: 'Software Architecture', origin: 'converted', converter: 'mineru', extractionVersion: 2, materialId: `document-${HASH}-md` } });
    for (let page = 1; page <= 3; page++)
      state.sources.push({ id: `ch3-p${page}`, title: `Chapter 3 handout · ${page}`, text: `Handout page ${page}: layered and microservice styles compared.`, createdAt: at, courses: [COURSE],
        document: { id: 'f'.repeat(64), page, totalPages: 3, filename: 'Chapter 3 handout.pdf', extractionVersion: 2, format: 'pdf' } });
    state.sources.push({ id: 'note-1', title: 'Revision note', text: 'Trade-offs are the first law of software architecture.', createdAt: at, courses: [COURSE] });
  });
  return { ids: ['bk-p1'] };
}

const status = { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [], boot: 'boot-1',
  companion: { id: 'mcp:mcp__studyhub__query_documents', running: true }, extension: { canInstall: true, installed: true, enabled: true, version: '3.0.1', desktop: false } };
const plan = { course: COURSE, pages: 408, toIndex: 4, unchanged: 404, toRemove: 0, chars: 300, firstRun: false, modelMb: 90, canIndex: true,
  documents: 3, missing: [{ title: 'Chapter 3 handout.pdf', pages: 3 }, { title: 'Revision note', pages: 1 }], missingDocuments: 2 };

test('the row, the badge, the advice and the card agree on 404 pages, and the course line names whose pages are missing (1280 and 420 px)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-counts-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: seedBook });
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 1400 });
      const hold = await holdActions(page, ['retrieval.status', 'retrieval.index.coverage', 'retrieval.index.plan']);
      await page.goto(running.server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      const nav = page.locator('[data-tour="nav-sources"]').first();
      await nav.waitFor({ state: 'visible' });
      await nav.dispatchEvent('click');
      const row = page.locator(`.sources-page .source-doc[data-document-key*="${HASH}"]`).first();
      await row.waitFor({ timeout: 30000 });
      await until(() => hold.seen('retrieval.status') && hold.seen('retrieval.index.coverage'), 'the page to ask for the status and the coverage');
      const ids = (await running.api('snapshot')).sources.map((source) => source.id);
      hold.release('retrieval.status', status);
      hold.release('retrieval.index.coverage', { indexed: ids.filter((id) => id.startsWith('bk-p')), stale: [], missing: ids.filter((id) => !id.startsWith('bk-p')), hasIndex: true, canIndex: true, building: null });
      hold.release('retrieval.index.plan', plan);
      await row.locator('.index-badge').waitFor({ timeout: 30000 });
      await row.locator('.source-doc__advice > summary').click();
      await row.locator('.extension-panel__plan[role="status"]').waitFor({ timeout: 30000 });
      await settleAnimations(page);
      await frames(page, 4);
      const words = await row.evaluate((element) => ({
        line: element.querySelector('.source-main small:nth-of-type(2)')?.innerText ?? '',
        badge: element.querySelector('.index-badge')?.innerText ?? '',
        advice: element.querySelector('.sh-disclosure__label')?.innerText ?? '',
        reason: element.querySelector('.large-doc__reason')?.innerText ?? '',
        course: element.querySelector('.extension-panel__plan[role="status"]')?.innerText ?? '',
        note: element.querySelector('.extension-panel__plan--note')?.innerText ?? '',
        button: element.querySelector('.extension-panel__action button')?.innerText ?? '',
        buttonClass: element.querySelector('.extension-panel__action button')?.className ?? '',
        shown: element.innerText,
      }));
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      assert.match(words.line, /404 页/);
      assert.match(words.badge, /404\/404 页/);
      assert.match(words.advice, /这份资料有 404 页/);
      assert.match(words.reason, /有 404 页/);
      assert.equal((words.shown.match(/422/g) || []).length, 1, `${width}px: the original's 422 is said once, in what a reader sees`);
      assert.match(words.line, /原 PDF 422 页/);
      assert.match(words.course, /共 408 页（含 3 份资料）：其中 4 页还没建索引，来自《Chapter 3 handout》（3 页）、《Revision note》（1 页）；404 页已经建好/);
      assert.match(words.note, /这份资料自己的 404 页已经全部建好/);
      assert.equal(words.button, '为这门课补建 4 页索引');
      assert.match(words.buttonClass, /sh-btn--secondary/);
      // The hover of the count says what the 18 are.
      await row.locator('.source-doc__gap').hover();
      const tip = page.locator('.sh-tooltip:popover-open').first();
      await tip.waitFor({ timeout: 5000 });
      assert.match(await tip.innerText(), /404 页有文字[^]*18 页/);
      await page.mouse.move(0, 0);
      // Nothing of the card reaches past the window: the course picker used to push the whole index box wider than its card when a course name was long.
      const reach = await row.evaluate((element, limit) => [...element.querySelectorAll('.extension-panel__index, .extension-panel__index *')].filter((node) => node.getBoundingClientRect().right > limit + 1).length, width);
      assert.equal(reach, 0, `${width}px: nothing in the index box reaches past the window`);
      if (process.env.PAGE_COUNTS_SHOTS) {
        await row.screenshot({ path: join(process.env.PAGE_COUNTS_SHOTS, `row-${width}.png`) });
        await row.locator('.extension-panel').scrollIntoViewIfNeeded();
        await row.locator('.extension-panel').screenshot({ path: join(process.env.PAGE_COUNTS_SHOTS, `card-${width}.png`) });
        await row.locator('.extension-panel__index').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(process.env.PAGE_COUNTS_SHOTS, `view-${width}.png`) });
      }
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
