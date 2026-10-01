import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const packageId = '@ericwang1358/dsh-daily-flashcard';

// Portable harness for the official DSH 0.2.0-rc.1 classic chunk contract.
// Separately verified 2026-10-01 against the actual ClientModuleSystem at
// D:/Program Files/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules/
// @deepseek-ai/dsh-client-modules/lib/client.js: native activation and all seven
// real lazy importers materialized through 24 revisioned module arrivals.
// index.js serves sibling client.*.js; client.js invalidates their factories,
// caches and stylesheet ownership with the parent plugin, not another plugin.

test('generated native modules resolve through classic chunk factories and share host React', async () => {
  // Assert before importing: the old script ran shared builds on import and had
  // no isolated build face. This witnesses the missing distribution boundary.
  const source = await readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  assert.match(source, /export async function buildHostClient/);
  const { buildHostClient, buildPreview } = await import('../scripts/build.mjs');
  const result = await buildHostClient({ write: false });
  const files = new Map(result.outputFiles.map(file => [basename(file.path), file.text]));
  assert.ok(files.size > 5, 'features and shared dependencies must be separate emitted modules');
  assert.ok(files.has('client.js'));
  for (const name of files.keys()) assert.match(name, /^client(?:\.[A-Za-z0-9][A-Za-z0-9._-]*)?\.js$/);
  assert.ok(!Object.keys(result.metafile.inputs).some(path => /node_modules[\\/]react[\\/]/.test(path)),
    'native modules must never contain a React implementation');

  const factories = new Map(), cache = new Map(), arrivals = [], materialized = [], lazyLoads = [];
  const hostReact = new Proxy(React, { get(target, key) {
    if (key === 'lazy') return load => { lazyLoads.push(load); return target.lazy(load); };
    return Reflect.get(target, key);
  } });
  const slots = [], styles = [], effects = [];
  const browser = { addEventListener() {}, removeEventListener() {},
    document: { compatMode: 'CSS1Compat', documentElement: { style: {} },
      createElement: () => ({ style: {}, remove() {} }), head: { append: node => styles.push(node), appendChild: node => styles.push(node) } } };
  const context = vm.createContext({ window: browser, document: browser.document, console,
    navigator: { platform: 'Win32', userAgent: 'test' },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {} });
  browser.__ModuleLoader__ = { load({ id, chunk, factory }) {
    assert.equal(id, packageId);
    const key = chunk ? `${id}/${chunk}` : id;
    assert.equal(factories.has(key), false, 'a module must register once');
    factories.set(key, factory);
  } };
  function materialize(id) {
    if (id === 'react') return hostReact;
    if (cache.has(id)) return cache.get(id);
    assert.ok(factories.has(id), `missing registered module ${id}`);
    const require = spec => materialize(spec);
    require.async = async spec => {
      assert.match(spec, /^\.\/client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/);
      const name = spec.slice(2), key = `${packageId}/${name}`;
      if (!factories.has(key)) {
        assert.ok(files.has(name), `missing emitted chunk ${name}`);
        arrivals.push(name);
        vm.runInContext(files.get(name), context, { filename: name });
      }
      return materialize(key);
    };
    const exports = factories.get(id)(require);
    cache.set(id, exports); materialized.push(id);
    return exports;
  }
  vm.runInContext(files.get('client.js'), context, { filename: 'client.js' });
  assert.equal(factories.size, 1, 'arrival only registers the entry factory');
  assert.equal(styles.length, 0);
  const entry = materialize(packageId);
  assert.deepEqual([...entry.inject], ['slots', 'locale']);
  assert.equal(arrivals.length, 0, 'entry materialization does not fetch optional features');
  const ctx = {
    get: () => undefined,
    effect(fn, label) { effects.push(label); fn(); },
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (_name, fn) => fn(), register: (descriptor, component) => { slots.push({ descriptor, component }); return () => {}; } },
    sidebarRightTabs: { register: () => () => {} },
    documentPreviews: { register: () => () => {} },
    inject: (_services, fn) => fn(ctx),
  };
  await entry.apply(ctx);
  for (const id of ['study-workspace', 'study-selection-learning'])
    assert.ok(slots.some(slot => slot.descriptor.id === id), `missing native slot ${id}`);
  assert.ok(slots.some(slot => slot.descriptor.key === 'study-html'), 'native selection preview must remain registered');
  assert.ok(effects.includes('study conversation panel bridge'));
  const loadedAtBoot = [...materialized];
  const featureInputs = ['ui/BlogNotes.jsx', 'ui/Skeleton.jsx', 'ui/Workflows.jsx'];
  for (const input of featureInputs) {
    const output = Object.entries(result.metafile.outputs).find(([, record]) => record.entryPoint === input);
    assert.ok(output, `missing optional module boundary for ${input}`);
    const name = basename(output[0]);
    assert.ok(!loadedAtBoot.includes(`${packageId}/${name}`), `${input} must stay optional at host activation`);
  }
  // Execute the real React.lazy importers, including editor and math libraries.
  // A missing shared registration, or an incorrect async load order, fails here.
  for (const [, output] of Object.entries(result.metafile.outputs)) {
    for (const edge of output.imports.filter(edge => edge.kind === 'dynamic-import')) {
      assert.ok(files.has(basename(edge.path)));
    }
  }
  const notesEntry = Object.entries(result.metafile.outputs).find(([, record]) => record.entryPoint === 'ui/BlogNotes.jsx');
  assert.ok(notesEntry);
  assert.equal(lazyLoads.length, 7);
  await Promise.all(lazyLoads.map(load => load()));
  assert.equal(cache.size, files.size, 'every emitted module can materialize');
  const notes = cache.get(`${packageId}/${basename(notesEntry[0])}`);
  assert.equal(React.isValidElement(React.createElement(notes.default, {})), true);
  const native = slots.find(slot => slot.descriptor.id === 'study-selection-learning');
  assert.equal(renderToStaticMarkup(React.createElement(native.component, { sessionId: 's', absolutePath: 'D:/notes.html' })), '');
  const preview = await buildPreview({ write: false });
  assert.deepEqual(preview.outputFiles.map(file => basename(file.path)).sort(), ['app.css', 'app.js'],
    'the existing local preview server must still serve every preview asset');
  assert.doesNotMatch(preview.outputFiles.find(file => basename(file.path) === 'app.js').text, /require\.async\(/);
});
