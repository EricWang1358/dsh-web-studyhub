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

/* 讲解详尽程度 and 覆盖 in the real page at 1280 and 420 px. A course of one long document (「04. Design Secure Architecture v4.7」, 80 pages) and a short
   note gets its book at 精简 from the real task with a fake model (the reading of before levels existed). Then the 总纲 page: the level beside 更新全书 is chosen
   (saved as the setting), 更新全书 asks for the task at that level, the book line says how much the explanations read, an opened point says
   「覆盖：读了 0/80 页，另有 80 页只读了开头」 and 读更多 asks for that one point at the next level; nothing scrolls sideways. Screenshots go to
   COURSE_BOOK_SHOTS when it is set. */

const SEC = 'Sec', TITLE = '04. Design Secure Architecture v4.7';
const pageText = page => Array.from({ length: 24 }, (_, i) => `Secure design page ${page} line ${i}: the architect checks each trust boundary and records the threat.`).join(' ');
const longDocument = () => Array.from({ length: 80 }, (_, i) => ({ id: `secure-p${i + 1}`, title: `${TITLE} · p. ${i + 1}`, text: pageText(i + 1),
  createdAt: '2026-09-20T00:00:00.000Z', courses: [SEC], document: { materialId: 'document-secure', page: i + 1, totalPages: 80, format: 'pdf', origin: 'converted',
    converter: 'marker', filename: `${TITLE}.pdf`, chapter: { index: 0, title: 'Secure design', level: 1 }, extractionVersion: 2 } }));
const note = { id: 'week1', title: 'Week 1 note', text: 'Entropy measures disorder. Example: a melting ice cube gains entropy as its molecules spread out.',
  createdAt: '2026-09-01T00:00:00.000Z', courses: [SEC], document: { materialId: 'document-week1', format: 'md', filename: 'week1.md' } };

async function seed(root) {
  await mkdir(root, { recursive: true });
  const fake = bookModel();
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push(...longDocument(), note);
    // One question, so the course area leads to its 总纲.
    state.decks.push({ id: 'sec-deck', title: 'Sec deck', course: SEC, cards: [{ id: 'sec-1', kind: 'flashcard', topic: 'Secure design', prompt: 'What does the architect check?',
      answer: 'Each trust boundary.', citations: [{ sourceId: 'secure-p1', quote: 'Secure design page 1 line 0' }] }] });
    state.focus = { mode: 'class', course: SEC, role: '', jd: '', targetTopics: [] };
  });
  const job = await settleJob(service, (await service.call('generation.courseBook.build', { course: SEC, coverage: 'brief' })).jobId);
  if (job.status !== 'complete') throw new Error(`the book did not finish: ${job.status}`);
  await service.dispose();
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.outline-page *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});
const argsOf = request => JSON.parse(request.postData()).args;

test('讲解详尽程度 beside 更新全书, the book line\'s 讲解覆盖, a point\'s 覆盖 and 读更多 (1280 and 420 px)', { timeout: 480000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-coverage-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_BOOK_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      await running.api('settings.book.set', { patch: { coverage: null } });
      const { page, errors, context } = await openPage(browser, running, { width, height: 1000 });
      const held = await holdActions(page, ['generation.courseBook.build']);
      await page.goto(running.server.url);
      await page.locator('.outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-tree--book').waitFor({ timeout: 30000 });
      const line = page.locator('.outline-book-line');
      assert.match((await line.innerText()).replace(/\s+/g, ' '), /讲解覆盖：读了资料的 \d+%，1 个知识点只读了一部分/, `${width}px: the book line`);
      // The level: 标准 by default; 详尽 is chosen and saved as the setting.
      const level = line.locator('.outline-organise__level');
      assert.match(await level.innerText(), /标准/);
      await level.click();
      const saved = page.waitForRequest(request => /"action":"settings\.book\.set"/.test(request.postData() || ''));
      await page.getByRole('option', { name: '详尽' }).click();
      assert.deepEqual(argsOf(await saved).patch, { coverage: 'full' });
      await page.waitForFunction(() => /详尽/.test(document.querySelector('.outline-organise__level')?.textContent || ''), null, { timeout: 10000 });
      const asked = page.waitForRequest(request => /"action":"generation\.courseBook\.build"/.test(request.postData() || ''));
      await line.getByRole('button', { name: '更新全书' }).click();
      const build = argsOf(await asked);
      assert.deepEqual([build.course, build.coverage, build.point], [SEC, 'full', undefined], `${width}px: the book at the chosen level`);
      held.release('generation.courseBook.build', { jobId: 'course-book-x', status: 'running', steps: 9 });
      await page.locator('text=已开始生成复习全书，进度在任务页。').first().waitFor({ timeout: 10000 });
      // The long point: what its explanation read, and 读更多.
      const point = page.locator('.outline-row[data-kind="point"]', { hasText: 'Secure design' }).first();
      await point.locator('[data-outline-toggle]').click();
      const coverage = point.locator('.outline-notes__coverage');
      await coverage.waitFor({ timeout: 30000 });
      assert.match((await coverage.innerText()).replace(/\s+/g, ' '), /覆盖：读了 0\/80 页，另有 80 页只读了开头 读更多/);
      const overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) { await line.screenshot({ path: join(shots, `coverage-line-${width}.png`) }); await point.screenshot({ path: join(shots, `coverage-point-${width}.png`) }); }
      const more = page.waitForRequest(request => /"action":"generation\.courseBook\.build"/.test(request.postData() || '') && /"point"/.test(request.postData() || ''));
      await coverage.getByRole('button', { name: '读更多' }).click();
      const again = argsOf(await more);
      assert.deepEqual([again.course, again.coverage, typeof again.point], [SEC, 'standard', 'string'], `${width}px: 读更多 asks for that point at the next level`);
      await page.locator('text=已开始多读这个知识点，进度在任务页。').first().waitFor({ timeout: 10000 });
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
