/* Where a first-use tip of the practice page goes (ui/review/practice-tip-spot.js). The tip lies over empty space only: the page hands over what the learner reads or
   presses at that moment ("keep clear" boxes: text lines, rows, buttons, the page's own messages, the divider), and the first slot that is inside the window and
   touches none of them wins: under the control's block, above its row, beside its row. Nothing free: no spot (the tip waits). Pure geometry, viewport pixels. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `export * from './ui/review/practice-tip-spot.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
const { tipSpot, SLOTS } = module.exports;

const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });
const wide = { width: 560, height: 44 };
const desk = box(0, 56, 1280, 844);
const phone = box(0, 56, 420, 844);
/* The 1280 px toolbar: tools at the left of one row, 更多 / 上一题 / 下一题 at the right of the same row. */
const tools = box(446, 497, 146, 38);
const anchor = box(536, 497, 56, 38);
const block = box(438, 497, 700, 38);
const nav = [box(890, 497, 80, 38), box(978, 497, 65, 32), box(1051, 497, 80, 32)];
const base = { anchor, row: tools, block, size: wide, bounds: desk, keepClear: [...nav, tools] };
const inside = (spot, size, bounds) => spot.left >= bounds.left + 8 && spot.left + size.width <= bounds.right - 8 && spot.top >= bounds.top && spot.top + size.height <= bounds.bottom;
const touches = (spot, size, other) => spot.left < other.right && spot.left + size.width > other.left && spot.top < other.bottom && spot.top + size.height > other.top;

test('the slots are tried in this order: under the control\'s block, above its row, beside its row', () => {
  assert.deepEqual([...SLOTS], ['under', 'over', 'beside']);
});

test('free band under the toolbar block: the tip goes there, its left edge on the control\'s', () => {
  const spot = tipSpot(base);
  assert.equal(spot.placement, 'under');
  assert.equal(spot.left, anchor.left);
  assert.equal(spot.top, block.bottom + 4);
  assert.ok(inside(spot, wide, desk));
});

test('the page\'s own message sits in the band: the tip goes above the tools row instead, over the card\'s empty padding', () => {
  const message = box(438, 541, 700, 42);
  const spot = tipSpot({ ...base, keepClear: [...base.keepClear, message] });
  assert.equal(spot.placement, 'over');
  assert.equal(spot.top, tools.top - 4 - wide.height);
  assert.ok(!touches(spot, wide, message));
});

test('the divider and the heading under the band: a band too short for the tip is not used (the divider is a keep-clear line)', () => {
  const divider = box(438, 576, 700, 3), heading = box(438, 640, 130, 30);
  const spot = tipSpot({ ...base, keepClear: [...base.keepClear, divider, heading] });
  assert.equal(spot.placement, 'over');
  const roomy = tipSpot({ ...base, keepClear: [...base.keepClear, box(438, 620, 700, 3), heading] });
  assert.equal(roomy.placement, 'under', 'a band tall enough is used');
});

test('a line of text above the tools row too: beside the tools, when the tip is narrow enough for the free space', () => {
  const narrow = { width: 260, height: 44 };
  const spot = tipSpot({ ...base, size: narrow, keepClear: [...base.keepClear, box(438, 541, 700, 42), box(438, 440, 700, 48)] });
  assert.equal(spot.placement, 'beside');
  assert.equal(spot.left, tools.right + 4);
  assert.ok(!nav.some(other => touches(spot, narrow, other)));
});

test('nothing is free: no spot, so the tip waits for a later moment instead of covering text', () => {
  const spot = tipSpot({ ...base, keepClear: [...base.keepClear, box(438, 541, 700, 42), box(438, 440, 700, 48)] });
  assert.equal(spot, null);
});

test('a slot outside the window is no slot', () => {
  const low = { anchor: box(459, 840, 60, 32), row: box(459, 840, 60, 32), block: box(438, 840, 700, 32) };
  const spot = tipSpot({ ...base, ...low, keepClear: [] });
  assert.equal(spot.placement, 'over', 'no room under the control (the window ends): above it');
  assert.ok(inside(spot, wide, desk));
  const top = { anchor: box(459, 60, 60, 32), row: box(459, 60, 60, 32), block: box(438, 60, 700, 32), keepClear: [box(438, 100, 700, 30)] };
  assert.equal(tipSpot({ ...base, ...top }), null, 'under is blocked, above is under the top bar: nothing');
});

test('420 px: 下一题 sits on the row under the tools, so the band under the block is used when free and above the tools when a message is there', () => {
  const size = { width: 388, height: 66 };
  const row = box(16, 432, 160, 24), blk = box(16, 432, 388, 74), anc = box(96, 432, 56, 24);
  const keep = [box(160, 470, 56, 36), box(234, 474, 65, 32), box(307, 474, 80, 32), row];
  const free = tipSpot({ anchor: anc, row, block: blk, size, bounds: phone, keepClear: keep });
  assert.equal(free.placement, 'under');
  assert.ok(inside(free, size, phone));
  const message = box(16, 514, 388, 42);
  const withMessage = tipSpot({ anchor: anc, row, block: blk, size, bounds: phone, keepClear: [...keep, message, box(16, 300, 388, 22), box(16, 330, 388, 24)] });
  assert.equal(withMessage.placement, 'over');
  assert.ok(!keep.concat(message).some(other => touches(withMessage, size, other)));
});

test('a left edge near the right of the window is pulled back inside; a tip wider than the window has no slot', () => {
  const spot = tipSpot({ ...base, anchor: box(380, 497, 60, 38), row: box(380, 497, 60, 38), block: box(16, 497, 388, 74), size: { width: 388, height: 60 }, bounds: phone, keepClear: [] });
  assert.ok(inside(spot, { width: 388, height: 60 }, phone), JSON.stringify(spot));
  assert.equal(tipSpot({ ...base, size: { width: 500, height: 60 }, bounds: phone, keepClear: [] }), null);
});

test('several sizes are tried in order of preference; the first (slot, size) that is free wins, so a narrower card can pass a button at the side', () => {
  const fold = box(364, 784, 30, 20);
  const wideCard = { width: 388, height: 44 }, narrowCard = { width: 300, height: 62 };
  const prereq = { anchor: box(16, 750, 70, 20), row: box(16, 750, 160, 20), block: box(16, 750, 160, 20), bounds: phone, keepClear: [fold, box(16, 700, 388, 40), box(16, 750, 160, 20)] };
  const one = tipSpot({ ...prereq, size: wideCard });
  assert.equal(one, null, 'the wide card would lie on the fold button');
  const both = tipSpot({ ...prereq, sizes: [wideCard, narrowCard] });
  assert.equal(both.placement, 'under');
  assert.equal(both.size, narrowCard);
});

test('whatever is chosen touches none of the keep-clear boxes by even a pixel (a margin of 2 counts as touching)', () => {
  const crowd = [];
  for (let y = 60; y < 900; y += 30) crowd.push(box(438, y, 700, 18));
  for (const clear of [[], crowd.slice(0, 10), crowd.slice(10, 20), crowd.filter((_, i) => i % 3 === 0)]) {
    const spot = tipSpot({ ...base, keepClear: [...clear, tools] });
    if (!spot) continue;
    for (const other of [...clear, tools]) assert.ok(!touches({ ...spot, left: spot.left - 2, top: spot.top - 2 }, { width: wide.width + 4, height: wide.height + 4 }, other), JSON.stringify([spot, other]));
  }
});
