// Crop the 2.5.8 product screenshots (site/assets/shots/*.png, 2360x1560 = 1180x780 @2x,
// see the screenshot notes) to the part each section needs, and encode WebP at the widths
// the page's srcset asks for. Encoding runs in Edge (canvas.toBlob('image/webp')), so there
// is no new dependency. Needs the site preview (node scripts/site-server.mjs) on :4321.
//
//   node scripts/site-crop.mjs            writes site/assets/shot-<slot>-<width>.webp
//
// A screenshot used as evidence has to be legible, or it is just texture: each crop keeps
// the text at roughly 12–16 CSS px at the width the page shows it.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const BASE = process.env.SITE || 'http://localhost:4321';
const Q = 0.82;

// [slot, source, x, y, w, h, widths] — coordinates in the source image's own pixels.
const crops = [
  ['desk-dark', 'library-home-dark', 0, 0, 2360, 1560, [960, 1600, 2360]],
  ['desk-light', 'library-light', 0, 0, 2360, 1560, [960, 1600, 2360]],
  ['import', 'audio-dark', 555, 150, 1717, 1390, [960, 1600]],
  ['cite-reader', 'reader-cited-dark', 0, 265, 1640, 1198, [960, 1600]],
  ['cite-draft', 'draft-citations-dark', 578, 132, 1074, 623, [720, 1074]],
  ['explain', 'review-wrong-dark', 740, 316, 1470, 1180, [960, 1470]],
  ['exam', 'exam-dark', 177, 153, 2095, 1097, [960, 1600]],
  ['skeleton', 'skeleton-dark', 548, 488, 1730, 900, [960, 1600]],
  ['stats', 'stats-dark', 520, 931, 1788, 540, [960, 1600]],
];

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'msedge' });
const page = await browser.newPage();
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

for (const [slot, src, x, y, w, h, widths] of crops) {
  for (const width of widths) {
    const b64 = await page.evaluate(async ({ url, x, y, w, h, width, q }) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const height = Math.round((h * width) / w);
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      const g = c.getContext('2d');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, x, y, w, h, 0, 0, width, height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/webp', q));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, { url: `${BASE}/assets/shots/${src}.png`, x, y, w, h, width, q: Q });
    const out = `site/assets/shot-${slot}-${width}.webp`;
    const buf = Buffer.from(b64, 'base64');
    await writeFile(out, buf);
    console.log(`${out}  ${width}x${Math.round((h * width) / w)}  ${(buf.length / 1024).toFixed(1)} KB  (from ${src} ${x},${y} ${w}x${h})`);
  }
}

await browser.close();
