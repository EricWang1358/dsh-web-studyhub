/* global document, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { drainLayoutStability, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { frames, until } from '../scripts/qa/layout-late.mjs';
import { startConsole, startJobs, openConsole, measure } from '../scripts/qa/task-console.mjs';

/* 目标与知识点 in the browser, on a seeded temporary library with the fake model: a question run whose plan has returned and whose later calls are held in flight. The third tab of the left panel
   has the goal and the table of points; it fills the panel, scrolls inside itself, leaves the rows of 正在进行 where they were, does not scroll the page sideways, fits the strip of tabs at 1280 and
   420, and nothing moves when the points change state (the model is let go, the points become 已通过). */

/** The rows of the table against the top of their section (the controls above the console shrink when a task ends, which moves the whole panel, not the rows in it). */
const inside = (page) => page.evaluate(() => { const top = document.querySelector('.tc-plan').getBoundingClientRect().top; return [...document.querySelectorAll('[data-point]')].map((row) => { const r = row.getBoundingClientRect(); return [Math.round(r.top - top), Math.round(r.height)]; }); });
const boxes = (page, selector) => page.evaluate((query) => [...document.querySelectorAll(query)].map((element) => { const r = element.getBoundingClientRect(); return [Math.round(r.top), Math.round(r.left), Math.round(r.width), Math.round(r.height)]; }), selector);

test('the goal and the points tab fills the panel, scrolls inside it, moves nothing around it and keeps its rows still when their states change', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-plan-dist-'));
  await buildPreview({ outdir: dist });
  try {
    for (const width of [1280, 420]) {
      const running = await startConsole({ distDir: dist, passPlan: true });
      try {
        await startJobs(running);
        const { page, errors, context } = await openConsole(browser, running, { lang: 'zh', theme: 'dark', width, height: 900 });
        await until(async () => (await page.locator('.tc-callrow').count()) > 0, 'a call in flight');
        // The learner's own pick stands (otherwise the console moves to the next running task when this one ends): the question run, the newest, is the first row.
        await page.locator('.tc-row').first().dispatchEvent('click');
        await frames(page, 6);
        await drainLayoutStability(page);
        const calls = await boxes(page, '.tc-callrow'), tabs = await page.locator('.tc-tabs').first().evaluate((strip) => {
          const box = strip.getBoundingClientRect();
          return { scrolls: strip.scrollWidth > strip.clientWidth + 1, tabs: [...strip.querySelectorAll('[role=tab]')].map((tab) => { const r = tab.getBoundingClientRect(); return { left: Math.round(r.left - box.left), right: Math.round(r.right - box.left), text: tab.innerText.trim() }; }), width: Math.round(box.width) };
        });
        assert.equal(tabs.tabs.length, 3, 'the third tab is there beside the two');
        assert.match(tabs.tabs[2].text, /^目标与知识点\s*\d+$/, 'the full name: the three Chinese labels fit even the left column of a laptop and a phone');
        assert.ok(tabs.tabs.every((tab) => tab.left >= 0 && tab.right <= tabs.width + 1), `${width}px: no tab is clipped by the strip ${JSON.stringify(tabs)}`);
        assert.equal(tabs.scrolls, false, `${width}px: the three tabs fit without scrolling the strip`);
        await page.locator('[data-plan-tab]').dispatchEvent('click');
        await until(async () => (await page.locator('.tc-plan [data-point]').count()) >= 5, 'the points of the plan');
        await frames(page, 4);
        const panel = await page.locator('.tc-plan').evaluate((element) => {
          const box = element.getBoundingClientRect(), host = element.parentElement.getBoundingClientRect(), s = getComputedStyle(element);
          return { top: Math.round(box.top), height: Math.round(box.height), hostHeight: Math.round(host.height), scrolls: element.scrollHeight > element.clientHeight + 1, sideways: element.scrollWidth > element.clientWidth + 1, overflowY: s.overflowY };
        });
        assert.ok(panel.height >= 150, `${width}px: the section has room (${panel.height}px)`);
        assert.ok(Math.abs(panel.height - panel.hostHeight) <= 2, `${width}px: it fills its panel (${panel.height} of ${panel.hostHeight}px)`);
        assert.equal(panel.overflowY, 'auto');
        assert.ok(panel.scrolls, `${width}px: ten points do not fit, so the section scrolls inside itself`);
        assert.equal(panel.sideways, false, `${width}px: nothing scrolls sideways inside it`);
        const first = await measure(page);
        assert.ok(first.scrollWidth <= width, `no sideways scroll at ${width}px`);
        if (width === 1280) assert.equal(first.appScrolls, false, 'the page does not scroll: the panel does');
        const heads = await page.locator('.tc-plan__group').first().evaluate((element) => ({ sticky: getComputedStyle(element).position, text: element.textContent.trim() }));
        assert.equal(heads.sticky, 'sticky');
        assert.match(heads.text, /^第 1 批 · 5 个考点/);
        // The rows of 正在进行 are where they were: look at them again.
        await page.getByRole('tab', { name: /正在进行/ }).first().dispatchEvent('click');
        await frames(page, 4);
        assert.deepEqual(await boxes(page, '.tc-callrow'), calls, `${width}px: the rows of the calls in flight did not move`);
        await page.locator('[data-plan-tab]').dispatchEvent('click');
        await frames(page, 4);
        // The explanations: the state of a point says what it means, on keyboard focus too.
        await page.locator('[data-plan-state]').first().focus();
        await until(async () => (await page.locator('.sh-tooltip:popover-open').count()) > 0, 'the tooltip of a state');
        assert.match(await page.locator('.sh-tooltip:popover-open').first().innerText(), /这个考点/);
        await page.keyboard.press('Escape');
        const before = await inside(page), states = await page.locator('[data-point]').evaluateAll((rows) => rows.map((row) => row.dataset.state));
        assert.ok(states.every((state) => state !== 'passed'), 'nothing has passed while the model is held');
        assert.equal(new Set(before.map((box) => box[1])).size, 1, `${width}px: every row has the same height`);
        // Opening the tab and looking around it shifted nothing. (Ending the task does shift the page: its controls above fold away; that is not this section, so it is not measured.)
        const verdict = judgeLayoutStability(await drainLayoutStability(page), { maxCls: 0.05 });
        assert.ok(verdict.ok, `${width}px: ${verdict.message}`);
        // Let the model go: the points become 已通过, and no row moves or changes its height.
        running.release();
        await until(async () => (await page.locator('[data-plan-state="passed"]').count()) > 0, 'a point that passed', 120000);
        await until(async () => !(await running.api('snapshot')).jobs.some((job) => ['queued', 'running', 'cancelling'].includes(job.status)), 'the jobs to end', 120000);
        await frames(page, 6);
        const after = await inside(page);
        assert.deepEqual(after.map((box) => box[1]), before.map((box) => box[1]), `${width}px: no row changed its height when the states did`);
        assert.deepEqual(after.map((box) => box[0]), before.map((box) => box[0]), `${width}px: no row moved when the states changed`);
        assert.ok(await page.locator('.tc-plan').evaluate((element) => Math.abs(element.getBoundingClientRect().height - element.parentElement.getBoundingClientRect().height) <= 2), 'the section still fills its panel');
        assert.deepEqual(errors, []);
        await context.close();
      } finally { await running.close(); }
    }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});
