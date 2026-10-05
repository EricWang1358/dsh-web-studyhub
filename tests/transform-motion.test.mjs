/* #101: motion is transform and opacity only (ui/DESIGN.md). No `transition` in ui CSS may list width, height, left, top, right or bottom,
   except the content-driven cases below, each with the reason it cannot be a transform. The list only shrinks. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, walk, parseCss } from '../scripts/qa/guardrail-baseline.mjs';

const LAYOUT_PROP = /(?<![\w-])(width|height|left|top|right|bottom|max-height|max-width|min-height|min-width)(?![\w-])/;

/* file | selector -> why */
const ALLOWED = {
  'ui/review/question.css | .flip-inner': 'the card grows to the height of the face that is up while it turns; the height is content-driven (FlipCard measures it)',
  'ui/review/question.css | .smooth-height': 'the response area under a card eases to its content height (auto height, no fixed size to scale from)',
  'ui/skeleton.css | & button.skc-class': 'focus-view boxes of the structure canvas glide to positions the layout engine writes as left/top; dragging switches the transition off',
};

const found = [];
for (const file of walk(join(ROOT, 'ui'), ['.css'])) {
  const rel = relative(ROOT, file).split('\\').join('/');
  for (const d of parseCss(readFileSync(file, 'utf8')).declarations) {
    if (!/^transition(-property)?$/.test(d.prop)) continue;
    if (LAYOUT_PROP.test(d.value)) found.push({ key: `${rel} | ${d.ctx.at(-1)}`, line: d.line, value: d.value.replace(/\s+/g, ' ') });
  }
}

test('no transition animates width, height, left, top, right or bottom outside the documented content-driven cases', () => {
  const unexpected = found.filter((f) => !(f.key in ALLOWED));
  assert.deepEqual(unexpected.map((f) => `${f.key} (line ${f.line}): ${f.value}`), [], 'animate transform / opacity instead (ui/DESIGN.md)');
});

test('every allowed exception still exists (the list only shrinks)', () => {
  for (const key of Object.keys(ALLOWED)) assert.ok(found.some((f) => f.key === key), `${key} no longer transitions a layout property: delete it from ALLOWED`);
});

test('the converted surfaces keep their reduced-motion switch-off', () => {
  const components = readFileSync(join(ROOT, 'ui/components/components.css'), 'utf8');
  assert.match(components, /prefers-reduced-motion: reduce\)[^]*\.sh-seg__thumb[^{]*\{[^}]*transition:\s*none/, 'segmented thumb');
  const session = readFileSync(join(ROOT, 'ui/review/session.css'), 'utf8');
  assert.match(session, /prefers-reduced-motion: reduce\)[^]*\.review-tick-line\s*\{\s*transition:\s*none/, 'review tick');
  const tour = readFileSync(join(ROOT, 'ui/tour/tour.css'), 'utf8');
  assert.match(tour, /@media \(prefers-reduced-motion: no-preference\)[^]*\.tour-spot\s*\{\s*transition:/, 'tour transitions are only declared for no-preference');
});

test('the review ticks and the tour spotlight are moved by transform', () => {
  const session = readFileSync(join(ROOT, 'ui/review/session.css'), 'utf8');
  const tick = parseCss(session).declarations.filter((d) => /review-tick-line/.test(d.ctx.at(-1)));
  assert.ok(tick.some((d) => d.prop === 'transform' && /scaleX/.test(d.value)), 'a tick changes length with scaleX');
  assert.ok(!tick.some((d) => d.prop === 'width' && d.ctx.at(-1).includes('hover')), 'hover no longer changes the width');
  const tourJsx = readFileSync(join(ROOT, 'ui/tour/Tour.jsx'), 'utf8');
  assert.match(tourJsx, /className="tour-spot" style=\{\{[^}]*transform: `translate/, 'the spotlight is placed with translate');
});
