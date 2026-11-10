/* Where a first-use tip of the practice page goes (ui/review/practice-tip-spot.js): next to the control it points at, inside the window, and never on a control the
   learner needs next (下一题 and its neighbours). Pure geometry, in viewport pixels. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `export * from './ui/review/practice-tip-spot.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
const { tipSpot } = module.exports;

const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });
const size = { width: 280, height: 84 };
const desk = box(0, 0, 1280, 900);
const phone = box(0, 0, 420, 900);
const inside = (spot, bounds) => spot.left >= bounds.left + 8 && spot.left + size.width <= bounds.right - 8 && spot.top >= bounds.top && spot.top + size.height <= bounds.bottom;
const covers = (spot, other) => spot.left < other.right && spot.left + size.width > other.left && spot.top < other.bottom && spot.top + size.height > other.top;

test('room below and nothing to avoid: the tip goes under the control, its left edge on the control\'s', () => {
  const anchor = box(459, 340, 60, 32);
  const spot = tipSpot({ anchor, size, bounds: desk });
  assert.equal(spot.placement, 'bottom-start');
  assert.equal(spot.left, 459);
  assert.ok(spot.top >= anchor.bottom, 'under it');
  assert.ok(inside(spot, desk));
});

test('a control the learner needs next under the tip: it goes above the control instead (420 px: 下一题 sits on the row below)', () => {
  const anchor = box(16, 600, 60, 32), next = box(300, 650, 88, 36), more = box(160, 650, 56, 36);
  const spot = tipSpot({ anchor, size, bounds: phone, avoid: [more, next] });
  assert.equal(spot.placement, 'top-start');
  assert.ok(spot.top + size.height <= anchor.top, 'above it');
  assert.ok(!covers(spot, next) && !covers(spot, more));
  assert.ok(inside(spot, phone));
});

test('wide window: 下一题 is to the right on the same row, so under the control is still free', () => {
  const anchor = box(459, 340, 60, 32), next = box(1051, 340, 80, 32);
  const spot = tipSpot({ anchor, size, bounds: desk, avoid: [next] });
  assert.equal(spot.placement, 'bottom-start');
  assert.ok(!covers(spot, next));
});

test('no room below the control: the tip goes above it', () => {
  const anchor = box(459, 840, 60, 32);
  const spot = tipSpot({ anchor, size, bounds: desk });
  assert.equal(spot.placement, 'top-start');
  assert.ok(inside(spot, desk));
});

test('a control at the right edge: the tip is pulled back inside the window', () => {
  const anchor = box(380, 340, 60, 32);
  const spot = tipSpot({ anchor, size, bounds: phone });
  assert.ok(inside(spot, phone), JSON.stringify(spot));
});

test('both sides would cover something: the side that covers less wins, and the tip stays inside the window', () => {
  const anchor = box(16, 300, 60, 32);
  const spot = tipSpot({ anchor, size, bounds: phone, avoid: [box(0, 340, 420, 36), box(0, 220, 120, 70)] });
  assert.ok(inside(spot, phone));
  assert.equal(spot.placement, 'top-start', 'the side with the smaller overlap');
});
