/* global document */
/* node scripts/qa/live-guidance-shots.mjs [--src <tree>] [--out <dir>] [--langs=zh,en]
   Screenshots of the live class page with a running fake class (scripts/qa/live-guidance-gallery.jsx): the owner's Chinese lecture with a 2,000-character
   sentence, short ones, skipped sentences, a growing line and an error; running and ended, 1440 light and 420 dark. Everything is fixed answers: no backend,
   no model, no network. `--src` is the tree to build the page from (default: this repository); for a "before" set, export an older commit into a folder under
   output/ (git archive <commit> ui lib tests/helpers | tar -x -C <folder>), copy scripts/qa/live-guidance-gallery.jsx there and pass it. Every shot is
   checked for page errors and horizontal overflow. */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const src = resolve(args.includes('--src') ? args[args.indexOf('--src') + 1] : root);
const out = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : join(root, 'output/live-guidance-shots/after'));
const langs = flag('langs', 'zh').split(',');
const sleep = ms => new Promise(done => setTimeout(done, ms));

await mkdir(out, { recursive: true });
const site = join(out, '.gallery');
await mkdir(site, { recursive: true });
await build({ absWorkingDir: src, entryPoints: ['scripts/qa/live-guidance-gallery.jsx'], bundle: true, outfile: join(site, 'gallery.js'), format: 'iife', platform: 'browser',
  loader: { '.css': 'text', '.json': 'json' }, jsx: 'transform', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"development"' } });
const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Live class</title></head><body><div id="root"></div><script src="/gallery.js"></script></body></html>';
const server = createServer(async (req, res) => {
  const reply = (code, type, body) => res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
  try { return req.url.startsWith('/gallery.js') ? reply(200, 'text/javascript', await readFile(join(site, 'gallery.js'))) : reply(200, 'text/html', html); }
  catch (error) { return reply(500, 'text/plain', String(error)); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launchChromium();
const shots = [], problems = [];
try {
  for (const lang of langs) {
    for (const [theme, width] of [['light', 1440], ['dark', 420]]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, colorScheme: theme });
      for (const scene of ['running', 'ended']) {
        const tag = `${scene}-${width}-${theme}${lang === 'zh' ? '' : `-${lang}`}`, where = `live/${tag}`;
        const tab = await context.newPage();
        tab.on('pageerror', error => problems.push(`${where}: ${error.message}`));
        tab.on('console', message => { if (message.type() === 'error') problems.push(`${where}: ${message.text()}`); });
        await tab.goto(`${base}/?lang=${lang}&theme=${theme}&scene=${scene}`);
        if (scene === 'running') {
          await tab.waitForSelector('form.live-setup');
          await tab.locator('form.live-setup button[type="submit"]').click();
        } else {
          await tab.waitForSelector('.live-history > summary');
          await tab.locator('.live-history > summary').click();
          await tab.locator('.live-history button').first().click();
        }
        await tab.waitForSelector('.live-bar');
        await sleep(900);
        const path = join(out, `${tag}.png`);
        await tab.screenshot({ path, fullPage: true }); shots.push(path);
        const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        if (overflow > 1) problems.push(`${where}: horizontal overflow ${overflow}px`);
        // The top of the transcript: the 2,000-character sentence and its skipped mark (the feed follows the newest sentence by default).
        await tab.evaluate(() => { document.querySelector('.live-feed').scrollTop = 0; });
        await sleep(300);
        const top = join(out, `${tag}-top.png`);
        await tab.locator('.live-stage').screenshot({ path: top }); shots.push(top);
        // The words behind a button that is off (the shared Tooltip: hover or focus).
        if (scene === 'running' && width === 1440) {
          const off = tab.locator('.live-selection .live-why__anchor[tabindex="0"]').first();
          if (await off.count()) {
            await off.hover(); await sleep(900);
            const hover = join(out, `${tag}-why.png`);
            await tab.locator('.live-stage').screenshot({ path: hover }); shots.push(hover);
          }
        }
        await tab.close();
      }
      await context.close();
    }
  }
} finally { await browser.close(); server.close(); }
console.log(`${shots.length} screenshots in ${out}`);
if (problems.length) { console.log(`${problems.length} problem(s):\n${problems.join('\n')}`); process.exitCode = 1; }
else console.log('no page errors, no horizontal overflow');
