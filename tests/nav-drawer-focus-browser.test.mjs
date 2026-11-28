/* global document -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { startLateServer } from '../scripts/qa/layout-late.mjs';

/* #1679: at 420px (DSH side panel width), entering practice from the navigation drawer via 回到题目
   must hand focus to the question card so Space flips the flashcard instead of reopening the drawer.
   Dismissing the drawer with Escape still returns focus to the topbar menu button. */

async function seedFlashcardRun(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.decks.push({
      id: 'd-flash',
      title: 'Flash Deck',
      course: 'Systems',
      folder: '',
      cards: [
        {
          id: 'fc1',
          kind: 'flashcard',
          topic: 'Memory',
          objective: 'Recall paging',
          prompt: 'What problem does a TLB solve?',
          answer: 'It caches recent virtual-to-physical page translations.',
          hint: 'Think of address translation speed.',
          explanation: 'Avoiding extra page-table walks.',
          misconception: '',
          citations: [],
          review: { repetitions: 0, interval: 0, easiness: 2.5, due_at: '2026-10-01T00:00:00.000Z', last_grade: null, lapses: 0 },
        },
      ],
    });
  });
  await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd-flash', cardId: 'fc1' }], fresh: true });
  await service.dispose();
}

test('420px nav drawer -> 回到题目 (mouse and keyboard): Space flips flashcard; Esc returns focus to menu button (#1679)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-drawer-1679-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: seedFlashcardRun });
  try {
    for (const mode of ['mouse', 'keyboard']) {
      const context = await browser.newContext({ viewport: { width: 420, height: 800 } });
      await context.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); } catch { /* blocked */ } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      try {
        await page.goto(running.server.url);
        const menu = page.locator('.nav-menu-toggle');
        await menu.waitFor({ timeout: 30000 });
        const drawer = page.locator('dialog.nav-drawer');

        if (mode === 'mouse') {
          await menu.click();
          await drawer.waitFor();
          await drawer.locator('.resume-nav').click();
        } else {
          // Dismissing with Esc must still return focus to the menu toggle button.
          await menu.focus();
          await page.keyboard.press('Enter');
          await drawer.waitFor();
          await page.keyboard.press('Escape');
          await drawer.waitFor({ state: 'detached' });
          assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('nav-menu-toggle')), true,
            'Esc closing the drawer must still return focus to the menu button');

          // Reopen and enter practice via keyboard.
          await page.keyboard.press('Enter');
          await drawer.waitFor();
          await drawer.locator('.resume-nav').focus();
          await page.keyboard.press('Enter');
        }

        await drawer.waitFor({ state: 'detached' });
        await page.locator('.question-card').waitFor({ timeout: 30000 });
        const activeInfo = await page.evaluate(() => ({
          className: document.activeElement?.className || '',
          inQuestionCard: Boolean(document.activeElement?.closest?.('.question-card')),
        }));
        assert.doesNotMatch(activeInfo.className, /nav-menu-toggle/, `${mode}: focus must leave the menu toggle button`);
        assert.equal(activeInfo.inQuestionCard, true, `${mode}: focus must land on the question card (${JSON.stringify(activeInfo)})`);

        // Pressing Space should flip the flashcard and reveal the 0-5 grade buttons, not reopen the drawer.
        await page.keyboard.press('Space');
        await page.locator('.grade-scale .grade').first().waitFor({ timeout: 10000 });
        assert.equal(await drawer.count(), 0, `${mode}: Space must not reopen the navigation drawer`);
        assert.equal(await page.locator('.grade-scale .grade').count(), 6, `${mode}: Space must flip the flashcard to show 6 grade buttons`);
        assert.deepEqual(errors, [], `${mode}: no page errors`);
      } finally {
        await context.close().catch(() => {});
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await running.close();
    await rm(dist, { recursive: true, force: true });
  }
});
