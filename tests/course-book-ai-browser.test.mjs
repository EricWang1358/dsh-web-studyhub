/* global window document MouseEvent */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { settleJob } from './helpers/wait.mjs';

/* 复习全书 M4 in the real page at 1280 and 420 px (docs/plans/review-book.md): select words of a point's explanation → 弄懂 → a visible task → the block
   appears right after the paragraph, 新 until 保留; 删除 takes it out; 「在这里加一段」 with an instruction puts a block under the heading; nothing scrolls
   sideways. The preview server's fake model answers. Screenshots go to COURSE_BOOK_AI_SHOTS when set. */

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => {
    state.sources.push(...sources);
    state.decks.push(...decks);
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
    const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'who', title: 'Stakeholders and concerns', anchors: [`${lecture}#1`] }] }],
      other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const page = state.sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes[0].children;
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
      body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} in one line [^1].`], explain: `The architect of ${leaf.title} writes each decision down with its reasons.\n\nA second paragraph about ${leaf.title}.`,
        cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }), createdAt: '2026-10-09T01:00:00.000Z' });
  });
  await service.dispose();
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.book-page *, .book-ai-ask *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});

/** Select `text` in a paragraph of a point (as the learner's drag does) and let the page see the mouseup. */
const selectWords = (page, text) => page.evaluate(words => {
  const paragraph = [...document.querySelectorAll('[data-book-point] .book-file p')].find(element => element.textContent.includes(words) && !element.closest('.book-ai'));
  const node = [...paragraph.childNodes].find(child => child.nodeType === 3 && child.textContent.includes(words)), at = node.textContent.indexOf(words);
  paragraph.scrollIntoView({ block: 'center', behavior: 'instant' });
  const range = document.createRange();
  range.setStart(node, at); range.setEnd(node, at + words.length);
  const selection = window.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  paragraph.closest('.book-read').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}, text);

/** The preview server has no job executor: the page's start of a 弄懂 task is answered by a second service over the same library with the unified runtime on
    (the real Job, the preview's fake model), and its job.status by how that Job ended. */
async function runTasksFor(page, root) {
  const fake = createFakeModel({ latencyMs: 5 });
  const service = new StudyService(root, { complete: fake, ...switchOptions('runtime', { complete: fake, paths: [] }) });
  const ended = new Map();
  await page.route('**/api/call', async route => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* not JSON */ }
    if (body.action === 'generation.courseBook.explain') {
      const started = await service.call('generation.courseBook.explain', body.args);
      ended.set(started.jobId, (await settleJob(service, started.jobId)).status);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: started }) });
    }
    if (body.action === 'job.status' && ended.has(body.args?.jobId)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: { status: ended.get(body.args.jobId) } }) });
    return route.continue();
  });
  return { dispose: () => service.dispose(), ended };
}

test('复习全书 弄懂 / 加一段: select → 弄懂 → the block right after its paragraph, 保留, 删除; 在这里加一段 under the heading (1280 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-ai-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_BOOK_AI_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      const tasks = await runTasksFor(page, join(running.base, 'library'));
      t.after(() => tasks.dispose());
      await page.goto(running.server.url);
      await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-book-line__open').click({ timeout: 30000 });
      await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
      if (await page.locator('.book-editor').count()) await page.locator('.book-header__mode').getByText('预览', { exact: true }).click();

      // Select words of the first point's explanation; the panel opens under them.
      const words = 'writes each decision down';
      await selectWords(page, words);
      await page.locator('.book-ai-ask [data-book-ai="explain"]').waitFor({ timeout: 10000 });
      let overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: the panel fits: ${JSON.stringify(overflow)}`);
      if (shots) await page.screenshot({ path: join(shots, `ai-panel-${width}.png`) });

      // The panel belongs to its selection: a click elsewhere, Escape, a new selection; scrolling keeps it; typed words and the focus inside keep it.
      const panel = page.locator('.book-ai-ask'), elsewhere = () => page.locator('.book-header [data-context-heading]').click();
      await elsewhere();
      await panel.waitFor({ state: 'detached', timeout: 5000 });
      await selectWords(page, words);
      await panel.waitFor({ timeout: 5000 });
      await page.evaluate(() => { for (const node of [document.scrollingElement, ...document.querySelectorAll('*')]) if (node.scrollHeight > node.clientHeight) node.scrollBy?.(0, 40); });
      await page.waitForTimeout(400);
      assert.equal(await panel.count(), 1, `${width}px: scrolling does not close it`);
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached', timeout: 5000 });
      await selectWords(page, words);
      await panel.waitFor({ timeout: 5000 });
      // A selection in another paragraph replaces the panel with a new one (its instruction box is empty again).
      await page.locator('.book-ai-ask .book-ai__input').fill('旧的');
      await selectWords(page, 'A second paragraph');
      await page.waitForFunction(() => document.querySelector('.book-ai-ask .book-ai__input')?.value === '', null, { timeout: 5000 });
      assert.equal(await panel.count(), 1, `${width}px: a selection in another paragraph replaces the panel`);
      await selectWords(page, words);
      await page.waitForTimeout(400);
      assert.equal(await panel.count(), 1);
      // The learner clicks the instruction box (the selection leaves the text) and types: it stays, even after a click elsewhere.
      await page.locator('.book-ai-ask .book-ai__input').click();
      await page.waitForTimeout(400);
      assert.equal(await panel.count(), 1, `${width}px: the focus inside keeps it`);
      await page.locator('.book-ai-ask .book-ai__input').fill('讲细点');
      await page.waitForTimeout(400);
      await elsewhere();
      await page.waitForTimeout(400);
      assert.equal(await panel.count(), 1, `${width}px: typed words keep it`);
      assert.equal(await page.locator('.book-ai-ask .book-ai__input').inputValue(), '讲细点');
      await page.locator('.book-ai-ask .book-ai__input').fill('');
      await elsewhere();
      await panel.waitFor({ state: 'detached', timeout: 5000 });
      await selectWords(page, words);
      await panel.waitFor({ timeout: 5000 });
      // The ×, a secondary way to close it.
      await page.locator('.book-ai-ask').getByRole('button', { name: '关闭' }).click();
      await panel.waitFor({ state: 'detached', timeout: 5000 });
      await selectWords(page, words);
      await page.locator('.book-ai-ask [data-book-ai="explain"]').click();
      // A task started from it is pending: the panel shows its state until the block appears, then closes.
      await page.locator('.book-ai-ask [data-book-ai="state"]').waitFor({ timeout: 10000 });
      await elsewhere();
      await page.waitForTimeout(400);
      assert.equal(await panel.count(), 1, `${width}px: a pending task keeps it`);
      const block = page.locator('.book-ai', { hasText: `关于：「${words}」` }).last();
      await block.waitFor({ timeout: 60000 });
      await panel.waitFor({ state: 'detached', timeout: 10000 });
      assert.deepEqual([...tasks.ended.values()], ['complete'], `${width}px: one task, run to the end`);
      const order = await block.evaluate((element, text) => {
        const paragraph = [...document.querySelectorAll('[data-book-point] .book-file p')].find(item => item.textContent.includes(text) && !item.closest('.book-ai'));
        const second = [...document.querySelectorAll('[data-book-point] .book-file p')].find(item => item.textContent.startsWith('A second paragraph'));
        return { after: !!(paragraph.compareDocumentPosition(element) & 4), before: !!(element.compareDocumentPosition(second) & 4) };
      }, words);
      assert.deepEqual(order, { after: true, before: true }, `${width}px: right after its paragraph, before the next one`);
      assert.equal(await block.getAttribute('data-ai-state'), 'new');
      assert.match(await block.innerText(), /资料原文/);
      assert.match(await block.innerText(), /补充（资料以外）/);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `ai-block-${width}.png`) });
      await block.getByText('保留', { exact: true }).click();
      await page.locator(`.book-ai[data-ai-state="kept"]`, { hasText: `关于：「${words}」` }).first().waitFor({ timeout: 30000 });
      await page.locator('.book-ai[data-ai-state="kept"]', { hasText: `关于：「${words}」` }).first().getByText('删除', { exact: true }).click();
      await page.locator('.book-ai', { hasText: `关于：「${words}」` }).first().waitFor({ state: 'detached', timeout: 30000 });

      // 在这里加一段: an instruction under the heading. It closes on a click elsewhere with an empty box, and on Escape; typed words keep it.
      await page.locator('[data-book-point] .book-point__add').first().click();
      await panel.waitFor({ timeout: 5000 });
      await elsewhere();
      await panel.waitFor({ state: 'detached', timeout: 5000 });
      await page.locator('[data-book-point] .book-point__add').first().click();
      await panel.waitFor({ timeout: 5000 });
      await page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached', timeout: 5000 });
      await page.locator('[data-book-point] .book-point__add').first().click();
      await page.locator('.book-ai-ask .book-ai__input').fill(`对比两种做法 ${width}`);
      await elsewhere();
      await page.waitForTimeout(400);
      assert.equal(await panel.count(), 1, `${width}px: typed words keep the box under a heading`);
      await page.locator('.book-ai-ask [data-book-ai="write"]').click();
      await panel.waitFor({ state: 'detached', timeout: 10000 });
      const here = page.locator('.book-ai', { hasText: `对比两种做法 ${width}` }).first();
      await here.waitFor({ timeout: 60000 });
      const top = await here.evaluate(element => {
        const point = element.closest('[data-book-point]'), add = point.querySelector('.book-point__add'), text = point.querySelector(':scope > .book-file');
        return !!(add.compareDocumentPosition(element) & 4) && !!(element.compareDocumentPosition(text) & 4);
      });
      assert.equal(top, true, `${width}px: under the heading, before the point's text`);
      overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      if (shots) await page.screenshot({ path: join(shots, `ai-here-${width}.png`) });
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
