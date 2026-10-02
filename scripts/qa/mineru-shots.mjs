/* global document */
/* node scripts/qa/mineru-shots.mjs [--out <dir>] [--quick]
   Screenshots of the MinerU conversion UI in zh/en x dark/light at 1440 and 420 px:
   1. a static gallery of every state (scripts/qa/mineru-gallery.jsx, fixed props, no backend): settings, the import route
      panel, the local setup panel and the job card;
   2. the real app in the browser preview: Settings › MinerU, then Add material › Convert with MinerU with a generated
      450-page PDF read by the real backend (chunked upload, local plan; nothing is sent anywhere and no conversion is started).
   The preview runs with no `mineru` on PATH and a temporary home, so the owner's own install is never touched; every
   key/token/base-url variable is removed from the environment. Chromium: PLAYWRIGHT_CHROMIUM or the one under ms-playwright. */
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createPreviewServer, previewCall } from '../preview-server.mjs';
import { launchChromium } from './browser.mjs';
import { scrubProcessEnv } from './env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(flag('out', join(root, 'output/qa/mineru')));
const quick = args.includes('--quick');
const sleep = ms => new Promise(done => setTimeout(done, ms));

scrubProcessEnv();
// Never meet the owner's real mineru: nothing on PATH, a temporary home.
const scratch = await mkdtemp(join(tmpdir(), 'mineru-qa-'));
process.env.PATH = dirname(process.execPath);
process.env.USERPROFILE = scratch; process.env.HOME = scratch;
delete process.env.MINERU_BIN;

await mkdir(out, { recursive: true });
const site = join(out, 'gallery');
await mkdir(site, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['scripts/qa/mineru-gallery.jsx'], bundle: true, outfile: join(site, 'gallery.js'), format: 'iife', platform: 'browser',
  loader: { '.css': 'text' }, jsx: 'transform', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"development"' } });
await writeFile(join(site, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MinerU</title></head><body><div id="root"></div><script src="gallery.js"></script></body></html>');
const gallery = pathToFileURL(join(site, 'index.html')).href;

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let n = 1; n <= 450; n++) doc.addPage([300, 400]).drawText(`Operating systems, page ${n}`, { x: 30, y: 340, size: 14, font });
const pdfPath = join(scratch, 'Operating Systems.pdf');
await writeFile(pdfPath, await doc.save());

const browser = await launchChromium();
const shots = [], problems = [];
const combos = quick ? [['zh', 'dark', 1440], ['en', 'light', 420]] : ['zh', 'en'].flatMap(lang => ['dark', 'light'].flatMap(theme => [1440, 420].map(width => [lang, theme, width])));
try {
  // 1. The gallery.
  for (const [lang, theme, width] of combos) for (const scene of ['settings', 'route', 'local', 'jobs']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
    const tab = await context.newPage();
    tab.on('pageerror', error => problems.push(`${scene}/${lang}/${theme}/${width}: ${error.message}`));
    tab.on('console', message => { if (message.type() === 'error') problems.push(`${scene}/${lang}/${theme}/${width}: ${message.text()}`); });
    await tab.goto(`${gallery}?lang=${lang}&theme=${theme}&scene=${scene}`);
    await tab.waitForSelector('.study-app'); await sleep(200);
    const height = await tab.evaluate(() => document.querySelector('.study-app').scrollHeight);
    await tab.setViewportSize({ width, height: Math.min(height + 8, 9000) }); await sleep(150);
    // No horizontal scroll at any width.
    const overflow = await tab.evaluate(() => document.querySelector('.study-app').scrollWidth - document.querySelector('.study-app').clientWidth);
    if (overflow > 1) problems.push(`${scene}/${lang}/${theme}/${width}: horizontal overflow ${overflow}px`);
    const path = join(out, `gallery-${scene}-${lang}-${theme}-${width}.png`);
    await tab.screenshot({ path }); shots.push(path);
    await context.close();
  }

  // 2. The real app (browser preview) for the wide/dark and narrow/light combinations.
  let port = 4452;
  for (const [lang, theme, width] of combos.filter(([, , w], i) => !quick || i === 0 || w === 420)) {
    const server = await createPreviewServer({ libraryRoot: join(scratch, `lib-${lang}-${theme}-${width}`), home: join(scratch, `home-${lang}-${theme}-${width}`), port: port++ });
    try {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'zh-CN', colorScheme: theme });
      await context.addInitScript(([l, t]) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-theme', t); } catch { /* blocked */ } }, [lang, theme]);
      const tab = await context.newPage();
      tab.on('pageerror', error => problems.push(`app/${lang}/${theme}/${width}: ${error.message}`));
      const settle = async (ms = 400) => { await tab.waitForLoadState('networkidle').catch(() => {}); await sleep(ms); };
      const shot = async label => { const path = join(out, `app-${label}-${lang}-${theme}-${width}.png`); await tab.screenshot({ path }); shots.push(path); };
      await tab.goto(server.url); await tab.locator('aside, nav').first().waitFor({ timeout: 30000 }); await settle(800);
      await tab.locator('[data-tour="nav-settings"]').first().click(); await settle();
      const section = tab.locator('[data-tour="settings-mineru"]');
      await section.waitFor({ timeout: 15000 });
      await section.evaluate(element => element.scrollIntoView({ block: 'start' })); await settle(600);
      await shot('1-settings-unset');
      // A saved token is only ever shown as its last four characters (saving writes a file; it calls nobody).
      await previewCall(server, 'mineru.settings.set', { token: 'eyJ0eXBlIjoiSldUIn0.qa_token_0000000000000000000.sig-qa42' });
      await tab.reload(); await tab.locator('aside, nav').first().waitFor({ timeout: 30000 }); await settle(600);
      await tab.locator('[data-tour="nav-settings"]').first().click(); await settle();
      await section.evaluate(element => element.scrollIntoView({ block: 'start' })); await settle(600);
      await shot('2-settings-token-saved');
      if (await tab.getByText('qa_token_0000000000000000000').count()) problems.push(`app/${lang}/${theme}/${width}: the token appears on the page`);

      // Add material › Convert with MinerU, with a real 450-page PDF read by the backend.
      await tab.locator('[data-tour="nav-sources"]').first().click(); await settle();
      await tab.locator('[data-tour="sources-add"]').first().click(); await settle(500);
      await tab.locator('dialog[open]').getByRole('button', { name: /用 MinerU 解析|Convert with MinerU/ }).first().click(); await settle(300);
      await shot('3-import-entry');
      await tab.locator('dialog[open] input[type="file"][accept=".pdf,application/pdf"]').setInputFiles(pdfPath);
      await tab.locator('dialog[open] .mineru-plan').waitFor({ timeout: 60000 }); await settle(600);
      const plan = await tab.locator('dialog[open] .mineru-plan').innerText();
      if (!/450/.test(plan) || !/3|三/.test(plan)) problems.push(`app/${lang}/${theme}/${width}: unexpected plan text: ${plan.replace(/\s+/g, ' ')}`);
      await tab.locator('dialog[open] .mineru-route-panel').scrollIntoViewIfNeeded(); await shot('4-import-plan-cloud-ack');
      const box = tab.locator('dialog[open] .mineru-privacy input[type="checkbox"]');
      if (await box.count()) { await box.check(); await settle(200); await shot('5-import-ready-to-start'); }
      await context.close();
    } finally { await server.close(); }
  }
} finally { await browser.close(); await rm(scratch, { recursive: true, force: true }).catch(() => {}); }

console.log(`${shots.length} screenshots in ${out}`);
if (problems.length) { console.log(`PROBLEMS:\n- ${problems.join('\n- ')}`); process.exitCode = 1; } else console.log('no page errors, no horizontal overflow, no token on the page');
