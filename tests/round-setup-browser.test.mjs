/* global localStorage, document, innerWidth */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { emptyState } from '../lib/store.js';
import { ROUND_SIZE_LIMITS } from '../lib/practice-settings.js';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* #1010 in a real browser, at 1280 and 420 px, in zh and en: never opened, the home start button sends the same review.start as ever (one click); opened, the
   popover starts a 10-question 错题 round, the round holds exactly the ten wrong questions, the choice comes back the next time (per course), a chapter limits the round,
   「设为默认」 shows the same number in 设置 › 练习, the bounds are the backend's, the popover works by keyboard and stays inside the window, and the result page
   offers it beside its next-round button. STUDYHUB_SHOTS=<folder> keeps screenshots. */

const RUNS = [['zh', 1280, 800], ['zh', 420, 900], ['en', 420, 900]];
const make = (id, topic, extra = {}) => ({ id, kind: 'quiz', topic, objective: 'Recall', prompt: `Question ${id}?`, hint: 'Think.', explanation: `Explanation ${id}.`, misconception: `Misconception ${id}.`, citations: [],
  options: [{ id: 'a', text: 'yes', correct: true, explanation: 'Right.' }, { id: 'b', text: 'no', correct: false, explanation: 'Wrong.' }], ...extra });
const PAST = '2026-10-01T00:00:00Z';
const WORDS = {
  zh: { setup: '本轮设置', mixed: '混合', due: '到期', fresh: '新题', wrong: '错题', chapter: '只练某章', whole: '整个范围', start: '开始本轮', makeDefault: '设为默认', end: /到此为止…/, confirm: '到此为止，看结果' },
  en: { setup: 'This round', mixed: 'Mixed', due: 'Due', fresh: 'New', wrong: 'Mistakes', chapter: 'One chapter only', whole: 'The whole range', start: 'Start this round', makeDefault: 'Make default', end: /Stop here…/, confirm: 'Stop and see the result' },
};

async function serve(t) {
  const root = await mkdtemp(join(tmpdir(), 'round-setup-browser-'));
  const service = new StudyService(join(root, 'library'));
  const attempts = [], cards = [];
  for (let n = 0; n < 12; n++) { cards.push(make(`weak${n}`, 'Weak chapter')); attempts.push({ deckId: 'rs', quiz_id: `weak${n}`, grade: 1, timestamp: PAST }); }
  for (let n = 0; n < 3; n++) { cards.push(make(`due${n}`, 'Due chapter', { review: { repetitions: 2, interval_days: 3, ease: 2.5, due_at: PAST } })); attempts.push({ deckId: 'rs', quiz_id: `due${n}`, grade: 4, timestamp: PAST }); }
  for (let n = 0; n < 15; n++) cards.push(make(`new${n}`, 'New chapter'));
  await service.store.update((s) => { Object.assign(s, { ...emptyState(), decks: [{ id: 'rs', title: 'Round setup', course: 'Course', cards }], attempts, focus: { mode: 'class', course: 'Course' } }); });
  await service.dispose();
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return null; }
  return { server, browser };
}

const starts = (page) => { const list = []; page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/api/call')) { const body = JSON.parse(request.postData() || '{}'); if (body.action === 'review.start') { const { uiLanguage: _language, ...args } = body.args; list.push(args); } } }); return list; };
const panel = (page) => page.locator('.round-setup__panel');
const openPopover = async (page) => { await page.locator('[data-usage="round.setup"]').first().click(); await panel(page).waitFor(); };
const lastRun = async (server) => { const runs = (await previewCall(server, 'export', {})).runs; return runs.at(-1); };
const idsOf = (run) => run.entries.map((entry) => entry.card.id);
const pressed = (page, name) => panel(page).getByRole('button', { name, exact: true }).getAttribute('aria-pressed');
const geometry = (page) => page.evaluate(() => {
  const box = document.querySelector('.round-setup__panel')?.getBoundingClientRect();
  return { overflow: document.documentElement.scrollWidth - innerWidth, inside: box ? box.left >= -1 && box.right <= innerWidth + 1 : null };
});
// The toolbar re-renders while the round loads, which can close a menu just opened: open it again until the item is there.
async function chooseMore(page, name) {
  const item = page.getByRole('menuitem', { name });
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!(await item.count())) await page.locator('.review-more-trigger').click();
    try { await item.click({ timeout: 3000 }); return; } catch { /* closed again: retry */ }
  }
  await item.click({ timeout: 3000 });
}
async function openSettingsPractice(page) {
  if (!(await page.locator('.sidebar').count())) { await page.locator('.nav-menu-toggle').click(); await page.locator('.nav-drawer .sidebar').waitFor(); }
  await page.locator('[data-tour="nav-settings"]').first().click();
  await page.locator('.settings-nav [data-category="practice"]').click();
  await page.locator('input[name="roundSize"]').waitFor({ state: 'attached' });
}

test('本轮设置: never opened it changes nothing; opened, a 10-question 错题 round, the last choice, a chapter, 设为默认 and the bounds', { timeout: 900000 }, async (t) => {
  const served = await serve(t);
  if (!served) return;
  const { server, browser } = served;
  const shots = process.env.STUDYHUB_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  for (const [lang, width, height] of RUNS) {
    const where = `${lang} ${width}px`, words = WORDS[lang];
    for (const open of (await previewCall(server, 'snapshot', {})).runs || []) await previewCall(server, 'review.end', { runId: open.id });
    await previewCall(server, 'settings.practice.reset', {});
    await previewCall(server, 'settings.practice.set', { patch: { autopilot: false, debrief: false } });
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage(), errors = [], sent = starts(page);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.addInitScript((language) => { localStorage.setItem('study-ui-language', language); }, lang);
    await page.goto(server.url);

    /* 1. Never opened: one click on the start button, and review.start gets exactly the arguments it always got. */
    await page.locator('[data-usage="home.start"]').first().waitFor();
    await page.locator('[data-usage="home.start"]').first().click();
    await page.locator('.question-card').waitFor({ timeout: 30000 });
    assert.deepEqual(sent, [{ mode: 'path', course: 'Course', daily: true }], `${where}: the plain start sends the plain arguments, once`);
    assert.equal((await lastRun(server)).entries.length, 20, `${where}: the day's round is the setting's 20`);
    await previewCall(server, 'review.end', { runId: (await lastRun(server)).id });
    sent.length = 0;
    await page.goto(server.url);

    /* 2. Opened: 10 questions, 错题 only. The panel is inside the window and says what each range is. */
    await openPopover(page);
    assert.deepEqual(await geometry(page).then((g) => ({ overflow: g.overflow <= 0, inside: g.inside })), { overflow: true, inside: true }, `${where}: the popover fits the window`);
    assert.equal(await pressed(page, words.mixed), 'true', `${where}: opens on the mixed day`);
    assert.equal(await panel(page).locator('input[name="round-size"]').inputValue(), '20', `${where}: the size is the setting's`);
    assert.equal(await panel(page).getByText(words.wrong, { exact: true }).count() > 0, true);
    if (shots) await page.screenshot({ path: join(shots, `round-setup-${lang}-${width}-open.png`) });
    await panel(page).getByRole('button', { name: '10', exact: true }).click();
    await panel(page).getByRole('button', { name: words.wrong, exact: true }).click();
    await panel(page).locator('[data-usage="round.setup.start"]').click();
    await page.locator('.question-card').waitFor({ timeout: 30000 });
    assert.deepEqual(sent, [{ mode: 'path', course: 'Course', daily: true, fresh: true, size: 10, only: 'wrong' }], `${where}: the changed choice, nothing more`);
    const wrongRun = await lastRun(server);
    assert.equal(wrongRun.entries.length, 10, `${where}: a round of ten`);
    assert.ok(idsOf(wrongRun).every((id) => id.startsWith('weak')), `${where}: wrong questions only`);
    assert.match(await page.locator('.question-card .question').first().innerText(), /Question weak\d+\?/, `${where}: the page shows one of them`);
    const saved = (await previewCall(server, 'export', {})).settings.practice;
    assert.deepEqual(saved.lastRounds, { Course: { size: 10, range: 'wrong' } }, `${where}: the choice is kept for the course`);
    assert.equal(saved.roundSize ?? 20, 20, `${where}: the default is untouched`);

    /* 3. The result page offers it beside its next-round button, opened on the same choice; a round of due ones from there. */
    await chooseMore(page, words.end);
    await page.locator('.round-end-confirm').getByRole('button', { name: words.confirm }).click();
    await page.locator('.result-page').waitFor({ timeout: 30000 });
    sent.length = 0;
    await openPopover(page);
    assert.equal(await panel(page).locator('.round-setup__form').count(), 1);
    assert.equal(await pressed(page, words.wrong), 'true', `${where}: the result page's popover opens on the course's last choice`);
    assert.equal(await panel(page).locator('input[name="round-size"]').inputValue(), '10');
    if (shots) await page.screenshot({ path: join(shots, `round-setup-${lang}-${width}-result.png`) });
    await panel(page).getByRole('button', { name: words.due, exact: true }).click();
    await panel(page).locator('[data-usage="round.setup.start"]').click();
    await page.locator('.question-card').waitFor({ timeout: 30000 });
    assert.deepEqual(sent, [{ mode: 'path', course: 'Course', daily: true, fresh: true, size: 10, only: 'due' }], `${where}: the result page's popover starts the course's next round with the choice`);
    const dueRun = await lastRun(server);
    assert.deepEqual(idsOf(dueRun).sort(), ['due0', 'due1', 'due2'], `${where}: the three due questions (fewer than the size)`);
    await previewCall(server, 'review.end', { runId: dueRun.id });

    /* 4. Home again: the popover opens on what was chosen last; a chapter limits the round; going back to the defaults forgets the choice. */
    await page.goto(server.url);
    await openPopover(page);
    assert.equal(await pressed(page, words.due), 'true', `${where}: prefilled with the last choice`);
    assert.equal(await panel(page).locator('input[name="round-size"]').inputValue(), '10');
    await panel(page).getByRole('button', { name: words.mixed, exact: true }).click();
    await panel(page).getByRole('combobox').click();
    await page.getByRole('option', { name: 'New chapter' }).click();
    assert.equal(await panel(page).isVisible(), true, `${where}: choosing a chapter does not close the popover`);
    sent.length = 0;
    await panel(page).locator('[data-usage="round.setup.start"]').click();
    await page.locator('.question-card').waitFor({ timeout: 30000 });
    assert.deepEqual(sent, [{ mode: 'path', scope: [{ deckId: 'rs', topic: 'New chapter' }], fresh: true, size: 10 }], `${where}: a chapter is the scope, with its size`);
    const chapterRun = await lastRun(server);
    assert.equal(chapterRun.entries.length, 10);
    assert.ok(idsOf(chapterRun).every((id) => id.startsWith('new')), `${where}: that chapter's questions only`);
    await previewCall(server, 'review.end', { runId: chapterRun.id });

    /* 5. 设为默认 writes 设置 › 练习's own number; the popover and the settings page show the same one. */
    await page.goto(server.url);
    await openPopover(page);
    assert.equal(await panel(page).getByRole('button', { name: words.makeDefault }).count(), 1, `${where}: the remembered 10 differs from the default 20, so it can be made the default`);
    const input = panel(page).locator('input[name="round-size"]');
    await input.fill('15');
    await panel(page).getByRole('button', { name: words.makeDefault }).click();
    await page.waitForFunction(() => !document.querySelector('.round-setup__default'));
    assert.equal((await previewCall(server, 'export', {})).settings.practice.roundSize, 15, `${where}: saved through settings.practice.set`);
    await page.keyboard.press('Escape');
    await openSettingsPractice(page);
    assert.equal(await page.locator('input[name="roundSize"]').inputValue(), '15', `${where}: 设置 › 练习 shows the same number`);
    assert.match(await page.locator('[role="combobox"]').filter({ hasText: '15' }).first().innerText(), /15/);
    if (shots) await page.screenshot({ path: join(shots, `round-setup-${lang}-${width}-settings.png`) });

    /* 6. The bounds are the backend's; the keyboard works; nothing scrolls sideways. */
    await page.goto(server.url);
    await openPopover(page);
    const start = panel(page).locator('[data-usage="round.setup.start"]');
    for (const bad of [ROUND_SIZE_LIMITS.min - 1, ROUND_SIZE_LIMITS.max + 1, '']) {
      await panel(page).locator('input[name="round-size"]').fill(String(bad));
      assert.equal(await start.isDisabled(), true, `${where}: ${JSON.stringify(bad)} cannot start a round`);
      assert.equal(await panel(page).locator('[role="alert"]').count(), 1, `${where}: and the field says why`);
    }
    for (const good of [ROUND_SIZE_LIMITS.min, ROUND_SIZE_LIMITS.max]) {
      await panel(page).locator('input[name="round-size"]').fill(String(good));
      assert.equal(await start.isDisabled(), false, `${where}: ${good} can`);
    }
    assert.ok((await geometry(page)).overflow <= 0, `${where}: no sideways scroll with the popover open`);
    await page.keyboard.press('Escape');
    assert.equal(await panel(page).count(), 0, `${where}: Escape closes it`);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-usage')), 'round.setup', `${where}: and focus is back on its button`);
    await page.keyboard.press('Enter');
    await panel(page).waitFor();
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.round-setup__panel')), true, `${where}: Enter opens it with focus inside`);
    assert.deepEqual(errors, [], `${where}: no page errors`);
    await context.close();
  }
});
