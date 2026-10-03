// Re-shoot the product screens the intro page uses, at 2x.
// The page puts two screenshots in the same slot at the same width, so they must
// share a pixel density and a viewport geometry — otherwise one renders crisp and
// the other soft on any HiDPI display. Geometry matches snap-glow.mjs (1180x780 @2x),
// which is where site/assets/_src/library.png came from.
// Requires the dev preview on :4178 with a seeded library:
//   node scripts/seed-demo.mjs output/preview-library
import { chromium } from 'playwright';

const BASE = process.env.DEV || 'http://127.0.0.1:4179/';
const browser = await chromium.launch({
  headless: true,
  channel: process.env.PW_CHANNEL || 'msedge',
});
const ctx = await browser.newContext({
  viewport: { width: 1180, height: 780 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
const p = await ctx.newPage();

await p.goto(BASE, { waitUntil: 'networkidle' });
await p.waitForSelector('.study-app', { timeout: 15000 });
await p.waitForTimeout(1200);

// Start a run from the home card, then answer one single-choice question —
// a single choice submits on click and reveals the per-option explanations.
// The sidebar's onboarding hint also contains 开始学习, so match the main CTA,
// which always carries its question count.
await p.locator('button', { hasText: /开始学习\s*·\s*\d+\s*题/ }).first().click();
await p.waitForSelector('.options', { timeout: 20000 });
await p.waitForTimeout(1200);

// Options disable themselves once feedback is showing, so wait for a live one
// and step past any question that is already answered.
for (let i = 0; i < 6; i++) {
  const live = p.locator('.options .option:not([disabled])').first();
  if (await live.count().then((n) => n > 0).catch(() => false)) break;
  const next = p.locator('button', { hasText: '下一题' }).first();
  if (await next.isVisible().catch(() => false)) {
    await next.click();
    await p.waitForTimeout(1200);
  } else {
    await p.waitForTimeout(800);
  }
}

// The section this shot illustrates is about getting it wrong, so keep trying
// questions until an answer actually lands wrong — the correct option's position
// is shuffled, so this is the only reliable way to reach that state.
let wrong = false;
for (let attempt = 0; attempt < 6 && !wrong; attempt++) {
  const live = p.locator('.options .option:not([disabled])');
  const n = await live.count();
  if (!n) break;
  // Bias away from the first option, which the fixture tends to make correct.
  await live.nth(Math.min(n - 1, 1 + (attempt % 2))).click({ timeout: 15000 });
  await p.waitForSelector('.options .option[disabled]', { timeout: 10000 });
  await p.waitForTimeout(900);
  wrong = await p.locator('text=你的选择').first().isVisible().catch(() => false);
  if (!wrong) {
    const next = p.locator('button', { hasText: '下一题' }).first();
    if (!(await next.isVisible().catch(() => false))) break;
    await next.click();
    await p.waitForTimeout(1600);
  }
}
if (!wrong) console.warn('warning: could not reach a wrong-answer state; shot shows a correct answer');
await p.waitForTimeout(900);
await p.screenshot({ path: 'site/assets/_src/review.png' });

// Library last, so the catalogue actually carries mastery colour — a tree of
// 0% grey bars illustrates nothing about mastery.
await p.locator('button', { hasText: '返回学习库' }).first().click();
await p.waitForTimeout(2000);
await p.screenshot({ path: 'site/assets/_src/library.png' });

await browser.close();
console.log('re-shot library.png and review.png at 1180x780 @2x');
