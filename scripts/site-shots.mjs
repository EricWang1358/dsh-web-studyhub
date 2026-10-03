// Capture the intro page at fixed viewports, for design review and for the video pipeline.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const BASE = process.env.SITE || 'http://127.0.0.1:4322';
const OUT = 'output/site';
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge' });

async function shoot(name, width, height, fn) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await fn(page);
  await page.close();
}

const sections = ['hero', 'problem', 'capture', 'grounded', 'coach', 'structure', 'retention', 'speed', 'start'];

// Desktop: one screenshot per section, scrolled into place.
await shoot('desktop', 1440, 900, async (page) => {
  for (const id of sections) {
    await page.evaluate((s) => {
      document.querySelector('#' + s).scrollIntoView({ behavior: 'instant', block: 'start' });
    }, id);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${OUT}/d-${id}.png` });
  }
});

// The citation demo in its un-lit state (the button toggles it back).
await shoot('demo', 1440, 900, async (page) => {
  await page.evaluate(() => document.querySelector('#grounded').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(1800);
  await page.click('#citeBtn');
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/d-grounded-unlit.png` });
});

// The two driveable figures, mid-interaction.
await shoot('widgets', 1440, 900, async (page) => {
  await page.evaluate(() => document.querySelector('#retention').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(900);
  for (let i = 0; i < 4; i++) { await page.click('[data-sm2="pass"]'); await page.waitForTimeout(280); }
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/d-retention-played.png` });

  await page.evaluate(() => document.querySelector('#structure').scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(900);
  await page.click('#graphPlay');
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/d-structure-played.png` });
});

// Mobile.
await shoot('mobile', 390, 844, async (page) => {
  for (const id of ['hero', 'grounded', 'structure', 'start']) {
    await page.evaluate((s) => {
      document.querySelector('#' + s).scrollIntoView({ behavior: 'instant', block: 'start' });
    }, id);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${OUT}/m-${id}.png` });
  }
});

await browser.close();
console.log('shots written to ' + OUT);
