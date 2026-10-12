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
import { bookModel } from './helpers/course-book-model.mjs';

/* The quality workflow in the real page at 1280 and 420 px. A course of three documents (a paged lecture of six topics, a case-study handout and a sample
   paper) gets its book from the real task with a fake model: the inventory, the outline of knowledge points, writing, review and repair, one point left short.
   Then the 总纲 page: the paper is used without opening anything, the book line says the three-level coverage, the short point says 「概念覆盖 N/M」 and
   「未达标：缺 1 个概念」 with what it misses, and 补漏 asks for that one point; the book page's header says the coverage and 查找 lists 生词与概念; nothing
   scrolls sideways. Screenshots go to COURSE_BOOK_SHOTS when it is set. */

const COURSE = 'ArchSS';
const TOPICS = ['CIA triad', 'Risk scenarios', 'Availability in series', 'Availability in parallel', 'Security patterns', 'Threat trees'];
const facts = (topic, from) => Array.from({ length: 3 }, (_, i) => `${topic} fact ${from + i}: what the course says about ${topic.toLowerCase()} number ${from + i}.`).join(' ');
const stamp = at => new Date(Date.UTC(2026, 8, 1) + at * 3600e3).toISOString();
const sources = () => [...TOPICS.flatMap((topic, at) => [0, 1].map(half => ({ id: `lec-p${at * 2 + half + 1}`, title: `5001-A Solution Architecture · p. ${at * 2 + half + 1}`,
  text: facts(topic, half * 3 + 1), createdAt: stamp(0), courses: [COURSE], document: { materialId: 'document-lec', page: at * 2 + half + 1, totalPages: 12, format: 'pdf', origin: 'converted',
    filename: '5001-A Solution Architecture.pdf' } }))),
  { id: 'handout', title: 'S-ARCHSS Case Study Exercises', text: facts('CIA triad', 11), createdAt: stamp(1), courses: [COURSE], document: { materialId: 'document-handout', format: 'md' } },
  { id: 'paper', title: 'SWE5001 Sample Paper', text: 'Q1 Explain the CIA triad with an example. (10 marks)', createdAt: stamp(2), courses: [COURSE], document: { materialId: 'document-paper', format: 'md' } }];

async function seed(root) {
  await mkdir(root, { recursive: true });
  const fake = bookModel({ omit: 1, stubborn: ['Risk scenarios'] });
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push(...sources());
    state.decks.push({ id: 'arch-deck', title: 'Arch deck', course: COURSE, cards: [{ id: 'q1', kind: 'flashcard', topic: 'CIA', prompt: 'What is the CIA triad?', answer: 'C, I, A.',
      citations: [{ sourceId: 'lec-p1', quote: 'CIA triad fact 1' }] }] });
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });
  const job = await settleJob(service, (await service.call('generation.courseBook.build', { course: COURSE })).jobId);
  if (job.status !== 'complete') throw new Error(`the book did not finish: ${job.status}`);
  await service.dispose();
}

const sideways = (page, scope) => page.evaluate(selector => {
  const width = window.innerWidth, wide = [...document.querySelectorAll(`${selector} *`)].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
}, scope);
const argsOf = request => JSON.parse(request.postData()).args;
const flat = text => text.replace(/\s+/g, ' ');

test('the paper used by default, the three-level coverage, a short point\'s 概念覆盖 and 补漏, and 生词与概念 in 查找 (1280 and 420 px)', { timeout: 480000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-quality-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_BOOK_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 1000 });
      const held = await holdActions(page, ['generation.courseBook.build']);
      await page.goto(running.server.url);
      await page.locator('.outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-tree--book').waitFor({ timeout: 30000 });
      const line = page.locator('.outline-book-line');
      const said = flat(await line.innerText());
      assert.match(said, /覆盖：资料用了 2\/2 份、页 13\/13；知识点达标 5\/6；概念 \d+\/\d+/, `${width}px: the book line: ${said}`);
      assert.match(said, /依据样卷：SWE5001 Sample Paper（按名称自动识别，可更改）/, `${width}px: the paper, without opening anything`);
      // The short point: its concept coverage, what it misses, and 补漏 for it alone.
      const point = page.locator('.outline-row[data-kind="point"]', { hasText: 'Risk scenarios' }).first();
      await point.locator('[data-outline-toggle]').click();
      const concepts = point.locator('[data-concepts]');
      await concepts.waitFor({ timeout: 30000 });
      assert.match(flat(await concepts.innerText()), /概念覆盖 \d+\/\d+ 补漏/);
      assert.match(flat(await point.locator('[data-notes-short]').innerText()), /未达标：缺 1 个概念 Risk scenarios fact \d/);
      const overflow = await sideways(page, '.outline-page');
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) { await line.screenshot({ path: join(shots, `quality-line-${width}.png`) }); await point.screenshot({ path: join(shots, `quality-point-${width}.png`) }); }
      const asked = page.waitForRequest(request => /"action":"generation\.courseBook\.build"/.test(request.postData() || '') && /"point"/.test(request.postData() || ''));
      await concepts.getByRole('button', { name: '补漏' }).click();
      const build = argsOf(await asked);
      assert.deepEqual([build.course, build.coverage, typeof build.point], [COURSE, 'standard', 'string'], `${width}px: 补漏 asks for that point at the book's level`);
      held.release('generation.courseBook.build', { jobId: 'course-book-x', status: 'running', steps: 2 });
      // The book page: the coverage in its header, and 生词与概念 in 查找.
      await line.getByRole('button', { name: '打开书页' }).click();
      const levels = page.locator('[data-book-levels]');
      await levels.waitFor({ timeout: 30000 });
      assert.match(flat(await levels.innerText()), /覆盖：资料用了 2\/2 份/);
      await page.locator('.book-header__mode').getByText('查找', { exact: true }).click();
      const glossary = page.locator('.book-lookup__glossary');
      await glossary.waitFor({ timeout: 30000 });
      assert.ok(await glossary.locator('[data-glossary-term]').count() > 10, `${width}px: the glossary lists the covered concepts`);
      const book = await sideways(page, '.book-page');
      assert.equal(book.doc <= 0 && book.wide.length === 0, true, `${width}px: the book page does not scroll sideways: ${JSON.stringify(book)}`);
      if (shots) await page.locator('.book-lookup').screenshot({ path: join(shots, `quality-lookup-${width}.png`) });
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
