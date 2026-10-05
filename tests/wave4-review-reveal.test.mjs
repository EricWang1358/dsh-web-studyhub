/* global localStorage, document, requestAnimationFrame */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { notify } from '../lib/inbox.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

// #182: a flashcard opens on its question unless it was already answered or revealed in the run being shown.
const flash = (id, n) => ({ id, kind: 'flashcard', topic: 'Topic', objective: 'Recall', prompt: `Question ${n}?`, answer: `Answer ${n}`, hint: '', explanation: 'Because.', misconception: '', citations: [] });
async function library(t) {
  const root = await mkdtemp(join(tmpdir(), 'wave4-reveal-'));
  const service = new StudyService(join(root, 'library'));
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.store.update((s) => {
    s.decks.push({ id: 'd1', title: 'First', cards: [1, 2, 3, 4, 5, 6].map((n) => flash(`c${n}`, n)) });
    s.decks.push({ id: 'd2', title: 'Second', cards: [7, 8].map((n) => flash(`c${n}`, n)) });
  });
  return { root, service };
}
const finish = async (service, run) => {
  let current = run;
  while (!current.complete) {
    await service.call('review.reveal', { runId: current.id, cardId: current.card.id });
    await service.call('review.answer', { runId: current.id, cardId: current.card.id, grade: 4 });
    current = await service.call('review.move', { runId: current.id, direction: 1 });
  }
  return current;
};

test('moving to an unanswered card returns revealed: false, however the earlier cards went (#182)', async (t) => {
  const { service } = await library(t);
  let run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd1' }], fresh: true });
  assert.equal(run.revealed, false);
  for (let i = 0; i < 3; i++) {
    run = await service.call('review.reveal', { runId: run.id, cardId: run.card.id });
    assert.equal(run.revealed, true);
    run = await service.call('review.answer', { runId: run.id, cardId: run.card.id, grade: 4 });
    run = await service.call('review.move', { runId: run.id, direction: 1 });
    assert.equal(run.revealed, false, `card ${i + 2} opens on its question`);
    assert.equal(run.feedback, null);
    assert.equal(run.solution, undefined);
  }
  // Jumping by index (the inbox, the navigator) shows the card's own state: an untouched card is unrevealed, an answered one keeps its answer.
  const unanswered = await service.call('review.move', { runId: run.id, index: 5 });
  assert.equal(unanswered.revealed, false);
  const answered = await service.call('review.move', { runId: run.id, index: 0 });
  assert.equal(answered.revealed, true);
  assert.ok(answered.feedback);
  const again = await service.call('review.move', { runId: run.id, index: 4 });
  assert.equal(again.revealed, false, 'and back to an untouched one');
});

test('a letter whose card was answered in an old unfinished run opens a fresh one-card run, not that old run (#182)', async (t) => {
  const { service } = await library(t);
  const old = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd1' }], fresh: true });
  await finish(service, old); // every card answered, the run never ended
  const current = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd2' }], fresh: true });
  await service.store.update((s) => { notify(s, { kind: 'followup', deckId: 'd1', cardId: 'c3', detail: '为什么？' }); });
  const [letter] = (await service.call('inbox')).items;
  const opened = await service.call('inbox.open', { id: letter.id, runId: current.id });
  assert.notEqual(opened.id, old.id, 'the answered old run is not re-entered');
  assert.equal(opened.card.id, 'c3');
  assert.equal(opened.total, 1);
  assert.equal(opened.revealed, false);
  assert.equal(opened.feedback, null);
  assert.equal(opened.returnTo, current.id);
  const stale = await service.call('review.get', { runId: old.id });
  assert.ok(stale.complete, 'the old run is untouched');
});

test('a letter whose card is still unanswered in another open run goes there (#182)', async (t) => {
  const { service } = await library(t);
  const other = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd1' }], fresh: true });
  const current = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'd2' }], fresh: true });
  await service.store.update((s) => { notify(s, { kind: 'followup', deckId: 'd1', cardId: 'c4', detail: 'x' }); });
  const [letter] = (await service.call('inbox')).items;
  const opened = await service.call('inbox.open', { id: letter.id, runId: current.id });
  assert.equal(opened.id, other.id);
  assert.equal(opened.card.id, 'c4');
  assert.equal(opened.revealed, false);
});

test('in the browser: next after a reveal shows the question, inside an inbox detour and after the poll (#182)', { timeout: 600000 }, async (t) => {
  const { root, service } = await library(t);
  await service.store.update((s) => {
    notify(s, { kind: 'followup', deckId: 'd1', cardId: 'c5', detail: 'x' });
  });
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
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
  const card = page.locator('.flashcard');
  await card.waitFor();
  const flipped = () => card.evaluate((element) => element.classList.contains('flipped'));
  // The next card has arrived once the card's text has changed; the poll has been applied once its answer (review.get) is back and the page has painted twice.
  const next = async () => {
    const before = await card.innerText();
    await page.getByRole('button', { name: /Next/ }).first().click();
    await page.waitForFunction(text => document.querySelector('.flashcard')?.innerText !== text, before);
  };
  const afterPoll = async () => {
    await page.waitForResponse(response => response.url().endsWith('/api/call') && /"review\.get"/.test(response.request().postData() || ''));
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  };
  const answer = async () => { await page.locator('.flip-control').click(); await page.locator('.grade-scale').waitFor(); await page.locator('.grade.high').first().click(); await page.locator('.next-due').waitFor(); };

  assert.equal(await flipped(), false);
  await answer();
  assert.equal(await flipped(), true, 'an answered card keeps its answer face');
  await next();
  assert.equal(await flipped(), false, 'card 2 opens on its question');
  assert.match(await card.innerText(), /Question 2\?/);

  // The inbox detour: jump to card 5, answer it, go on.
  await page.locator('.mailbox__toggle').click();
  await page.locator('.mailbox__item').filter({ hasText: 'Question 5' }).first().click();
  await page.locator('.review-detour').waitFor();
  assert.match(await card.innerText(), /Question 5\?/);
  assert.equal(await flipped(), false, 'a card reached from the inbox opens on its question');
  await afterPoll(); // the review poll fires
  assert.equal(await flipped(), false, 'the poll does not flip it');
  await answer();
  await next();
  assert.match(await card.innerText(), /Question 6\?/);
  assert.equal(await flipped(), false, 'the card after a detour card opens on its question');
  await afterPoll();
  assert.equal(await flipped(), false);
  assert.deepEqual(errors, []);
});
