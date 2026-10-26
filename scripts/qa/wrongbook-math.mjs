/* global document, getComputedStyle */
/* node scripts/qa/wrongbook-math.mjs [--out <dir>] [--lang zh|en] [--theme dark|light]
   The mistakes page with formulas in an opened row: the prompt line, 你的答案 / 正确答案 / 解析 / 易错点 and a long unbroken formula must be drawn
   as formulas (MathML), stay inside the page at 1280 and 420 px, and never scroll sideways. A seeded temporary library, the preview's fake model,
   every key variable removed (scripts/qa/layout-late.mjs). Prints one JSON line per width; exits 1 when a check fails. */
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { buildPreview } from '../build.mjs';
import { launchChromium } from './browser.mjs';
import { Store } from '../../lib/store.js';
import { frames, openPage, seedWrongBookLibrary, settleAnimations, startLateServer, until } from './layout-late.mjs';

export const MATH_CARD = {
  prompt: String.raw`某银行一年期整存整取年利率为$1.1\%$。把$20000$元存入一年期，第一年期满后把本金和利息一起转存一年期，第二年利息约为多少元？`,
  answer: String.raw`$20220\times1.1\%=222.42$元，所以第二年利息约为 222 元。`,
  explanation: String.raw`逐年转存时，每满一年的利息并入本金，成为下一年的计息本金。第一年利息 220 元并入后，第二年计息本金为$20000+220=20220$元，利率仍是所存一年期的$1.1\%$，故第二年利息为$20220\times1.1\%=222.42$元，按“算至分位”的规定取到分。物理里同理：$ F = ma $，$v=\sqrt{\frac{2GM}{r}}$，质量为5$kg$的物体，$\vec{F}=m\vec{a}$。`,
  misconception: String.raw`最容易把第二年本金仍当作最初的$20000$元，从而算得$220$元。`,
  long: String.raw`$$\text{总利息}=20000\times1.1\%+20220\times1.1\%+20442.42\times1.1\%+20667.28\times1.1\%+20894.72\times1.1\%+21124.7\times1.1\%$$`,
};

async function seed(root) {
  const seeded = await seedWrongBookLibrary(root, { wrong: 8 });
  const store = new Store(root);
  await store.update((library) => {
    // Every card carries the formulas, so whichever row the page opens first shows them.
    for (const card of library.decks.flatMap((deck) => deck.cards))
      Object.assign(card, { prompt: MATH_CARD.prompt, answer: MATH_CARD.answer, explanation: `${MATH_CARD.explanation}\n\n${MATH_CARD.long}`, misconception: MATH_CARD.misconception });
  });
  return seeded;
}

const measure = (page) => page.evaluate(() => {
  const box = document.querySelector('.wb-detail');
  const root = document.documentElement;
  // What a box clips or scrolls (a long formula in its .md-math, a one-line prompt cut with an ellipsis) is not the page overflowing.
  const clipped = (el) => { for (let up = el.parentElement; up && up !== box?.parentElement; up = up.parentElement) { if (getComputedStyle(up).overflowX !== 'visible' && el.getBoundingClientRect().right > up.getBoundingClientRect().right + 1) return true; } return false; };
  const wide = [...document.querySelectorAll('.wb-detail, .wb-detail *')].filter((el) => el.getBoundingClientRect().right > root.clientWidth + 1
    && getComputedStyle(el).position !== 'fixed' && !clipped(el));
  return {
    formulas: box ? box.querySelectorAll('math').length : 0,
    rawDollars: box ? (box.textContent.match(/\$[^$]*\$/g) || []).length : -1,
    rawRowPrompt: (document.querySelector('.wb-row .wb-prompt')?.textContent.match(/\$/g) || []).length,
    rowFormulas: document.querySelectorAll('.wb-row .wb-prompt math').length,
    scrollsSideways: root.scrollWidth > root.clientWidth + 1,
    boxRight: box ? Math.round(box.getBoundingClientRect().right) : null,
    sample: box ? box.textContent.replace(/\s+/g, ' ').slice(0, 160) : '',
    wide: wide.slice(0, 4).map((el) => `${el.tagName}.${String(el.className).slice(0, 30)} ${Math.round(el.getBoundingClientRect().right)}`),
  };
});

export async function run({ lang = 'zh', theme = 'dark', out = null, widths = [1280, 420] } = {}) {
  const browser = await launchChromium();
  const dist = await mkdtemp(join(tmpdir(), 'study-wb-math-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed, lang });
  const results = [];
  try {
    for (const width of widths) {
      const { page, errors, context } = await openPage(browser, running, { lang, theme, width });
      await page.goto(running.server.url);
      await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
      await page.locator('[data-tour="nav-wrongbook"]').first().dispatchEvent('click');
      await page.locator('.wb-group .wb-group-toggle').first().waitFor({ timeout: 30000 });
      await page.locator('.wb-group .wb-group-toggle').first().dispatchEvent('click');
      await page.locator('.wb-group .wb-row-toggle').first().waitFor({ timeout: 30000 });
      await page.locator('.wb-group .wb-row-toggle').first().dispatchEvent('click');
      await page.locator('.wb-detail .wb-fact').first().waitFor({ timeout: 30000 });
      // The formula drawer is a lazy chunk: give it a moment, then measure whatever is on the page (a broken page has no formulas to wait for).
      await until(() => page.evaluate(() => !document.querySelector('.wb-detail .md-math:not(:has(math)):not(:has(.md-math-source))')), 'the formulas to settle');
      await page.waitForTimeout(800);
      await settleAnimations(page);
      await frames(page, 4);
      const state = await measure(page);
      await page.locator('.wb-detail').first().scrollIntoViewIfNeeded();
      if (out) { await mkdir(out, { recursive: true }); await page.screenshot({ path: join(out, `wrongbook-math-${width}-${lang}-${theme}.png`), fullPage: false }); }
      results.push({ width, ...state, errors });
      await context.close();
    }
  } finally { await browser.close(); await running.close(); }
  return results;
}

const flag = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : fallback; };
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('wrongbook-math.mjs')) {
  const out = flag('out', null);
  const results = await run({ lang: flag('lang', 'zh'), theme: flag('theme', 'dark'), out: out ? resolve(out) : null });
  let failed = false;
  for (const r of results) {
    console.log(JSON.stringify(r));
    if (r.formulas < 5 || r.rawDollars > 0 || r.rowFormulas < 1 || r.scrollsSideways || r.wide.length || r.errors.length) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
