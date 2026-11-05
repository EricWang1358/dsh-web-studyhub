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
import { appearanceAttrs, seatAttrs } from '../ui/appearance-prefs.js';

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

/* The new page arriving is a DOM insertion, and so is every toast, row and badge React adds later. A :has() that is not in the subject of
   its selector (`.x:has(...) <target>`) is checked again on such insertions, and when the target names no class, id, element or attribute
   (`*`, `:focus-visible`, `:not(...)`) Chrome restyles everything under the elements the :has() was tried on: on 创建题组, with
   `.study-app:is([data-motion='off'], :has(> .study-app[data-motion='off'])) *` in the sheet, inserting one <p> restyled all 6 266
   elements (70-110 ms in the development build) where it restyles 289 without such a rule. Name the target, or stamp what the :has()
   asked for on the element itself. */
const splitTop = (text, separators) => {
  const out = [];
  let depth = 0, quote = '', cur = '';
  for (const ch of text) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && separators.includes(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((part) => part.trim()).filter(Boolean);
};
/** The flat selectors a declaration's nesting chain stands for (`&` is the parent; a nested selector without one is its descendant). */
const flatSelectors = (ctx) => ctx.filter((prelude) => !prelude.startsWith('@')).reduce((parents, prelude) => parents.flatMap((parent) =>
  splitTop(prelude, ',').map((part) => (!parent ? part : part.includes('&') ? part.replaceAll('&', `:is(${parent})`) : `:is(${parent}) ${part}`))), ['']);
/** A compound without its :not(...) and :has(...) groups and pseudo-classes (:is and :where keep what they name). */
const withoutNegations = (compound) => {
  let out = '';
  for (let i = 0; i < compound.length; i++) {
    const head = compound.slice(i, i + 5);
    if (head === ':not(' || head === ':has(') {
      let depth = 0, j = i + 4;
      for (; j < compound.length; j++) { if (compound[j] === '(') depth++; else if (compound[j] === ')' && --depth === 0) break; }
      i = j;
      continue;
    }
    out += compound[i];
  }
  return out.replace(/::?[\w-]+/g, (pseudo) => (/^:(is|where)$/.test(pseudo) ? pseudo : ''));
};
/** Selectors whose :has() sits before a combinator and whose target names nothing Chrome can narrow the restyle to. */
function unboundedHasSelectors(css) {
  const found = new Set();
  for (const d of parseCss(css).declarations) for (const flat of flatSelectors(d.ctx)) for (const selector of splitTop(flat, ',')) {
    const compounds = splitTop(selector, ' >+~');
    if (!compounds.slice(0, -1).some((compound) => compound.includes(':has('))) continue;
    if (!/[.#[]|^[a-z]/i.test(withoutNegations(compounds.at(-1)).replace(/^\*/, ''))) found.add(selector);
  }
  return [...found];
}

test('the :has() guard tells a whole-app restyle from a narrow one', () => {
  const scope = (body) => `@layer study.features {\n  :is(.study-app, .study-seat) {\n${body}\n  }\n}\n`;
  assert.equal(unboundedHasSelectors(scope("&:is([data-motion='off'], :has(> .study-app[data-motion='off'])) *::before { transition: none; }")).length, 1);
  assert.equal(unboundedHasSelectors(scope('.row:has(> .delete) > :not(.open, .delete) { grid-column: 1 / -1; }')).length, 1);
  assert.equal(unboundedHasSelectors(scope('.x:has(.y) {\n  :focus-visible { outline: 0; }\n}')).length, 1, 'nesting puts the :has() before the combinator too');
  assert.equal(unboundedHasSelectors(scope('.row:has(> .delete) { gap: 0; }\n.row:has(> .delete) > .meta { gap: 0; }')).length, 0, 'a subject :has() and a named target are fine');
  assert.equal(unboundedHasSelectors(scope("&[data-motion='off'] *:not(.spin) { transition: none; }")).length, 0, 'an attribute on the root needs no :has()');
});

test('no stylesheet has a :has() that makes every insertion restyle the whole app', () => {
  const found = [];
  for (const file of walk(join(ROOT, 'ui'), ['.css'])) {
    const rel = relative(ROOT, file).split('\\').join('/');
    for (const entry of unboundedHasSelectors(readFileSync(file, 'utf8'))) found.push(`${rel}: ${entry}`);
  }
  assert.deepEqual(found, []);
});

test('the DSH seat wears the motion and contrast choices itself, so what sits beside the app (a note, the candidate dialog) follows them without a :has()', () => {
  const dark = { light: false, reducedMotion: false, contrast: false };
  assert.deepEqual(seatAttrs(appearanceAttrs({ motion: 'off', contrast: 'high' }, dark)), { 'data-motion': 'off', 'data-contrast': 'high' });
  assert.deepEqual(seatAttrs(appearanceAttrs({}, { ...dark, reducedMotion: true })), { 'data-motion': 'reduced', 'data-contrast': 'standard' }, 'auto follows the system');
  const workspace = readFileSync(join(ROOT, 'ui/host/workspace.jsx'), 'utf8');
  assert.match(workspace, /const seatLook = useSeatAppearance\(\);/);
  assert.match(workspace, /<div className="study-seat" \{\.\.\.seatLook\}>/);
});
