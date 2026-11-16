/* global document, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, seedWrongBookLibrary, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* #1086: switching 待巩固 / 已订正 changes the sentence about the list, never the controls above it. The 课程范围 select and the switch itself
   stay where they are at a desktop and a phone width, and a count in the sentence (a toggle) is as tall as the text line it sits in. */

test('mistakes page: the course select and the view switch do not move between 待巩固 and 已订正 (1440 and 420 px)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-wb-steady-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, lang: 'en', seed: (root) => seedWrongBookLibrary(root, { wrong: 6 }) });
  const store = new Store(join(running.base, 'library'));
  // Three of the six are answered right afterwards: they are the history; three stay.
  await store.update((library) => {
    const deck = library.decks[0];
    deck.cards.slice(0, 3).forEach((card, index) => library.attempts.push({ id: `fixed-${index}`, runId: library.runs[0].id, quiz_id: card.id, deckId: deck.id, topic: card.topic,
      timestamp: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(), grade: 4, elapsed_ms: 3000,
      before: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null }, after: { repetitions: 1, interval_days: 1, ease_factor: 2.5, due_at: null } }));
  });
  try {
    for (const width of [1440, 420]) {
      const { page, errors, context } = await openPage(browser, running, { lang: 'en', width, theme: 'light' });
      await page.goto(running.server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      await (await revealNavRow(page, 'wrongbook')).dispatchEvent('click');
      await page.locator('.wb-views').waitFor({ timeout: 30000 });
      await settleAnimations(page);
      const read = () => page.evaluate(() => {
        const top = (selector) => Math.round(document.querySelector(selector).getBoundingClientRect().top * 10) / 10;
        const toggle = document.querySelector('.wb-count-toggle');
        const line = toggle && parseFloat(getComputedStyle(toggle.parentElement).lineHeight);
        return { select: top('.page-scope'), views: top('.wb-views'), toggleHeight: toggle && Math.round(toggle.getBoundingClientRect().height * 10) / 10, line };
      });
      const weak = await read();
      assert.ok(weak.toggleHeight, `${width}px: the 待巩固 sentence has count toggles`);
      assert.ok(weak.toggleHeight <= weak.line + 1, `${width}px: a count toggle is ${weak.toggleHeight}px tall, its text line ${weak.line}px`);
      await page.locator('.wb-views__seg-item').nth(1).click();
      await until(async () => (await page.locator('.wb').innerText()).includes('Corrected —'), 'the history sentence');
      await settleAnimations(page);
      const history = await read();
      assert.equal(history.select, weak.select, `${width}px: the course select moved ${history.select - weak.select}px between the views`);
      assert.equal(history.views, weak.views, `${width}px: the view switch moved ${history.views - weak.views}px between the views`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
