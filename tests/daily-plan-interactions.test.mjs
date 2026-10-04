/* global document, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

test('daily plan editors preserve consent, zero minutes and keyboard focus; reading completes its exact task', { timeout: 60000 }, async t => {
  const bundle = await build({ stdin: { contents: `
    import React, { useEffect, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import DailyPlan, { RelatedTasks } from './ui/DailyPlan.jsx';
    import { useDailyPlan } from './ui/daily-plan.js';
    const reference = { root: '/library', kind: 'source', id: 'source-1' };
    const initial = { budgetMinutes: 30, spentMinutes: 0, profile: { weekdayMinutes: 30, weekendMinutes: 40 },
      proposal: null, tasks: [{ id: 'reading-1', kind: 'reading', title: '阅读概率讲义', minutes: 10,
        status: 'todo', available: true, studyRef: reference, progress: { done: 0, total: 1 } }] };
    window.calls = { suggest: [], profile: [], complete: [] };
    let fixture = initial;
    function Harness() {
      const [related, setRelated] = useState(false);
      const plan = useDailyPlan({ root: '/library', visible: false, call: async (action, args) => {
        const { date, ...options } = args;
        if (action === 'daily.plan.get') return fixture;
        if (action === 'daily.plan.suggest') {
          window.calls.suggest.push(options);
          return new Promise((resolve, reject) => {
            window.finishSuggest = () => resolve(fixture);
            window.failSuggest = () => reject(new Error('建议失败'));
          });
        }
        if (action === 'daily.plan.profile') {
          window.calls.profile.push(options);
          return new Promise(resolve => {
            window.finishProfile = () => { fixture = { ...fixture, profile: options }; resolve(fixture); };
          });
        }
        if (action === 'daily.plan.complete') window.calls.complete.push(options.taskId);
        return fixture;
      } });
      useEffect(() => { void plan.refresh(); }, [plan.refresh]);
      window.updatePlan = async patch => { fixture = { ...fixture, ...patch }; await plan.refresh(); };
      window.showRelated = () => setRelated(true);
      return <div className="study-app">{related ? <RelatedTasks plan={plan} reference={reference} /> : <DailyPlan plan={plan} />}</div>;
    }
    createRoot(document.getElementById('root')).render(<Harness />);
  `, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
    loader: { '.css': 'text' }, logLevel: 'silent' });
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const adjust = page.getByRole('button', { name: '调整今天', exact: true });
  await adjust.waitFor();
  assert.equal(await page.getByRole('textbox').count(), 0, 'negotiation is on demand');
  assert.deepEqual(await page.evaluate(() => window.calls.suggest), [], 'reading the plan never asks AI');
  await adjust.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.getByRole('textbox').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('textbox').count(), 0);
  assert.equal(await adjust.evaluate(node => node === document.activeElement), true);

  await page.evaluate(() => window.updatePlan({ proposal: { id: 'proposal-1', method: 'ai', items: [] } }));
  await page.getByRole('button', { name: '接受这份安排' }).waitFor();
  await adjust.click();
  await page.getByRole('textbox').fill('今天休息');
  await page.getByRole('spinbutton').fill('0');
  await page.getByRole('button', { name: '按我的意见重新建议' }).click();
  await page.waitForFunction(() => window.calls.suggest.length === 1);
  assert.equal(await adjust.isDisabled(), true, 'the actual controller disables triggers during the request');
  await page.evaluate(() => window.failSuggest());
  await page.waitForFunction(() => !document.querySelector('textarea')?.disabled);
  assert.deepEqual(await page.evaluate(() => window.calls.suggest[0]), { feedback: '今天休息', minutes: 0, proposalId: 'proposal-1' });
  assert.equal(await page.getByRole('textbox').inputValue(), '今天休息', 'a failed suggestion retains the draft');
  await page.getByRole('button', { name: '按我的意见重新建议' }).click();
  await page.waitForFunction(() => window.calls.suggest.length === 2);
  await page.evaluate(() => window.finishSuggest());
  await page.waitForFunction(() => !document.querySelector('textarea'));
  assert.equal(await adjust.evaluate(node => node === document.activeElement), true);
  assert.deepEqual(await page.evaluate(() => window.calls.profile), [], 'today-only feedback leaves the regular pace alone');

  await page.getByRole('button', { name: '学习量习惯', exact: true }).click();
  const weekdays = page.getByRole('spinbutton', { name: '工作日（分钟）' });
  await weekdays.fill('');
  assert.equal(await page.getByRole('button', { name: '保存长期习惯' }).isDisabled(), true);
  await weekdays.fill('0');
  await page.getByRole('spinbutton', { name: '周末（分钟）' }).fill('60');
  await page.getByRole('button', { name: '保存长期习惯' }).click();
  await page.waitForFunction(() => window.calls.profile.length === 1);
  await page.evaluate(() => window.finishProfile());
  await page.waitForFunction(() => !document.querySelector('input'));
  assert.deepEqual(await page.evaluate(() => window.calls.profile), [{ weekdayMinutes: 0, weekendMinutes: 60 }]);
  assert.equal(await page.getByRole('button', { name: '学习量习惯', exact: true }).evaluate(node => node === document.activeElement), true);

  await page.evaluate(() => window.showRelated());
  const strip = page.getByRole('complementary', { name: '相关学习待办' });
  await strip.waitFor();
  assert.equal(await strip.getByRole('button', { name: /开始|继续/ }).count(), 0, 'the learning page does not launch itself again');
  await strip.getByRole('button', { name: '我已完成' }).click();
  assert.deepEqual(await page.evaluate(() => window.calls.complete), ['reading-1']);
  assert.deepEqual(errors, []);
});
