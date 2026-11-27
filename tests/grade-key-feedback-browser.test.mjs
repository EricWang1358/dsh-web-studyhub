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
  // Each outcome group has three equal cells. The two groups can stack on a narrow study surface.
  const groups = page.locator('.grade-group');
  assert.equal(await groups.count(), 2);
  for (const group of await groups.all()) {
    const boxes = await group.locator('.grade').evaluateAll(els => els.map(el => {
      const box = el.getBoundingClientRect(), cell = el.parentElement.getBoundingClientRect();
      return { top: box.top, height: box.height, width: box.width, cellWidth: cell.width };
    }));
    assert.equal(boxes.length, 3, 'three grades per outcome group');
    for (const box of boxes) {
      assert.ok(Math.abs(box.top - boxes[0].top) <= 1, 'one row within each group');
      assert.ok(Math.abs(box.height - boxes[0].height) <= 1, 'equal button heights');
      assert.ok(box.width > 0 && Math.abs(box.width - boxes[0].width) <= 1, 'equal columns');
      assert.ok(Math.abs(box.width - box.cellWidth) <= 1, 'the button fills its anchor');
    }
  }
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
  await page.waitForFunction(() => /Question 2\?/.test(document.querySelector('.flashcard')?.innerText || ''), null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => window.__gradePress), '4', 'the button the 4 key named wore its press');
  assert.deepEqual(errors, []);
});
