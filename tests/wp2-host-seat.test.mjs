import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* The DSH seat is bundled with App replaced by a probe, so these tests see
   exactly what the host adapter hands the shared UI and registers with DSH. */
const appProbe = {
  name: 'app-probe',
  setup(builder) {
    builder.onResolve({ filter: /[\\/]App\.jsx$/ }, () => ({ path: 'app-probe', namespace: 'probe' }));
    builder.onLoad({ filter: /.*/, namespace: 'probe' }, () => ({ loader: 'js', contents:
      "import React from 'react'; export default function App(props) { globalThis.__studyApp.push(props);" +
      " return React.createElement('div', { 'data-probe': 'app' }); }" }));
  },
};
async function load(entry) {
  const compiled = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs',
    external: ['react', 'react-dom'], loader: { '.css': 'text' }, plugins: [appProbe], logLevel: 'silent' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
const workspace = await load('ui/host/workspace.jsx');

function fakeHost({ storage = new Map(), layoutReady = true } = {}) {
  const registrations = [], dictionaries = {}, disposers = [], styles = [], selected = [];
  const layout = { selectPanel(id) {
    if (id !== null && !registrations.some(r => r.descriptor.name === 'main' && r.descriptor.key === id))
      throw new Error(`layout.selectPanel: main panel "${id}" is not registered`);
    selected.push(id);
  } };
  const services = { layout: layoutReady ? layout : undefined, uiWorkspace: { startSession() { selected.push('new-session'); } } };
  const ctx = {
    get: name => services[name],
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    inject: (_names, fn) => fn(ctx),
    locale: {
      register(ns, dictionary) { dictionaries[ns] = dictionary; return () => {}; },
      bind: ns => key => dictionaries[ns]?.en?.[key] ?? key,
    },
    slots: {
      inject: (_name, fn) => fn(),
      register(descriptor, component) { registrations.push({ descriptor, component }); return () => {}; },
    },
    sidebarRightTabs: { register: () => () => {} },
  };
  const window = { localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) } };
  const document = { createElement: () => ({ remove() {} }), head: { appendChild: node => styles.push(node.textContent) } };
  return { ctx, registrations, dictionaries, disposers, styles, selected, storage, window, document, services };
}
async function applyWith(host) {
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = host.window; globalThis.document = host.document;
  try {
    workspace.apply(host.ctx, () => {});
    await new Promise(resolve => setTimeout(resolve, 30));
  } finally {
    for (const key of Object.keys(previous)) previous[key] === undefined ? delete globalThis[key] : globalThis[key] = previous[key];
    host.disposers.forEach(dispose => dispose());
  }
  return host;
}
const find = (host, name, key) => host.registrations.find(r => r.descriptor.name === name &&
  (r.descriptor.id === key || r.descriptor.key === key));
function renderApp(element) {
  globalThis.__studyApp = [];
  const html = renderToStaticMarkup(element);
  return { html, props: globalThis.__studyApp };
}
const CAPABILITIES = { edition: 'plugin', chat: true, agentTasks: false, landing: false };

test('every DSH seat hands App the plugin host capabilities', async () => {
  const host = await applyWith(fakeHost());
  for (const [name, key] of [['conversation.view', 'study-workspace'], ['sidebar.right.pane.tab', 'study-workspace']]) {
    const { component } = find(host, name, key);
    const { props } = renderApp(React.createElement(component, { sessionId: 'session-1', openView() {} }));
    assert.equal(props.length, 1, `${name} renders App once`);
    assert.deepEqual(props[0].host.capabilities, CAPABILITIES);
    assert.equal(typeof props[0].call, 'function');
  }
});

test('StudyHub is a top-level DSH page with a labelled sidebar entry', async () => {
  const host = await applyWith(fakeHost());
  const page = find(host, 'main', 'studyhub');
  assert.ok(page, 'a root main panel keyed studyhub is registered');
  assert.deepEqual(page.descriptor.children, { 'study-workspace.page': { kind: 'single', scope: 'session-maybe' } },
    'the page follows the current session like the Conversation does');
  const entry = find(host, 'sidebar.panellist', 'studyhub');
  assert.ok(entry, 'the DSH left sidebar lists the page');
  assert.equal(entry.descriptor.label(), 'StudyHub');
  assert.ok(entry.descriptor.order < 0, 'listed above Plugins (order 0)');
  const glyph = renderToStaticMarkup(React.createElement(entry.component, { size: 16, active: false }));
  assert.match(glyph, /<svg[^>]*width="16"/);
  // The panel renders its session-scoped child slot, which renders the shared App.
  let rendered = null;
  const panel = renderToStaticMarkup(React.createElement(page.component, { renderSlot: (name, props) => { rendered = name; return React.createElement('i', props); } }));
  assert.equal(rendered, 'study-workspace.page');
  assert.match(panel, /<i>/);
  const child = find(host, 'study-workspace.page');
  const { html, props } = renderApp(React.createElement(child.component, { sessionId: 'session-2' }));
  assert.match(html, /data-probe="app"/);
  assert.deepEqual(props[0].host.capabilities, CAPABILITIES);
  assert.match(html, /studyhub-page/);
});

test('without a session the page explains itself and offers DSH\'s own New Session', async () => {
  const host = await applyWith(fakeHost());
  const child = find(host, 'study-workspace.page');
  const { html, props } = renderApp(React.createElement(child.component, { sessionId: undefined }));
  assert.equal(props.length, 0, 'no library can open without a session workspace');
  assert.match(html, /新建会话/);
  assert.match(html, /<button[^>]*type="button"/);
});

test('enabling the plugin opens StudyHub once, then remembers it', async () => {
  const first = await applyWith(fakeHost());
  assert.deepEqual(first.selected, ['studyhub']);
  assert.ok(first.storage.get('studyhub.welcomed.v1'));
  const again = await applyWith(fakeHost({ storage: first.storage }));
  assert.deepEqual(again.selected, [], 'a later load never steals the main view');
  const blocked = fakeHost();
  blocked.window = {};
  assert.deepEqual((await applyWith(blocked)).selected, [], 'without durable storage it would reopen on every load, so it never auto-opens');
});

test('the conversation Study tab reserves the DSH composer height instead of sitting under it', async () => {
  const host = await applyWith(fakeHost());
  const main = renderToStaticMarkup(React.createElement(find(host, 'conversation.view', 'study-workspace').component, { sessionId: 's', openView() {} }));
  assert.match(main, /class="study-seat-frame"[^>]*data-conversation-composer-overlay=""/);
  const side = renderToStaticMarkup(React.createElement(find(host, 'sidebar.right.pane.tab', 'study-workspace').component, { sessionId: 's' }));
  assert.doesNotMatch(side, /data-conversation-composer-overlay/, 'the right sidebar has no composer');
  const css = host.styles.join('\n');
  assert.match(css, /\.study-seat-frame\s*\{[^}]*padding-bottom:\s*calc\(var\(--dsh-composer-height,\s*152px\)/);
  // .study-seat contains fixed modals; a 90vh modal would overflow the shorter seat and lose its footer.
  assert.match(css, /\.study-seat \.modal:not\(dialog\)\s*\{[^}]*max-height:\s*min\(90vh,\s*100%\)/);
});

test('user-facing DSH labels say StudyHub in both languages', async () => {
  const { dictionaries } = await applyWith(fakeHost());
  const copy = dictionaries['study-workspace'];
  for (const language of ['zh', 'en']) {
    assert.equal(copy[language].tab, 'StudyHub');
    assert.equal(copy[language].page, 'StudyHub');
    assert.doesNotMatch(copy[language].guide, /DSH|Daily Flashcard/);
  }
});
