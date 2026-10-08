/* global document, innerWidth, window, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { startConsole, startJobs } from '../scripts/qa/task-console.mjs';

/* 「仅本任务生效」 in the browser: the 即时控制 box of a running question run with a host model catalog (DSH's, played by window.STUDY_MODEL_GROUPS in the
   preview) at 1280 and 420 px. The 模型 select sits with the other choices, says 「跟随设置」 whole, lists the models by name in its popup; choosing one is
   applied to this run (the job's control and its log say so) and the stage selects then offer that model's levels (the host's answer to model.efforts is
   played at the network edge: the preview's fake model describes no levels). Nothing leaves the box or the window. STUDY_SHOTS_DIR=<folder> keeps the
   screenshots. */

const ROUTE = { provider: 'deepseek', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' };
const GROUPS = [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek-V41-Flash' }, { id: 'deepseek-v4.1-pro', name: 'DeepSeek-V41-Pro' }] },
  { id: 'siliconflow', name: 'SiliconFlow', models: [{ id: 'Qwen/Qwen3-235B-A22B', name: 'Qwen3 235B A22B' }] }];
const LEVELS = { 'deepseek-v4.1-flash': ['off', 'low', 'high', 'max'], 'Qwen/Qwen3-235B-A22B': ['low', 'medium', 'high'] };
const B = JSON.stringify(['siliconflow', 'Qwen/Qwen3-235B-A22B']);
const WORDS = { zh: { follow: '跟随设置', note: '模型仅本任务生效', applied: '模型 → Qwen3 235B A22B', defaultLevel: '模型默认' },
  en: { follow: 'As in Settings', note: 'model for this task only', applied: 'Model → Qwen3 235B A22B', defaultLevel: 'Model default' } };

const readBox = (page) => page.evaluate(() => {
  const box = (element) => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const row = document.querySelector('.tc-controls__items')?.closest('.tc-controls');
  if (!row) return null;
  const status = row.querySelector('.tc-controls__applied');
  return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, row: box(row), status: status.textContent.trim(),
    statusLines: Math.round(status.getBoundingClientRect().height / parseFloat(getComputedStyle(status).lineHeight)),
    controls: [...row.querySelectorAll('.tc-control')].map((control) => {
      const value = control.querySelector('.sh-select__value');
      return { key: control.dataset.control, box: box(control), value: value?.textContent.trim() ?? null, cut: value ? value.scrollWidth > value.clientWidth + 1 : false };
    }) };
});
const popupOptions = (page) => page.evaluate(() => [...document.querySelectorAll('.sh-pop__popup:not([data-closed]) .sh-opt')].map((option) => option.textContent.replace(/\s+/g, ' ').trim()));

async function openWithCatalog(browser, running, { lang, theme, width }) {
  const opened = await openPage(browser, running, { lang, theme, width, height: 900 });
  await opened.context.addInitScript((groups) => { window.STUDY_MODEL_GROUPS = groups; }, GROUPS);
  await opened.page.route('**/api/call', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}');
    if (body.action !== 'model.efforts') return route.continue();
    const ids = LEVELS[body.args?.model] ?? [];
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: { options: ids.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })) } }) });
  });
  await opened.page.goto(running.server.url);
  await opened.page.locator('[data-tour="nav-tasks"]').first().dispatchEvent('click');
  await opened.page.locator('.tc-detail').first().waitFor({ state: 'attached', timeout: 30000 });
  await settleAnimations(opened.page);
  for (let index = 0, rows = await opened.page.locator('.tc-row').count(); index < rows && !(await opened.page.locator('[data-control="model"]').count()); index++) {
    await opened.page.locator('.tc-row').nth(index).dispatchEvent('click');
    await frames(opened.page, 4);
  }
  await opened.page.locator('[data-control="model"] [role="combobox"]').waitFor({ state: 'attached' });
  return opened;
}

test('the 模型 select of a running question run: in the box at 1280 and 420 px, applied to this run only, and the levels follow the model', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-model-choice-dist-'));
  await buildPreview({ outdir: dist });
  const shots = process.env.STUDY_SHOTS_DIR;
  if (shots) await mkdir(shots, { recursive: true });
  const running = await startConsole({ distDir: dist, route: ROUTE });
  try {
    const { generation } = await startJobs(running);
    for (const [lang, theme, width] of [['zh', 'dark', 1280], ['zh', 'dark', 420], ['en', 'light', 420]]) {
      const where = `${lang} ${theme} ${width}px`, words = WORDS[lang];
      const { page, context, errors } = await openWithCatalog(browser, running, { lang, theme, width });
      await frames(page, 6);
      const first = await readBox(page);
      assert.ok(first.scrollWidth <= first.viewport, `${where}: no sideways scroll`);
      assert.deepEqual(first.controls.map((control) => control.key), ['concurrency', 'model', 'effortPlanning', 'effortReview', 'effortWriting', 'effortRepair', 'applySuggestions'], where);
      for (const control of first.controls) {
        assert.ok(control.box.left >= first.row.left - 0.75 && control.box.right <= first.row.right + 0.75 && control.box.right <= first.viewport + 0.75, `${where}: ${control.key} inside the box and the window`);
        assert.equal(control.cut, false, `${where}: ${control.key} says "${control.value}" whole`);
      }
      assert.equal(first.controls[1].value, words.follow, `${where}: the closed select says the short words`);
      assert.match(first.status, new RegExp(words.note), `${where}: one line says the model is for this task only`);
      assert.equal(first.statusLines, 1, `${where}: and it is one line ("${first.status}")`);
      if (shots) await page.locator('.tc-controls').first().screenshot({ path: join(shots, `box-${lang}-${width}-follow.png`) });

      // the popup: the generation model named in full, then the host's models by name under their provider
      const model = page.locator('[data-control="model"] [role="combobox"]');
      await model.click();
      await page.locator('.sh-pop__popup:not([data-closed]):not([data-starting-style])').waitFor();
      await page.waitForTimeout(250);
      const listed = await popupOptions(page);
      assert.deepEqual(listed.slice(1), ['DeepSeek-V41-Flash', 'DeepSeek-V41-Pro', 'Qwen3 235B A22B'], `${where}: the host models by name`);
      assert.match(listed[0], new RegExp(`^${words.follow} · deepseek · deepseek-v4.1-flash`), `${where}: the first choice names the generation model`);
      const inside = await page.evaluate(() => { const r = document.querySelector('.sh-pop__popup:not([data-closed])').getBoundingClientRect(); return r.left >= -0.75 && r.right <= innerWidth + 0.75; });
      assert.ok(inside, `${where}: the popup is inside the window`);
      if (shots) await page.screenshot({ path: join(shots, `popup-${lang}-${width}.png`) });

      // choose another model: applied, said, and the stage selects offer ITS levels
      await page.locator('.sh-pop__popup:not([data-closed]) .sh-opt', { hasText: 'Qwen3 235B A22B' }).click();
      await until(async () => (await page.locator('.tc-controls__applied').first().innerText()).includes(words.applied), `${where}: the change to be in force`);
      const repair = page.locator('[data-control="effortRepair"] [role="combobox"]');
      await until(async () => { await repair.click(); await page.waitForTimeout(200); const options = await popupOptions(page); await page.keyboard.press('Escape'); return options.includes('Medium'); }, `${where}: the levels of the chosen model`);
      await repair.click();
      await page.locator('.sh-pop__popup:not([data-closed]):not([data-starting-style])').waitFor();
      assert.deepEqual((await popupOptions(page)).slice(1), [words.defaultLevel, 'Low', 'Medium', 'High'], `${where}: the stage offers the levels of the chosen model`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const after = await readBox(page);
      assert.equal(after.controls[1].value, 'Qwen3 235B A22B', `${where}: the select says the model in force`);
      for (const control of after.controls) assert.equal(control.cut, false, `${where} after the change: ${control.key} says "${control.value}" whole`);
      assert.ok(after.scrollWidth <= after.viewport, `${where}: still no sideways scroll`);
      assert.equal(after.row.height, first.row.height, `${where}: the box keeps its height when the model changes (${first.row.height} -> ${after.row.height})`);
      if (shots) await page.locator('.tc-controls').first().screenshot({ path: join(shots, `box-${lang}-${width}-chosen.png`) });
      if (shots) await page.screenshot({ path: join(shots, `console-${lang}-${width}-chosen.png`) });

      const job = (await running.api('snapshot')).jobs.find((item) => item.id === generation.jobId);
      assert.equal(job.contract.actions.set.settings.find((item) => item.key === 'model').value, B, `${where}: the run holds the model`);
      assert.ok(job.contract.events.some((event) => event.code === 'control' && event.args?.changed?.model === B), `${where}: and its log says so`);
      assert.equal((await running.api('snapshot')).settings?.generation?.model, undefined, `${where}: Settings hold no model`);
      assert.deepEqual(errors, [], where);
      await running.api('job.control', { jobId: generation.jobId, action: 'set', patch: { model: 'follow' } });
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
