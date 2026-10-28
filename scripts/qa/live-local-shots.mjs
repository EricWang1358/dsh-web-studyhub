/* global document */
/* node scripts/qa/live-local-shots.mjs [--out <dir>] [--langs=zh,en]
   Screenshots of 课堂实录's local engine, zh/en x light/dark at 1280 and 420 px (scripts/qa/live-local-gallery.jsx):
   1. 课堂实录 with fixed answers: the setup gate without a key (local first), installing, a failed checksum with its one fix, the Gemini gate where this
      computer has no local engine, the per-class choice where both engines can run, and the start form on the local engine; Settings › 音频转写's choice
      with the card missing, installing, failed and ready; the card's hover explanation;
   2. the click-through against a QA server where the REAL installer runs with tiny pinned files and a slow fake download (no network, nothing real
      installed): 安装本地引擎 -> installing -> ready -> the start form says the class runs on this computer.
   Every shot is checked for page errors and horizontal overflow. DSH_HOME points into output/. */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';
import { scrubProcessEnv } from './env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(flag('out', join(root, 'output/qa/live-local')));
const langs = flag('langs', 'zh,en').split(',');
const sleep = ms => new Promise(done => setTimeout(done, ms));

scrubProcessEnv();
await mkdir(join(root, 'output'), { recursive: true });
const scratch = await mkdtemp(join(root, 'output', 'live-local-qa-'));
process.env.DSH_HOME = join(scratch, 'home');
const { createLiveLocalInstaller, installSizes } = await import('../../lib/live-local-install.js');
const { fakePins, fakeFetch } = await import('../../tests/helpers/live-local-fakes.mjs');

await mkdir(out, { recursive: true });
const site = join(out, 'gallery');
await mkdir(site, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['scripts/qa/live-local-gallery.jsx'], bundle: true, outfile: join(site, 'gallery.js'), format: 'iife', platform: 'browser',
  loader: { '.css': 'text', '.json': 'json' }, jsx: 'transform', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"development"' } });
const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local live engine</title></head><body><div id="root"></div><script src="/gallery.js"></script></body></html>';

/* ---------- the QA server: the real installer with tiny pinned files and a download slow enough to watch ---------- */
const fake = fakePins(), key = `${process.platform}-${process.arch}`;
const pins = { ...fake.pins, platforms: { [key]: fake.pins.platforms['win32-x64'] } };
const net = fakeFetch(fake.files);
const slowFetch = async (url, init) => { await sleep(url.includes('model.int8') ? 2500 : 400); return net.fetch(url, init); };
const seams = { pins, fetch: slowFetch, drives: async () => [], freeMegabytes: async () => 120 * 1024, checkEngine: async () => { await sleep(1200); return { version: '1.13.8' }; },
  legacyModelFolders: [] };
const installer = createLiveLocalInstaller(seams);
const MB = 1_048_576;
async function status() {
  const install = await installer.status(), sizes = installSizes({ seams });
  return { ...install, supported: true, ready: install.installed, tested: true, engineVersion: '1.13.8', downloadMb: Math.round(sizes.download / MB) || 239, diskMb: 253, modelMb: 228 };
}
const handlers = {
  'live.local.status': () => status(), 'live.local.plan': a => installer.plan(a),
  'live.local.install': async a => { await installer.start(a); return status(); }, 'live.local.cancel': async () => { await installer.cancel(); return status(); },
  'live.list': async () => ({ sessions: [] }),
  'audio.preflight': async () => {
    const ready = (await installer.status()).installed;
    return { providers: { free: false, siliconflow: false, groq: false, paid: false }, transcription: false, textProvider: 'host', liveChoice: 'auto',
      live: ready, liveProvider: ready ? 'local' : null, ...(ready ? {} : { liveReason: 'no-provider' }), liveLocal: { supported: true, ready } };
  },
};
const qa = createServer(async (req, res) => {
  const reply = (code, type, body) => res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
  try {
    if (req.method === 'GET') return req.url === '/gallery.js' ? reply(200, 'text/javascript', await readFile(join(site, 'gallery.js'))) : reply(200, 'text/html', html);
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || '{}'), handler = handlers[payload.action];
    if (!handler) return reply(200, 'application/json', JSON.stringify({ ok: true, value: {} }));
    try { return reply(200, 'application/json', JSON.stringify({ ok: true, value: await handler(payload.args || {}) })); }
    catch (error) { return reply(200, 'application/json', JSON.stringify({ ok: false, error: error.message, code: error.code })); }
  } catch (error) { return reply(500, 'text/plain', String(error)); }
});
await new Promise(done => qa.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${qa.address().port}`;

/* ---------- shots ---------- */
const browser = await launchChromium();
const shots = [], problems = [];
const open = async (context, url, where) => {
  const tab = await context.newPage();
  tab.on('pageerror', error => problems.push(`${where}: ${error.message}`));
  tab.on('console', message => { if (message.type() === 'error') problems.push(`${where}: ${message.text()}`); });
  await tab.goto(url);
  return tab;
};
const snap = async (tab, name, where, target = '.gallery') => {
  await sleep(250);
  const path = join(out, `${name}.png`);
  await tab.locator(target).first().screenshot({ path }); shots.push(path);
  const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) problems.push(`${where}: horizontal overflow ${overflow}px`);
};
const LIVE = ['gate', 'gate-installing', 'gate-failed', 'gate-gemini', 'choice', 'local'];
const SETTINGS = ['missing', 'installing', 'checksum', 'ready'];

try {
  for (const lang of langs) {
    for (const [theme, width] of [['light', 1280], ['dark', 1280], ['light', 420], ['dark', 420]]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, colorScheme: theme });
      const tag = `${lang}-${theme}-${width}`;
      for (const name of LIVE) {
        const where = `live/${name}/${tag}`;
        const tab = await open(context, `${base}/?lang=${lang}&theme=${theme}&scene=live&case=${name}`, where);
        await tab.waitForSelector('.live-class', { timeout: 15000 });
        if (name.startsWith('gate') && name !== 'gate-gemini') await tab.waitForSelector('.live-local-card[data-state]:not([data-state="checking"])', { timeout: 15000 });
        if (name === 'gate') await tab.waitForSelector('.mineru-install__facts:not([aria-busy])', { timeout: 15000 }).catch(() => {});
        await snap(tab, `live-${name}-${tag}`, where);
        await tab.close();
      }
      for (const name of SETTINGS) {
        const where = `settings/${name}/${tag}`;
        const tab = await open(context, `${base}/?lang=${lang}&theme=${theme}&scene=settings&case=${name}`, where);
        await tab.waitForSelector('.live-local-card[data-state]', { timeout: 15000 });
        await snap(tab, `settings-${name}-${tag}`, where);
        await tab.close();
      }
      if (width === 1280 && theme === 'light') {
        const where = `tip/${tag}`;
        const tab = await open(context, `${base}/?lang=${lang}&theme=${theme}&scene=live&case=gate`, where);
        await tab.waitForSelector('.live-local-card__about');
        await tab.locator('.live-local-card__about').hover(); await sleep(800);
        const path = join(out, `tip-how-it-works-${tag}.png`); await tab.screenshot({ path }); shots.push(path);
        await tab.close();
      }
      await context.close();
    }
  }
  // The click-through against the real installer (zh, wide and narrow).
  for (const [theme, width] of [['light', 1280], ['dark', 420]]) {
    const tag = `zh-${theme}-${width}`, where = `flow/${tag}`;
    await installer.uninstall({ confirm: true }).catch(() => {});
    const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, colorScheme: theme });
    const tab = await open(context, `${base}/?lang=zh&theme=${theme}&scene=flow`, where);
    await tab.waitForSelector('.live-local-card[data-state="not-installed"] .mineru-install__facts:not([aria-busy])', { timeout: 20000 });
    await snap(tab, `flow-1-before-${tag}`, where);
    await tab.getByRole('button', { name: /安装本地引擎/ }).click();
    await tab.waitForSelector('.live-local-card[data-state="installing"]', { timeout: 20000 });
    await tab.waitForFunction(() => /第 2\/3 步/.test(document.querySelector('.live-local-card__line')?.textContent || ''), null, { timeout: 30000 });
    await snap(tab, `flow-2-installing-${tag}`, where);
    await tab.waitForSelector('form.live-setup', { timeout: 60000 });
    await snap(tab, `flow-3-ready-${tag}`, where);
    await tab.close(); await context.close();
  }
} finally {
  await browser.close();
  qa.close();
}
console.log(`${shots.length} screenshots in ${out}`);
if (problems.length) { console.log(`${problems.length} problem(s):\n${problems.join('\n')}`); process.exitCode = 1; }
else console.log('no page errors, no horizontal overflow');
