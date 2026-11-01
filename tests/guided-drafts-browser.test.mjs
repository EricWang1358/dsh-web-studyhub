/* global localStorage, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { StudyService } from '../lib/service.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* The unsubmitted answer and the help an answer got, in Chromium through the REAL practice page on a real library (#537, #542): typing reaches review.draft.save without the
   page going busy and with no model anywhere near, a reload brings it back, a cleared answer stays cleared, a step waits for the save and is refused when the save fails, and the
   attempt says whether the learner answered alone. Last, the real host adapter (ui/host/workspace.jsx) drops a panel intent that arrives after a newer one. The library is read
   from the host's own store: what the attempt says, not what the page believes. */

const base = { topic: 'Topic', objective: 'Recall', hint: '想想定义。', explanation: 'Because.', misconception: 'Mixed up.', citations: [] };
const open = (id) => ({ ...base, id, kind: 'open', prompt: `Explain ${id}?`, answer: 'An answer.' });
const flash = (id) => ({ ...base, id, kind: 'flashcard', prompt: `Recall ${id}?`, answer: 'An answer.' });
const quiz = (id, kind = 'quiz') => ({ ...base, id, kind, multiple: kind === 'multi', prompt: `Pick ${id}?`,
  options: [{ id: 'a', text: 'Right one', correct: true, explanation: 'Yes.' }, { id: 'b', text: 'Wrong one', correct: false, explanation: 'No.' }, { id: 'c', text: 'Other one', correct: kind === 'multi', explanation: 'Maybe.' }] });
const cloze = (id) => ({ ...base, id, kind: 'cloze', prompt: `Fill ${id}`, clozeText: 'The word is {{b1}}.', cloze: { text: 'The word is {{b1}}.', answers: [{ id: 'b1', accepted: ['word'] }] } });

const DECKS = {
  'deck-open': [open('o1')], 'deck-hint': [quiz('q-hint')], 'deck-alone': [quiz('q-alone')], 'deck-multi': [quiz('m1', 'multi')], 'deck-cloze': [cloze('c1')],
  'deck-flash': [flash('f1')], 'deck-fail': [open('o-fail')], 'deck-order': [open('o-a'), open('o-b')], 'deck-ask': [flash('f-ask')],
  'deck-queue': [open('o-q1'), open('o-q2')], 'deck-extra': [flash('x1')], 'deck-hang': [open('o-hang')],
  'deck-move': [open('o-m1'), open('o-m2')], 'deck-pre': [flash('pre')], 'deck-branch': [{ ...open('o-branch'), requires: [{ deckId: 'deck-pre', cardId: 'pre' }] }],
};

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'guided-drafts-'));
  const service = new StudyService(join(root, 'library'));
  await service.store.update((s) => {
    for (const [id, cards] of Object.entries(DECKS)) s.decks.push({ id, title: id, course: '', cards });
  });
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await service.dispose(); await rm(root, { recursive: true, force: true }); });
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return null; }
  return { root, service, server, browser };
}

/** A page with every host call written down, in order. */
async function openPage(browser, server) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const calls = [];
  page.on('request', (request) => {
    if (!request.url().endsWith('/api/call')) return;
    try { const { action, args } = JSON.parse(request.postData()); calls.push({ action, args }); } catch { /* not ours */ }
  });
  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'zh'); });
  await page.goto(server.url);
  const saves = () => calls.filter((call) => call.action === 'review.draft.save');
  const startDeck = async (title) => {
    await page.getByRole('button', { name: `开始学习 ${title}` }).first().click();
    await page.locator('[data-tour="review-question"]').waitFor({ timeout: 30000 });
  };
  // What 刷新 does to the learner: the page is gone; the S key opens the last round again, as it does from anywhere.
  const reopen = async (runId) => {
    await page.reload();
    const inside = page.getByRole('button', { name: /^开始学习 / }).first();
    await inside.waitFor({ timeout: 30000 });
    await inside.focus();
    await page.keyboard.press('s');
    await page.locator('[data-tour="review-question"]').waitFor({ timeout: 30000 });
    assert.equal(calls.findLast((call) => call.action === 'review.get')?.args.runId, runId, 'the round itself, not a new one');
  };
  return { page, calls, saves, startDeck, reopen, close: () => context.close() };
}

const FLIP = /翻面|看答案|显示答案/;
const until = async (check, what, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 40));
  }
};
const attemptsOf = async (service, cardId) => (await service.store.read()).attempts.filter((item) => item.quiz_id === cardId);
const runIdOf = (calls) => calls.findLast((call) => call.args?.runId)?.args.runId;

test('the real practice page saves, restores, clears and waits for the unsubmitted answer, and records whether the answer had help', { timeout: 600000 }, async (t) => {
  const served = await setup(t);
  if (!served) return;
  const { service, server, browser } = served;

  await t.test('typing reaches review.draft.save by itself, never going busy, and a reload brings it back; clearing it stays cleared', async () => {
    const view = await openPage(browser, server);
    await view.startDeck('deck-open');
    const box = view.page.locator('.response-label textarea');
    const busyBefore = await view.page.locator('[data-usage="review.next"]').count();
    await box.pressSequentially('half an answer', { delay: 15 });
    assert.equal(view.saves().length, 0, 'nothing is sent while the learner is still typing');
    const save = await until(() => view.saves().at(-1), 'the debounced save');
    assert.equal(save.args.draft.text, 'half an answer');
    assert.equal(save.args.cardId, 'o1');
    assert.equal(typeof save.args.queueVersion, 'number');
    assert.equal(save.args.index, 0);
    assert.equal(await box.inputValue(), 'half an answer');
    assert.equal(await box.isDisabled(), false, 'the field stays usable while it saves');
    assert.equal(await view.page.locator('[data-usage="review.next"]').count(), busyBefore);
    assert.equal(view.saves().length, 1, 'one save for one burst of typing');
    const runId = save.args.runId;
    await until(async () => (await previewCall(server, 'review.get', { runId })).draft?.text === 'half an answer', 'the draft in the library');

    await view.reopen(runId);
    assert.equal(await view.page.locator('.response-label textarea').inputValue(), 'half an answer', 'a reload brings the words back');

    await view.page.locator('.response-label textarea').fill('');
    await until(() => view.saves().at(-1)?.args.draft.text === '', 'a save of the empty text');
    await until(async () => (await previewCall(server, 'review.get', { runId })).draft?.text === '', 'the cleared draft in the library');
    await view.reopen(runId);
    assert.equal(await view.page.locator('.response-label textarea').inputValue(), '', 'cleared stays cleared');
    await view.close();
  });

  await t.test('opening a question and reading it writes nothing', async () => {
    const view = await openPage(browser, server);
    await view.startDeck('deck-flash');
    await new Promise((done) => setTimeout(done, 900));
    assert.equal(view.saves().length, 0);
    await view.close();
  });

  await t.test('picked options and filled blanks come back too', async () => {
    const view = await openPage(browser, server);
    await view.startDeck('deck-multi');
    await view.page.locator('[data-usage="review.option"]').nth(0).click();
    const picked = await until(() => view.saves().find((save) => save.args.draft.selected.length), 'a save of the options');
    await until(async () => (await previewCall(server, 'review.get', { runId: picked.args.runId })).draft?.selected?.length, 'options in the library');
    await view.reopen(picked.args.runId);
    assert.equal(await view.page.locator('.option--selected').count(), 1, 'the option is ticked again');
    await view.page.locator('.option--selected').click();
    await until(() => view.saves().at(-1)?.args.draft.selected.length === 0, 'a save of no options');
    await view.close();

    const blanks = await openPage(browser, server);
    await blanks.startDeck('deck-cloze');
    const blank = blanks.page.locator('[data-tour="review-question"] input').first();
    await blank.fill('wor');
    const filled = await until(() => blanks.saves().at(-1), 'a save of the blank');
    assert.deepEqual(Object.values(filled.args.draft.stepInputs), ['wor']);
    await until(async () => Object.values((await previewCall(server, 'review.get', { runId: filled.args.runId })).draft?.stepInputs || {}).length, 'the blank in the library');
    await blanks.reopen(filled.args.runId);
    assert.equal(await blanks.page.locator('[data-tour="review-question"] input').first().inputValue(), 'wor');
    await blanks.close();
  });

  await t.test('a choice answered alone is independent; opening the hint first makes the attempt say so', async () => {
    const alone = await openPage(browser, server);
    await alone.startDeck('deck-alone');
    await alone.page.locator('[data-usage="review.option"]').first().click();
    await until(async () => (await attemptsOf(service, 'q-alone')).length, 'the attempt');
    assert.equal((await attemptsOf(service, 'q-alone'))[0].assistance.used, false);
    await alone.close();

    const helped = await openPage(browser, server);
    await helped.startDeck('deck-hint');
    await helped.page.getByRole('button', { name: '提示', exact: true }).click();
    await helped.page.locator('.hint').waitFor();
    // At once, without waiting for the debounce: the step sends what is waiting first.
    await helped.page.locator('[data-usage="review.option"]').first().click();
    await until(async () => (await attemptsOf(service, 'q-hint')).length, 'the attempt');
    const [attempt] = await attemptsOf(service, 'q-hint');
    assert.equal(attempt.assistance.hintUsed, true);
    assert.equal(attempt.assistance.used, true);
    const order = helped.calls.map((call) => call.action);
    assert.ok(order.indexOf('review.draft.save') > -1 && order.indexOf('review.draft.save') < order.indexOf('review.answer'), 'saved before the answer');
    await helped.close();
  });

  await t.test('a flashcard flipped and graded is independent; asking the background assistant first is help', async () => {
    const view = await openPage(browser, server);
    await view.startDeck('deck-flash');
    await view.page.getByRole('button', { name: FLIP }).click();
    await view.page.locator('[data-usage="review.grade"]').nth(4).click();
    await until(async () => (await attemptsOf(service, 'f1')).length, 'the attempt');
    assert.equal((await attemptsOf(service, 'f1'))[0].assistance.used, false, 'the flip is how a flashcard is answered');
    await view.close();

    const asked = await openPage(browser, server);
    await asked.startDeck('deck-ask');
    await asked.page.locator('[data-usage="review.help"]').click();
    await asked.page.locator('.assist-form textarea').fill('why?');
    await asked.page.locator('.assist-form button[type="submit"]').click();
    const noted = await until(() => asked.saves().find((save) => save.args.assistance?.askedTutorBeforeAnswer), 'the asked-tutor signal');
    assert.equal(noted.args.cardId, 'f-ask');
    await until(async () => (await previewCall(server, 'review.get', { runId: noted.args.runId })).assistance?.askedTutorBeforeAnswer, 'the signal in the library');
    await asked.close();
  });

  await t.test('a step waits for the save; when the save fails it does not go ahead, says so, keeps the words, and works once it can save', async () => {
    const view = await openPage(browser, server);
    await view.startDeck('deck-fail');
    let refuse = true;
    await view.page.route('**/api/call', async (route) => {
      const { action } = JSON.parse(route.request().postData());
      if (action === 'review.draft.save' && refuse) await route.abort('failed');
      else await route.continue();
    });
    const box = view.page.locator('.response-label textarea');
    await box.fill('do not lose me');
    await view.page.getByRole('button', { name: '提示', exact: true }).click();
    // Flip is not blocked (it is not a step that leaves the question), so the blocked step here is the grade after it.
    await view.page.getByRole('button', { name: FLIP }).click();
    const grade = view.page.locator('[data-usage="review.grade"]').nth(4);
    await grade.waitFor();
    await until(() => view.saves().length >= 1, 'a save attempt');
    const answersBefore = view.calls.filter((call) => call.action === 'review.answer').length;
    await grade.click();
    await view.page.getByText('没能保存你写的内容').first().waitFor({ timeout: 8000 });
    assert.equal(view.calls.filter((call) => call.action === 'review.answer').length, answersBefore, 'review.answer was not sent');
    assert.equal((await attemptsOf(service, 'o-fail')).length, 0);
    refuse = false;
    await grade.click();
    await until(async () => (await attemptsOf(service, 'o-fail')).length, 'the attempt once it can save');
    const [attempt] = await attemptsOf(service, 'o-fail');
    assert.equal(attempt.assistance.hintUsed, true, 'the signal that could not be saved at first reached the attempt');
    await view.close();
  });

  await t.test('moving away sends the words first and coming back finds them; so does going off to a prerequisite', async () => {
    const view = await openPage(browser, server);
    await view.startDeck('deck-move');
    const firstCard = await view.page.locator('.response-label textarea').count();
    assert.equal(firstCard, 1);
    await view.page.getByRole('button', { name: FLIP }).click();
    await view.page.locator('[data-usage="review.grade"]').nth(4).click();
    await view.page.locator('[data-usage="review.next"]:not([disabled])').click();
    const box = view.page.locator('.response-label textarea');
    await box.waitFor();
    await box.fill('typed just now');
    // At once: within the debounce.
    await view.page.locator('[data-usage="review.prev"]').click();
    const order = await until(() => { const names = view.calls.map((call) => call.action); return names.lastIndexOf('review.move') > names.lastIndexOf('review.draft.save') && names.includes('review.draft.save') ? names : null; }, 'the save and the move');
    assert.equal(view.saves().at(-1).args.draft.text, 'typed just now');
    assert.ok(order.lastIndexOf('review.draft.save') < order.lastIndexOf('review.move'));
    await view.page.locator('[data-usage="review.next"]:not([disabled])').click();
    await box.waitFor();
    assert.equal(await box.inputValue(), 'typed just now', 'back on the question, the words are there');
    await view.close();

    const branch = await openPage(browser, server);
    await branch.startDeck('deck-branch');
    // The path puts a question's unlearned prerequisite first; past it, the question itself still offers it again.
    if (!(await branch.page.locator('.response-label textarea').count())) {
      await branch.page.getByRole('button', { name: FLIP }).click();
      await branch.page.locator('[data-usage="review.grade"]').nth(4).click();
      await branch.page.locator('[data-usage="review.next"]:not([disabled])').click();
    }
    await branch.page.locator('.response-label textarea').fill('before the prerequisite');
    await branch.page.locator('.prereq-strip summary').getByRole('button').click();
    const started = branch.calls.indexOf(await until(() => branch.calls.find((call) => call.action === 'review.start' && call.args.returnTo), 'the prerequisite round'));
    const saved = branch.calls.findIndex((call) => call.action === 'review.draft.save' && call.args.draft.text === 'before the prerequisite');
    assert.ok(saved > -1 && saved < started, 'saved before the round starts');
    await branch.close();
  });

  await t.test('the main chat changes the queue while the learner types: the words stay on screen and reach the library', async () => {
    const view = await openPage(browser, server);
    await view.startDeck('deck-queue');
    const box = view.page.locator('.response-label textarea');
    await box.fill('first words');
    const { args: { runId } } = await until(() => view.saves().at(-1), 'the first save');
    await until(async () => (await previewCall(server, 'review.get', { runId })).draft?.text === 'first words', 'the first words in the library');
    const edited = await previewCall(server, 'review.queue.edit', { runId, add: [{ deckId: 'deck-extra', cardId: 'x1' }] });
    // The page has not seen the edit yet (it polls), so this save still names the older queue.
    await box.fill('first words and more');
    await until(async () => (await previewCall(server, 'review.get', { runId })).draft?.text === 'first words and more', 'the newer words in the library');
    const polls = view.calls.filter((call) => call.action === 'review.get').length;
    await until(() => view.calls.filter((call) => call.action === 'review.get').length > polls, 'the page reading the round', 10000);
    await new Promise((done) => setTimeout(done, 300));
    assert.equal(await box.inputValue(), 'first words and more', 'the same question at the same place keeps what is typed');
    assert.ok(edited.queueVersion > 0);
    await view.reopen(runId);
    assert.equal(await view.page.locator('.response-label textarea').inputValue(), 'first words and more');
    await view.close();
  });

  await t.test('a save that hangs does not hold a step silently: the page says so soon, and the step works once it can save', async () => {
    const view = await openPage(browser, server);
    await view.startDeck('deck-hang');
    let hang = true;
    const held = [];
    await view.page.route('**/api/call', async (route) => {
      const { action } = JSON.parse(route.request().postData());
      if (action === 'review.draft.save' && hang) held.push(route);
      else await route.continue();
    });
    await view.page.locator('.response-label textarea').fill('do not lose me either');
    await view.page.getByRole('button', { name: FLIP }).click();
    const grade = view.page.locator('[data-usage="review.grade"]').nth(4);
    await grade.waitFor();
    const answersBefore = view.calls.filter((call) => call.action === 'review.answer').length;
    await grade.click();
    await view.page.getByText('没能保存你写的内容').first().waitFor({ timeout: 12000 });
    assert.equal(view.calls.filter((call) => call.action === 'review.answer').length, answersBefore, 'review.answer was not sent');
    hang = false;
    await Promise.all(held.map((route) => route.continue()));
    await grade.click();
    await until(async () => (await attemptsOf(service, 'o-hang')).length, 'the attempt once it can save');
    await view.close();
  });

  await t.test('a late draft cannot return to an answered question', async () => {
    const view = await openPage(browser, server);
    await view.startDeck('deck-order');
    const runId = await until(() => runIdOf(view.calls), 'the run id');
    const box = view.page.locator('.response-label textarea');
    await box.fill('typed before grading');
    await view.page.getByRole('button', { name: FLIP }).click();
    await view.page.locator('[data-usage="review.grade"]').nth(4).click();
    await view.page.locator('[data-usage="review.next"]:not([disabled])').waitFor();
    const answered = await previewCall(server, 'review.get', { runId });
    assert.ok(answered.feedback);
    const countAfter = view.saves().length;
    await new Promise((done) => setTimeout(done, 700));
    assert.equal(view.saves().length, countAfter, 'nothing more is written for it');
    await view.close();
  });
});

const hostBundle = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import * as workspace from './ui/host/workspace.jsx';
  import { setUiLanguage } from './ui/i18n.js';
  setUiLanguage('zh');
  const seats = {}, log = window.hostLog = { acks: [], tabs: 0 };
  window.intentQueue = [];
  const rpc = { call: async (_route, _path, payload) => {
    if (payload.action === 'panel.intent.next') return { ok: true, value: { intent: window.intentQueue.shift() || null } };
    if (payload.action === 'panel.ack') { log.acks.push(payload.args.intentId); return { ok: true, value: {} }; }
    const reply = await window.invokeStudy(payload.action, payload.args);
    return reply.ok ? { ok: true, value: reply.value } : { ok: false, error: { message: reply.error, code: reply.code } };
  } };
  const services = { connection: { rpc }, sidebarRight: { openTab: () => { log.tabs += 1; } }, layout: { selectPanel: () => {} } };
  const ctx = { get: (name) => services[name], effect(fn) { fn(); }, inject: (_n, fn) => fn(ctx),
    locale: { register: () => () => {}, bind: () => (key) => key },
    slots: { inject: (_n, fn) => fn(), register: (descriptor, component) => { seats[descriptor.name + ':' + (descriptor.key || descriptor.id)] = component; return () => {}; } },
    sidebarRightTabs: { register: () => () => {} } };
  workspace.apply(ctx, () => {});
  createRoot(document.getElementById('main')).render(React.createElement(seats['study-workspace.page:undefined'], { sessionId: 's1' }));
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });

test('the real host adapter shows a newer panel intent and drops an older one that arrives after it', { timeout: 300000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'guided-intents-'));
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('invokeStudy', async (action, args) => {
    try { return { ok: true, value: await previewCall(server, action, args) }; }
    catch (error) { return { ok: false, error: error.message, code: error.code }; }
  });
  await page.setContent('<!doctype html><html><body><div id="main"></div></body></html>');
  await page.addScriptTag({ content: hostBundle.outputFiles[0].text });
  assert.deepEqual(errors, []);
  const read = () => page.evaluate(() => window.hostLog);
  await page.evaluate(() => { window.intentQueue.push({ type: 'studyRef', studyRef: { kind: 'none' }, intentId: 'newer', intentSeq: 5, issuedAt: 5000 }); });
  await until(async () => (await read()).acks.includes('newer'), 'the newer intent acknowledged', 15000);
  const tabs = (await read()).tabs;
  await page.evaluate(() => { window.intentQueue.push({ type: 'studyRef', studyRef: { kind: 'none' }, intentId: 'older', intentSeq: 3, issuedAt: 3000 }); });
  await until(() => page.evaluate(() => window.intentQueue.length === 0), 'the older intent taken', 15000);
  await new Promise((done) => setTimeout(done, 300));
  const after = await read();
  assert.deepEqual(after.acks, ['newer'], 'the late one is not acknowledged as shown');
  assert.equal(after.tabs, tabs, 'and does not ask for the sidebar');
  await page.evaluate(() => { window.intentQueue.push({ type: 'studyRef', studyRef: { kind: 'none' }, intentId: 'restarted', intentSeq: 1, issuedAt: 9000 }); });
  await until(async () => (await read()).acks.includes('restarted'), 'an intent of a restarted host', 15000);
});

const guidedBundle = await build({ stdin: { contents: `
  import React, { Suspense } from 'react';
  import { createRoot } from 'react-dom/client';
  import { PAGE_VIEWS } from './ui/app/page-views.jsx';
  import { AppContext } from './ui/app/app-context.js';
  import { setUiLanguage } from './ui/i18n.js';
  setUiLanguage('zh');
  window.order = [];
  const card = { id: 'c', kind: 'flashcard', prompt: 'Recall?', answer: 'A', hint: 'H' };
  const run = { id: 'r', index: 0, card, deckId: 'd', queueVersion: 0, feedback: null, revealed: false };
  const guidedSession = { id: 's', courseId: 'C', status: 'active', goal: { title: 'Goal', checkItems: [] }, focus: { kind: 'card', id: 'c', deckId: 'd', runId: 'r' } };
  const value = { data: { modelReady: true }, core: { call: async () => guidedSession, act() {}, refresh() {}, notify() {} }, nav: { navigate() {} }, lib: { guidedSession, set: {} },
    session: { run, enterRun() {}, actions: { noteAssistance: (flag) => window.order.push(flag) } },
    // The chat never answers: what is recorded must not wait for it.
    host: { askInChat: () => { window.order.push('sent'); return new Promise(() => {}); } } };
  createRoot(document.getElementById('main')).render(
    React.createElement(AppContext.Provider, { value }, React.createElement(Suspense, { fallback: null }, React.createElement(PAGE_VIEWS.guided))));
`, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });

test('请教主会话 is recorded on the guided page before the question is sent, so a chat that never answers cannot lose it', { timeout: 120000 }, async (t) => {
  let browser;
  t.after(async () => { await browser?.close(); });
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body><div id="main"></div></body></html>');
  await page.addScriptTag({ content: guidedBundle.outputFiles[0].text });
  await page.getByRole('button', { name: '请教主会话' }).click();
  await until(() => page.evaluate(() => window.order.length === 2), 'the note and the send');
  assert.deepEqual(await page.evaluate(() => window.order), ['askedTutorBeforeAnswer', 'sent']);
});
