/* global localStorage, document, innerWidth */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

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
  en: { skip: /Skip for now/, end: /Stop here…/, confirm: 'Stop and see the result', next: 'Next question', resume: (title) => `Continue ${title}`, pending: (n) => `${n} to answer`, closed: 'This session has ended.', unanswered: 'unanswered 1',
    lookBack: 'Questions in this round', showAll: (n) => `Show all ${n} questions`, unansweredNote: /did not answer this question/, left: (n) => `${n} questions are still unanswered` },
};

async function serve(t) {
  const root = await mkdtemp(join(tmpdir(), 'round-controls-browser-'));
  const service = new StudyService(join(root, 'library'));
  await service.store.update((s) => { s.decks.push(...RUNS.map((_, i) => deckOf(i)), { ...deckOf('c'), cards: deckOf('c').cards.slice(0, 2) }); });
  await service.dispose();
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return null; }
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
  // The control: with the same switch on, a round answered to the end does count down on its result page (so the check above is not empty).
  const control = deckOf('c');
  for (const open of (await previewCall(server, 'snapshot', {})).runs || []) await previewCall(server, 'review.end', { runId: open.id });
  await previewCall(server, 'settings.practice.set', { patch: { autopilot: false } });
  await previewCall(server, 'review.start', { mode: 'path', fresh: true, scope: [{ deckId: control.id }] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); });
  await page.goto(server.url);
  await page.getByRole('button', { name: '接着做' }).first().click(); // the home card for the open round
  for (const n of [1, 2]) {
    await page.waitForFunction((k) => new RegExp(`Question number ${k}\\?`).test(document.querySelector('.question-card .question')?.textContent || ''), n);
    await answerRight(page);
    // The switch goes on only for the last step, so the questions themselves do not move on by the countdown (the step reloads the library).
    if (n === 2) await previewCall(server, 'settings.practice.set', { patch: { autopilot: true } });
    await nextButton(page).click();
  }
  await page.locator('.result-page').waitFor({ timeout: 30000 });
  assert.equal(await page.locator('.result-title').innerText(), '这一轮，完成了。');
  await page.locator('.coach-countdown[role="status"]').waitFor({ timeout: 15000 });
  await context.close();
});
