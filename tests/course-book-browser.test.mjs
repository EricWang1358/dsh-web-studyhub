/* global window document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { holdActions, openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { settleJob } from './helpers/wait.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { bookModel } from './helpers/course-book-model.mjs';

/* 复习全书 in the real page at 1280 and 420 px. The library shaped like the owner's (134 materials, a sample paper) gets its outline and its book from the real
   task with a fake model; then the 总纲 page: the book's button is quiet (the notes are current), an opened knowledge point shows its notes (考情, 知识梳理, 讲解,
   补充, 出处), a 角标 opens the original in the reader, nothing scrolls sideways. A course with an outline and no book offers 生成复习全书 as the one main button and
   one click asks for the task. Screenshots go to COURSE_BOOK_SHOTS when it is set. */

const PAPER = 'doc:document-paper-2025', at = '2026-10-01T08:00:00.000Z';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const fake = bookModel();
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary({ paper: true });
  await service.store.update(state => {
    state.sources.push(...sources,
      { id: 'db-notes', title: 'Database notes', text: 'Indexes fact 1: a B-tree keeps keys sorted. Indexes fact 2: a hash index answers equality.', createdAt: at, courses: ['DB'] });
    state.decks.push(...decks, { id: 'db-deck', title: 'DB deck', course: 'DB', cards: [{ id: 'db1', kind: 'flashcard', topic: 'Indexes', prompt: 'What does a B-tree keep?',
      answer: 'Sorted keys.', citations: [{ sourceId: 'db-notes', quote: 'Indexes fact 1: a B-tree keeps keys sorted.' }] }] });
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });
  for (const [action, args] of [['generation.courseBook.build', { course: COURSE, papers: [PAPER] }], ['generation.courseOutline.build', { course: 'DB' }]]) {
    const job = await settleJob(service, (await service.call(action, args)).jobId);
    if (job.status !== 'complete') throw new Error(`${action} did not finish: ${job.status}`);
  }
  await service.dispose();
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.outline-page *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});

test('复习全书 on the 总纲 page: a knowledge point opens to its notes, a 角标 opens the original; a course without a book offers 生成复习全书 (1280 and 420 px)', { timeout: 480000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-course-book-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_BOOK_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 1000 });
      // The synthetic library has no document records, so the reader's translation list of a material is refused (400): that alone is the fixture's, not the page's.
      const refused = [];
      page.on('response', response => { if (response.status() >= 400) refused.push(/"action":"([^"]+)"/.exec(response.request().postData() || '')?.[1] ?? response.url()); });
      await page.goto(running.server.url);
      await page.locator('.outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-tree--book').waitFor({ timeout: 30000 });
      const line = page.locator('.outline-book-line');
      assert.match(await line.innerText(), /更新全书/);
      assert.equal(await line.locator('.sh-btn--primary').count(), 0, `${width}px: the notes are current, nothing is the main action`);
      assert.doesNotMatch(await line.innerText(), /资料有更新/);
      // 2.2 In practice › Views and viewpoints: tested by the sample paper.
      await page.locator('.outline-row[data-kind="section"]', { hasText: /2\.2\s*In practice/ }).locator('[data-outline-toggle]').click();
      const point = page.locator('.outline-row[data-kind="point"]', { hasText: 'Views and viewpoints' }).first();
      await point.waitFor();
      await point.locator('[data-outline-toggle]').click();
      const notes = point.locator('.outline-notes');
      await notes.waitFor({ timeout: 30000 });
      const text = (await notes.innerText()).replace(/\s+/g, ' ');
      assert.match(text, /考情 样卷考过。 Asked as: /, `${width}px: ${text.slice(0, 200)}`);
      assert.match(text, /知识梳理 .*讲解 .*补充 资料以外 .*1\. 「Views and viewpoints fact 0/);
      assert.ok(await notes.locator('.md-cite__mark').count() >= 1, 'the 角标 are buttons in the text');
      const overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) await point.screenshot({ path: join(shots, `book-notes-${width}.png`) });
      await notes.locator('.md-cite__mark').first().click();
      const reader = page.locator('.source-preview');
      await reader.waitFor({ timeout: 30000 });
      assert.match(await reader.innerText(), /01\. Introduction to Solution Architecture v2\.1/, `${width}px: the reader opens the original`);
      await reader.getByText(/Views and viewpoints fact 0/).first().waitFor({ timeout: 30000 });
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `book-cite-${width}.png`) });
      assert.deepEqual([...new Set(refused)].filter(action => action !== 'materials.translation.list'), [], `${width}px: no other request refused`);
      assert.deepEqual(errors.filter(line => !(refused.length && /status of 400/.test(line))), [], `${width}px: no page errors`);
      await context.close();

      // A course with an outline and no book: 生成复习全书 is the one main button; one click asks for the task.
      await running.api('focus.set', { course: 'DB' });
      const other = await openPage(browser, running, { width, height: 900 });
      const held = await holdActions(other.page, ['generation.courseBook.build']);
      await other.page.goto(running.server.url);
      await other.page.locator('.outline-entry').first().click({ timeout: 30000 });
      const offer = other.page.locator('.outline-book-line');
      await offer.waitFor({ timeout: 30000 });
      assert.equal(await other.page.locator('.outline-page .sh-btn--primary').count(), 1, `${width}px: one primary`);
      assert.match(await offer.locator('.sh-btn--primary').innerText(), /生成复习全书/);
      await settleAnimations(other.page);
      if (shots) await other.page.screenshot({ path: join(shots, `book-offer-${width}.png`) });
      const asked = other.page.waitForRequest(request => /"action":"generation\.courseBook\.build"/.test(request.postData() || ''));
      await offer.locator('.sh-btn--primary').click();
      assert.equal(JSON.parse((await asked).postData()).args.course, 'DB');
      held.release('generation.courseBook.build', { jobId: 'course-book-x', status: 'running', steps: 2 });
      await other.page.locator('text=已开始生成复习全书，进度在任务页。').first().waitFor({ timeout: 10000 });
      assert.deepEqual(other.errors, [], `${width}px: no page errors`);
      await other.context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
