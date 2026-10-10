/* global window document */
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
import { openCourseBook } from '../lib/course-book-files.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* 复习全书 M1 in the real page at 1280 and 420 px (docs/plans/review-book.md): from the home to the 总纲 and 打开书页; the 目录 beside the book at 1280,
   folded at 420; 你在这里; a closed chapter renders nothing; a question link goes to the practice page with 回到复习全书 and comes back at the same heading
   and scroll; 本节问答 opens in place; a link to a deleted question says so; nothing scrolls sideways. Screenshots go to COURSE_BOOK_PAGE_SHOTS when set. */

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => {
    state.sources.push(...sources);
    state.decks.push(...decks);
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = key => groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes(`document-l${key}-p1`)).key;
    const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture(1)}#0`] }, { id: 'who', title: 'Stakeholders and concerns', anchors: [`${lecture(1)}#1`] },
        { id: 'views', title: 'Views and viewpoints', anchors: [`${lecture(1)}#2`] }] },
      { id: 'c2', title: 'Requirements', children: [{ id: 'fr', title: 'Functional requirements', anchors: [`${lecture(2)}#0`] }, { id: 'qa', title: 'Quality attribute scenarios with a rather long title that has to wrap on a phone', anchors: [`${lecture(2)}#1`] }] }],
      other: { anchors: [] }, counts: { units: 5, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const page = state.sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes.flatMap(node => node.children);
    const long = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: an architect writes down each decision and the reasons for it, so the team can see later why the system is shaped as it is.`).join('\n\n');
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
      body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} in one line [^1].`], explain: `${long}\n\nIn short: ${leaf.title} [^1].`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }),
      createdAt: '2026-10-09T01:00:00.000Z' });
    openCourseBook(state, {});
    // The learner's own file of the first point links a question that was deleted since.
    const record = state.sources.find(source => source.provenance === 'course-book-doc');
    record.bookDoc.files[`${leaves[0].id}.mine.md`].text = 'My note: see also [练习：an old question](studyhub://card/deck-l1/deleted-long-ago).';
  });
  await service.dispose();
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.book-page *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});
const topOf = (page, hid) => page.evaluate(id => Math.round(document.getElementById(`book-${id}`).getBoundingClientRect().top), hid);

test('复习全书: 打开书页 from the 总纲, 目录 and 你在这里, a question link goes to practice and back to the same place, 本节问答, a deleted question (1280 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-page-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_BOOK_PAGE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await page.goto(running.server.url);
      await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-tree--book').waitFor({ timeout: 30000 });
      await page.locator('.outline-book-line__open').click();
      await page.locator('.book-chapter').first().waitFor({ timeout: 30000 });
      assert.match(await page.locator('.book-page h1').innerText(), /复习全书 · SA/);
      assert.deepEqual(await page.locator('.book-chapter__toggle').evaluateAll(list => list.map(item => [item.innerText.replace(/\s+/g, ' ').trim(), item.getAttribute('aria-expanded')])),
        [['1 Introduction', 'true'], ['2 Requirements', 'false']], `${width}px: the first chapter open, the others only their heading`);
      assert.equal(await page.locator('[data-chapter] .book-file').count() > 0, true);
      assert.equal(await page.locator('.book-chapter').nth(1).locator('.book-file').count(), 0, `${width}px: a closed chapter renders no file`);
      if (width === 420) {
        assert.equal(await page.locator('.book-toc').count(), 0, '420px: the 目录 is folded');
        await page.locator('.book-header__toc').click();
      }
      await page.locator('.book-toc').waitFor();
      assert.ok(await page.locator('.book-toc__go').count() >= 7, `${width}px: every heading in the 目录`);
      assert.equal(await page.locator('.book-link-gone').innerText(), '这道题已被删除', `${width}px: a link to a deleted question says so`);
      let overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `book-${width}.png`), fullPage: true });

      // The 目录 goes to a point of the closed chapter: it opens, and 你在这里 follows.
      await page.locator('.book-toc__go', { hasText: '2.2 Quality attribute scenarios' }).click();
      await page.locator('.book-chapter').nth(1).locator('.book-file').first().waitFor();
      await page.waitForTimeout(300);
      const point = await page.locator('.book-node__heading', { hasText: 'Quality attribute scenarios' }).evaluate(element => Math.round(element.getBoundingClientRect().top));
      assert.ok(point >= 0 && point < 300, `${width}px: the 目录 brought the point to the top of the window: ${point}`);
      overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways with the long title: ${JSON.stringify(overflow)}`);
      if (shots) await page.screenshot({ path: join(shots, `book-point-${width}.png`) });
      if (width === 420) {
        assert.equal(await page.locator('.book-toc').count(), 0, '420px: the 目录 folds again after a jump');
        await page.locator('.book-header__toc').click();
      }
      // 你在这里 is the heading on screen; at 420 px the reopened 目录 sits above the text and pushes it down, so only that it is shown is checked there.
      await (width === 1280 ? page.locator('.book-toc__item', { hasText: '2.2 Quality attribute scenarios' }).locator('.book-toc__here') : page.locator('.book-toc__here')).waitFor();
      if (width === 420) await page.locator('.book-header__toc').click();

      // 本节问答 of 1.1 opens in place (this library keeps none: it says so).
      const first = page.locator('.book-chapter').first();
      await first.locator('[data-book-link="qa"]').first().click();
      await first.locator('.book-qa__none, .book-qa').first().waitFor({ timeout: 30000 });

      // A question link of 1.2 goes to the practice page with 回到复习全书, and comes back at the same heading and scroll.
      const hid = await first.locator('.book-node__heading').nth(1).getAttribute('data-book-heading');
      const link = page.locator(`#book-${hid} ~ .book-file [data-book-link="card"]`).first();
      await link.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const before = await topOf(page, hid);
      const started = page.waitForRequest(request => request.url().includes('/api/call') && /"action":"review\.start"/.test(request.postData() || ''));
      await link.click();
      const args = JSON.parse((await started).postData()).args;
      assert.equal(args.scope.length, 1, `${width}px: the round is the linked question`);
      const back = page.locator('.review-detour', { hasText: '回到复习全书' });
      await back.waitFor({ timeout: 30000 });
      if (shots) await page.screenshot({ path: join(shots, `book-practice-${width}.png`) });
      await back.click();
      await page.locator(`#book-${hid}`).waitFor({ timeout: 30000 });
      await page.waitForTimeout(300);
      const after = await topOf(page, hid);
      assert.ok(Math.abs(after - before) <= 24, `${width}px: back at the same place: ${before} -> ${after}`);

      // 练 5 道 starts a round of at most five of the point's questions.
      const five = page.waitForRequest(request => request.url().includes('/api/call') && /"action":"review\.start"/.test(request.postData() || ''));
      await page.locator(`#book-${hid} ~ .book-file [data-book-link="practice"]`).first().click();
      const chunk = JSON.parse((await five).postData()).args;
      assert.equal(chunk.scope.length, 5, `${width}px: 练 5 道 is five questions`);
      await page.locator('.review-detour', { hasText: '回到复习全书' }).click();
      await page.locator('.book-chapter').first().waitFor({ timeout: 30000 });
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
