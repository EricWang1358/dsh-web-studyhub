/* Switching pages stuttered (owner, 2026-11-05). scripts/qa/page-switch-perf.mjs measured why: the leaving page's state rule set
   `pointer-events: none`, an inherited property, so every switch restyled every element of the old page inside the click (2 600 elements,
   17 ms on 学习库; 9 800 elements, 80 ms on a long page) before the leave motion could start. A leaving page changes only opacity and
   transform (each restyles the page root alone); a press on it during the beat is refused by ui/app/leave-guard.js instead. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, walk, parseCss } from '../scripts/qa/guardrail-baseline.mjs';
import { refuseLeavingPress } from '../ui/app/leave-guard.js';

const PAGE_ROOT = /\.(page|review-page|board-page)\b/;

test('the leaving page changes opacity and transform only, never an inherited property that restyles the whole page', () => {
  const found = [];
  for (const file of walk(join(ROOT, 'ui'), ['.css'])) {
    const rel = relative(ROOT, file).split('\\').join('/');
    for (const d of parseCss(readFileSync(file, 'utf8')).declarations) {
      const selector = d.ctx.at(-1) || '';
      if (selector.includes('.is-leaving') && /\bmain\b/.test(selector) && PAGE_ROOT.test(selector)) found.push(`${rel} (line ${d.line}): ${d.prop}`);
    }
  }
  assert.ok(found.length > 0, 'the leaving state rule is still found');
  assert.deepEqual(found.filter((entry) => !/: (opacity|transform)$/.test(entry)), [], 'set only opacity or transform on a leaving page');
});

/** A press as the browser hands it: the element it landed on, and the two calls that refuse it. */
function press(target) {
  const event = { target, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  return event;
}
const element = (insidePage) => ({ closest: (selector) => (insidePage && selector.includes('.page') ? {} : null) });

test('a press on the page that is leaving does nothing', () => {
  const event = press(element(true));
  refuseLeavingPress(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
});

test('a press outside the leaving page (the top bar, a banner) still works', () => {
  const event = press(element(false));
  refuseLeavingPress(event);
  assert.equal(event.prevented, false);
  assert.equal(event.stopped, false);
});

test('a press on a text node or a target without closest() is left alone', () => {
  const event = press({});
  refuseLeavingPress(event);
  assert.equal(event.stopped, false);
});
