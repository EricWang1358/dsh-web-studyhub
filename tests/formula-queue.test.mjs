/* Formulas off screen are drawn a few per frame (ui/formula-queue.js): one queue and one budget for every watch on the page (the reader's column,
   the formulas of the rest of the app), the nearest to the middle of the screen first, those on screen at once. Frames, IntersectionObserver and
   positions are fakes here; the real scroll, its long tasks, copy, find and a citation are checked in the browser
   (tests/reader-formula-scroll-browser.test.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormulaQueue, createFormulaWatch, FORMULAS_PER_FRAME } from '../ui/formula-queue.js';

/** Fake frames: `run()` runs the frame callbacks waiting now. */
function fakeFrames(t) {
  let waiting = new Map(), next = 1;
  const saved = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame, height: globalThis.innerHeight };
  globalThis.requestAnimationFrame = callback => { waiting.set(next, callback); return next++; };
  globalThis.cancelAnimationFrame = id => { waiting.delete(id); };
  globalThis.innerHeight = 800;
  t.after(() => { globalThis.requestAnimationFrame = saved.request; globalThis.cancelAnimationFrame = saved.cancel; globalThis.innerHeight = saved.height; });
  return {
    get pending() { return waiting.size; },
    run() { const now = waiting; waiting = new Map(); for (const callback of now.values()) callback(); },
  };
}

/** Fake IntersectionObservers: `near(element)` / `onScreen(element)` deliver one entry to the look-ahead or the on-screen observers watching it. */
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
  const deliver = (near, element, isIntersecting = true) => {
    for (const observer of made) {
      const isNear = (observer.options?.rootMargin ?? '0px') !== '0px';
      if (isNear === near && observer.watched.has(element)) observer.callback([{ target: element, isIntersecting, boundingClientRect: { top: element.top } }]);
    }
  };
  return { made, near: (element, is) => deliver(true, element, is), onScreen: (element, is) => deliver(false, element, is) };
}

/** A fake element `top` px below the top of the screen when it comes near (the screen is 800 px high, its middle at 400). Never measured. */
const at = (name, top) => ({ name, top, getBoundingClientRect() { throw new Error('a waiting formula is not measured'); } });

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

test('the queue draws in the order given, and asks for no frame once the last key is taken out', t => {
  const frames = fakeFrames(t), drawn = [];
  const queue = createFormulaQueue({ perFrame: 1, order: keys => keys.sort((a, b) => b - a) });
  for (const n of [1, 5, 3]) queue.add(n, () => drawn.push(n));
  frames.run(); frames.run(); frames.run();
  assert.deepEqual(drawn, [5, 3, 1]);
  assert.equal(frames.pending, 0);
  const remove = queue.add(9, () => drawn.push(9));
  remove();
  assert.equal(frames.pending, 0, 'nothing left to draw, no frame');
});

test('a drawing that throws does not stop the queue', t => {
  const frames = fakeFrames(t), drawn = [];
  const queue = createFormulaQueue({ perFrame: 1 });
  queue.add('bad', () => { throw new Error('bad formula'); });
  queue.add('good', () => drawn.push('good'));
  assert.throws(() => frames.run(), /bad formula/);
  frames.run();
  assert.deepEqual(drawn, ['good']);
});

test('a watch draws a formula on screen at once and those near it a few a frame, the nearest to the middle of the screen first', t => {
  const frames = fakeFrames(t), observers = fakeObservers(t), drawn = [];
  const area = { scrollTop: 0 };
  const watch = createFormulaWatch(() => area, { margin: 100 });
  const [shown, far, middle, below, above, stopped] = [at('shown', 10), at('far', 1500), at('middle', 380), at('below', 900), at('above', -300), at('stopped', 400)];
  for (const element of [shown, far, middle, below, above]) watch.observe(element, () => drawn.push(element.name));
  assert.equal(observers.made.length, 2, 'one observer for near the screen, one for on it');
  observers.onScreen(shown);
  assert.deepEqual(drawn, ['shown'], 'on screen: drawn in the observer task');
  for (const element of [far, middle, below, above]) observers.near(element);
  assert.deepEqual(drawn, ['shown'], 'near ones wait for a frame');
  // Where they are now decides, not where they were when they came near: the area scrolled 480 px, `below` is at the middle, `middle` above it.
  area.scrollTop = 480;
  frames.run();
  assert.deepEqual(drawn, ['shown', 'below', 'middle']);
  observers.onScreen(above);
  observers.near(far, false);
  assert.deepEqual(drawn, ['shown', 'below', 'middle', 'above'], 'one that comes on screen while waiting is drawn at once');
  frames.run();
  assert.deepEqual(drawn, ['shown', 'below', 'middle', 'above'], 'one that left the band is not drawn');
  assert.ok(observers.made.every(observer => !observer.watched.has(shown)), 'a drawn formula is no longer watched');
  const stop = watch.observe(stopped, () => drawn.push('stopped'));
  observers.near(stopped);
  stop();
  frames.run();
  assert.equal(drawn.includes('stopped'), false, 'stopping a watch takes it out of the queue');
  watch.disconnect();
  assert.equal(frames.pending, 0);
});

test('every watch on the page shares one queue: one budget a frame, the nearest first across them', t => {
  const frames = fakeFrames(t), observers = fakeObservers(t), drawn = [];
  const reader = createFormulaWatch(() => ({ scrollTop: 0 })), page = createFormulaWatch(() => null);
  const elements = [['reader-far', 1200, reader], ['page-near', 390, page], ['reader-near', 410, reader], ['page-far', -900, page]].map(([name, top, watch]) => {
    const element = at(name, top);
    watch.observe(element, () => drawn.push(name));
    return element;
  });
  for (const element of elements) observers.near(element);
  frames.run();
  assert.equal(drawn.length, FORMULAS_PER_FRAME, 'two watches, one budget');
  assert.deepEqual(drawn, ['page-near', 'reader-near']);
  page.disconnect();
  frames.run();
  assert.deepEqual(drawn, ['page-near', 'reader-near', 'reader-far'], 'disconnecting one watch leaves the others queued');
  reader.disconnect();
});

test('without IntersectionObserver every formula is drawn at once', t => {
  const saved = globalThis.IntersectionObserver;
  delete globalThis.IntersectionObserver;
  t.after(() => { globalThis.IntersectionObserver = saved; });
  const drawn = [];
  createFormulaWatch(() => null).observe({}, () => drawn.push(1));
  assert.deepEqual(drawn, [1]);
});
