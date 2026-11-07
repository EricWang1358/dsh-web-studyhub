/* global localStorage, document, window, MutationObserver */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

// #745: a 0-5 key answers from the session's key handler, so no <button> is ever clicked and nothing shows the press. The button the key named
// takes it for a moment now, and the shortcut words moved from a title attribute to the shared tooltip.

const card = (id, n) => ({ id, kind: 'flashcard', topic: 'Topic', objective: 'Recall', prompt: `Question ${n}?`, answer: `Answer ${n}`, hint: '',
  explanation: 'Because.', misconception: '', citations: [] });

async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'grade-key-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update((s) => { s.decks.push({ id: 'd1', title: 'First', cards: [1, 2, 3, 4, 5, 6].map((n) => card(`c${n}`, n)) }); });
  return { root, service };
}

test('in the browser: a 0-5 key makes its own button look pressed, and the shortcut is a tooltip, not a title (#745)', { timeout: 600000 }, async (t) => {
  const { root, service } = await library(t);
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'en'); localStorage.setItem('study-autopilot', 'off'); });
  await page.goto(server.url);
  await page.getByRole('button', { name: 'Start studying First' }).first().click();
  await page.locator('.flashcard').waitFor();
  await page.locator('.flip-control').click();
  await page.locator('.grade-scale').waitFor();
  const grades = page.locator('.grade');
  assert.equal(await grades.count(), 6, 'the 0-5 scale');
  assert.equal(await grades.nth(4).getAttribute('title'), null, 'no title attribute on a grade button');
  assert.equal(await grades.nth(4).getAttribute('aria-keyshortcuts'), '4', 'the key is still announced on the button');
  // The tooltip's anchor is the grid cell (#745): the buttons must still be six equal columns on one row, not content-width boxes.
  const boxes = await grades.evaluateAll((els) => els.map((el) => { const box = el.getBoundingClientRect(); return { top: Math.round(box.top), height: Math.round(box.height), width: Math.round(box.width) }; }));
  assert.equal(new Set(boxes.map((box) => box.top)).size, 1, 'one row');
  assert.equal(new Set(boxes.map((box) => box.height)).size, 1, 'one height');
  assert.ok(Math.max(...boxes.map((box) => box.width)) - Math.min(...boxes.map((box) => box.width)) <= 1, 'equal columns');
  assert.ok(Math.min(...boxes.map((box) => box.width)) > 80, 'each button fills its cell');
  // The words come from the shared tooltip, on hover, in the top layer so the card cannot clip them.
  await grades.nth(4).hover();
  const tip = page.locator('.grade-tip').nth(4).locator('[role="tooltip"]');
  await tip.waitFor({ state: 'visible', timeout: 10000 });
  assert.match(await tip.innerText(), /Shortcut 4/, 'the tooltip names the key and the grade');
  // Watch for the press before pressing: it lasts a moment, and the answer takes the whole scale away.
  await page.evaluate(() => {
    window.__gradePress = '';
    const watch = new MutationObserver(() => {
      const pressed = document.querySelector('.grade.is-key-pressed');
      if (pressed) window.__gradePress = pressed.getAttribute('aria-keyshortcuts');
    });
    watch.observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    setTimeout(() => watch.disconnect(), 15000);
  });
  await page.keyboard.press('4');
  await page.locator('.next-due').waitFor({ timeout: 20000 });
  assert.equal(await page.evaluate(() => window.__gradePress), '4', 'the button the 4 key named wore its press');
  assert.deepEqual(errors, []);
});
