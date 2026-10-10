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
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* 复习全书 M3 in the real page at 1280 and 420 px (docs/plans/review-book.md): from the book to a question, its follow-up has 「加入复习全书」; added it reads
   已加入 · 撤回 and 撤回 takes it out; with 自动加入复习全书 on, a NEW follow-up goes into the book by itself; back in the book the Q&A is under the point,
   after the own file. Screenshots go to COURSE_BOOK_QA_SHOTS when set. */

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
      body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} in one line [^1].`], explain: `The explanation of ${leaf.title}.`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }),
      createdAt: '2026-10-09T01:00:00.000Z' });
  });
  await service.dispose();
}

const sideways = (page, scope) => page.evaluate(selector => {
  const width = window.innerWidth, wide = [...document.querySelectorAll(`${selector} *`)].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
}, scope);

test('复习全书 Q&A: 加入复习全书 / 已加入 · 撤回 on a follow-up, 自动加入 for the next one, the Q&A in the book (1280 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-qa-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_BOOK_QA_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: COURSE });
      await running.api('settings.book.set', { patch: { qaToBook: 'manual' } });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await page.goto(running.server.url);
      await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-book-line__open').click({ timeout: 30000 });
      await page.locator('.book-questions [data-book-link="card"]').first().waitFor({ timeout: 30000 });
      const book = await running.api('course.book.open', {}), ref = book.nodes[0].children[0].questions[0];
      await running.api('card.followup.add', { ...ref, question: `Manual question ${width}?`, answer: `Manual answer ${width}.` });

      // The question of the point, in the practice page; its answer shown (as after answering), its follow-up with 加入复习全书.
      await page.locator('.book-questions [data-book-link="card"]').first().click();
      await page.locator('.review-detour', { hasText: '回到复习全书' }).waitFor({ timeout: 30000 });
      // A flashcard: turning it over shows the answer and its Q&A (once turned, the run comes back turned).
      const flip = page.locator('[data-usage="review.flip"][aria-label="翻面查看答案"]');
      if (await flip.count()) await flip.first().click();
      const explain = page.getByRole('button', { name: '讲解', exact: true });
      if (await explain.getAttribute('aria-pressed') !== 'true' && await explain.getAttribute('aria-expanded') !== 'true') await explain.click();
      const item = page.locator('.followup-item', { hasText: `Manual question ${width}?` });
      await item.waitFor({ timeout: 30000 });
      if (!(await item.getAttribute('open') !== null)) await item.locator('summary').click();
      const button = item.locator('.book-qa-button__go');
      await button.waitFor({ timeout: 30000 });
      assert.equal(await button.innerText(), '加入复习全书', `${width}px: manual adds nothing by itself`);
      await button.click();
      await item.locator('.book-qa-button__go', { hasText: '已加入 · 撤回' }).waitFor({ timeout: 30000 });
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `qa-added-${width}.png`) });
      await item.locator('.book-qa-button__go').click();
      await item.locator('.book-qa-button__go', { hasText: '加入复习全书' }).waitFor({ timeout: 30000 });
      assert.deepEqual((await running.api('book.qa.list', {})).followupIds.length, width === 1280 ? 0 : 2, `${width}px: 撤回 took it out`);
      await item.locator('.book-qa-button__go').click();
      await item.locator('.book-qa-button__go', { hasText: '已加入 · 撤回' }).waitFor({ timeout: 30000 });

      // 自动加入复习全书: the next follow-up goes into the book by itself.
      const auto = page.locator('.book-qa-auto input');
      await auto.check();
      await running.api('card.followup.add', { ...ref, question: `Auto question ${width}?`, answer: `Auto answer ${width}.` });
      const fresh = page.locator('.followup-item', { hasText: `Auto question ${width}?` });
      await fresh.waitFor({ timeout: 30000 });
      await fresh.locator('.book-qa-button__go', { hasText: '已加入 · 撤回' }).waitFor({ timeout: 30000 });
      assert.equal((await running.api('snapshot')).settings.book.qaToBook, 'auto');
      const overflow = await sideways(page, '.review');
      assert.equal(overflow.doc <= 0, true, `${width}px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      if (shots) await page.screenshot({ path: join(shots, `qa-auto-${width}.png`) });

      // Back in the book: both Q&A under the point, after its own file; the markers are not shown.
      await page.locator('.review-detour', { hasText: '回到复习全书' }).click();
      await page.locator('.book-file', { hasText: `Auto question ${width}?` }).waitFor({ timeout: 30000 });
      const qa = await page.locator('.book-file', { hasText: `Manual question ${width}?` }).innerText();
      assert.match(qa, new RegExp(`Manual answer ${width}\\.`));
      assert.doesNotMatch(await page.locator('.book-page').innerText(), /sh:qa/);
      if (shots) await page.screenshot({ path: join(shots, `qa-book-${width}.png`) });
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
