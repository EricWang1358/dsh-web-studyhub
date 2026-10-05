import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { drainLayoutStability, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { frames, until } from '../scripts/qa/layout-late.mjs';
import { startConsole, startJobs, finishJobsThenHoldOne, openConsole, measure, measureCards } from '../scripts/qa/task-console.mjs';

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
