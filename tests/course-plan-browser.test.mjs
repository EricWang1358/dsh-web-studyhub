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
import { localDate } from '../lib/board-model.js';
import { addDays } from '../lib/crunch-plan.js';
import { COURSE, library } from './helpers/crunch-library.mjs';

/* 备考计划 in the real review book page at 1280 and 420 px: the section under the book bar with a saved plan (open, folded and kept folded after a reload, the
   numbers and their hover words, today's day, the next days up to the final week and the line that says when the final week begins), a course inside the final
   week (the daily part hands over to 期末一周: one line, 今天读哪几节 opens the day once), and the quiet line without a plan or without an exam date that points
   at the exam date and at 发给主会话. Pictures go to COURSE_PLAN_SHOTS. */

const TODAY = localDate();
const PLAN = { version: 1, minutesPerDay: 120, reviewCycleDays: 4, restDates: [addDays(TODAY, 2)], mockDates: [addDays(TODAY, 6)],
  phases: [{ name: '打基础', until: addDays(TODAY, 15), goal: '把每一章读一遍，做完每节的 5 道题' }, { name: '冲刺', goal: '只做薄弱点和模拟卷' }] };

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { state, deck } = library();
  const now = new Date().toISOString();
  // Five questions of the first point answered today: it is learnt, the second point is still to learn.
  await service.store.update(own => {
    own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus;
    for (const card of deck.cards.slice(0, 5)) own.attempts.push({ id: `a-${card.id}`, quiz_id: card.id, deckId: deck.id, timestamp: now, grade: 4, assessment: 'graded' });
  });
  await service.call('course.book.open');
  await service.call('course.save', { name: COURSE, exam: { date: addDays(TODAY, 40) } });
  await service.call('course.save', { name: COURSE, plan: PLAN });
  await service.dispose();
}

const sideways = (page, scope = '.book-page *') => page.evaluate(selector => {
  const width = window.innerWidth, wide = [...document.querySelectorAll(selector)].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
}, scope);
const flat = overflow => overflow.doc <= 0 && overflow.wide.length === 0;

/** The book page of the course: 总纲 › 打开书页. */
async function openBook(page, running, open = '打开书页') {
  await page.goto(running.server.url);
  await page.locator('.outline-entry').first().click({ timeout: 30000 });
  await page.locator('.outline-book-line').getByRole('button', { name: open }).click({ timeout: 30000 });
  await page.locator('.book-bar').waitFor({ timeout: 30000 });
}

test('备考计划: a saved plan (open, folded, kept), the final week handing over, the quiet lines, no horizontal scroll (1280 and 420 px)', { timeout: 480000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-course-plan-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_PLAN_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      // 40 days to the exam: the plan has its own days up to the final week.
      await running.api('course.save', { name: COURSE, exam: { date: addDays(TODAY, 40) } });
      await running.api('course.save', { name: COURSE, plan: PLAN });
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
      await openBook(page, running);
      const section = page.locator('.book-plan[data-plan="plan"]');
      await section.waitFor({ timeout: 30000 });
      const text = await section.innerText();
      for (const part of ['备考计划', '距考试 40 天', '已学 1/2 节 · 已排 2/2 节', '打基础', '冲刺', '把每一章读一遍，做完每节的 5 道题', '学习日', '去读', '休息', '模拟考', '起是期末一周，每天读什么到时另排。', '刷新', '发给主会话'])
        assert.ok(text.includes(part), `${width}px: the section shows ${part}: ${text}`);
      assert.equal(await page.locator('.book-plan .crunch-day').count(), 1, `${width}px: today's day once`);
      assert.equal(await page.locator('.book-plan__day').first().getAttribute('data-mode') !== null, true);
      let overflow = await sideways(page);
      assert.ok(flat(overflow), `${width}px: nothing scrolls sideways with the plan open: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) { await section.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(shots, `plan-open-${width}.png`) }); }

      // The hover words: what 已学 and 已排 mean.
      await page.locator('.book-plan__coverage').hover();
      const tip = page.getByText('已学：一天里答够 5 道题').first();
      await tip.waitFor({ timeout: 5000 });
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `plan-tip-${width}.png`) });
      await page.mouse.move(0, 0);

      // 去读 opens the book at the point.
      const point = section.locator('.crunch-day__point').first(), hid = await point.getAttribute('data-point');
      await point.getByRole('button', { name: '去读' }).click();
      await page.locator(`#book-${hid}`).waitFor({ timeout: 30000 });

      // Folded: one row; the fold is kept after a reload.
      await section.locator('.book-plan__title').click();
      assert.equal(await section.locator('.book-plan__title').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('.book-plan__phases, .book-plan__next, .book-plan .crunch-day').count(), 0, `${width}px: folded, only the head`);
      await settleAnimations(page);
      if (shots) { await section.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(shots, `plan-folded-${width}.png`) }); }
      overflow = await sideways(page);
      assert.ok(flat(overflow), `${width}px: nothing scrolls sideways folded: ${JSON.stringify(overflow)}`);
      await openBook(page, running);
      await page.locator('.book-plan__title').waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.book-plan__title').getAttribute('aria-expanded'), 'false', `${width}px: the fold is kept`);
      await page.locator('.book-plan__title').click();
      await page.locator('.book-plan__phases').waitFor({ timeout: 30000 });

      // 想调整这份计划 › 发给主会话: the message goes to the clipboard (no chat in the preview) and names the tools and the rule.
      await section.locator('.book-plan__revise [data-hand-off="course.plan"]').click();
      await page.getByText(/已复制到剪贴板|需要手动复制|已填进主会话/).first().waitFor({ timeout: 10000 });
      const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
      if (copied) for (const part of ['course.plan', 'course.save', '我同意之后才用 course.save 存 plan', '要不要调整']) assert.ok(copied.includes(part), `${width}px: the message has ${part}`);

      // Inside the final week (10 days to the exam): the plan keeps its head and phases; the daily part is 期末一周's, shown once from 今天读哪几节.
      await running.api('course.save', { name: COURSE, exam: { date: addDays(TODAY, 10) } });
      await openBook(page, running);
      await page.locator('.book-plan__handover').waitFor({ timeout: 30000 });
      const near = await page.locator('.book-plan').innerText();
      assert.ok(near.includes('已进入考前 21 天：每天读什么由「期末一周」排。') && near.includes('距考试 10 天'), `${width}px: ${near}`);
      assert.equal(await page.locator('.book-plan .crunch-day, .book-plan__next').count(), 0, `${width}px: no day is said twice`);
      assert.equal(await page.locator('.book-today').count(), 0);
      await page.locator('.book-plan__handover').getByRole('button', { name: '今天读哪几节' }).click();
      await page.locator('.book-today .crunch-day').waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.book-plan .crunch-day').count(), 0, `${width}px: the day is the final week's, once`);
      overflow = await sideways(page);
      assert.ok(flat(overflow), `${width}px: nothing scrolls sideways inside the final week: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) { await page.locator('.book-plan').scrollIntoViewIfNeeded(); await page.screenshot({ path: join(shots, `plan-final-week-${width}.png`) }); }

      // No plan, an exam date: one quiet line with the hand-off.
      await running.api('course.save', { name: COURSE, plan: null });
      await openBook(page, running);
      const quiet = page.locator('.book-plan--quiet');
      await quiet.waitFor({ timeout: 30000 });
      assert.match(await quiet.innerText(), /还没有备考计划：和主会话一起定一份.*发给主会话/s);
      assert.equal(await quiet.getByRole('button', { name: '设置考试日期' }).count(), 0);
      await settleAnimations(page);
      if (shots) { await quiet.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(shots, `plan-none-${width}.png`) }); }

      // No exam date: the line points at the existing way (the course settings) and at the hand-off.
      await running.api('course.save', { name: COURSE, exam: null });
      await openBook(page, running);
      await quiet.waitFor({ timeout: 30000 });
      assert.match(await quiet.innerText(), /备考计划要先有考试日期。.*设置考试日期.*发给主会话/s);
      overflow = await sideways(page);
      assert.ok(flat(overflow), `${width}px: nothing scrolls sideways with the quiet line: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) { await quiet.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(shots, `plan-no-exam-${width}.png`) }); }
      await quiet.getByRole('button', { name: '设置考试日期' }).click();
      await page.getByText(/考试日期/).first().waitFor({ timeout: 30000 });

      assert.deepEqual(errors.filter(line => !/status of 400/.test(line)), [], `${width}px: no page errors`);
      await context.close();
    }
    // English, 420 px wide: the same section, every word English, nothing scrolls sideways.
    await running.api('course.save', { name: COURSE, exam: { date: addDays(TODAY, 40) } });
    await running.api('course.save', { name: COURSE, plan: PLAN });
    const en = await openPage(browser, running, { lang: 'en', width: 420, height: 900 });
    await openBook(en.page, running, 'Open the book page');
    const english = en.page.locator('.book-plan[data-plan="plan"]');
    await english.waitFor({ timeout: 30000 });
    const said = await english.innerText();
    for (const part of ['Study plan', 'Exam in 40 days', '1 of 2 learnt · 2 of 2 placed', 'Study day', 'Refresh', 'Send to the main chat']) assert.ok(said.includes(part), `English: ${part}: ${said}`);
    assert.doesNotMatch(said.replace(/打基础|冲刺|把每一章读一遍，做完每节的 5 道题|只做薄弱点和模拟卷/g, ''), /[㐀-鿿]/, 'English: no Chinese left but the plan own words');
    const overflow = await sideways(en.page);
    assert.ok(flat(overflow), `English 420px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
    await settleAnimations(en.page);
    if (shots) { await english.scrollIntoViewIfNeeded(); await en.page.screenshot({ path: join(shots, 'plan-open-420-en.png') }); }
    assert.deepEqual(en.errors.filter(line => !/status of 400/.test(line)), [], 'English: no page errors');
    await en.context.close();
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
