import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTree, walkTree } from '../scripts/qa/css-tools.mjs';

// #178: a mailbox entry is clamped to one or two lines, and shows everything while it is hovered or keyboard-focused.
const rules = [];
walkTree(parseTree(readFileSync(new URL('../ui/inbox.css', import.meta.url), 'utf8')), (node) => { if (node.kind === 'rule') rules.push(node); });
const decl = (node, prop) => node.decls.find((d) => d.prop === prop)?.value;
const open = (part) => rules.find((r) => r.prelude.includes(':is(:hover, :focus-visible, :focus-within)') && r.prelude.includes(part));

test('the clamps are on by default', () => {
  const base = (cls) => rules.find((r) => r.prelude.endsWith(cls));
  assert.equal(decl(base('.mailbox__deck'), 'white-space'), 'nowrap');
  assert.equal(decl(base('.mailbox__prompt'), 'white-space'), 'nowrap');
  assert.equal(decl(base('.mailbox__detail'), '-webkit-line-clamp'), '2');
});

test('hover, keyboard focus and focus-within lift every clamp, with no transition', () => {
  const lines = open('.mailbox__deck');
  assert.ok(lines, 'a rule for the deck title and prompt');
  assert.match(lines.prelude, /\.mailbox__prompt/);
  assert.equal(decl(lines, 'white-space'), 'normal');
  assert.equal(decl(lines, 'overflow'), 'visible');
  assert.equal(decl(lines, 'text-overflow'), 'clip');
  const detail = open('.mailbox__detail');
  assert.ok(detail, 'a rule for the reply');
  assert.equal(decl(detail, '-webkit-line-clamp'), 'unset');
  assert.equal(decl(detail, 'line-clamp'), 'unset');
  for (const rule of [lines, detail]) assert.equal(decl(rule, 'transition'), undefined, 'nothing animates, so reduced motion needs no override');
});
