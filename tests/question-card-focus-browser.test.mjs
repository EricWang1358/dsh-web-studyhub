/* global document getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';

/* The question card takes focus from the program (Esc out of the source column puts the learner back at the question; the card is tabindex -1, never a Tab stop).
   After keyboard use the browser then drew its own heavy near-black ring around the whole card. The card draws no ring of its own; the controls inside it, which a
   learner does reach with Tab, keep theirs. Screenshots go to QUESTION_CARD_FOCUS_SHOTS when set. */

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update(state => {
    state.decks.push({ id: 'd1', title: 'Voice 2', course: 'Distributed systems', folder: '', cards: [1, 2, 3, 4].map(n => ({ id: `c${n}`, kind: 'choice', topic: 'T', objective: `Obj ${n}`,
      prompt: `Choice ${n}: which one is right?`, answer: 'A', hint: 'hint', explanation: 'Because.', misconception: '', citations: [],
      options: [{ id: 'a', text: 'Alpha', correct: true, explanation: 'yes' }, { id: 'b', text: 'Beta', correct: false }, { id: 'c', text: 'Gamma', correct: false }],
      review: { repetitions: 0, interval: 0, easiness: 2.5, due_at: '2026-10-01T00:00:00.000Z', last_grade: null, lapses: 0 } })) });
  });
  await service.call('review.start', { mode: 'path', scope: [1, 2, 3, 4].map(n => ({ deckId: 'd1', cardId: 'c' + n })), fresh: true });
  await service.dispose();
}

test('the question card takes program focus without a ring; the controls inside keep theirs (1280 and 420 px)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-card-focus-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.QUESTION_CARD_FOCUS_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 800 });
      await context.addInitScript(() => { try { localStorage.setItem('study-autopilot', 'off'); } catch { /* blocked */ } });
      await page.goto(running.server.url);
      await page.getByRole('button', { name: '接着做' }).first().click({ timeout: 30000 });
      await page.locator('.question-card').waitFor({ timeout: 30000 });
      await settleAnimations(page);
      // Keyboard use first, so the browser is in keyboard modality when the program moves focus.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      const ringOf = () => page.evaluate(() => {
        const active = document.activeElement, style = getComputedStyle(active);
        return { tag: active.className, visible: active.matches(':focus-visible'), outline: style.outlineStyle, width: style.outlineWidth, shadow: style.boxShadow };
      });
      const tabbed = await ringOf();
      assert.equal(tabbed.visible, true, `${width}px: Tab puts focus on a control: ${JSON.stringify(tabbed)}`);
      assert.ok(tabbed.outline !== 'none' || tabbed.shadow !== 'none', `${width}px: a control reached by Tab shows its focus ring: ${JSON.stringify(tabbed)}`);
      await page.evaluate(() => document.querySelector('.question-card').focus({ preventScroll: true }));
      const card = await ringOf();
      assert.match(card.tag, /question-card/, `${width}px: the card has the focus`);
      assert.equal(card.outline, 'none', `${width}px: the card draws no outline: ${JSON.stringify(card)}`);
      if (shots) await page.screenshot({ path: join(shots, `question-card-focus-${width}.png`) });
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
