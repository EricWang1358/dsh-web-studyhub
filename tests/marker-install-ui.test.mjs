import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { INSTALL_MESSAGES } from '../lib/marker-install.js';

/* The one-click Marker install in Settings: every state renders in both languages, uses the shared primitives, and the buttons call the right actions. */
const mod = await loadUi(`export { default as MarkerInstall } from './ui/MarkerInstall.jsx';
  export { default as MarkerSettings } from './ui/MarkerSettings.jsx';
  export { installMode, stageStates, defaultMirror, canInstall, failureHint } from './ui/marker-install-flow.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const { MarkerInstall, MarkerSettings, installMode, stageStates, defaultMirror, canInstall, failureHint } = mod;
const han = /[㐀-鿿]/;
const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');

const plan = (extra = {}) => ({ ok: true, problems: [], folder: 'C:\\Users\\lee\\.dsh\\studyhub\\marker', adjusted: false, existing: false, defaultFolder: 'C:\\Users\\lee\\.dsh\\studyhub\\marker', platform: 'win32',
  python: { version: '3.11.4', command: 'py -3' }, minPython: '3.10', recommendedPython: '3.12', disk: { freeMb: 52_000, neededMb: 4000 }, estimate: { downloadMb: 1500, minutes: [5, 20] },
  mirror: 'tsinghua', mirrors: [{ id: 'tsinghua', reach: 'mainland', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' }, { id: 'official', reach: 'overseas', url: null }],
  commands: [{ stage: 'create-venv', command: 'py -3 -m venv "C:\\m\\venv"' }, { stage: 'install', command: '"C:\\m\\venv\\Scripts\\python.exe" -m pip install marker-pdf' }], ...extra });
const missing = plan({ ok: false, python: null, problems: [{ code: 'python-missing', message: INSTALL_MESSAGES.pythonMissing }],
  channels: [{ id: 'npmmirror', reach: 'mainland', url: 'https://registry.npmmirror.com/binary.html?path=python/' }, { id: 'huawei', reach: 'mainland', url: 'https://mirrors.huaweicloud.com/python/' }, { id: 'official', reach: 'overseas', url: 'https://www.python.org/downloads/' }] });
const idle = { status: 'idle', stage: '', stages: ['create-venv', 'install', 'verify', 'configure'], folder: '', log: [], error: null, installed: false, installedFolder: '', defaultFolder: plan().folder };
const running = { ...idle, status: 'running', stage: 'install', folder: plan().folder, mirror: 'tsinghua', startedAt: new Date().toISOString(), lastLine: 'Downloading torch-2.4.0 (190 MB)', log: ['== install ==', 'Downloading torch-2.4.0 (190 MB)'] };
const failed = { ...idle, status: 'failed', stage: 'install', folder: plan().folder, log: ['$ python -m pip install marker-pdf', 'ERROR: Could not find a version that satisfies the requirement marker-pdf'],
  error: { code: 'network', message: INSTALL_MESSAGES.pipNetwork } };
const complete = { ...idle, status: 'complete', stage: 'done', folder: plan().folder, command: 'C:\\m\\venv\\Scripts\\marker_single.exe', installed: true, installedFolder: plan().folder, needsModels: true, log: ['Successfully installed marker-pdf-1.0.0'] };
const render = (props, language = 'zh') => { mod.setUiLanguage(language); try { return renderToStaticMarkup(React.createElement(MarkerInstall, { call: async () => ({}), ...props })); } finally { mod.setUiLanguage('zh'); } };

test('flow: the mode, the stage marks, the default mirror and what blocks the button', () => {
  assert.equal(installMode({ install: null }), 'loading');
  assert.equal(installMode({ install: idle, markerReady: false }), 'offer');
  assert.equal(installMode({ install: idle, markerReady: true }), 'manual', 'a Marker that already works is left alone');
  assert.equal(installMode({ install: running }), 'running');
  assert.equal(installMode({ install: failed }), 'problem');
  assert.equal(installMode({ install: { ...failed, status: 'cancelled' } }), 'problem');
  assert.equal(installMode({ install: { ...failed, status: 'interrupted' } }), 'problem');
  assert.equal(installMode({ install: complete, markerReady: true }), 'installed');
  assert.equal(installMode({ install: complete, markerReady: true, moving: true }), 'offer', 'moving shows the offer again');
  assert.deepEqual(stageStates(running).map(s => s.state), ['done', 'active', 'pending', 'pending']);
  assert.deepEqual(stageStates(failed).map(s => s.state), ['done', 'failed', 'pending', 'pending']);
  assert.deepEqual(stageStates(complete).map(s => s.state), ['done', 'done', 'done', 'done']);
  assert.equal(defaultMirror('zh'), 'tsinghua'); assert.equal(defaultMirror('en'), 'official');
  assert.equal(canInstall(plan()), true); assert.equal(canInstall(missing), false); assert.equal(canInstall(null), false);
  assert.equal(canInstall(plan({ ok: false, problems: [{ code: 'no-space' }] })), false);
  assert.match(failureHint('network'), /国内直连/); assert.ok(failureHint('no-space')); assert.ok(failureHint('unknown-code'));
});

test('before install: one primary button, the folder, the mirrors with their reach, what will happen', () => {
  const html = render({ initialInstall: idle, initialPlan: plan(), initialMirror: 'tsinghua' });
  const text = textOf(html);
  assert.match(text, /一键安装 Marker/);
  assert.equal((html.match(/sh-btn--primary/g) || []).length, 1, 'cinnabar marks only the one primary action');
  assert.match(text, /C:\\Users\\lee\\\.dsh\\studyhub\\marker/); assert.match(text, /更改位置/);
  assert.match(text, /国内直连/); assert.match(text, /需海外网络/);
  assert.match(text, /3\.11\.4/); assert.match(text, /50\.8 GB|51 GB|50 GB/, 'free space'); assert.match(text, /估算/);
  assert.match(text, /5.20/);
  assert.match(html, /<input[^>]*name="marker-mirror"[^>]*checked=""[^>]*value="tsinghua"/);
  assert.match(text, /将要运行的命令/); assert.match(html, /-m pip install marker-pdf/);
  assert.doesNotMatch(html, /<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*一键安装 Marker/);
});

test('python missing: download channels (mainland first) instead of a failure; the button is off', () => {
  const html = render({ initialInstall: idle, initialPlan: missing });
  const text = textOf(html);
  assert.match(text, /没有找到 Python/);
  assert.match(html, /href="https:\/\/registry\.npmmirror\.com\/binary\.html\?path=python\/"/);
  assert.ok(html.indexOf('npmmirror') < html.indexOf('python.org'), 'a reachable mirror comes before the official installer');
  assert.match(html, /target="_blank"[^>]*rel="noreferrer"|rel="noreferrer"[^>]*target="_blank"/);
  assert.match(text, /国内直连/); assert.match(text, /重新检测/);
  assert.match(html, /<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*一键安装 Marker/);
});

test('installing: stages, a progress bar, the latest line, cancel', () => {
  const html = render({ initialInstall: running, initialPlan: plan() });
  const text = textOf(html);
  assert.match(html, /role="progressbar"/); assert.match(html, /aria-valuenow="1"/);
  assert.match(text, /创建独立环境/); assert.match(text, /下载并安装 marker-pdf/); assert.match(text, /验证 marker_single/); assert.match(text, /写入程序路径/);
  assert.match(text, /Downloading torch-2\.4\.0/); assert.match(text, /取消/);
  assert.doesNotMatch(text, /一键安装 Marker<\/button>/);
});

test('failed and cancelled: the reason, a retry, the raw log behind a disclosure', () => {
  for (const state of [failed, { ...failed, status: 'cancelled', error: { code: 'cancelled', message: INSTALL_MESSAGES.cancelled } }, { ...failed, status: 'interrupted', error: { code: 'interrupted', message: INSTALL_MESSAGES.interrupted } }]) {
    const html = render({ initialInstall: state, initialPlan: plan() });
    const text = textOf(html);
    if (state.status === 'cancelled') assert.match(text, /安装已取消/); else assert.ok(text.includes(state.error.message.slice(0, 8)), state.error.message);
    assert.match(text, /重试/);
    assert.match(html, /<details/); assert.match(text, /Could not find a version/);
  }
  assert.match(textOf(render({ initialInstall: failed, initialPlan: plan() })), /国内直连/, 'a network failure points at the mirror');
});

test('installed: ready, the path is filled, the first-conversion note, uninstall and move', () => {
  const html = render({ initialInstall: complete, initialPlan: plan(), markerReady: true });
  const text = textOf(html);
  assert.match(text, /Marker 已就绪/); assert.match(text, /C:\\Users\\lee\\\.dsh\\studyhub\\marker/);
  assert.match(text, /第一次解析时会下载 Marker 的模型/);
  assert.match(text, /卸载/); assert.match(text, /安装到其他位置/);
  assert.doesNotMatch(html, /sh-btn--primary/);
});

test('a Marker that already works keeps the install out of the way', () => {
  const html = render({ initialInstall: idle, initialPlan: plan(), markerReady: true });
  assert.match(html, /<details/);
  assert.doesNotMatch(html, /sh-btn--primary/);
});

test('English: every state is free of Chinese, links use the theme link style, nothing leaks', () => {
  const states = [{ initialInstall: idle, initialPlan: plan() }, { initialInstall: idle, initialPlan: missing }, { initialInstall: running, initialPlan: plan() },
    { initialInstall: failed, initialPlan: plan() }, { initialInstall: { ...failed, status: 'cancelled', error: { code: 'cancelled', message: INSTALL_MESSAGES.cancelled } }, initialPlan: plan() },
    { initialInstall: { ...failed, status: 'interrupted', error: { code: 'interrupted', message: INSTALL_MESSAGES.interrupted } }, initialPlan: plan() },
    { initialInstall: complete, initialPlan: plan(), markerReady: true }, { initialInstall: idle, initialPlan: plan({ adjusted: true }) },
    { initialInstall: idle, initialPlan: plan({ ok: false, problems: [{ code: 'no-space', message: INSTALL_MESSAGES.noSpace }] }) }];
  for (const props of states) {
    const html = render(props, 'en');
    assert.doesNotMatch(textOf(html), han, textOf(html));
    for (const anchor of html.match(/<a [^>]*>/g) || []) assert.match(anchor, /class="[^"]*marker-link/, anchor);
  }
});

test('Marker settings: the install comes first, the manual path stays, the old guidance stays', () => {
  const html = renderToStaticMarkup(React.createElement(MarkerSettings, { call: async () => ({}) }));
  assert.match(html, /marker-install/);
  assert.match(html, /placeholder="marker_single"/); assert.match(html, /检测并保存/);
  assert.match(html, /marker#installation/); assert.match(html, /marker#commercial-usage/);
  assert.ok(html.indexOf('marker-install') < html.indexOf('placeholder="marker_single"'), 'the one-click install is above the manual path');
  for (const anchor of html.match(/<a [^>]*>/g) || []) assert.match(anchor, /class="[^"]*marker-link/, anchor);
  const off = renderToStaticMarkup(React.createElement(MarkerSettings, { call: async () => ({}), available: false }));
  assert.doesNotMatch(off, /一键安装 Marker/, 'without the converter component nothing can be installed from here');
});

/* ---------- the buttons ---------- */

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(item => find(item, predicate)).find(Boolean);
  if (!React.isValidElement(tree)) return undefined;
  return predicate(tree) ? tree : find(tree.props.children, predicate);
}
// Keep state and effects across renders, so the component's effects and handlers run as in the app (no DOM needed).
async function mount(props) {
  const states = [], refs = [], deps = [], cleanups = [];
  let stateAt = 0, refAt = 0, effectAt = 0, pending = [];
  const hooks = { ...React, useId: () => 'mounted', useContext: () => null,
    useState: initial => { const index = stateAt++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef: initial => refs[refAt++] ||= { current: initial }, useMemo: read => read(), useCallback: fn => fn,
    useInsertionEffect: () => {}, useEffect: (effect, dependencies) => { const index = effectAt++;
      if (!deps[index] || !dependencies || dependencies.some((value, position) => value !== deps[index][position])) { deps[index] = dependencies; pending.push(() => { cleanups[index]?.(); cleanups[index] = effect(); }); } } };
  const { MarkerInstall: Hooked } = await loadHooked(hooks);
  return { render(next = props) { stateAt = 0; refAt = 0; effectAt = 0; pending = []; const tree = Hooked(next); pending.forEach(run => run()); return tree; }, close() { cleanups.forEach(cleanup => cleanup?.()); }, states };
}
async function loadHooked(hooks) {
  const { build } = await import('esbuild');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const compiled = await build({ stdin: { contents: `export { default as MarkerInstall } from './ui/MarkerInstall.jsx';`, resolveDir: process.cwd() }, bundle: true, write: false,
    platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => name === 'react' ? hooks : require(name), module, module.exports);
  return module.exports;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const named = label => item => item.props?.children === label;

test('the install button starts the job with the chosen folder and mirror, and confirmation is explicit', async () => {
  const calls = [];
  const call = async (action, args) => { calls.push({ action, args }); if (action === 'marker.install.status') return idle; if (action === 'marker.install.plan') return plan({ mirror: args.mirror }); if (action === 'marker.install.start') return running; return {}; };
  const mounted = await mount({ call, initialMirror: 'tsinghua', pickDirectory: async () => 'D:\\Tools' });
  mounted.render(); await flush(); await flush();
  let tree = mounted.render();
  assert.deepEqual(calls.map(item => item.action).slice(0, 2), ['marker.install.status', 'marker.install.plan']);
  await find(tree, named('一键安装 Marker')).props.onClick(); await flush();
  assert.deepEqual(calls.find(item => item.action === 'marker.install.start').args, { confirm: true, mirror: 'tsinghua' });
  mounted.close();
});

test('changing the location uses the folder picker and re-plans for that folder', async () => {
  const calls = [];
  const call = async (action, args) => { calls.push({ action, args }); if (action === 'marker.install.status') return idle; if (action === 'marker.install.plan') return plan({ folder: args.location || plan().folder }); if (action === 'marker.install.start') return running; return {}; };
  const mounted = await mount({ call, initialMirror: 'official', pickDirectory: async () => 'D:\\Tools' });
  mounted.render(); await flush(); await flush();
  await find(mounted.render(), named('更改位置')).props.onClick(); await flush(); await flush();
  mounted.render(); await flush();
  const plans = calls.filter(item => item.action === 'marker.install.plan');
  assert.equal(plans.at(-1).args.location, 'D:\\Tools');
  await find(mounted.render(), named('一键安装 Marker')).props.onClick(); await flush();
  assert.deepEqual(calls.find(item => item.action === 'marker.install.start').args, { confirm: true, mirror: 'official', location: 'D:\\Tools' });
  mounted.close();
});

test('without a native folder picker the location is typed as a full path', async () => {
  const calls = [];
  const call = async (action, args) => { calls.push({ action, args }); if (action === 'marker.install.status') return idle; if (action === 'marker.install.plan') return plan({ folder: args.location || plan().folder }); return {}; };
  const mounted = await mount({ call });
  mounted.render(); await flush(); await flush();
  await find(mounted.render(), named('更改位置')).props.onClick();
  const input = find(mounted.render(), item => item.props?.['aria-label'] === '安装位置的完整路径' || item.props?.placeholder === 'D:\\Tools\\marker');
  assert.ok(input, 'a path field appears');
  input.props.onChange({ target: { value: 'E:\\Apps\\marker' } });
  await find(mounted.render(), named('使用此位置')).props.onClick(); mounted.render(); await flush(); await flush();
  assert.equal(calls.filter(item => item.action === 'marker.install.plan').at(-1).args.location, 'E:\\Apps\\marker');
  mounted.close();
});

test('cancel and retry call the install actions; uninstall asks first, then removes and tells the parent', async t => {
  const savedDocument = globalThis.document;
  globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  t.after(() => { if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument; });
  const calls = [];
  let current = running, changes = 0;
  const call = async (action, args) => { calls.push({ action, args }); if (action === 'marker.install.status') return current; if (action === 'marker.install.plan') return plan(); if (action === 'marker.install.cancel') return (current = { ...failed, status: 'cancelled', error: { code: 'cancelled', message: INSTALL_MESSAGES.cancelled } });
    if (action === 'marker.install.start') return (current = running); if (action === 'marker.install.uninstall') return (current = idle); return {}; };
  const mounted = await mount({ call, markerReady: false, onChanged: () => { changes += 1; } });
  mounted.render(); await flush(); await flush();
  const job = find(mounted.render(), item => Array.isArray(item.props?.actions) && item.props.actions.some(action => action.label === '取消'));
  await job.props.actions.find(action => action.label === '取消').onClick(); await flush();
  assert.ok(calls.some(item => item.action === 'marker.install.cancel'));
  mounted.render(); await flush();
  const problem = find(mounted.render(), item => Array.isArray(item.props?.actions) && item.props.actions.some(action => action.label === '重试'));
  await problem.props.actions.find(action => action.label === '重试').onClick(); await flush();
  assert.equal(calls.filter(item => item.action === 'marker.install.start').length, 1);
  mounted.close();

  const installed = await mount({ call: async (action, args) => { calls.push({ action, args }); if (action === 'marker.install.status') return complete; if (action === 'marker.install.plan') return plan(); if (action === 'marker.install.uninstall') return idle; return {}; }, markerReady: true, onChanged: () => { changes += 1; } });
  installed.render(); await flush(); await flush();
  const before = calls.filter(item => item.action === 'marker.install.uninstall').length;
  find(installed.render(), named('卸载')).props.onClick();
  const dialog = find(installed.render(), item => typeof item.props?.onConfirm === 'function' && item.props?.confirmLabel);
  assert.ok(dialog, 'a confirmation dialog opens before anything is removed');
  assert.equal(calls.filter(item => item.action === 'marker.install.uninstall').length, before);
  await dialog.props.onConfirm(); await flush();
  assert.deepEqual(calls.filter(item => item.action === 'marker.install.uninstall').at(-1).args, { confirm: true });
  assert.ok(changes >= 1, 'the settings page re-reads the path after an uninstall');
  installed.close();
});
