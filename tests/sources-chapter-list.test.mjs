import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* The chapter list of a big converted book (资料 page, "查看 N 章"): one line per chapter (title, size, 从这一章出题), inside a list that
   scrolls on its own. A rule written for the plain page buttons (`.source-doc__page-list button { display:flex; width:100% }`) also caught
   the 从这一章出题 button, so it dropped to a line of its own, centred, and every chapter took two rows; and a 400-page book simply pushed
   the whole page down. */

const css = readFileSync(new URL('../ui/sources.css', import.meta.url), 'utf8');

/** The body of the first rule whose selector (after trimming) is exactly `selector`. */
function rule(selector) {
  const pattern = new RegExp(`(?:^|\\n)[ \\t]*${selector.replace(/[.>:()[\]]/g, match => `\\${match}`)}[ \\t]*\\{([^}]*)\\}`);
  return pattern.exec(css)?.[1] ?? '';
}

test('a chapter row is one flex line: the title takes the room, the generate button keeps its own width', () => {
  const row = rule('.source-doc__chapters > li');
  assert.match(row, /display:\s*flex/);
  assert.match(row, /align-items:\s*center/);
  assert.match(rule('.source-doc__chapters > li > .sh-btn'), /flex:\s*none/);
  assert.match(rule('.source-doc__chapters > li > .sh-btn'), /width:\s*auto/);
});

test('the full-width rule is for the plain row buttons only, not for the .sh-btn actions inside the list', () => {
  assert.match(css, /\.source-doc__page-list button:not\(\.sh-btn\)\s*\{[^}]*width:\s*100%/);
  assert.doesNotMatch(css, /\.source-doc__page-list button\s*\{[^}]*width:\s*100%/, 'a bare `button` selector also catches .sh-btn');
});

test('the list scrolls inside its own box and the title ellipsises instead of wrapping', () => {
  const list = rule('.source-doc__page-list');
  assert.match(list, /max-height:/);
  assert.match(list, /overflow-y:\s*auto/);
  assert.match(list, /overscroll-behavior:\s*contain/);
  const title = rule('.source-doc__page-list button:not(.sh-btn) > span');
  assert.match(title, /text-overflow:\s*ellipsis/);
  assert.match(title, /white-space:\s*nowrap/);
  assert.match(title, /min-width:\s*0/);
});
