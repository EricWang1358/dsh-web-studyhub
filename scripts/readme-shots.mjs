// Generate bilingual (zh/en) dark & light WebP showcase screenshots for README.md and README.zh-CN.md.
// Runs completely offline against local builds of site/ and web-demo/ using bundled sample data.
// Manual re-shoot only (not run in CI): node scripts/readme-shots.mjs
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoClient } from './build-demo.mjs';
import { launchChromium } from './qa/browser.mjs';
import { scrubProcessEnv } from './qa/env.mjs';
import { buildSite } from './site-build.mjs';
import { createSiteServer } from './site-server.mjs';

scrubProcessEnv();

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT_DIR = resolve(ROOT, 'docs/assets/readme');
const WORK_DIR = resolve(ROOT, 'output/readme-shots');

const ALL_SLOTS = ['hero', 'explorer', 'desk', 'companion', 'practice', 'reader', 'exam'];
const slotsArg = process.argv.find((arg) => arg.startsWith('--slots='))?.slice('--slots='.length);
const SELECTED_SLOTS = new Set(
  slotsArg ? slotsArg.split(',').map((s) => s.trim()).filter(Boolean) : ALL_SLOTS,
);
const want = (slot) => SELECTED_SLOTS.has(slot);

const MAX_FILE_BYTES = 150 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

const DEMO_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

async function serveDemoDir(dir) {
  const rootDir = resolve(dir);
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const target = resolve(rootDir, '.' + rel);
      if (!target.startsWith(rootDir + sep)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(target);
      res.writeHead(200, {
        'content-type': DEMO_MIME[extname(target)] || 'application/octet-stream',
        'cache-control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail);
      done();
    });
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => {
      server.close(done);
      server.closeAllConnections();
    }),
  };
}

async function encodeWebp(encoderPage, pngBuffer, { targetWidth, quality }) {
  const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`;
  const b64 = await encoderPage.evaluate(async ({ src, targetWidth: w, quality: q }) => {
    const img = new globalThis.Image();
    img.src = src;
    await img.decode();
    const outW = w || img.naturalWidth;
    const outH = Math.round((img.naturalHeight * outW) / img.naturalWidth);
    const canvas = globalThis.document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, outW, outH);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', q));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }, { src: dataUrl, targetWidth, quality });
  return Buffer.from(b64, 'base64');
}

const writtenSizes = [];

async function saveShot(encoderPage, page, name, { targetWidth, quality }) {
  const png = await page.screenshot({ type: 'png' });
  let q = quality;
  let webp = await encodeWebp(encoderPage, png, { targetWidth, quality: q });
  while (webp.length > MAX_FILE_BYTES && q > 0.55) {
    q = Math.max(0.55, Number((q - 0.06).toFixed(2)));
    webp = await encodeWebp(encoderPage, png, { targetWidth, quality: q });
  }
  if (webp.length > MAX_FILE_BYTES) {
    throw new Error(`${name}.webp exceeded 150 KB budget (${webp.length} bytes even at q=${q})`);
  }
  const dest = join(OUT_DIR, `${name}.webp`);
  await writeFile(dest, webp);
  writtenSizes.push({ name, bytes: webp.length, q });
  console.log(`wrote docs/assets/readme/${name}.webp (${(webp.length / 1024).toFixed(1)} KB, q=${q})`);
}

async function closeAnyDialogs(page) {
  for (let i = 0; i < 4; i++) {
    const closeBtn = page.locator('dialog[open] .sh-dialog__close, dialog[open] button[aria-label*="Close"], dialog[open] button[aria-label*="关闭"]').last();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(200);
    } else {
      break;
    }
  }
}

async function clickNav(page, id) {
  const item = page.locator(`[data-tour="nav-${id}"]`).first();
  if (!(await item.isVisible().catch(() => false))) {
    const more = page.locator('[data-tour="nav-more"]').first();
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      await page.waitForTimeout(200);
    }
  }
  await item.waitFor({ state: 'visible', timeout: 15000 });
  await item.click();
}

async function stepToSingleChoiceAndReveal(page) {
  await page.waitForSelector('.options .option, .flashcard-stage, .reveal-btn', { timeout: 15000 });
  for (let i = 0; i < 8; i++) {
    const liveOption = page.locator('.options .option:not([disabled])').first();
    if (await liveOption.isVisible().catch(() => false)) {
      const options = page.locator('.options .option:not([disabled])');
      const count = await options.count();
      // Pick the second option when multiple exist so feedback reveals both correctness and per-option explanations.
      await options.nth(Math.min(1, count - 1)).click();
      await page.waitForSelector('.options .option[disabled]', { timeout: 10000 });
      await page.waitForTimeout(450);
      return;
    }
    const nextBtn = page.locator('.question-nav button, .review-actions button').filter({ hasText: /下一题|Next/i }).first();
    if (await nextBtn.isVisible().catch(() => false)) {
      await nextBtn.click();
      await page.waitForTimeout(350);
      continue;
    }
    break;
  }
}

await rm(WORK_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });
await mkdir(join(WORK_DIR, 'site-dist'), { recursive: true });
await mkdir(join(WORK_DIR, 'demo-dist'), { recursive: true });

await buildSite({ outdir: join(WORK_DIR, 'site-dist') });
await buildDemoClient({ outdir: join(WORK_DIR, 'demo-dist') });
await writeFile(
  join(WORK_DIR, 'demo-dist', 'index.html'),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>StudyHub</title><link rel="stylesheet" href="./app.css"></head><body><div id="root"></div><script type="module" src="./app.js"></script></body></html>',
);

const siteServer = await createSiteServer({ root: join(WORK_DIR, 'site-dist') });
const demoServer = await serveDemoDir(join(WORK_DIR, 'demo-dist'));
const browser = await launchChromium();

try {
  const encoderPage = await browser.newPage();
  await encoderPage.setContent('<!doctype html><meta charset="utf-8">');

  // 1. Landing Hero (1440x1040 @2x -> 1440w) and Architecture Explorer (1280x832 @2x -> 1200w)
  if (want('hero') || want('explorer')) {
    for (const lang of ['en', 'zh']) {
      if (want('hero')) {
        for (const theme of ['dark', 'light']) {
          const heroCtx = await browser.newContext({
            viewport: { width: 1440, height: 1040 },
            deviceScaleFactor: 2,
            reducedMotion: 'reduce',
            colorScheme: theme,
          });
          const heroPage = await heroCtx.newPage();
          await heroPage.route('**/*', (route) => (new URL(route.request().url()).origin === siteServer.url ? route.continue() : route.abort()));
          await heroPage.goto(`${siteServer.url}/${lang === 'en' ? 'en.html' : 'index.html'}`, { waitUntil: 'networkidle' });
          await heroPage.waitForFunction(() => globalThis.window?.STUDY_DEMO && globalThis.document.querySelectorAll('.rail-node').length === 9);
          await heroPage.evaluate(async () => {
            for (const image of globalThis.document.images) {
              image.loading = 'eager';
              await image.decode().catch(() => {});
            }
          });
          await heroPage.locator('#hero').evaluate((el) => el.scrollIntoView({ block: 'start' }));
          await heroPage.waitForTimeout(300);
          await saveShot(encoderPage, heroPage, `hero-${lang}-${theme}`, { targetWidth: 1440, quality: 0.86 });
          await heroCtx.close();
        }
      }

      if (want('explorer')) {
        const expCtx = await browser.newContext({
          viewport: { width: 1280, height: 832 },
          deviceScaleFactor: 2,
          reducedMotion: 'reduce',
          colorScheme: 'dark',
        });
        const expPage = await expCtx.newPage();
        await expPage.route('**/*', (route) => (new URL(route.request().url()).origin === siteServer.url ? route.continue() : route.abort()));
        await expPage.goto(`${siteServer.url}/${lang === 'en' ? 'explorer-en.html' : 'explorer.html'}`, { waitUntil: 'networkidle' });
        await expPage.waitForFunction(() => globalThis.window?.STUDY_DEMO && globalThis.document.querySelectorAll('.rail-node').length === 4);
        await expPage.evaluate(() => globalThis.window.scrollTo(0, 0));
        await expPage.waitForTimeout(250);
        await saveShot(encoderPage, expPage, `explorer-${lang}-dark`, { targetWidth: 1200, quality: 0.85 });

        await expPage.locator('#themeToggle').click();
        await expPage.waitForTimeout(250);
        await saveShot(encoderPage, expPage, `explorer-${lang}-light`, { targetWidth: 1200, quality: 0.85 });
        await expCtx.close();
      }
    }
  }

  // 2. App workflows from static web-demo (1280x820 @2x -> 1200w)
  if (['desk', 'companion', 'practice', 'reader', 'exam'].some(want)) {
    for (const lang of ['en', 'zh']) {
      for (const theme of ['dark', 'light']) {
        const ctx = await browser.newContext({
          viewport: { width: 1280, height: 820 },
          deviceScaleFactor: 2,
          reducedMotion: 'reduce',
          colorScheme: theme,
          locale: lang === 'en' ? 'en-US' : 'zh-CN',
        });
        await ctx.addInitScript(({ uiLang, uiTheme }) => {
          try {
            globalThis.localStorage.setItem('study-ui-language', uiLang);
            globalThis.localStorage.setItem('study-theme', uiTheme);
          } catch { /* storage blocked in synthetic context */ }
        }, { uiLang: lang, uiTheme: theme });

        const page = await ctx.newPage();
        await page.route('**/*', (route) => (new URL(route.request().url()).origin === demoServer.url ? route.continue() : route.abort()));
        await page.goto(demoServer.url, { waitUntil: 'networkidle' });
        await page.addStyleTag({ content: '.public-demo-banner { display: none !important; }' });
        await page.waitForSelector('.study-app .desk .today-card', { timeout: 15000 });
        await page.waitForTimeout(600);

        // (a) Study library desk
        if (want('desk')) {
          await page.evaluate(() => globalThis.window.scrollTo(0, 0));
          await saveShot(encoderPage, page, `desk-${lang}-${theme}`, { targetWidth: 1200, quality: 0.85 });
        }

        // (b) Interactive Companion parametric math sandbox
        if (want('companion')) {
          await page.setViewportSize({ width: 1560, height: 940 });
          await clickNav(page, 'sources');
          await page.waitForSelector('article.source-doc details.source-row-actions > summary', { timeout: 15000 });
          await page.waitForTimeout(300);
          const dampingRow = page.locator('article.source-doc').filter({ hasText: /Critical Damping|临界阻尼/i }).first();
          const targetRow = (await dampingRow.isVisible().catch(() => false))
            ? dampingRow
            : page.locator('article.source-doc').filter({ has: page.locator('button.source-row-menu__btn', { hasText: /Open interactive companion|打开交互伴学页/i }) }).first();
          await targetRow.locator('details.source-row-actions > summary').click();
          const openCompanionBtn = targetRow
            .locator('button.source-row-menu__btn')
            .filter({ hasText: /Open interactive companion|打开交互伴学页/i })
            .first();
          await openCompanionBtn.waitFor({ state: 'visible', timeout: 10000 });
          await openCompanionBtn.click();
          const expandStage = page.locator('dialog[open] button[aria-pressed="false"]').first();
          if (await expandStage.isVisible().catch(() => false)) {
            await expandStage.click();
          }
          const frame = page.frameLocator('iframe.sh-comp-viewer__frame');
          await frame.locator('#count.toc__btn').waitFor({ state: 'visible', timeout: 15000 });
          // Headless Linux containers often lack OpenType Math fonts (Latin Modern / STIX), so Chromium's
          // `text-transform: math-auto` maps Greek <mi> (ζ, ω) to missing U+1D7xx glyphs. Keep standard Greek
          // code points styled in italic serif so formulas render crisply without tofu boxes.
          await frame.locator('head').evaluate((head) => {
            const style = head.ownerDocument.createElement('style');
            style.textContent = 'math, math * { font-family: "DejaVu Serif", "DejaVu Sans", "WenQuanYi Micro Hei", serif !important; text-transform: none !important; } math mi { font-style: italic; }';
            head.appendChild(style);
          });
          await frame.locator('#count.toc__btn').click();
          await frame.locator('.toc__item').nth(6).click();
          await frame.locator('.sbox svg').first().waitFor({ state: 'visible', timeout: 15000 });
          await page.waitForTimeout(500);
          await saveShot(encoderPage, page, `companion-${lang}-${theme}`, { targetWidth: 1200, quality: 0.85 });
          await closeAnyDialogs(page);
          await page.setViewportSize({ width: 1280, height: 820 });
        }

        // (c) Practice & per-option grading feedback
        if (want('practice') || want('reader')) {
          await clickNav(page, 'library');
          await page.waitForSelector('.today-card .today-go', { timeout: 15000 });
          await page.locator('.today-card .today-go').click();
          await stepToSingleChoiceAndReveal(page);
          if (want('practice')) {
            await saveShot(encoderPage, page, `practice-${lang}-${theme}`, { targetWidth: 1200, quality: 0.85 });
          }

          // (d) Source reader opened from question citation (amber highlight + linked question)
          if (want('reader')) {
            const citeSummary = page.locator('.citation-disclosure summary').first();
            if (await citeSummary.isVisible().catch(() => false)) {
              await citeSummary.click();
              const citeBtn = page.locator('.citation-disclosure .citations__button').first();
              await citeBtn.waitFor({ state: 'visible', timeout: 10000 });
              await citeBtn.click();
            } else {
              await clickNav(page, 'sources');
              await page.waitForSelector('article.source-doc button.source-main', { timeout: 15000 });
              await page.locator('article.source-doc button.source-main').first().click();
            }
            await page.waitForSelector('.study-document-viewer .reader-toolbar', { timeout: 15000 });
            await page.waitForTimeout(550);
            // Opening the citation scrolls the question column; put every pane except the reader back at its top
            // so the shot starts at the question header instead of mid-answer.
            await page.evaluate(() => {
              for (const el of globalThis.document.querySelectorAll('*')) {
                if (el.scrollTop > 0 && !el.closest('.study-document-viewer')) el.scrollTop = 0;
              }
              globalThis.window.scrollTo(0, 0);
            });
            await page.waitForTimeout(200);
            await saveShot(encoderPage, page, `reader-${lang}-${theme}`, { targetWidth: 1200, quality: 0.85 });
            await closeAnyDialogs(page);
          }
        }

        // (e) Timed Mock Exam paper
        if (want('exam')) {
          await clickNav(page, 'exam');
          await page.waitForSelector('[data-tour="exam-start"] button.sh-btn--primary', { timeout: 15000 });
          await page.locator('[data-tour="exam-start"] button.sh-btn--primary').click();
          await page.waitForSelector('.exam-card[data-exam-paper] .exam-options .exam-option', { timeout: 15000 });
          await page.locator('.exam-card[data-exam-paper] .exam-options .exam-option').first().click();
          await page.waitForTimeout(450);
          await saveShot(encoderPage, page, `exam-${lang}-${theme}`, { targetWidth: 1200, quality: 0.85 });
        }

        await ctx.close();
      }
    }
  }
} finally {
  await browser.close();
  await siteServer.close();
  await demoServer.close();
  await rm(WORK_DIR, { recursive: true, force: true });
}

const totalBytes = writtenSizes.reduce((sum, item) => sum + item.bytes, 0);
if (totalBytes > MAX_TOTAL_BYTES) {
  throw new Error(`Total docs/assets/readme size ${totalBytes} bytes exceeds 3 MB budget (${MAX_TOTAL_BYTES})`);
}
console.log(`README screenshots generated cleanly: ${writtenSizes.length} files, ${(totalBytes / 1024).toFixed(1)} KB total.`);
