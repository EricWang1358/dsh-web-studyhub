// Crop product screenshots down to the part a reader can actually read.
// A screenshot used as evidence has to be legible, or it is just texture.
import { chromium } from 'playwright';
const BASE = process.env.SITE || 'http://localhost:4321';

// [source, out, x, y, w, h] — coordinates in the source image's own pixels.
// Both sources are 2360x1560 (1180x780 @2x). The page shows these at ~760 CSS px,
// so each crop stays ~1900px wide to land at ~2.5x density; cropping tighter
// would make one figure soft next to the other on a HiDPI screen.
const crops = [
  ['site/assets/_src/library.png', 'site/assets/crop-decks.png', 440, 545, 1900, 636],
  ['site/assets/_src/review.png', 'site/assets/crop-options.png', 440, 455, 1900, 1105],
];

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge' });

for (const [src, out, x, y, w, h] of crops) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  const url = BASE + src.slice('site'.length);
  await page.setContent(
    `<!doctype html><meta charset="utf-8">
     <style>
       html,body{margin:0;background:#1d2126;overflow:hidden}
       img{position:absolute;left:${-x}px;top:${-y}px;max-width:none;width:auto;height:auto;display:block}
     </style>
     <img src="${url}">`,
    { waitUntil: 'load', baseURL: BASE },
  );
  await page.waitForFunction(() => {
    const i = document.querySelector('img');
    return i && i.complete && i.naturalWidth > 0;
  });
  await page.screenshot({ path: out });
  const dim = await page.evaluate(() => {
    const i = document.querySelector('img');
    return `${i.naturalWidth}x${i.naturalHeight}`;
  });
  await page.close();
  console.log(`${out}  (source ${dim}, crop ${w}x${h} at ${x},${y})`);
}

await browser.close();
