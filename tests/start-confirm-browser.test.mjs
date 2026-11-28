/* global localStorage, document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium, skipMissingChromium } from '../scripts/qa/browser.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { confirmStart } from '../scripts/qa/confirm-start.mjs';

/* Real Chromium verification for #1624:
   1. StartConfirm focuses 取消 by default and returns focus to the triggering ▶ button on both Cancel and Escape.
   2. Opening StartConfirm while the reader is open stacks on top in the native top layer without unmounting the reader:
      Escape / Cancel closes only StartConfirm and keeps the reader DOM node and scroll position intact; Confirm closes both and starts the round. */

test('StartConfirm in Chromium: default focus on 取消, focus return to ▶ on Cancel/Escape, and non-destructive stacking over the reader', { timeout: 300000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'start-confirm-browser-'));
  const service = new StudyService(join(root, 'library'));
  const card = (id, topic) => ({
    id, kind: 'flashcard', topic, objective: `Recall ${id}`, prompt: `Question ${id}`, answer: 'Answer',
    hint: '', explanation: '', misconception: '', citations: [],
  });
  const longText = Array.from({ length: 80 }, (_, idx) => `第 ${idx + 1} 段：这是用于验证阅读器滚动位置保持不变的长文本段落。`).join('\n\n');
  await service.store.update((state) => {
    state.decks.push({ id: 'd1', title: '行为型模式', course: 'CS3219', cards: [card('c1', 'Memento'), card('c2', 'State')] });
    state.sources.push({ id: 's1', title: '设计模式讲义', course: 'CS3219', kind: 'note', text: longText, createdAt: '2026-11-01T00:00:00.000Z' });
  });
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  try { browser = await launchChromium(); }
  catch (error) { skipMissingChromium(t, error); return; }

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
  await page.addInitScript(() => {
    localStorage.setItem('study-ui-language', 'zh');
    localStorage.setItem('study-autopilot', 'off');
  });
  await page.goto(server.url);

  // 1. Deck row ▶: focus lands on 取消 and returns to the ▶ button after Cancel and after Escape.
  const deckPlay = page.locator('[data-deck-id="d1"] .deck-row .map-play').first();
  await deckPlay.waitFor({ timeout: 30000 });
  const dialog = page.locator('dialog.confirm-start[open]');

  await deckPlay.focus();
  await deckPlay.click();
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '取消', 'deck ▶: default focus lands on 取消');
  await dialog.getByRole('button', { name: '取消' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await deckPlay.evaluate((el) => el === document.activeElement), true, 'deck ▶: focus returns to ▶ after Cancel');

  await deckPlay.click();
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '取消', 'deck ▶ reopen: default focus lands on 取消');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await deckPlay.evaluate((el) => el === document.activeElement), true, 'deck ▶: focus returns to ▶ after Escape');

  // 2. Topic row ▶: focus lands on 取消 and returns to topic ▶ after Escape.
  const topicPlay = page.locator('[data-deck-id="d1"] .topic-row .map-play').first();
  await topicPlay.waitFor({ timeout: 15000 });
  await topicPlay.focus();
  await topicPlay.click();
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '取消', 'topic ▶: default focus lands on 取消');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await topicPlay.evaluate((el) => el === document.activeElement), true, 'topic ▶: focus returns to topic ▶ after Escape');

  // 3. Stacking over the open reader: open reader from 资料, scroll it, trigger 回到题目, verify reader stays mounted & scrolled on Cancel/Escape, and closes on Confirm.
  await (await revealNavRow(page, 'sources')).click();
  const sourceRow = page.getByText('设计模式讲义').first();
  await sourceRow.waitFor({ timeout: 30000 });
  await sourceRow.click();
  const reader = page.locator('dialog.source-preview[open]');
  await reader.waitFor({ timeout: 30000 });
  await reader.getByText('第 1 段', { exact: false }).first().waitFor({ timeout: 30000 });

  const before = await page.evaluate(() => {
    const dlg = document.querySelector('dialog.source-preview[open]');
    const candidates = [dlg.querySelector('.reader-scroll'), dlg.querySelector('.sh-dialog__body')].filter(Boolean);
    const scroller = candidates.find((el) => el.scrollHeight > el.clientHeight) || candidates[0];
    scroller.scrollTop = 240;
    dlg.dataset.testReaderIdentity = 'keep-mounted';
    return { scrollTop: scroller.scrollTop, selector: scroller.classList.contains('reader-scroll') ? '.reader-scroll' : '.sh-dialog__body' };
  });
  assert.ok(before.scrollTop > 0, `reader actually scrolled before stacking (got ${before.scrollTop})`);

  // Invoke 回到题目 while the reader dialog is open.
  await page.evaluate(() => document.querySelector('[data-usage="nav.resume"]')?.click());
  await dialog.waitFor();
  assert.equal(await reader.count(), 1, 'reader stays open underneath StartConfirm');
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '取消', 'stacked StartConfirm focuses 取消');

  // Escape closes ONLY StartConfirm; reader stays the exact same DOM node with its scroll intact.
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  const afterEscape = await page.evaluate((selector) => {
    const dlg = document.querySelector('dialog.source-preview[open]');
    const scroller = dlg?.querySelector(selector);
    return {
      open: Boolean(dlg),
      identity: dlg?.dataset?.testReaderIdentity || null,
      scrollTop: scroller?.scrollTop ?? -1,
    };
  }, before.selector);
  assert.equal(afterEscape.open, true, 'reader stays open after Escape on StartConfirm');
  assert.equal(afterEscape.identity, 'keep-mounted', 'reader was never unmounted');
  assert.equal(afterEscape.scrollTop, before.scrollTop, 'reader scroll position stayed intact');

  // Reopen StartConfirm over the reader and confirm: both dialogs close and the practice round opens.
  await page.evaluate(() => document.querySelector('[data-usage="nav.resume"]')?.click());
  await dialog.waitFor();
  await confirmStart(page);
  await reader.waitFor({ state: 'detached', timeout: 15000 });
  await page.locator('.question-card, .flash-area').first().waitFor({ timeout: 30000 });
  assert.deepEqual(errors, [], 'no page errors');
});
