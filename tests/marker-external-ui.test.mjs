import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MAX_TEXT_DOCUMENT_BYTES } from '../lib/office/limits.js';
import { createMarkerConversionScript, MARKER_SCRIPT_FILENAME } from '../lib/marker-external.js';

const compiled = await build({ stdin: { contents: `export { default as ImportHub } from './ui/ImportHub.jsx';
  export { default as MarkerExternal, validateMarkerOutput, downloadMarkerScript } from './ui/MarkerExternal.jsx';
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
  useEffect: () => {}, useMemo: read => read(), useRef: initial => ({ current: initial }) });
function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(item => find(item, predicate)).find(Boolean);
  if (!React.isValidElement(tree)) return undefined;
  return predicate(tree) ? tree : find(tree.props.children, predicate);
}
function file(name, text) { const blob = new Blob([text]); return Object.assign(blob, { name }); }
const output = file('lecture.md', `{0}${'-'.repeat(48)}\n# Mechanics\nEnergy is conserved.\n{1}${'-'.repeat(48)}\nWork transfers energy.`);

test('optional Marker guidance is bilingual, explains local workflow and separate model licenses', () => {
  try {
    for (const language of ['zh', 'en']) {
      components.setUiLanguage(language);
      const html = renderToStaticMarkup(React.createElement(components.MarkerExternal, { settings: true }));
      assert.match(html, /marker#installation/);
      assert.match(html, /marker#commercial-usage/);
      assert.match(html, /python studyhub-marker-convert.py/);
      assert.doesNotMatch(html, /type="file"/);
      if (language === 'en') {
        assert.doesNotMatch(html.replace(/<[^>]*>/g, ''), /[㐀-鿿]/);
        assert.match(html, /does not install or start Marker/);
        assert.match(html, /LLM enhancement off/);
      } else assert.match(html, /添加资料/);
    }
  } finally { components.setUiLanguage('zh'); }
});

test('import portal presents peer converters and keeps installation details in settings', () => {
  const html = renderToStaticMarkup(React.createElement(components.ImportHub, { data: { focus: {} }, call: async () => ({}), onOpenSettings: () => {} }));
  assert.match(html, /aria-label="MinerU"/);
  assert.match(html, /aria-label="Marker"/);
  assert.match(html, /安装与使用设置/);
  assert.doesNotMatch(html, /marker#installation|studyhub-marker-convert.py|Apache-2.0|llama-server/);
  let anchor;
  const marker = events.MarkerExternal({ onOpenSettings: value => { anchor = value; } });
  find(marker, item => item.props.children === '安装与使用设置').props.onClick();
  assert.equal(anchor, 'settings-marker');
});

test('the native picker forwards validated Markdown into the normal course import and completion callbacks', async () => {
  const calls = [], summaries = [];
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const hub = events.ImportHub({ data: { focus: { courses: [] } }, course: 'Mechanics', call: async (action, args) => {
    calls.push({ action, args });
    return { documentId: 'doc', sourceIds: ['p1', 'p2'], document: { title: 'Lecture', format: 'md', sources: [{ document: { converter: 'marker' } }] } };
  }, onImported: value => summaries.push(value), onComplete: complete });
  const marker = find(hub, item => item.type === events.MarkerExternal);
  assert.ok(marker);
  const picker = find(events.MarkerExternal(marker.props), item => item.props.type === 'file');
  const event = { target: { files: [output], value: 'fakepath/lecture.md' } };
  await picker.props.onChange(event);
  const result = await done;
  assert.equal(event.target.value, '');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'materials.document.import');
  assert.deepEqual(calls[0].args.courses, ['Mechanics']);
  assert.equal(calls[0].args.filename, output.name);
  assert.equal(Buffer.from(calls[0].args.dataBase64, 'base64').toString(), await output.text());
  assert.equal(summaries.length, 1);
  assert.equal(result.documents[0].converted, 'marker');
  assert.deepEqual(result.sourceIds, ['p1', 'p2']);
});

test('invalid formats and oversized output produce a visible error without import or automatic retry', async () => {
  assert.equal(await components.validateMarkerOutput(output), output);
  await assert.rejects(components.validateMarkerOutput(file('lecture.md', '# Ordinary unpaginated text')), /分页标记/);
  await assert.rejects(components.validateMarkerOutput(file('lecture.json', '{"children":[]}')), /不是原 PDF 或 JSON/);
  await assert.rejects(components.validateMarkerOutput(file('lecture.pdf', '%PDF')), /不是原 PDF 或 JSON/);
  await assert.rejects(components.validateMarkerOutput({ name: 'huge.md', size: MAX_TEXT_DOCUMENT_BYTES + 1, text: () => assert.fail('must reject before reading') }), /8 MB/);
  let imports = 0;
  changes.length = 0;
  const picker = find(events.MarkerExternal({ onFiles: () => { imports++; } }), item => item.props.type === 'file');
  await picker.props.onChange({ target: { files: [file('wrong.md', '# Missing pagination')], value: 'wrong.md' } });
  assert.equal(imports, 0);
  assert.ok(changes.some(value => typeof value === 'string' && /分页标记/.test(value)));
});

test('busy Marker controls block file handling and keep ordinary import unchanged', async () => {
  const html = renderToStaticMarkup(React.createElement(components.MarkerExternal, { disabled: true }));
  assert.equal((html.match(/<button[^>]*disabled/g) || []).length, 1);
  assert.match(html, /type="file"[^>]*disabled/);
  const tree = events.MarkerExternal({ disabled: true, onFiles: () => assert.fail('busy must not enqueue') });
  await find(tree, item => item.props.type === 'file').props.onChange({ target: { files: [output], value: 'output.md' } });
  const hub = events.ImportHub({ data: { focus: {} }, busy: true, call: () => assert.fail('busy must not import') });
  assert.equal(find(hub, item => item.type === events.MarkerExternal).props.disabled, true);
});

test('an import starting while Marker validation is pending blocks its stale callback with an actionable error', async () => {
  const refs = [], states = [];
  let cursor = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const racing = load({ ...React, useState: initial => [initial, value => states.push(value)],
    useEffect: () => {}, useRef: initial => refs[cursor++] ||= { current: initial } });
  let imports = 0;
  const props = { onFiles: () => { imports++; } };
  const picker = find(racing.MarkerExternal(props), item => item.props.type === 'file');
  const selection = picker.props.onChange({ target: { files: [{ name: 'pending.md', size: 200,
    text: async () => { await pending; return output.text(); } }], value: 'pending.md' } });
  cursor = 0;
  racing.MarkerExternal({ ...props, disabled: true });
  release();
  await selection;
  assert.equal(imports, 0);
  assert.ok(states.includes('另一个操作还在进行，请稍后重试。'));
});

test('closing the import dialog during validation cancels queueing and updates to an unmounted component', async () => {
  const states = [], cleanups = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const mounted = load({ ...React, useState: initial => [initial, value => states.push(value)],
    useEffect: (effect, dependencies) => { if (!dependencies.length) cleanups.push(effect()); }, useRef: initial => ({ current: initial }) });
  let imports = 0;
  const tree = mounted.MarkerExternal({ onFiles: () => { imports++; } });
  const selection = find(tree, item => item.props.type === 'file').props.onChange({ target: {
    files: [{ name: 'pending.md', size: 200, text: async () => { await pending; return output.text(); } }], value: 'pending.md' } });
  cleanups.forEach(cleanup => cleanup());
  const previousStates = states.length;
  release(); await selection;
  assert.equal(imports, 0);
  assert.equal(states.length, previousStates);
});

test('a course change during validation uses the latest import callback', async () => {
  const refs = [], imported = [];
  let cursor = 0, release;
  const pending = new Promise(resolve => { release = resolve; });
  const mounted = load({ ...React, useState: initial => [initial, () => {}], useEffect: () => {},
    useRef: initial => refs[cursor++] ||= { current: initial } });
  const tree = mounted.MarkerExternal({ onFiles: () => imported.push('old course') });
  const selection = find(tree, item => item.props.type === 'file').props.onChange({ target: {
    files: [{ name: 'pending.md', size: 200, text: async () => { await pending; return output.text(); } }], value: 'pending.md' } });
  cursor = 0;
  mounted.MarkerExternal({ onFiles: files => { imported.push('current course'); assert.equal(files[0].name, 'pending.md'); } });
  release(); await selection;
  assert.deepEqual(imported, ['current course']);
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
