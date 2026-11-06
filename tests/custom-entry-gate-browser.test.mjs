/* global document window navigator */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { customDefaults } from '../lib/custom-plan.js';
import { openPage, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* 深度定制 entry and gate in the real page (zh at 1280 and 420 px): a 160-page converted book of the course 宏经 has 「深度定制」 on its 资料 row all the time, beside 查看 N 章,
   and pressing it hands over twice (not once only); on the 总纲 page 生成总纲 and 生成复习全书 of that course ask first (深度定制这本书（推荐） / 整本生成 / 取消, with the build's own
   estimate): 取消 starts nothing, 深度定制 hands over and starts nothing, 整本生成 starts the original task; a course with a custom plan reads 查看/修改定制 on the row and starts
   at once. Seeded through the real store, fake model, no key. Pictures go to CUSTOM_GATE_SHOTS when set. */

const at = '2026-11-01T08:00:00.000Z';
const REFUSED = 'Failed to load resource: the server responded with a status of 400 (Bad Request)'; // the build the page asks for: the preview has no background executor
const PAGES = 160;
const fact = (topic, i) => `${topic} fact ${i}: aggregate demand, aggregate supply and the multiplier move output and prices in the short run.`;
const page = (course, n) => ({ id: `${course}-p${n}`, title: `Macro book · p. ${n}`, text: Array.from({ length: 4 }, (_, i) => fact(`Page${n}`, i)).join(' '), createdAt: at, courses: [course],
  document: { materialId: `document-${course}-book`, page: n, totalPages: PAGES, format: 'pdf', origin: 'converted', converter: 'mineru', filename: `${course}-book.pdf`, extractionVersion: 2 } });

const seeder = (course, { plan = false } = {}) => async root => {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    state.sources.push(...Array.from({ length: PAGES }, (_, index) => page(course, index + 1)));
    state.decks.push({ id: `deck-${course}`, title: `${course} deck`, course, cards: [1, 2, 3].map(n => ({ id: `q${n}`, kind: 'flashcard', topic: 'Output', prompt: `Question ${n}: what moves output in the short run?`,
      answer: 'Aggregate demand.', explanation: 'See the book.', citations: [{ sourceId: `${course}-p${n}`, quote: fact(`Page${n}`, 1) }] })) });
    state.focus = { mode: 'class', course, role: '', jd: '', targetTopics: [] };
  });
  await service.call('course.save', { name: course, ...(plan ? { custom: customDefaults('review') } : {}) });
  await service.dispose();
};

const sideways = (page, selector) => page.evaluate(selector => {
  const width = window.innerWidth, wide = [...document.querySelectorAll(`${selector} *`)].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
}, selector);

const captureClipboard = async context => context.addInitScript(() => {
  window.__handed = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__handed.push(String(text)); } } });
});
const handed = page => page.evaluate(() => window.__handed.slice());
/* The preview has no background executor, so a build that is really asked for answers "后台执行器暂时不可用": what is checked is the request the page sends (not an estimate), and that no task exists. */
const watchBuilds = page => {
  const sent = [];
  page.on('request', request => {
    if (!request.url().includes('/api/call')) return;
    try { const { action, args } = JSON.parse(request.postData() || '{}'); if (/^generation\.course(Outline|Book)\.build$/.test(action) && args?.estimate !== true) sent.push({ action, args }); } catch { /* not JSON */ }
  });
  return sent;
};

test('深度定制 on the 资料 row and the gate before 生成总纲 / 生成复习全书 (zh, 1280 and 420 px)', { timeout: 480000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-custom-gate-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await buildPreview({ outdir: dist });
  const shots = process.env.CUSTOM_GATE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const width of [1280, 420]) {
    const running = await startLateServer({ distDir: dist, seed: seeder('宏经') });
    try {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await captureClipboard(context);
      const builds = watchBuilds(page);
      await page.goto(running.server.url);
      // ---- the 资料 row ----
      await (await revealNavRow(page, 'sources')).dispatchEvent('click');
      const entry = page.locator('.source-doc [data-hand-off="custom.start"]');
      await entry.waitFor({ timeout: 30000 });
      assert.equal((await entry.innerText()).trim(), '深度定制', `${width}px: the label`);
      assert.equal(await entry.getAttribute('title'), null, 'the words are a Tooltip, not a title attribute');
      const place = await page.evaluate(() => {
        const toggle = document.querySelector('.source-doc__pages-toggle').getBoundingClientRect(), mine = document.querySelector('.source-doc [data-hand-off="custom.start"]').getBoundingClientRect();
        return { sameLine: Math.abs(toggle.top - mine.top) < 6, after: mine.left >= toggle.right, inside: mine.right <= window.innerWidth && mine.left >= 0, sameHeight: Math.abs(toggle.height - mine.height) < 4 };
      });
      assert.deepEqual(place, { sameLine: true, after: true, inside: true, sameHeight: true }, `${width}px: beside 查看 N 章, same size, inside the window`);
      const flat = await sideways(page, '.sources-page');
      assert.ok(flat.doc <= 0 && flat.wide.length === 0, `${width}px: the 资料 page does not scroll sideways: ${JSON.stringify(flat)}`);
      await entry.hover();
      await page.locator('[role="tooltip"]', { hasText: '确认之前不生成任何东西' }).first().waitFor({ state: 'visible', timeout: 5000 });
      await settleAnimations(page);
      if (shots) await page.locator('article.source-doc').first().screenshot({ path: join(shots, `custom-sources-row-${width}.png`) });
      await page.mouse.move(0, 0);
      await entry.click();
      await until(async () => (await handed(page)).length === 1, 'the first hand-over');
      await entry.click();
      await until(async () => (await handed(page)).length === 2, 'the second hand-over: the entry stays');
      const [first] = await handed(page);
      assert.match(first, /宏经/);
      assert.match(first, new RegExp(String(PAGES)));
      assert.match(first, /document-宏经-book/);
      assert.doesNotMatch(first, /已有定制/);
      assert.equal(await entry.count(), 1, 'still there after pressing it');

      // ---- the 总纲 page ----
      await page.goto(running.server.url);
      await page.locator('.course-header .outline-entry').click();
      await page.locator('.outline-organise').waitFor({ timeout: 30000 });
      const open = async name => {
        await page.getByRole('button', { name, exact: true }).first().click();
        const dialog = page.locator('dialog[data-custom-gate][open]');
        await dialog.waitFor({ timeout: 10000 });
        return dialog;
      };
      // 生成复习全书 (no outline yet: the estimate is the first step's) -> 取消
      let dialog = await open('生成复习全书');
      assert.equal(await dialog.getAttribute('data-custom-gate'), 'book');
      await dialog.locator('[data-custom-gate-scale]').waitFor({ timeout: 30000 });
      const scaleText = await dialog.locator('[data-custom-gate-scale]').innerText();
      assert.match(scaleText, /次模型调用/);
      assert.match(scaleText, /tok/);
      assert.match(scaleText, /这只是第一步/);
      assert.doesNotMatch(await dialog.innerText(), /价|费用|元|\$|¥|price|cost/i, 'no price');
      assert.deepEqual((await dialog.locator('.sh-dialog__footer button').allInnerTexts()).map(text => text.trim()), ['深度定制这本书（推荐）', '整本生成', '取消']);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `custom-gate-book-${width}.png`) });
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await page.locator('dialog[data-custom-gate]').waitFor({ state: 'detached', timeout: 10000 });
      // 生成总纲 -> 取消 starts nothing
      dialog = await open('生成总纲');
      assert.equal(await dialog.getAttribute('data-custom-gate'), 'outline');
      await dialog.locator('[data-custom-gate-scale]').waitFor({ timeout: 30000 });
      assert.match(await dialog.locator('[data-custom-gate-scale]').innerText(), /次模型调用/);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `custom-gate-outline-${width}.png`) });
      const overflow = await sideways(page, 'dialog[data-custom-gate]');
      assert.ok(overflow.wide.length === 0, `${width}px: the dialog stays inside the window: ${JSON.stringify(overflow)}`);
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
      await page.locator('dialog[data-custom-gate]').waitFor({ state: 'detached', timeout: 10000 });
      assert.deepEqual(builds, [], `${width}px: 取消 started nothing`);
      // 深度定制这本书（推荐） hands over (for this course, with the one book) and starts nothing
      const before = (await handed(page)).length;
      dialog = await open('生成总纲');
      await dialog.getByRole('button', { name: '深度定制这本书（推荐）', exact: true }).click();
      await page.locator('dialog[data-custom-gate]').waitFor({ state: 'detached', timeout: 10000 });
      await until(async () => (await handed(page)).length === before + 1, 'the hand-over from the gate');
      const sent = (await handed(page)).at(-1);
      assert.match(sent, /宏经/);
      assert.match(sent, /document-宏经-book/);
      assert.deepEqual(builds, [], `${width}px: 深度定制 started nothing`);
      // 整本生成 starts the original task
      dialog = await open('生成总纲');
      await dialog.getByRole('button', { name: '整本生成', exact: true }).click();
      await page.locator('dialog[data-custom-gate]').waitFor({ state: 'detached', timeout: 10000 });
      await until(async () => builds.length === 1, '整本生成 asks for the 总纲 build');
      assert.deepEqual([builds[0].action, builds[0].args.course, builds[0].args.confirm], ['generation.courseOutline.build', '宏经', true], `${width}px: the original request, unchanged`);
      assert.deepEqual(errors, [REFUSED], `${width}px: no page error but the one build the preview cannot run`);
      await context.close();
    } finally { await running.close(); }
  }
});

test('a course with a custom plan: the row reads 查看/修改定制 and 生成总纲 starts at once (zh, 1280 px)', { timeout: 240000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-custom-gate-plan-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await buildPreview({ outdir: dist });
  const shots = process.env.CUSTOM_GATE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  const running = await startLateServer({ distDir: dist, seed: seeder('微观', { plan: true }) });
  try {
    const { page, errors, context } = await openPage(browser, running, { width: 1280, height: 900 });
    await captureClipboard(context);
    const builds = watchBuilds(page);
    await page.goto(running.server.url);
    await (await revealNavRow(page, 'sources')).dispatchEvent('click');
    const entry = page.locator('.source-doc [data-hand-off="custom.start"]');
    await entry.waitFor({ timeout: 30000 });
    assert.equal((await entry.innerText()).trim(), '查看/修改定制');
    await settleAnimations(page);
    if (shots) await page.locator('article.source-doc').first().screenshot({ path: join(shots, 'custom-sources-row-plan-1280.png') });
    await entry.click();
    await until(async () => (await handed(page)).length === 1, 'the hand-over');
    assert.match((await handed(page))[0], /已有定制/);
    await page.goto(running.server.url);
    await page.locator('.course-header .outline-entry').click();
    await page.locator('.outline-organise').waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: '生成总纲', exact: true }).first().click();
    await until(async () => builds.length === 1, 'the build is asked for at once');
    assert.equal(builds[0].action, 'generation.courseOutline.build');
    assert.equal(await page.locator('dialog[data-custom-gate]').count(), 0, 'no question');
    assert.deepEqual(errors, [REFUSED], 'no page error but the one build the preview cannot run');
    await context.close();
  } finally { await running.close(); }
});
