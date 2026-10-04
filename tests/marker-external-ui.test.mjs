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
  useEffect: () => {}, useId: () => 'pdf', useMemo: read => read(), useRef: initial => ({ current: initial }) });
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
  const mounted = load({ ...React, useId: () => 'mounted-pdf',
    useState: initial => { const index = stateCursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef: initial => refs[refCursor++] ||= { current: initial },
    useEffect: (effect, dependencies) => { const index = effectCursor++; if (dependencies?.some(item => typeof item === 'string' && item.includes('{'))) return;
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
  assert.equal(find(tree, item => item.type === 'input').props.disabled, true);
  releaseSettings({ command: 'old-path' }); await flush();
  tree = mounted.render();
  assert.equal(find(tree, item => item.type === 'input').props.disabled, false, 'editing does not wait for the CLI probe');
  find(tree, item => item.type === 'input').props.onChange({ target: { value: 'new-path' } });
  tree = mounted.render(); await find(tree, item => item.props.children === '保存并检测').props.onClick();
  releaseStatus({ state: 'not-installed' }); await flush();
  tree = mounted.render();
  assert.equal(find(tree, item => item.type === 'input').props.value, 'new-path');
  assert.equal(mounted.states[1].state, 'ready');
  assert.deepEqual(calls.find(item => item.action === 'marker.settings.set').args, { command: 'new-path' });
  mounted.close();
});
test('a host without audio offers external guidance and never calls unavailable converter operations', async () => {
  const calls = [], call = async action => { calls.push(action); return {}; };
  const settings = mountPdf({ call, available: false }, 'MarkerSettings');
  const tree = settings.render();
  assert.equal(find(tree, item => item.type === 'input').props.disabled, true);
  assert.equal(find(tree, item => item.props.children === '保存并检测').props.disabled, true);
  assert.equal(find(tree, item => item.props.children === '下载 Marker 转换脚本').props.disabled, false);
  const pdf = mountPdf({ call, available: false, file: new Blob(['PDF']) }); pdf.render(); await flush();
  assert.deepEqual(calls, []);
  const html = renderToStaticMarkup(React.createElement(components.ImportHub, { data: { contexts: ['materials'], focus: {} }, call, onOpenSettings: () => {} }));
  assert.match(html, /未启用 PDF 解析组件/);
  assert.match(html, /<button[^>]*disabled[^>]*>用 Marker 解析/);
  settings.close(); pdf.close();
});
