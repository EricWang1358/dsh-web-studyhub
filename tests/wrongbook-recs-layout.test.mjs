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

test('the recommendations panel and body are grids whose columns can shrink below their longest question', () => {
  for (const selector of ['.wb-recs', '.wb-recs-body']) {
    const grid = rule(selector);
    assert.match(grid, /display:\s*grid/, `${selector} uses grid layout`);
    assert.match(grid, /grid-template-columns:\s*minmax\(0,\s*1fr\)/, `${selector}: an auto column would expand to the longest nowrap question`);
    assert.match(grid, /min-width:\s*0/, `${selector} may shrink`);
  }
});

test('the question stays a single ellipsised line that may shrink', () => {
  const prompt = rule('.wb-prompt');
  assert.match(prompt, /min-width:\s*0/);
  assert.match(prompt, /text-overflow:\s*ellipsis/);
  assert.match(prompt, /white-space:\s*nowrap/);
});
