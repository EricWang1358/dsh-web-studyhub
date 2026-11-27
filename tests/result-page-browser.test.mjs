/* global document, window, localStorage -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium, skipMissingChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { until } from '../scripts/qa/layout-late.mjs';

/* The result page of a round of the sample course with wrong answers, in the browser preview with the fake model.
   #1687: the one filled button practises the wrong questions; the page's next step is a plain button after it.
   #1688: 本轮题目 comes right after the score and the next step (before the 点评, the seal card and 今日学习总结), so at 1440×900 the score and the first
   wrong row are on the first screen; its header keeps 重练错题 and nothing else beside it (the other tools are a quieter row under it). */

/** Answers the round through the host, every third question wrong, and stops on its last question answered, so the page opens it and the learner ends it. */
async function answerAlmostAll(api) {
  const deck = await api('deck.get', { id: 'sample-deck-patterns' });
  const byId = new Map(deck.cards.map((card) => [card.id, card]));
  let run = await api('review.start', { deckId: 'sample-deck-patterns', mode: 'path', fresh: true });
  for (let step = 0; step < 40 && !run.complete; step++) {
    const card = byId.get(run.card.id), wrong = step % 3 === 0;
    if (card.kind === 'flashcard') {
      await api('review.reveal', { runId: run.id, cardId: card.id });
      run = await api('review.answer', { runId: run.id, cardId: card.id, grade: wrong ? 2 : 4 });
    } else if (card.kind === 'quiz') {
      run = await api('review.answer', { runId: run.id, cardId: card.id, selected: [card.options.find((option) => !!option.correct !== !wrong).id] });
    } else {
      run = await api('review.answer', { runId: run.id, cardId: card.id, answers: {} });
    }
    if ((run.navigation || []).every((stop) => stop.answered)) return run;
    run = await api('review.move', { runId: run.id, direction: 1 });
  }
  return run;
}

test('#1687 #1688: a round with wrong answers ends on 重练这 N 道错题 and 本轮题目 right under the score, both on the first screen at 1440×900', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { skipMissingChromium(t, error); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-result-page-'));
  const dist = join(base, 'dist');
  await buildPreview({ outdir: dist });
  const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0,
    model: createFakeModel({ latencyMs: 20 }), distDir: dist });
  t.after(async () => {
    await browser.close();
    await server.close();
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const api = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: 'zh' });
  await api('sample.load', { language: 'zh' });
  await answerAlmostAll(api);

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  await context.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); } catch { /* blocked */ } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  try {
    await page.goto(server.url);
    await page.getByRole('button', { name: /^回到题目/ }).first().click();
    // The last question is answered: its 完成 / 下一题 ends the round (a re-ask on the way is graded 4).
    await until(async () => {
      if (await page.locator('.result-page').count()) return true;
      if (await page.locator('button[aria-label*="分："]').count()) await page.keyboard.press('4');
      const next = page.locator('main button:not([disabled])').filter({ hasText: /^\s*(下一题|完成)/ });
      if (await next.count()) await next.first().click().catch(() => {});
      await new Promise((done) => setTimeout(done, 300));
      return false;
    }, 'the result page', { timeoutMs: 30000 });
    await page.locator('.round-look-back .look-back__row').first().waitFor({ timeout: 20000 });
    await page.locator('[data-testid="round-seal-section"]').waitFor({ timeout: 20000 }).catch(() => {});

    // #1687: one filled button on the page, and it practises the wrong ones.
    const filled = await page.locator('.result-page .sh-btn--primary').allInnerTexts();
    assert.equal(filled.length, 1, `one filled button (${JSON.stringify(filled)})`);
    assert.match(filled[0].trim(), /^重练这(?: \d+ 道|道)错题$/);
    assert.equal(await page.locator('.result-next .sh-btn--primary').count(), 1, 'it is the first button of the next-step row');

    // #1688: the order, and the first screen.
    const layout = await page.evaluate(() => {
      const scroller = document.querySelector('.study-app');
      if (scroller) scroller.scrollTop = 0;
      const top = (selector) => { const element = document.querySelector(selector); return element ? Math.round(element.getBoundingClientRect().top) : null; };
      const firstRow = document.querySelector('.round-look-back .look-back__row')?.getBoundingClientRect();
      return { vh: window.innerHeight, next: top('.result-next'), list: top('.round-look-back'), coach: top('.coach-debrief'), seal: top('[data-testid="round-seal-section"]'),
        recap: top('.daily-recap'), score: Math.round(document.querySelector('.result-headline')?.getBoundingClientRect().bottom ?? -1),
        firstRowBottom: Math.round(firstRow?.bottom ?? -1),
        tools: [...document.querySelectorAll('.round-look-back__tools button')].map((button) => button.innerText.trim()) };
    });
    assert.ok(layout.next < layout.list, `本轮题目 under the next step (${JSON.stringify(layout)})`);
    for (const later of ['coach', 'seal', 'recap']) if (layout[later] !== null) assert.ok(layout.list < layout[later], `本轮题目 above the ${later} (${JSON.stringify(layout)})`);
    assert.ok(layout.score > 0 && layout.score <= layout.vh, `the score is on the first screen (${JSON.stringify(layout)})`);
    assert.ok(layout.firstRowBottom > 0 && layout.firstRowBottom <= layout.vh, `the first wrong row is on the first screen (${JSON.stringify(layout)})`);
    assert.equal(layout.tools.length, 1, `the list's header keeps one action beside it (${JSON.stringify(layout.tools)})`);
    assert.match(layout.tools[0], /^重练这(?: \d+ 道|道)错题$/);
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await context.close(); }
});
