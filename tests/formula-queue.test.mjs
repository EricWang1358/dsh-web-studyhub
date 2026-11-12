/* Formulas off screen are drawn a few per frame (ui/formula-queue.js), the reader's nearest first and those on screen at once
   (createFormulaWatch in ui/document-preview/reader/lazy-formulas.js). Frames and IntersectionObserver are fakes here; the real scroll, its long tasks,
   copy, find and a citation are checked in the browser (tests/reader-formula-scroll-browser.test.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormulaQueue, FORMULAS_PER_FRAME } from '../ui/formula-queue.js';
import { createFormulaWatch } from '../ui/document-preview/reader/lazy-formulas.js';

/** Fake frames: `run()` runs the frame callbacks waiting now. */
function fakeFrames(t) {
  let waiting = new Map(), next = 1;
  const saved = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = callback => { waiting.set(next, callback); return next++; };
  globalThis.cancelAnimationFrame = id => { waiting.delete(id); };
  t.after(() => { globalThis.requestAnimationFrame = saved.request; globalThis.cancelAnimationFrame = saved.cancel; });
  return {
    get pending() { return waiting.size; },
    run() { const now = waiting; waiting = new Map(); for (const callback of now.values()) callback(); },
  };
}

/** Fake IntersectionObservers: `enter(options-match, element, top)` delivers one entry to the observers made with that rootMargin. */
function fakeObservers(t) {
  const made = [];
  const saved = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; this.watched = new Set(); made.push(this); }
    observe(element) { this.watched.add(element); }
    unobserve(element) { this.watched.delete(element); }
    disconnect() { this.watched.clear(); }
  };
  t.after(() => { globalThis.IntersectionObserver = saved; });
  const deliver = (near, element, { isIntersecting = true, top = 0 } = {}) => {
    for (const observer of made) {
      const isNear = (observer.options?.rootMargin ?? '0px') !== '0px';
      if (isNear !== near || !observer.watched.has(element)) continue;
      observer.callback([{ target: element, isIntersecting, boundingClientRect: { top }, rootBounds: { top: -100, height: 1000 } }]);
    }
  };
  return { made, near: (element, options) => deliver(true, element, options), onScreen: (element, options) => deliver(false, element, options) };
}

test('the queue draws a few a frame, the first added first, and keys taken out are not drawn', t => {
  const frames = fakeFrames(t), drawn = [];
  const queue = createFormulaQueue();
  const remove = [];
  for (let n = 0; n < 7; n += 1) remove.push(queue.add(n, () => drawn.push(n)));
  assert.deepEqual(drawn, [], 'nothing is drawn in the task that adds');
  remove[2]();
  frames.run();
  assert.deepEqual(drawn, [0, 1].slice(0, FORMULAS_PER_FRAME));
  frames.run();
  assert.deepEqual(drawn, [0, 1, 3, 4]);
  queue.clear();
  frames.run();
  assert.deepEqual(drawn, [0, 1, 3, 4], 'clear drops the rest');
  assert.equal(frames.pending, 0, 'and asks for no more frames');
});

test('the queue draws in the order given, once a frame', t => {
  const frames = fakeFrames(t), drawn = [];
  const queue = createFormulaQueue({ perFrame: 1, order: keys => keys.sort((a, b) => b - a) });
  for (const n of [1, 5, 3]) queue.add(n, () => drawn.push(n));
  frames.run(); frames.run(); frames.run();
  assert.deepEqual(drawn, [5, 3, 1]);
  assert.equal(frames.pending, 0);
});

test('the reader draws a formula on screen at once and those near it a few a frame, the nearest first', t => {
  const frames = fakeFrames(t), observers = fakeObservers(t), drawn = [];
  const root = { scrollTop: 0 };
  const watch = createFormulaWatch(() => root, { margin: 100 });
  const elements = Array.from({ length: 6 }, (_, n) => ({ n }));
  for (const element of elements) watch.observe(element, () => drawn.push(element.n));
  assert.equal(observers.made.length, 2, 'one observer for near the screen, one for on it');
  // On screen: drawn in the observer's task.
  observers.onScreen(elements[0], { top: 10 });
  assert.deepEqual(drawn, [0]);
  // Near: queued, two a frame, the nearest to the middle of the screen (400 px down an 800 px high area) first.
  observers.near(elements[1], { top: 1000 });
  observers.near(elements[2], { top: 500 });
  observers.near(elements[3], { top: 800 });
  observers.near(elements[4], { top: -50 });
  assert.deepEqual(drawn, [0], 'near ones wait for a frame');
  frames.run();
  assert.deepEqual(drawn, [0, 2, 3]);
  // One that comes on screen while waiting is drawn at once; one that leaves the band is no longer drawn.
  observers.onScreen(elements[4], { top: 20 });
  observers.near(elements[1], { isIntersecting: false, top: 2000 });
  assert.deepEqual(drawn, [0, 2, 3, 4]);
  frames.run();
  assert.deepEqual(drawn, [0, 2, 3, 4], 'the one that left is not drawn');
  // Once drawn, a formula is no longer watched; stopping a watch takes it out of the queue.
  assert.ok(observers.made.every(observer => !observer.watched.has(elements[0])));
  const stop = watch.observe(elements[5], () => drawn.push(5));
  observers.near(elements[5], { top: 300 });
  stop();
  frames.run();
  assert.deepEqual(drawn, [0, 2, 3, 4]);
  watch.disconnect();
  assert.equal(frames.pending, 0);
});

test('without IntersectionObserver every formula is drawn at once', t => {
  const saved = globalThis.IntersectionObserver;
  delete globalThis.IntersectionObserver;
  t.after(() => { globalThis.IntersectionObserver = saved; });
  const drawn = [];
  createFormulaWatch(() => null).observe({}, () => drawn.push(1));
  assert.deepEqual(drawn, [1]);
});
