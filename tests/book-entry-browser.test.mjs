/* global document window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
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
import { openCourseBook } from '../lib/course-book-files.js';
import { localDate } from '../lib/board-model.js';
import { addDays } from '../lib/crunch-plan.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* The sidebar's 复习全书 (3.4.1) in the real page at 1280 and 420 px: with a written book it opens the book page, and the header says what the 期末一周
   needs (no exam date: a link to the course settings; a date beyond the window: when the week starts); with only an outline it opens the 总纲 page with its one
   line on what the 复习全书 is; with no outline at all the 总纲 page too. Nothing scrolls sideways. Screenshots go to BOOK_ENTRY_SHOTS when set. */

const seedWith = ({ outline: withOutline, notes: withNotes }) => async root => {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => {
    state.sources.push(...sources);
    state.decks.push(...decks);
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    if (!withOutline) return;
    const lecture = key => groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes(`document-l${key}-p1`)).key;
    const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture(1)}#0`] }, { id: 'who', title: 'Stakeholders and concerns', anchors: [`${lecture(1)}#1`] }] },
        { id: 'c2', title: 'Requirements', children: [{ id: 'fr', title: 'Functional requirements', anchors: [`${lecture(2)}#0`] }] }],
      other: { anchors: [] }, counts: { units: 3, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    if (!withNotes) return;
    const page = state.sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes.flatMap(node => node.children);
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
      body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} in one line [^1].`], explain: `About ${leaf.title} [^1].`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }),
      createdAt: '2026-10-09T01:00:00.000Z' });
    openCourseBook(state, {});
  });
  await service.dispose();
};

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth;
  const wide = [...document.querySelectorAll('.book-page *, .outline-page *')].filter(element => element.getBoundingClientRect().right > width + 1).map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});
const flat = overflow => overflow.doc <= 0 && overflow.wide.length === 0;
/** The sidebar entry: at 420 px the rail may sit off to the side, so the press is dispatched when a plain click is blocked. */
const pressBook = async page => {
  const entry = page.locator('[data-tour="nav-book"]').first();
  await entry.waitFor({ state: 'attached', timeout: 30000 });
  await entry.dispatchEvent('click');
};

test('复习全书 in the sidebar: the book page with the 期末一周 date hints, the 总纲 page with its one line, and the 总纲 page for a course without an outline (1280 and 420 px)', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-entry-dist-'));
  await buildPreview({ outdir: dist });
  const shots = process.env.BOOK_ENTRY_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    // 1. A written book.
    const written = await startLateServer({ distDir: dist, seed: seedWith({ outline: true, notes: true }) });
    try {
      for (const width of [1280, 420]) {
        const { page, errors, context } = await openPage(browser, written, { width, height: 900 });
        await page.goto(written.server.url);
        await pressBook(page);
        await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
        assert.match(await page.locator('.book-page h1').innerText(), /复习全书 · SA/, `${width}px: the sidebar opened the book page`);
        // No exam date: 更多 › 期末一周 offers 设置考试日期 (开启期末一周), and it opens the course settings.
        await page.locator('.book-bar__more').click();
        const link = page.getByRole('menuitem', { name: /^设置考试日期/ });
        await link.waitFor({ timeout: 30000 });
        assert.equal((await link.locator('.sh-menu__hint').innerText()).trim(), '开启期末一周', `${width}px: no date, the item says what it starts`);
        assert.equal(flat(await sideways(page)), true, `${width}px: nothing scrolls sideways`);
        await settleAnimations(page);
        if (shots) await page.screenshot({ path: join(shots, `book-no-date-${width}.png`) });
        await link.click();
        await page.locator('.course-settings').waitFor({ timeout: 30000 });
        assert.equal(await page.locator('.course-settings [aria-label="考试日期"]').count() > 0, true, `${width}px: the exam date is the first thing of the settings`);
        if (shots) await page.screenshot({ path: join(shots, `book-settings-${width}.png`) });
        await context.close();
        assert.deepEqual(errors, [], `${width}px: no console errors`);
      }
      // A date beyond the window: the line, no link.
      await written.api('course.save', { name: COURSE, exam: { date: addDays(localDate(), 60) } });
      for (const width of [1280, 420]) {
        const { page, context } = await openPage(browser, written, { width, height: 900 });
        await page.goto(written.server.url);
        await pressBook(page);
        await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
        await page.locator('.book-bar__more').click();
        const settings = page.getByRole('menuitem', { name: /^前往设置/ });
        await settings.waitFor({ timeout: 30000 });
        assert.equal((await settings.locator('.sh-menu__hint').innerText()).trim(), '期末一周在考前 21 天开始', `${width}px: a date beyond the window`);
        assert.equal(await page.getByRole('menuitem', { name: /^设置考试日期/ }).count(), 0, `${width}px: no 设置考试日期 when the date is set`);
        if (shots) await page.screenshot({ path: join(shots, `book-far-date-${width}.png`) });
        await context.close();
      }
      // An exam inside the window: nothing to say.
      await written.api('course.save', { name: COURSE, exam: { date: addDays(localDate(), 10) } });
      const near = await openPage(browser, written, { width: 1280, height: 900 });
      await near.page.goto(written.server.url);
      await pressBook(near.page);
      await near.page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
      await near.page.locator('.book-bar__more').click();
      await near.page.getByRole('menuitem', { name: /^前往设置/ }).waitFor({ timeout: 30000 });
      assert.equal(await near.page.locator('[role="menu"] .sh-menu__hint', { hasText: '期末一周在考前' }).count(), 0, 'inside the window 更多 says nothing more');
      assert.equal(await near.page.getByRole('menuitem', { name: /^设置考试日期/ }).count(), 0);
      await near.context.close();
    } finally { await written.close(); }

    // 2. An outline without the book: the 总纲 page, its one line, one primary button.
    const outlined = await startLateServer({ distDir: dist, seed: seedWith({ outline: true, notes: false }) });
    try {
      for (const width of [1280, 420]) {
        const { page, errors, context } = await openPage(browser, outlined, { width, height: 900 });
        await page.goto(outlined.server.url);
        await pressBook(page);
        await page.locator('.outline-tree--book').waitFor({ timeout: 30000 });
        assert.match(await page.locator('.outline-book-intro').innerText(), /^复习全书：按总纲给每个知识点写一段讲解/, `${width}px: the line on what the book is`);
        assert.deepEqual(await page.locator('.outline-page .sh-btn--primary').evaluateAll(list => list.map(item => item.innerText.trim())), ['生成复习全书'], `${width}px: one primary button`);
        assert.equal(flat(await sideways(page)), true, `${width}px: nothing scrolls sideways`);
        await settleAnimations(page);
        if (shots) await page.screenshot({ path: join(shots, `outline-intro-${width}.png`) });
        await context.close();
        assert.deepEqual(errors, [], `${width}px: no console errors`);
      }
    } finally { await outlined.close(); }

    // 3. No outline: the 总纲 page with its offer to generate one.
    const bare = await startLateServer({ distDir: dist, seed: seedWith({ outline: false, notes: false }) });
    try {
      for (const width of [1280, 420]) {
        const { page, context } = await openPage(browser, bare, { width, height: 900 });
        await page.goto(bare.server.url);
        await pressBook(page);
        await page.locator('.outline-organise').waitFor({ timeout: 30000 });
        assert.match(await page.locator('.outline-book-intro').innerText(), /复习全书/, `${width}px: the line is above the offer`);
        assert.equal((await page.locator('.outline-organise .sh-btn--primary').first().innerText()).trim(), '生成总纲', `${width}px: 生成总纲 first`);
        if (shots) await page.screenshot({ path: join(shots, `outline-none-${width}.png`) });
        await context.close();
      }
    } finally { await bare.close(); }
  } finally { await browser.close(); }
});
