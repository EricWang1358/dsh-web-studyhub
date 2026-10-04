/* global localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

test('browser calculation flow preserves corrections, mode drafts, reload and edits during checking', { timeout: 90000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-calculation-browser-'));
  const screenshots = process.env.STUDY_CALCULATION_SCREENSHOTS || join(root, 'screenshots');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(screenshots, { recursive: true });
  const quote = 'Distance equals speed multiplied by elapsed time.';
  const rungs = ['conditions', 'formula', 'substitution', 'computation', 'verification'].map((stage, i) => ({
    stage, lesson: `Current relationship ${i}`, check: `Work on stage ${i}`, answer: `Secret scoring reference ${i}`,
    assumptions: 'Constant speed', units: 'Metres and seconds', rounding: 'Round only at the final result',
    citations: [{ sourceId: 'source', quote }],
  }));
  let gate;
  const gradingStarted = Promise.withResolvers();
  const model = async (_system, prompt) => {
    const input = JSON.parse(prompt);
    if (input.learnerAnswer !== undefined) {
      if (input.learnerAnswer === 'right') { gradingStarted.resolve(); await gate; }
      return JSON.stringify({ passed: input.learnerAnswer === 'right', feedback: input.learnerAnswer === 'right' ? 'Continue to the next check' : 'Try checking the time unit' });
    }
    return JSON.stringify({ diagnosis: 'Unit gap', transfer: 'Hidden transfer rule',
      rungs: _system.includes('calculation tutor') ? rungs : [{ lesson: 'Generic current relationship', check: 'Generic check', answer: 'Generic private' }, { lesson: 'Generic future', check: 'Future check', answer: 'Future private' }] });
  };
  const libraryRoot = join(root, 'library');
  const service = new StudyService(libraryRoot);
  await service.store.update(s => {
    s.sources.push({ id: 'source', title: 'Motion', text: quote });
    s.decks.push({ id: 'deck', title: 'Motion', cards: [{ id: 'card', kind: 'flashcard', prompt: 'At 3 m/s for 4 s, how far?', answer: '12 m', explanation: 'Multiply speed by time.', citations: [{ sourceId: 'source', quote }] }] });
  });
  const run = await service.call('review.start', { deckId: 'deck', mode: 'flashcard' });
  await service.call('review.reveal', { runId: run.id, cardId: run.card.id });
  await service.call('review.answer', { runId: run.id, cardId: run.card.id, grade: 2 });
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot, home: join(root, 'home'), port: 0, model, distDir });
  t.after(() => server.close());
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'en'); localStorage.setItem('study-autopilot', 'off'); });
  await page.goto(server.url);
  const resume = () => page.locator('[data-usage="nav.resume"]').click();
  await resume();
  await page.getByRole('button', { name: 'Guided calculation', exact: true }).click();
  const answer = page.getByRole('textbox', { name: 'Answer to the current step' });
  await page.getByRole('heading', { name: 'Known conditions and unknown quantity' }).waitFor();
  assert.equal((await page.locator('.teaching-panel').innerText()).includes('Secret scoring'), false);
  assert.equal((await page.locator('.teaching-panel').innerText()).includes('Work on stage 1'), false);
  assert.equal(await page.locator('.teaching-context dt').count(), 3);
  assert.equal(await page.locator('.teaching-progress').getAttribute('aria-valuenow'), '0');
  await answer.fill('wrong');
  await page.locator('.teaching-panel button.primary').click();
  await page.getByText('Try checking the time unit', { exact: true }).waitFor();
  assert.equal(await answer.inputValue(), 'wrong');
  await page.reload();
  await resume();
  await page.getByRole('heading', { name: 'Known conditions and unknown quantity' }).waitFor();
  assert.equal(await answer.inputValue(), 'wrong');
  const release = Promise.withResolvers(); gate = release.promise;
  await answer.fill('right');
  await page.locator('.teaching-panel button.primary').click();
  await gradingStarted.promise;
  await answer.fill('typed while checking');
  release.resolve();
  await page.getByRole('heading', { name: 'Formula and why it applies' }).waitFor();
  assert.equal(await page.locator('.teaching-progress').getAttribute('aria-valuenow'), '1');
  assert.equal(await answer.inputValue(), 'typed while checking');
  await page.getByRole('button', { name: 'Guided understanding', exact: true }).click();
  await page.getByText('Generic current relationship', { exact: true }).waitFor();
  await answer.fill('generic draft');
  await page.getByRole('button', { name: 'Guided calculation', exact: true }).click();
  await page.getByRole('heading', { name: 'Formula and why it applies' }).waitFor();
  assert.equal(await answer.inputValue(), 'typed while checking');
  await page.screenshot({ path: resolve(screenshots, 'calculation-desktop.png'), fullPage: true });
  await page.locator('.teaching-panel').screenshot({ path: resolve(screenshots, 'calculation-panel-desktop.png') });
  await page.setViewportSize({ width: 420, height: 900 });
  await page.screenshot({ path: resolve(screenshots, 'calculation-mobile.png'), fullPage: true });
  await page.locator('.teaching-panel').screenshot({ path: resolve(screenshots, 'calculation-panel-mobile.png') });
  assert.ok(await page.locator('.teaching-panel').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await page.setViewportSize({ width: 320, height: 900 });
  assert.ok(await page.locator('.teaching-panel').evaluate(element => element.scrollWidth <= element.clientWidth + 1));
  await page.evaluate(() => localStorage.setItem('study-ui-language', 'zh'));
  await page.addInitScript(() => localStorage.setItem('study-ui-language', 'zh'));
  await page.reload(); await resume();
  await page.getByRole('heading', { name: '公式与适用理由' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '当前步骤的回答' }).inputValue(), 'typed while checking');
  assert.deepEqual(errors, []);
});
