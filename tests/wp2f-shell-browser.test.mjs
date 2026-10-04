/* global localStorage, document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

// UI wave 2 · WP-F in a real browser: the dialogs own focus and Escape (#73), the flag save is a footer action (#74), the board's
// undo goes through the one toast region and is held while hovered (#90), the keyboard and the nav menu still work.
test('the composed shell: shortcut sheet over a dialog, the flag save, the 更多 menu, the board undo toast', { timeout: 150000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'wp2f-shell-'));
  const service = new StudyService(join(root, 'library'));
  const card = id => ({ id, kind: 'flashcard', topic: 'Topic', objective: 'Recall', prompt: `Question ${id}`, answer: 'Answer', hint: '', explanation: '', misconception: '', citations: [] });
  await service.store.update(s => { s.decks.push({ id: 'deck', title: 'Only deck', cards: [card('a'), card('b')] }); });
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await service.dispose(); await rm(root, { recursive: true, force: true }); });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'en'); localStorage.setItem('study-autopilot', 'off'); });
  await page.goto(server.url);

  // Practice: the session hook drives the page (space flips, grading keys answer).
  await page.locator('[data-usage="nav.resume"]').click();
  await page.locator('.question-card').waitFor();
  await page.keyboard.press('Space');
  await page.locator('.grading').waitFor();

  // #73: the shortcut sheet is open, then the flag dialog opens over it; focus is in the dialog and one Escape closes only the dialog.
  await page.keyboard.press('Shift+Slash');
  await page.locator('.shortcut-sheet').waitFor();
  await page.getByRole('button', { name: 'Flag question' }).click();
  const dialog = page.locator('dialog[open]');
  await dialog.waitFor();
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'focus is inside the flag dialog, not in the inert sheet');
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    // A native modal makes everything else inert: focus is in the dialog or, for a moment, in the browser's own chrome (the body), never in the page behind.
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement) || document.activeElement === document.body), true, 'Tab never lands on the page behind the dialog');
  }
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.shortcut-sheet').count(), 0, 'the press on the flag button had already dismissed the sheet, and nothing is left open');
  assert.equal(await page.locator('.question-card').count(), 1, 'one Escape closed the dialog only: the practice page stays');

  // #74: the flag save is the footer's primary Button; saving closes the dialog and says so.
  await page.getByRole('button', { name: 'Flag question' }).click();
  const flag = page.locator('dialog[open]');
  await flag.locator('textarea').fill('Check the source');
  const save = flag.locator('footer').getByRole('button', { name: 'Save flag' });
  assert.match(await save.getAttribute('class'), /sh-btn--primary/);
  await save.click();
  await flag.waitFor({ state: 'detached' });
  await page.getByText('Question flagged for priority review.').waitFor();

  // #79: 更多 is a menu: Enter opens, arrows move, Escape closes and gives focus back to the trigger.
  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menu').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
  assert.equal(await more.evaluate(element => element === document.activeElement), true, 'focus returns to the trigger');

  // #90: the board page draws no toast stack of its own (its undo goes through the app's one region; the hold-on-hover rule of that
  // region is the wave-1 overlay test's).
  await page.locator('[data-tour="nav-board"]').click();
  await page.getByRole('heading', { name: /Tasks/ }).first().waitFor();
  assert.equal(await page.locator('.sh-toasts--page').count() <= 1, true, 'at most one page-level toast stack');
  assert.deepEqual(errors, []);
});
