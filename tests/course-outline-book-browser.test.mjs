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
import { COURSE, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';

/* 课程总纲 step 2 in the real page at 1280 and 420 px. A library shaped like the owner's (134 materials, about 900 questions, a sample paper) is organised by
   the real task with a fake model, then the page is looked at: it reads like a book (第 N 章 open, sections closed, introductions, what the order rests on,
   样卷考过 marks), a point opens to the materials it holds and then to their questions, a picked point practises exactly its questions, nothing scrolls
   sideways. A second course without an outline shows the v3.3.0 list with one primary 生成总纲 and the folded choice of sample papers; one click asks for the
   task. Screenshots go to COURSE_OUTLINE_SHOTS when it is set. */

const PAPER = 'doc:document-paper-2025', at = '2026-10-01T08:00:00.000Z';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const fake = outlineModel();
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary({ paper: true });
  await service.store.update(state => {
    state.sources.push(...sources,
      { id: 'db-notes', title: 'Database notes', text: 'Indexes fact 1: a B-tree keeps keys sorted. Indexes fact 2: a hash index answers equality.', createdAt: at, courses: ['DB'] },
      { id: 'db-paper', title: 'DB 2024 样卷', text: 'Q1 Explain a B-tree. (10 marks)', createdAt: at, courses: ['DB'] });
    state.decks.push(...decks, { id: 'db-deck', title: 'DB deck', course: 'DB', cards: [{ id: 'db1', kind: 'flashcard', topic: 'Indexes', prompt: 'What does a B-tree keep?', answer: 'Sorted keys.',
      citations: [{ sourceId: 'db-notes', quote: 'Indexes fact 1: a B-tree keeps keys sorted.' }] }] });
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });
  const job = await settleJob(service, (await service.call('generation.courseOutline.build', { course: COURSE, papers: [PAPER] })).jobId);
  await service.dispose();
  if (job.status !== 'complete') throw new Error(`the outline was not built: ${job.status}`);
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.outline-page *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});
const rowsOf = page => page.locator('.outline-tree > .outline-row').evaluateAll(list => list.map(row => ({ key: row.dataset.key, kind: row.dataset.kind, level: row.dataset.level,
  title: row.querySelector('.outline-row__toggle')?.innerText.replace(/\s+/g, ' ').trim(), open: row.querySelector('[data-outline-toggle]')?.getAttribute('aria-expanded') })));

test('总纲 as a book: chapters open, sections closed, a point opens to its materials and questions, practise a point; a course without one offers 生成总纲 (1280 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-outline-book-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_OUTLINE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 1000 });
      await page.goto(running.server.url);
      await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-tree--book').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.outline-page h1').innerText(), /总纲 · SA/);
      assert.match(await page.locator('.outline-book-line__basis').innerText(), /学习顺序依据：讲义大纲《SA 讲义大纲》的顺序 · 资料标题里的编号 · 录音的日期/);
      let rows = await rowsOf(page);
      const parts = rows.filter(row => row.kind === 'part');
      assert.deepEqual(parts.map(row => row.title), ['第 1 章 Course overview', '第 2 章 Introduction to Solution Architecture', '第 3 章 Requirements and Quality Attributes',
        '第 4 章 Architecture Patterns', '第 5 章 Integration and APIs', '第 6 章 Cloud Deployment', '第 7 章 Security Architecture', '第 8 章 Exam review'], `${width}px: the syllabus order`);
      assert.ok(parts.every(row => row.open === 'true'), 'chapters open by default');
      assert.ok(rows.filter(row => row.kind === 'section').every(row => row.open === 'false'), 'sections closed');
      assert.ok(await page.locator('.outline-row[data-kind="part"] .outline-row__intro').count() >= 7, 'every chapter says what it teaches');
      assert.equal(await page.locator('.outline-organise .sh-btn--primary').count(), 0, 'an outline exists: no primary 生成总纲');
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `book-${width}.png`), fullPage: true });

      // Open 2.1 Foundations, its first point (it holds several materials), the lecture's chapter under it.
      const section = rows.find(row => row.kind === 'section' && row.title === '2.1 Foundations');
      await page.locator(`[data-outline-toggle="${section.key}"]`).click();
      await page.locator('.outline-row[data-kind="point"]', { hasText: 'What architects do' }).first().waitFor();
      rows = await rowsOf(page);
      const pointRow = rows.find(row => row.kind === 'point' && /What architects do/.test(row.title));
      assert.match(pointRow.title, /^2\.1\.1 What architects do/);
      await page.locator(`[data-outline-toggle="${pointRow.key}"]`).click();
      await page.locator('.outline-row[data-kind="anchor"]').first().waitFor();
      rows = await rowsOf(page);
      const anchors = rows.filter(row => row.kind === 'anchor').map(row => row.title);
      assert.ok(anchors.some(title => /^01\. Introduction to Solution Architecture v2\.1 · What architects do/.test(title)), `${width}px: ${JSON.stringify(anchors)}`);
      assert.ok(anchors.some(title => /^补充笔记 · Reintroduction（4 份同名）/.test(title)), 'the four identical notes are ONE row under the point they belong to');
      const lecture = rows.find(row => row.kind === 'anchor' && /v2\.1 · What architects do/.test(row.title));
      await page.locator(`[data-outline-toggle="${lecture.key}"]`).click();
      await page.locator(`[data-key="${lecture.key}"] .outline-q`).first().waitFor();
      // Views and viewpoints: 2.2, marked by the sample paper.
      const practice = (await rowsOf(page)).find(row => row.kind === 'section' && row.title === '2.2 In practice');
      await page.locator(`[data-outline-toggle="${practice.key}"]`).click();
      const marked = page.locator('.outline-row[data-kind="point"]', { hasText: 'Views and viewpoints' }).first();
      await marked.waitFor();
      assert.match(await marked.locator('.outline-row__tier').innerText(), /样卷考过（1\/1 份）/);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `book-open-${width}.png`), fullPage: true });

      await page.locator(`[data-key="${pointRow.key}"] > .outline-row__line input[type="checkbox"]`).check();
      const bar = page.locator('.outline-bar');
      await bar.locator('.outline-bar__count', { hasText: /已选 \d+ 题/ }).waitFor();
      const picked = Number((await bar.locator('.outline-bar__count').innerText()).match(/\d+/)[0]);
      assert.ok(picked > 20, `${width}px: a point of a lecture and the notes on it: ${picked}`);
      const overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `book-picked-${width}.png`) });
      const started = page.waitForRequest(request => request.url().includes('/api/call') && /"action":"review\.start"/.test(request.postData() || ''));
      await bar.locator('.sh-btn--primary').click();
      const args = JSON.parse((await started).postData()).args;
      assert.equal(args.scope.length, Math.min(200, picked), `${width}px: the round is exactly the picked point`);
      await page.locator('.review-detour', { hasText: '返回总纲' }).click({ timeout: 30000 });
      await page.locator('.outline-tree--book').waitFor();
      assert.equal(await page.locator(`[data-outline-toggle="${pointRow.key}"]`).getAttribute('aria-expanded'), 'true', `${width}px: back on the outline as it was left`);
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();

      // A course without an outline: the materials as before, one primary 生成总纲, sample papers folded; one click asks for the task.
      await running.api('focus.set', { course: 'DB' });
      const other = await openPage(browser, running, { width, height: 900 });
      const held = await holdActions(other.page, ['generation.courseOutline.build']);
      await other.page.goto(running.server.url);
      await other.page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      const offer = other.page.locator('.outline-organise');
      await offer.waitFor({ timeout: 30000 });
      assert.equal(await other.page.locator('.outline-page .sh-btn--primary').count(), 1, `${width}px: one primary`);
      assert.match(await offer.locator('.sh-btn--primary').innerText(), /生成总纲/);
      await offer.locator('.outline-papers summary').click();
      const choices = await offer.locator('.outline-papers__list .sh-check').allInnerTexts();
      assert.match(choices[0], /DB 2024 样卷[\s\S]*像样卷/, 'the likely paper first');
      assert.equal(await offer.locator('.outline-papers__list input:checked').count(), 0, 'none picked');
      await settleAnimations(other.page);
      if (shots) await other.page.screenshot({ path: join(shots, `offer-${width}.png`), fullPage: true });
      const asked = other.page.waitForRequest(request => /"action":"generation\.courseOutline\.build"/.test(request.postData() || ''));
      await offer.locator('.sh-btn--primary').click();
      assert.deepEqual(JSON.parse((await asked).postData()).args.course, 'DB');
      held.release('generation.courseOutline.build', { jobId: 'course-outline-x', status: 'running', steps: 2 });
      await other.page.locator('text=已开始整理总纲，进度在任务页。').first().waitFor({ timeout: 10000 });
      const wide = await sideways(other.page);
      assert.equal(wide.doc <= 0 && wide.wide.length === 0, true, `${width}px: nothing sideways: ${JSON.stringify(wide)}`);
      assert.deepEqual(other.errors, [], `${width}px: no page errors`);
      await other.context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
