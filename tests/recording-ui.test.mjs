import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { nativeSelects } from './helpers/native-selects.mjs';

const compiled = await build({ entryPoints: ['ui/Ingest.jsx'], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['react'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
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
  // 新建题组 is the picker's footer action, not an option: with no deck of the course the form is the new-deck form (a name and a folder to fill).
  assert.doesNotMatch(html, /<option value="new"/);
  assert.match(html, /data-footer-action="new-deck"/);
  assert.match(html, /<label>题组名称<input required/);
  assert.match(html, /课程归属/);
  assert.match(html, /value="Sources only"/);
});
