import test from 'node:test';
import assert from 'node:assert/strict';
import { specificity, rulesOf, orderPairs } from '../scripts/qa/css-order-pairs.mjs';

// #151: moving a rule changes its place in the source order; only equal-specificity rules on one subject can notice.
const sheet = (body, scope = ':where(.study-app, .study-seat)') => `@layer study.features {\n  ${scope} {\n${body}  }\n}\n`;

test('specificity counts ids, classes/attributes/pseudo-classes and types; :where is free and :is/:not take their most specific argument', () => {
  assert.deepEqual(specificity('.a .b'), [0, 2, 0]);
  assert.deepEqual(specificity('.a > button.b:hover'), [0, 3, 1]);
  assert.deepEqual(specificity('.a[data-x="1"]::before'), [0, 2, 1]);
  assert.deepEqual(specificity(':where(.a, .b) .c'), [0, 1, 0]);
  assert.deepEqual(specificity('.a :is(.b, #c .d)'), [1, 2, 0]);
  assert.deepEqual(specificity('.a:not(.b)'), [0, 2, 0]);
});

test('the :is() scope wrapper adds a class, the :where() one does not', () => {
  assert.equal(rulesOf(sheet('    .a { gap: 1px; }\n'), 'one.css')[0].spec, '0,1,0');
  assert.equal(rulesOf(sheet('    .a { gap: 1px; }\n', ':is(.study-app, .study-seat)'), 'one.css')[0].spec, '0,2,0');
});

test('a moved rule meets a rule of another sheet only at equal specificity, with a property and a subject class in common', () => {
  const rule = '    .x .b { gap: 1px; }\n';
  const before = [...rulesOf(sheet(rule), 'old.css'), ...rulesOf(sheet('    .y .b { gap: 2px; }\n    .y .b { color: red; }\n    .x .c { gap: 3px; }\n    .y .b:hover { gap: 4px; }\n'), 'other.css')];
  const after = [...rulesOf(sheet(rule), 'new.css'), ...before.slice(1)];
  const { moved, across, within } = orderPairs(before, after);
  assert.equal(moved.length, 1);
  assert.deepEqual(across.map(([a, b]) => `${a.entry} | ${b.entry}`), ['.x .b | .y .b'], 'colour, another subject and a higher specificity do not count');
  assert.deepEqual(within, []);
});

test('a pair inside the new sheet is reported separately', () => {
  const before = [...rulesOf(sheet('    .x .b { gap: 1px; }\n'), 'old.css'), ...rulesOf(sheet('    .y .b { gap: 2px; }\n'), 'new.css')];
  const after = rulesOf(sheet('    .y .b { gap: 2px; }\n    .x .b { gap: 1px; }\n'), 'new.css');
  const { across, within } = orderPairs(before, after);
  assert.equal(across.length, 0);
  assert.equal(within.length, 1);
});
