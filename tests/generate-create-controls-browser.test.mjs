/* global document, window, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { StudyService } from '../lib/service.js';
import { sampleAction } from '../lib/sample-library.js';

/* The controls of 创建题组, in a real browser on the sample course (a course with a case-study exam):
   #1700  the three ways in are the app's segmented control: the chosen one is the raised block, one Tab stop, arrow keys move, Enter chooses;
   #1701  the last ticked question type looks like any ticked one, stays ticked, and says why on a click, on keyboard focus and on hover;
   #1702  where the new deck goes is a row of the form (and the case-paper hint is under it), and nothing but the primary button is in the accent. */

const SIZES = [[1440, 900, 'light'], [420, 860, 'dark']];
const WHY = '至少保留一种题型';

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await sampleAction({ call: (name, args) => service.call(name, args), store: service.store, has: () => true }, 'sample.load', { language: 'zh' });
  service.dispose?.();
}

/** How a question-type row is drawn: its box and its word. */
const kindLook = (page, name) => page.evaluate(selector => {
  const input = document.querySelector(selector), row = input.closest('label'), box = getComputedStyle(input), word = getComputedStyle(row.querySelector('.sh-check__label'));
  return { checked: input.checked, box: box.backgroundColor, edge: box.borderTopColor, boxOpacity: box.opacity, word: word.color, rowOpacity: getComputedStyle(row).opacity, cursor: box.cursor };
}, `input[name="${name}"]`);

/** Is the reason's card on screen (a top-layer popover with the words)? */
const whyShown = page => page.evaluate(words => [...document.querySelectorAll('[role="tooltip"]')]
  .some(card => card.textContent === words && card.matches(':popover-open') && card.getBoundingClientRect().height > 0), WHY);

async function lastKindSaysWhy(page, where, name) {
  const box = page.locator(`input[name="${name}-quiz"]`), other = page.locator(`input[name="${name}-multi"]`);
  const word = box.locator('xpath=..').locator('.sh-check__label');
  await box.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await settleAnimations(page);
  const alone = await kindLook(page, `${name}-quiz`);
  await other.click();
  await until(() => other.isChecked(), `${where}: a second type ticked`);
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement?.blur());
  await settleAnimations(page);
  assert.deepEqual(alone, await kindLook(page, `${name}-quiz`), `${where}: the only ticked type is drawn as it is with a second one ticked`);
  await other.click();
  await until(async () => !(await other.isChecked()), `${where}: and unticked again`);
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement?.blur());
  await until(async () => !(await whyShown(page)), `${where}: no card before anything is tried`);

  // A click on its word unticks nothing and says why at once. (force: Playwright counts aria-disabled as not clickable; a learner's press arrives.)
  await word.click({ force: true });
  assert.equal(await box.isChecked(), true, `${where}: a click leaves the last type ticked`);
  await until(() => whyShown(page), `${where}: a click says why`);
  // A second click, with the focus already there and the card dismissed, says it again.
  await page.keyboard.press('Escape');
  await until(async () => !(await whyShown(page)), `${where}: Esc closes the card`);
  await box.click({ force: true });
  assert.equal(await box.isChecked(), true);
  await until(() => whyShown(page), `${where}: a second click says why again`);
  await page.mouse.move(0, 0);
  await page.evaluate(() => document.activeElement?.blur());
  await until(async () => !(await whyShown(page)), `${where}: the card closes when the pointer and the focus leave`);

  // The keyboard: reaching the box says why, and Space unticks nothing.
  await other.focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await box.evaluate(element => element === document.activeElement), true, `${where}: the last type is a Tab stop`);
  await until(() => whyShown(page), `${where}: keyboard focus says why`);
  await page.keyboard.press('Space');
  await frames(page, 3);
  assert.equal(await box.isChecked(), true, `${where}: Space leaves it ticked`);
  await page.evaluate(() => document.activeElement?.blur());
  await until(async () => !(await whyShown(page)), `${where}: closed again`);

  // Hover.
  await word.hover();
  await until(() => whyShown(page), `${where}: hover says why`);
  await page.mouse.move(0, 0);
}

test('创建题组 controls: the ways in, the last question type and the course row', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-create-controls-'));
  const distDir = join(base, 'dist');
  await buildPreview({ outdir: distDir });
  await seed(join(base, 'library'));
  const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir });
  try {
    for (const [width, height, theme] of SIZES) {
      const where = `${width} ${theme}`;
      const { page, errors, context } = await openPage(browser, { server }, { lang: 'zh', theme, width, height });
      await page.goto(server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      await (await revealNavRow(page, 'generate')).dispatchEvent('click');
      await page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });
      await page.keyboard.press('Escape');
      await settleAnimations(page);

      // #1700: the chosen way is the raised thumb every segmented control has.
      const ways = page.getByRole('group', { name: '创建方式' });
      const way = name => ways.getByRole('button', { name, exact: true });
      const thumbs = () => page.evaluate(() => {
        const look = selector => { const thumb = document.querySelector(`${selector} > .sh-seg__thumb`), group = thumb.parentElement;
          const style = getComputedStyle(thumb), on = group.querySelector(':scope > .sh-seg__item.is-active'), box = on.getBoundingClientRect(), at = thumb.getBoundingClientRect();
          return { look: [style.backgroundColor, style.boxShadow, style.opacity, getComputedStyle(group).backgroundColor, getComputedStyle(on).color].join(' | '),
            under: Math.abs(box.left - at.left) < 1 && Math.abs(box.top - at.top) < 1 && Math.abs(box.width - at.width) < 1 }; };
        return { ways: look('.source-mode'), preset: look('.presets__choice') };
      });
      await until(async () => (await thumbs()).ways.under, `${where}: the thumb is under the chosen way`);
      const drawn = await thumbs();
      assert.equal(drawn.ways.look, drawn.preset.look, `${where}: the ways in are drawn as 出题方式 is`);
      assert.equal(await way('用资料出题').getAttribute('aria-pressed'), 'true');
      await way('用资料出题').focus();
      await page.keyboard.press('ArrowRight');
      assert.equal(await way('导入 JSON 题组').evaluate(element => element === document.activeElement), true, `${where}: the arrow keys move along the row`);
      assert.equal(await way('用资料出题').getAttribute('aria-pressed'), 'true', `${where}: moving chooses nothing yet`);
      await page.keyboard.press('Enter');
      await until(async () => await way('导入 JSON 题组').getAttribute('aria-pressed') === 'true', `${where}: Enter chooses`);
      assert.equal(await page.locator('[data-tour="generate-sources"]').count(), 0, `${where}: the panel is the chosen way's`);
      await until(async () => /已有题目/.test(await ways.evaluate(element => document.getElementById(element.getAttribute('aria-describedby')).textContent)), `${where}: the group is described by the chosen way's line`);
      await way('用资料出题').click();
      await page.locator('[data-tour="generate-sources"] .source-picker__item').first().waitFor({ timeout: 30000 });

      // #1701
      await lastKindSaysWhy(page, `${where} 创建题组`, 'kinds');

      // #1702: the course is a row of the form, in the two columns of the rows above it; the case hint stands under it.
      const place = () => page.evaluate(() => {
        const box = element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
        // The middle of the first line of words inside an element (its own padding left out).
        const middle = element => { const range = document.createRange(); range.selectNodeContents(element); const r = range.getClientRects()[0]; return (r.top + r.bottom) / 2; };
        const row = tour => { const element = document.querySelector(`.generate-rows--main > [data-tour="${tour}"]`);
          return element && { label: box(element.querySelector(':scope > .generate-row__label')), control: box(element.querySelector(':scope > .generate-row__control')), words: element.querySelector(':scope > .generate-row__label').textContent }; };
        const course = document.querySelector('.generate-rows--main > [data-tour="generate-course"]');
        return { kinds: row('generate-kinds'), preset: row('generate-preset'), course: row('generate-course'),
          level: course && [middle(course.querySelector('.generate-row__label')), middle(course.querySelector('.generate-plan__course'))],
          name: course && box(course.querySelector('.generate-plan__course')), hint: course && box(course.querySelector('.generate-plan__hint')), sideways: document.documentElement.scrollWidth - window.innerWidth };
      });
      const rows = await place();
      assert.ok(rows.course, `${where}: where the new deck goes is one of the form's rows`);
      assert.equal(rows.course.words, '新题组放进的课程');
      for (const other of [rows.kinds, rows.preset]) {
        assert.ok(Math.abs(rows.course.label.left - other.label.left) < 0.5, `${where}: its label starts where the other labels do`);
        assert.ok(Math.abs(rows.course.control.left - other.control.left) < 0.5, `${where}: its words start where the other controls do`);
      }
      assert.ok(Math.abs(rows.name.left - rows.course.control.left) < 0.5 && Math.abs(rows.hint.left - rows.course.control.left) < 0.5, `${where}: the course and the case hint share that edge`);
      if (width > 640) assert.ok(Math.abs(rows.level[0] - rows.level[1]) < 3, `${where}: the label is level with the course's name (${rows.level})`);
      assert.ok(rows.sideways <= 0, `${where}: no sideways scroll`);

      // 更改 opens the field inside the row; nothing but the one primary button is written in the accent, 更多选项 open too.
      await page.locator('[data-tour="generate-course"]').getByRole('button', { name: '更改' }).click();
      await page.locator('.generate-rows--main [data-tour="generate-course"] .course-field').waitFor();
      await page.locator('[data-tour="generate-course"]').getByRole('button', { name: '收起' }).click();
      await page.locator('[data-tour="generate-more"] > summary').click();
      await page.locator('[data-tour="generate-depth"]').waitFor();
      await settleAnimations(page);
      const accented = await page.evaluate(() => {
        const probe = document.querySelector('.generate-page').appendChild(document.createElement('span'));
        const accents = new Set(['--accent', '--accent-text'].map(token => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; }));
        probe.remove();
        return [...document.querySelectorAll('.generate-page button, .generate-page a, .generate-page summary, .generate-page p, .generate-page span, .generate-page label')]
          .filter(element => element.getClientRects().length && !element.closest('.sh-btn--primary') && accents.has(getComputedStyle(element).color) && element.textContent.trim())
          .map(element => `${element.tagName.toLowerCase()}.${element.className}: ${element.textContent.trim().slice(0, 24)}`);
      });
      assert.deepEqual(accented, [], `${where}: only the primary button uses the accent`);

      // 设置 › 出题偏好 is the same group of boxes.
      await page.locator('[data-open-settings="settings-generation"]').click();
      await page.locator('[data-tour="settings-generation"] input[name="kinds-quiz"]').waitFor({ timeout: 30000 });
      await settleAnimations(page);
      await lastKindSaysWhy(page, `${where} 出题偏好`, 'kinds');

      assert.deepEqual(errors, [], `${where}: no errors`);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
