import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, FROZEN_FILES, cssFiles } from '../scripts/qa/css-tools.mjs';
import { checkStructure, wrapStylesheet, layerOf, optionsOf, HOST_FILES, LAYER_STATEMENT } from '../scripts/qa/css-layers.mjs';

// #149: one scope and cascade layers instead of five ways to write "inside the app".
const read = (file) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

test('every stylesheet sits in a study layer and, inside it, in the :is(.study-app, .study-seat) scope', () => {
  const problems = [];
  for (const file of cssFiles()) {
    if (FROZEN_FILES.includes(file)) continue; // owned by another work package this wave (see FROZEN_FILES); wrap it with css-layers.mjs when it lands
    for (const problem of checkStructure(read(file), optionsOf(file))) problems.push(`${file}: ${problem}`);
  }
  assert.deepEqual(problems, [], 'wrap new stylesheets with: node scripts/qa/css-layers.mjs wrap <file>');
});

test('the host-world stylesheets are the only ones allowed to leave the scope, and each says why', () => {
  assert.deepEqual(Object.keys(HOST_FILES).sort(), ['ui/document-preview/document-preview.css', 'ui/host/studyhub.css', 'ui/panel-bridge.css']);
  for (const file of Object.keys(HOST_FILES)) assert.ok(existsSync(join(ROOT, file)), file);
  assert.match(read('ui/document-preview/document-preview.css'), /host-embedded/, 'the unscoped part is marked');
});

test('the layer statement is identical in every sheet, so any injection order gives the same layer order', () => {
  for (const file of cssFiles()) {
    if (FROZEN_FILES.includes(file)) continue;
    assert.ok(read(file).includes(LAYER_STATEMENT), `${file} declares the layer order`);
  }
});

test('the wrapper puts bare, scoped and root rules where they belong and is idempotent', () => {
  const source = [
    '.plain { color: red; }',
    '.study-app .old, :is(.study-app, .study-seat) .both { color: blue; }',
    ':where(.study-app) .where { color: green; }',
    '.study-app[data-theme="light"] .themed { color: black; }',
    '.study-seat .seat-only { color: white; }',
    ':where(.study-app) { & { display: flex; } button { margin: 0; } &::before { content: ""; } }',
    '@container study (max-width: 600px) { .narrow { padding: 0; } .study-app .narrow2 { padding: 0; } }',
    '@keyframes spin { to { opacity: 1; } }',
    '',
  ].join('\n');
  const wrapped = wrapStylesheet(source, 'features');
  assert.deepEqual(checkStructure(wrapped), []);
  assert.equal(wrapStylesheet(wrapped, 'features'), wrapped, 'a wrapped sheet is left alone');
  assert.match(wrapped, /@layer study\.features \{/);
  assert.match(wrapped, /\.plain \{ color: red; \}/);
  assert.match(wrapped, /\.old,\s*\.both \{ color: blue; \}/, 'both scope spellings become one relative selector');
  assert.match(wrapped, /\.where \{ color: green; \}/);
  assert.match(wrapped, /\.study-app\[data-theme="light"\] \.themed \{/, 'a root-conditional selector stays a root rule');
  assert.match(wrapped, /\.study-seat \.seat-only \{/, 'a seat-only rule stays a root rule');
  assert.match(wrapped, /\.study-app \{\s*display: flex;/, 'the app box itself is a root rule, not the seat');
  assert.match(wrapped, /& button \{ margin: 0; \}/);
  assert.match(wrapped, /\.study-app::before \{/);
  assert.match(wrapped, /@container study \(max-width: 600px\) \{/);
  assert.match(wrapped, /@keyframes spin/);
  assert.notEqual(checkStructure('.loose { color: red; }').length, 0, 'an unwrapped sheet is reported');
  assert.notEqual(checkStructure(`${LAYER_STATEMENT}\n@layer study.features { .loose { color: red; } }`).length, 0, 'an unscoped rule inside a layer is reported');
});

test('layers by path: tokens and element defaults low, components, features, host chrome on top', () => {
  assert.equal(layerOf('ui/tokens.css'), 'tokens');
  assert.equal(layerOf('ui/accent.css'), 'tokens');
  assert.equal(layerOf('ui/base.css'), 'reset');
  assert.equal(layerOf('ui/motion.css'), 'reset', 'its !important rules must win, and !important inverts the layer order');
  assert.equal(layerOf('ui/components/components.css'), 'components');
  assert.equal(layerOf('ui/legacy.css'), 'components');
  assert.equal(layerOf('ui/review/question.css'), 'features');
  assert.equal(layerOf('ui/host/studyhub.css'), 'overrides');
});
