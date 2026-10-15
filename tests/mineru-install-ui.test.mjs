import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* The one-click MinerU card (ui/MineruInstallCard.jsx): every display state with its exact words, exactly one primary button, Tooltips (never title=),
   更多 only in Settings, reserved slots, the one fix of each failure; then the clicks: a fresh install is one click to mineru.install.start with the
   default folder, a drive change is two more, and a cancelled install continues with 继续安装. */

const mod = await loadUi(`export { default as MineruInstallCard } from './ui/MineruInstallCard.jsx';
  export { cardState, STATUS_TEXT, FIX_FOR, fixFor, stageStates, installProgress, locationHint, mineruUsable } from './ui/mineru-install-flow.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const { MineruInstallCard, cardState, FIX_FOR, fixFor, stageStates, installProgress, locationHint, mineruUsable } = mod;
const h = React.createElement;
const han = /[㐀-鿿]/;
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
const call = async () => ({});

const FOLDER = 'D:\\StudyHub\\MinerU';
const drives = [{ root: 'C:\\', freeMb: 40_000, totalMb: 250_000, system: true, recommended: false, folder: 'C:\\StudyHub\\MinerU' },
  { root: 'D:\\', freeMb: 118 * 1024, totalMb: 500_000, system: false, recommended: true, folder: FOLDER },
  { root: 'E:\\', freeMb: 2000, totalMb: 32_000, system: false, recommended: false, folder: 'E:\\StudyHub\\MinerU' }];
const plan = (extra = {}) => ({ ok: true, problems: [], warnings: [], folder: FOLDER, adjusted: false, existing: false, defaultFolder: FOLDER, defaultReason: 'largest-data-drive', platform: 'win32',
  drives, disk: { freeMb: 118 * 1024, neededMb: 4000, drive: 'D:' }, estimate: { downloadMb: 1300, minutes: [10, 30] }, tier: 'basic',
  tiers: [{ id: 'basic', modelsMb: 800, secondsPerPage: 1.6 }, { id: 'standard', modelsMb: 2000, secondsPerPage: 2.5 }], ramMb: 8192,
  source: { id: 'mainland', chosenBy: 'auto', reason: 'overseas-unreachable', hosts: [] }, pythons: [{ version: '3.11.9', path: 'C:\\Python311\\python.exe' }], python: '', external: null,
  commands: [{ stage: 'tools', command: 'GET https://pypi.tuna.tsinghua.edu.cn/simple/uv/uv-0.13.1-py3-none-win_amd64.whl' }], ...extra });
const idle = { status: 'idle', stage: '', stages: ['tools', 'python', 'package', 'models', 'enable', 'check'], done: [], step: 0, of: 6, folder: '', installedFolder: '', installed: false, tier: '', source: null, log: [], error: null };
const running = (stage = 'python', extra = {}) => ({ ...idle, status: 'running', stage, step: idle.stages.indexOf(stage) + 1, done: idle.stages.slice(0, idle.stages.indexOf(stage)), folder: FOLDER, tier: 'basic',
  source: { id: 'mainland' }, lastLine: ' 42%|####      | 9.0M/22.0M', log: ['== python =='], stageFraction: 0.42, ...extra });
const ended = (status, code, stage, extra = {}) => ({ ...idle, status, stage, step: idle.stages.indexOf(stage) + 1, done: idle.stages.slice(0, idle.stages.indexOf(stage)), folder: FOLDER, tier: 'basic',
  source: { id: 'mainland' }, error: { code, message: code === 'network' ? '下载失败：连不上下载源。请检查网络后点「重试」；已下载的部分会保留。' : `失败（${code}）` }, ...extra });
const complete = { ...idle, status: 'complete', stage: 'done', step: 6, done: [...idle.stages], folder: FOLDER, installedFolder: FOLDER, installed: true, tier: 'basic', mineruVersion: '4.0.12', source: { id: 'mainland' } };
const local = {
  checking: null,
  missing: { state: 'not-installed', next: 'install', origin: null, install: idle, lastError: null, external: null },
  installing: { state: 'installing', origin: null, install: running('models', { lastLine: 'Downloading 360M / 800M' }), lastError: null },
  stopped: { state: 'server-stopped', origin: 'installed', folder: FOLDER, install: complete, lastError: null, version: '4.0.12' },
  ready: { state: 'ready', origin: 'installed', folder: FOLDER, install: complete, version: '4.0.12', tier: 'basic', running: true, lastError: null },
  external: { state: 'ready', origin: 'search', exe: 'C:\\Users\\lee\\.local\\bin\\mineru.exe', install: idle, version: '4.0.10', tier: 'standard', running: true, lastError: null },
  network: { state: 'not-installed', origin: null, install: { ...ended('failed', 'network', 'package'), attempts: 1 }, lastError: null },
  network2: { state: 'not-installed', origin: null, install: { ...ended('failed', 'network', 'package'), attempts: 2 }, lastError: null },
  cancelled: { state: 'not-installed', origin: null, install: ended('cancelled', 'cancelled', 'models'), lastError: null },
  vc: { state: 'not-installed', origin: null, install: ended('failed', 'vc-runtime', 'enable'), lastError: null },
  port: { state: 'server-stopped', origin: 'installed', folder: FOLDER, install: complete, lastError: { code: 'port-in-use', message: '本机服务没能启动：端口被占用', at: '2026-10-16T00:00:00Z' }, external: { exe: 'C:\\x\\mineru.exe', state: 'found' } },
  unreadable: { state: 'unknown', origin: 'search', install: idle, lastError: null },
};
const render = (props, language = 'zh') => { mod.setUiLanguage(language); try { return renderToStaticMarkup(h(MineruInstallCard, { call, ...props })); } finally { mod.setUiLanguage('zh'); } };
const primaries = html => (html.match(/class="sh-btn sh-btn--primary/g) || []).length;

/* ---------- the pure side ---------- */

test('the display state, in the documented order: a failed read is never "loading forever", an unreadable service is never "running"', () => {
  assert.deepEqual(cardState(null), { state: 'checking' });
  assert.equal(cardState({ state: 'unavailable' }).state, 'error');
  assert.equal(cardState(local.missing).state, 'not-installed');
  assert.equal(cardState(local.installing).state, 'installing');
  assert.equal(cardState(local.stopped).state, 'stopped');
  assert.equal(cardState(local.ready).state, 'ready');
  assert.deepEqual(cardState(local.network), { state: 'error', code: 'network', origin: 'install' });
  assert.deepEqual(cardState(local.port), { state: 'error', code: 'port-in-use', origin: 'service' });
  assert.deepEqual(cardState(local.unreadable), { state: 'error', code: 'unreadable', origin: 'check' });
  assert.deepEqual(cardState({ state: 'needs-models', origin: 'installed', install: complete }), { state: 'error', code: 'needs-models', origin: 'check' });
  assert.equal(cardState({ state: 'needs-models', origin: 'search', install: idle }).state, 'not-installed', 'another mineru without models is not ours to repair');
  assert.equal(cardState({ ...local.ready, install: ended('failed', 'network', 'package') }).state, 'ready', 'a working MinerU wins over an old failed attempt');
  assert.equal(mineruUsable(local.stopped), true, 'stopped after it worked: the conversion starts it');
  assert.equal(mineruUsable({ state: 'server-stopped', origin: 'installed', install: idle }), false);
});

test('the one fix of each failure (FIX_FOR), with the second network failure on a source switching the source', () => {
  const ids = Object.fromEntries(Object.keys(FIX_FOR).map(code => [code, fixFor(code).id]));
  assert.deepEqual(ids, { network: 'retry', checksum: 'retry', cancelled: 'continue', interrupted: 'continue', 'no-space': 'relocate', 'not-writable': 'relocate', 'folder-in-use': 'relocate',
    'bad-location': 'relocate', 'path-too-long': 'relocate', 'tools-failed': 'repair', 'python-failed': 'repair', 'package-failed': 'repair', 'models-failed': 'repair', 'check-failed': 'repair',
    'needs-models': 'repair', 'service-failed': 'restart-service', 'port-in-use': 'restart-service', 'vc-runtime': 'vc-runtime', unreadable: 'recheck' });
  assert.deepEqual([fixFor('network', { attempts: 2, source: 'mainland' }).id, fixFor('network', { attempts: 2, source: 'mainland' }).source], ['switch-source', 'global']);
  assert.equal(fixFor('port-in-use', { external: true }).id, 'stop-external');
  assert.equal(fixFor('something-new').id, 'repair');
});

test('the steps and the progress bar: finished steps plus how far the current one is, out of six', () => {
  assert.deepEqual(stageStates(running('package')).map(item => item.state), ['done', 'done', 'active', 'pending', 'pending', 'pending']);
  assert.deepEqual(stageStates(ended('failed', 'network', 'package')).map(item => item.state), ['done', 'done', 'failed', 'pending', 'pending', 'pending']);
  assert.deepEqual(installProgress(running('package')), { value: 2.42, max: 6 });
  assert.deepEqual(stageStates(complete).map(item => item.state), Array(6).fill('done'));
});

test('where the default folder came from, in words', () => {
  assert.match(locationHint(plan()), /默认装在剩余空间最大的非系统盘（D:，剩余 118 GB），不占用 C 盘。/);
  const onlyC = plan({ folder: 'C:\\StudyHub\\MinerU', defaultFolder: 'C:\\StudyHub\\MinerU', defaultReason: 'only-system-drive', drives: [drives[0]], disk: { freeMb: 40_000, neededMb: 4000, drive: 'C:' } });
  assert.match(locationHint(onlyC), /这台电脑只有系统盘（C:），只能装在这里。/);
  assert.match(locationHint(plan({ folder: 'C:\\StudyHub\\MinerU', disk: { freeMb: 40_000, neededMb: 4000, drive: 'C:' } })), /装在系统盘会占用 C 盘约 3\.9 GB。/);
  assert.match(locationHint(plan({ adjusted: true })), /StudyHub-MinerU/);
  assert.match(locationHint(plan({ platform: 'darwin' })), /数据文件夹/);
});

/* ---------- each state ---------- */

test('checking: the status line keeps its two-line slot and says it is checking; nothing else moves in later', () => {
  const html = render({ call: undefined });
  assert.match(html, /data-state="checking"/);
  assert.match(textOf(html), /检测中 正在检测本机 MinerU…/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.equal(primaries(html), 0);
});

test('not installed: the default folder (not C:), the facts, the source with its reach, and one primary 一键安装 that explains its steps', () => {
  const html = render({ initialLocal: local.missing, initialPlan: plan() });
  const text = textOf(html);
  assert.match(text, /未安装 这台电脑上还没有可用的 MinerU。/);
  assert.match(html, /<code translate="no">D:\\StudyHub\\MinerU<\/code>/);
  assert.match(text, /默认装在剩余空间最大的非系统盘（D:，剩余 118 GB），不占用 C 盘。/);
  assert.match(text, /下载约 1\.3 GB · 占用约 3\.9 GB · 约 10–30 分钟 · 下载源：国内镜像/);
  assert.match(text, /国内直连/);
  assert.match(html, /role="tooltip"[^>]*>自动选择：海外源 3 秒内没有响应。/);
  assert.match(html, /role="tooltip"[^>]*>会依次：准备安装工具 → 准备 Python → 安装 MinerU → 下载模型（basic 档）→ 启用本机服务 → 检查能不能用。/);
  assert.equal(primaries(html), 1);
  assert.match(html, /选择位置/);
  assert.doesNotMatch(html, /\stitle="/);
});

test('a blocked start says why, as a message and as the button\'s Tooltip; the button stays focusable (aria-disabled)', () => {
  const blocked = plan({ ok: false, problems: [{ code: 'no-space', message: 'D: 剩余 1.2 GB，至少需要 3.9 GB。请换一个空间更大的磁盘。' }] });
  const html = render({ initialLocal: local.missing, initialPlan: blocked });
  assert.match(html, /aria-disabled="true"/);
  assert.equal((html.match(/D: 剩余 1\.2 GB，至少需要 3\.9 GB/g) || []).length, 2, 'once in the message, once in the Tooltip');
  const nonAscii = render({ initialLocal: local.missing, initialPlan: plan({ warnings: [{ code: 'non-ascii', message: '路径里有中文或特殊字符，个别组件可能加载失败；建议只用英文和数字，例如 D:\\StudyHub\\MinerU。' }] }) });
  assert.match(textOf(nonAscii), /路径里有中文或特殊字符/);
});

test('installing: step n of 6, the stage, what was downloaded, the last line, one 取消, the six steps and where to follow it', () => {
  const html = render({ initialLocal: local.installing });
  const text = textOf(html);
  assert.match(text, /安装中 .*第 4\/6 步：下载模型/);
  assert.match(html, /role="tooltip"[^>]*>每一步完成后才进入下一步。/);
  assert.match(text, /第 4\/6 步 · 下载模型 · D:\\StudyHub\\MinerU · 已下载 360M \/ 约 800M/);
  assert.match(text, /Downloading 360M \/ 800M/);
  assert.match(text, /取消/);
  assert.match(text, /可以离开这个页面；进度也在「任务」里。请不要关闭 StudyHub。/);
  assert.equal((html.match(/<li data-state="done"/g) || []).length, 3);
  assert.doesNotMatch(html, /\stitle="/);
});

test('installed, service not running: one primary 启动服务, and that a conversion starts it anyway', () => {
  const html = render({ initialLocal: local.stopped });
  assert.match(textOf(html), /已安装 · 服务未启动 .*MinerU 已装好，本机服务没在运行。/);
  assert.match(html, /role="tooltip"[^>]*>MinerU 要靠一个在后台运行的本机服务来解析。/);
  assert.match(textOf(html), /启动服务 开始解析时也会自动启动。/);
  assert.equal(primaries(html), 1);
});

test('ready: the version, the tier and the folder (or that it is the learner\'s own), with the tier explained; no button in Settings', () => {
  const html = render({ initialLocal: local.ready });
  assert.match(textOf(html), /可以用了 .*MinerU 4\.0\.12 · basic 档 · 装在 D:\\StudyHub\\MinerU/);
  assert.match(html, /role="tooltip"[^>]*>basic 档：只用 CPU/);
  assert.equal(primaries(html), 0);
  const external = render({ initialLocal: local.external });
  assert.match(textOf(external), /MinerU 4\.0\.10 · standard 档 · 你自己安装的/);
  assert.match(external, /role="tooltip"[^>]*>这是你自己装的 MinerU（C:\\Users\\lee\\.local\\bin\\mineru\.exe）/);
  assert.match(textOf(render({ initialLocal: local.ready, compact: true })), /可以开始解析了。/);
});

test('every failure: where it stopped, the reason, and exactly one fix button', () => {
  const cases = [[local.network, /安装停在「安装 MinerU」/, '重试'], [local.network2, /安装停在「安装 MinerU」/, '换下载源重试'], [local.cancelled, /安装停在「下载模型」/, '继续安装'],
    [local.vc, /安装停在「启用本机服务」/, '下载 VC++ 运行库'], [local.port, /本机服务没能启动/, '停止另一份 MinerU 并重试'], [local.unreadable, /检测没有通过/, '重新检测']];
  for (const [state, title, fix] of cases) {
    const html = render({ initialLocal: state });
    assert.match(html, /data-state="error"/);
    assert.match(textOf(html), title);
    assert.equal(primaries(html), 1, fix);
    assert.match(html, new RegExp(`sh-btn--primary[^>]*>(?:(?!</button>).)*${fix.replace(/[+]/g, '\\+')}`, 's'), fix);
  }
  assert.match(render({ initialLocal: local.vc }), />重试</, 'beside the VC++ download sits a quiet 重试');
  assert.match(render({ initialLocal: local.network2 }), /role="tooltip"[^>]*>换成海外官方源再试；已装好的步骤不会重做。/);
});

test('更多 (Settings only): tier with the memory note, source, Python, stop, move, uninstall, the log and the commands; the compact card links there instead', () => {
  const html = render({ initialLocal: local.ready, initialPlan: plan(), initialMore: true });
  const text = textOf(html);
  for (const part of ['模型档位', '模型约 0.8 GB · 每页约 1.6 秒（估算）', '建议 16 GB 内存（这台电脑 8 GB）', '内存可能不够', '下载源', '自动（推荐）', '现在用：国内镜像（海外源 3 秒内没有响应）',
    '国内镜像', '海外官方源', '需海外网络', 'StudyHub 自带 Python 3.12（推荐）', '这台电脑上的 Python 3.11.9（C:\\Python311\\python.exe）', '停止服务', '安装到其他位置…', '卸载', '安装日志', '将要运行的命令'])
    assert.ok(text.includes(part), part);
  assert.match(html, /role="tooltip"[^>]*>用它就不再下载 Python；以后升级或卸载这个 Python 会让 MinerU 失效。/);
  assert.match(html, /role="tooltip"[^>]*>服务在后台会占用内存；需要解析时会自动再启动。/);
  const compact = render({ initialLocal: local.missing, initialPlan: plan(), compact: true, onOpenSettings() {} });
  assert.doesNotMatch(compact, /mineru-install__more/);
  assert.match(textOf(compact), /更多选项/);
  assert.match(compact, /mineru-install--compact/);
});

test('reserved slots: the status line, the hint, the facts and the last line keep their height before an answer arrives', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../ui/mineru-install.css', import.meta.url), 'utf8');
  for (const slot of ['__status', '__hint', '__facts', '__last']) assert.match(css, new RegExp(`\\.mineru-install${slot} \\{[^}]*min-height`), slot);
  assert.match(textOf(render({ initialLocal: local.missing })), /正在计算剩余空间…/, 'the facts slot says it is computing');
});

test('English: no Chinese in any state, in Settings or compact', () => {
  for (const state of Object.values(local)) for (const compact of [false, true]) {
    const html = render({ initialLocal: state, initialPlan: plan(), compact, initialMore: !compact, onOpenSettings() {} }, 'en')
      // What a program printed stays as it printed it (端口被占用); the rest is the learner's language.
      .replace(/端口被占用|下载失败：连不上下载源。请检查网络后点「重试」；已下载的部分会保留。|失败（[\w-]+）/g, 'x');

    assert.doesNotMatch(textOf(html), han, JSON.stringify(state?.state));
  }
});

/* ---------- the clicks ---------- */

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(item => find(item, predicate)).find(Boolean);
  if (!React.isValidElement(tree)) return undefined;
  return predicate(tree) ? tree : find(tree.props.children, predicate) || (tree.props.body ? find(tree.props.body, predicate) : undefined);
}
const named = label => item => item.props?.children === label || (Array.isArray(item.props?.children) && item.props.children.includes(label));
async function mount(props) {
  const states = [], refs = [], deps = [], cleanups = [];
  let stateAt = 0, refAt = 0, effectAt = 0, pending = [];
  const hooks = { ...React, useId: () => 'mounted', useContext: () => null, useSyncExternalStore: (_subscribe, get) => get(), useLayoutEffect: () => {},
    useState: initial => { const index = stateAt++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef: initial => refs[refAt++] ||= { current: initial }, useMemo: read => read(), useCallback: fn => fn,
    useInsertionEffect: () => {}, useEffect: (effect, dependencies) => { const index = effectAt++;
      if (!deps[index] || !dependencies || dependencies.some((value, position) => value !== deps[index][position])) { deps[index] = dependencies; pending.push(() => { cleanups[index]?.(); cleanups[index] = effect(); }); } } };
  const { build } = await import('esbuild');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const compiled = await build({ stdin: { contents: `export { default as MineruInstallCard } from './ui/MineruInstallCard.jsx';`, resolveDir: process.cwd() }, bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => (name === 'react' ? hooks : require(name)), module, module.exports);
  const Hooked = module.exports.MineruInstallCard;
  return { render(next = props) { stateAt = 0; refAt = 0; effectAt = 0; pending = []; const tree = Hooked(next); pending.forEach(run => run()); return tree; }, close() { cleanups.forEach(cleanup => cleanup?.()); } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a fresh install is one click: 一键安装 starts with the default folder and confirm: true, nothing else', async t => {
  const saved = globalThis.document;
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  t.after(() => { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; });
  const calls = [];
  const fake = async (action, args) => { calls.push({ action, args }); if (action === 'mineru.install.plan') return plan(args.location ? { folder: args.location } : {}); if (action === 'mineru.install.start') return running('tools'); if (action === 'mineru.local.status') return local.missing; return {}; };
  const card = await mount({ call: fake, initialLocal: local.missing });
  card.render(); await flush(); await flush();
  const tree = card.render();
  assert.deepEqual(calls.map(item => item.action), ['mineru.install.plan'], 'opening the card only plans');
  await find(tree, named('一键安装')).props.onClick(); await flush();
  assert.deepEqual(calls.find(item => item.action === 'mineru.install.start').args, { confirm: true, location: FOLDER });
  card.close();
});

test('another drive is two more clicks: 选择位置, the drive, then 一键安装 installs there', async t => {
  const saved = globalThis.document;
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  t.after(() => { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; });
  const calls = [];
  const fake = async (action, args) => { calls.push({ action, args }); if (action === 'mineru.install.plan') return plan(args.location ? { folder: args.location } : {}); if (action === 'mineru.install.start') return running('tools'); return {}; };
  const card = await mount({ call: fake, initialLocal: local.missing });
  card.render(); await flush(); await flush();
  find(card.render(), named('选择位置')).props.onClick();
  const chooser = find(card.render(), item => typeof item.props?.onChoose === 'function');
  assert.ok(chooser, 'the location chooser opens inline');
  chooser.props.onChoose('E:\\StudyHub\\MinerU'); card.render(); await flush(); await flush();
  assert.equal(calls.filter(item => item.action === 'mineru.install.plan').at(-1).args.location, 'E:\\StudyHub\\MinerU', 'the plan is read again for that drive');
  await find(card.render(), named('一键安装')).props.onClick(); await flush();
  assert.deepEqual(calls.find(item => item.action === 'mineru.install.start').args, { confirm: true, location: 'E:\\StudyHub\\MinerU' });
  card.close();
});

test('cancel, then 继续安装 starts again in the same folder (the finished steps are skipped by the backend)', async t => {
  const saved = globalThis.document;
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  t.after(() => { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; });
  const calls = [];
  let status = local.installing;
  const fake = async (action, args) => { calls.push({ action, args });
    if (action === 'mineru.install.cancel') { status = local.cancelled; return local.cancelled.install; }
    if (action === 'mineru.local.status') return status; if (action === 'mineru.install.status') return status.install;
    if (action === 'mineru.install.plan') return plan(); if (action === 'mineru.install.start') return running('models'); return {}; };
  const card = await mount({ call: fake, initialLocal: local.installing });
  card.render(); await flush();
  const row = find(card.render(), item => Array.isArray(item.props?.actions));
  await row.props.actions.find(action => action.label === '取消').onClick(); await flush(); await flush();
  card.render(); await flush();
  const fix = find(card.render(), named('继续安装'));
  assert.ok(fix, 'the one fix of a cancelled install is 继续安装');
  await fix.props.onClick(); await flush();
  assert.deepEqual(calls.find(item => item.action === 'mineru.install.start').args, { confirm: true, location: FOLDER, tier: 'basic' });
  card.close();
});
