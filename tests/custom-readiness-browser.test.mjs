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
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { COURSE, library, planOf } from './helpers/readiness-library.mjs';

/* 「章节准备度」 in the real course settings (深度定制 S5), zh dark at 1440 px and en light at 420 px: a row for each chapter of the plan with its thin bar and number, the four
   counts on hover (a Tooltip), 未生成 on the chapter the book has not written, 补齐 on the chapters with something missing; 补齐 says what it would start and the rough calls
   (or that it cannot say) and starts nothing until 开始补齐; nothing scrolls sideways. Pictures go to CUSTOM_READINESS_SHOTS when set (output/qa/custom-readiness-s5). */

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { state, attempts, drafts } = library();
  await service.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.attempts.push(...attempts); own.drafts.push(...drafts); own.focus = state.focus; });
  await service.call('course.save', { name: COURSE, exam: { date: '2027-01-20' }, custom: planOf() });
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
  await page.locator('.course-list__item', { hasText: name }).locator('.course-list__action').click();
  await page.locator('.course-settings').waitFor({ timeout: 30000 });
}

test('「章节准备度」: the rows, the hover counts, 未生成, 补齐 says what it would do and starts nothing, no sideways scroll (zh dark 1440, en light 420)', { timeout: 480000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-custom-readiness-dist-'));
  await buildPreview({ outdir: dist });
  const shots = process.env.CUSTOM_READINESS_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const { width, height, lang, theme } of [{ width: 1440, height: 1100, lang: 'zh', theme: 'dark' }, { width: 420, height: 1300, lang: 'en', theme: 'light' }]) {
    const zh = lang === 'zh', say = (cn, en) => (zh ? cn : en);
    const running = await startLateServer({ distDir: dist, seed, lang });
    try {
      const { page, errors, context } = await openPage(browser, running, { width, height, lang, theme });
      await page.goto(running.server.url);
      await openSettings(page, COURSE);
      const list = page.locator('.course-settings .custom-readiness');
      await list.waitFor({ timeout: 30000 });
      const rows = list.locator('.custom-readiness__row');
      assert.equal(await rows.count(), 3, `${width}px: a row for each chapter of the plan`);
      assert.deepEqual(await rows.locator('.custom-readiness__title').allInnerTexts(), ['Introduction', 'Requirements', 'Patterns']);
      assert.deepEqual(await rows.locator('.custom-readiness__value').allInnerTexts(), ['50%', '0%', '0%'], `${width}px: the readiness of each chapter`);
      assert.equal(await rows.nth(2).getByText(say('未生成', 'Not built')).count(), 1, 'the chapter the book has not written says so');
      assert.equal(await rows.nth(0).getByText(say('未生成', 'Not built')).count(), 0);
      assert.equal(await list.getByRole('progressbar').count(), 3);
      const bars = await rows.locator('.sh-progress').evaluateAll(elements => elements.map(element => Math.round(element.getBoundingClientRect().width)));
      assert.ok(bars.every(wide => wide >= 60), `${width}px: the bars are drawn, not collapsed: ${bars}`);
      assert.equal(await rows.nth(0).locator('.sh-progress__fill').evaluate(fill => fill.style.transform), 'scaleX(0.5)', 'half of the chapter is solid');
      assert.equal(await rows.nth(0).getByRole('button', { name: say('补齐', 'Fill gaps') }).count(), 1, 'something is missing in each chapter');
      assert.equal(await list.getByRole('button', { name: say('全部补齐', 'Fill all gaps') }).count(), 1);
      assert.equal(await list.locator('[title]').count(), 0, 'hover words are Tooltips, not title attributes');
      assert.doesNotMatch(await list.innerText(), /价|费用|元|\$|¥|price|cost/i, `${width}px: no price`);

      // The four counts on hover.
      await rows.nth(0).locator('.custom-readiness__meter').hover();
      const tip = page.getByRole('tooltip').filter({ hasText: say('扎实 1/2', 'Solid 1/2') });
      await tip.first().waitFor({ state: 'visible', timeout: 10000 });
      assert.match(await tip.first().innerText(), say(/讲解 2\/2 · 有题 2\/2 · 练过 2\/2 · 扎实 1\/2/, /Explained 2\/2 · With questions 2\/2 · Practised 2\/2 · Solid 1\/2/));
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `readiness-hover-${lang}-${theme}-${width}.png`) });
      await page.mouse.move(0, 0);

      // 补齐 says what it would do and starts nothing.
      await rows.nth(1).getByRole('button', { name: say('补齐', 'Fill gaps') }).click();
      const ask = page.locator('.course-settings .custom-readiness [role="group"]');
      await ask.waitFor({ timeout: 30000 });
      assert.match(await ask.innerText(), say(/补齐 「Requirements」[\s\S]*出题 3 个知识点/, /Fill gaps in “Requirements”[\s\S]*write questions for 3 points/));
      assert.match(await ask.innerText(), say(/调用|次/, /calls|Jobs/), `${width}px: the calls are said (or that they cannot be)`);
      assert.deepEqual((await running.api('job.status')).jobs, [], 'asking started nothing');
      const flat = await sideways(page);
      assert.ok(flat.doc <= 0 && flat.wide.length === 0, `${width}px: nothing scrolls sideways: ${JSON.stringify(flat)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `readiness-fill-${lang}-${theme}-${width}.png`) });
      await ask.getByRole('button', { name: say('取消', 'Cancel') }).click();
      await ask.waitFor({ state: 'detached', timeout: 10000 });
      await context.close();
      assert.deepEqual(errors, [], `${width}px: no console errors`);
    } finally { await running.close(); }
  }
});
