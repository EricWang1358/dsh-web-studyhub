/* global document window */
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
import { localDate } from '../lib/board-model.js';
import { addDays } from '../lib/crunch-plan.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* 期末一周 in the real page at 1280 and 420 px (docs/plans/review-book.md M7): with the course's exam a week away the home shows the 期末一周 card (the
   day's kind, its reason, its points); 去读 opens the book at that point, with 「今天读哪几节」 in the header; 翻看 lists the points with their 易错点 first,
   已看 is kept after a reload; 「用这几节出一套模拟卷」 says what can go in and starts the ordinary exam page. Nothing scrolls sideways.
   Screenshots go to COURSE_BOOK_CRUNCH_SHOTS. */

const options = [{ id: 'a', text: 'Yes', correct: true }, { id: 'b', text: 'No', correct: false }];
async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  // A few single and multiple choice questions in the first point (the exam mode takes only these), one open question.
  const deck = decks.find(item => item.id === 'deck-l1');
  deck.cards.slice(0, 8).forEach(card => Object.assign(card, { kind: 'quiz', options }));
  Object.assign(deck.cards[8], { kind: 'multi', options: [...options, { id: 'c', text: 'Both', correct: true }] });
  Object.assign(deck.cards[9], { kind: 'open', answer: 'A decision and its reasons.' });
  await service.store.update(state => {
    state.sources.push(...sources);
    state.decks.push(...decks);
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = key => groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes(`document-l${key}-p1`)).key;
    const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture(1)}#0`] }, { id: 'who', title: 'Stakeholders and concerns, with a rather long title that has to wrap on a phone', anchors: [`${lecture(1)}#1`] }] }],
      other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const page = state.sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes.flatMap(node => node.children);
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
      body: { fingerprint: 'f'.repeat(16), points: [`**${leaf.title}**：${leaf.title} in one line [^1].`], explain: `About ${leaf.title}, the explanation that 翻看 keeps folded [^1].`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }),
      createdAt: '2026-10-09T01:00:00.000Z' });
    openCourseBook(state, {});
    // The learner's 易错点 of the first point: a follow-up put into the book and a 弄懂 block.
    const record = state.sources.find(source => source.provenance === 'course-book-doc');
    record.bookDoc.files['what.qa.md'] = { text: `- [练习：q](studyhub://card/deck-l1/${deck.cards[0].id})\n\n<!-- sh:qa card=${deck.cards[0].id} fid=f1 -->\n> **追问：** 决策日志和架构图有什么区别？\n>\n> **答：** 一个记理由，一个画结构。\n<!-- /sh:qa -->`, version: 1 };
    record.bookDoc.files['what.mine.md'].text = '<!-- sh:ai id=ai1 at=abc state=kept mode=explain -->\n关于：「decision log」\n\n记下每个决定和理由的文档。\n<!-- /sh:ai -->';
  });
  await service.call('course.save', { name: COURSE, exam: { date: addDays(localDate(), 7) } });
  await service.dispose();
}

const sideways = (page, scope = '.book-page *') => page.evaluate(selector => {
  const width = window.innerWidth, wide = [...document.querySelectorAll(selector)].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
}, scope);
const flat = overflow => overflow.doc <= 0 && overflow.wide.length === 0;
const seenCount = async page => Number((await page.locator('.book-flip__progress').innerText()).match(/已看 (\d+)/)[1]);

test('期末一周: the home card, a point in the book, 翻看 with the 易错点 and 已看 kept, a mock paper in the exam page (1280 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-crunch-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_BOOK_CRUNCH_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await page.goto(running.server.url);
      // The home card: the day's kind and reason, its points.
      const card = page.locator('.crunch-card');
      await card.waitFor({ timeout: 30000 });
      const text = await card.innerText();
      for (const part of ['期末一周 · SA', '学习日', '距考试 7 天', '练 5 道', '用这几节出一套模拟卷']) assert.ok(text.includes(part), `${width}px: the card shows ${part}`);
      assert.match(text, /每节读完练 5 道，约 \d+ 分钟/, `${width}px: the reason`);
      // The card's own parts (the rest of the home is not this test's).
      let overflow = await sideways(page, '.crunch-card *');
      assert.ok(flat(overflow), `${width}px: nothing scrolls sideways on the home: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) { await card.screenshot({ path: join(shots, `home-card-${width}.png`) }); await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(shots, `home-${width}.png`) }); }

      // 去读: the book at that point, 今天读哪几节 in the header.
      const first = card.locator('.crunch-day__point').first(), hid = await first.getAttribute('data-point');
      await first.getByRole('button', { name: '去读' }).click();
      await page.locator(`#book-${hid}`).waitFor({ timeout: 30000 });
      await page.waitForTimeout(300);
      const top = await page.evaluate(id => Math.round(document.getElementById(`book-${id}`).getBoundingClientRect().top), hid);
      assert.ok(top >= 0 && top < 500, `${width}px: the point's heading is on screen: ${top}`);
      await page.locator('.book-header__today').click();
      await page.locator('.book-today .crunch-day').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.book-today').innerText(), /学习日[\s\S]*去读/);
      overflow = await sideways(page);
      assert.ok(flat(overflow), `${width}px: nothing scrolls sideways in the book with 今天读哪几节: ${JSON.stringify(overflow)}`);
      if (shots) await page.screenshot({ path: join(shots, `book-today-${width}.png`) });

      // 翻看: the 易错点 first, the 讲解 folded; 已看 kept.
      await page.locator('.book-header__mode').getByText('翻看', { exact: true }).click();
      await page.locator('.book-flip').waitFor({ timeout: 30000 });
      const flip = await page.locator('.book-flip').innerText();
      for (const part of ['问过：决策日志和架构图有什么区别？', '弄懂：decision log', '这一节还没有记下的易错点。', '讲解', '选进模拟卷']) assert.ok(flip.includes(part), `${width}px: 翻看 shows ${part}`);
      assert.doesNotMatch(flip, /the explanation that 翻看 keeps folded/, `${width}px: the 讲解 is folded`);
      const firstFlip = page.locator('.book-flip__point').first(), flipHid = await firstFlip.getAttribute('data-flip-point');
      assert.match(await firstFlip.innerText(), /What architects do/, `${width}px: the point with the most 易错点 first`);
      const before = await seenCount(page);
      await firstFlip.locator('.book-flip__checks').getByText('已看', { exact: true }).click();
      await page.waitForFunction(n => /已看 (\d+)/.exec(document.querySelector('.book-flip__progress')?.innerText || '')?.[1] === String(n), before + 1, { timeout: 30000 });
      await firstFlip.locator('summary').click();
      await firstFlip.locator('.book-point').waitFor({ timeout: 30000 });
      assert.match(await firstFlip.innerText(), /the explanation that 翻看 keeps folded/, `${width}px: 讲解 drawn when opened`);
      overflow = await sideways(page);
      assert.ok(flat(overflow), `${width}px: nothing scrolls sideways in 翻看: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `flip-${width}.png`), fullPage: true });
      // A reload keeps 已看 (kept in the book's record) and the 翻看 view (kept per course).
      await page.reload();
      await page.locator('.crunch-card').waitFor({ timeout: 30000 });
      await page.locator('.crunch-card__open').click();
      await page.locator('.book-flip').waitFor({ timeout: 30000 });
      assert.equal(await seenCount(page), before + 1, `${width}px: 已看 survives a reload`);

      // A question link inside 翻看 goes to the practice page with 回到复习全书 and comes back to the same place in 翻看.
      const last = page.locator('.book-flip__point').last(), lastHid = await last.getAttribute('data-flip-point');
      await last.locator('summary').click();
      const question = last.locator('.book-questions [data-book-link="card"]').first();
      await question.waitFor({ timeout: 30000 });
      await question.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const topBefore = await page.evaluate(id => Math.round(document.getElementById(`flip-${id}`).getBoundingClientRect().top), lastHid);
      await question.click();
      const back = page.locator('.review-detour', { hasText: '回到复习全书' });
      await back.waitFor({ timeout: 30000 });
      await back.click();
      await page.locator(`#flip-${lastHid}`).waitFor({ timeout: 30000 });
      await page.waitForTimeout(400);
      const topAfter = await page.evaluate(id => Math.round(document.getElementById(`flip-${id}`).getBoundingClientRect().top), lastHid);
      // The point comes back where it was (or, when its folded 讲解 makes the page too short for that, as near as the page allows: on screen).
      assert.ok(Math.abs(topAfter - topBefore) <= 24 || (topAfter >= 0 && topAfter < 900), `${width}px: back in 翻看 at the same point: ${topBefore} -> ${topAfter}`);
      assert.equal(await seenCount(page), before + 1, `${width}px: still 翻看 with its progress`);

      // The mock paper: what can go in, then the ordinary exam page.
      await page.locator('.book-flip__mock').getByRole('button', { name: '用这几节出一套模拟卷' }).click();
      const mock = page.locator('.book-flip__mock .book-mock');
      await mock.waitFor({ timeout: 30000 });
      const said = await mock.innerText();
      assert.match(said, /这 2 节共 \d+ 道题，其中 9 道单选或多选可以进模拟卷/, `${width}px: the coverage: ${said}`);
      assert.match(said, /不进卷：.*开放 1 道.*闪卡 \d+ 道/, `${width}px: what is left out: ${said}`);
      if (shots) await mock.screenshot({ path: join(shots, `mock-${width}.png`) });
      await mock.getByRole('button', { name: '开始模拟卷' }).click();
      await page.locator('.exam-card').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.exam-progress').innerText(), /^1 \/ 9$/, `${width}px: the exam has the nine choice questions`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `exam-${width}.png`) });
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
      // The next width starts from the same marks.
      await running.api('book.crunch.mark', { hid: flipHid, kind: 'seen', on: false });
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
