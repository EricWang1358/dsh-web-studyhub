/* global document, localStorage, getComputedStyle -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { startNavServer } from '../scripts/qa/nav-layout.mjs';
import { previewCall } from '../scripts/preview-server.mjs';
import { frameOf } from '../ui/app/use-drawer-frame.js';

/* The navigation drawer opens inside StudyHub's own page, never along the edge of the whole host window (owner, 2026-11-05: inside DSH it
   covered DSH's own sidebar), and the sidebar is docked by default: the old 'study-sidebar' = 'collapsed' of the icon rail no longer puts it away.
   The host is imitated by pushing the app 300 px to the right inside a wider window. Needs a Chromium; without one the test says so. */

test('frameOf: the root box as the four --nav-frame-* properties', () => {
  assert.deepEqual(frameOf({ left: 300, top: 40, width: 500, height: 760 }),
    { '--nav-frame-left': '300px', '--nav-frame-top': '40px', '--nav-frame-width': '500px', '--nav-frame-height': '760px' });
});

test('the drawer opens inside the app, not at the host window edge; the sidebar is docked by default', { timeout: 240000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-drawer-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startNavServer({ distDir: dist });
  try {
    // A learner of the icon-rail version: 'study-sidebar' = 'collapsed' is left over. Wide workspace: the sidebar is docked anyway.
    const wide = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await wide.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); localStorage.setItem('study-sidebar', 'collapsed'); } catch { /* blocked */ } });
    const page = await wide.newPage();
    await page.goto(running.server.url);
    await page.locator('.sidebar').first().waitFor({ timeout: 30000 });
    assert.equal(await page.locator('.nav-menu-toggle').count(), 0, 'docked: no menu button');
    assert.equal(await page.locator('aside.sidebar').count(), 1, 'the sidebar is the docked column');
    // 回到题目 and its count on one line at the compact width (1050 and below).
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(300);
    const resume = await page.evaluate(() => {
      const label = document.querySelector('aside.sidebar .nav .nav-label');
      return label ? Math.round(label.getBoundingClientRect().height / parseFloat(getComputedStyle(label).lineHeight)) : null;
    });
    assert.equal(resume, 1, 'the first row label is one line');
    await wide.close();

    // A narrow workspace placed 300 px from the window's left edge, as inside a host: the drawer opens at the app's edge.
    const narrow = await browser.newContext({ viewport: { width: 900, height: 800 } });
    await narrow.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); } catch { /* blocked */ } });
    const host = await narrow.newPage();
    await host.goto(running.server.url);
    await host.addStyleTag({ content: '.study-app { position: fixed !important; left: 300px !important; top: 40px !important; width: 500px !important; height: 720px !important; }' });
    await host.locator('.nav-menu-toggle').first().waitFor({ timeout: 30000 });
    await host.locator('.nav-menu-toggle').first().click();
    await host.locator('.nav-drawer[open]').waitFor();
    await host.waitForTimeout(400);
    const box = await host.evaluate(() => {
      const rect = document.querySelector('.nav-drawer[open]').getBoundingClientRect(), app = document.querySelector('.study-app').getBoundingClientRect();
      return { left: rect.left, top: rect.top, bottom: rect.bottom, appLeft: app.left, appTop: app.top, appBottom: app.bottom };
    });
    assert.ok(Math.abs(box.left - box.appLeft) <= 2, `the drawer starts at the app's left edge, not the window's (${JSON.stringify(box)})`);
    assert.ok(Math.abs(box.top - box.appTop) <= 2 && Math.abs(box.bottom - box.appBottom) <= 2, `the drawer is as tall as the app (${JSON.stringify(box)})`);
    await host.keyboard.press('Escape');
    await host.locator('.nav-drawer[open]').waitFor({ state: 'detached' });
    assert.equal(await host.evaluate(() => document.querySelector('.study-app').style.getPropertyValue('--nav-frame-left')), '', 'the frame is cleared on close');
    await narrow.close();

    // Seed a flashcard deck and active run so the 420 px drawer tests can navigate to 回到题目 and flip with Space (#1679).
    const quote = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
    await previewCall(running.server, 'source.add', { id: 's1', title: 'Bridge', text: quote });
    await previewCall(running.server, 'draft.save', {
      deck: {
        id: 'd1',
        title: 'Patterns',
        cards: [
          { id: 'c1', kind: 'flashcard', topic: 'Bridge', objective: 'Explain Bridge', prompt: 'What does Bridge separate?', answer: 'Abstraction and implementation.', hint: 'Two dimensions.', explanation: 'Composition over inheritance.', misconception: '', citations: [{ sourceId: 's1', quote }] },
          { id: 'c2', kind: 'flashcard', topic: 'Bridge', objective: 'Use Bridge', prompt: 'When is Bridge useful?', answer: 'When both sides vary independently.', hint: 'Avoid class explosion.', explanation: 'Decouples hierarchies.', misconception: '', citations: [{ sourceId: 's1', quote }] },
        ],
      },
    });
    await previewCall(running.server, 'draft.publish.quick', { id: 'd1' });
    const snap = await previewCall(running.server, 'snapshot');
    const publishedDeck = snap.decks.find((deck) => deck.title === 'Patterns') || snap.decks[0];
    assert.ok(publishedDeck?.id, 'published flashcard deck exists in snapshot');

    const startFreshFlashRun = () => previewCall(running.server, 'review.start', {
      mode: 'path',
      scope: [{ deckId: publishedDeck.id }],
      fresh: true,
    });

    await t.test('clicking 回到题目 inside the 420px drawer moves focus onto the flashcard so Space flips instead of reopening the menu', async () => {
      await startFreshFlashRun();
      const ctx = await browser.newContext({ viewport: { width: 420, height: 800 } });
      await ctx.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); } catch { /* blocked */ } });
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (error) => errors.push(String(error)));
      try {
        await p.goto(running.server.url, { timeout: 60000 });
        const menuBtn = p.locator('.nav-menu-toggle').first();
        await menuBtn.waitFor({ timeout: 30000 });

        // Esc dismissal still returns focus to the topbar menu button.
        await menuBtn.click();
        await p.locator('.nav-drawer[open]').waitFor();
        await p.keyboard.press('Escape');
        await p.locator('.nav-drawer[open]').waitFor({ state: 'detached' });
        assert.equal(await p.evaluate(() => document.activeElement?.classList?.contains('nav-menu-toggle') ?? false), true, 'Esc returns focus to 打开导航');

        // Mouse click on 回到题目 closes drawer and hands focus to the question card so Space flips the flashcard.
        await menuBtn.click();
        await p.locator('.nav-drawer[open]').waitFor();
        await p.locator('.nav-drawer .resume-nav').click();
        await p.locator('.nav-drawer[open]').waitFor({ state: 'detached' });
        await p.locator('.flashcard').waitFor({ timeout: 30000 });
        await p.waitForFunction(() => document.activeElement?.classList?.contains('question-card'), null, { timeout: 10000 });
        assert.equal(await p.locator('.flashcard.flipped').count(), 0, 'flashcard starts unflipped');

        await p.keyboard.press('Space');
        await p.locator('.flashcard.flipped').waitFor({ timeout: 10000 });
        await p.locator('.grading .grade-scale').waitFor({ timeout: 10000 });
        assert.equal(await p.locator('.nav-drawer[open]').count(), 0, 'Space flipped the card instead of reopening the drawer');
        assert.deepEqual(errors, [], 'no page errors');
      } finally {
        await ctx.close();
      }
    });

    await t.test('tabbing to 回到题目 with the keyboard at 420px lands on the question card for Space flip while Escape restores the menu trigger', async () => {
      await startFreshFlashRun();
      const ctx = await browser.newContext({ viewport: { width: 420, height: 800 } });
      await ctx.addInitScript(() => { try { localStorage.setItem('study-ui-language', 'zh'); } catch { /* blocked */ } });
      const p = await ctx.newPage();
      const errors = [];
      p.on('pageerror', (error) => errors.push(String(error)));
      try {
        await p.goto(running.server.url, { timeout: 60000 });
        const menuBtn = p.locator('.nav-menu-toggle').first();
        await menuBtn.waitFor({ timeout: 30000 });

        // Open drawer with keyboard Enter, dismiss with Esc -> focus returns to 打开导航.
        await menuBtn.focus();
        await p.keyboard.press('Enter');
        await p.locator('.nav-drawer[open]').waitFor();
        await p.keyboard.press('Escape');
        await p.locator('.nav-drawer[open]').waitFor({ state: 'detached' });
        assert.equal(await p.evaluate(() => document.activeElement?.classList?.contains('nav-menu-toggle') ?? false), true, 'Esc returns focus to 打开导航 after keyboard open');

        // Reopen with keyboard Space, Tab to 回到题目, activate with Enter -> focus moves to the question card and Space flips.
        await p.keyboard.press('Space');
        await p.locator('.nav-drawer[open]').waitFor();
        let reachedResume = false;
        for (let step = 0; step < 15; step++) {
          await p.keyboard.press('Tab');
          reachedResume = await p.evaluate(() => document.activeElement?.matches?.('.nav-drawer .resume-nav') ?? false);
          if (reachedResume) break;
        }
        assert.equal(reachedResume, true, 'Tab reaches 回到题目 inside the drawer');
        await p.keyboard.press('Enter');
        await p.locator('.nav-drawer[open]').waitFor({ state: 'detached' });
        await p.locator('.flashcard').waitFor({ timeout: 30000 });
        await p.waitForFunction(() => document.activeElement?.classList?.contains('question-card'), null, { timeout: 10000 });
        assert.equal(await p.locator('.flashcard.flipped').count(), 0, 'flashcard starts unflipped');

        await p.keyboard.press('Space');
        await p.locator('.flashcard.flipped').waitFor({ timeout: 10000 });
        await p.locator('.grading .grade-scale').waitFor({ timeout: 10000 });
        assert.equal(await p.locator('.nav-drawer[open]').count(), 0, 'Space flipped the card instead of reopening the drawer');
        assert.deepEqual(errors, [], 'no page errors');
      } finally {
        await ctx.close();
      }
    });
  } finally {
    await running.close?.();
    await browser.close();
    await rm(dist, { recursive: true, force: true });
  }
});
