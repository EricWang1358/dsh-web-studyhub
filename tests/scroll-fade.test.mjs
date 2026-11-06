import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEdgeTracker, edgeTracker, scrollEdges, scrollEdgesX } from '../ui/components/scroll-edges.js';

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

test('the shared stylesheet fades one side, the other, or both, and nothing else', async () => {
  const css = await readFile('ui/components/scroll-fade.css', 'utf8');
  assert.match(css, /\.sh-fade-x\[data-fade-start\]\s*\{[^}]*mask-image: linear-gradient\(to right/);
  assert.match(css, /\.sh-fade-x\[data-fade-end\]\s*\{[^}]*mask-image: linear-gradient\(to left/);
  assert.match(css, /\.sh-fade-x\[data-fade-start\]\[data-fade-end\]\s*\{[^}]*mask-image: linear-gradient\(to right, transparent 0/);
  assert.equal((css.match(/mask-image:/g) || []).length, 6, 'three rules, the prefixed and the plain property each');
  assert.doesNotMatch(css, /\n\s*(overflow|scroll-behavior|scroll-snap-type|position|display)\s*:/, 'a fade paints; it never moves or un-scrolls anything');
  assert.match(css, /--sh-fade-size, 28px/, 'the fade has one default width, and a strip may set its own');
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
  const spine = await readFile('ui/skeleton.css', 'utf8');
  assert.doesNotMatch(spine, /spine-strip\[data-(start|end)\]/, 'the spine no longer carries a second fade implementation');
  assert.match(spine, /--sh-fade-size: 36px/, 'it only sets how wide its fade is');
});
