import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, parseTree, walkTree, splitSelectorList } from '../scripts/qa/css-tools.mjs';
import { SCOPE_LOW } from '../scripts/qa/css-layers.mjs';

// #574: Chinese has no spaces to fall back on, so the greedy default strands the last character of a line ("…留到下一" + "轮").
// The line-breaking rules live once, in the element layer (the lowest), so every component and feature can still choose its own.
const read = (file) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

/** Every declaration of `prop` in a sheet, with the layer, the scope rule and the selectors it sits under. */
function declarations(file, prop) {
  const found = [];
  walkTree(parseTree(read(file)), (node, ancestors) => {
    if (node.kind !== 'rule') return;
    for (const decl of node.decls) {
      if (decl.prop !== prop) continue;
      const layer = ancestors.find((a) => a.kind === 'at' && a.prelude.startsWith('@layer'))?.prelude;
      const scope = ancestors.filter((a) => a.kind === 'rule').map((a) => a.prelude);
      found.push({ layer, scope, inMedia: ancestors.some((a) => /^@(container|media|supports)/.test(a.prelude)),
        selectors: splitSelectorList(node.prelude).map((s) => s.replace(/^&\s*/, '')), value: decl.value });
    }
  });
  return found;
}

test('headings balance and paragraphs avoid a one-character last line, in the element layer of base.css', () => {
  const rules = declarations('ui/base.css', 'text-wrap-style');
  const at = (value) => rules.filter((rule) => rule.value === value);
  for (const [value, selectors] of [['balance', ['h1', 'h2', 'h3', 'h4']], ['pretty', ['p']]]) {
    const matching = at(value);
    assert.equal(matching.length, 1, `one ${value} rule`);
    const [rule] = matching;
    assert.equal(rule.layer, '@layer study.reset', `${value} sits in the lowest layer, so components and features outrank it`);
    assert.deepEqual(rule.scope, [SCOPE_LOW], `${value} is scoped to the app and the seat with zero specificity`);
    assert.equal(rule.inMedia, false, `${value} holds at every width`);
    assert.deepEqual(rule.selectors.sort(), selectors);
  }
  assert.deepEqual(rules.map((rule) => rule.value).sort(), ['balance', 'pretty'], 'nothing else in base.css sets a wrap style');
});

test('the global rule uses the longhand, so a nowrap (own or inherited) is never switched back to wrapping', () => {
  // `text-wrap: balance` is a shorthand that also resets text-wrap-mode to wrap; on an element-level rule that would undo an ancestor's nowrap.
  assert.deepEqual(declarations('ui/base.css', 'text-wrap'), [], 'base.css sets text-wrap-style only');
  assert.doesNotMatch(read('ui/base.css'), /@supports[^{]*text-wrap/, 'no polyfill or feature query: an older browser keeps the default breaks');
});

test('inputs, code, pre and table cells are left to the default breaks', () => {
  const named = declarations('ui/base.css', 'text-wrap-style').flatMap((rule) => rule.selectors);
  for (const element of ['input', 'textarea', 'select', 'code', 'pre', 'table', 'td', 'th', 'li']) {
    assert.ok(!named.some((selector) => new RegExp(`(^|[^\\w-])${element}($|[^\\w-])`).test(selector)), `${element} is not named`);
  }
});

test('the page lead balances like the empty-state copy (pretty only stops a one-character last line)', () => {
  const lead = declarations('ui/components/components.css', 'text-wrap').filter((rule) => rule.selectors.includes('.sh-page-header__description'));
  assert.deepEqual(lead.map((rule) => [rule.layer, rule.value]), [['@layer study.components', 'balance']]);
});
