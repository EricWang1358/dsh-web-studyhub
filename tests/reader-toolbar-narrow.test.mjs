import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTree, walkTree } from '../scripts/qa/css-tools.mjs';

/* In a narrow reader (a phone-width window) the toolbar's end group held "Practise these pages", search, 译, Aa, the panel toggle and the generate button on ONE
   nowrap line, right-aligned: wider than the reader, it overflowed to the LEFT, so the first button sat at x < 0 and could not be reached. The group must wrap. */

const css = readFileSync(new URL('../ui/document-preview/reader/reader.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let end;
walkTree(parseTree(css), (node, ancestors) => {
  if (node.kind === 'rule' && /(^|,\s*)\.reader-toolbar__group--end$/.test(node.prelude) && ancestors.some((a) => a.prelude === '@container reader (max-width: 640px)')) end = node;
});
const decl = (prop) => end?.decls.find((d) => d.prop === prop)?.value ?? '';

test('in a narrow reader the toolbar end group wraps instead of overflowing to the left', () => {
  assert.ok(end, 'the narrow container block has a rule for the end group');
  assert.match(decl('flex-wrap'), /^wrap$/);
  assert.match(decl('justify-content'), /^flex-start$/, 'a wrapped row starts at the left edge, so nothing can end up at a negative x');
});
