/* The quick-add on 待办 → 今日 must not be lost when the app itself wrote the board a moment earlier.
   Opening 今日 with an active course plan makes the 今日安排 block ask for the program's own proposal (daily.plan.suggest, local),
   and that request writes the board on the server. Until its answer reaches the page, the page still holds the older board revision.
   Here the answer is held at the network edge after the server has written, so a quick-add sent in that window carries the stale
   revision every time; board reads are held in the same window, so no poll can close it by luck. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDate } from '../lib/board-model.js';
import { addDays } from '../lib/crunch-plan.js';
import { StudyService } from '../lib/service.js';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { COURSE, library as crunchLibrary } from './helpers/crunch-library.mjs';

test('Browser (#855): a quick-add on 今日 sent while the daily plan has just written the board still adds the card', { timeout: 300000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const today = localDate();
  const dist = await mkdtemp(join(tmpdir(), 'study-today-stale-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: async (root) => {
    await mkdir(root, { recursive: true });
    const service = new StudyService(root);
    await service.call('snapshot');
    const { state } = crunchLibrary();
    await service.store.update((own) => {
      own.sources.push(...state.sources);
      own.decks.push(...state.decks);
      own.focus = state.focus;
    });
    await service.call('course.save', { name: COURSE, exam: { date: addDays(today, 25) } });
    await service.call('course.save', { name: COURSE, plan: { version: 1, minutesPerDay: 90 } });
    await service.dispose();
  } });
  t.after(async () => {
    await browser?.close();
    await running.close();
    await rm(dist, { recursive: true, force: true });
  });

  const { page, errors, context } = await openPage(browser, running, { lang: 'zh', theme: 'dark', width: 1280, height: 860 });
  // The window: from the moment the server has written the proposal until the quick-add has gone out.
  let releaseAnswer, addSent;
  const answerGate = new Promise((done) => { releaseAnswer = done; });
  const addGate = new Promise((done) => { addSent = done; });
  const seen = { suggesting: false, written: false, add: null };
  const bodyOf = (route) => { try { return JSON.parse(route.request().postData() || '{}'); } catch { return {}; } };
  await page.route('**/api/call', async (route) => {
    const body = bodyOf(route), action = body.action || '';
    if (action === 'daily.plan.suggest') {
      seen.suggesting = true;
      const response = await route.fetch();
      seen.written = true;
      await answerGate;
      return route.fulfill({ response });
    }
    if (action === 'board.card.add' && !seen.add) {
      seen.add = { sent: body.args?.revision, server: (await running.api('board.get')).revision };
      addSent();
    }
    if (action === 'board.get') {
      // A read the server answers once the proposal may be written would show the page the new revision early: its
      // answer waits until the quick-add has gone out, whenever the read itself was sent.
      const response = await route.fetch();
      if (seen.suggesting) await addGate;
      return route.fulfill({ response });
    }
    return route.continue();
  });

  try {
    await page.goto(running.server.url);
    const todayRoot = page.locator('.board-today');
    await todayRoot.waitFor({ timeout: 30000 });
    await until(() => seen.written, 'the daily plan to write the board', { timeoutMs: 30000 });

    const field = todayRoot.getByPlaceholder('记一条今天要做的事…');
    await field.fill('做 10 道概念辨析');
    await todayRoot.getByRole('button', { name: '记一条' }).click();
    await until(() => seen.add, 'the quick-add to go out', { timeoutMs: 15000 });
    releaseAnswer();
    assert.ok(seen.add.sent < seen.add.server, `the quick-add went out on the board the page held before the plan wrote (sent ${seen.add.sent}, server ${seen.add.server})`);

    await todayRoot.locator('.board-card__title', { hasText: '做 10 道概念辨析' }).waitFor({ timeout: 15000 });
    assert.equal(await field.inputValue(), '', 'the quick-add field is cleared once the card is saved');
    const saved = Object.values((await running.api('board.get')).cards).filter((card) => card.title === '做 10 道概念辨析');
    assert.equal(saved.length, 1, 'exactly one card was saved on the server');
    assert.equal(saved[0].plannedDate, today);
    assert.equal(await page.getByText('看板已在其他位置更新').count(), 0, 'no conflict warning is left on the page');
    assert.deepEqual(errors.filter((line) => !/favicon|status of 400/.test(line)), [], 'no page console errors');
  } finally {
    addSent();
    releaseAnswer();
    await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    await context.close();
  }
});
