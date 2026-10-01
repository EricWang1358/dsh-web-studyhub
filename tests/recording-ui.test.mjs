import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = await build({ entryPoints: ['ui/Ingest.jsx'], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['react'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const Ingest = module.exports.default;
const decks = [{ id: 'system', title: 'System', course: 'A', systemKind: 'slay' },
  { id: 'archived', title: 'Archived', course: 'A', archived: true },
  { id: 'b', title: 'B deck', course: 'B' }, { id: 'a', title: 'A deck', course: 'A' }];
const render = course => renderToStaticMarkup(React.createElement(Ingest, {
  data: { decks, modelReady: true, focus: { course, courses: ['A', 'B', 'Sources only'].map(name => ({ name })) } },
  start() {}, busy: false,
}));

test('recording defaults to the current course and omits system and archived targets', () => {
  const html = render('A');
  assert.match(html, /<option value="a" selected="">/);
  assert.doesNotMatch(html, /<option value="(?:system|archived)"/);
  assert.match(html, /<option value="b"/,'other courses remain explicitly reachable');
});

test('a source-only course starts a new deck with a visible editable course', () => {
  const html = render('Sources only');
  assert.match(html, /<option value="new" selected="">/);
  assert.match(html, /课程归属/);
  assert.match(html, /value="Sources only"/);
});
