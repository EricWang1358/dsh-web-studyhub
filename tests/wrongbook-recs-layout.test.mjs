import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* The recommendation rows of the wrong book show a question on one line (nowrap + ellipsis). In a grid whose column is just `auto`,
   the column's minimum becomes the length of the longest question, so the whole panel grew wider than the page and the text ran
   off its right edge without an ellipsis. The grid column must be allowed to shrink. */

const css = readFileSync(new URL('../ui/wrongbook.css', import.meta.url), 'utf8');

/** The body of the first rule written exactly as `selector { ... }` at the start of its line (not a longer selector list). */
function rule(selector) {
  for (const line of css.split('\n')) void line;
  const start = css.search(new RegExp(`^[ \\t]*${selector.split('.').join('\\.')}[ \\t]*\\{`, 'm'));
  if (start === -1) return '';
  const open = css.indexOf('{', start);
  return css.slice(open + 1, css.indexOf('}', open));
}

test('the recommendations panel is a grid whose column can shrink below its longest question', () => {
  const panel = rule('.wb-recs');
  assert.match(panel, /display:\s*grid/);
  assert.match(panel, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'an auto column would be as wide as the longest nowrap question');
  assert.match(panel, /min-width:\s*0/);
});

test('the question stays a single ellipsised line that may shrink', () => {
  const prompt = rule('.wb-prompt');
  assert.match(prompt, /min-width:\s*0/);
  assert.match(prompt, /text-overflow:\s*ellipsis/);
  assert.match(prompt, /white-space:\s*nowrap/);
});
