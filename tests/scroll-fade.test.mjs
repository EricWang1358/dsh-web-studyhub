// test-audit-allowlist: static-css-guard — CSS mask-image / scroll-padding-inline declarations in scroll-fade.css & skeleton.css and cross-surface strip wiring cannot be evaluated without a browser CSSOM/layout engine (browser measuring is covered by tests/scroll-fade-browser.test.mjs); pure edge math and CSS AST assertions run here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createEdgeTracker, edgeTracker, scrollEdges, scrollEdgesX } from '../ui/components/scroll-edges.js';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';

/* #747: a strip that scrolls sideways hid its scrollbar and gave no sign that more was off screen. One hook (ui/components/use-scroll-edges.js) and one
   stylesheet (ui/components/scroll-fade.css) say which side still has content and fade that side, and only that side; the scroll position, the keyboard
   and the scroll snap are untouched. This file covers the edge rule, the change-only publishing that keeps a per-commit measure from looping, and that
   each strip is wired to both. The real measuring is walked in tests/scroll-fade-browser.test.mjs. */

const element = (scrollLeft, clientWidth, scrollWidth) => ({ scrollLeft, clientWidth, scrollWidth });

test('a horizontal strip: more content to the start once scrolled past 1px, more to the end until the last pixel', () => {
  assert.deepEqual(scrollEdgesX(element(0, 300, 300)), { start: false, end: false }, 'nothing is off screen');
  assert.deepEqual(scrollEdgesX(element(1, 300, 900)), { start: false, end: true }, '1px is not scrolled yet');
  assert.deepEqual(scrollEdgesX(element(24, 300, 900)), { start: true, end: true });
  assert.deepEqual(scrollEdgesX(element(600, 300, 900)), { start: true, end: false }, 'the last pixel is in view');
  assert.equal(scrollEdgesX(element(598, 300, 900)).end, true, 'one pixel short of the end still has content beyond it');
});

test('the vertical rule is unchanged, and the one tracker serves both axes', () => {
  assert.deepEqual(scrollEdges({ scrollTop: 0, clientHeight: 280, scrollHeight: 728 }), { top: false, bottom: true });
  const published = [];
  const tracker = createEdgeTracker(scrollEdgesX, (edges) => published.push(edges), { start: false, end: false });
  tracker(element(0, 300, 900));
  assert.deepEqual(published, [{ start: false, end: true }], 'a real change is published');
  tracker(element(0, 300, 900));
  tracker(element(1, 300, 900));
  assert.equal(published.length, 1, 'the same answer is not published again: that is what loops a per-commit measure (React #185)');
  tracker(element(40, 300, 900));
  assert.deepEqual(published.at(-1), { start: true, end: true });
  assert.equal(edgeTracker((edges) => published.push(edges)) instanceof Function, true);
});

test('the shared stylesheet fades one side, the other, or both, and nothing else', () => {
  const { declarations } = parseCss(readFileSync('ui/components/scroll-fade.css', 'utf8'));
  const masks = declarations.filter((d) => d.prop === 'mask-image' || d.prop === '-webkit-mask-image');
  assert.equal(masks.length, 6, 'three rules, the prefixed and the plain property each');
  assert.ok(
    masks.some((d) => d.ctx.at(-1) === '.sh-fade-x[data-fade-start]' && d.prop === 'mask-image' && /^linear-gradient\(to right/.test(d.value)),
    'start edge fades to the right',
  );
  assert.ok(
    masks.some((d) => d.ctx.at(-1) === '.sh-fade-x[data-fade-end]' && d.prop === 'mask-image' && /^linear-gradient\(to left/.test(d.value)),
    'end edge fades to the left',
  );
  assert.ok(
    masks.some((d) => d.ctx.at(-1) === '.sh-fade-x[data-fade-start][data-fade-end]' && d.prop === 'mask-image' && /^linear-gradient\(to right, transparent 0/.test(d.value)),
    'both edges fade inward',
  );
  const forbidden = new Set(['overflow', 'scroll-behavior', 'scroll-snap-type', 'position', 'display']);
  assert.deepEqual(
    declarations.filter((d) => forbidden.has(d.prop)),
    [],
    'a fade paints; it never moves or un-scrolls anything',
  );
  assert.ok(
    masks.every((d) => d.value.includes('--sh-fade-size, 28px')),
    'the fade has one default width, and a strip may set its own',
  );
  assert.ok(
    declarations.some((d) => d.ctx.at(-1) === '.sh-fade-x--pad' && d.prop === 'scroll-padding-inline' && d.value === 'var(--sh-fade-size, 28px)'),
    'a focused item scrolls in clear of the fade',
  );
});

test('every sideways strip in the app takes the hook and the class', async () => {
  const strips = {
    'ui/tasks/TaskBody.jsx': 'both tab strips of a task (left and right)',
    'ui/tasks/TaskConsole.jsx': 'the filter strip above the list',
    'ui/Settings.jsx': 'the settings categories, which turn into a strip on a narrow pane',
    'ui/Board.jsx': 'the board columns',
    'ui/SkeletonSpine.jsx': 'the learning spine stations',
  };
  for (const [file, what] of Object.entries(strips)) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /useScrollEdges\(\)/, `${file}: ${what} measures its edges with the shared hook`);
    assert.match(source, /sh-fade-x/, `${file}: ${what} is painted by the shared stylesheet`);
    assert.match(source, /data-fade-start=\{/, `${file}: ${what} tells the stylesheet about its start edge`);
    assert.match(source, /data-fade-end=\{/, `${file}: ${what} tells the stylesheet about its end edge`);
  }
  // The spine's own copy of the rules went with it.
  const spineDecls = parseCss(readFileSync('ui/skeleton.css', 'utf8')).declarations;
  assert.equal(
    spineDecls.some((d) => /spine-strip\[data-(start|end)\]/.test(d.ctx.at(-1))),
    false,
    'the spine no longer carries a second fade implementation',
  );
  assert.equal(
    spineDecls.some((d) => d.ctx.at(-1) === '.spine-strip' && d.prop === '--sh-fade-size' && d.value === '36px'),
    true,
    'it only sets how wide its fade is',
  );
});
