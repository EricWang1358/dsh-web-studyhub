import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ICON_MAP, OUTPUT, iconPathsModule, pathsOfSvg } from '../scripts/icons/build-icons.mjs';
import { ICON_PATHS } from '../ui/components/icon-paths.js';

// Icons are Phosphor Light (MIT): scripts/icons/build-icons.mjs holds the name map and writes ui/components/icon-paths.js; Icon.jsx draws from it.
const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { Icon, ICON_NAMES } from './ui/components/index.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { Icon, ICON_NAMES } = module.exports;
const h = React.createElement;
const BRAND = ['brand', 'brand-compact'];

test('icon-paths.js is exactly what the generator makes from @phosphor-icons/core (run node scripts/icons/build-icons.mjs --write)', async () => {
  assert.equal(readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n'), await iconPathsModule());
});

test('every registry name is a Phosphor path or a brand mark, and every mapped name is in the registry', () => {
  for (const name of ICON_NAMES) {
    if (BRAND.includes(name)) { assert.equal(ICON_PATHS[name], undefined, `${name} stays custom`); continue; }
    const paths = ICON_PATHS[name];
    assert.ok(paths && [].concat(paths).every((d) => typeof d === 'string' && /^M/.test(d)), `${name} has path data`);
  }
  assert.deepEqual([...ICON_NAMES].filter((n) => !BRAND.includes(n)).sort(), Object.keys(ICON_MAP).sort());
  assert.deepEqual(Object.keys(ICON_PATHS).sort(), Object.keys(ICON_MAP).sort());
  for (const name of ['check', 'search', 'plus', 'chevron-down', 'settings']) assert.ok(ICON_NAMES.includes(name), `${name} exists for Select/Combobox`);
});

test('a Phosphor icon renders as a 256-grid fill in currentColor, hidden from assistive tech', () => {
  const html = renderToStaticMarkup(h(Icon, { name: 'check', size: 20, className: 'x' }));
  assert.match(html, /^<svg class="sh-icon x" viewBox="0 0 256 256" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">/);
  assert.match(html, /<path d="M228\.24,76\.24/);
  assert.doesNotMatch(html, /stroke=/);
  assert.equal(renderToStaticMarkup(h(Icon, { name: 'nope' })), '');
});

test('strokeWidth above the default emboldens the glyph (the heavier tick of a checked box) and the default adds nothing', () => {
  assert.doesNotMatch(renderToStaticMarkup(h(Icon, { name: 'check' })), /stroke/);
  assert.match(renderToStaticMarkup(h(Icon, { name: 'check', strokeWidth: 2.4 })), /stroke="currentColor" stroke-width="[\d.]+"[^>]*stroke-linejoin="round"/);
});

test('the brand marks stay hand-drawn strokes on a 32 grid', () => {
  for (const name of BRAND) assert.match(renderToStaticMarkup(h(Icon, { name })), /viewBox="0 0 32 32"[^>]*fill="none" stroke="currentColor"/, name);
});

test('the generator refuses what a plain fill path cannot draw', () => {
  assert.deepEqual(pathsOfSvg('<svg viewBox="0 0 256 256" fill="currentColor"><path d="M1,1Z"/><path d="M2,2Z"/></svg>', 't'), ['M1,1Z', 'M2,2Z']);
  assert.throws(() => pathsOfSvg('<svg viewBox="0 0 256 256"><circle cx="1"/></svg>', 't'), /unexpected <circle>/);
  assert.throws(() => pathsOfSvg('<svg viewBox="0 0 256 256"><path d="M1Z" opacity="0.2"/></svg>', 't'), /opacity/);
  assert.throws(() => pathsOfSvg('<svg viewBox="0 0 24 24"><path d="M1Z"/></svg>', 't'), /256 grid/);
});
