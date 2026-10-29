/* global document, window, localStorage -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { SEEDS } from '../scripts/qa/tiers.mjs';
import { seedBookFixture } from './helpers/book-fixtures.mjs';
import { drainLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';

/* 3.7 guidance step 3 in the browser preview: the home's one 下一步 card, on a temporary library with a deck of the learner's own. States walked: a round left open
   (接着做, and 今天先不 hides it for the day, across a reload), no model (the settings), a new material without questions (创建题组 with it ticked), an exam in three days (the review book), everything done (no
   button on the card; the day's card keeps the primary). In each: the card is the page's only primary button, the day's card takes a secondary one, nothing sticks out
   sideways, and the card itself never moves while the page settles. 1280 px zh dark, 390 px zh dark, 390 and 320 px en light. NEXT_CARD_SHOTS=<dir> keeps a screenshot of each state. */

const SHOTS = process.env.NEXT_CARD_SHOTS || '';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const primaries = (page) => page.locator('main .sh-btn--primary:visible').count();
const TEXT = {
  zh: { next: '下一步', later: '今天先不', resume: '有一组练习没做完', model: '还没有可用的 AI 模型', fresh: '「Week 2 · Consistency」还没出过题', makeFresh: '用这份资料出题', done: '今天的任务都完成了' },
  en: { next: 'Next step', later: 'Not today', resume: 'A practice round is still open', model: 'No AI model is ready yet', fresh: '“Week 2 · Consistency” has no questions yet', makeFresh: 'Make questions from this material', done: 'Today’s work is complete' },
};

/** A library of the learner's own, set up the way SEEDS.daily does, then bent to the state under test. */
async function seed(api, state) {
  if (state === 'learn') {
    // A first deck of their own, just published and not yet answered: nothing due, nothing wrong, the round is only questions not yet learned.
    const quote = 'A service owns its data so that its boundary is enforced by the contract and not by a shared schema.';
    const card = (id, topic, prompt) => ({ id, kind: 'flashcard', topic, objective: `Explain ${topic}`, prompt, answer: 'Because of the boundary.', hint: 'Think boundary.',
      explanation: 'Ownership keeps change local.', misconception: 'Sharing is cheaper.', citations: [{ sourceId: 's1', quote }] });
    await api('source.add', { id: 's1', title: 'Week 1 · Services and boundaries', text: quote, course: 'Cloud Native Solution Design' });
    await api('draft.save', { deck: { id: 'd1', title: 'Services and boundaries', course: 'Cloud Native Solution Design',
      cards: [card('c1', 'Boundaries', 'Why does a service own its data?'), card('c2', 'Boundaries', 'What is a bounded context?'), card('c3', 'Contracts', 'When is a contract breaking?')] } });
    await api('draft.publish', { id: 'd1' });
    return;
  }
  await SEEDS.daily(api);
  if (state === 'resume' || state === 'model') return;
  const { runs } = await api('snapshot');
  for (const run of runs) await api('review.end', { runId: run.id });
  if (state === 'fresh') await api('source.add', { id: 's2', title: 'Week 2 · Consistency', text: 'Replicas converge when writes are ordered. '.repeat(8), course: 'Cloud Native Solution Design' });
  if (state === 'done' || state === 'exam-no-book') {
    // Every question answered well: nothing due, nothing weak, nothing unlearned.
    const run = await api('review.start', { deckId: 'd1', mode: 'flashcard' });
    let current = run;
    for (let index = 0; index < 5; index++) {
      await api('review.reveal', { runId: run.id, cardId: current.card.id });
      current = await api('review.answer', { runId: run.id, cardId: current.card.id, grade: 5 });
      current = await api('review.move', { runId: run.id, direction: 1 });
    }
    await api('review.end', { runId: run.id });
  }
  if (state === 'exam-no-book') {
    const at = new Date(Date.now() + 3 * 86400000), pad = (value) => String(value).padStart(2, '0');
    await api('course.save', { name: 'Cloud Native Solution Design', exam: { date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` } });
  }
}

async function walk({ browser, dist, state, lang, theme, width, check }) {
  const base = await mkdtemp(join(tmpdir(), 'study-next-card-'));
  // An exam card needs a course with a review book: the book fixture (a 总纲 and its notes, an exam in five days, questions not yet learned), written before the server starts.
  if (state === 'exam') await seedBookFixture(join(base, 'library'), 'questions');
  const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0,
    model: state === 'model' ? null : createFakeModel({ latencyMs: 20 }), distDir: dist });
  try {
    if (state !== 'exam') await seed((action, input = {}) => previewCall(server, action, { ...input, uiLanguage: lang }), state);
    const { page, errors, context } = await openPage(browser, { server }, { lang, theme, width, height: width < 700 ? 844 : 800 });
    await page.goto(server.url);
    await page.locator('.desk').waitFor({ timeout: 30000 });
    await settleAnimations(page);
    await check(page, { server, errors });
    assert.deepEqual(errors.filter((error) => !/favicon|Failed to load resource/.test(error)), [], `${state} ${width}px: no console or page errors`);
    await context.close();
  } finally {
    await server.close().catch(() => {});
    await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
}

/** Every control and line of the card sits inside the card (a long English label wraps; it does not run out of it). */
async function assertInsideCard(page, label) {
  const outside = await page.evaluate(() => {
    const box = document.querySelector('.next-card').getBoundingClientRect();
    return [...document.querySelectorAll('.next-card button, .next-card p, .next-card [data-hand-off]')].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && (rect.right > box.right + 0.5 || rect.left < box.left - 0.5);
    }).map((element) => (element.textContent || '').trim().slice(0, 40));
  });
  assert.deepEqual(outside, [], `${label}: sticks out of the card`);
}

/** The card stayed where the first paint put it: no layout shift names it while the late parts of the home (the day's plan, the exam card) arrive. */
async function assertCardStays(page, label) {
  await drainLayoutStability(page);
  await frames(page, 6);
  await page.waitForTimeout(1500);
  const log = await drainLayoutStability(page);
  const moved = log.shifts.filter((shift) => shift.sources.some((source) => /next-card/.test(source.element)));
  assert.deepEqual(moved, [], `${label}: the 下一步 card moved while the home settled`);
}

test('the 下一步 card on the home: a round left open, no model, a new material, everything done', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const dist = await mkdtemp(join(tmpdir(), 'study-next-card-dist-'));
  await buildPreview({ outdir: dist });
  try {
    for (const [lang, theme, width] of [['zh', 'dark', 1280], ['zh', 'dark', 390], ['en', 'light', 390], ['en', 'light', 320]]) {
      const words = TEXT[lang], tag = `${width}px ${lang}`;
      const card = (page) => page.locator('.next-card');
      const todayButton = (page) => page.locator('.today-go');

      await walk({ browser, dist, state: 'resume', lang, theme, width, check: async (page) => {
        await card(page).waitFor({ timeout: 30000 });
        assert.equal(await card(page).count(), 1, `${tag}: one card`);
        assert.equal(await card(page).getAttribute('data-next'), 'resume');
        assert.match(await card(page).innerText(), new RegExp(words.next));
        assert.match(await card(page).innerText(), new RegExp(words.resume));
        assert.equal(await primaries(page), 1, `${tag}: the card holds the page's one primary button`);
        assert.equal(await card(page).locator('.sh-btn--primary').count(), 1);
        assert.match(await todayButton(page).getAttribute('class'), /sh-btn--secondary/, `${tag}: the day's card takes a secondary button`);
        assert.ok(await page.evaluate(() => document.querySelector('.next-card').getBoundingClientRect().top < document.querySelector('.desk').getBoundingClientRect().top), 'the card is above the desk and the other modules');
        assert.ok(await overflow(page) <= 0, `${tag}: no sideways scroll`);
        await assertInsideCard(page, `${tag} resume`);
        await assertCardStays(page, `${tag} resume`);
        await settleAnimations(page);
        await shot(page, `01-resume-${width}-${lang}`);
        // 今天先不: hidden for the local day, remembered across a reload; the day's button is the primary again.
        await card(page).getByRole('button', { name: words.later }).click();
        await card(page).waitFor({ state: 'detached', timeout: 10000 });
        assert.match(await todayButton(page).getAttribute('class'), /sh-btn--primary/, `${tag}: with the card put off, the day's card has the primary`);
        assert.equal(await primaries(page), 1);
        const stored = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('study-next-card:')));
        assert.equal(stored.length, 1, 'one mark for the library');
        assert.match(stored[0][1], /^\d{4}-\d{2}-\d{2}$/, 'the mark is the local day');
        await page.reload();
        await page.locator('.desk').waitFor({ timeout: 30000 });
        await settleAnimations(page);
        assert.equal(await card(page).count(), 0, `${tag}: still put off after a reload`);
        // 设置 › 引导 lists the card as seen and can bring it back.
        await page.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('study-next-card:')) localStorage.setItem(key, '2000-01-01'); });
        await page.reload();
        await card(page).waitFor({ timeout: 30000 });
        assert.equal(await card(page).getAttribute('data-next'), 'resume', `${tag}: another day, the card is back`);
        assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('study-next-card:')).length), 0, 'the mark of an earlier day is forgotten');
      } });

      await walk({ browser, dist, state: 'model', lang, theme, width, check: async (page) => {
        await card(page).waitFor({ timeout: 30000 });
        assert.equal(await card(page).getAttribute('data-next'), 'model');
        assert.match(await card(page).innerText(), new RegExp(words.model));
        assert.equal(await primaries(page), 1, `${tag} no model: one primary`);
        await assertInsideCard(page, `${tag} model`);
        await assertCardStays(page, `${tag} model`);
        await shot(page, `02-model-${width}-${lang}`);
        assert.ok(await overflow(page) <= 0, `${tag}: no sideways scroll`);
        await card(page).locator('.sh-btn--primary').click();
        await until(async () => !(await card(page).count()), 'the settings page replaces the home', { timeoutMs: 20000 });
      } });

      await walk({ browser, dist, state: 'fresh', lang, theme, width, check: async (page) => {
        await card(page).waitFor({ timeout: 30000 });
        assert.equal(await card(page).getAttribute('data-next'), 'new-source');
        assert.equal((await card(page).locator('.next-card__headline').innerText()).trim(), words.fresh);
        assert.equal(await primaries(page), 1, `${tag} new material: one primary`);
        assert.equal((await card(page).locator('.sh-btn--primary').innerText()).trim(), words.makeFresh);
        assert.match(await todayButton(page).getAttribute('class'), /sh-btn--secondary/);
        await assertInsideCard(page, `${tag} new material`);
        await assertCardStays(page, `${tag} new material`);
        await shot(page, `03-new-material-${width}-${lang}`);
        assert.ok(await overflow(page) <= 0, `${tag}: no sideways scroll`);
        await card(page).locator('.sh-btn--primary').click();
        await page.locator('.generate-page').waitFor({ timeout: 20000 });
        assert.equal(await card(page).count(), 0, 'the form replaces the home');
      } });

      await walk({ browser, dist, state: 'exam', lang, theme, width, check: async (page) => {
        await card(page).waitFor({ timeout: 30000 });
        assert.equal(await card(page).getAttribute('data-next'), 'exam');
        assert.match(await card(page).locator('.next-card__headline').innerText(), lang === 'zh' ? /「ArchSS」5 天后考试/ : /“ArchSS” exam in 5 days/);
        assert.equal(await primaries(page), 1, `${tag} exam: one primary`);
        await assertInsideCard(page, `${tag} exam`);
        await shot(page, `05-exam-${width}-${lang}`);
        await card(page).locator('.sh-btn--primary').click();
        await page.locator('.book-page').first().waitFor({ timeout: 20000 });
        assert.equal(await card(page).count(), 0, 'the review book replaces the home');
        // The card promised a plan over the book: it is a book (points to read), not the "no outline yet" page.
        await page.locator('[data-book-point]').first().waitFor({ timeout: 30000 });
        assert.doesNotMatch(await page.locator('.book-page').first().innerText(), /还没有总纲|no outline yet/);
      } });

      // The same exam date on a course with no review book: the card does not promise one (the book page would be an empty state); the work that is there is said.
      await walk({ browser, dist, state: 'exam-no-book', lang, theme, width, check: async (page) => {
        await card(page).waitFor({ timeout: 30000 });
        assert.equal(await card(page).getAttribute('data-next'), 'done', `${tag}: an exam near a course without a book is no card about the book`);
        assert.doesNotMatch(await card(page).innerText(), /复习全书|review book/i);
        assert.equal(await primaries(page), 1);
      } });

      // The home right after a first deck: nothing due, nothing wrong, the round is only questions not yet learned. The card must not say there is nothing to do.
      await walk({ browser, dist, state: 'learn', lang, theme, width, check: async (page) => {
        await card(page).waitFor({ timeout: 30000 });
        assert.equal(await card(page).getAttribute('data-next'), 'learn');
        const text = await card(page).innerText();
        assert.match(text, lang === 'zh' ? /今天有 [0-9]+ 题待学/ : /[0-9]+ to study today/);
        assert.doesNotMatch(text, /今天没有要做的复习|No review is waiting today/);
        assert.equal(await primaries(page), 1, `${tag} learn: one primary`);
        assert.equal(await card(page).locator('.sh-btn--primary').count(), 1, `${tag}: the card holds the primary button`);
        assert.match(await todayButton(page).getAttribute('class'), /sh-btn--secondary/);
        // The card's number is the day's card number.
        const count = (text.match(/[0-9]+/) || [])[0];
        assert.match(await page.locator('.today-card').innerText(), new RegExp(`(^|[^0-9])${count}([^0-9]|$)`),`${tag}: the card and the day's card say the same number`);
        await assertInsideCard(page, `${tag} learn`);
        await assertCardStays(page, `${tag} learn`);
        await shot(page, `06-learn-${width}-${lang}`);
        assert.ok(await overflow(page) <= 0, `${tag}: no sideways scroll`);
      } });

      await walk({ browser, dist, state: 'done', lang, theme, width, check: async (page) => {
        await card(page).waitFor({ timeout: 30000 });
        assert.equal(await card(page).getAttribute('data-next'), 'done');
        assert.match(await card(page).innerText(), new RegExp(words.done.replace(/[’']/g, '.')));
        assert.equal(await card(page).locator('.sh-btn--primary').count(), 0, `${tag}: the done card has no primary button`);
        assert.match(await todayButton(page).getAttribute('class'), /sh-btn--primary/, `${tag}: so the day's card keeps it`);
        assert.equal(await primaries(page), 1);
        await assertInsideCard(page, `${tag} done`);
        await assertCardStays(page, `${tag} done`);
        await shot(page, `04-done-${width}-${lang}`);
        assert.ok(await overflow(page) <= 0, `${tag}: no sideways scroll`);
        assert.equal(await card(page).locator('[data-hand-off="guide.start"]').count(), 1, 'the way to the main chat stays one click away');
      } });
    }
  } finally { await browser.close().catch(() => {}); await rm(dist, { recursive: true, force: true }); }
});
