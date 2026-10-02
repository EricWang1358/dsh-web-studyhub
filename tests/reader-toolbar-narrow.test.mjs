import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* In a narrow reader (a phone-width window) the toolbar's end group held "Practise these pages", search, 译, Aa, the panel toggle and the generate button on ONE
   nowrap line, right-aligned: wider than the reader, it overflowed to the LEFT, so the first button sat at x < 0 and could not be reached. The group must wrap. */

const css = readFileSync(new URL('../ui/document-preview/reader/reader.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = css.indexOf('@container reader (max-width: 640px) {\n    .reader-toolbar');
const block = start < 0 ? '' : css.slice(start, css.indexOf('\n  }\n', start));

test('in a narrow reader the toolbar end group wraps instead of overflowing to the left', () => {
  assert.ok(block.length > 0, 'the narrow container block exists');
  const end = /\.reader-toolbar__group--end\s*\{([^}]*)\}/.exec(block)?.[1] ?? '';
  assert.match(end, /flex-wrap:\s*wrap/);
  assert.match(end, /justify-content:\s*flex-start/, 'a wrapped row starts at the left edge, so nothing can end up at a negative x');
});
