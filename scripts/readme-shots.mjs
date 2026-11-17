// Generate bilingual (zh/en) dark & light WebP showcase screenshots for README.md and README.zh-CN.md.
// Runs completely offline against local builds of site/ and web-demo/.
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDemoClient } from './build-demo.mjs';
import { launchChromium } from './qa/browser.mjs';
import { scrubProcessEnv } from './qa/env.mjs';
import { buildSite } from './site-build.mjs';

scrubProcessEnv();

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT_DIR = resolve(ROOT, 'docs/assets/readme');
const WORK_DIR = resolve(ROOT, 'output/readme-shots');

const MIME = {
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

async function serveDir(dir) {
  const rootDir = resolve(dir);
  const server = createServer(async (req, res) => {
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
        'content-type': MIME[extname(target)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
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

async function saveShot(encoderPage, page, name, opts) {
  const png = await page.screenshot({ type: 'png' });
  const webp = await encodeWebp(encoderPage, png, opts);
  const dest = join(OUT_DIR, `${name}.webp`);
  await writeFile(dest, webp);
  console.log(`wrote docs/assets/readme/${name}.webp (${(webp.length / 1024).toFixed(1)} KB)`);
}

async function closeAnyDialogs(page) {
  for (let i = 0; i < 3; i++) {
    const closeBtn = page.locator('dialog[open] .sh-dialog__close').last();
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(200);
    } else {
      break;
    }
  }
}

async function stepToSingleChoiceAndReveal(page) {
  await page.waitForSelector('.options .option, .flashcard-stage, .reveal-btn', { timeout: 15000 });
  for (let i = 0; i < 8; i++) {
    const liveOption = page.locator('.options .option:not([disabled])').first();
    if (await liveOption.isVisible().catch(() => false)) {
      const options = page.locator('.options .option:not([disabled])');
      const count = await options.count();
      // Pick the second option when multiple exist so feedback reveals both green right answer and explanation contrast.
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
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>StudyHub</title><link rel="stylesheet" href="./app.css"></head><body><div id="root"></div><script type="module" src="./app.js"></script></body></html>`,
);

const siteServer = await serveDir(join(WORK_DIR, 'site-dist'));
const demoServer = await serveDir(join(WORK_DIR, 'demo-dist'));
const browser = await launchChromium();

try {
  const encoderPage = await browser.newPage();
  await encoderPage.setContent('<!doctype html><meta charset="utf-8">');

  // 1. Landing Hero (1440x1040 @2x -> 1440w) and Architecture Explorer (1280x832 @2x -> 1200w)
  for (const lang of ['en', 'zh']) {
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
      await heroPage.locator('#hero').evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await heroPage.waitForTimeout(300);
      await saveShot(encoderPage, heroPage, `hero-${lang}-${theme}`, { targetWidth: 1440, quality: 0.88 });
      await heroCtx.close();
    }

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

  // 2. App workflows from static web-demo (1280x820 @2x -> 1200w)
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
        } catch { /* ignore */ }
      }, { uiLang: lang, uiTheme: theme });

      const page = await ctx.newPage();
      await page.route('**/*', (route) => (new URL(route.request().url()).origin === demoServer.url ? route.continue() : route.abort()));
      await page.goto(demoServer.url, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: '.public-demo-banner { display: none !important; }' });
      await page.waitForSelector('.study-app .desk .today-card', { timeout: 15000 });
      await page.waitForTimeout(600);

      // (a) Study library desk
      await page.evaluate(() => globalThis.window.scrollTo(0, 0));
      await saveShot(encoderPage, page, `desk-${lang}-${theme}`, { targetWidth: 1200, quality: 0.85 });

      // (b) Interactive Companion parametric math sandbox
      await page.locator('[data-tour="nav-sources"]').click();
      await page.waitForSelector('article.source-doc button.source-doc__action', { timeout: 15000 });
      await page.waitForTimeout(300);
      const dampingCompanionBtn = page
        .locator('article.source-doc')
        .filter({ hasText: /Critical Damping|临界阻尼/i })
        .locator('button.source-doc__action')
        .filter({ hasText: /Open interactive companion|打开交互伴学页/i })
        .first();
      const anyCompanionBtn = page
        .locator('article.source-doc button.source-doc__action')
        .filter({ hasText: /Open interactive companion|打开交互伴学页/i })
        .first();
      if (await dampingCompanionBtn.isVisible().catch(() => false)) {
        await dampingCompanionBtn.click();
      } else {
        await anyCompanionBtn.click();
      }
      const expandStage = page.locator('dialog[open] button[aria-pressed="false"]').first();
      if (await expandStage.isVisible().catch(() => false)) {
        await expandStage.click();
      }
      const frame = page.frameLocator('iframe.sh-comp-viewer__frame');
      await frame.locator('#count.toc__btn').waitFor({ state: 'visible', timeout: 15000 });
      await frame.locator('#count.toc__btn').click();
      await frame.locator('.toc__item').nth(6).click();
      await frame.locator('.sbox svg').first().waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForTimeout(500);
      await saveShot(encoderPage, page, `companion-${lang}-${theme}`, { targetWidth: 1200, quality: 0.85 });
      await closeAnyDialogs(page);

      // (c) Practice & per-option grading feedback
      await page.locator('[data-tour="nav-library"]').click();
      await page.waitForSelector('.today-card .today-go', { timeout: 15000 });
      await page.locator('.today-card .today-go').click();
      await stepToSingleChoiceAndReveal(page);
      await saveShot(encoderPage, page, `practice-${lang}-${theme}`, { targetWidth: 1200, quality: 0.85 });

      // (d) Source reader opened from question citation (amber highlight + linked question)
      const citeSummary = page.locator('.citation-disclosure summary').first();
      if (await citeSummary.isVisible().catch(() => false)) {
        await citeSummary.click();
        const citeBtn = page.locator('.citation-disclosure .citations__button').first();
        await citeBtn.waitFor({ state: 'visible', timeout: 10000 });
        await citeBtn.click();
      } else {
        await page.locator('[data-tour="nav-sources"]').click();
        await page.waitForSelector('article.source-doc button.source-main', { timeout: 15000 });
        await page.locator('article.source-doc button.source-main').first().click();
      }
      await page.waitForSelector('.study-document-viewer .reader-toolbar', { timeout: 15000 });
      await page.waitForTimeout(550);
      await saveShot(encoderPage, page, `reader-${lang}-${theme}`, { targetWidth: 1200, quality: 0.85 });
      await closeAnyDialogs(page);

      // (e) Timed Mock Exam paper
      await page.locator('[data-tour="nav-exam"]').click();
      await page.waitForSelector('[data-tour="exam-start"] button.sh-btn--primary', { timeout: 15000 });
      await page.locator('[data-tour="exam-start"] button.sh-btn--primary').click();
      await page.waitForSelector('.exam-card[data-exam-paper] .exam-options .exam-option', { timeout: 15000 });
      await page.locator('.exam-card[data-exam-paper] .exam-options .exam-option').first().click();
      await page.waitForTimeout(450);
      await saveShot(encoderPage, page, `exam-${lang}-${theme}`, { targetWidth: 1200, quality: 0.85 });

      await ctx.close();
    }
  }
} finally {
  await browser.close();
  await siteServer.close();
  await demoServer.close();
  await rm(WORK_DIR, { recursive: true, force: true });
}
console.log('README screenshots generated cleanly.');
