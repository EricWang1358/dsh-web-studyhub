/* global document, getComputedStyle, NodeFilter */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium, skipMissingChromium } from '../scripts/qa/browser.mjs';
import { seedLibrary } from '../scripts/qa/perf-seed.mjs';
import { frames, openPage, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* #1073 round 3: the library home in a real browser, in both languages at 1440 and 420 px. A button never lets its text or its icon out of its own box (the English 「Continue →」 of a deck
   row overflowed a fixed 72px pill by 6px on each side), the play slots of all the rows are one width, and the eyebrow of a resume row breaks at words, not inside 「继续上次学习」. */

/** Every visible button whose text or icon sticks out of it: [{ text, side, by }]. */
const overflowing = (page) => page.evaluate(() => {
  const out = [];
  for (const button of document.querySelectorAll('button')) {
    const box = button.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(button).visibility === 'hidden') continue;
    const parts = [];
    for (const child of button.querySelectorAll('svg, img')) if (child.getClientRects().length && !child.closest('[aria-hidden="true"][style*="visibility"]')) parts.push(child.getBoundingClientRect());
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const parent = node.parentElement;
      if (getComputedStyle(parent).visibility === 'hidden') continue;
      // Range rectangles include glyphs past a nested ellipsis, even when the ancestor clips them before the button edge.
      let leftEdge = -Infinity, rightEdge = Infinity;
      for (let element = parent; element !== button; element = element.parentElement) {
        const style = getComputedStyle(element);
        if (style.textOverflow !== 'ellipsis' || style.overflowX === 'visible') continue;
        const clip = element.getBoundingClientRect();
        leftEdge = Math.max(leftEdge, clip.left);
        rightEdge = Math.min(rightEdge, clip.right);
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        const left = Math.max(leftEdge, rect.left), right = Math.min(rightEdge, rect.right);
        if (right > left) parts.push({ left, right });
      }
    }
    for (const rect of parts) {
      if (rect.left < box.left - 0.5) out.push({ text: button.textContent.trim().slice(0, 30), cls: String(button.className).slice(0, 40), side: 'left', by: +(box.left - rect.left).toFixed(1) });
      else if (rect.right > box.right + 0.5) out.push({ text: button.textContent.trim().slice(0, 30), cls: String(button.className).slice(0, 40), side: 'right', by: +(rect.right - box.right).toFixed(1) });
    }
  }
  return out;
});

test('the button fit probe detects visible text beyond a nested clipping box', async t => {
  let browser;
  try { browser = await launchChromium(); }
  catch (error) { skipMissingChromium(t, error); return; }
  try {
    const page = await browser.newPage();
    await page.setContent('<style>button{width:100px;padding:0;border:0;text-align:left} .label{display:block;width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}</style><button><span class="label"><span>Long text that extends well past this narrow button</span></span></button>');
    assert.deepEqual(await overflowing(page), []);
    const label = page.locator('.label');
    await label.evaluate(element => { element.style.overflow = 'visible'; });
    assert.ok((await overflowing(page)).some(overflow => overflow.side === 'right'), 'unclipped text escapes the button');
    await label.evaluate(element => { element.style.overflow = 'hidden'; element.style.width = '130px'; });
    assert.ok((await overflowing(page)).some(overflow => overflow.by > 20), 'a clip that itself extends beyond the button still overflows');
  } finally { await browser.close(); }
});

test('library home: no button lets its text or icon out, the play slots are one width, and the resume eyebrow does not orphan a character (zh and en, 1440 and 420 px)', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); }
  catch (error) { skipMissingChromium(t, error); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-deck-fit-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: (root) => seedLibrary(root, { sources: 2, decks: 4, cardsPerDeck: 8, runs: 4, attempts: 0, courses: 1, largeSources: 0 }) });
  try {
    for (const lang of ['en', 'zh']) {
      for (const width of [1440, 420]) {
        const where = `${lang} ${width}px`;
        const { page, context, errors } = await openPage(browser, running, { lang, theme: 'light', width, height: 900 });
        await page.goto(running.server.url);
        await page.locator('.map-deck').first().waitFor({ timeout: 60000 });
        await page.keyboard.press('Escape');
        await settleAnimations(page);
        await frames(page, 4);
        // Start a run on the first deck and come back: its row now says 继续 / Continue, the others keep the idle ▶.
        await page.locator('.deck-row .map-play').first().click();
        await page.locator('.question-card, .flash-area').first().waitFor({ timeout: 30000 });
        await (await revealNavRow(page, 'library')).dispatchEvent('click');
        await page.locator('.map-play.is-run').first().waitFor({ timeout: 30000 });
        await settleAnimations(page);
        await frames(page, 4);

        assert.deepEqual(await overflowing(page), [], `${where}: every button holds its text and its icon`);

        // One width for every play slot of a deck row, run or not (the idle ▶ keeps the room of the 继续 → beside it).
        const widths = await page.evaluate(() => [...document.querySelectorAll('.deck-row .map-play')].map((button) => Math.round(button.getBoundingClientRect().width * 10) / 10));
        assert.ok(widths.length >= 2 && new Set(widths).size === 1, `${where}: the play slots are one width (${widths.join(', ')})`);

        // The gap before the arrow of 继续 is the row-end gap, 8px, like the resume row's counter.
        const gap = await page.evaluate(() => {
          const face = document.querySelector('.deck-row .map-play.is-run .map-play__face');
          const text = face && [...face.childNodes].find((node) => node.nodeType === 3), icon = face?.querySelector('svg');
          if (!text || !icon) return null;
          const range = document.createRange();
          range.selectNodeContents(text);
          return Math.round((icon.getBoundingClientRect().left - range.getBoundingClientRect().right) * 10) / 10;
        });
        assert.equal(gap, 8, `${where}: 8px between 继续 and its arrow`);

        // The resume list: its eyebrow is one line, and the counter is one line.
        const details = page.locator('details.resume-list').first();
        if (await details.count()) {
          if (!(await details.evaluate((element) => element.open))) await details.locator('summary').first().click();
          await until(async () => (await page.locator('.resume').count()) > 0, 'the resume rows');
          await frames(page, 3);
          const lines = await page.evaluate(() => [...document.querySelectorAll('.resume .resume__eyebrow, .resume .row-end')].map((element) => {
            // The text only (the icon beside it sits a pixel off the baseline and is not a line).
            const tops = new Set();
            for (const node of element.childNodes) {
              if (node.nodeType !== 3 || !node.textContent.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              for (const rect of range.getClientRects()) tops.add(Math.round(rect.top));
            }
            return { cls: element.className, lines: tops.size };
          }));
          assert.ok(lines.length >= 2, `${where}: resume rows are there`);
          for (const line of lines) assert.equal(line.lines, 1, `${where}: ${line.cls} stays on one line`);
          assert.deepEqual(await overflowing(page), [], `${where}: the resume rows hold their text too`);
        }
        assert.deepEqual(errors.filter((message) => !/Failed to load resource/.test(message)), [], where);
        await context.close();
      }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
