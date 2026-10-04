/* global document */
/* node scripts/qa/marker-install-shots.mjs [--out <dir>] [--quick]
   Screenshots and a layout audit of the one-click Marker install (Settings > PDF conversion > Marker) in zh/en x dark/light at 1440 and 420 px:
   1. a static gallery of every state (scripts/qa/marker-install-gallery.jsx): before, python missing, no space, installing, failed, cancelled, done, an existing Marker;
   2. the click-through "flow": the settings in a browser talking to a QA server where the REAL installer (lib/marker-install.js) runs against a fake python/pip
      (tests/helpers/fake-python.mjs, no network): change location, install, cancel, retry into a failure, retry into success, uninstall;
   3. the real app (browser preview, real backend) with no python on PATH: the python-missing state with download channels.
   A temporary DSH home; every key/token/base-url variable is removed from the environment. */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewServer } from '../preview-server.mjs';
import { launchChromium } from './browser.mjs';
import { layoutAudit } from './mineru-layout.mjs';
import { scrubProcessEnv } from './env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(flag('out', join(root, 'output/wave1-marker')));
const quick = args.includes('--quick');
const sleep = ms => new Promise(done => setTimeout(done, ms));

scrubProcessEnv();
const scratch = await mkdtemp(join(tmpdir(), 'marker-install-qa-'));
const realPath = process.env.PATH;
process.env.DSH_HOME = join(scratch, 'home');
process.env.USERPROFILE = scratch; process.env.HOME = scratch;
// Dynamic imports after DSH_HOME is set: these read it on every call, but keep the order obvious.
const { createMarkerInstaller, venvLayout } = await import('../../lib/marker-install.js');
const { readMarkerSettings, saveMarkerSettings } = await import('../../lib/marker-settings.js');
const { detectMarker } = await import('../../lib/marker-local.js');

await mkdir(out, { recursive: true });
const site = join(out, 'gallery');
await mkdir(site, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['scripts/qa/marker-install-gallery.jsx'], bundle: true, outfile: join(site, 'gallery.js'), format: 'iife', platform: 'browser',
  loader: { '.css': 'text' }, jsx: 'transform', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"development"' } });
const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Marker install</title></head><body><div id="root"></div><script src="/gallery.js"></script></body></html>';

/* ---------- the QA server: the real installer behind a fake python ---------- */
const FAKE_PYTHON = join(root, 'tests/helpers/fake-python.mjs'), FAKE_MARKER = join(root, 'tests/helpers/fake-marker-cli.mjs');
const pyState = join(scratch, 'py-state.json');
await writeFile(pyState, '{}');
const pyEnv = { FAKE_PY_STATE: pyState };
const installer = createMarkerInstaller({ pythons: [{ file: process.execPath, prefix: [FAKE_PYTHON], env: pyEnv }], freeMegabytes: async () => 52_000,
  venvPython: folder => ({ file: process.execPath, prefix: [FAKE_PYTHON], env: { ...pyEnv, FAKE_PY_VENV: venvLayout(folder).venv } }),
  markerCli: () => ({ file: process.execPath, prefix: [FAKE_MARKER], env: {} }) });
const handlers = {
  'marker.install.plan': a => installer.plan(a), 'marker.install.start': a => installer.start(a), 'marker.install.status': () => installer.status(),
  'marker.install.cancel': () => installer.cancel(), 'marker.install.uninstall': a => installer.uninstall(a),
  'marker.settings.get': () => readMarkerSettings(), 'marker.settings.set': a => saveMarkerSettings(a),
  'marker.local.status': async () => ((await readMarkerSettings()).command ? detectMarker({ cli: { file: process.execPath, prefix: [FAKE_MARKER], env: {} } }) : { state: 'not-installed', next: 'install' }),
};
const qa = createServer(async (req, res) => {
  const reply = (status, type, body) => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
  try {
    if (req.method === 'GET') return req.url === '/gallery.js' ? reply(200, 'text/javascript', await readFile(join(site, 'gallery.js'))) : reply(200, 'text/html', html);
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || '{}');
    if (req.url === '/qa') { await writeFile(pyState, JSON.stringify(payload.py || {})); return reply(200, 'application/json', '{"ok":true}'); }
    const handler = handlers[payload.action];
    if (!handler) return reply(200, 'application/json', JSON.stringify({ ok: false, error: `unknown action ${payload.action}` }));
    try { return reply(200, 'application/json', JSON.stringify({ ok: true, value: await handler(payload.args || {}) })); }
    catch (error) { return reply(200, 'application/json', JSON.stringify({ ok: false, error: error.message })); }
  } catch (error) { return reply(500, 'text/plain', String(error)); }
});
await new Promise(done => qa.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${qa.address().port}`;
const setPy = async py => { await fetch(`${base}/qa`, { method: 'POST', body: JSON.stringify({ py }) }); };

const browser = await launchChromium();
const shots = [], problems = [];
const combos = quick ? [['zh', 'dark', 1440], ['en', 'light', 420]] : [['zh', 'dark', 1440], ['zh', 'dark', 420], ['en', 'light', 1440], ['en', 'light', 420]];
const rx = (zh, en) => new RegExp(`${zh}|${en}`);
const audit = async (tab, where) => {
  const result = await tab.evaluate(layoutAudit, { scopes: ['.marker-install'] });
  for (const text of result.problems.filter(item => !/sh-progress__ahead/.test(item))) problems.push(`${where}: ${text}`);
  const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 1) problems.push(`${where}: horizontal overflow ${overflow}px`);
};
const open = async (context, url, where) => {
  const tab = await context.newPage();
  tab.on('pageerror', error => problems.push(`${where}: ${error.message}`));
  tab.on('console', message => { if (message.type() === 'error') problems.push(`${where}: ${message.text()}`); });
  await tab.goto(url);
  return tab;
};
const snap = async (tab, label, lang, theme, width, where) => {
  await sleep(150);
  const path = join(out, `${label}-${lang}-${theme}-${width}.png`);
  await tab.locator('[data-tour="settings-marker"], .gallery').first().screenshot({ path }); shots.push(path);
  await audit(tab, `${where}/${label}`);
};

try {
  // 1. The static cases.
  for (const [lang, theme, width] of combos) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, colorScheme: theme });
    for (const name of ['before', 'missing', 'nospace', 'running', 'failed', 'cancelled', 'done', 'manual']) {
      const where = `case/${name}/${lang}/${theme}/${width}`;
      const tab = await open(context, `${base}/?lang=${lang}&theme=${theme}&scene=case&case=${name}`, where);
      await tab.waitForSelector('.marker-install[data-mode]:not([data-mode="loading"])', { timeout: 15000 });
      if (['before', 'missing', 'nospace', 'failed', 'cancelled'].includes(name)) await tab.waitForSelector('.marker-install__facts, .marker-install__channels', { timeout: 15000 });
      if (name === 'manual') { await tab.locator('.marker-install summary').first().click(); await tab.waitForSelector('.marker-install__facts'); }
      if (name === 'failed') { await tab.locator('.sh-job__detail summary').first().click(); }
      await snap(tab, `case-${name}`, lang, theme, width, where);
      await tab.close();
    }
    await context.close();
  }

  // 2. The click-through, against the real installer with a fake python.
  for (const [lang, theme, width] of combos) {
    const where = `flow/${lang}/${theme}/${width}`;
    await rm(join(scratch, 'home'), { recursive: true, force: true }); await setPy({});
    const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, colorScheme: theme });
    const picked = join(scratch, `My Tools ${lang}-${width}`, 'marker');
    const tab = await open(context, `${base}/?lang=${lang}&theme=${theme}&scene=flow&pick=${encodeURIComponent(picked)}`, where);
    const primary = tab.getByRole('button', { name: rx('一键安装 Marker', 'One-click install Marker') });
    await tab.waitForSelector('.marker-install__facts', { timeout: 15000 });
    await snap(tab, 'flow-1-before', lang, theme, width, where);
    await tab.getByRole('button', { name: rx('更改位置', 'Change location') }).click();
    await tab.locator('.marker-install__where code', { hasText: picked }).waitFor({ timeout: 15000 });
    await tab.waitForFunction(text => document.querySelector('.marker-install__where code')?.textContent === text, picked);
    await snap(tab, 'flow-2-location', lang, theme, width, where);
    await setPy({ delayPip: true });
    await primary.click();
    await tab.locator('[role="progressbar"]').first().waitFor({ timeout: 15000 });
    await tab.locator('.marker-install__line', { hasText: 'Downloading' }).waitFor({ timeout: 20000 });
    await snap(tab, 'flow-3-installing', lang, theme, width, where);
    await tab.getByRole('button', { name: rx('取消', 'Cancel'), exact: true }).first().click();
    await tab.getByText(rx('安装已取消', 'Install cancelled')).first().waitFor({ timeout: 20000 });
    await snap(tab, 'flow-4-cancelled', lang, theme, width, where);
    await setPy({ failPip: true });
    await tab.getByRole('button', { name: rx('重试', 'Retry'), exact: true }).first().click();
    await tab.getByText(rx('Marker 没有装好', 'Marker was not installed')).first().waitFor({ timeout: 30000 });
    await tab.locator('.sh-job__detail summary').first().click();
    await snap(tab, 'flow-5-failed', lang, theme, width, where);
    if (!(await tab.locator('.sh-job__raw').first().innerText()).includes('Could not find a version')) problems.push(`${where}: the raw log is missing from the failure`);
    await setPy({});
    await tab.getByRole('button', { name: rx('重试', 'Retry'), exact: true }).first().click();
    await tab.getByText(rx('Marker 已就绪', 'Marker is ready')).first().waitFor({ timeout: 60000 });
    await sleep(500);
    const path = await tab.locator('input[placeholder="marker_single"]').inputValue();
    if (!path.startsWith(picked) || !/marker_single/.test(path)) problems.push(`${where}: the path field was not filled in (${path})`);
    await snap(tab, 'flow-6-done', lang, theme, width, where);
    await tab.getByRole('button', { name: rx('卸载', 'Uninstall'), exact: true }).first().click();
    await tab.locator('dialog[open]').waitFor({ timeout: 10000 });
    const dialog = join(out, `flow-7-uninstall-confirm-${lang}-${theme}-${width}.png`);
    await sleep(250); await tab.screenshot({ path: dialog }); shots.push(dialog);
    await tab.locator('dialog[open]').getByRole('button', { name: rx('卸载', 'Uninstall'), exact: true }).click();
    await tab.waitForSelector('.marker-install[data-mode="offer"]', { timeout: 20000 });
    await sleep(600);
    if (await tab.locator('input[placeholder="marker_single"]').inputValue()) problems.push(`${where}: the path was not cleared by the uninstall`);
    await snap(tab, 'flow-8-uninstalled', lang, theme, width, where);
    await context.close();
  }

  // 3. The real app and backend with no python on PATH: the missing-Python state and its download channels.
  process.env.PATH = dirname(process.execPath);
  let port = 4472;
  for (const [lang, theme, width] of combos) {
    const where = `app/${lang}/${theme}/${width}`;
    const server = await createPreviewServer({ libraryRoot: join(scratch, `lib-${lang}-${theme}-${width}`), home: join(scratch, `app-home-${lang}-${theme}-${width}`), port: port++ });
    try {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'zh-CN', colorScheme: theme });
      await context.addInitScript(([l, t]) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-theme', t); } catch { /* blocked */ } }, [lang, theme]);
      const tab = await open(context, server.url, where);
      await tab.locator('aside, nav').first().waitFor({ timeout: 30000 });
      await tab.locator('[data-tour="nav-settings"]').first().click();
      await tab.locator('.settings-nav__item[data-category="mineru"]').click();
      const section = tab.locator('[data-tour="settings-marker"]');
      await section.waitFor({ timeout: 20000 });
      await section.evaluate(element => element.scrollIntoView({ block: 'start' }));
      await tab.waitForSelector('.marker-install__channels', { timeout: 30000 });
      await sleep(500);
      const path = join(out, `app-python-missing-${lang}-${theme}-${width}.png`);
      await section.screenshot({ path }); shots.push(path);
      await audit(tab, `${where}/python-missing`);
      await context.close();
    } finally { await server.close(); }
  }
} finally {
  process.env.PATH = realPath;
  await browser.close(); await new Promise(done => qa.close(done)); await installer.cancel(); await installer.idle();
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
await writeFile(join(out, 'summary.json'), JSON.stringify({ shots: shots.map(path => path.replace(out, '')), problems }, null, 2));
console.log(`${shots.length} screenshots in ${out}`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
