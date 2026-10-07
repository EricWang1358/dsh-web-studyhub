/* global getComputedStyle, document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { drainLayoutStability, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { frames, until } from '../scripts/qa/layout-late.mjs';
import { startConsole, startJobs, finishJobsThenHoldOne, openConsole, measure, measureCards, measureSelection, contrastRatio } from '../scripts/qa/task-console.mjs';

/* WP-TC in the browser, on a seeded temporary library with the fake model: an audio batch and a question run held in flight, and four days of 为你定制 in the
   coach's file. At 1280 the console is as tall as the window and every list scrolls INSIDE its panel (the page never grows); at 420 the columns stack and the page
   scrolls; picking another task moves nothing; the compact cards line up on the pages that carry them, and 「查看详情」 opens the console on that job. */

test('the 任务 console fits the window, scrolls inside its panels, stacks when narrow and does not shift when another task is picked', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-console-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startConsole({ distDir: dist });
  try {
    await startJobs(running);
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openConsole(browser, running, { lang: 'zh', theme: 'dark', width, height: 900 });
      await until(async () => (await page.locator('.tc-callrow').count()) > 0, 'a call in flight');
      await until(async () => (await page.locator('.tc-row').count()) >= 4, 'the jobs and the days of 为你定制 in the list');
      await frames(page, 6);
      await drainLayoutStability(page);
      const first = await measure(page);
      assert.equal(first.viewport.width, width);
      if (width === 1280) {
        assert.equal(first.appScrolls, false, 'the console fits the window: the page does not scroll');
        assert.ok(first.docHeight <= first.viewport.height + 1, `the document grew to ${first.docHeight}px in a ${first.viewport.height}px window`);
        assert.ok(Math.abs(first.console.bottom - first.main.bottom) <= 2, 'the console reaches the bottom of the window: it takes the height the bar leaves');
        assert.ok(Math.abs(first.body.bottom - first.detail.bottom) <= 2 && first.body.height >= 300, `the panels take the rest of the detail (body ${first.body.top}-${first.body.bottom}, ${first.body.height}px high; detail ends at ${first.detail.bottom}): a usage line must not push them down`);
        const [left, right] = first.cols;
        assert.equal(left.height, right.height, 'the two columns are as tall as each other');
      } else assert.equal(first.appScrolls, true, 'stacked: the page scrolls instead of splitting a phone-height window into panels');
      assert.ok(first.scrollWidth <= width, `no sideways scroll at ${width}px`);
      // every task in the list: pick it, and nothing around it moves
      const rows = await page.locator('.tc-row').count();
      for (let index = 0; index < rows; index++) {
        await page.locator('.tc-row').nth(index).dispatchEvent('click');
        await frames(page, 4);
        const picked = await measure(page);
        if (width === 1280) {
          assert.deepEqual(picked.console, first.console, `picking task ${index} moved the console`);
          assert.equal(picked.cols[0].height, picked.cols[1].height, `task ${index}: the two columns are as tall as each other`);
          assert.ok(Math.abs(picked.body.bottom - picked.detail.bottom) <= 2 && picked.body.height >= 300, `task ${index}: the panels take the rest of the detail (body ${picked.body.top}-${picked.body.bottom}, ${picked.body.height}px high; detail ends at ${picked.detail.bottom}), whether or not there is a usage line`);
          assert.equal(picked.appScrolls, false, `picking task ${index} made the page scroll`);
        }
        assert.ok(picked.scrollWidth <= width);
      }
      const verdict = judgeLayoutStability(await drainLayoutStability(page), { maxCls: 0.05 });
      assert.ok(verdict.ok, `${width}px: ${verdict.message}`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

test('the compact cards on the audio page and the library line up, and 查看详情 opens the console on that job', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-console-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startConsole({ distDir: dist });
  try {
    await startJobs(running);
    for (const [nav, width] of [['audio', 1280], ['library', 1280], ['audio', 420]]) {
      const { page, errors, context } = await openConsole(browser, running, { lang: 'zh', theme: 'dark', width, height: 900, nav });
      await frames(page, 6);
      await drainLayoutStability(page);
      const { cards, scrollWidth } = await measureCards(page);
      assert.ok(cards.length >= 1, `${nav}: a card for the job in flight`);
      assert.ok(scrollWidth <= width, `${nav} ${width}px: no sideways scroll`);
      for (const card of cards) {
        assert.equal(card.box.height, cards[0].box.height, `${nav}: the cards are the same height`);
        assert.equal(card.go.width, cards[0].go.width, `${nav}: the buttons are the same width`);
        assert.equal(card.go.x, cards[0].go.x, `${nav}: the buttons line up`);
        assert.ok(card.line.height <= 20, `${nav}: the status is ONE line`);
      }
      if (width === 1280) assert.equal(cards[0].go.width, 168);
      const id = cards[0].id;
      await page.locator('.cjc__go').first().dispatchEvent('click');
      await page.locator('.tc-detail').first().waitFor({ state: 'attached', timeout: 30000 });
      const shown = await page.locator('.tc-detail').first().getAttribute('data-task-id');
      assert.ok(shown === id || (await page.locator(`.tc-row[data-task-id="${shown}"]`).count()) === 1, `${nav}: the console opens on the job of the card (${id} -> ${shown})`);
      const verdict = judgeLayoutStability(await drainLayoutStability(page), { maxCls: 0.05 });
      assert.ok(verdict.ok, `${nav} ${width}px: ${verdict.message}`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/* 任务 归档 and 批量删除, with real clicks: two finished tasks (the audio batch and a question run) and one still running, besides the days of 为你定制. Select the two
   → 归档: they leave the default list and appear under 已归档, read-only; → 取消归档: they are back; → 删除 asks first (the dialog names what goes and what stays), 取消 deletes
   nothing, 确认 deletes the records and the audio batch's working folder. At 1280 and 420 the bar of the selection keeps its height and nothing makes the page wider or taller. */
test('select two finished tasks → 归档 → 已归档 → 取消归档, then 批量删除 with its confirmation, at 1280 and 420', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-console-dist-'));
  await buildPreview({ outdir: dist });
  try {
    for (const width of [1280, 420]) {
      const running = await startConsole({ distDir: dist });
      try {
        await startJobs(running);
        const runningId = await finishJobsThenHoldOne(running);
        const ids = (await running.api('snapshot')).jobs.filter((job) => job.id !== runningId && job.type !== 'coach-daily').map((job) => job.contract.jobId);
        assert.equal(ids.length, 2, 'the audio batch and the first question run have ended');
        const { page, errors, context } = await openConsole(browser, running, { lang: 'zh', theme: 'dark', width, height: 900 });
        const finish = async () => { await frames(page, 4); await drainLayoutStability(page); };
        await until(async () => (await page.locator('.tc-row').count()) >= 7, 'the three jobs and the four days of 为你定制 in the list');
        await finish();
        const filterText = async (name) => (await page.locator('.tc-filter', { hasText: name }).first().innerText()).replace(/\s+/g, ' ').trim();
        const first = await measure(page);
        const bar = () => page.locator('.tc-pickbar').evaluate((element) => { const r = element.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) }; });
        const idle = await bar();
        assert.equal(await page.locator('.tc-item__check input').count(), 2, 'a box on each finished task; none on the running one or on the days of 为你定制');
        assert.equal(await page.locator(`.tc-item:has(.tc-row[data-task-id="${runningId}"]) input`).count(), 0, 'the running task has no box');
        assert.equal(await filterText('已归档'), '已归档 0');
        // select everything that can be selected
        await page.locator('.tc-pickbar__all input').dispatchEvent('click');
        await page.locator('.tc-pickbar__actions').waitFor({ state: 'attached' });
        await finish();
        assert.match(await page.locator('.tc-pickbar').innerText(), /已选 2/);
        const picked = await bar(), pickedMeasure = await measure(page);
        assert.deepEqual(picked, idle, 'the bar keeps its place and its size when the actions appear');
        assert.equal(pickedMeasure.scrollWidth <= width, true, `selecting made the page wider than ${width}px`);
        assert.deepEqual(pickedMeasure.list, first.list, 'the list did not move or grow');
        if (width === 1280) assert.equal(pickedMeasure.appScrolls, false);
        const actionBox = await page.locator('.tc-pickbar__actions').evaluate((element) => {
          const r = element.getBoundingClientRect(), p = element.parentElement.getBoundingClientRect();
          return { right: Math.round(r.right), parentRight: Math.round(p.right), bottom: Math.round(r.bottom), parentBottom: Math.round(p.bottom) };
        });
        assert.ok(actionBox.right <= actionBox.parentRight + 1 && actionBox.bottom <= actionBox.parentBottom + 1, `the actions fit in the bar: ${JSON.stringify(actionBox)}`);
        // 归档
        await page.getByRole('button', { name: '归档', exact: true }).dispatchEvent('click');
        await until(async () => (await filterText('已归档')) === '已归档 2', 'the two tasks under 已归档');
        await until(async () => (await page.locator('.tc-item__check input').count()) === 0, 'the two finished tasks out of the default list');
        for (const id of ids) assert.equal(await page.locator(`.tc-row[data-task-id="${id}"]`).count(), 0, 'gone from the default list');
        assert.match(await page.locator('.tc-pickbar').innerText(), /全选当前筛选/, 'the selection is empty again');
        assert.deepEqual(await bar(), idle);
        const snapshot = await running.api('snapshot');
        assert.deepEqual(snapshot.archivedJobs.map((job) => job.contract.jobId).sort(), [...ids].sort(), 'the host agrees');
        assert.deepEqual(snapshot.jobs.filter((job) => ids.includes(job.contract.jobId)), []);
        // the archived list
        await page.locator('.tc-filter', { hasText: '已归档' }).first().dispatchEvent('click');
        await until(async () => (await page.locator('.tc-row').count()) === 2, 'the two archived tasks listed');
        await finish();
        for (const id of ids) assert.equal(await page.locator(`.tc-row[data-task-id="${id}"]`).count(), 1);
        const detail = page.locator('.tc-detail[data-archived="true"]');
        await detail.waitFor({ state: 'attached' });
        const text = await detail.innerText();
        assert.match(text, /取消归档/);
        assert.match(text, /只读/);
        for (const gone of ['暂停', '继续', '接着做', '停止', '知道了']) assert.equal(await detail.locator('button', { hasText: new RegExp(`^${gone}$`) }).count(), 0, `no ${gone} on an archived task`);
        const archivedMeasure = await measure(page);
        assert.equal(archivedMeasure.scrollWidth <= width, true);
        if (width === 1280) { assert.equal(archivedMeasure.appScrolls, false); assert.deepEqual(archivedMeasure.console, first.console); }
        // 取消归档 (from the bar)
        await page.locator('.tc-pickbar__all input').dispatchEvent('click');
        await page.locator('.tc-pickbar__actions').getByRole('button', { name: '取消归档', exact: true }).dispatchEvent('click');
        await until(async () => (await filterText('已归档')) === '已归档 0', 'nothing archived any more');
        await page.locator('.tc-filter', { hasText: '全部' }).first().dispatchEvent('click');
        await until(async () => (await page.locator('.tc-item__check input').count()) === 2, 'both tasks back in the list');
        for (const id of ids) assert.equal(await page.locator(`.tc-row[data-task-id="${id}"]`).count(), 1, 'back in the default list');
        assert.deepEqual((await running.api('snapshot')).archivedJobs, []);
        // 批量删除 asks first
        await page.locator('.tc-pickbar__all input').dispatchEvent('click');
        await page.locator('.tc-pickbar__actions').getByRole('button', { name: '删除', exact: true }).dispatchEvent('click');
        const dialog = page.locator('dialog.sh-dialog[open]');
        await dialog.waitFor({ state: 'attached' });
        const words = await dialog.innerText();
        assert.match(words, /删除 2 个任务/);
        assert.match(words, /任务记录/);
        assert.match(words, /1 个音频任务/);
        assert.match(words, /工作副本/);
        assert.match(words, /不会删除：已导入的资料/);
        const folders = () => readdir(join(running.root, 'audio-batches')).catch(() => []);
        assert.equal((await folders()).filter((name) => !name.includes('.retired')).length, 1, 'the audio batch has its working folder');
        await dialog.getByRole('button', { name: '取消', exact: true }).dispatchEvent('click');
        await dialog.waitFor({ state: 'detached' });
        assert.equal((await running.api('snapshot')).jobs.filter((job) => ids.includes(job.contract.jobId)).length, 2, '取消 deleted nothing');
        await page.locator('.tc-pickbar__actions').getByRole('button', { name: '删除', exact: true }).dispatchEvent('click');
        await dialog.waitFor({ state: 'attached' });
        await dialog.getByRole('button', { name: '确认删除' }).dispatchEvent('click');
        await dialog.waitFor({ state: 'detached', timeout: 30000 });
        await until(async () => (await page.locator('.tc-item__check input').count()) === 0, 'the two tasks deleted');
        for (const id of ids) assert.equal(await page.locator(`.tc-row[data-task-id="${id}"]`).count(), 0, 'deleted');
        const after = await running.api('snapshot');
        assert.deepEqual(after.jobs.filter((job) => job.type !== 'coach-daily').map((job) => job.id), [runningId], 'only the running task is left');
        assert.deepEqual(after.archivedJobs, []);
        await until(async () => (await folders()).length === 0, 'the audio batch folder cleaned in the background');
        assert.ok(after.sources.length >= 12, 'the imported sources are untouched');
        assert.deepEqual(await bar(), idle, 'the bar never moved');
        const verdict = judgeLayoutStability(await drainLayoutStability(page), { maxCls: 0.05 });
        assert.ok(verdict.ok, `${width}px: ${verdict.message}`);
        assert.deepEqual(errors, []);
        await context.close();
      } finally { await running.close(); }
    }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});

/* 知道了 on a card of the audio page no longer deletes: the task is archived (nothing is lost, its working folder stays), and the 任务 console lists it under 已归档. */
test('知道了 on a card of the audio page archives the task: the card goes, the folder stays, and the console lists it under 已归档', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-console-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startConsole({ distDir: dist });
  try {
    await startJobs(running);
    running.release();
    await until(async () => !(await running.api('snapshot')).jobs.some((job) => ['queued', 'running', 'cancelling'].includes(job.status)), 'the jobs to finish');
    const { page, errors, context } = await openConsole(browser, running, { lang: 'zh', theme: 'light', width: 1280, height: 900, nav: 'audio' });
    await frames(page, 6);
    const folders = () => readdir(join(running.root, 'audio-batches')).catch(() => []);
    const before = (await folders()).filter((name) => !name.includes('.retired'));
    assert.equal(before.length, 1);
    const card = page.locator('.cjc[data-state="done"]').first();
    await card.waitFor({ state: 'attached' });
    const id = await card.getAttribute('data-job-id');
    await card.getByRole('button', { name: /^知道了/ }).dispatchEvent('click');
    await until(async () => (await page.locator(`.cjc[data-job-id="${id}"]`).count()) === 0, 'the card to leave the page');
    const snapshot = await running.api('snapshot');
    assert.deepEqual(snapshot.jobs.filter((job) => job.id === id), [], 'out of the live list');
    assert.equal(snapshot.archivedJobs.filter((job) => job.id === id).length, 1, 'kept as an archived record');
    assert.deepEqual((await folders()).filter((name) => !name.includes('.retired')), before, 'the working folder is still there');
    await page.locator('[data-tour="nav-tasks"]').first().dispatchEvent('click');
    await page.locator('.tc-detail').first().waitFor({ state: 'attached' });
    await page.locator('.tc-filter').nth(3).dispatchEvent('click');
    await until(async () => (await page.locator(`.tc-row[data-task-id="${snapshot.archivedJobs.find((job) => job.id === id).contract.jobId}"]`).count()) === 1, 'the task under 已归档');
    assert.deepEqual(errors, []);
    await context.close();
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

/* 2.6.2: the selection and archive UI as the owner saw it on a real screen (a 300px list, a non-default accent): the tooltip of the bar was clipped by the list column to an empty
   strip, the boxes of the rows sat in the middle of two lines and off the bar's box, a ticked row was a dimmed beige while the bar was the same tint as the picked row, a tick
   under a hover lost its tint, and the archived header cut the task's name to three letters (or a button off the edge at 420). Measured here in the real page, under every
   accent preset, in both themes, in both languages, at 1280 and 420. */
const ACCENTS = ['cinnabar', 'jade', 'ochre', 'graphite', 'plum'];
const inside = (box, frame, slack = 0.5) => box.left >= frame.left - slack && box.right <= frame.right + slack && box.top >= frame.top - slack && box.bottom <= frame.bottom + slack;
const ratioText = (sample, ratio) => `${sample.what} "${sample.text}" is ${ratio.toFixed(2)}:1 (text rgb(${sample.fg.slice(0, 3).map(Math.round)}) on rgb(${sample.bg.slice(0, 3).map(Math.round)}))`;

test('the selection bar: its tooltip is in the top layer and inside the window, the boxes line up with the dots and the bar, ticked rows read under every accent, nothing shifts, Esc ends it', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-console-dist-'));
  await buildPreview({ outdir: dist });
  try {
    const plan = [
      ['zh', 1280, ['light', 'dark'], ACCENTS],
      ['en', 420, ['light', 'dark'], ACCENTS],
      ['en', 1280, ['light', 'dark'], ['jade']],
    ];
    for (const [lang, width, themes, accents] of plan) {
      const running = await startConsole({ distDir: dist, lang });
      try {
        await startJobs(running);
        await finishJobsThenHoldOne(running);
        for (const theme of themes) for (const accent of accents) {
          const where = `${lang} ${theme} ${width}px ${accent}`;
          const { page, errors, context } = await openConsole(browser, running, { lang, theme, width, height: 900, accent });
          try {
            await until(async () => (await page.locator('.tc-item__check input').count()) >= 2, `${where}: the finished tasks to be selectable`);
            await frames(page, 4);
            const idle = await measureSelection(page);
            assert.equal(idle.bar.height, 36, `${where}: the bar is 36px high`);
            // the words of the box open in the top layer: whole, inside the window, not under anything
            await page.locator('.tc-pickbar__all').hover();
            await until(async () => (await page.locator('.sh-tooltip:popover-open').count()) === 1, `${where}: the tooltip of the box`);
            await frames(page, 3);
            const hovered = await measureSelection(page);
            assert.ok(hovered.tooltip.inTopLayer && hovered.tooltip.text.length > 4, `${where}: a tooltip with words, in the top layer`);
            assert.ok(inside(hovered.tooltip, { left: 0, right: hovered.viewport.width, top: 0, bottom: hovered.viewport.height }), `${where}: the tooltip is inside the window: ${JSON.stringify(hovered.tooltip)}`);
            assert.equal(hovered.tooltip.covered, false, `${where}: nothing (the list column's edge, a row) cuts or covers the tooltip`);
            assert.ok(hovered.tooltip.width >= 120 && hovered.tooltip.height >= 20, `${where}: the tooltip shows its whole text, not a strip (${Math.round(hovered.tooltip.width)}x${Math.round(hovered.tooltip.height)})`);
            await page.mouse.move(width - 2, 2);
            // one ticked box: the bar's box is mixed, not checked
            await page.locator('.tc-item__check input').first().click();
            await until(async () => (await measureSelection(page)).barIndeterminate === true, `${where}: the box of the bar to be mixed with one of two ticked`);
            const some = await measureSelection(page);
            assert.equal(some.barChecked, false, `${where}: mixed, not checked`);
            assert.match(some.barLabel, lang === 'zh' ? /已选 1/ : /1 selected/);
            // everything: the actions appear and nothing moves
            await page.locator('.tc-pickbar__all input').click();
            await page.locator('.tc-pickbar__actions').waitFor({ state: 'attached' });
            await page.mouse.move(width - 2, 2);
            await frames(page, 4);
            const m = await measureSelection(page);
            assert.equal(m.barIndeterminate, false);
            assert.equal(m.barChecked, true, `${where}: everything ticked: the box is checked`);
            assert.deepEqual(m.bar, idle.bar, `${where}: the bar did not move or change size when the actions appeared`);
            assert.deepEqual(m.itemTops, idle.itemTops, `${where}: no row moved when the bar changed`);
            assert.equal(m.listScroll.scrollHeight, idle.listScroll.scrollHeight, `${where}: the list did not grow`);
            assert.ok(m.scrollWidth <= width, `${where}: no sideways scroll`);
            // the bar: nothing clips, nothing is cut, nothing overlaps
            assert.equal(await page.locator('.tc-pickbar').evaluate((element) => getComputedStyle(element).overflowX), 'visible', `${where}: the bar clips nothing (a focus ring, a tooltip)`);
            assert.equal(m.labelCut, false, `${where}: the count is whole ("${m.barLabel}")`);
            assert.equal(m.actions.length, 3);
            for (const [index, button] of m.actions.entries()) {
              assert.ok(inside(button, m.bar, 0.5), `${where}: ${button.text} fits in the bar`);
              if (index) assert.ok(button.left >= m.actions[index - 1].right - 0.5, `${where}: ${button.text} does not overlap ${m.actions[index - 1].text}`);
            }
            assert.ok(m.actions[0].left >= m.barInput.right + 8, `${where}: the actions keep clear of the count`);
            // the boxes: one column (the bar's and the rows'), on the line of the dot and the title
            assert.ok(m.ticked.length >= 2, `${where}: the two finished tasks are ticked`);
            for (const row of [...m.ticked, ...m.unticked]) {
              assert.ok(Math.abs(row.input.left - m.barInput.left) <= 1 && Math.abs(row.input.width - m.barInput.width) <= 0.5, `${where}: the box of a row lines up with the bar's (${row.input.left} vs ${m.barInput.left}, ${row.input.width} vs ${m.barInput.width})`);
              assert.ok(Math.abs(row.input.cy - row.dot.cy) <= 1.5, `${where}: the box is level with the status dot (${row.input.cy} vs ${row.dot.cy})`);
            }
            // every text on a ticked row, the picked row and the bar is readable (4.5:1) on what it sits on
            assert.ok(m.contrast.length >= 8, `${where}: samples were taken`);
            for (const sample of m.contrast) { const ratio = contrastRatio(sample.fg, sample.bg); assert.ok(ratio >= 4.5, `${where}: ${ratioText(sample, ratio)}`); }
            // 取消选择 hands the focus to the bar (its buttons go away with the selection); Esc ends a selection from the keyboard
            await page.locator('.tc-pickbar__actions button').nth(2).click();
            await until(async () => (await page.locator('.tc-pickbar__actions').count()) === 0, `${where}: the selection to end`);
            assert.equal((await measureSelection(page)).focus.isBar, true, `${where}: the focus moved to the bar, not to the page`);
            await page.locator('.tc-pickbar__all input').click();
            await page.locator('.tc-pickbar__actions').waitFor({ state: 'attached' });
            await page.keyboard.press('Escape');
            await until(async () => (await page.locator('.tc-pickbar__actions').count()) === 0, `${where}: Esc to end the selection`);
            assert.equal((await page.locator('.tc-item[data-checked="true"]').count()), 0, `${where}: Esc cleared every tick`);
            assert.deepEqual(errors, [], where);
          } finally { await context.close(); }
        }
      } finally { await running.close(); }
    }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});

test('the archived read-only detail: the name keeps its room, the actions fit and are apart from 删除, the note is whole, the bar works on the archive, at 1280 and 420', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-console-dist-'));
  await buildPreview({ outdir: dist });
  try {
    for (const lang of ['zh', 'en']) {
      const running = await startConsole({ distDir: dist, lang });
      try {
        await startJobs(running);
        await finishJobsThenHoldOne(running);
        const ids = (await running.api('snapshot')).jobs.filter((job) => ['complete', 'failed'].includes(job.status) && job.type !== 'coach-daily').map((job) => job.contract.jobId);
        assert.equal(ids.length, 2);
        await running.api('job.archive', { jobIds: ids });
        for (const [width, theme, accent] of [[1280, 'light', 'jade'], [1280, 'dark', 'plum'], [420, 'light', 'ochre'], [420, 'dark', 'graphite']]) {
          const where = `${lang} ${theme} ${width}px ${accent}`;
          const { page, errors, context } = await openConsole(browser, running, { lang, theme, width, height: 900, accent });
          try {
            await page.locator('.tc-filter').nth(3).click();
            await page.locator('.tc-detail[data-archived="true"]').waitFor({ state: 'attached' });
            await until(async () => (await page.locator('.tc-item__check input').count()) === 2, `${where}: the archived tasks, selectable`);
            await frames(page, 4);
            const m = await measureSelection(page);
            assert.ok(m.scrollWidth <= width, `${where}: no sideways scroll`);
            const names = m.head.actions.map((action) => action.text);
            // 全屏 first, 取消归档 and 删除 last; between them whatever the task offers (打开资料 / 打开草稿, and 为没覆盖的部分补题 for a draft that still has uncovered sections).
            assert.ok(names.length >= 4 && /^(全屏|Full screen)$/.test(names[0]) && /^(取消归档|Unarchive)$/.test(names.at(-2)) && /^(删除|Delete)$/.test(names.at(-1)), `${where}: 全屏, …, 取消归档, 删除: ${names}`);
            for (const [index, action] of m.head.actions.entries()) {
              assert.ok(action.left >= m.head.detail.left && action.right <= m.head.detail.right, `${where}: ${action.text} is inside the detail (${Math.round(action.left)}-${Math.round(action.right)} of ${Math.round(m.head.detail.left)}-${Math.round(m.head.detail.right)})`);
              if (index && Math.abs(action.top - m.head.actions[index - 1].top) < 4) assert.ok(action.left >= m.head.actions[index - 1].right - 0.5, `${where}: ${action.text} does not overlap ${m.head.actions[index - 1].text}`);
            }
            const [unarchive, remove] = m.head.actions.slice(-2);
            if (Math.abs(unarchive.top - remove.top) < 4) assert.ok(remove.left - unarchive.right >= 8, `${where}: 删除 is set apart from the others (${Math.round(remove.left - unarchive.right)}px)`);
            assert.equal(await page.locator('.tc-head__actions button').last().evaluate((button) => button.classList.contains('sh-btn--danger')), true, `${where}: 删除 looks destructive`);
            assert.ok(m.head.title.width >= 160, `${where}: the name of the task has room (${Math.round(m.head.title.width)}px)`);
            if (width === 1280) assert.equal(m.head.titleCut, false, `${where}: the name is not cut`);
            const note = await page.locator('.tc-controls[data-archived="true"]').evaluate((element) => { const r = element.getBoundingClientRect(), p = element.parentElement.getBoundingClientRect(), text = element.querySelector('.tc-controls__idle'); return { left: r.left, right: r.right, parentLeft: p.left, parentRight: p.right, height: r.height, cut: text.scrollWidth > text.clientWidth + 1 }; });
            assert.ok(note.left >= note.parentLeft - 0.5 && note.right <= note.parentRight + 0.5 && note.height >= 44 && !note.cut, `${where}: the note of the archive is whole: ${JSON.stringify(note)}`);
            // the bar on the archive: one task ticked, the actions fit, the words read
            await page.locator('.tc-item__check input').first().click();
            await page.locator('.tc-pickbar__actions').waitFor({ state: 'attached' });
            await page.mouse.move(width - 2, 2);
            await frames(page, 3);
            const picked = await measureSelection(page);
            assert.equal(picked.barIndeterminate, true, `${where}: one of two ticked: mixed`);
            assert.equal(picked.labelCut, false, `${where}: the count is whole`);
            for (const button of picked.actions) assert.ok(inside(button, picked.bar, 0.5), `${where}: ${button.text} fits in the bar`);
            for (const sample of picked.contrast) { const ratio = contrastRatio(sample.fg, sample.bg); assert.ok(ratio >= 4.5, `${where}: ${ratioText(sample, ratio)}`); }
            assert.deepEqual(errors, [], where);
          } finally { await context.close(); }
        }
      } finally { await running.close(); }
    }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});

/* The overview of every kind of task (a question run, an audio batch, a day of 为你定制) is one structure: label, value and a note line that is always there, from the TOP of each tile. In every row of tiles
   (one row at 1280, two rows beside the progress tile when it wraps at 768 and 420) the labels stand on one line and the values on one line, whichever tile has a note (the owner's 「UI不整齐」). */
test('the tiles of the overview share their lines: the labels and the values of a row have the same top (within 1px), whichever tile has a note, at 1280, 768 and 420', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-console-dist-'));
  await buildPreview({ outdir: dist });
  try {
    for (const [lang, theme, width] of [['zh', 'dark', 1280], ['en', 'light', 768], ['zh', 'dark', 420]]) {
      const running = await startConsole({ distDir: dist, lang });
      try {
        await startJobs(running);
        const { page, errors, context } = await openConsole(browser, running, { lang, theme, width, height: 900 });
        await until(async () => (await page.locator('.tc-row').count()) >= 4, 'the jobs and the days of 为你定制 in the list');
        await frames(page, 6);
        const rows = await page.locator('.tc-row').count();
        let withNote = 0;
        for (let index = 0; index < rows; index++) {
          await page.locator('.tc-row').nth(index).dispatchEvent('click');
          await frames(page, 4);
          const tiles = await page.evaluate(() => [...document.querySelectorAll('.tc-metrics > .tc-metric')].map((tile) => {
            const top = (selector) => { const element = tile.querySelector(selector); return element ? element.getBoundingClientRect().top : null; };
            const box = tile.getBoundingClientRect();
            return { top: box.top, height: box.height, progress: tile.classList.contains('tc-metric--progress'), label: top('.tc-metric__k'), value: top('.tc-metric__v'),
              note: top('[data-metric-note]'), noteText: tile.querySelector('[data-metric-note]')?.textContent.trim() || '' };
          }));
          const where = `${lang}/${theme}/${width} task ${index}`;
          const facts = tiles.filter((tile) => !tile.progress);
          assert.equal(facts.length, 4, `${where}: four facts`);
          assert.ok(facts.every((tile) => tile.note !== null), `${where}: every tile has its note line, empty or not`);
          if (facts.some((tile) => tile.noteText)) withNote += 1;
          // rows of tiles: the tiles with the same top are a row
          const rowsOf = new Map();
          for (const tile of tiles) { const key = Math.round(tile.top); (rowsOf.get(key) || rowsOf.set(key, []).get(key)).push(tile); }
          for (const [key, row] of rowsOf) {
            const spread = (name, list) => { const values = list.map((tile) => tile[name]); return Math.max(...values) - Math.min(...values); };
            assert.ok(spread('label', row) <= 1, `${where}, row at ${key}: the labels are on one line (spread ${spread('label', row)}px)`);
            assert.ok(spread('height', row) <= 1, `${where}, row at ${key}: the tiles are as tall as each other`);
            const only = row.filter((tile) => !tile.progress);
            if (only.length) {
              assert.ok(spread('value', only) <= 1, `${where}, row at ${key}: the values are on one line (spread ${spread('value', only)}px)`);
              assert.ok(spread('note', only) <= 1, `${where}, row at ${key}: the notes are on one line (spread ${spread('note', only)}px)`);
            }
          }
        }
        assert.ok(withNote >= 1, `${lang}/${width}: at least one task shows a note under a tile (the question run's elapsed time)`);
        assert.deepEqual(errors, []);
        await context.close();
      } finally { await running.close(); }
    }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
});
