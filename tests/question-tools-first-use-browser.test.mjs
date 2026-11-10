/* global document, window, localStorage, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { openPage } from '../scripts/qa/layout-late.mjs';

/* The three first-use tips under a practice question (#948), in the real app on a made-up library (no model is called, no real library is read):
     帮我弄懂  after the first wrong answer;  修题  after the first 「这题有问题」;  出成前置题  once an answer stands under the question.
   Each shows once, only after the learner acted, never before; it pushes nothing, never covers 下一题 (1280 and 420 px), takes no focus (Enter still means 下一题),
   closes with 知道了 or Esc, and stays away when the master switch or its own switch of 设置 › 引导 is off. QUESTION_TIPS_SHOTS=<folder> keeps screenshots. */

const SHOTS = process.env.QUESTION_TIPS_SHOTS || '';
const TIPS_KEY = 'study-practice-tips';
const card = (id, n) => ({
  id, kind: 'quiz', topic: 'Indexes', objective: `Explain indexes precisely (${n})`, prompt: `Question ${n}: which statement about database indexes is right?`,
  answer: 'An index speeds up lookups on a key', hint: 'Think about how the data is stored.',
  explanation: 'An index keeps the keys in a sorted structure, so a lookup does not scan every row.', misconception: 'An index is not a copy of the table.', citations: [],
  options: [{ id: 'a', text: 'An index speeds up lookups on a key', correct: true, explanation: 'Yes: the sorted keys let the database jump to the row.' },
    { id: 'b', text: 'An index always makes every write faster', correct: false, explanation: 'No: every write must also update the index.' },
    { id: 'c', text: 'An index replaces the table', correct: false, explanation: 'No: the table still holds the rows.' }],
});

async function seed(root, { qa }) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((s) => { s.decks.push({ id: 'd', title: 'Databases · Indexes', course: 'Databases', folder: '', publishedAt: '2026-10-01T00:00:00.000Z', cards: [1, 2, 3].map((n) => card(`c${n}`, n)) }); });
  if (qa) await service.call('card.followup.add', { deckId: 'd', cardId: 'c1', question: 'Why does a B-tree index stay balanced?', answer: 'Every insert and delete splits or merges nodes so that all leaves stay at the same depth.', source: 'assistant' });
  service.dispose?.();
}

async function start(dist, options = {}) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-question-tips-'));
  const root = join(base, 'library');
  await seed(root, options);
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
  return { server, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

async function openRun(browser, running, { width = 1280, lang = 'zh', storage = {} } = {}) {
  const opened = await openPage(browser, running, { lang, theme: 'dark', width, height: 900 });
  await opened.page.addInitScript(([entries]) => { try { localStorage.setItem('study-autopilot', 'off'); for (const [key, value] of Object.entries(entries)) if (!localStorage.getItem(key)) localStorage.setItem(key, value); } catch { /* blocked */ } }, [storage]);
  await opened.page.goto(running.server.url);
  await opened.page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
  await opened.page.locator('.question-toolbar').waitFor({ timeout: 30000 });
  await opened.page.waitForTimeout(1000);
  return opened;
}
const answer = async (page, which) => {
  await page.locator('.options .option', { hasText: which === 'wrong' ? 'always makes every write' : 'speeds up lookups' }).click();
  await page.locator('.next-due').waitFor({ timeout: 15000 });
};
/** The learner scrolls to the tools under the question (at 420 px they are below the fold): a tip waits for its control to be on screen. */
const toTools = (page) => page.evaluate(() => document.querySelector('.question-toolbar').scrollIntoView({ block: 'center' }));
const tipOf = (page, id) => page.locator(`[data-practice-tip="${id}"]`);
const anyTip = (page) => page.locator('[data-practice-tip]');
const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '[]'), TIPS_KEY);
const boxes = (page) => page.evaluate(() => {
  const rect = (element) => { if (!element) return null; const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  const tip = document.querySelector('[data-practice-tip]');
  return { tip: rect(tip), open: !!tip?.matches(':popover-open'), position: tip ? getComputedStyle(tip).position : '', viewport: { width: window.innerWidth, height: window.innerHeight },
    next: rect(document.querySelector('[data-usage="review.next"]')), prev: rect(document.querySelector('[data-usage="review.prev"]')),
    help: rect(document.querySelector('[data-usage="review.help"]')), fix: rect(document.querySelector('[data-usage="review.improve"]')),
    derive: rect([...document.querySelectorAll('[data-usage="review.derive-prereq"]')].find((link) => link.getClientRects().length)),
    toolbar: rect(document.querySelector('.question-toolbar')), more: rect(document.querySelector('.question-navigation .review-more-trigger')),
    focus: document.activeElement?.tagName || '', scrollWidth: document.documentElement.scrollWidth };
});
const covers = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
const insideWindow = (tip, viewport) => tip.left >= 0 && tip.top >= 0 && tip.right <= viewport.width && tip.bottom <= viewport.height;
const shot = async (page, name) => { if (SHOTS) { await mkdir(SHOTS, { recursive: true }); await page.screenshot({ path: join(SHOTS, `${name}.png`) }); } };
const WORDS = {
  zh: { help: '没懂？点「帮我弄懂」，讲解会直接出现在这道题下面。', fix: '觉得题目本身有问题？点「修题」', prereq: '这一点基础不牢？点「出成前置题」', ok: '知道了', more: '更多', thumbDown: /这题有问题/ },
  en: { help: 'Still not clear? Choose “Help me understand”', fix: 'Think the question itself is wrong? Choose “Improve question”', prereq: 'Is this point shaky? Choose “Turn into a prerequisite question”', ok: 'Got it', more: 'More', thumbDown: /Something is wrong with it/ },
};
const voteDown = async (page, words) => {
  await page.evaluate(() => document.querySelector('.question-toolbar').scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(400);
  await page.locator('.question-toolbar').getByRole('button', { name: words.more, exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: words.thumbDown }).click();
};

test('the three first-use tips of the practice page (zh 1280 and 420 px, en 420 px)', { timeout: 1200000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-question-tips-dist-'));
  await buildPreview({ outdir: dist });
  const servers = [];
  const fresh = async (options) => { const running = await start(dist, options); servers.push(running); return running; };
  t.after(async () => { await browser.close().catch(() => {}); for (const running of servers) await running.close().catch(() => {}); await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); });

  for (const [lang, width] of [['zh', 1280], ['zh', 420], ['en', 420]]) {
    const words = WORDS[lang], where = `${lang} ${width}px`;

    // ---- 帮我弄懂: nothing while the learner is thinking, nothing after a right answer, one after the first wrong one ----
    {
      const running = await fresh();
      const { page, context, errors } = await openRun(browser, running, { width, lang });
      await page.waitForTimeout(1500);
      assert.equal(await anyTip(page).count(), 0, `${where}: no tip while the question is unanswered`);
      await answer(page, 'wrong');
      await toTools(page);
      await tipOf(page, 'practice.help-first').waitFor({ state: 'visible', timeout: 10000 });
      const before = await boxes(page);
      assert.equal(before.position, 'fixed', `${where}: the tip is an overlay, not in the flow`);
      assert.ok(before.open, `${where}: in the top layer`);
      assert.ok(insideWindow(before.tip, before.viewport), `${where}: inside the window ${JSON.stringify(before.tip)}`);
      for (const [name, control] of [['下一题', before.next], ['上一题', before.prev], ['更多', before.more]]) assert.ok(!covers(before.tip, control), `${where}: the tip does not cover ${name}`);
      assert.ok(!covers(before.tip, before.help) && !covers(before.tip, before.fix), `${where}: nor the controls it is about`);
      assert.match(await tipOf(page, 'practice.help-first').innerText(), new RegExp(words.help.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${where}: the words`);
      assert.equal(await anyTip(page).count(), 1, `${where}: one tip at a time`);
      assert.ok(before.scrollWidth <= before.viewport.width, `${where}: no sideways scroll`);
      if (lang === 'zh') await shot(page, `help-first-${width}`);
      // the tip takes no focus: the next key still moves on
      assert.notEqual(before.focus, 'BUTTON', `${where}: focus is not on a button`);
      assert.ok(await page.locator('[data-practice-tip] button').evaluate((button) => document.activeElement !== button), `${where}: the tip's button has no focus`);
      await page.keyboard.press('Enter');
      await page.locator('.options .option:not([disabled])').first().waitFor({ timeout: 15000 });
      assert.equal(await anyTip(page).count(), 0, `${where}: moving on takes the tip away`);
      assert.deepEqual(await stored(page), ['help-first'], `${where}: it was shown, so it is seen`);
      await answer(page, 'wrong');
      await page.waitForTimeout(1500);
      assert.equal(await anyTip(page).count(), 0, `${where}: a second wrong answer shows nothing: once`);
      assert.deepEqual(errors, [], `${where}: no page errors`);
      await context.close();
    }

    // ---- 帮我弄懂, closed with 知道了 and with Esc; a right answer shows nothing ----
    {
      const running = await fresh();
      const { page, context } = await openRun(browser, running, { width, lang });
      await answer(page, 'right');
      await page.waitForTimeout(1500);
      assert.equal(await anyTip(page).count(), 0, `${where}: a right answer shows no tip`);
      await page.keyboard.press('Enter');
      await page.locator('.options .option:not([disabled])').first().waitFor({ timeout: 15000 });
      await answer(page, 'wrong');
      await toTools(page);
      await tipOf(page, 'practice.help-first').waitFor({ state: 'visible', timeout: 10000 });
      const shown = await boxes(page);
      await page.locator('[data-practice-tip]').getByRole('button', { name: words.ok, exact: true }).click();
      assert.equal(await anyTip(page).count(), 0, `${where}: 知道了 closes it`);
      const after = await boxes(page);
      for (const name of ['toolbar', 'next', 'help', 'fix']) assert.deepEqual(after[name], shown[name], `${where}: ${name} did not move when the tip came or went`);
      assert.deepEqual(await stored(page), ['help-first']);
      await page.reload();
      await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(1500);
      assert.equal(await anyTip(page).count(), 0, `${where}: it does not come back after a reload`);
      await context.close();
    }
    {
      const running = await fresh();
      const { page, context } = await openRun(browser, running, { width, lang });
      await answer(page, 'wrong');
      await toTools(page);
      await tipOf(page, 'practice.help-first').waitFor({ state: 'visible', timeout: 10000 });
      await page.keyboard.press('Escape');
      await anyTip(page).first().waitFor({ state: 'detached', timeout: 5000 });
      assert.deepEqual(await stored(page), ['help-first'], `${where}: Esc closes it for good`);
      await context.close();
    }

    // ---- using the control it points at: seen quietly ----
    {
      const running = await fresh();
      const { page, context } = await openRun(browser, running, { width, lang });
      await answer(page, 'wrong');
      await toTools(page);
      await tipOf(page, 'practice.help-first').waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('[data-usage="review.help"]').click();
      await anyTip(page).first().waitFor({ state: 'detached', timeout: 5000 });
      assert.deepEqual(await stored(page), ['help-first'], `${where}: 帮我弄懂 was used`);
      await page.waitForTimeout(1200);
      assert.equal(await anyTip(page).count(), 0);
      await context.close();
    }

    // ---- 修题 after the first 「这题有问题」 ----
    {
      const running = await fresh();
      const { page, context } = await openRun(browser, running, { width, lang });
      await answer(page, 'right');
      await page.waitForTimeout(1200);
      assert.equal(await anyTip(page).count(), 0, `${where}: voting is the moment, not the answer`);
      await voteDown(page, words);
      await tipOf(page, 'practice.fix-first').waitFor({ state: 'visible', timeout: 15000 });
      const fix = await boxes(page);
      assert.ok(insideWindow(fix.tip, fix.viewport), `${where}: inside the window ${JSON.stringify(fix)}`);
      for (const [name, control] of [['下一题', fix.next], ['上一题', fix.prev], ['更多', fix.more]]) assert.ok(!covers(fix.tip, control), `${where}: the tip does not cover ${name}`);
      assert.match(await tipOf(page, 'practice.fix-first').innerText(), new RegExp(words.fix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.equal(await anyTip(page).count(), 1);
      if (lang === 'zh') await shot(page, `fix-first-${width}`);
      await page.locator('[data-usage="review.improve"]').click();
      await anyTip(page).first().waitFor({ state: 'detached', timeout: 5000 });
      assert.deepEqual(await stored(page), ['fix-first'], `${where}: 修题 was used`);
      await context.close();
    }

    // ---- 出成前置题: an answer under the question; when it coincides with a wrong answer the earlier row wins and this one waits ----
    {
      const running = await fresh({ qa: true });
      const { page, context } = await openRun(browser, running, { width, lang });
      await answer(page, 'right');
      await page.waitForTimeout(1500);
      assert.equal(await anyTip(page).count(), 1, `${where}: the tip is drawn, but waits for its link to come on screen`);
      assert.equal(await page.locator('[data-practice-tip]').isVisible(), (await boxes(page)).derive?.bottom <= 900, `${where}: shown only when the link is on screen`);
      await page.locator('[data-usage="review.derive-prereq"]').first().scrollIntoViewIfNeeded();
      await tipOf(page, 'practice.prereq-first').waitFor({ state: 'visible', timeout: 10000 });
      const prereq = await boxes(page);
      assert.ok(prereq.derive, `${where}: the link it points at is on screen`);
      assert.ok(insideWindow(prereq.tip, prereq.viewport), `${where}: inside the window ${JSON.stringify(prereq.tip)}`);
      assert.ok(!covers(prereq.tip, prereq.derive), `${where}: it does not cover the link`);
      assert.match(await tipOf(page, 'practice.prereq-first').innerText(), new RegExp(words.prereq.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      if (lang === 'zh') await shot(page, `prereq-first-${width}`);
      await page.locator('[data-practice-tip]').getByRole('button', { name: words.ok, exact: true }).click();
      assert.deepEqual(await stored(page), ['prereq-first']);
      await context.close();
    }
    {
      const running = await fresh({ qa: true });
      const { page, context } = await openRun(browser, running, { width, lang });
      await answer(page, 'wrong');
      await toTools(page);
      await tipOf(page, 'practice.help-first').waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await anyTip(page).count(), 1, `${where}: a wrong answer with an answer under it: one tip, the earlier row`);
      await page.locator('[data-practice-tip]').getByRole('button', { name: words.ok, exact: true }).click();
      await page.waitForTimeout(1500);
      assert.equal(await anyTip(page).count(), 0, `${where}: the other moment waits for its next one`);
      assert.deepEqual(await stored(page), ['help-first']);
      await context.close();
    }
  }

  // ---- the switches of 设置 › 引导, and a seen tip that is brought back ----
  for (const [name, guidance] of [['the master switch is off', { off: true }], ['its own switch is off', { muted: ['practice.help-first'] }]]) {
    const running = await fresh();
    const { page, context } = await openRun(browser, running, { storage: { 'study-guidance:v1': JSON.stringify(guidance) } });
    await answer(page, 'wrong');
    await page.waitForTimeout(1800);
    assert.equal(await anyTip(page).count(), 0, `${name}: no tip`);
    assert.deepEqual(await stored(page), [], `${name}: and nothing is spent`);
    await context.close();
  }
  {
    const running = await fresh();
    const { page, context } = await openRun(browser, running, { storage: { [TIPS_KEY]: JSON.stringify(['help-first']) } });
    await answer(page, 'wrong');
    await page.waitForTimeout(1800);
    assert.equal(await anyTip(page).count(), 0, 'a tip seen before does not show again');
    await page.evaluate((key) => localStorage.removeItem(key), TIPS_KEY);
    await page.keyboard.press('Enter');
    await page.locator('.options .option:not([disabled])').first().waitFor({ timeout: 15000 });
    await answer(page, 'wrong');
    await tipOf(page, 'practice.help-first').waitFor({ state: 'visible', timeout: 10000 });
    await context.close();
  }
});
