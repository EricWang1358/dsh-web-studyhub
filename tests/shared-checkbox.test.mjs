import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* #566: every visible checkbox in ui/ is the shared check (`Checkbox`, or `CheckboxInput` for a row that lays out its own label),
   drawn from the tokens. A bare <input type="checkbox"> is left to the browser, and on the dark desk that was a white square.
   The only literal checkbox inputs are the two in ui/components/Choice.jsx, and both carry .sh-check__input. */
const root = process.cwd();
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const jsxFiles = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const path = join(dir, entry.name);
  return entry.isDirectory() ? jsxFiles(path) : entry.name.endsWith('.jsx') ? [path] : [];
});
const files = jsxFiles(join(root, 'ui')).map(path => ({ file: relative(root, path).split('\\').join('/'), text: stripComments(readFileSync(path, 'utf8')) }));

/* Answer choices whose input is a radio or a checkbox depending on the question kind (single or multiple choice). They are one
   control pair: converting only the checkbox half would draw the two kinds differently, so they stay native together. */
const ANSWER_CHOICES = new Set(['ui/Draft.jsx', 'ui/guided-study/GuidedStudyWorkbench.jsx']);
const LITERAL = /\btype=(?:"checkbox"|'checkbox'|\{\s*['"`]checkbox['"`]\s*\})/g;
const DYNAMIC = /\btype=\{[^}]*['"`]checkbox['"`][^}]*\}/;

/** The opening tag around a match: from the last `<input` before it to the end of the line after it (enough for the className). */
const tagAround = (text, index) => text.slice(text.lastIndexOf('<input', index), text.indexOf('\n', index) === -1 ? undefined : text.indexOf('\n', index));

test('no ui/**/*.jsx renders a bare checkbox: use Checkbox or CheckboxInput (#566)', () => {
  const bare = [];
  for (const { file, text } of files) {
    for (const match of text.matchAll(LITERAL)) {
      const tag = tagAround(text, match.index);
      if (file === 'ui/components/Choice.jsx' && /sh-check__input/.test(tag)) continue;
      bare.push(`${file}: ${tag.trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(bare, [], 'a hand-written <input type="checkbox"> draws the browser\'s box: use <Checkbox> (a labelled row) or <CheckboxInput> (the box alone) from ui/components');
});

test('a checkbox whose type is computed is one of the allowed answer choices (#566)', () => {
  const found = new Set();
  for (const { file, text } of files) if (DYNAMIC.test(text)) found.add(file);
  assert.deepEqual([...found].filter(file => !ANSWER_CHOICES.has(file)), [], 'a computed type="checkbox": use <CheckboxInput>, or add the file to ANSWER_CHOICES with the reason');
  assert.deepEqual([...ANSWER_CHOICES].filter(file => !found.has(file)), [], 'stale ANSWER_CHOICES entry: delete it');
});

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { Checkbox, CheckboxInput } from './ui/components/index.js';`, resolveDir: root },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);
const { Checkbox, CheckboxInput } = module.exports;

test('CheckboxInput is the shared box alone: the same class as Checkbox, attributes passed through', () => {
  const box = renderToStaticMarkup(React.createElement(CheckboxInput, { checked: true, indeterminate: true, disabled: true, 'aria-label': '选择主题 A', className: 'x', onChange() {} }));
  assert.match(box, /^<input /);
  assert.match(box, /type="checkbox"/);
  assert.match(box, /class="sh-check__input x"/);
  assert.match(box, /aria-label="选择主题 A"/);
  assert.match(box, /checked=""/);
  assert.match(box, /disabled=""/);
  assert.doesNotMatch(box, /indeterminate/, 'indeterminate is a DOM property set from the ref, not an attribute');
  const row = renderToStaticMarkup(React.createElement(Checkbox, { label: 'x', checked: false, onChange() {} }));
  assert.match(row, /<input type="checkbox" class="sh-check__input"/);
});

test('the shared check is drawn from tokens, with a ticked, a mixed and a forced-colours state', () => {
  const css = stripComments(readFileSync(join(root, 'ui/components/fields.css'), 'utf8'));
  const rule = selector => css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
  const box = rule('.sh-check__input');
  assert.match(box, /appearance:\s*none/, 'the box is not left to the browser');
  assert.doesNotMatch(box, /accent-color/);
  assert.match(box, /border:[^;]*var\(--/);
  assert.match(box, /background:\s*var\(--/);
  assert.match(rule('.sh-check__input:is(:checked, :indeterminate)'), /background:\s*var\(--accent\)/);
  assert.match(rule('.sh-check__input:checked::before'), /scale\(1\)/);
  assert.match(rule('.sh-check__input:indeterminate::before'), /clip-path/);
  assert.match(css, /@media \(forced-colors: active\)\s*\{\s*\.sh-check__input\s*\{\s*appearance:\s*auto/);
  for (const [, value] of css.matchAll(/\.sh-check__input[^{]*\{([^}]*)\}/g)) assert.doesNotMatch(value, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'tokens only');
});

test('no feature stylesheet resizes or recolours the shared box', () => {
  const offenders = [];
  const cssFiles = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? cssFiles(path) : entry.name.endsWith('.css') ? [path] : [];
  });
  for (const path of cssFiles(join(root, 'ui'))) {
    const file = relative(root, path).split('\\').join('/');
    if (file === 'ui/components/fields.css') continue;
    for (const [, selector, body] of stripComments(readFileSync(path, 'utf8')).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      // `input:not([type="checkbox"])` is a rule for the other inputs; base.css's `:not([class^="sh-"])` defaults reach only the answer choices above.
      if (/:not\(\[class\^="sh-"\]/.test(selector) || !/sh-check__input|type=["']?checkbox/.test(selector.replace(/:not\([^)]*\)/g, ''))) continue;
      if (/(?:^|[\s;])(?:width|height|accent-color|appearance)\s*:/.test(body)) offenders.push(`${file}: ${selector.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'the size and colours of a checkbox belong to .sh-check__input in ui/components/fields.css');
});
