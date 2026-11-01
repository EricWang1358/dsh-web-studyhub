import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleSignatures, diffSignatures } from '../scripts/qa/css-rules-diff.mjs';

// A rule that only moved between sheets (or out of a selector list) is the same rule; a changed declaration or wrapper is not.
const sheet = (body, scope = ':is(.study-app, .study-seat)') => `@layer study.features {\n  ${scope} {\n${body}  }\n}\n`;

test('moving a rule to another sheet, or splitting it out of a list, changes no signature', () => {
  const before = [...ruleSignatures(sheet('    .a, .b { gap: 1px; color: red; }\n')), ...ruleSignatures(sheet('    .c { margin: 0; }\n'))];
  const after = [...ruleSignatures(sheet('    .a { color: red; gap: 1px; }\n')), ...ruleSignatures(sheet('    .c { margin: 0; }\n    .b { gap: 1px; color: red; }\n'))];
  assert.deepEqual(diffSignatures(before, after), { removed: [], added: [] });
});

test('a changed declaration, scope or at-rule shows up as one removed and one added rule', () => {
  const base = ruleSignatures(sheet('    .a { gap: 1px; }\n'));
  assert.equal(diffSignatures(base, ruleSignatures(sheet('    .a { gap: 2px; }\n'))).added.length, 1);
  assert.equal(diffSignatures(base, ruleSignatures(sheet('    .a { gap: 1px; }\n', ':where(.study-app, .study-seat)'))).removed.length, 1);
  const wrapped = '@layer study.features {\n  @media (max-width: 1px) {\n    :is(.study-app, .study-seat) {\n      .a { gap: 1px; }\n    }\n  }\n}\n';
  assert.equal(diffSignatures(base, ruleSignatures(wrapped)).added.length, 1);
});

test('two copies of a rule are two rules', () => {
  const one = ruleSignatures(sheet('    .a { gap: 1px; }\n'));
  const two = ruleSignatures(sheet('    .a { gap: 1px; }\n    .a { gap: 1px; }\n'));
  assert.deepEqual(diffSignatures(two, one).removed.length, 1);
});
