/* global document, getComputedStyle, localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';

/* #1679: At 420 px (DSH side panel width) the sidebar is a modal drawer opened from the top-bar menu button.
   Leaving the drawer through a nav item (such as 「回到题目」) must hand focus to the destination page (the question card on Review,
   or <main> elsewhere) instead of returning focus to 「打开导航」, so pressing Space immediately flips the flashcard rather than
   reopening the drawer. Dismissing the drawer via Escape, backdrop click, or the close button still returns focus to 「打开导航」. */

async function seedFlashcardRun(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.decks.push({
      id: 'd1',
      title: 'Memory Systems',
      course: 'Operating Systems',
      folder: '',
      cards: [1, 2].map((n) => ({
        id: `fc${n}`,
        kind: 'flashcard',
        topic: 'Paging',
        objective: `Recall paging ${n}`,
        prompt: `Flashcard ${n}: What is a TLB hit?`,
        answer: `Answer ${n}: The virtual-to-physical translation is found in the TLB cache.`,
        hint: 'Fast address lookup',
        explanation: 'Avoids a multi-level page-table walk.',
        misconception: '',
        citations: [],
        review: { repetitions: 0, interval: 0, easiness: 2.5, due_at: '2026-10-01T00:00:00.000Z', last_grade: null, lapses: 0 },
      })),
    });
  });
  await service.call('review.start', {
    mode: 'path',
    scope: [1, 2].map((n) => ({ deckId: 'd1', cardId: `fc${n}` })),
    fresh: true,
  });
  await service.dispose();
}

const activeInfo = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el) return null;
  const style = getComputedStyle(el);
  return {
    tag: el.tagName.toLowerCase(),
    className: String(el.className || ''),
    ariaLabel: el.getAttribute('aria-label') || '',
    usage: el.getAttribute('data-usage') || '',
    outline: style.outlineStyle,
  };
});

async function tabToSelector(page, selector, maxTabs = 25) {
  for (let i = 0; i < maxTabs; i += 1) {
    const matched = await page.evaluate((sel) => Boolean(document.activeElement?.matches?.(sel)), selector);
    if (matched) return true;
    await page.keyboard.press('Tab');
  }
  return page.evaluate((sel) => Boolean(document.activeElement?.matches?.(sel)), selector);
}

test('#1679: at 420px, leaving nav drawer to 回到题目 (mouse & keyboard) puts focus on the question card so Space flips instead of reopening drawer; Esc/backdrop/close still return focus to 打开导航', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to test with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-drawer-focus-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: seedFlashcardRun });
  try {
    await t.test('mouse: open drawer -> click 回到题目 -> focus lands on .question-card and Space flips', async () => {
      const { page, errors, context } = await openPage(browser, running, { width: 420, height: 800 });
      try {
        await context.addInitScript(() => {
          localStorage.setItem('study-ui-language', 'zh');
          localStorage.setItem('study-autopilot', 'off');
        });
        await page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
        await page.goto(running.server.url);
        const menu = page.locator('.nav-menu-toggle');
        await menu.waitFor({ timeout: 30000 });

        await menu.click();
        const drawer = page.locator('dialog.nav-drawer[open]');
        await drawer.waitFor();
        await drawer.locator('[data-usage="nav.resume"]').click();
        await drawer.waitFor({ state: 'detached' });

        await page.locator('.question-card').waitFor({ timeout: 30000 });
        await page.locator('.flip-control:not([disabled])').waitFor({ timeout: 30000 });
        await settleAnimations(page);

        const afterEnter = await activeInfo(page);
        assert.match(afterEnter.className, /\bquestion-card\b/, `mouse enter should focus question card, got ${JSON.stringify(afterEnter)}`);
        assert.doesNotMatch(afterEnter.className, /\bnav-menu-toggle\b/);

        await page.keyboard.press('Space');
        await page.locator('.grading').waitFor({ timeout: 10000 });
        assert.equal(await page.locator('dialog.nav-drawer[open]').count(), 0, 'Space flipped the flashcard instead of reopening the nav drawer');
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });

    await t.test('keyboard: Enter on 打开导航 -> Tab to 回到题目 -> Enter -> focus lands on .question-card without ring and Space flips; Esc/backdrop/close still return focus to 打开导航', async () => {
      const { page, errors, context } = await openPage(browser, running, { width: 420, height: 800 });
      try {
        await context.addInitScript(() => {
          localStorage.setItem('study-ui-language', 'zh');
          localStorage.setItem('study-autopilot', 'off');
        });
        await page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
        await page.goto(running.server.url);
        const menu = page.locator('.nav-menu-toggle');
        await menu.waitFor({ timeout: 30000 });
        const drawer = page.locator('dialog.nav-drawer[open]');

        // 1. Dismiss with Escape -> focus returns to 打开导航.
        await menu.focus();
        await page.keyboard.press('Enter');
        await drawer.waitFor();
        await page.keyboard.press('Escape');
        await drawer.waitFor({ state: 'detached' });
        const afterEsc = await activeInfo(page);
        assert.match(afterEsc.className, /\bnav-menu-toggle\b/, `Escape should return focus to menu button, got ${JSON.stringify(afterEsc)}`);

        // 2. Dismiss via backdrop click -> focus returns to 打开导航.
        await page.keyboard.press('Enter');
        await drawer.waitFor();
        const box = await drawer.boundingBox();
        assert.ok(box && box.x + box.width < 400, `drawer leaves clickable backdrop on right edge: ${JSON.stringify(box)}`);
        await page.mouse.click(Math.round(box.x + box.width + 20), 400);
        await drawer.waitFor({ state: 'detached' });
        const afterBackdrop = await activeInfo(page);
        assert.match(afterBackdrop.className, /\bnav-menu-toggle\b/, `backdrop click should return focus to menu button, got ${JSON.stringify(afterBackdrop)}`);

        // 3. Dismiss via close button -> focus returns to 打开导航.
        await menu.click();
        await drawer.waitFor();
        await drawer.locator('.sh-dialog__close').click();
        await drawer.waitFor({ state: 'detached' });
        const afterCloseBtn = await activeInfo(page);
        assert.match(afterCloseBtn.className, /\bnav-menu-toggle\b/, `close button should return focus to menu button, got ${JSON.stringify(afterCloseBtn)}`);

        // 4. Keyboard navigation to a non-review page (资料) hands focus to <main> without ring and Space does not reopen drawer.
        await menu.focus();
        await page.keyboard.press('Enter');
        await drawer.waitFor();
        assert.equal(await tabToSelector(page, '[data-tour="nav-sources"]'), true, 'Tab reaches 资料 in drawer');
        await page.keyboard.press('Enter');
        await drawer.waitFor({ state: 'detached' });
        await page.locator('.study-app[data-usage-area="sources"]').waitFor({ timeout: 30000 });
        await settleAnimations(page);
        const afterSources = await activeInfo(page);
        assert.equal(afterSources.tag, 'main', `keyboard nav to non-review page should focus <main>, got ${JSON.stringify(afterSources)}`);
        assert.equal(afterSources.outline, 'none', `<main> draws no focus ring: ${JSON.stringify(afterSources)}`);
        await page.keyboard.press('Space');
        assert.equal(await page.locator('dialog.nav-drawer[open]').count(), 0, 'Space on destination page does not reopen drawer');

        // 5. Keyboard navigation to 回到题目 -> focus lands on .question-card without ring, and Space flips.
        await menu.focus();
        await page.keyboard.press('Enter');
        await drawer.waitFor();
        assert.equal(await tabToSelector(page, '[data-usage="nav.resume"]'), true, 'Tab reaches 回到题目 in drawer');
        await page.keyboard.press('Enter');
        await drawer.waitFor({ state: 'detached' });

        await page.locator('.question-card').waitFor({ timeout: 30000 });
        await page.locator('.flip-control:not([disabled])').waitFor({ timeout: 30000 });
        await settleAnimations(page);

        const afterKbEnter = await activeInfo(page);
        assert.match(afterKbEnter.className, /\bquestion-card\b/, `keyboard enter should focus question card, got ${JSON.stringify(afterKbEnter)}`);
        assert.equal(afterKbEnter.outline, 'none', `question card draws no outline ring: ${JSON.stringify(afterKbEnter)}`);

        await page.keyboard.press('Space');
        await page.locator('.grading').waitFor({ timeout: 10000 });
        assert.equal(await page.locator('dialog.nav-drawer[open]').count(), 0, 'Space flipped the flashcard instead of reopening the nav drawer');

        // 6. While already on Review, reopening drawer and clicking 回到题目 still hands focus back to .question-card.
        await menu.click();
        await drawer.waitFor();
        await drawer.locator('[data-usage="nav.resume"]').click();
        await drawer.waitFor({ state: 'detached' });
        const afterSamePage = await activeInfo(page);
        assert.match(afterSamePage.className, /\bquestion-card\b/, `clicking 回到题目 while already on Review should focus question card, got ${JSON.stringify(afterSamePage)}`);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  } finally {
    await browser.close();
    await running.close();
    await rm(dist, { recursive: true, force: true });
  }
});
