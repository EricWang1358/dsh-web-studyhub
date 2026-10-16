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
   day's kind, its reason, its points); 去读 opens the book at that point, today's points on top of its 目录 (no 今天读哪几节 in 更多); 打开复习全书 lands on
   today's first point not read; 更多 › 翻看 lists the points with their 易错点 first,
   已看 is kept after a reload, a round from 翻看 comes back to the reading surface at its point; 「用这些知识点出一套模拟卷」 says what can go in and starts the ordinary exam page. Nothing scrolls sideways.
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
    state.decks.push(...decks, { id: 'deck-other-course', title: 'Another course', course: '另一门课', cards: [{ id: 'oc1', kind: 'flashcard', topic: 'x', prompt: 'x?', answer: 'a' }] });
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
    // The pictures are made in both themes; the checks run once.
    for (const [theme, width] of (shots ? [['dark', 1280], ['dark', 420], ['light', 1280], ['light', 420]] : [['dark', 1280], ['dark', 420]])) {
      const tag = `${width}${theme === 'light' ? '-light' : ''}`;
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900, theme });
      await page.goto(running.server.url);
      // The home card: the day's kind and reason, its points.
      const card = page.locator('.crunch-card');
      await card.waitFor({ timeout: 30000 });
      const text = await card.innerText();
      for (const part of ['期末一周 · SA', '学习日', '距考试 7 天', '练 5 道', '用这些知识点出一套模拟卷']) assert.ok(text.includes(part), `${width}px: the card shows ${part}`);
      assert.match(text, /每个读完练 5 道，约 \d+ 分钟/, `${width}px: the reason`);
      // The card's own parts (the rest of the home is not this test's).
      let overflow = await sideways(page, '.crunch-card *');
      assert.ok(flat(overflow), `${width}px: nothing scrolls sideways on the home: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) { await card.screenshot({ path: join(shots, `home-card-${tag}.png`) }); await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(shots, `home-${tag}.png`) }); }

      // 练 5 道 on the card keeps a way back to the home, as every round started from a page does.
      const first = card.locator('.crunch-day__point').first(), hid = await first.getAttribute('data-point');
      const started = page.waitForRequest(request => request.url().includes('/api/call') && /"action":"review\.start"/.test(request.postData() || ''));
      await first.getByRole('button', { name: '练 5 道' }).click();
      assert.equal(JSON.parse((await started).postData()).args.scope.length, 5, `${width}px: the card practises the point's next five`);
      const home = page.locator('.review-detour', { hasText: '返回学习库' });
      await home.waitFor({ timeout: 30000 });
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `home-practice-${tag}.png`) });
      await home.click();
      await card.waitFor({ timeout: 30000 });

      // The card acts on a course that is not the current one: the app switches to it and the book says so once, in a quiet line of its header.
      await running.api('focus.set', { course: '另一门课' });
      await page.reload();
      await card.waitFor({ timeout: 30000 });
      assert.equal(await page.getByText('已切换到课程').count(), 0, `${width}px: nothing is said before the card acts`);

      // 去读: the book at that point.
      await first.getByRole('button', { name: '去读' }).click();
      await page.getByText('已切换到课程 SA').first().waitFor({ timeout: 30000 });
      assert.equal(await page.getByText('已切换到课程 SA').count(), 1, `${width}px: said once`);
      // Two courses: the title's course is the course switcher (the home's), and it names the card's course.
      assert.match(await page.locator('.book-page h1').innerText(), /复习全书 ·\s*SA/, `${width}px: the book is the card's course`);
      assert.equal(await page.locator('.book-page h1 [aria-label="切换当前课程"]').count(), 1, `${width}px: the course switcher in the title`);
      assert.equal(await page.locator('.sh-toast', { hasText: '已切换到课程' }).count(), 0, `${width}px: a quiet line in the header, not a toast`);
      await page.locator(`#book-${hid}`).waitFor({ timeout: 30000 });
      await page.waitForTimeout(300);
      const top = await page.evaluate(id => Math.round(document.getElementById(`book-${id}`).getBoundingClientRect().top), hid);
      assert.ok(top >= 0 && top < 500, `${width}px: the point's heading is on screen: ${top}`);
      // The line is in the header, above the point the page opened at: the picture scrolls up to it.
      await page.locator('.book-header').scrollIntoViewIfNeeded();
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `book-switched-${tag}.png`) });
      // Today's points are the 目录's 今天 group, on top (the slide-over on a narrow page); 更多 has no 今天读哪几节 any more.
      if (width < 900) { await page.locator('.book-bar__toc').click(); await page.locator('.book-toc[data-overlay]').waitFor({ timeout: 30000 }); }
      const todayGroup = page.locator('[data-book-today]');
      await todayGroup.waitFor({ timeout: 30000 });
      assert.match(await todayGroup.innerText(), /今天 \d+ 个 · 已读完 \d+/, `${width}px: the 今天 head`);
      assert.ok(await todayGroup.locator('.book-toc__go').count() >= 1, `${width}px: today's points listed`);
      overflow = await sideways(page);
      assert.ok(flat(overflow), `${width}px: nothing scrolls sideways in the book with the 目录 open: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `book-today-${tag}.png`) });
      if (width < 900) { await page.keyboard.press('Escape'); await page.locator('.book-toc').waitFor({ state: 'detached', timeout: 30000 }); }
      await page.locator('.book-bar__more').click();
      assert.equal(await page.getByRole('menuitem', { name: '今天读哪几节' }).count(), 0, `${width}px: no 今天读哪几节 in 更多`);
      await page.keyboard.press('Escape');

      // 更多 › 翻看: the 易错点 first, the 讲解 folded; 已看 kept; 「完成 · 回到阅读」 on top.
      await page.locator('.book-bar__more').click();
      await page.getByRole('menuitem', { name: /^翻看/ }).click();
      await page.locator('.book-flip').waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.book-mode__done').count(), 1, `${width}px: 翻看 has its way back to reading`);
      const flip = await page.locator('.book-flip').innerText();
      for (const part of ['问过：决策日志和架构图有什么区别？', '弄懂：decision log', '这个知识点还没有记下的易错点。', '讲解', '选进模拟卷']) assert.ok(flip.includes(part), `${width}px: 翻看 shows ${part}`);
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
      if (shots) await page.screenshot({ path: join(shots, `flip-${tag}.png`), fullPage: true });
      // A reload keeps 已看 (kept in the book's record). The home card's 打开复习全书 opens the reading surface at today's first point not read yet (a view is
      // never remembered: the book does not reopen in 翻看 by itself); 翻看 is one press away in 更多.
      await page.reload();
      await page.locator('.crunch-card').waitFor({ timeout: 30000 });
      const firstToday = await page.evaluate(() => [...document.querySelectorAll('.crunch-card .crunch-day__point')].find(row => !/读完/.test(row.innerText))?.dataset.point);
      await page.locator('.crunch-card__open').click();
      await page.locator(`[data-book-step="${firstToday}"]`).waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.book-flip').count(), 0, `${width}px: not in 翻看 by itself`);
      await page.locator('.book-bar__more').click();
      await page.getByRole('menuitem', { name: /^翻看/ }).click();
      await page.locator('.book-flip').waitFor({ timeout: 30000 });
      assert.equal(await seenCount(page), before + 1, `${width}px: 已看 survives a reload`);

      // A question link inside 翻看 goes to the practice page with 回到复习全书; the way back lands on the reading surface at that point (an entry always does),
      // its heading focused, and 翻看 is one press away in 更多 with its progress.
      const last = page.locator('.book-flip__point').last(), lastHid = await last.getAttribute('data-flip-point');
      await last.locator('summary').first().click();
      // The point's questions are folded under 本节的题 (N).
      await last.locator('.book-questions > summary').click();
      const question = last.locator('.book-questions [data-book-link="card"]').first();
      await question.waitFor({ timeout: 30000 });
      await question.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const topBefore = await page.evaluate(id => Math.round(document.getElementById(`flip-${id}`).getBoundingClientRect().top), lastHid);
      await question.click();
      const back = page.locator('.review-return', { hasText: '回到复习全书' });
      await back.waitFor({ timeout: 30000 });
      await back.click();
      await page.locator(`#book-${lastHid}`).waitFor({ timeout: 30000 });
      await page.waitForTimeout(400);
      assert.equal(await page.locator('.book-flip').count(), 0, `${width}px: back on the reading surface`);
      const topAfter = await page.evaluate(id => Math.round(document.getElementById(`book-${id}`).getBoundingClientRect().top), lastHid);
      assert.ok(topAfter >= 0 && topAfter < 900, `${width}px: at the point left: ${topBefore} -> ${topAfter}`);
      await page.waitForFunction(id => document.activeElement?.id === id, `book-${lastHid}`, { timeout: 5000 });
      await page.locator('.book-bar__more').click();
      await page.getByRole('menuitem', { name: /^翻看/ }).click();
      await page.locator('.book-flip').waitFor({ timeout: 30000 });
      assert.equal(await seenCount(page), before + 1, `${width}px: 翻看 keeps its progress`);

      // The mock paper: what can go in, then the ordinary exam page.
      await page.locator('.book-flip__mock').getByRole('button', { name: '用这些知识点出一套模拟卷' }).click();
      const mock = page.locator('.book-flip__mock .book-mock');
      await mock.waitFor({ timeout: 30000 });
      const said = await mock.innerText();
      assert.match(said, /这 2 个知识点共 \d+ 道题，其中 9 道单选或多选可以进模拟卷/, `${width}px: the coverage: ${said}`);
      assert.match(said, /不进卷：.*开放 1 道.*闪卡 \d+ 道/, `${width}px: what is left out: ${said}`);
      await settleAnimations(mock);
      if (shots) await mock.screenshot({ path: join(shots, `mock-${tag}.png`) });
      await mock.getByRole('button', { name: '开始模拟卷' }).click();
      await page.locator('.exam-card').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.exam-progress').innerText(), /^1 \/ 9$/, `${width}px: the exam has the nine choice questions`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `exam-${tag}.png`) });
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
      // The next width starts from the same marks.
      await running.api('book.crunch.mark', { hid: flipHid, kind: 'seen', on: false });
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
