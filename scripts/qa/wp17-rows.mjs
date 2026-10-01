/* WP17 visual proof for every migrated row and the Disclosure transition.
   node scripts/qa/wp17-rows.mjs [--full] [--out output/qa/wp17-rows] [--port 4322]
   Default: zh + dark at 1440 and 420 (--full adds en and light).
   - harness page (scripts/qa/wp17-harness.jsx): md/sm/icon/disabled/wrapping
     controls, the Ingest recording rows and a Disclosure;
   - the real preview app: 学习库 study-mode switch, 知识骨架 view switch + canvas
     intents, Settings disclosure (closed, mid-transition numbers, open).
   Build the app first: npm run build. */
/* global document, getComputedStyle */
import { build } from 'esbuild';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPreviewServer, previewCall } from '../preview-server.mjs';
import { createFakeModel } from '../fake-model.mjs';
import { launchChromium } from './browser.mjs';
import { scrubProcessEnv } from './env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const out = resolve(root, flag('--out', 'output/qa/wp17-rows'));
const configs = args.includes('--full')
  ? [['zh', 'light', 1440], ['en', 'dark', 1440], ['zh', 'dark', 420], ['en', 'light', 420]] : [['zh', 'dark', 1440], ['zh', 'dark', 420]];
const sleep = ms => new Promise(done => setTimeout(done, ms));

scrubProcessEnv();
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'work', 'harness'), { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['scripts/qa/wp17-harness.jsx'], bundle: true, outfile: join(out, 'work', 'harness', 'harness.js'),
  format: 'iife', platform: 'browser', loader: { '.css': 'text' }, jsx: 'transform', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"development"' } });
await writeFile(join(out, 'work', 'harness', 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>wp17</title></head><body><div id="root"></div><script src="harness.js"></script></body></html>');
const harness = pathToFileURL(join(out, 'work', 'harness', 'index.html')).href;

const server = await createPreviewServer({ libraryRoot: join(out, 'work', 'library'), home: join(out, 'work', 'home'), port: Number(flag('--port', 4322)),
  model: createFakeModel({ latencyMs: 100, generationLatencyMs: 500 }) });
const browser = await launchChromium();
const summary = { checks: [], errors: [] };
const check = (name, ok, detail = '') => { summary.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

async function open({ lang, theme, width, url }) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'zh-CN', colorScheme: theme });
  await context.addInitScript(([l, t]) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-theme', t); } catch { /* blocked */ } }, [lang, theme]);
  const page = await context.newPage();
  page.on('pageerror', error => summary.errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') summary.errors.push(message.text()); });
  await page.goto(url || server.url);
  if (!url) { await page.locator('aside, nav').first().waitFor({ timeout: 30000 }); await sleep(600); }
  else { await page.locator('.sh-seg').first().waitFor(); await sleep(400); }
  return { page, close: () => context.close() };
}
const nav = async (page, id) => { await page.locator(`[data-tour="nav-${id}"]`).first().click(); await sleep(800); };
const pressed = (page, selector) => page.locator(`${selector} .sh-seg__item[aria-pressed="true"]`).allTextContents();
const thumbOn = (page, selector) => page.locator(selector).first().getAttribute('data-thumb');
const gap = (page) => page.evaluate(() => [...document.querySelectorAll('.sh-seg')].map(group => {
  const thumb = group.querySelector('.sh-seg__thumb').getBoundingClientRect();
  const item = group.querySelector('.sh-seg__item.is-active').getBoundingClientRect();
  return Math.max(Math.abs(thumb.x - item.x), Math.abs(thumb.y - item.y), Math.abs(thumb.width - item.width), Math.abs(thumb.height - item.height));
}));

try {
  await previewCall(server, 'sample.load', { uiLanguage: 'zh' }).catch(error => summary.errors.push(`sample.load: ${error.message}`));
  for (const [lang, theme, width] of configs) {
    const tag = `${lang}-${theme}-${width}`;

    // Harness: every variant, after a click on each control.
    {
      const { page, close } = await open({ lang, theme, width, url: `${harness}?lang=${lang}&theme=${theme}` });
      const groups = page.locator('.sh-seg');
      const total = await groups.count();
      for (let i = 0; i < total; i += 1) await groups.nth(i).locator('.sh-seg__item:not(:disabled)').last().click();
      await sleep(400);
      check(`${tag} harness: all ${total} controls hand over to the thumb`, await page.evaluate(() => [...document.querySelectorAll('.sh-seg')].every(group => group.getAttribute('data-thumb') === 'on')));
      const aligned = await gap(page);
      check(`${tag} harness: each thumb sits exactly under its active item`, aligned.every(delta => delta < 1.01), aligned.map(delta => delta.toFixed(2)).join(','));
      await page.screenshot({ path: join(out, `${tag}-harness.png`), fullPage: true });
      if (width === 1440) {
        const group = page.locator('.sh-seg[aria-label="disabled"]');
        await group.locator('.sh-seg__item').nth(1).focus();
        await page.keyboard.press('ArrowRight');
        const focused = await page.evaluate(() => document.activeElement.textContent);
        check('arrow keys skip the disabled segment', focused === 'Four', focused);
        await page.setViewportSize({ width: 520, height: 900 });
        await sleep(300);
        const moved = await gap(page);
        check(`${tag} harness: thumbs follow their items after a resize`, moved.every(value => value < 1.01), moved.map(value => value.toFixed(2)).join(','));
      }
      await close();
    }

    // Real app.
    const { page, close } = await open({ lang, theme, width });
    await nav(page, 'library');
    const later = page.getByRole('button', { name: lang === 'en' ? /maybe later|later/i : /以后再说/ });
    if (await later.count()) { await later.first().click(); await sleep(700); }
    const home = page.locator('.focus-switch.sh-seg');
    if (await home.count()) {
      const before = await pressed(page, '.focus-switch');
      await page.screenshot({ path: join(out, `${tag}-home.png`) });
      await home.locator('.sh-seg__item').last().click();
      await sleep(500);
      const after = await pressed(page, '.focus-switch');
      check(`${tag} home: the study-mode switch changes mode`, before[0] !== after[0], `${before} -> ${after}`);
      await home.locator('.sh-seg__item').first().click();
      await sleep(400);
    } else check(`${tag} home: study-mode switch present`, false, 'not rendered with the sample library');

    await nav(page, 'skeleton');
    const saved = page.locator('.sk-saved-item').first();
    if (await saved.count()) {
      await saved.click();
      await sleep(900);
      const view = page.locator('.sk-view-switch.sh-seg');
      check(`${tag} skeleton: the view switch is a segmented control`, await view.count() === 1);
      if (await view.count()) {
        await page.screenshot({ path: join(out, `${tag}-skeleton-spine.png`) });
        await view.locator('.sh-seg__item').last().click();
        await sleep(900);
        check(`${tag} skeleton: switching to 结构图 shows the canvas`, (await pressed(page, '.sk-view-switch')).length === 1 && await page.locator('.skc').count() > 0);
        const intents = page.locator('.skc-extend-intents.sh-seg');
        if (await intents.count()) {
          await intents.first().scrollIntoViewIfNeeded();
          await intents.first().locator('.sh-seg__item').last().click();
          await sleep(400);
          check(`${tag} skeleton: canvas intents is a segmented control`, (await thumbOn(page, '.skc-extend-intents')) === 'on');
          await page.screenshot({ path: join(out, `${tag}-skeleton-intents.png`) });
        }
      }
    } else check(`${tag} skeleton: a saved skeleton exists`, false);

    await nav(page, 'settings');
    const disclosure = page.locator('details.sh-disclosure').first();
    if (await disclosure.count()) {
      await disclosure.scrollIntoViewIfNeeded();
      await disclosure.locator(':scope > summary').click();
      const samples = await page.evaluate(async () => {
        const details = document.querySelector('details.sh-disclosure');
        const read = () => { const style = getComputedStyle(details, '::details-content'); return { height: Math.round(parseFloat(style.blockSize) || 0), opacity: Number(Number(style.opacity).toFixed(2)) }; };
        const result = [];
        for (let i = 0; i < 8; i += 1) { result.push(read()); await new Promise(done => setTimeout(done, 40)); }
        return result;
      });
      check(`${tag} settings: the disclosure fades/grows instead of snapping`, samples.some(sample => sample.opacity > 0.02 && sample.opacity < 0.98),
        samples.map(sample => `${sample.height}px/${sample.opacity}`).join(' '));
      await sleep(300);
      await page.screenshot({ path: join(out, `${tag}-settings-open.png`) });
    } else check(`${tag} settings: a disclosure exists`, false);
    await close();
  }
} finally {
  await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
  await browser.close().catch(() => {});
  await server.close();
}
if (summary.errors.length) console.log(`page errors: ${[...new Set(summary.errors)].slice(0, 6).join(' | ')}`);
process.exit(summary.checks.some(item => !item.ok) || summary.errors.length ? 1 : 0);
