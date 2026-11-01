import test from 'node:test';
import assert from 'node:assert/strict';
import { basename } from 'node:path';
import vm from 'node:vm';
import React from 'react';
import ReactDOM from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildHostClient } from '../scripts/build.mjs';

const PACKAGE_ID = '@ericwang1358/dsh-daily-flashcard';
const built = await buildHostClient({ write: false });
const emitted = new Map(built.outputFiles.map(file => [basename(file.path), file.text]));

function createClassicHarness({ welcomed = true, failChunks = false, language = 'zh' } = {}) {
  const factories = new Map(), cache = new Map(), arrivals = [], styles = [], effects = [];
  const slots = [], rightTabs = [], previews = [], selected = [], disposers = [];
  const dictionaries = {};
  const storage = new Map(welcomed ? [['studyhub.welcomed.v1', '2026-10-01T00:00:00.000Z']] : []);
  storage.set('study-ui-language', language);
  const localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  };
  const browser = {
    localStorage,
    addEventListener() {},
    removeEventListener() {},
    document: {
      compatMode: 'CSS1Compat',
      documentElement: { style: {} },
      createElement: () => ({ style: {}, remove() {} }),
      head: { append: node => styles.push(node), appendChild: node => styles.push(node) },
    },
  };
  const navigator = { platform: 'Win32', userAgent: 'test', language, languages: [language] };
  const context = vm.createContext({
    window: browser,
    document: browser.document,
    localStorage,
    navigator,
    console,
    TextDecoder,
    TextEncoder,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
  });
  browser.__ModuleLoader__ = {
    load({ id, chunk, factory }) {
      assert.equal(id, PACKAGE_ID);
      const key = chunk ? `${id}/${chunk}` : id;
      assert.equal(factories.has(key), false, `duplicate module registration ${key}`);
      factories.set(key, factory);
    },
  };
  async function asyncModule(spec) {
    assert.match(spec, /^\.\/client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/);
    const name = spec.slice(2), key = `${PACKAGE_ID}/${name}`;
    if (failChunks) throw new Error(`Failed to load module script ${name}`);
    if (!factories.has(key)) {
      assert.ok(emitted.has(name), `missing emitted chunk ${name}`);
      arrivals.push(name);
      vm.runInContext(emitted.get(name), context, { filename: name });
    }
    return materialize(key);
  }
  function materialize(id) {
    if (id === 'react') return React;
    if (id === 'react-dom') return ReactDOM;
    if (cache.has(id)) return cache.get(id);
    assert.ok(factories.has(id), `missing registered module ${id}`);
    const require = spec => materialize(spec);
    require.async = asyncModule;
    const exports = factories.get(id)(require);
    cache.set(id, exports);
    return exports;
  }
  const layout = {
    selectPanel(id) {
      if (id !== null && !slots.some(slot => slot.descriptor.name === 'main' && slot.descriptor.key === id))
        throw new Error(`layout.selectPanel: main panel "${id}" is not registered`);
      selected.push(id);
    },
  };
  const ctx = {
    get: name => (name === 'layout' ? layout : undefined),
    effect(fn, label) {
      effects.push(label);
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    locale: {
      register(ns, dictionary) {
        dictionaries[ns] = dictionary;
        return () => { delete dictionaries[ns]; };
      },
      bind: ns => key => dictionaries[ns]?.[language]?.[key] ?? key,
    },
    slots: {
      inject(_name, fn) { return fn(); },
      register(descriptor, component) {
        const entry = { descriptor, component, active: true };
        slots.push(entry);
        return () => { entry.active = false; };
      },
    },
    sidebarRightTabs: {
      register(def) { rightTabs.push(def); return () => {}; },
    },
    documentPreviews: {
      register(def) { previews.push(def); return () => {}; },
    },
    inject(_services, fn) {
      const dispose = fn(ctx);
      if (typeof dispose === 'function') disposers.push(dispose);
    },
  };
  vm.runInContext(emitted.get('client.js'), context, { filename: 'client.js' });
  const entry = materialize(PACKAGE_ID);
  const disposeAll = () => { while (disposers.length) disposers.pop()?.(); };
  return { entry, ctx, arrivals, styles, effects, slots, rightTabs, previews, selected, storage, dictionaries, browser, navigator, disposeAll };
}

function withBrowserGlobals(harness, fn) {
  const keys = ['window', 'document', 'localStorage', 'navigator'];
  const saved = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: harness.browser });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: harness.browser.document });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: harness.browser.localStorage });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: harness.navigator });
  try {
    return fn();
  } finally {
    keys.forEach((key, index) => saved[index] ? Object.defineProperty(globalThis, key, saved[index]) : delete globalThis[key]);
  }
}

test('apply(ctx) activates with zero chunk fetches, registers every host surface, and renders the sidebar glyph without loading workspace chunks (#630)', async () => {
  const harness = createClassicHarness({ welcomed: true, language: 'zh' });
  try {
    await withBrowserGlobals(harness, () => harness.entry.apply(harness.ctx));
    assert.deepEqual(harness.arrivals, [], 'boot activation must fetch 0 sibling chunks');
    assert.equal(harness.styles.length, 0, 'heavy StudyHub stylesheets stay unloaded while the user stays in Chat');
    assert.equal(harness.dictionaries['study-workspace']?.zh?.tab, 'StudyHub');
    assert.equal(harness.dictionaries['study-workspace']?.en?.page, 'StudyHub');

    const findSlot = (name, key) => harness.slots.find(slot => slot.descriptor.name === name &&
      (key === undefined || slot.descriptor.id === key || slot.descriptor.key === key));
    assert.ok(findSlot('conversation.view', 'study-workspace'), 'conversation StudyHub tab registered');
    assert.ok(findSlot('sidebar.right.pane.tab', 'study-workspace'), 'right sidebar StudyHub tab registered');
    assert.ok(findSlot('main', 'studyhub'), 'root StudyHub main panel registered');
    assert.ok(findSlot('study-workspace.page'), 'session-scoped StudyHub page slot registered');
    assert.ok(findSlot('sidebar.panellist', 'studyhub'), 'left sidebar StudyHub entry registered');
    assert.ok(findSlot('sidebar.right.tab.document.actions', 'study-selection-learning'), 'document toolbar action slot registered');
    assert.ok(findSlot('sidebar.right.tab.document', 'study-html'), 'Study HTML preview body slot registered');
    assert.equal(harness.rightTabs[0]?.id, 'study-workspace');
    assert.equal(harness.previews[0]?.id, 'study-html');
    assert.equal(withBrowserGlobals(harness, () => harness.previews[0].title()), '学习 HTML');

    const glyphHtml = withBrowserGlobals(harness, () =>
      renderToStaticMarkup(React.createElement(findSlot('sidebar.panellist', 'studyhub').component, { size: 16, active: false })));
    assert.match(glyphHtml, /<svg[^>]*width="16"/, 'left sidebar renders the StudyHub mark');
    assert.deepEqual(harness.arrivals, [], 'rendering DSH left sidebar must still fetch 0 sibling chunks');

    const actionsHtml = withBrowserGlobals(harness, () =>
      renderToStaticMarkup(React.createElement(findSlot('sidebar.right.tab.document.actions', 'study-selection-learning').component, {
        sessionId: 's1', absolutePath: 'D:/notes.md',
      })));
    assert.equal(actionsHtml, '', 'unloaded preview toolbar action renders nothing so the 38px header row stays intact');

    const convHtml = withBrowserGlobals(harness, () =>
      renderToStaticMarkup(React.createElement(findSlot('conversation.view', 'study-workspace').component, {
        sessionId: 's1', openView() {},
      })));
    assert.match(convHtml, /class="study-seat-frame"[^>]*data-conversation-composer-overlay=""/,
      'conversation seat shell reserves the floating DSH composer even before studyhub.css arrives');
  } finally {
    harness.disposeAll();
  }
});

test('first-run landing still selects the StudyHub panel once without blocking boot on chunk fetches (#630)', async () => {
  const harness = createClassicHarness({ welcomed: false, language: 'en' });
  try {
    await withBrowserGlobals(harness, () => harness.entry.apply(harness.ctx));
    assert.deepEqual(harness.arrivals, [], 'first-run registration still fetches 0 chunks inside apply(ctx)');
    assert.equal(withBrowserGlobals(harness, () => harness.previews[0].title()), 'Study HTML');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(harness.selected, ['studyhub']);
    assert.ok(harness.storage.get('studyhub.welcomed.v1'));
  } finally {
    harness.disposeAll();
  }
});

test('a blocked sibling chunk never rejects apply(ctx) or takes down DSH web boot (#630)', async () => {
  const harness = createClassicHarness({ welcomed: true, failChunks: true });
  try {
    await assert.doesNotReject(async () => {
      await withBrowserGlobals(harness, () => harness.entry.apply(harness.ctx));
    });
    assert.deepEqual(harness.arrivals, []);
  } finally {
    harness.disposeAll();
  }
});
