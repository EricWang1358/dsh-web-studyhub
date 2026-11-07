/* global document window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { customDefaults } from '../lib/custom-plan.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* A second course shares the materials and saves a plan that also names a chapter the book no longer holds (#758): its card must say so. */
const MOVED = 'Moved course';

/* 「你的定制」 in the real course settings (深度定制, 4.4 S0), zh dark at 1280 px and en light at 420 px: the card with its sentence, the rough cost line, the parts as
   toggles and three switches; a toggle is saved through course.save {custom} (and the cost is read again); a course with no 定制方案 has no card; nothing scrolls
   sideways. Pictures go to CUSTOM_PLAN_SHOTS when set. */

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary({ paper: true });
  await service.store.update(own => {
    own.sources.push(...sources.map(source => ({ ...source, courses: [...source.courses, MOVED] }))); own.decks.push(...decks);
    own.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });
  const { skeleton } = await service.call('course.custom.preview', { course: COURSE });
  const lecture = skeleton.documents.find(doc => doc.chapters.length === 3 && !doc.copyOf);
  const custom = { ...customDefaults('review'), scope: { kind: 'chapters', chapters: lecture.chapters.map(chapter => chapter.id) },
    book: { make: true, coverage: 'standard', parts: ['explain', 'terms', 'confusables'] } };
  await service.call('course.save', { name: COURSE, exam: { date: '2027-01-20' }, custom });
  await service.call('course.save', { name: MOVED, custom: { ...custom, scope: { kind: 'chapters', chapters: [...custom.scope.chapters, 'document-gone#9'] } } });
  await service.call('course.save', { name: 'Plain course' });
  await service.dispose();
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth;
  const wide = [...document.querySelectorAll('.course-settings *')].filter(element => element.getBoundingClientRect().right > width + 1).map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});

async function openSettings(page, name) {
  await (await revealNavRow(page, 'settings')).dispatchEvent('click');
  await page.locator('[data-category="courses"]').first().click();
  await page.locator('.course-list__item', { has: page.getByText(name, { exact: true }) }).locator('.course-list__action').click();
  await page.locator('.course-settings').waitFor({ timeout: 30000 });
}

test('「你的定制」: the card, a saved toggle, no card without a plan, no sideways scroll (zh dark 1280, en light 420)', { timeout: 480000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-custom-plan-dist-'));
  await buildPreview({ outdir: dist });
  const shots = process.env.CUSTOM_PLAN_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const { width, lang, theme } of [{ width: 1280, lang: 'zh', theme: 'dark' }, { width: 420, lang: 'en', theme: 'light' }]) {
    const zh = lang === 'zh', say = (cn, en) => (zh ? cn : en);
    const running = await startLateServer({ distDir: dist, seed, lang });
    try {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900, lang, theme });
      await page.goto(running.server.url);
      await openSettings(page, COURSE);
      const card = page.locator('.course-settings .custom-card');
      await card.waitFor({ timeout: 30000 });
      assert.match(await card.locator('.custom-card__summary').innerText(), zh ? /^期末复习 · .* · 讲解标准 \+ 术语卡 \+ 易混对照 · 各种题型 · 按考试日期排计划$/
        : /^Final review · .* · Explanations: Standard \+ Term cards \+ Confusable pairs · All question types · Plan back from the exam date$/, `${width}px: the sentence`);
      await card.locator('.custom-card__estimate').waitFor({ timeout: 30000 });
      assert.match(await card.locator('.custom-card__estimate').innerText(), zh ? /^粗估：约 \d+ 次模型调用，读取约 [\d.]+K? tok$/ : /^Rough: about \d+ model calls, reading about [\d.]+K? tok$/, `${width}px: the cost line`);
      assert.doesNotMatch(await card.innerText(), /价|费用|元|\$|¥|price|cost/i, `${width}px: no price`);
      const chips = card.locator('.custom-card__parts button');
      assert.equal(await chips.count(), 7);
      assert.equal(await card.locator('.custom-card__parts button[aria-pressed="true"]').count(), 3);
      // The parts something rests on are locked (explain and terms rest under 易混对照).
      assert.equal(await chips.nth(0).isDisabled(), true, 'explain is locked while terms is on');
      assert.equal(await chips.nth(1).isDisabled(), true, 'terms is locked while confusables is on');
      assert.equal(await chips.nth(4).isDisabled(), false);
      assert.equal(await card.locator('[role="alert"], [role="status"]', { hasText: say('找不到了', 'no longer in the material') }).count(), 0, `${width}px: a plan whose chapters are all there says nothing of moved chapters`);
      const flat = await sideways(page);
      assert.ok(flat.doc <= 0 && flat.wide.length === 0, `${width}px: nothing scrolls sideways: ${JSON.stringify(flat)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `card-${lang}-${theme}-${width}.png`) });

      // 速查表 on: saved, the sentence says it, the cost is read again.
      const before = await card.locator('.custom-card__estimate').innerText();
      await chips.nth(6).click();
      await page.locator('.custom-card__parts button[aria-pressed="true"]').nth(3).waitFor({ timeout: 30000 });
      assert.match(await card.locator('.custom-card__summary').innerText(), say(/速查表$|速查表 · /, /Cheat sheet · /));
      const saved = (await running.api('course.get', { name: COURSE })).custom;
      assert.deepEqual(saved.book.parts, ['explain', 'terms', 'confusables', 'cheatSheet']);
      assert.equal(saved.scope.kind, 'chapters', 'the rest of the record is as it was');
      assert.equal(typeof before, 'string');

      // 变式题 off, 出题 off: saved; with the questions off the variants switch cannot be used.
      await card.getByRole('switch', { name: say('变式题', 'Variants') }).click();
      await until(async () => (await running.api('course.get', { name: COURSE })).custom.questions.variants === false, 'the variants switch saved');
      await card.getByRole('switch', { name: say('出题', 'Question writing') }).click();
      await page.waitForFunction(() => document.querySelector('.custom-card__summary')?.textContent.includes('不出题') || document.querySelector('.custom-card__summary')?.textContent.includes('No questions'), null, { timeout: 30000 });
      assert.equal(await card.getByRole('switch', { name: say('变式题', 'Variants') }).isDisabled(), true);
      assert.equal((await running.api('course.get', { name: COURSE })).custom.questions.make, false);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `card-${lang}-${theme}-${width}-after.png`) });

      // A plan that names a chapter the book no longer holds (#758): the card says how many, once, and offers the one hand-off that picks them again.
      await page.keyboard.press('Escape');
      await page.locator('.course-settings').waitFor({ state: 'detached', timeout: 30000 });
      await page.locator('.course-list__item', { has: page.getByText(MOVED, { exact: true }) }).locator('.course-list__action').click();
      await page.locator('.course-settings').waitFor({ timeout: 30000 });
      const moved = page.locator('.course-settings .custom-card');
      const notice = moved.getByText(say('有 1 章在资料里找不到了，需要重新选', '1 chapter(s) are no longer in the material and must be picked again'));
      await notice.waitFor({ timeout: 30000 });
      await moved.getByRole('button', { name: say('发给主会话', 'Send to the main chat') }).waitFor({ timeout: 30000 });
      const movedFlat = await sideways(page);
      assert.ok(movedFlat.doc <= 0 && movedFlat.wide.length === 0, `${width}px: the notice does not scroll sideways: ${JSON.stringify(movedFlat)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `card-moved-${lang}-${theme}-${width}.png`) });

      // A course with no 定制方案 has no card.
      await page.keyboard.press('Escape');
      await page.locator('.course-settings').waitFor({ state: 'detached', timeout: 30000 });
      await page.locator('.course-list__item', { has: page.getByText('Plain course', { exact: true }) }).locator('.course-list__action').click();
      await page.locator('.course-settings').waitFor({ timeout: 30000 });
      assert.equal(await page.locator('.custom-card').count(), 0, `${width}px: no card without a plan`);
      await context.close();
      assert.deepEqual(errors, [], `${width}px: no console errors`);
    } finally { await running.close(); }
  }
});
