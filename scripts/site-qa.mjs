// Production QA for the intro page: viewports, keyboard path, focus, reduced motion.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.SITE || 'http://localhost:4321';
const OUT = 'output/site/qa';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge' });
const fail = [];
const ok = (cond, label, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!cond) fail.push(label);
};

// ── Viewports: horizontal scroll and overflow ──────────────────────────────
for (const [w, h, name] of [[360, 740, 'xs'], [390, 844, 'phone'], [768, 1024, 'tablet'], [1280, 800, 'laptop'], [1680, 1050, 'wide']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(scrollX <= 1, `${name} (${w}px) no horizontal scroll`, `overflow ${scrollX}px`);

  const overflowing = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return [...document.querySelectorAll('main *')]
      .filter((el) => el.getBoundingClientRect().right > vw + 2)
      .map((el) => el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0])
      .slice(0, 5);
  });
  ok(overflowing.length === 0, `${name} nothing past right edge`, overflowing.join(', '));
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  await page.close();
}

// ── Keyboard path + visible focus ──────────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // Arrow-down steps one section at a time.
  const before = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(1400);
  const after = await page.evaluate(() => window.scrollY);
  ok(after > before + 200, 'ArrowDown advances one section', `${before} -> ${after}`);

  await page.keyboard.press('End');
  await page.waitForTimeout(1600);
  const atEnd = await page.evaluate(() =>
    window.scrollY > document.documentElement.scrollHeight - window.innerHeight * 2.2);
  ok(atEnd, 'End reaches the install section');

  // Every focusable stop shows a visible outline.
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  let stops = 0, unfocusable = 0;
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      return { tag: el.tagName.toLowerCase(), outline };
    });
    if (!info) break;
    stops++;
    if (!info.outline) unfocusable++;
  }
  ok(stops > 8, 'keyboard reaches the rail and the links', `${stops} stops`);
  ok(unfocusable === 0, 'every focus stop has a visible ring', `${unfocusable} without`);
  await page.close();
}

// ── Reduced motion is a real reduction ─────────────────────────────────────
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const hidden = await page.evaluate(() =>
    [...document.querySelectorAll('.rise')].filter((el) => getComputedStyle(el).opacity === '0').length);
  ok(hidden === 0, 'reduced motion: no content left invisible', `${hidden} hidden`);

  await page.evaluate(() => document.querySelector('#grounded').scrollIntoView());
  await page.waitForTimeout(500);
  const litNow = await page.evaluate(() =>
    !document.querySelector('#demo mark').classList.contains('dim'));
  ok(litNow, 'reduced motion: the citation still resolves');
  await page.close();
}

// ── Content realism: a long unbroken string must not break the layout ──────
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => {
    document.querySelector('.q').textContent =
      'ThisIsAnAbsurdlyLongUnbrokenTokenThatShouldNotBlowOutTheCardWidth'.repeat(2);
  });
  await page.waitForTimeout(300);
  const scrollX = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(scrollX <= 1, 'long unbroken string does not force horizontal scroll', `overflow ${scrollX}px`);
  await page.close();
}

await browser.close();
console.log(fail.length ? `\n${fail.length} FAILING: ${fail.join(' | ')}` : '\nall checks passed');
process.exit(fail.length ? 1 : 0);
