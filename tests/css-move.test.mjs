import test from 'node:test';
import assert from 'node:assert/strict';
import { moveRule } from '../scripts/qa/css-move.mjs';

// #151: moving a rule to the stylesheet that owns its class must keep its cascade: same layer, same scope wrapper, same at-rule.
const LAYER = '@layer study.reset, study.tokens, study.components, study.features, study.overrides;\n\n';
const sheet = (body, scope = ':is(.study-app, .study-seat)') => `${LAYER}@layer study.features {\n  ${scope} {\n${body}  }\n}\n`;
const rules = (text) => text.replace(LAYER, '');

test('a rule moves to the end of the same scope in the other sheet, untouched', () => {
  const from = sheet('    .a { color: red; }\n    .note .b { margin: 0 var(--space-2); }\n    .c { color: blue; }\n');
  const to = sheet('    .b { margin: 1px; }\n');
  const out = moveRule(from, to, '.note .b');
  assert.equal(out.from, sheet('    .a { color: red; }\n    .c { color: blue; }\n'));
  assert.equal(out.to, sheet('    .b { margin: 1px; }\n    .note .b { margin: 0 var(--space-2); }\n'));
});

test('a multi-line rule moves with its own indentation', () => {
  const from = sheet('    .x .b {\n      margin: 0;\n      gap: 1px;\n    }\n');
  const out = moveRule(from, sheet('    .b { margin: 1px; }\n'), '.x .b');
  assert.match(out.to, /    \.b \{ margin: 1px; \}\n    \.x \.b \{\n      margin: 0;\n      gap: 1px;\n    \}\n  \}/);
  assert.doesNotMatch(out.from, /\.x \.b/);
});

test('one entry of a selector list splits off; the others stay where they were', () => {
  const from = sheet('    .p .b,\n    .q .b { gap: 1px; }\n');
  const out = moveRule(from, sheet('    .b { gap: 0; }\n'), '.q .b');
  assert.match(out.from, /\.p \.b \{ gap: 1px; \}/);
  assert.doesNotMatch(out.from, /\.q \.b/);
  assert.match(out.to, /\.q \.b \{ gap: 1px; \}/);
});

test('a rule inside an at-rule goes to the same at-rule of the other sheet', () => {
  const at = (body) => `${LAYER}@layer study.features {\n  :is(.study-app, .study-seat) {\n    .b { gap: 0; }\n  }\n  @container study (max-width: 600px) {\n    :is(.study-app, .study-seat) {\n${body}    }\n  }\n}\n`;
  const out = moveRule(at('      .x .b { gap: 1px; }\n'), at('      .b { gap: 2px; }\n'), '.x .b');
  assert.match(out.to, /\.b \{ gap: 2px; \}\n      \.x \.b \{ gap: 1px; \}\n    \}\n  \}\n\}/);
  assert.doesNotMatch(out.from, /\.x \.b/);
});

test('it refuses what would change the cascade: another scope wrapper, a missing at-rule, a missing rule', () => {
  const low = sheet('    .b { gap: 0; }\n', ':where(.study-app, .study-seat)');
  const high = sheet('    .x .b { gap: 1px; }\n');
  assert.throws(() => moveRule(high, low, '.x .b'), /scope/);
  assert.throws(() => moveRule(high, high, '.nope'), /no rule/);
  const wrapped = `${LAYER}@layer study.features {\n  @media (max-width: 1px) {\n    :is(.study-app, .study-seat) {\n      .x .b { gap: 1px; }\n    }\n  }\n}\n`;
  assert.throws(() => moveRule(wrapped, high, '.x .b'), /at-rule/);
});

test('with createAt, a missing at-rule is added at the end of the layer, around a scope block of the same kind', () => {
  const wrapped = `${LAYER}@layer study.features {\n  @media (max-width: 1px) {\n    :is(.study-app, .study-seat) {\n      .x .b { gap: 1px; }\n    }\n  }\n}\n`;
  const to = sheet('    .b { gap: 0; }\n');
  const out = moveRule(wrapped, to, '.x .b', { createAt: true });
  assert.equal(out.to, `${LAYER}@layer study.features {\n  :is(.study-app, .study-seat) {\n    .b { gap: 0; }\n  }\n  @media (max-width: 1px) {\n    :is(.study-app, .study-seat) {\n      .x .b { gap: 1px; }\n    }\n  }\n}\n`);
});

test('it refuses to cross cascade layers (a component-layer sheet is below every feature sheet)', () => {
  const components = sheet('    .b { gap: 0; }\n').replace('@layer study.features {', '@layer study.components {');
  assert.throws(() => moveRule(sheet('    .x .b { gap: 1px; }\n'), components, '.x .b'), /layer/);
});

test('CRLF sheets stay CRLF', () => {
  const crlf = (text) => text.replace(/\n/g, '\r\n');
  const out = moveRule(crlf(sheet('    .x .b { gap: 1px; }\n')), crlf(sheet('    .b { gap: 0; }\n')), '.x .b');
  assert.ok(!/(?<!\r)\n/.test(out.from) && !/(?<!\r)\n/.test(out.to), 'no bare LF');
  assert.match(rules(out.to), /\.x \.b \{ gap: 1px; \}/);
});
