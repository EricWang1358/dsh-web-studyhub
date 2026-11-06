import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { frames, openPage, seedWrongBookLibrary, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* #748, in a browser: 薄弱点分布 draws the groups of the mistakes list as one bar. Every segment is a focusable button whose aria-label is the words the
   tooltip draws, the count is in the segment, and a press applies the group's own filter (48 mistakes over two decks of 24; scripts/qa/layout-late.mjs). */

test('mistakes page: the distribution bar says the same words it draws, and a segment narrows the list (#748)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-wb-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: (root) => seedWrongBookLibrary(root, { wrong: 72 }) });
  const { page, errors } = await openPage(browser, running, { width: 1280 });
  try {
    await page.goto(running.server.url);
    await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
    await (await revealNavRow(page, 'wrongbook')).dispatchEvent('click');
    await page.locator('.wb-dist').waitFor({ timeout: 30000 });
    await settleAnimations(page);
    await frames(page, 4);

    // One segment per deck, each with its count drawn in it (the second cue beside the width).
    const segments = page.locator('.wb-dist-seg');
    assert.equal(await segments.count(), 2, 'two decks of mistakes');
    assert.equal((await segments.first().locator('span').innerText()).trim(), '24', 'the count is drawn in the segment');
    const label = await segments.first().getAttribute('aria-label');
    assert.equal(await segments.first().evaluate((element) => element.tabIndex), 0, 'every segment is in the tab order');

    // The drawn words are the spoken ones: hover draws the point tooltip over the segment, fact for fact.
    await segments.first().hover();
    const tip = page.locator('.wb-dist-bar .sh-tooltip--point');
    await tip.waitFor({ state: 'visible', timeout: 10000 });
    const drawn = (await tip.innerText()).replace(/\s+/g, ' ').trim();
    assert.equal(drawn, label.split(' · ').join(' '), 'the tooltip says exactly what the aria-label says');
    assert.match(drawn, /只看这个题组/, 'and what a press does');
    await page.mouse.move(0, 0);
    await until(async () => (await page.locator('.wb-dist-bar .sh-tooltip--point').count()) === 0, 'the tooltip to close');

    // A press applies the group's own filter (the same action as the row's 只看这个题组).
    await segments.first().click();
    await until(async () => (await page.locator('.wb-dist-seg').count()) === 1, 'the list to narrow to one deck');
    assert.match(await page.locator('.wb-filter-result').innerText(), /显示 24 \/ 共 48 题/);
    assert.equal(await page.locator('.wb-group-toggle').first().getAttribute('aria-expanded'), 'true', 'the narrowed group is open');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await running.server.close();
  }
});
