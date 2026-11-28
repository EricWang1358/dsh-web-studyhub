/* global document, window */
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

/* #1694: 资料 with the sample course's two materials. By default only 课程范围 and the search box stand over the list (two rows of controls), so the first
   material is on the first screen of a narrow pane. Type, category, AI 智能分类, grouping, sort, 只看待巩固 and 整理课程归属 are in 「筛选与分组」, which
   remembers being open; a filter in use is said while it is shut; controls in one row are one height; 找功能 still reaches 整理课程归属. */

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await sampleAction({ call: (name, args) => service.call(name, args), store: service.store, has: () => true }, 'sample.load', { language: 'zh' });
  service.dispose?.();
}

/** The controls over the list, grouped into the rows they are drawn in: each row is [{ name, top, height }]. */
const rowsOfControls = page => page.evaluate(() => {
  const list = document.querySelector('.sources-page .source-groups').getBoundingClientRect();
  const header = document.querySelector('.sources-page__header').getBoundingClientRect();
  const selector = '.sources-page input:not([type="checkbox"]), .sources-page [role="combobox"], .sources-page .sh-select__trigger, .sources-page .sh-seg, .sources-page .sh-btn:not(.sh-btn--link), .sources-page summary';
  const controls = [...document.querySelectorAll(selector)].filter(element => {
    // A segmented control is one control; the ⓘ inside the line of the estimate is part of that line's words.
    if ((element.closest('.sh-seg') && !element.matches('.sh-seg')) || element.closest('[data-classify-estimate]')) return false;
    const box = element.getBoundingClientRect();
    // (The header's hidden copy, measured for its fit, is not on screen.)
    return element.checkVisibility({ visibilityProperty: true }) && !element.closest('.sources-page__fit') && box.height > 0 && box.top >= header.bottom - 1 && box.bottom <= list.top + 1;
  }).map(element => { const box = element.getBoundingClientRect();
    return { name: (element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.textContent.trim()).slice(0, 16), top: box.top, bottom: box.bottom, height: box.height, left: box.left, right: box.right }; })
    .sort((a, b) => a.top - b.top);
  const rows = [];
  for (const control of controls) {
    const row = rows.find(items => items.some(item => control.top < item.bottom - 4 && control.bottom > item.top + 4));
    if (row) row.push(control); else rows.push([control]);
  }
  return rows;
});
const oneHeight = (rows, where) => {
  for (const row of rows) {
    const heights = row.map(control => control.height);
    assert.ok(Math.max(...heights) - Math.min(...heights) < 1.5, `${where}: one row, one height: ${row.map(control => `${control.name}=${Math.round(control.height)}`).join(', ')}`);
  }
};

test('资料 keeps filters, grouping and the organizer in 「筛选与分组」', { timeout: 600000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-sources-tools-'));
  const distDir = join(base, 'dist');
  await buildPreview({ outdir: distDir });
  await seed(join(base, 'library'));
  const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir });
  try {
    for (const [lang, width, height, theme] of [['zh', 1440, 900, 'light'], ['zh', 420, 860, 'dark'], ['en', 420, 860, 'light'], ['en', 320, 760, 'dark']]) {
      const where = `${lang} ${width}`;
      const { page, errors, context } = await openPage(browser, { server }, { lang, theme, width, height });
      const open = async () => {
        await (await revealNavRow(page, 'sources')).dispatchEvent('click');
        await page.locator('.source-doc').first().waitFor({ timeout: 30000 });
        await page.keyboard.press('Escape');
        await settleAnimations(page);
        await frames(page, 4);
      };
      await page.goto(server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      await open();
      const toggle = page.locator('.sources-page [data-tour="sources-tools"]');
      const name = lang === 'zh' ? '筛选与分组' : 'Filter & group';
      assert.equal(await page.getByRole('button', { name, exact: true }).count(), 1, `${where}: one button, named ${name}`);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false', `${where}: shut by default`);

      const shut = await rowsOfControls(page);
      assert.ok(shut.length <= 2, `${where}: at most two rows of controls before the first material: ${JSON.stringify(shut.map(row => row.map(control => control.name)))}`);
      oneHeight(shut, `${where} shut`);
      assert.equal(await page.locator('.sources-view-bar, .source-organize').count() + await page.locator('.material-category-bar__controls:visible').count(), 0, `${where}: nothing else is over the list`);
      const first = await page.locator('.source-doc').first().evaluate(row => ({ title: row.querySelector('.source-title').getBoundingClientRect().top, bottom: row.getBoundingClientRect().bottom,
        sideways: document.documentElement.scrollWidth - window.innerWidth }));
      if (height >= 860) assert.ok(first.bottom <= height && first.title < height * 0.6, `${where}: the first material is whole on the first screen (name at ${Math.round(first.title)}, ends ${Math.round(first.bottom)} of ${height})`);
      assert.ok(first.sideways <= 0, `${where}: no sideways scroll`);
      // The words of the button never cost the course its name: where there is no room for both, the button is its icon.
      const course = await page.locator('.sources-page .page-scope__select').evaluate(select => {
        const words = [...select.querySelectorAll('span')].find(span => span.scrollWidth > 0 && span.textContent.trim()) ?? select;
        return { cut: words.scrollWidth > words.clientWidth + 1, wordsShown: document.querySelector('.sources-tools-toggle__label').getBoundingClientRect().width > 2 };
      });
      if (width >= 420) assert.equal(course.cut && course.wordsShown, false, `${where}: the course is not cut to make room for the button's words`);

      await toggle.click();
      await page.locator('.sources-view-bar').waitFor();
      await settleAnimations(page);
      await frames(page, 4);
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      for (const part of ['.material-category-bar__select', '[data-ai-classify]', '.sources-view-bar .sh-seg', '.sources-view-bar__sort', '.sources-view-bar__review', '.source-organize > summary'])
        assert.ok(await page.locator(`.sources-page ${part}`).first().isVisible(), `${where}: ${part} is in the open fold`);
      oneHeight(await rowsOfControls(page), `${where} open`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth) <= 0, `${where}: no sideways scroll when open`);

      if (width === 420 && lang === 'zh') {
        // It remembers being open, and remembers being shut.
        await page.reload();
        await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
        await open();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true', `${where}: still open after a reload`);

        // A filter in use is said while it is shut, with the way back.
        const rows = await page.locator('.source-doc').count();
        await page.locator('.sources-page .material-category-bar__select').first().click();
        const option = page.locator('[role="option"]').nth(1);
        const picked = (await option.innerText()).replace(/\s*\(\d+\)\s*$/, '').trim();
        await option.click();
        await page.locator('.sources-view-bar__review').click();
        assert.equal(await page.locator('[data-material-filters-on]').count(), 0, `${where}: open, the controls say it themselves`);
        await toggle.click();
        const said = page.locator('.sources-page [data-material-filters-on]');
        await said.waitFor();
        const line = await said.innerText();
        assert.ok(line.includes(picked) && line.includes('待巩固'), `${where}: the filters in use are said while shut (${line})`);
        assert.ok(await toggle.evaluate(element => element.classList.contains('is-on')), `${where}: and the button is marked`);
        await said.getByRole('button', { name: '清除筛选' }).click();
        await until(async () => await said.count() === 0 && await page.locator('.source-doc').count() === rows, `${where}: 清除筛选 brings every material back`);

        await page.reload();
        await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
        await open();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false', `${where}: and stays shut after a reload`);

        // 找功能 opens the fold and the organizer in it.
        await page.keyboard.press('Control+k');
        await page.getByRole('dialog').getByRole('combobox').fill('整理课程归属');
        await page.keyboard.press('Enter');
        await page.locator('.sources-page details.source-organize[open]').waitFor({ timeout: 15000 });
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true', `${where}: 找功能 opens 筛选与分组`);
        await toggle.click();
        await until(async () => await page.locator('.source-organize').count() === 0, `${where}: shut again`);
        assert.equal(await page.locator('.source-doc__check').count(), 0, `${where}: with the organizer put away, the rows have no boxes to tick`);
      }
      assert.deepEqual(errors, [], `${where}: no errors`);
      await context.close();
    }
  } finally {
    await browser.close();
    await server.close();
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
