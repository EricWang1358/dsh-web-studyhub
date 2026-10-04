/* global localStorage, process */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// #185: an empty proposal is not a pending plan; it explains itself and offers the next step. #186: the 记录实际用时 form is one compact row.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { default as DailyPlan } from './ui/DailyPlan.jsx'; export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { DailyPlan, setUiLanguage } = module.exports;
const noop = () => {};
const base = { date: '2026-10-05', budgetMinutes: 60, spentMinutes: 59, profile: { weekdayMinutes: 60, weekendMinutes: 60 }, tasks: [] };
const empty = (emptyReason, extra = {}) => ({ ...base, ...extra, proposal: { id: 'p1', method: 'local', items: [], emptyReason, warnings: [] } });
const controls = (state) => ({ state, busy: '', error: '', suggest: noop, accept: noop, saveProfile: noop, start: noop, complete: noop, refresh: noop });
const render = (plan, props = {}) => { setUiLanguage('zh'); return renderToStaticMarkup(React.createElement(DailyPlan, { plan, ...props })); };
// The body is hidden while folded, but it is in the markup: open it the way a returning learner has it.
const opened = (plan, props) => { globalThis.localStorage = { getItem: () => 'true', setItem: noop, removeItem: noop }; try { return render(plan, props); } finally { delete globalThis.localStorage; } };

test('a proposal with no action because the time is used up: no accept button, the reason and two ways on (#185)', () => {
  const html = opened(controls(empty('budget')));
  assert.doesNotMatch(html, /接受这份安排/);
  assert.doesNotMatch(html, /有一份安排等你接受/);
  assert.match(html, /今天的学习时间快用完了/);
  assert.match(html, />今天再学一会儿</);
  assert.match(html, />今天到此为止</);
  assert.match(html, /今天已投入 59 \/ 60 分钟/, 'the folded row says where the day stands');
});

test('a proposal with no action because nothing is due: the reason and the way to the library and to importing (#185)', () => {
  const html = opened(controls(empty('nothing-due', { spentMinutes: 10 })));
  assert.doesNotMatch(html, /接受这份安排/);
  assert.match(html, /没有到期复习或待学内容/);
  assert.match(html, />去学习库</);
  assert.match(html, />导入资料</);
  assert.doesNotMatch(html, /有一份安排等你接受/);
  assert.match(html, /daily-plan__summary[^>]*>[^<]*没有到期复习或待学内容/);
});

test('a rest day is still an empty proposal: nothing to accept, and 今天再学一会儿 is the way to add time (#185)', () => {
  const html = opened(controls(empty('budget', { budgetMinutes: 0, spentMinutes: 0 })));
  assert.match(html, /今天休息/);
  assert.doesNotMatch(html, /接受这份安排/);
  assert.match(html, />今天再学一会儿</);
});

test('a real proposal still offers 接受这份安排 and the folded row says it waits (#185)', () => {
  const html = opened(controls({ ...base, spentMinutes: 0, proposal: { id: 'p2', method: 'ai', items: [{ title: '练习概率', reason: '混淆', minutes: 15 }], warnings: [] } }));
  assert.match(html, />接受这份安排</);
  assert.match(html, /有一份安排等你接受/);
});

test('in the browser: the empty-proposal buttons act, and the recorded-time row sits on one line (#185 #186)', { timeout: 240000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wave4-plan-ui-'));
  const home = join(root, 'home'), old = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const budgetLibrary = new StudyService(join(root, 'budget'));
  const dueLibrary = new StudyService(join(root, 'nothing'));
  await budgetLibrary.store.update((s) => {
    s.decks.push({ id: 'deck', title: 'Probability', course: 'Math', cards: Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, kind: 'flashcard', topic: 'T', prompt: `Question ${i}`, answer: 'A',
      options: [], citations: [], requires: [], review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null } })) });
  });
  await dueLibrary.store.update((s) => {
    s.decks.push({ id: 'deck', title: 'Probability', course: 'Math', cards: [{ id: 'q0', kind: 'flashcard', topic: 'T', prompt: 'Question', answer: 'A', options: [], citations: [], requires: [],
      review: { repetitions: 3, interval_days: 30, ease_factor: 2.5, due_at: '2099-01-01T00:00:00.000Z' } }] });
  });
  const today = new Date(), date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await budgetLibrary.call('daily.plan.suggest', { date, minutes: 1 });
  await dueLibrary.call('daily.plan.suggest', { date, minutes: 30 });
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const servers = [];
  let browser;
  t.after(async () => {
    await browser?.close();
    for (const server of servers) await server.close();
    await budgetLibrary.dispose(); await dueLibrary.dispose();
    if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old;
    await rm(root, { recursive: true, force: true });
  });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }
  const open = async (service, width = 1100) => {
    const server = await createPreviewServer({ libraryRoot: service.store.root, home, port: 0, model: 'fake', distDir });
    servers.push(server);
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-theme', 'dark'); localStorage.setItem('study-daily-plan:open', 'true'); });
    await page.goto(server.url);
    return page;
  };
  const shots = process.env.WAVE4_SHOTS;

  const page = await open(budgetLibrary);
  const plan = page.locator('.daily-plan');
  await plan.getByText('今天的学习时间快用完了').waitFor();
  assert.equal(await plan.getByRole('button', { name: '接受这份安排' }).count(), 0);
  assert.match(await plan.locator('.daily-plan__summary').innerText(), /今天已投入 \d+ \/ \d+ 分钟/);
  if (shots) await page.screenshot({ path: `${shots}/budget-1100.png` });
  await plan.getByRole('button', { name: '今天再学一会儿' }).click();
  await plan.locator('textarea').waitFor();
  assert.ok(await plan.getByText('只调整今天').count(), 'the adjust-today editor opened');
  await page.keyboard.press('Escape');
  await plan.getByRole('button', { name: '今天到此为止' }).click();
  await plan.getByText('今天的学习时间快用完了').waitFor({ state: 'detached' });

  const other = await open(dueLibrary);
  const due = other.locator('.daily-plan');
  await due.getByText('没有到期复习或待学内容').first().waitFor();
  assert.equal(await due.getByRole('button', { name: '接受这份安排' }).count(), 0);
  if (shots) await other.screenshot({ path: `${shots}/nothing-due-1100.png` });
  await due.getByRole('button', { name: '导入资料' }).click();
  await other.getByRole('dialog').waitFor();
});

test('the actual-time form is a compact row on shared parts: Disclosure, a minutes input with a unit, a small 保存 (#186)', () => {
  const task = { id: 't1', title: '练习概率', kind: 'practice', minutes: 15, status: 'done', progress: { done: 5, total: 5 }, actualMinutes: undefined };
  const html = opened(controls({ ...base, proposal: null, tasks: [task, { ...task, id: 't2', title: '另一项', status: 'todo' }] }));
  assert.match(html, /记录实际用时/);
  const form = /<form[^>]*daily-plan__actual-form[\s\S]*?<\/form>/.exec(html)?.[0] || '';
  assert.ok(form, 'one compact form');
  assert.match(form, /type="number"/);
  assert.match(form, /min="1"/);
  assert.match(form, /max="240"/);
  assert.match(form, /value="15"/, 'prefilled with the estimate');
  assert.match(form, />分钟</, 'the unit is shown');
  assert.match(form, />保存</);
  assert.match(html, /<details[^>]*sh-disclosure[^>]*daily-plan__actual/, 'the shared Disclosure (chevron) is the toggle');
  assert.doesNotMatch(html, /<summary>记录实际用时/, 'not a bare native summary');
  assert.doesNotMatch(form, /<label[^>]*>实际学习分钟数/, 'no stacked label above the input');
});

test('a recorded time shows in place as 已记录 N 分钟 (#186)', () => {
  const task = { id: 't1', title: '练习概率', kind: 'practice', minutes: 15, status: 'done', progress: { done: 5, total: 5 }, actualMinutes: 22 };
  const html = opened(controls({ ...base, proposal: null, tasks: [task] }));
  assert.match(html, /已记录 22 分钟/);
  assert.match(html, /value="22"/);
});

test('DailyPlan.jsx and its editors use no raw label or input: the field guard covers them (#186)', () => {
  for (const file of ['ui/DailyPlan.jsx']) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /<label[\s>]/, `${file}: no raw <label>`);
    assert.doesNotMatch(source, /<input[\s>]/, `${file}: no raw <input>`);
  }
});

test('in the browser: 记录实际用时 opens as one aligned row and saves in place as 已记录 N 分钟 (#186)', { timeout: 240000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wave4-actual-'));
  const home = join(root, 'home'), old = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const service = new StudyService(join(root, 'library'));
  await service.store.update((s) => { s.sources.push({ id: 'source', title: 'Lecture notes', text: 'Probability notes for the week.' }); });
  const today = new Date(), date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const suggested = await service.call('daily.plan.suggest', { date, minutes: 10 });
  const accepted = await service.call('daily.plan.accept', { date, proposalId: suggested.proposal.id });
  await service.call('daily.plan.complete', { date, taskId: accepted.tasks[0].id });
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home, port: 0, model: 'fake', distDir });
  let browser;
  t.after(async () => {
    await browser?.close(); await server.close(); await service.dispose();
    if (old === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = old;
    await rm(root, { recursive: true, force: true });
  });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }
  for (const width of [1100, 420]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-theme', 'dark'); localStorage.setItem('study-daily-plan:open', 'true'); });
    await page.goto(server.url);
    const plan = page.locator('.daily-plan');
    await plan.getByText('完整安排').first().click();
    const toggle = plan.locator('.daily-plan__actual > summary');
    await toggle.waitFor();
    if (process.env.WAVE4_SHOTS) await page.screenshot({ path: `${process.env.WAVE4_SHOTS}/actual-closed-${width}.png` });
    await toggle.click();
    const form = plan.locator('.daily-plan__actual-form');
    await form.waitFor();
    if (process.env.WAVE4_SHOTS) await page.screenshot({ path: `${process.env.WAVE4_SHOTS}/actual-open-${width}.png` });
    const centres = await form.evaluate((element) => ['input', '.sh-number__suffix', 'button'].map((selector) => { const r = element.querySelector(selector).getBoundingClientRect(); return { top: r.top, mid: r.top + r.height / 2 }; }));
    if (width > 600) for (const spot of centres) assert.ok(Math.abs(spot.mid - centres[0].mid) <= 3, `input, unit and button share a line at ${width}px (${centres.map((c) => c.mid.toFixed(1))})`);
    if (width > 600) {
      assert.equal(await form.locator('input').inputValue(), '10', 'prefilled with the estimate');
      await form.locator('input').fill('42');
      await form.getByRole('button', { name: '保存' }).click();
      await plan.getByText('已记录 42 分钟').first().waitFor();
    }
    await page.close();
  }
});
