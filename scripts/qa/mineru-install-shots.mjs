/* global document */
/* node scripts/qa/mineru-install-shots.mjs [--out <dir>] [--quick] [--langs=zh,en]
   Screenshots and a layout audit of the one-click local MinerU (设置 › PDF 转换, and the same card inline in the import route), zh/en x dark/light at 1280 and 420 px:
   1. the Settings card in every state (scripts/qa/mineru-install-gallery.jsx, fixed answers): checking, not installed (default D:, only C:), the location chooser
      (drives, and the typed path of 其他文件夹…), no space, installing 2/6 and 4/6, paused (cancelled, interrupted), every failure with its one fix (network 1
      and 2, package, no space during the install, the service inside the install with and without another MinerU, the VC++ runtime, the service after the
      install, a port held by another MinerU, an unreadable status, missing models), service stopped, ready (ours, the learner's own), 更多 open, the move
      (安装到其他位置… with 先不换), a change of tier, a change of tier that did not finish, the chooser opened by 换位置 after a failure, a service failure's raw text in 更多 ›
      详细信息, the uninstall confirmation, and one open Tooltip of each kind;
   2. the import route when MinerU is not ready (not installed, installing, stopped with the auto-start hint), a conversion starting the stopped service, and
      the large-textbook card's converter; the 任务 console with the install's row running and after 暂停;
   3. the click-through against a QA server where the REAL installer runs on a local index, a fake uv and the fake mineru (no network, nothing real installed):
      一键安装 -> installing -> ready -> 停止服务 -> stopped.
   Layout audit (scripts/qa/mineru-layout.mjs) on every shot, no horizontal overflow, and no shift of the card between checking and not installed.
   Every temporary folder is under output/; HOME, USERPROFILE and DSH_HOME point there, PATH holds only node, so no real mineru or ~/.mineru is touched. */
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChromium } from './browser.mjs';
import { layoutAudit } from './mineru-layout.mjs';
import { scrubProcessEnv } from './env.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(flag('out', join(root, 'output/qa/mineru-install')));
const quick = args.includes('--quick');
const langs = flag('langs', 'zh,en').split(',');
const sleep = ms => new Promise(done => setTimeout(done, ms));

scrubProcessEnv();
await mkdir(join(root, 'output'), { recursive: true });
const scratch = await mkdtemp(join(root, 'output', 'mineru-install-qa-'));
const realPath = process.env.PATH;
process.env.DSH_HOME = join(scratch, 'home'); process.env.USERPROFILE = join(scratch, 'user'); process.env.HOME = join(scratch, 'user');
process.env.PATH = dirname(process.execPath); if (process.env.Path !== undefined) process.env.Path = process.env.PATH;
delete process.env.MINERU_BIN; delete process.env.MINERU_HOME;
await mkdir(process.env.USERPROFILE, { recursive: true });
const { createMineruInstaller, effectiveMineru } = await import('../../lib/mineru-install.js');
const { LOCAL, detectLocal, startServer, stopServer } = await import('../../lib/mineru-local.js');
const { startFakeIndex } = await import('../../tests/helpers/fake-index-server.mjs');

await mkdir(out, { recursive: true });
const site = join(out, 'gallery');
await mkdir(site, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['scripts/qa/mineru-install-gallery.jsx'], bundle: true, outfile: join(site, 'gallery.js'), format: 'iife', platform: 'browser',
  loader: { '.css': 'text', '.json': 'json' }, jsx: 'transform', logLevel: 'warning', define: { 'process.env.NODE_ENV': '"development"' } });
const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MinerU install</title></head><body><div id="root"></div><script src="/gallery.js"></script></body></html>';

/* ---------- the QA server: the real installer behind a local index, a fake uv and the fake mineru ---------- */
const index = await startFakeIndex();
const FAKE_UV = join(root, 'tests/helpers/fake-uv.mjs'), FAKE_MINERU = join(root, 'tests/helpers/fake-mineru-cli.mjs'), FAKE_PYTHON = join(root, 'tests/helpers/fake-python.mjs');
const uvState = join(scratch, 'uv.json'), mineruState = join(scratch, 'mineru.json'), pyState = join(scratch, 'py.json');
const resetFakes = async () => {
  await writeFile(uvState, JSON.stringify({ delayVenvMs: 1500, delayPipMs: 2500 }));
  await writeFile(mineruState, JSON.stringify({ version: '4.0.12', mode: 'disabled', tier: 'flash', running: false, total: 3, modelsReady: false, downloadDelayMs: 2500 }));
  await writeFile(pyState, JSON.stringify({ version: '3.12.15' }));
};
await resetFakes();
const cli = (prefix, env) => ({ file: process.execPath, prefix: [prefix], env });
const mineruEnv = { FAKE_MINERU_STATE: mineruState };
const seams = { sources: index.sources, probe: async () => ({ mainland: [{ url: 'm', ok: true, ms: 80 }], global: [{ url: 'g', ok: false, ms: 3000 }] }), drives: async () => [],
  freeMegabytes: async () => 120 * 1024, pythons: [], external: null, ramMb: 16 * 1024, checkPauseMs: 200, maxPathLength: 260,
  uvCli: () => cli(FAKE_UV, { FAKE_UV_STATE: uvState }), venvPython: () => cli(FAKE_PYTHON, { FAKE_PY_STATE: pyState }),
  mineruCli: () => cli(FAKE_MINERU, mineruEnv), kitCli: () => cli(FAKE_MINERU, mineruEnv) };
const installer = createMineruInstaller(seams);
const extras = () => ({ estimates: { ...LOCAL.secondsPerPage }, modelsMbByTier: { ...LOCAL.modelsMb }, windowPages: LOCAL.windowPages });
async function localStatus() {
  const install = await installer.status();
  if (install.status === 'running') return { state: 'installing', next: null, origin: null, folder: '', install, lastError: null, external: null, ...extras() };
  const found = await effectiveMineru({ seams });
  const detected = found.cli ? await detectLocal({ cli: found.cli, home: found.home }) : { state: 'not-installed', next: 'install' };
  return { ...detected, origin: found.origin, folder: found.folder || '', install, lastError: null, external: null, ...extras() };
}
const handlers = {
  'mineru.install.plan': a => installer.plan(a), 'mineru.install.start': a => installer.start(a), 'mineru.install.status': () => installer.status(),
  'mineru.install.cancel': () => installer.cancel(), 'mineru.install.uninstall': a => installer.uninstall(a), 'mineru.local.status': () => localStatus(),
  'mineru.local.start': async () => { const found = await effectiveMineru({ seams }); return startServer({ cli: found.cli, home: found.home }); },
  'mineru.local.stop': async () => { const found = await effectiveMineru({ seams }); return stopServer({ cli: found.cli, home: found.home }); },
};
const qa = createServer(async (req, res) => {
  const reply = (status, type, body) => res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
  try {
    if (req.method === 'GET') return req.url === '/gallery.js' ? reply(200, 'text/javascript', await readFile(join(site, 'gallery.js'))) : reply(200, 'text/html', html);
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body || '{}');
    const handler = handlers[payload.action];
    if (!handler) return reply(200, 'application/json', JSON.stringify({ ok: false, error: `unknown action ${payload.action}` }));
    try { return reply(200, 'application/json', JSON.stringify({ ok: true, value: await handler(payload.args || {}) })); }
    catch (error) { return reply(200, 'application/json', JSON.stringify({ ok: false, error: error.message, code: error.code })); }
  } catch (error) { return reply(500, 'text/plain', String(error)); }
});
await new Promise(done => qa.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${qa.address().port}`;

/* ---------- shots ---------- */
const browser = await launchChromium();
const shots = [], problems = [];
const combos = langs.flatMap(lang => (quick ? [['dark', 1280], ['light', 420]] : [['light', 1280], ['dark', 1280], ['light', 420], ['dark', 420]]).map(([theme, width]) => [lang, theme, width]));
const audit = async (tab, where, scopes) => {
  const result = await tab.evaluate(layoutAudit, { scopes });
  for (const text of result.problems.filter(item => !/sh-progress__ahead|sh-seg__thumb/.test(item))) problems.push(`${where}: ${text}`);
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
const snap = async (tab, name, where, target = '.gallery') => {
  await sleep(200);
  const path = join(out, `${name}.png`);
  await tab.locator(target).first().screenshot({ path }); shots.push(path);
  await audit(tab, where, ['.mineru-install', '.mineru-route-panel', '.pdf-convert-jobs > *', '.pdf-detail', '.large-doc__group']);
};
const SETTINGS = ['checking', 'missing', 'only-c', 'chooser', 'chooser-path', 'no-space', 'installing-2', 'installing-4', 'cancelled', 'interrupted', 'network-1', 'network-2',
  'package-failed', 'install-no-space', 'install-service', 'install-port', 'vc-runtime', 'service-failed', 'port-in-use', 'unreadable', 'needs-models', 'stopped', 'ready', 'external',
  'more', 'moving', 'tier-switch', 'uninstall-confirm', 'tier-unfinished', 'relocate-choosing', 'service-detail'];
// A case that is another case after some clicks: [gallery case, what to do].
const CLICKED = {
  'chooser-path': ['missing', async tab => { await tab.getByRole('button', { name: /选择位置|Choose location/ }).click(); await tab.getByRole('button', { name: /其他文件夹|Another folder/ }).click(); }],
  moving: ['more', async tab => { await tab.getByRole('button', { name: /安装到其他位置|Install in another location/ }).click(); }],
  'tier-switch': ['more', async tab => { await tab.locator('input[name="mineru-install-tier"][value="standard"]').check({ force: true }); }],
  // After a failure a different folder fixes: 换位置 opens the chooser, whose confirm is then the one primary.
  'relocate-choosing': ['install-no-space', async tab => { await tab.getByRole('button', { name: /^换位置$|^Choose another location$/ }).click(); await tab.waitForSelector('.mineru-install__chooser'); }],
  // What the program printed when the service did not start: 更多 › 详细信息 only.
  'service-detail': ['service-failed', async tab => { await tab.locator('.mineru-install__more > summary').click(); await tab.getByText(/^详细信息$|^Details$/).click(); }],
  'uninstall-confirm': ['more', async tab => { await tab.getByRole('button', { name: /^卸载$|^Uninstall$/ }).click(); await tab.waitForSelector('[role="dialog"], [role="alertdialog"]'); }],
};
// One open Tooltip of each kind: [name, gallery case, the element hovered].
const TIPS = [['tip-badge-ready', 'ready', '.mineru-install__line .mineru-install__tipped'], ['tip-badge-stopped', 'stopped', '.mineru-install__line .mineru-install__tipped'],
  ['tip-source', 'missing', '.mineru-install__facts .mineru-install__tipped'], ['tip-install', 'missing', '.mineru-install__row .sh-btn--primary'],
  ['tip-blocked', 'no-space', '.mineru-install__row .sh-btn--primary'], ['tip-fix', 'network-2', '.mineru-install__problem .sh-btn--primary'],
  ['tip-python', 'more', '.mineru-install__choices .mineru-install__tipped'], ['tip-tier-unfinished', 'tier-unfinished', '.mineru-install__tipped-text'], ['tip-stop', 'more', '.mineru-install__more-body .mineru-install__row .sh-btn--secondary']];
const IMPORT = ['missing', 'installing-4', 'stopped'];

try {
  for (const [lang, theme, width] of combos) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: theme });
    const tag = `${lang}-${theme}-${width}`;
    // 1. The Settings card in every state.
    for (const name of SETTINGS) {
      const where = `settings/${name}/${tag}`, [shown, clicks] = CLICKED[name] || [name, null];
      const tab = await open(context, `${base}/?lang=${lang}&theme=${theme}&scene=settings&case=${shown}`, where);
      await tab.waitForSelector(`.mineru-install[data-state]`, { timeout: 15000 });
      if (['missing', 'only-c', 'chooser', 'no-space', 'network-1', 'more'].includes(shown)) await tab.waitForSelector('.mineru-install__facts:not([aria-busy]), .mineru-install__more-body', { timeout: 15000 }).catch(() => {});
      if (name === 'chooser') { await tab.getByRole('button', { name: /选择位置|Choose location/ }).click(); await tab.waitForSelector('.mineru-install__chooser'); }
      if (clicks) { await clicks(tab); await sleep(300); }
      // The uninstall confirmation is a dialog in the top layer: the whole viewport is the shot.
      if (name === 'uninstall-confirm') { await sleep(200); const path = join(out, `settings-${name}-${tag}.png`); await tab.screenshot({ path }); shots.push(path); }
      else await snap(tab, `settings-${name}-${tag}`, where);
      await tab.close();
    }
    for (const [name, shown, target] of TIPS) {
      const where = `tooltip/${name}/${tag}`;
      const tab = await open(context, `${base}/?lang=${lang}&theme=${theme}&scene=settings&case=${shown}`, where);
      await tab.waitForSelector(`.mineru-install[data-state]`, { timeout: 15000 });
      await tab.waitForSelector('.mineru-install__facts:not([aria-busy]), .mineru-install__more-body, .mineru-install__problem, .mineru-install[data-state="ready"], .mineru-install[data-state="stopped"]', { timeout: 15000 }).catch(() => {});
      const anchor = tab.locator(target).first();
      await anchor.scrollIntoViewIfNeeded(); await anchor.hover();
      await sleep(800);
      const path = join(out, `${name}-${tag}.png`); await tab.screenshot({ path }); shots.push(path);
      await tab.close();
    }
    // The card does not move when the answer arrives: checking and not installed start at the same place (the status line, the body, 更多 below them).
    {
      const tab = await open(context, `${base}/?lang=${lang}&theme=${theme}&scene=settings&case=checking`, `shift/${tag}`);
      await tab.waitForSelector('.mineru-install');
      const measure = () => tab.evaluate(() => {
        const box = selector => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return rect ? { top: Math.round(rect.top), height: Math.round(rect.height) } : null; };
        return { status: box('.mineru-install__status'), button: box('.mineru-install__row .sh-btn'), more: box('.mineru-install__more'), card: box('.mineru-install') };
      });
      const before = await measure();
      await tab.goto(`${base}/?lang=${lang}&theme=${theme}&scene=settings&case=missing`); await tab.waitForSelector('.mineru-install[data-state="not-installed"] .mineru-install__facts:not([aria-busy])');
      const after = await measure();
      for (const part of ['status', 'button', 'more', 'card']) {
        const [a, b] = [before[part], after[part]];
        if (!a || !b || Math.abs(a.top - b.top) > 1 || Math.abs(a.height - b.height) > 1) problems.push(`shift/${tag}: ${part} moved ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      }
      await tab.close();
    }
    // 2. The import route when MinerU is not ready, a conversion starting the service, the large-textbook converter.
    for (const name of IMPORT) {
      const where = `import/${name}/${tag}`;
      const tab = await open(context, `${base}/?lang=${lang}&theme=${theme}&scene=import&case=${name}`, where);
      await tab.waitForSelector('.mineru-plan', { timeout: 15000 });
      await snap(tab, `import-${name}-${tag}`, where);
      await tab.close();
    }
    for (const [scene, name, which] of [['job', 'job-start-service', 'missing'], ['large', 'large-converter', 'missing'], ['console', 'console-install-running', 'running'],
      ['console', 'console-install-cancelled', 'cancelled']]) {
      const where = `${scene}/${name}/${tag}`;
      const tab = await open(context, `${base}/?lang=${lang}&theme=${theme}&scene=${scene}&case=${which}`, where);
      await tab.waitForSelector({ job: '.pdf-convert-jobs', large: '.large-doc__group', console: '.gallery .tc-list' }[scene], { timeout: 15000, state: 'attached' });
      if (scene === 'large') await tab.waitForSelector('.mineru-install', { timeout: 15000 });
      await snap(tab, `${name}-${tag}`, where);
      await tab.close();
    }
    await context.close();
  }

  // 3. The click-through against the real installer (zh, wide dark and narrow light).
  for (const [lang, theme, width] of [['zh', 'dark', 1280], ['zh', 'light', 420]]) {
    const tag = `${lang}-${theme}-${width}`, where = `flow/${tag}`;
    await installer.uninstall({ confirm: true }).catch(() => {});
    await rm(join(scratch, 'home'), { recursive: true, force: true }); await resetFakes();
    const context = await browser.newContext({ viewport: { width, height: 1000 }, deviceScaleFactor: 1, colorScheme: theme });
    const tab = await open(context, `${base}/?lang=${lang}&theme=${theme}&scene=flow`, where);
    await tab.waitForSelector('.mineru-install[data-state="not-installed"] .mineru-install__facts:not([aria-busy])', { timeout: 20000 });
    await snap(tab, `flow-1-before-${tag}`, where);
    await tab.getByRole('button', { name: /一键安装/ }).click();
    await tab.waitForSelector('.mineru-install[data-state="installing"]', { timeout: 20000 });
    await tab.waitForFunction(() => /第 [2-4]\/6 步/.test(document.querySelector('.mineru-install__sentence')?.textContent || ''), null, { timeout: 30000 });
    await snap(tab, `flow-2-installing-${tag}`, where);
    await tab.waitForSelector('.mineru-install[data-state="ready"]', { timeout: 90000 });
    await snap(tab, `flow-3-ready-${tag}`, where);
    await tab.locator('.mineru-install__more > summary').click();
    await tab.getByRole('button', { name: /停止服务/ }).click();
    await tab.waitForSelector('.mineru-install[data-state="stopped"]', { timeout: 30000 });
    await tab.locator('.mineru-install__more > summary').click();
    await snap(tab, `flow-4-stopped-${tag}`, where);
    await context.close();
  }
} finally {
  process.env.PATH = realPath;
  await browser.close(); await new Promise(done => qa.close(done)); await installer.cancel(); await installer.idle(); await index.close();
  await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}
await writeFile(join(out, 'summary.json'), JSON.stringify({ shots: shots.map(path => path.replace(out, '')), problems }, null, 2));
console.log(`${shots.length} screenshots in ${out}`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
