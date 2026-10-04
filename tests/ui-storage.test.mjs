import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

// #115: one safe reader/writer for browser storage. A missing, corrupt or throwing storage never breaks the page.
const m = await loadUi(`export * from './ui/storage.js';`);
const memory = (entries = {}) => {
  const map = new Map(Object.entries(entries));
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => void map.set(key, String(value)), removeItem: key => void map.delete(key), map };
};
const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('denied'); } };

test('readJSON returns the fallback for missing, corrupt and unreadable values', () => {
  assert.deepEqual(m.readJSON('k', { a: 1 }, memory()), { a: 1 });
  assert.deepEqual(m.readJSON('k', [], memory({ k: '{not json' })), []);
  assert.equal(m.readJSON('k', 'x', broken), 'x');
  assert.equal(m.readJSON('k', null, null), null, 'no storage at all');
  assert.deepEqual(m.readJSON('k', null, memory({ k: '{"a":2}' })), { a: 2 });
  assert.equal(m.readJSON('k', 5, memory({ k: 'null' })), null, 'a stored null is a value, not a miss');
});

test('writeJSON and removeKey swallow storage errors and say whether it worked', () => {
  const store = memory();
  assert.equal(m.writeJSON('k', { a: 1 }, store), true);
  assert.equal(store.map.get('k'), '{"a":1}');
  assert.equal(m.writeJSON('k', 1, broken), false);
  assert.equal(m.writeJSON('k', 1, null), false);
  assert.equal(m.writeJSON('k', undefined, store), false, 'undefined has no JSON form');
  assert.equal(m.removeKey('k', store), true);
  assert.equal(store.map.has('k'), false);
  assert.equal(m.removeKey('k', broken), false);
});

test('readText and writeText keep plain text as written and never throw (#115)', () => {
  const store = memory({ page: 'review' });
  assert.equal(m.readText('page', '', store), 'review');
  assert.equal(m.readText('none', 'fallback', store), 'fallback');
  assert.equal(m.readText('page', 'x', broken), 'x');
  assert.equal(m.readText('page', 'x', null), 'x');
  assert.equal(m.writeText('page', 7, store), true);
  assert.equal(store.map.get('page'), '7', 'text, not JSON');
  assert.equal(m.writeText('page', 'a', broken), false);
  assert.equal(m.writeText('page', 'a', null), false);
});

test('the browser storage is asked of a scope (the host page\'s window in the DSH seat), the session one of globalThis, and a blocked one is null (#115)', () => {
  const scope = { localStorage: memory() };
  assert.equal(m.browserStorage(scope), scope.localStorage);
  assert.equal(m.browserStorage({}), null);
  assert.equal(m.browserStorage({ get localStorage() { throw new Error('blocked'); } }), null);
  assert.equal(m.browserSession(), globalThis.sessionStorage ?? null);
});

test('a persistent state starts from the stored value (parse) and falls back to the initial one', () => {
  const store = memory({ theme: 'dark' });
  const Probe = ({ storage, initial = 'light', options = {} }) => React.createElement('b', null, m.usePersistentState('theme', initial, { storage, ...options })[0]);
  assert.match(renderToStaticMarkup(React.createElement(Probe, { storage: store, options: { parse: raw => raw, serialize: String } })), />dark</);
  assert.match(renderToStaticMarkup(React.createElement(Probe, { storage: memory() })), />light</);
  assert.match(renderToStaticMarkup(React.createElement(Probe, { storage: broken })), />light</);
  assert.match(renderToStaticMarkup(React.createElement(Probe, { storage: memory({ theme: '"mist"' }) })), />mist</, 'JSON by default');
  assert.match(renderToStaticMarkup(React.createElement(Probe, { storage: memory({ theme: 'x' }), options: { parse: () => { throw new Error('bad'); } } })), />light</, 'a parse that throws is a miss');
});

test('persistentCodec reads and writes with the same rules the hook uses', () => {
  const store = memory();
  const codec = m.persistentCodec('k', { serialize: value => (value ? '1' : '0'), parse: raw => raw === '1' }, store);
  assert.equal(codec.read(true), true, 'missing: the initial value');
  codec.write(false);
  assert.equal(store.map.get('k'), '0');
  assert.equal(codec.read(true), false);
  codec.write(true);
  assert.equal(codec.read(false), true);
  assert.doesNotThrow(() => m.persistentCodec('k', {}, broken).write(1));
});
