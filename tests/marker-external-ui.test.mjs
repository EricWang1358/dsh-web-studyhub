import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createMarkerConversionScript, MARKER_SCRIPT_FILENAME } from '../lib/marker-external.js';

const compiled = await build({ stdin: { contents: `export { default as ImportHub } from './ui/ImportHub.jsx';
  export { default as MarkerSettings } from './ui/MarkerSettings.jsx';
  export { default as PdfConversion } from './ui/PdfConversion.jsx';
  export { downloadMarkerScript } from './ui/marker-script.js';
  export { setUiLanguage } from './ui/i18n.js';`, resolveDir: process.cwd() }, bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const require = createRequire(import.meta.url);
function load(react) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(name => name === 'react' ? react : require(name), module, module.exports);
  return module.exports;
}
const components = load(React);
const changes = [];
const events = load({ ...React, useState: initial => [typeof initial === 'function' ? initial() : initial, value => changes.push(value)],
  useInsertionEffect: () => {}, useEffect: () => {}, useId: () => 'pdf', useMemo: read => read(), useRef: initial => ({ current: initial }),
  // The shared host-query store (ui/host-query.js) reads through these: no services, and the store's current answer.
  useContext: () => null, useSyncExternalStore: (_subscribe, snapshot) => snapshot() });
function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(item => find(item, predicate)).find(Boolean);
  if (!React.isValidElement(tree)) return undefined;
  return predicate(tree) ? tree : find(tree.props.children, predicate);
}

test('Marker settings show executable configuration and usage guidance in both languages', () => {
  try {
    for (const language of ['zh', 'en']) {
      components.setUiLanguage(language);
      const html = renderToStaticMarkup(React.createElement(components.MarkerSettings, { call: async () => ({}) }));
      assert.match(html, /marker#installation/);
      assert.match(html, /marker#commercial-usage/);
      assert.match(html, /marker_single/);
      assert.match(html, /type="text"/);
      if (language === 'en') assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /[㐀-鿿]/);
    }
  } finally { components.setUiLanguage('zh'); }
});

test('import portal presents peer converters and keeps installation details in settings', () => {
  const html = renderToStaticMarkup(React.createElement(components.ImportHub, { data: { focus: {} }, call: async () => ({}), onOpenSettings: () => {} }));
  assert.match(html, /aria-label="MinerU"/);
  assert.match(html, /aria-label="Marker"/);
  assert.match(html, /用 Marker 解析/);
  assert.match(html, /安装与使用设置/);
  assert.doesNotMatch(html, /marker#installation|studyhub-marker-convert.py|Apache-2.0|llama-server|选择转换结果/);
});

test('Marker starts from original PDF with course routing, without cloud acknowledgement or manual results', async () => {
  const calls = [], starts = [], file = { name: 'Lecture.pdf', size: 1000 }, plan = { pages: 5, bytes: 1000 };
  const tree = events.PdfConversion({ file, initialPlan: plan, initialConverter: 'marker', initialMarker: { state: 'ready' }, initialSettings: {}, initialLocal: { state: 'ready' },
    courses: ['Mechanics'], call: async (action, args) => { calls.push({ action, args }); return { jobId: 'marker-job' }; }, onStarted: job => starts.push(job) });
  await find(tree, item => item.props.children === '用 Marker 开始解析').props.onClick();
  assert.deepEqual(calls.map(item => item.action), ['marker.import']);
  assert.deepEqual(calls[0].args.courses, ['Mechanics']);
  assert.equal(starts[0].converter, 'marker'); assert.equal(starts[0].filename, file.name);
  const html = renderToStaticMarkup(React.createElement(components.PdfConversion, { file, initialPlan: plan, initialConverter: 'marker', initialMarker: { state: 'ready' }, initialSettings: {}, initialLocal: { state: 'ready' } }));
  assert.doesNotMatch(html, /type="checkbox"|type="password"|选择转换结果|高级：|llama-server/);
});

test('Marker setup is a settings jump rather than installation instructions inside import', () => {
  let anchor;
  const tree = events.PdfConversion({ file: { name: 'Lecture.pdf', size: 1000 }, initialPlan: { pages: 5, bytes: 1000 }, initialConverter: 'marker', initialMarker: { state: 'not-installed' },
    initialSettings: {}, initialLocal: { state: 'ready' }, onOpenSettings: value => { anchor = value; } });
  find(tree, item => item.props.children === '打开设置').props.onClick();
  assert.equal(anchor, 'settings-marker');
  assert.equal(find(tree, item => item.props.children === '用 Marker 开始解析').props.disabled, true);
});

test('script download contains the generated local script and releases the object URL', async () => {
  const originalDocument = globalThis.document, originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const originalTimeout = globalThis.setTimeout;
  let blob, clicked = false, revoked = false;
  const link = { click: () => { clicked = true; } };
  try {
    globalThis.document = { createElement: tag => { assert.equal(tag, 'a'); return link; } };
    URL.createObjectURL = value => { blob = value; return 'blob:marker-test'; };
    URL.revokeObjectURL = value => { assert.equal(value, 'blob:marker-test'); revoked = true; };
    globalThis.setTimeout = callback => { callback(); return 1; };
    components.downloadMarkerScript();
    assert.equal(link.download, MARKER_SCRIPT_FILENAME);
    assert.equal(link.href, 'blob:marker-test');
    assert.equal(await blob.text(), createMarkerConversionScript());
    assert.equal(clicked, true); assert.equal(revoked, true);
  } finally {
    globalThis.document = originalDocument; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
    globalThis.setTimeout = originalTimeout;
  }
});

// Keep state and effect dependencies across renders to exercise the shared upload ownership.
function mountPdf(props, component = 'PdfConversion') {
  const states = [], refs = [], effectDependencies = [], cleanups = [];
  let stateCursor = 0, refCursor = 0, effectCursor = 0, pending = [];
  const mounted = load({ ...React, useId: () => 'mounted-pdf', useContext: () => null, useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useState: initial => { const index = stateCursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial },
    useInsertionEffect: () => {}, useEffect: (effect, dependencies) => { const index = effectCursor++; if (dependencies?.some(item => typeof item === 'string' && item.includes('{'))) return;
      if (!effectDependencies[index] || dependencies.some((value, position) => value !== effectDependencies[index][position])) {
        effectDependencies[index] = dependencies; pending.push(() => { cleanups[index]?.(); cleanups[index] = effect(); });
      }
    } });
  return {
    render(next = props) { stateCursor = 0; refCursor = 0; effectCursor = 0; pending = []; const tree = mounted[component](next); pending.forEach(effect => effect()); return tree; },
    close() { cleanups.forEach(cleanup => cleanup?.()); }, states,
  };
}

test('switching converters preserves one PDF upload and starts the selected converter', async () => {
  const file = Object.assign(new Blob(['original PDF']), { name: 'Original.pdf' });
  const calls = [], starts = [];
  const props = { file, initialSettings: {}, initialLocal: { state: 'ready' }, initialMarker: { state: 'ready' }, courses: ['Mechanics'],
    call: async (action, args) => { calls.push({ action, args });
      if (action === 'mineru.upload.start') return { uploadId: 'shared-pdf' };
      if (action === 'mineru.plan') return { pages: 5, bytes: file.size, windows: [], pieces: [] };
      if (action === 'marker.import') return { jobId: 'selected-marker' };
      return {};
    }, onStarted: job => starts.push(job) };
  const mounted = mountPdf(props); mounted.render(); await new Promise(resolve => setImmediate(resolve));
  const mineru = mounted.render(); find(mineru, item => item.props.title === 'Marker').props.onSelect('marker');
  const marker = mounted.render(); await find(marker, item => item.props.children === '用 Marker 开始解析').props.onClick();
  mounted.close();
  assert.equal(calls.filter(item => item.action === 'mineru.upload.start').length, 1);
  assert.equal(calls.filter(item => item.action === 'mineru.plan').length, 1);
  assert.deepEqual(calls.find(item => item.action === 'marker.import').args, { uploadId: 'shared-pdf', courses: ['Mechanics'] });
  assert.equal(starts[0].converter, 'marker');
  assert.equal(calls.filter(item => item.action === 'mineru.upload.cancel').length, 0, 'started upload belongs to the background job');
});

test('replacing a PDF while its plan is pending cancels that upload and ignores its stale plan', async () => {
  const first = Object.assign(new Blob(['first']), { name: 'First.pdf' }), second = Object.assign(new Blob(['second']), { name: 'Second.pdf' });
  const calls = []; let release;
  const props = { file: first, initialSettings: {}, initialLocal: { state: 'ready' }, initialMarker: { state: 'ready' },
    call: async (action, args) => { calls.push({ action, args });
      if (action === 'mineru.upload.start') return { uploadId: args.name };
      if (action === 'mineru.plan' && args.uploadId === first.name) return new Promise(resolve => { release = resolve; });
      if (action === 'mineru.plan') return { pages: 2, bytes: second.size, windows: [], pieces: [] };
      return {};
    } };
  const mounted = mountPdf(props); mounted.render(); await new Promise(resolve => setImmediate(resolve));
  mounted.render({ ...props, file: second }); await new Promise(resolve => setImmediate(resolve));
  release({ pages: 999, bytes: first.size }); await new Promise(resolve => setImmediate(resolve));
  const tree = mounted.render({ ...props, file: second });
  assert.ok(find(tree, item => item.props.children === second.name));
  assert.ok(mounted.states.some(value => value?.pages === 2));
  assert.ok(!mounted.states.some(value => value?.pages === 999));
  assert.ok(calls.some(item => item.action === 'mineru.upload.cancel' && item.args.uploadId === first.name));
  mounted.close();
});

const flush = () => new Promise(resolve => setImmediate(resolve));
const NOT_SAVED = '没有通过检测，所以没有保存；原来的路径没有改动。';
test('Marker settings load the path promptly and reject a stale initial probe after saving', async () => {
  let releaseSettings, releaseStatus;
  let probes = 0;
  const calls = [];
  const props = { call: async (action, args) => {
    calls.push({ action, args });
    if (action === 'marker.settings.get') return new Promise(resolve => { releaseSettings = resolve; });
    if (action === 'marker.local.status' && ++probes === 1) return new Promise(resolve => { releaseStatus = resolve; });
    if (action === 'marker.local.status') return { state: 'ready' };
    return {};
  } };
  const mounted = mountPdf(props, 'MarkerSettings');
  let tree = mounted.render();
  assert.equal(find(tree, item => item.props?.placeholder === 'marker_single').props.disabled, true);
  releaseSettings({ command: 'old-path' }); await flush();
  tree = mounted.render();
  assert.equal(find(tree, item => item.props?.placeholder === 'marker_single').props.disabled, false, 'editing does not wait for the CLI probe');
  find(tree, item => item.props?.placeholder === 'marker_single').props.onChange({ target: { value: 'new-path' } });
  tree = mounted.render(); await find(tree, item => item.props.children === '检测并保存').props.onClick();
  releaseStatus({ state: 'not-installed' }); await flush();
  tree = mounted.render();
  assert.equal(find(tree, item => item.props?.placeholder === 'marker_single').props.value, 'new-path');
  assert.equal(mounted.states[1].state, 'ready');
  assert.deepEqual(calls.find(item => item.action === 'marker.settings.set').args, { command: 'new-path' });
  const order = calls.map(item => item.action);
  assert.ok(order.lastIndexOf('marker.local.status') < order.indexOf('marker.settings.set'), 'the path is checked before it is saved');
  mounted.close();
});
test('a blank or whitespace path box never overwrites the saved path: 检测并保存 only checks what is in use now', async () => {
  for (const saved of ['', 'F:\\StudyHub-Marker\\venv\\Scripts\\marker_single.exe']) for (const typed of ['', '   ']) {
    const calls = [];
    const props = { call: async (action, args) => { calls.push({ action, args }); if (action === 'marker.settings.get') return { command: saved }; if (action === 'marker.local.status') return { state: 'ready' }; return {}; } };
    const mounted = mountPdf(props, 'MarkerSettings');
    mounted.render(); await flush();
    let tree = mounted.render();
    find(tree, item => item.props?.placeholder === 'marker_single').props.onChange({ target: { value: typed } });
    tree = mounted.render(); await find(tree, item => item.props.children === '检测并保存').props.onClick(); await flush();
    assert.equal(calls.filter(item => item.action === 'marker.settings.set').length, 0, `a blank box ${JSON.stringify(typed)} (saved: ${JSON.stringify(saved)}) writes nothing`);
    const probes = calls.filter(item => item.action === 'marker.local.status');
    assert.equal(probes.length, 2, 'it still checks');
    assert.deepEqual(probes[1].args, {}, 'with no path in the box it asks about what is in use now');
    assert.equal(find(mounted.render(), item => item.props.children === NOT_SAVED), undefined, 'a blank box is not a failed save');
    mounted.close();
  }
});
// Mounts MarkerSettings with a saved path, types `typed`, presses 检测并保存 and returns what was called and what the page shows.
async function checkAndSave({ saved = 'saved-marker', typed, result }) {
  const calls = [];
  const mounted = mountPdf({ call: async (action, args) => { calls.push({ action, args });
    if (action === 'marker.settings.get') return { command: saved };
    if (action === 'marker.local.status') return args?.command ? result : { state: 'ready' };
    return {}; } }, 'MarkerSettings');
  mounted.render(); await flush();
  let tree = mounted.render();
  find(tree, item => item.props?.placeholder === 'marker_single').props.onChange({ target: { value: typed } });
  tree = mounted.render(); await find(tree, item => item.props.children === '检测并保存').props.onClick(); await flush();
  tree = mounted.render();
  return { calls, tree, mounted, hint: find(tree, item => item.props.children === NOT_SAVED), box: find(tree, item => item.props?.placeholder === 'marker_single') };
}
test('a path that passes the check is checked first (with the path, unsaved) and then saved with the same path', async () => {
  const { calls, hint, tree, mounted } = await checkAndSave({ typed: '  new-marker  ', result: { state: 'ready', command: 'new-marker' } });
  const probe = calls.findIndex(item => item.action === 'marker.local.status' && item.args?.command), save = calls.findIndex(item => item.action === 'marker.settings.set');
  assert.ok(probe >= 0, 'the typed path was probed'); assert.ok(save > probe, 'saved only after the probe answered');
  assert.deepEqual(calls[probe].args, { command: 'new-marker' }, 'the probe gets the trimmed path');
  assert.deepEqual(calls[save].args, { command: 'new-marker' }, 'the same path is what is saved');
  assert.equal(calls.filter(item => item.action === 'marker.settings.set').length, 1);
  assert.equal(hint, undefined, 'nothing to explain when it was saved');
  assert.ok(find(tree, item => item.props?.role === 'status' && item.props['data-ready'] === true), 'the page says Marker is ready');
  mounted.close();
});
test('a path that does not pass the check is never saved: the saved path stays and the page says so', async () => {
  for (const result of [{ state: 'unavailable', next: 'recheck', command: 'bad', message: 'Marker 程序暂时无法使用，请检查安装和版本。' }, { state: 'not-installed', next: 'recheck', command: 'bad' }]) {
    const { calls, hint, tree, box, mounted } = await checkAndSave({ typed: 'bad', result });
    assert.deepEqual(calls.filter(item => item.action === 'marker.local.status').at(-1).args, { command: 'bad' }, 'it did check the typed path');
    assert.equal(calls.filter(item => item.action === 'marker.settings.set').length, 0, `${result.state}: nothing is written over the saved path`);
    assert.ok(hint, `${result.state}: the page says nothing was saved`);
    assert.ok(find(tree, item => item.props?.role === 'status' && item.props['data-ready'] === false), 'and that Marker is not ready');
    assert.equal(box.props.value, 'bad', 'the typed path stays in the box to fix');
    box.props.onChange({ target: { value: 'bad2' } });
    assert.equal(find(mounted.render(), item => item.props.children === NOT_SAVED), undefined, 'editing the box clears the note');
    mounted.close();
  }
});
test('a host without audio offers external guidance and never calls unavailable converter operations', async () => {
  const calls = [], call = async action => { calls.push(action); return {}; };
  const settings = mountPdf({ call, available: false }, 'MarkerSettings');
  const tree = settings.render();
  assert.equal(find(tree, item => item.props?.placeholder === 'marker_single').props.disabled, true);
  assert.equal(find(tree, item => item.props.children === '检测并保存').props.disabled, true);
  assert.equal(find(tree, item => item.props.children === '下载 Marker 转换脚本').props.disabled, false);
  const pdf = mountPdf({ call, available: false, file: new Blob(['PDF']) }); pdf.render(); await flush();
  assert.deepEqual(calls, []);
  const html = renderToStaticMarkup(React.createElement(components.ImportHub, { data: { contexts: ['materials'], focus: {} }, call, onOpenSettings: () => {} }));
  assert.match(html, /未启用 PDF 解析组件/);
  assert.match(html, /<button[^>]*disabled[^>]*>用 Marker 解析/);
  settings.close(); pdf.close();
});
