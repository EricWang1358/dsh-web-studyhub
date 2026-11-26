/* global localStorage, document, innerWidth, window, KeyboardEvent */
import test from 'node:test';
import { dismissAfterOverlay } from './helpers/overlay-escape.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium, skipMissingChromium } from '../scripts/qa/browser.mjs';
import { globalCss } from './helpers/global-css.mjs';
import { PLAIN_HELP_REQUEST } from '../lib/assist-contract.js';

/* #1008 / #1009 in a real browser, at 1280 and 420 px: a question set aside (先跳过: K at 1280, 更多 at 420) comes back after the others, 下一题 does not say 完成
   while it waits, the narrow window's 「N 题待答」 list jumps, 到此为止 asks once and opens the result page with the unanswered one counted, the result page lists
   the round's questions and opens a read-only look-back that records nothing, and autopilot does not carry a stopped round on (while it does carry a finished one).
   The toolbar stays one row and nothing scrolls sideways. STUDYHUB_SHOTS=<folder> keeps screenshots. */

const RUNS = [['zh', 1280, 800], ['zh', 420, 900], ['en', 420, 900]];
const deckOf = (i) => ({ id: `d${i}`, title: `Round controls ${i}`, course: 'Course', cards: [1, 2, 3, 4].map((n) => quiz(`d${i}`, n)) });
const quiz = (deck, n) => ({ id: `${deck}-q${n}`, kind: 'quiz', topic: `Topic ${n}`, objective: 'Recall', prompt: `Question number ${n}?`, hint: 'Think.', explanation: `Explanation ${n}.`,
  misconception: `Misconception ${n}.`, citations: [], options: [{ id: 'a', text: 'yes', correct: true, explanation: 'Right.' }, { id: 'b', text: 'no', correct: false, explanation: 'Wrong.' }] });
const WORDS = {
  zh: { skip: /先跳过/, end: /到此为止…/, confirm: '到此为止，看结果', next: '下一题', resume: (title) => `继续 ${title}`, pending: (n) => `${n} 题待答`, closed: '这一轮，已结束。', unanswered: '未答 1',
    lookBack: '本轮题目', showAll: (n) => `显示全部 ${n} 题`, unansweredNote: /这道题这一轮没有作答/, left: (n) => `还有 ${n} 题没答` },
  en: { skip: /Skip for now/, end: /Stop here…/, confirm: 'Stop and see the result', next: 'Next question', resume: (title) => `Resume ${title}`, pending: (n) => `${n} to answer`, closed: 'This session has ended.', unanswered: 'unanswered 1',
    lookBack: 'Questions in this round', showAll: (n) => `Show all ${n} questions`, unansweredNote: /did not answer this question/, left: (n) => n === 1 ? '1 question is still unanswered' : `${n} questions are still unanswered` },
};

async function serve(t, setup) {
  const root = await mkdtemp(join(tmpdir(), 'round-controls-browser-'));
  const service = new StudyService(join(root, 'library'));
  await service.store.update((s) => {
    if (setup) setup(s);
    else s.decks.push(...RUNS.map((_, i) => deckOf(i)), { ...deckOf('c'), cards: deckOf('c').cards.slice(0, 3) });
  });
  await service.dispose();
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  try { browser = await launchChromium(); } catch (error) { skipMissingChromium(t, error); return null; }
  return { server, browser };
}

const prompt = (page) => page.locator('.question-card .question').first().innerText();
const answerRight = async (page) => { await page.locator('.option', { hasText: 'yes' }).click(); await page.locator('.option.correct').first().waitFor(); };
const nextButton = (page) => page.locator('[data-usage="review.next"]');
async function chooseMore(page, item) {
  await page.locator('.review-more-trigger').click();
  await page.getByRole('menuitem', { name: item }).click();
}
const layout = (page) => page.evaluate(() => {
  const box = (el) => { const r = el?.getBoundingClientRect(); return r ? { top: r.top, bottom: r.bottom, height: r.height } : null; };
  const nav = document.querySelector('.question-navigation');
  const buttons = [...(nav?.querySelectorAll('button') || [])].map((button) => { const b = box(button); return Math.round(b.top + b.height / 2); });
  return { overflow: document.documentElement.scrollWidth - innerWidth, navigationTops: buttons };
});

test('先跳过, 「N 题待答」, 到此为止 and the look-back, at 1280 and 420 px', { timeout: 600000 }, async (t) => {
  const served = await serve(t);
  if (!served) return;
  const { server, browser } = served;
  const shots = process.env.STUDYHUB_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const [i, [lang, width, height]] of RUNS.entries()) {
    const where = `${lang} ${width}px`, words = WORDS[lang], deck = deckOf(i);
    for (const open of (await previewCall(server, 'snapshot', {})).runs || []) await previewCall(server, 'review.end', { runId: open.id });
    await previewCall(server, 'settings.practice.set', { patch: { autopilot: false, debrief: false } });
    const run = await previewCall(server, 'review.start', { mode: 'path', fresh: true, scope: [{ deckId: deck.id }] });
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript((language) => { localStorage.setItem('study-ui-language', language); }, lang);
    await page.goto(server.url);
    await page.getByRole('button', { name: words.resume(deck.title) }).first().click();
    await page.locator('.question-card').waitFor({ timeout: 30000 });
    assert.match(await prompt(page), /Question number 1\?/, `${where}: the round opens on question 1`);
    const wide = width >= 1000;
    // Where the column of ticks is drawn the chip is not, and the other way round.
    assert.equal(await page.locator('.review-navigator').isVisible(), wide, `${where}: the column only on a wide page`);
    assert.equal(await page.locator('.round-pending__trigger').isVisible(), !wide, `${where}: 「N 题待答」 only on a narrow page`);
    if (wide) assert.equal(await page.locator('.review-end-tick').count(), 1, `${where}: 到此为止 at the tail of the column`);
    else assert.equal((await page.locator('.round-pending__trigger').innerText()).trim(), words.pending(4), `${where}: four to answer`);
    if (shots) await page.screenshot({ path: join(shots, `round-controls-${lang}-${width}-question.png`) });
    // 先跳过: the K key on a wide page (focus in the panel), 更多 on a narrow one.
    if (wide) await page.keyboard.press('k');
    else await chooseMore(page, words.skip);
    await page.waitForFunction(() => /Question number 2\?/.test(document.querySelector('.question-card .question')?.textContent || ''));
    // Questions 2-4, then 下一题 on the last one says 下一题 (question 1 waits) and brings question 1 back.
    for (const n of [2, 3, 4]) {
      assert.match(await prompt(page), new RegExp(`Question number ${n}\\?`), `${where}: question ${n}`);
      await answerRight(page);
      if (n === 4) assert.equal((await nextButton(page).innerText()).replace('→', '').trim(), words.next, `${where}: not 完成 while a skipped question waits`);
      await nextButton(page).click();
      if (n < 4) await page.waitForFunction((k) => new RegExp(`Question number ${k}\\?`).test(document.querySelector('.question-card .question')?.textContent || ''), n + 1);
    }
    await page.waitForFunction(() => /Question number 1\?/.test(document.querySelector('.question-card .question')?.textContent || ''));
    if (!wide) {
      // The chip now says one, and its list jumps (to question 3, then back to 1).
      assert.equal((await page.locator('.round-pending__trigger').innerText()).trim(), words.pending(1), `${where}: one left`);
      await page.locator('.round-pending__trigger').click();
      await page.locator('.round-pending__item', { hasText: /^3$/ }).click();
      await page.waitForFunction(() => /Question number 3\?/.test(document.querySelector('.question-card .question')?.textContent || ''));
      await page.locator('.round-pending__trigger').click();
      await page.locator('.round-pending__item', { hasText: /^1$/ }).click();
      await page.waitForFunction(() => /Question number 1\?/.test(document.querySelector('.question-card .question')?.textContent || ''));
    }
    const shape = await layout(page);
    assert.ok(shape.overflow <= 0, `${where}: no sideways scroll (${shape.overflow})`);
    // English labels are longer and the row may wrap there by design (ui/language.css); nothing this change adds sits in that row.
    if (lang === 'zh') assert.ok(shape.navigationTops.length >= 3 && shape.navigationTops.every((top) => Math.abs(top - shape.navigationTops[0]) <= 4), `${where}: 更多 / 上一题 / 下一题 stay one row (${shape.navigationTops})`);
    const attemptsBefore = (await previewCall(server, 'export', {})).attempts.filter((item) => item.deckId === deck.id).length;
    assert.equal(attemptsBefore, 3, `${where}: three answers, nothing for the skip`);
    // 到此为止 asks once, says what is left, then the result page. Autopilot is on by now: it must not carry the stopped round on.
    await previewCall(server, 'settings.practice.set', { patch: { autopilot: true } });
    await chooseMore(page, words.end);
    const confirm = page.locator('.round-end-confirm');
    await confirm.waitFor();
    assert.match(await confirm.innerText(), new RegExp(words.left(1)), `${where}: the confirm says one is unanswered`);
    if (shots) await page.screenshot({ path: join(shots, `round-controls-${lang}-${width}-confirm.png`) });
    await confirm.getByRole('button', { name: words.confirm }).click();
    await page.locator('.result-page').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.result-title').innerText(), words.closed, `${where}: the ended round's title`);
    assert.match(await page.locator('.result-breakdown').getAttribute('aria-label'), new RegExp(words.unanswered), `${where}: the breakdown counts the unanswered one`);
    // The look-back: only the unanswered one at first, then all four; opening rows records nothing.
    const list = page.locator('.round-look-back');
    await list.getByRole('heading', { name: words.lookBack }).waitFor();
    assert.equal(await list.locator('.look-back__row').count(), 1, `${where}: only the unanswered row at first`);
    await list.locator('.look-back__line').first().click();
    assert.match(await list.locator('.look-back__panel').first().innerText(), words.unansweredNote, `${where}: an unanswered question keeps its answer back`);
    assert.doesNotMatch(await list.locator('.look-back__panel').first().innerText(), /Explanation 1\./, `${where}: no explanation for the unanswered one`);
    await list.getByRole('button', { name: words.showAll(4) }).click();
    assert.equal(await list.locator('.look-back__row').count(), 4, `${where}: all four`);
    const second = list.locator('.look-back__row').nth(1);
    await second.locator('.look-back__line').click();
    const panel = second.locator('.look-back__panel');
    await panel.waitFor();
    assert.match(await panel.innerText(), /Explanation 2\./, `${where}: the explanation`);
    assert.equal(await panel.locator('.option.correct').count(), 1, `${where}: the right answer marked`);
    const after = await previewCall(server, 'export', {});
    assert.equal(after.attempts.filter((item) => item.deckId === deck.id).length, attemptsBefore, `${where}: looking back records nothing`);
    assert.equal((await layout(page)).overflow <= 0, true, `${where}: the result page does not scroll sideways`);
    if (shots) { await list.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(shots, `round-controls-${lang}-${width}-result.png`) }); }
    await page.waitForTimeout(2500);
    assert.equal(await page.locator('.coach-countdown[role="status"]').count(), 0, `${where}: no autopilot countdown on a stopped round`);
    assert.equal(await page.locator('.result-page').count(), 1, `${where}: still on the result page`);
    assert.equal((await previewCall(server, 'review.get', { runId: run.id })).closed, true);
    assert.deepEqual(errors, [], `${where}: no page errors`);
    await context.close();
  }
  /* The control, a finished round: 先跳过 question 1, answer 2 and 3, 下一题 brings 1 back, and once it is answered the button says 完成 and one press opens
     the result page (下一题 does not walk through the answered ones). With the same switch on, this result page does count down (so the check above is not empty). */
  const control = deckOf('c');
  for (const open of (await previewCall(server, 'snapshot', {})).runs || []) await previewCall(server, 'review.end', { runId: open.id });
  await previewCall(server, 'settings.practice.set', { patch: { autopilot: false } });
  await previewCall(server, 'review.start', { mode: 'path', fresh: true, scope: [{ deckId: control.id }] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let releaseSnapshot, holdSnapshot = false;
  const heldSnapshot = new Promise((resolve) => { releaseSnapshot = resolve; });
  try {
    await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); });
    await page.route('**/api/call', async (route) => {
      if (holdSnapshot && route.request().postDataJSON()?.action === 'snapshot') await heldSnapshot;
      return route.fallback();
    });
    await page.goto(server.url);
    const resumeButton = page.getByRole('button', { name: '接着做' }).first();
    await resumeButton.waitFor();
    // Hold any post-resume snapshot so openRun cannot mask a busy-lock regression behind a fast local server.
    holdSnapshot = true;
    await resumeButton.click(); // the home card for the open round
    const on = (k) => page.waitForFunction((n) => new RegExp(`Question number ${n}\\?`).test(document.querySelector('.question-card .question')?.textContent || ''), k);
    await on(1);
    await page.keyboard.press('k');
    await on(2);
    holdSnapshot = false;
    releaseSnapshot();
    for (const n of [2, 3]) {
      await on(n);
      await answerRight(page);
      await nextButton(page).click();
    }
    await on(1);
    await answerRight(page);
    assert.equal((await nextButton(page).innerText()).replace('→', '').trim(), '完成', 'the set-aside question was the last one waiting');
    // The switch goes on only for the last step, so the questions themselves do not move on by the countdown (the step reloads the library).
    await previewCall(server, 'settings.practice.set', { patch: { autopilot: true } });
    await nextButton(page).click();
    await page.locator('.result-page').waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.result-title').innerText(), '这一轮，完成了。');
    await page.locator('.coach-countdown[role="status"]').waitFor({ timeout: 15000 });
  } finally {
    releaseSnapshot?.();
    await context.close();
  }
});

test('Cloze Enter/Esc keyboard flow and RoundLookBack source-page jump in a real browser', { timeout: 600000 }, async (t) => {
  const clozeDeck = {
    id: 'cloze-src',
    title: 'Cloze Source Flow',
    course: 'Course',
    cards: [{
      id: 'clz-1',
      kind: 'cloze',
      topic: 'Topic',
      objective: 'Recall',
      prompt: 'First {{b1}} then {{b2}}.',
      hint: 'Check order.',
      explanation: 'Alpha comes before beta.',
      misconception: 'Not reversed.',
      citations: [{ sourceId: 's1-p5', quote: 'Alpha beta is the answer.' }],
      cloze: { text: 'First {{b1}} then {{b2}}.', answers: [{ id: 'b1', value: 'alpha' }, { id: 'b2', value: 'beta' }] },
    }],
  };
  const served = await serve(t, (s) => {
    s.sources.push({ id: 's1-p5', title: 'Notes · p. 5', format: 'pdf', document: { id: 'doc1', format: 'pdf', bookTitle: 'Notes', page: 5 }, text: 'Alpha beta is the answer.' });
    s.decks.push(clozeDeck);
  });
  if (!served) return;
  const { server, browser } = served;
  await previewCall(server, 'settings.practice.set', { patch: { autopilot: false, debrief: false } });
  await previewCall(server, 'review.start', { mode: 'path', fresh: true, scope: [{ deckId: 'cloze-src', cardId: 'clz-1' }] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); });
  await page.goto(server.url);
  await page.getByRole('button', { name: '继续 Cloze Source Flow' }).first().click();
  await page.locator('.cloze-blank--input').first().waitFor({ timeout: 30000 });
  // Focus card (not input), Enter -> jumps to first empty blank; Esc -> returns to card; h -> hint works.
  await page.locator('.question-card').click();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '第 1 个空');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('question-card')), true);
  await page.keyboard.press('h');
  await page.locator('.hint').waitFor();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '第 1 个空');
  await page.keyboard.type('alpha');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '第 2 个空');
  await page.keyboard.type('beta');
  await page.keyboard.press('Enter');
  await page.locator('.cloze-right').first().waitFor({ timeout: 15000 });
  await nextButton(page).click();
  await page.locator('.result-page').waitFor({ timeout: 30000 });
  // All answers are correct, so the result initially folds the look-back.
  const lookBackSummary = page.locator('details.round-look-back:not([open]) > summary');
  await lookBackSummary.click();
  const row = page.locator('.round-look-back .look-back__row').first();
  await row.locator('.look-back__line').click();
  const panel = row.locator('.look-back__panel');
  await panel.locator('.citation-disclosure').waitFor();
  await panel.getByRole('button', { name: /打开出处「Notes」第 5 页/ }).click();
  await page.locator('dialog[open]').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => /Alpha beta is the answer\./.test(document.querySelector('dialog[open]')?.innerText || ''), undefined, { timeout: 15000 });
  assert.deepEqual(errors, []);
  await context.close();
});

test('Slice 1 practice controls: multi-choice clear, cloze Shift+Enter, open draft, flashcard cues, long footer, thumb Esc, assist append/Esc, RoundPending roving/filter, RoundEndConfirm (#1,#3,#5,#31-#40)', { timeout: 600000 }, async (t) => {
  const mixedDeck = {
    id: 'slice1-mix',
    title: 'Slice 1 Mix',
    course: 'Course',
    cards: [
      { id: 'm1', kind: 'multi', multiple: true, topic: 'Multi', objective: 'O', prompt: 'Pick two options.', hint: 'Hint', explanation: 'Long '.repeat(80), misconception: 'M', citations: [],
        options: [{ id: 'a', text: 'Alpha', correct: true, explanation: 'Right A' }, { id: 'b', text: 'Beta', correct: true, explanation: 'Right B' }, { id: 'c', text: 'Gamma', correct: false, explanation: 'Wrong C' }] },
      { id: 'cl2', kind: 'cloze', topic: 'Cloze', objective: 'O', prompt: 'One {{b1}} and two {{b2}}.', hint: 'H', explanation: 'Cloze explanation.', misconception: 'M', citations: [],
        cloze: { text: 'One {{b1}} and two {{b2}}.', answers: [{ id: 'b1', value: 'one' }, { id: 'b2', value: 'two' }] } },
      { id: 'op1', kind: 'open', topic: 'Open', objective: 'O', prompt: 'Explain why idempotency matters.', hint: 'H', explanation: 'Reference open explanation.', misconception: 'M', citations: [], options: [] },
      { id: 'fl1', kind: 'flashcard', topic: 'Flash', objective: 'O', prompt: 'Front side question?', answer: 'Back side answer.', hint: 'H', explanation: 'Flash explanation.', misconception: 'M', citations: [], options: [] },
    ],
  };
  const served = await serve(t, (s) => { s.decks.push(mixedDeck); });
  if (!served) return;
  const { server, browser } = served;
  await previewCall(server, 'settings.practice.set', { patch: { autopilot: false, debrief: false } });
  await previewCall(server, 'review.start', { mode: 'path', fresh: true, scope: [{ deckId: 'slice1-mix' }] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); });
  await page.goto(server.url);
  await page.getByRole('button', { name: '继续 Slice 1 Mix' }).first().click();
  await page.locator('.question-card').waitFor({ timeout: 30000 });

  // #1 & #31: Multi-choice selection hint, 0/Backspace clear, 清空 link.
  await page.locator('.option', { hasText: 'Alpha' }).click();
  assert.match(await page.locator('.submit-hint').innerText(), /已选 1 项 · 按 Enter 提交/);
  await page.locator('.submit-clear').waitFor();
  await page.locator('.question-card').focus();
  await page.keyboard.press('0');
  assert.equal(await page.locator('.submit-hint').count(), 0, '0 clears selected choices');
  await page.locator('.option', { hasText: 'Alpha' }).click();
  await page.locator('.submit-clear').click();
  assert.equal(await page.locator('.submit-hint').count(), 0, '清空 link clears selection');
  await page.locator('.option', { hasText: 'Alpha' }).click();
  await page.keyboard.press('Backspace');
  assert.equal(await page.locator('.submit-hint').count(), 0, 'Backspace clears selection');

  // #38: ThumbFeedback tray hint + Escape closes & stops propagation & focuses .question-card.
  await page.locator('.question-card').focus();
  await page.keyboard.press('b');
  await page.locator('.thumb-tray').waitFor();
  assert.match(await page.locator('.thumb-tray__keys').innerText(), /按 1–7 选标签，Esc 收起/);
  await dismissAfterOverlay(page, page.locator('.thumb-tray'), { externalInput: true });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('question-card')), true, 'Esc restores focus to .question-card');

  // Answer multi-choice & check #39 long explanation footer collapse/expand.
  await page.locator('.option', { hasText: 'Alpha' }).click();
  await page.locator('.option', { hasText: 'Beta' }).click();
  await page.locator('.submit-answer').click();
  await page.locator('.explanation-foot').waitFor({ timeout: 15000 });
  assert.match(await page.locator('.explanation-foot').innerText(), /收起解析 \(H\)/);
  assert.doesNotMatch(await page.locator('.explanation-foot').innerText(), /下一题/);
  await page.locator('.explanation-foot').getByRole('button', { name: /收起解析/ }).click();
  await page.locator('.explanation-collapsed').waitFor();
  await page.locator('.question-card').focus();
  await page.keyboard.press('h');
  await page.locator('.explanation-foot').waitFor();

  // #5: skip Q1? Q1 is already answered; let's go to Q2 (Cloze) and test #32, then skip Q2 later or test RoundPending at 420px!
  await nextButton(page).click();
  await page.locator('.cloze-blank--input').first().waitFor();

  // #32: Cloze filled count + Shift+Enter back navigation.
  await page.locator('.cloze-blank--input').nth(0).fill('one');
  assert.match(await page.locator('.submit-hint').innerText(), /已填 1\/2 空/);
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '第 2 个空');
  await page.keyboard.press('Shift+Enter');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '第 1 个空');
  // Skip cl2 with K before moving to open card so Q2 becomes skipped unanswered!
  await page.keyboard.press('Escape');
  await page.keyboard.press('k');

  // #33: Open answer char hint, Esc blur to card, Ctrl+Enter reveal.
  await page.waitForFunction(() => /Explain why idempotency matters/.test(document.querySelector('.question-card')?.innerText || ''));
  const responseBox = page.locator('.response-label textarea');
  await responseBox.fill('Prevent duplicate side effects.');
  assert.match(await page.locator('.response-hint').innerText(), /\d+ 字 · Ctrl\+Enter 看答案/);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('question-card')), true, 'Esc blurs open draft to card');
  await responseBox.focus();
  await page.keyboard.press('Control+Enter');
  await page.locator('.grading .grade').first().waitFor();
  await page.locator('.grade').nth(4).click();

  // #35: Self-grading op1 advances directly to fl1; flashcard front/back cue + 0-5 grading works on front side too!
  await page.waitForFunction(() => /Front side question\?/.test(document.querySelector('.question-card')?.innerText || ''));
  await page.locator('.flip-control').click();
  await page.locator('.grading-side-cue').waitFor();
  assert.match(await page.locator('.grading-side-cue').innerText(), /按 Space 可翻回正面核对题干/);
  await page.locator('.question-card').focus();
  await page.keyboard.press(' ');
  assert.match(await page.locator('.grading-side-cue').innerText(), /正在看正面题干 · 按 Space 回背面/);
  await page.keyboard.press('4');
  // Grading fl1 advances directly to the remaining skipped cl2.
  await page.locator('.cloze-blank--input').first().waitFor();

  // #36 & #37 at 420px: RoundPending shows skipped cl2, 只看未答 toggle, arrow roving focus; RoundEndConfirm mounts focus + Esc + Enter block!
  await page.setViewportSize({ width: 420, height: 900 });
  await page.locator('.round-pending__trigger').click();
  await page.locator('.round-pending__panel').waitFor();
  assert.equal(await page.locator('.round-pending__item[data-skipped="true"]').count(), 1, 'skipped cl2 marked in RoundPending');
  assert.equal(await page.locator('.round-pending__item').count(), 4);
  const firstPending = page.locator('.round-pending__item').first();
  await firstPending.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement?.innerText?.trim().startsWith('2')), true, 'ArrowRight roves focus');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement?.innerText?.trim().startsWith('4')), true, 'End focuses last pending item');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement?.innerText?.trim().startsWith('1')), true, 'Home focuses first pending item');
  await page.getByRole('button', { name: '只看未答' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.round-pending__item').length === 1);
  assert.equal(await page.locator('.round-pending__item').count(), 1, '只看未答 filters to unanswered cl2');
  await page.locator('.round-pending__trigger').click(); // close popover

  // #37: RoundEndConfirm focus + Enter blocked behind confirm + Esc cancels back to card.
  await chooseMore(page, /到此为止…/);
  await page.locator('.round-end-confirm').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.innerText?.trim()), '接着做', 'cancel button receives mount focus');
  await page.locator('.question-card').focus();
  const cardBefore = await page.locator('.question-card').innerText();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('.round-end-confirm').count(), 1, 'Enter blocked while end confirm open');
  assert.equal(await page.locator('.question-card').innerText(), cardBefore);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.round-end-confirm').count(), 0, 'Escape closes end confirm');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('question-card')), true, 'Escape returns focus to card');

  assert.deepEqual(errors, []);
  await context.close();
});

test('RetellPanel (#3, #4), ExplanationFollowup (#3, #25), and QuestionRun assist form (#3, #40) in browser', { timeout: 60000 }, async (t) => {
  const { build: esbuild } = await import('esbuild');
  const compBundle = await esbuild({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import RetellPanel from './ui/review/RetellPanel.jsx';
    import ExplanationFollowup from './ui/ExplanationFollowup.jsx';
    import QuestionRun from './ui/review/QuestionRun.jsx';
    import { StudyServicesContext } from './ui/study-context.jsx';
    import { setUiLanguage } from './ui/i18n.js';
    setUiLanguage('zh');
    window.__calls = [];
    window.__assists = [];
    window.__retellClosed = 0;
    function App() {
      const [showRetell, setShowRetell] = React.useState(true);
      const call = async (op, args) => {
        window.__calls.push([op, args]);
        if (op === 'teach.retell') return { right: ['Point A'], missed: ['Missed B'], wrong: [] };
        if (op === 'card.followup.suggest') return { questions: ['Why?'] };
        if (op === 'card.followup') return { item: { id: 'f-new', question: args.question, answer: 'Because.' } };
        return {};
      };
      const services = React.useMemo(() => ({
        call, act: async () => {}, busy: false, notify() {}, askInChat() {}, host: {}, openSettings() {}, navigate() {}, openModal() {},
      }), []);
      const session = {
        run: { id: 'r1', deckId: 'd1', index: 0, total: 1, mode: 'path', complete: false, revealed: false, feedback: null, solution: null,
          position: { last: true }, navigation: [{ index: 0, answered: false, level: 'new' }],
          card: { id: 'q1', kind: 'quiz', topic: 'T', prompt: 'Stem?', options: [{ id: 'a', text: 'Yes' }] } },
        entry: { selected: [], hint: false, explain: false, response: '', clozeValues: {}, teaching: null, teachAnswer: '' },
        showBack: false, showEn: false, enBusyKey: '', keyGrade: null, teachingBusy: false, autopilot: false, choice: true, isCloze: false, rubricCard: false,
        actions: {
          reviewAct() {}, choose() {}, clearChoice() {}, flipCard() {},
          assistCard: async (...args) => { window.__assists.push(args); return true; },
          slayCard() {}, studyPrerequisites() {}, teachingAct() {}, toggleEn() {}, toggleHelp() {}, setResponse() {}, setClozeValue() {}, setTeachAnswer() {},
          closeShortcutHelp() {}, showExplanation() {}, toggleAutopilot() {}, skipQuestion() {}, askEnd() {},
        },
      };
      const data = {
        root: 'r1', sources: [], decks: [], model: { ready: true },
        settings: { practice: { fixPhrases: ['选项有歧义', '解析不完整'] } },
        assist: [{
          id: 't-run', status: 'running', mode: 'ask', cardId: 'q1',
          choices: ['plain', 'angle'], question: 'Why does retry amplify load?',
          text: ${JSON.stringify(`${PLAIN_HELP_REQUEST}；换一种解释角度，指出关键概念之间的关系；Why does retry amplify load?`)},
        }],
      };
      return (
        <StudyServicesContext.Provider value={services}>
          <div className="study-app">
            <QuestionRun session={session} data={data} shellTitle="练习" feedback={null} coachProps={null} links={{}} context={{}} />
            <div className="standalone-extras" tabIndex={-1}>
              {showRetell && (
                <RetellPanel
                  op="teach.retell"
                  args={{ cardId: 'q1' }}
                  draftKey="r1:q1"
                  model={{ ready: true }}
                  onDone={() => {}}
                  onClose={() => { window.__retellClosed++; setShowRetell(false); }}
                />
              )}
              <ExplanationFollowup
                run={{ id: 'r1', deckId: 'd1', card: { id: 'q1' }, solution: { followups: [{ id: 'f1', question: 'Q1?', answer: 'A1' }] } }}
                noteQa={{ savedIn: () => 'n1', onSave() {}, onOpen() {} }}
                cardNotes={[{ noteId: 'n1', title: '笔记A', followupIds: ['f1', 'f2'] }]}
              />
            </div>
          </div>
        </StudyServicesContext.Provider>
      );
    }
    createRoot(document.getElementById('root')).render(<App />);
  `, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    skipMissingChromium(t, error); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://test.local/**', (route) => route.fulfill({ contentType: 'text/html', body: '<main id="root"></main>' }));
  await page.goto('http://test.local/');
  await page.addStyleTag({ content: globalCss() });
  await page.addScriptTag({ content: compBundle.outputFiles[0].text });

  // Assist status summarizes chips instead of raw PLAIN_HELP_REQUEST prompt (#U3).
  const statusText = await page.locator('.assist-status__text').innerText();
  assert.match(statusText, /通俗详解 · 换个角度讲 · Why does retry amplify load\?/);
  assert.doesNotMatch(statusText, /贴近生活的比喻/);

  // Help form layout (#U1, #U2): no empty 44px feedback hole, unified -1px outlineOffset, zero horizontal overflow.
  await page.locator('[data-tour="review-help"]').click();
  await page.locator('.assist-form__input').waitFor();
  const holeHeight = await page.locator('.assist-form .action-feedback-slot').evaluate((el) => el.getBoundingClientRect().height);
  assert.equal(holeHeight, 0, 'empty feedback slot inside assist form collapses to 0px');
  await page.locator('.assist-actions').getByRole('button', { name: '取消' }).focus();
  const assistInput = page.locator('.assist-form__input');
  const controls = await page.locator('.assist-form').locator('button, input, textarea, select, a').count();
  for (let step = 0; step < controls; step++) {
    await page.keyboard.press('Shift+Tab');
    if (await assistInput.evaluate(el => document.activeElement === el)) break;
    assert.ok(await page.locator('.assist-form').evaluate(form => form.contains(document.activeElement)), 'backward keyboard navigation stays in the form until it reaches the answer field');
  }
  const focusStyle = await page.locator('.assist-form__input').evaluate((el) => ({
    active: document.activeElement === el,
    outlineOffset: window.getComputedStyle(el).outlineOffset,
  }));
  assert.equal(focusStyle.active, true, 'Shift+Tab reaches textarea');
  assert.equal(focusStyle.outlineOffset, '-1px', 'single unified focus ring on textarea');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow at 1280px');
  await page.locator('.assist-actions').getByRole('button', { name: '取消' }).click();

  // QuestionRun .assist-form (#3 & #40): append fix phrases, 清空, IME guard, empty Esc collapse restoring focus, Ctrl+Enter submit.
  await page.locator('[data-tour="review-improve"]').click();
  await page.locator('.assist-form__input').waitFor();
  await page.getByRole('button', { name: '选项有歧义', exact: true }).click();
  await page.getByRole('button', { name: '解析不完整', exact: true }).click();
  assert.equal(await page.locator('.assist-form__input').inputValue(), '选项有歧义；解析不完整');
  await page.getByRole('button', { name: '解析不完整', exact: true }).click();
  assert.equal(await page.locator('.assist-form__input').inputValue(), '选项有歧义；解析不完整', 'duplicate phrase not appended twice');
  await page.locator('.assist-actions').getByRole('button', { name: '清空' }).click();
  assert.equal(await page.locator('.assist-form__input').inputValue(), '');
  await page.locator('.assist-form__input').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.assist-form__input').count(), 0, 'empty Esc collapses assist form');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-tour')), 'review-improve', 'focus returns to trigger');
  await page.locator('[data-tour="review-improve"]').click();
  await page.locator('.assist-form__input').fill('Fix stem wording');
  await page.evaluate(() => {
    const el = document.querySelector('.assist-form__input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
    const legacy = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true });
    Object.defineProperty(legacy, 'keyCode', { value: 229 });
    el.dispatchEvent(legacy);
  });
  assert.equal(await page.evaluate(() => window.__assists.length), 0, 'IME Enter ignored in assist form');
  await page.locator('.assist-form__input').focus();
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => window.__assists.length === 1);
  assert.equal(await page.evaluate(() => window.__assists[0][0]), 'improve');

  // RetellPanel: IME Ctrl+Enter ignored, real Ctrl+Enter submits, 对照漏点再补一句 restores & focuses textarea, empty Esc closes.
  const retellInput = page.locator('.retell-panel__input');
  await retellInput.fill('First retell draft');
  await page.evaluate(() => {
    const el = document.querySelector('.retell-panel__input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
    const legacy = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true });
    Object.defineProperty(legacy, 'keyCode', { value: 229 });
    el.dispatchEvent(legacy);
  });
  assert.equal(await page.evaluate(() => window.__calls.filter(([op]) => op === 'teach.retell').length), 0, 'IME Enter ignored in RetellPanel');
  await retellInput.focus();
  await page.keyboard.press('Control+Enter');
  await page.locator('.retell-result__restore').waitFor();
  assert.equal(await retellInput.inputValue(), '');
  // Focus the button as a press does, then click: the draft must hold focus when the click returns, not a frame later (the button unmounts).
  assert.equal(await page.evaluate(() => {
    const restore = document.querySelector('.retell-result__restore');
    restore.focus();
    restore.click();
    return document.activeElement?.classList.contains('retell-panel__input');
  }), true, '对照漏点再补一句 moves focus to the draft within the click');
  assert.equal(await retellInput.inputValue(), 'First retell draft');
  await page.locator('.retell-panel__input:focus').waitFor();
  await page.keyboard.press('End');
  await page.keyboard.insertText(' continued');
  assert.equal(await retellInput.inputValue(), 'First retell draft continued', 'typing continues in the restored draft');
  await retellInput.fill('');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => window.__retellClosed), 1);

  // ExplanationFollowup: open ask -> custom ask -> IME ignored -> empty Esc restores trigger focus -> type & Ctrl+Enter submits.
  await page.getByRole('button', { name: '追问？' }).click();
  await page.getByRole('button', { name: '你的疑问' }).click();
  const fuInput = page.locator('.followup-picker__input');
  await fuInput.focus();
  await page.locator('.followup-picker__actions').getByRole('button', { name: '取消' }).click();
  assert.equal(await page.locator('.followup-picker__input').count(), 0, 'cancel closes custom followup form');
  assert.equal(await page.evaluate(() => /你的疑问/.test(document.activeElement?.innerText || '')), true, 'cancel returns focus to custom trigger');
  await page.getByRole('button', { name: '你的疑问' }).click();
  await fuInput.focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.followup-picker__input').count(), 0, 'empty Esc collapses custom followup input');
  assert.equal(await page.evaluate(() => /你的疑问/.test(document.activeElement?.innerText || '')), true, 'focus returns to custom trigger');
  await page.getByRole('button', { name: '你的疑问' }).click();
  await fuInput.fill('Custom followup question?');
  await page.evaluate(() => {
    const el = document.querySelector('.followup-picker__input');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
    const legacy = new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true });
    Object.defineProperty(legacy, 'keyCode', { value: 229 });
    el.dispatchEvent(legacy);
  });
  assert.equal(await page.evaluate(() => window.__calls.filter(([op]) => op === 'card.followup').length), 0, 'IME ignored in ExplanationFollowup');
  await fuInput.focus();
  await page.keyboard.press('Control+Enter');
  await page.waitForFunction(() => window.__calls.filter(([op]) => op === 'card.followup').length === 1);
  assert.match(await page.locator('.explanation-followup').innerHTML(), /已存进「笔记A」（含 2 条问答）/);
  assert.deepEqual(errors, []);
});
