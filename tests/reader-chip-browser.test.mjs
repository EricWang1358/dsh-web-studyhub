/* global document, getSelection, getComputedStyle, NodeFilter, MouseEvent */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { bilingualMarkdown } from './helpers/bilingual-transcript.mjs';
import { until } from './helpers/wait.mjs';

/* #231: the 译 chip of a selection sits at the end of the selection (above it, never paragraphs away), at any interface size, wide and narrow,
   and keeps following it while the reader scrolls. The cause was the interface zoom: rectangles are screen pixels, the chip's left/top are
   CSS pixels inside the zoomed app, so at 150% it landed 1.5 times as far from the page's origin as the selection. The chip and the 原文
   view's floating card now place themselves with the shared anchoring (ui/components/use-dismiss.js placeInHost, the Menu's measuring). */

const WORDS = 'two groups find each other';

/** A preview whose model translates reader passages the way the real one answers (the shared fake model has no passage translator): "[译] <text>" per passage. */
async function startTranslatingServer({ distDir, seed }) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-chip-'));
  const root = join(base, 'library');
  await seed(root);
  const model = async (system, prompt) => JSON.stringify({ translations: JSON.parse(prompt).passages.map((passage) => ({ id: passage.id, text: `【预览译文】${passage.text}` })) });
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model, distDir });
  return { server, close: async () => { await server.close(); await rm(base, { recursive: true, force: true }); } };
}

/** Select WORDS in the document's own text (the first paragraph that has them), as the learner's drag would, and tell the reader. */
const select = (page, words = WORDS) => page.evaluate((phrase) => {
  const body = document.querySelector('.study-document-body'), walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.data.indexOf(phrase);
    if (at < 0 || node.parentElement.closest('[data-study-marker]')) continue;
    const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + phrase.length);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return true;
  }
  return false;
}, words);

/** The chip, the selection's last rectangle, the visible reading area and every text line of the document, in screen pixels. */
const measure = (page, selector = '.tr-chipbtn') => page.evaluate((chipSelector) => {
  const box = (rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
  const chip = document.querySelector(chipSelector), selection = getSelection();
  const rects = selection.rangeCount ? selection.getRangeAt(0).getClientRects() : [];
  const body = document.querySelector('.study-document-body'), walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT), lines = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement.closest('[data-study-marker], script, style') || !node.data.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    for (const rect of range.getClientRects()) if (rect.width > 0) lines.push(box(rect));
  }
  const style = chip && getComputedStyle(chip);
  return { chip: chip && box(chip.getBoundingClientRect()), shown: !!chip && style.visibility !== 'hidden' && style.display !== 'none',
    last: rects.length ? box(rects[rects.length - 1]) : null, area: box(document.querySelector('.reader-scroll').getBoundingClientRect()), lines };
}, selector);

/** Scroll the reading area so the selection is in the middle of it (a learner selects what they can see; a narrow, zoomed reader shows little). */
const reveal = (page) => page.evaluate(() => {
  const scroller = document.querySelector('.reader-scroll'), area = scroller.getBoundingClientRect(), rects = getSelection().getRangeAt(0).getClientRects();
  scroller.scrollTop += (rects[rects.length - 1].top - (area.top + area.height / 2)) / (area.height / scroller.clientHeight); // scrollTop is in CSS pixels, the rectangles in screen pixels
});

const gap = (a, b) => Math.hypot(Math.max(0, a.left - b.right, b.left - a.right), Math.max(0, a.top - b.bottom, b.top - a.bottom));
const overlaps = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

test('the 译 chip stays at the end of the selection at 100% and 150%, wide and narrow, and after scrolling (#231)', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-chip-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: async (root) => {
    const runtime = createStudyRuntime(root);
    await runtime.call('materials.document.import', { filename: 'bilingual.md', dataBase64: Buffer.from(bilingualMarkdown()).toString('base64'), courses: ['QA'] });
    runtime.dispose();
  } });
  try {
    for (const [width, scale] of [[1280, 100], [1280, 150], [420, 100], [420, 150]]) {
      const label = `${width}px @${scale}%`;
      const { context, page, errors } = await openPage(browser, running, { width, height: 900 });
      await context.addInitScript((value) => { try { localStorage.setItem('study-interface', JSON.stringify({ scale: value })); } catch { /* blocked */ } }, scale);
      try {
        await page.goto(running.server.url);
        await page.locator('[data-tour="nav-sources"]').first().click().catch(() => {});
        await page.locator('.source-doc').first().locator('.source-main').click();
        await page.locator('.study-document-viewer').waitFor();
        await page.locator('.tr-mark').first().waitFor({ timeout: 30000 });

        assert.equal(await select(page), true, `${label}: the words are in the document`);
        await until(async () => (await measure(page)).chip, `${label}: the chip`);
        await reveal(page);
        let first;
        await until(async () => { first = await measure(page); return first.chip && first.last && first.shown && gap(first.chip, first.last) < 12; }, `${label}: the chip next to the end of the selection`);
        assert.ok(first.chip.top < first.last.top, `${label}: the chip is above the selection, not over what comes next`);
        for (const line of first.lines.filter((line) => line.top >= first.last.top - 1)) assert.ok(!overlaps(first.chip, line), `${label}: the chip covers the selected line or a line below it`);
        assert.ok(first.chip.left >= first.area.left - 1 && first.chip.right <= first.area.right + 1, `${label}: the chip is inside the reading area`);

        // Scrolling moves the text; the chip goes with it.
        await page.evaluate(() => { document.querySelector('.reader-scroll').scrollTop += 120; });
        let scrolled;
        await until(async () => { scrolled = await measure(page); return scrolled.last && scrolled.last.top !== first.last.top && gap(scrolled.chip, scrolled.last) < 12; }, `${label}: the chip next to the selection after scrolling`);
        assert.ok(scrolled.chip.top < scrolled.last.top, `${label}: after scrolling the chip is still above the selection`);

        // Under the top edge of the reading area there is no room above: the chip goes below instead of under the toolbar.
        await page.evaluate(() => {
          const scroller = document.querySelector('.reader-scroll'), range = getSelection().getRangeAt(0), rects = range.getClientRects();
          const area = scroller.getBoundingClientRect(), zoom = area.height / scroller.clientHeight; // scrollTop is in CSS pixels, the rectangles in screen pixels
          scroller.scrollTop += (rects[rects.length - 1].top - area.top - 4) / zoom; // the last line: a narrow reader wraps the words
        });
        let edge;
        await until(async () => { edge = await measure(page); return edge.last && edge.last.top - edge.area.top < 12 && edge.last.top - edge.area.top > -2 && edge.chip.top >= edge.area.top - 1; },
          `${label}: the chip inside the reading area with the selection at its top edge`);
        assert.ok(gap(edge.chip, edge.last) < 12, `${label}: at the top edge the chip is still next to the selection`);

        // Scrolled out of sight altogether: nothing floats over other text.
        await page.evaluate(() => { document.querySelector('.reader-scroll').scrollTop += 900; });
        let away;
        await until(async () => { away = await measure(page); return away.last && away.last.bottom < away.area.top && (!away.shown || away.chip.bottom < away.area.top || away.chip.top > away.area.bottom); },
          `${label}: no chip over other text once the selection is out of sight`);
        assert.deepEqual(errors, [], `${label}: no console errors`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});

test('the floating translation card of the 原文 view opens at the selection under the interface zoom, and the chip works there too (#231)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-chip-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startTranslatingServer({ distDir: dist, seed: async (root) => {
    const runtime = createStudyRuntime(root);
    await runtime.call('materials.document.import', { filename: 'bilingual.md', dataBase64: Buffer.from(bilingualMarkdown()).toString('base64'), courses: ['QA'] });
    runtime.dispose();
  } });
  try {
    for (const scale of [100, 150]) {
      const label = `原文 @${scale}%`;
      const { context, page, errors } = await openPage(browser, running, { width: 1280, height: 900 });
      await context.addInitScript((value) => { try { localStorage.setItem('study-interface', JSON.stringify({ scale: value })); } catch { /* blocked */ } }, scale);
      try {
        await page.goto(running.server.url);
        await page.locator('[data-tour="nav-sources"]').first().click().catch(() => {});
        await page.locator('.source-doc').first().locator('.source-main').click();
        await page.locator('.study-document-viewer').waitFor();
        await page.locator('.study-document-viewer .sh-seg__item', { hasText: '原文' }).click();
        await page.locator('.study-document-viewer[data-mode="text"]').waitFor();
        assert.equal(await select(page), true, `${label}: the words are in the text`);
        const first = await until(async () => { const m = await measure(page); return m.chip && m.last ? m : null; }, `${label}: the chip`);
        assert.ok(gap(first.chip, first.last) < 12, `${label}: the chip is ${Math.round(gap(first.chip, first.last))}px from the end of the selection`);
        await page.locator('.tr-chipbtn').click();
        const anchor = await until(() => page.evaluate(() => document.querySelector('.tr-float__anchor')?.getBoundingClientRect().toJSON() ?? null), `${label}: the card`);
        assert.ok(Math.abs(anchor.top - first.last.bottom) < 14, `${label}: the card's anchor is ${Math.round(anchor.top - first.last.bottom)}px below the selection end`);
        assert.ok(anchor.left >= first.area.left - 1 && anchor.left <= first.area.right, `${label}: the card opens inside the reading area`);
        // The translation arrives in the same card, and the card is still at the selection (the key changes from the call's to the kept one).
        const text = await until(() => page.locator('.tr-float .tr-block__text').first().textContent().catch(() => ''), `${label}: the translation in the card`);
        assert.match(text, /预览译文/);
        const kept = await page.evaluate(() => document.querySelector('.tr-float__anchor').getBoundingClientRect().toJSON());
        assert.ok(Math.abs(kept.top - first.last.bottom) < 14, `${label}: the finished card is ${Math.round(kept.top - first.last.bottom)}px below the selection end`);
        assert.deepEqual(errors, [], `${label}: no console errors`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
