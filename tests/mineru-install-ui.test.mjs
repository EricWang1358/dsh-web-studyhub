import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* The one-click MinerU card (ui/MineruInstallCard.jsx): every display state with its exact words, exactly one primary button, Tooltips (never title=),
   更多 only in Settings, reserved slots, the one fix of each failure; then the clicks: a fresh install is one click to mineru.install.start with the
   default folder, a drive change is two more, and a cancelled install continues with 继续安装. */

const mod = await loadUi(`export { default as MineruInstallCard } from './ui/MineruInstallCard.jsx';
  export { cardState, STATUS_TEXT, FIX_FOR, fixFor, stageStates, installProgress, installLine, locationHint, mineruUsable, errorHint } from './ui/mineru-install-flow.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const { MineruInstallCard, cardState, FIX_FOR, fixFor, stageStates, installProgress, installLine, locationHint, mineruUsable, errorHint } = mod;
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
  // A first install that stopped at 启用本机服务: nothing is installed yet, so the fix is the install again (with another mineru to stop, or not).
  enablePort: { state: 'not-installed', origin: null, install: ended('failed', 'port-in-use', 'enable'), lastError: null, external: null },
  enablePortExternal: { state: 'not-installed', origin: null, install: ended('failed', 'port-in-use', 'enable'), lastError: null, external: { exe: 'C:\\Tools\\mineru.exe', state: 'found' } },
  enableService: { state: 'not-installed', origin: null, install: ended('failed', 'service-failed', 'enable'), lastError: null, external: null },
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
  assert.deepEqual(cardState(local.cancelled), { state: 'paused', code: 'cancelled', origin: 'install' }, 'a cancel is a pause, not a failure');
  assert.equal(cardState({ ...local.cancelled, install: ended('interrupted', 'interrupted', 'models') }).state, 'paused');
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
    'needs-models': 'repair', 'models-missing': 'repair', 'service-failed': 'restart-service', 'service-timeout': 'restart-service', 'port-in-use': 'restart-service', 'vc-runtime': 'vc-runtime', unreadable: 'recheck' });
  assert.deepEqual([fixFor('network', { attempts: 2, source: 'mainland' }).id, fixFor('network', { attempts: 2, source: 'mainland' }).source], ['switch-source', 'global']);
  assert.equal(fixFor('port-in-use', { external: true }).id, 'stop-external');
  assert.equal(fixFor('something-new').id, 'repair');
  // Inside an install that has not finished, a service fix starts the install again (nothing is installed yet to restart), stopping the other MinerU first when there is one.
  assert.equal(fixFor('service-failed', { origin: 'install' }).id, 'repair');
  assert.equal(fixFor('port-in-use', { origin: 'install' }).id, 'repair');
  assert.equal(fixFor('port-in-use', { origin: 'install', external: true }).id, 'stop-external');
  assert.equal(fixFor('service-failed', { origin: 'service' }).id, 'restart-service');
  // The network hint names the button the card offers.
  assert.match(errorHint('network', { attempts: 1 }), /点「重试」/);
  assert.match(errorHint('network', { attempts: 2, source: 'mainland' }), /换成海外官方源再试/);
  // The service hints name the button too: 修复 inside an unfinished install, 重新启动服务 after it; a hint only where it adds something to the line and the button.
  assert.match(errorHint('service-failed', { origin: 'install' }), /点「修复」/);
  assert.equal(errorHint('service-failed', { origin: 'service' }), '', '重新启动服务 says it all');
  assert.match(errorHint('port-in-use', { origin: 'install' }), /关掉占用端口的程序后点「修复」/);
  assert.match(errorHint('port-in-use', { origin: 'service' }), /关掉占用端口的程序后点「重新启动服务」/);
  assert.equal(errorHint('port-in-use', { origin: 'install', external: true }), '', '停止另一份 MinerU 并重试 says it all');
  for (const code of ['no-space', 'not-writable', 'path-too-long', 'folder-in-use', 'bad-location', 'needs-models', 'models-failed']) assert.equal(errorHint(code, {}), '', code);
  // Each fix's icon says its action.
  assert.deepEqual(['no-space', 'port-in-use'].map(code => fixFor(code, { external: true }).icon), ['location', 'stop']);
});

test('the line under the bar is a downloaded size or nothing: never a command, a package name or progress glyphs', () => {
  assert.equal(installLine({ lastLine: 'Downloading 360M / 800M' }), '已下载 360 MB / 约 800 MB');
  assert.equal(installLine({ lastLine: ' 42%|####      | 9.0M/22.0M' }), '已下载 9 MB / 约 22 MB');
  assert.equal(installLine({ lastLine: 'Downloading cpython-3.12.15-windows-x86_64 (21.9MiB) 50%|#####     |' }), '已下载 11 MB / 约 21.9 MB');
  for (const line of ['$ D:\\StudyHub\\MinerU\\tools\\uv.exe venv D:\\StudyHub\\MinerU\\venv --python 3.12', '== package ==', 'Resolved 112 packages in 2.1s', '(tools: already done)', ''])
    assert.equal(installLine({ lastLine: line }), '', line);
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
  // An external USB disk: C: by default (said why), and when the learner picks the disk anyway, that it must be plugged in.
  const usb = { root: 'E:\\', freeMb: 900_000, system: false, removable: true, folder: 'E:\\StudyHub\\MinerU' };
  const cOverUsb = plan({ folder: 'C:\\StudyHub\\MinerU', defaultFolder: 'C:\\StudyHub\\MinerU', defaultReason: 'other-drives-removable', drives: [drives[0], usb], disk: { freeMb: 40_000, neededMb: 4000, drive: 'C:' } });
  assert.match(locationHint(cOverUsb), /其他磁盘是外接硬盘，拔掉后就用不了，所以装在系统盘（C:）。/);
  assert.match(locationHint({ ...cOverUsb, folder: usb.folder, disk: { freeMb: 900_000, neededMb: 4000, drive: 'E:' } }), /E: 是外接硬盘：拔掉后 MinerU 就用不了/);
  assert.match(locationHint(plan({ adjusted: true })), /StudyHub-MinerU/);
  assert.match(locationHint(plan({ platform: 'darwin' })), /数据文件夹/);
});

/* ---------- each state ---------- */

test('checking: the status line keeps its one-line slot and the body holds the offer\'s rows, so the most common answer (not installed) moves nothing', () => {
  const html = render({ call: undefined });
  assert.match(html, /data-state="checking"/);
  assert.match(textOf(html), /检测中 正在检测本机 MinerU…/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.equal(primaries(html), 0);
  assert.match(html, /mineru-install__offer/);
  for (const part of ['安装位置', '选择位置', '正在检测…', '一键安装']) assert.ok(textOf(html).includes(part), part);
  assert.match(html, /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*一键安装/s, 'the button is there, disabled, until the answer arrives');
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
  assert.match(html, /sh-inline__action[^>]*>换位置</, 'the message carries its own fix');
  const away = render({ initialLocal: local.missing, initialPlan: { ...blocked, folder: 'E:\\StudyHub\\MinerU', disk: { freeMb: 1200, neededMb: 4000, drive: 'E:' } } });
  assert.doesNotMatch(away, /mineru-install__hint/, 'a hint with nothing to say gives way to the message');
  const nonAscii = render({ initialLocal: local.missing, initialPlan: plan({ warnings: [{ code: 'non-ascii', message: '路径里有中文或特殊字符，个别组件可能加载失败；建议只用英文和数字，例如 D:\\StudyHub\\MinerU。' }] }) });
  assert.match(textOf(nonAscii), /路径里有中文或特殊字符/);
});

test('installing: step n of 6 (said once, in the status line), where it goes, what was downloaded, one 取消, the six steps and where to follow it', () => {
  const html = render({ initialLocal: local.installing });
  const text = textOf(html);
  assert.match(text, /安装中 .*第 4\/6 步：下载模型/);
  assert.match(html, /role="tooltip"[^>]*>每一步完成后才进入下一步。/);
  assert.match(html, /sh-job__meta[^>]*>D:\\StudyHub\\MinerU</, 'the row says only where it installs');
  assert.match(text, /已下载 360 MB \/ 约 800 MB/);
  assert.doesNotMatch(text, /Downloading 360M/, 'the raw output stays in the log');
  assert.equal((text.match(/第 4\/6 步/g) || []).length, 1);
  assert.match(text, /暂停/);
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

test('ready: where it is and that it works (the version and the tier in the badge\'s Tooltip), or that it is the learner\'s own; no button in Settings', () => {
  const html = render({ initialLocal: local.ready });
  assert.match(textOf(html), /可以用了 .*装在 D:\\StudyHub\\MinerU，可以开始解析 PDF 了。/);
  assert.match(html, /mineru-install__sentence">装在 D:\\StudyHub\\MinerU，可以开始解析 PDF 了。</, 'the sentence itself has no version or tier');
  assert.match(html, /role="tooltip"[^>]*>MinerU 4\.0\.12 · basic 档。\s*basic 档：只用 CPU/);
  assert.equal(primaries(html), 0);
  const external = render({ initialLocal: local.external });
  assert.match(textOf(external), /用的是你自己安装的 MinerU，可以开始解析 PDF 了。/);
  assert.match(external, /role="tooltip"[^>]*>MinerU 4\.0\.10 · standard 档。\s*这是你自己装的 MinerU（C:\\Users\\lee\\.local\\bin\\mineru\.exe）/);
  assert.match(textOf(render({ initialLocal: local.ready, compact: true })), /可以开始解析了。/);
});

const sentenceOf = html => textOf(/mineru-install__sentence">([^<]*)</.exec(html)?.[1] || '');

test('every failure: one short line that says what is wrong (the status line), at most one new hint, and exactly one fix button', () => {
  const needsModels = { state: 'needs-models', origin: 'installed', folder: FOLDER, install: complete, lastError: null };
  const cases = [[local.network, /^下载失败：连不上下载源/, '重试'], [local.network2, /^下载失败/, '换下载源重试'],
    [local.vc, /^失败（vc-runtime）$/, '下载 VC++ 运行库'], [local.port, /^本机服务没能启动：另一份 MinerU 占用了它要用的端口。$/, '停止另一份 MinerU 并重试'],
    [local.unreadable, /^读不出本机 MinerU 的状态。$/, '重新检测'], [needsModels, /^本机 MinerU 的模型还没有下载完整。$/, '修复'],
    [local.enablePort, /^本机服务要用的端口被别的程序占用了。$/, '修复'], [local.enablePortExternal, /^另一份 MinerU 占用了本机服务要用的端口。$/, '停止另一份 MinerU 并重试'],
    [local.enableService, /^失败（service-failed）$/, '修复']];
  for (const [state, line, fix] of cases) {
    const html = render({ initialLocal: state });
    assert.match(html, /data-state="error"/);
    assert.match(sentenceOf(html), line, fix);
    assert.equal(primaries(html), 1, fix);
    assert.match(html, new RegExp(`sh-btn--primary[^>]*>(?:(?!</button>).)*${fix.replace(/[+]/g, '\\+')}`, 's'), fix);
    // Never a pointer to the page the learner is on, never a title that explains nothing, never the same button twice.
    for (const banned of ['设置 › PDF 转换', '检测没有通过', '安装停在']) assert.ok(!textOf(html).includes(banned), `${fix}: ${banned}`);
    assert.equal(html.split(`>${fix}<`).length - 1, 1, `${fix} is offered once`);
    assert.ok((html.match(/class="sh-hint[" ]/g) || []).length <= 1, `${fix}: at most one hint`);
  }
  assert.doesNotMatch(render({ initialLocal: local.port }), /class="sh-hint/, 'another MinerU found: the button says it all');
  assert.match(render({ initialLocal: local.vc }), />重试</, 'beside the VC++ download sits a quiet 重试');
  assert.match(render({ initialLocal: local.network2 }), /role="tooltip"[^>]*>换成海外官方源再试；已装好的步骤不会重做。/);
  assert.match(textOf(render({ initialLocal: local.network })), /网络恢复后点「重试」/);
  assert.match(textOf(render({ initialLocal: local.network2 })), /换成海外官方源再试常常就好了。/);
});

test('a cancelled (or interrupted) install is paused, not failed: a neutral badge, where it stopped said once, the steps and one 继续安装', () => {
  const html = render({ initialLocal: local.cancelled });
  assert.match(html, /data-state="paused"/);
  assert.match(textOf(html), /已暂停 已暂停在第 4\/6 步「下载模型」；已下载的部分会保留。/);
  assert.doesNotMatch(html, /role="alert"/, 'no error message');
  assert.equal((textOf(html).match(/已下载的部分/g) || []).length, 1, 'the fact is said once');
  assert.equal(primaries(html), 1);
  assert.match(html, /sh-btn--primary[^>]*>(?:(?!<\/button>).)*继续安装/s);
  assert.equal((html.match(/<li data-state="done"/g) || []).length, 3);
  const interrupted = render({ initialLocal: { ...local.cancelled, install: ended('interrupted', 'interrupted', 'models') } });
  assert.match(textOf(interrupted), /StudyHub 关闭或重启时安装停下了。/);
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
  assert.match(compact, /class="sh-btn sh-btn--quiet[^"]*mineru-install__settings/, 'a quiet link: the one accent stays on 一键安装');
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
  assert.deepEqual(calls.find(item => item.action === 'mineru.install.start').args, { confirm: true, location: FOLDER, tier: 'basic' });
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
  assert.deepEqual(calls.find(item => item.action === 'mineru.install.start').args, { confirm: true, location: 'E:\\StudyHub\\MinerU', tier: 'basic' });
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
  await row.props.actions.find(action => action.label === '暂停').onClick(); await flush(); await flush();
  card.render(); await flush();
  const fix = find(card.render(), named('继续安装'));
  assert.ok(fix, 'the one fix of a cancelled install is 继续安装');
  await fix.props.onClick(); await flush();
  assert.deepEqual(calls.find(item => item.action === 'mineru.install.start').args, { confirm: true, location: FOLDER, tier: 'basic' });
  card.close();
});

/** Mount the card on one failed install and press its one fix button; resolves the start's arguments. */
async function pressFix(t, status, label) {
  const saved = globalThis.document;
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  t.after(() => { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; });
  const calls = [];
  const fake = async (action, args) => { calls.push({ action, args });
    if (action === 'mineru.local.status') return status; if (action === 'mineru.install.status') return status.install;
    // The plan is read without a location after a remount: it names the default folder, not the one the install used.
    if (action === 'mineru.install.plan') return plan(); if (action === 'mineru.install.start') return running('enable'); return {}; };
  const card = await mount({ call: fake, initialLocal: status });
  card.render(); await flush(); await flush();
  const button = find(card.render(), named(label));
  assert.ok(button, label);
  await button.props.onClick(); await flush();
  card.close();
  return calls.filter(item => item.action !== 'mineru.install.plan' && item.action !== 'mineru.install.status' && item.action !== 'mineru.local.status');
}

test('换下载源重试 continues in the folder the install used, not the default folder of a plan read after a remount', async t => {
  const elsewhere = 'E:\\Tools\\MinerU';
  const status = { ...local.network2, install: { ...local.network2.install, folder: elsewhere } };
  const [started] = await pressFix(t, status, '换下载源重试');
  assert.deepEqual(started, { action: 'mineru.install.start', args: { confirm: true, location: elsewhere, source: 'global', tier: 'basic' } });
});

test('a first install that stopped at 启用本机服务 is fixed by starting the install again, after stopping another MinerU when there is one', async t => {
  const [repair] = await pressFix(t, local.enablePort, '修复');
  assert.deepEqual(repair, { action: 'mineru.install.start', args: { confirm: true, location: FOLDER, tier: 'basic' } }, 'not a service start: nothing is installed yet');
  const [stop] = await pressFix(t, local.enablePortExternal, '停止另一份 MinerU 并重试');
  assert.deepEqual(stop, { action: 'mineru.install.start', args: { confirm: true, location: FOLDER, tier: 'basic', stopExternal: true } });
});

/* ---------- round 3: the tier after a remount, a change of tier that did not finish, no raw CLI text, one primary ---------- */

const standard = { ...complete, tier: 'standard', installedTier: 'standard' };
const readyStandard = { state: 'ready', origin: 'installed', folder: FOLDER, install: standard, version: '4.0.12', tier: 'standard', running: true, lastError: null };
function findAll(tree, predicate, found = []) {
  if (Array.isArray(tree)) { tree.forEach(item => findAll(item, predicate, found)); return found; }
  if (!React.isValidElement(tree)) return found;
  if (predicate(tree)) found.push(tree);
  findAll(tree.props.children, predicate, found);
  if (tree.props.body) findAll(tree.props.body, predicate, found);
  return found;
}
/** Mount the card on `status` (a remount: no tier chosen here), with every call recorded; resolves { card, calls }. */
async function remount(t, status, props = {}) {
  const saved = globalThis.document;
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  t.after(() => { if (saved === undefined) delete globalThis.document; else globalThis.document = saved; });
  const calls = [];
  const fake = async (action, args) => { calls.push({ action, args });
    if (action === 'mineru.local.status') return status; if (action === 'mineru.install.status') return status.install;
    if (action === 'mineru.install.plan') return plan(args.location ? { folder: args.location } : {}); if (action === 'mineru.install.start') return running('tools'); return {}; };
  const card = await mount({ call: fake, initialLocal: status, ...props });
  card.render(); await flush(); await flush();
  t.after(() => card.close());
  return { card, calls, starts: () => calls.filter(item => item.action === 'mineru.install.start').map(item => item.args) };
}

test('after a remount every start sends the tier of the install it fixes or moves: 安装到其他位置 keeps standard, 修复 and 继续安装 keep the install\'s tier', async t => {
  const moving = await remount(t, readyStandard, { initialMore: true });
  find(moving.card.render(), named('安装到其他位置…')).props.onClick();
  moving.card.render(); await flush(); await flush();
  await find(moving.card.render(), named('安装到这个位置')).props.onClick(); await flush();
  assert.deepEqual(moving.starts().at(-1), { confirm: true, location: FOLDER, tier: 'standard', removePrevious: true });
  // A standard install whose models went missing: 修复 repairs standard, never the backend's default basic.
  const repair = await remount(t, { state: 'needs-models', origin: 'installed', folder: FOLDER, install: standard, lastError: null });
  await find(repair.card.render(), named('修复')).props.onClick(); await flush();
  assert.equal(repair.starts().at(-1).tier, 'standard');
  // A paused standard install continues as standard; a VC++ failure's 重试 too.
  const paused = await remount(t, { ...local.cancelled, install: { ...ended('cancelled', 'cancelled', 'models'), tier: 'standard' } });
  await find(paused.card.render(), named('继续安装')).props.onClick(); await flush();
  assert.equal(paused.starts().at(-1).tier, 'standard');
  const vc = await remount(t, { ...local.vc, install: { ...local.vc.install, tier: 'standard' } });
  await find(vc.card.render(), named('重试')).props.onClick(); await flush();
  assert.equal(vc.starts().at(-1).tier, 'standard');
  // A service that failed to start outside an install is restarted (not reinstalled) by that 重试.
  const service = await remount(t, { state: 'server-stopped', origin: 'installed', folder: FOLDER, install: standard, lastError: { code: 'vc-runtime', message: '', at: '2026-10-16T00:00:00Z' } });
  await find(service.card.render(), named('重试')).props.onClick(); await flush();
  assert.deepEqual(service.calls.filter(item => item.action === 'mineru.local.start').map(item => item.args), [{ restart: true }]);
  assert.deepEqual(service.starts(), []);
});

test('a change of tier that did not finish: the ready state of the installed tier, plus one quiet line 换成 standard 档没有完成 · 重试 (why in its Tooltip)', async t => {
  const failedChange = { ...complete, status: 'failed', stage: 'models', tier: 'standard', installedTier: 'basic', done: ['tools', 'python', 'package'],
    error: { code: 'models-failed', message: '模型没有下载完整。' } };
  const status = { ...local.ready, install: failedChange };
  const html = render({ initialLocal: status, initialPlan: plan(), initialMore: true });
  assert.match(html, /data-state="ready"/, 'the old tier still works');
  assert.match(textOf(html), /换成 standard 档没有完成 .*· 重试/);
  assert.match(html, /role="tooltip"[^>]*>模型没有下载完整。/);
  assert.match(html, /name="mineru-install-tier" checked="" value="basic"/, '更多 shows the tier that is installed');
  assert.doesNotMatch(textOf(html), /换成 standard 档(?!没有完成)/, 'no second offer of the same change');
  assert.equal(primaries(html), 0);
  const cancelled = render({ initialLocal: { ...status, install: { ...failedChange, status: 'cancelled', error: { code: 'cancelled', message: '' } } } });
  assert.match(textOf(cancelled), /换成 standard 档没有完成/);
  assert.match(cancelled, /role="tooltip"[^>]*>已暂停；已下载的部分会保留。/);
  const card = await remount(t, status);
  await find(card.card.render(), named('重试')).props.onClick(); await flush();
  assert.deepEqual(card.starts().at(-1), { confirm: true, location: FOLDER, tier: 'standard' });
});

test('a service that does not start never shows a traceback or English CLI text on the status line: a plain reason by its code; the raw text only in 更多 › 详细信息', () => {
  const raw = 'Traceback (most recent call last):\n  File "mineru\\cli\\server.py", line 88, in start\nRuntimeError: worker exited with code 3';
  for (const [code, line] of [['service-failed', '本机服务没能启动：它一启动就退出了。'], ['service-timeout', '本机服务没能启动：等了很久它还没有准备好。'],
    ['models-missing', '本机服务没能启动：模型文件不完整。'], ['port-in-use', '本机服务没能启动：它要用的端口被别的程序占用了。'], ['vc-runtime', '本机服务没能启动：这台电脑缺少微软 VC++ 运行库。'],
    ['something-new', '本机服务没能启动：它一启动就退出了。']]) {
    const status = { state: 'server-stopped', origin: 'installed', folder: FOLDER, install: complete, external: null,
      lastError: { code, message: `本机服务没能启动：${raw}`, detail: raw, at: '2026-10-16T00:00:00Z' } };
    const html = render({ initialLocal: status });
    assert.equal(sentenceOf(html), line, code);
    assert.doesNotMatch(textOf(html), /Traceback|RuntimeError|worker exited|server\.py/, code);
    const more = render({ initialLocal: status, initialPlan: plan(), initialMore: true });
    assert.match(textOf(more), /详细信息/);
    assert.doesNotMatch(sentenceOf(more), /Traceback/);
  }
});

test('while the location chooser is open after a location failure, its confirm is the one primary: 换位置 gives way', async t => {
  const status = { state: 'not-installed', origin: null, install: ended('failed', 'no-space', 'models'), lastError: null, external: null };
  const card = await remount(t, status);
  const primaryButtons = () => findAll(card.card.render(), item => item.props?.variant === 'primary');
  assert.deepEqual(primaryButtons().map(item => item.props.children), ['换位置']);
  find(card.card.render(), named('换位置')).props.onClick();
  card.card.render(); await flush(); await flush();
  assert.deepEqual(primaryButtons().map(item => item.props.children), ['安装到这个位置'], 'one primary, the chooser\'s confirm');
});

test('the path field\'s placeholder reads as an example, and 取消 and 收起 are never stacked', async () => {
  const source = await (await import('node:fs/promises')).readFile(new URL('../ui/install/LocationChooser.jsx', import.meta.url), 'utf8');
  assert.match(source, /placeholder=\{uiFormat\('例如 \{0\}'/);
  assert.match(source, /\{draft === null && <div className="mineru-install__row">/, 'the 收起 row shows only while the path field is closed');
});