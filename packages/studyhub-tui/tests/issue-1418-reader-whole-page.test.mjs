// Regression test for #1418: the reader showed only the first slice of a long page
// ("page 1 / 1", scrolled to 100%, yet the text stopped in the middle).
// node --test tests/issue-1418-reader-whole-page.test.mjs
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { register } from 'tsx/esm/api';
import { PAGES_CHARS, sourcePages } from '../../../lib/book-pages.js';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const { readWholePage, readWholeSource, SOURCE_SLICE_CHARS } = await import('../src/views/sources/page-loader.ts');

/** A library holding one long text material, read through the real `source.pages` contract. */
function libraryWith(text) {
  const state = { sources: [{ id: 's1', title: '长资料', text }], documents: [] };
  const calls = [];
  const call = async (args) => {
    calls.push(args);
    return { ok: true, value: sourcePages(state, { sourceId: 's1', ...args }).result };
  };
  return { call, calls };
}

const longText = Array.from({ length: 900 }, (_, i) => `第 ${i + 1} 行：这是一段用来撑长度的正文。`).join('\n');

test('#1418: a page longer than one slice is read to its end', async () => {
  assert.ok(longText.length > PAGES_CHARS * 2, 'fixture spans several slices');
  const { call, calls } = libraryWith(longText);
  const first = (await call({ from: 1, to: 1 })).value;
  assert.ok(first.shown[0].text.length < longText.length, 'the first answer is only a slice');

  const whole = await readWholePage(call, first);
  assert.equal(whole.incomplete, false);
  assert.equal(whole.text, longText, 'every character arrives, in order, once');
  assert.ok(calls.length > 2, 'the loader asked for the following slices');
  assert.ok(calls.slice(1).every((args) => args.from === 1 && args.to === 1 && args.offset > 0));
});

test('#1418: a short page costs no extra request', async () => {
  const { call, calls } = libraryWith('只有一小段。');
  const first = (await call({ from: 1, to: 1 })).value;
  const whole = await readWholePage(call, first);
  assert.deepEqual(whole, { text: '只有一小段。', incomplete: false });
  assert.equal(calls.length, 1);
});

test('#1418: a slice that fails is reported instead of passing for the end of the page', async () => {
  const { call } = libraryWith(longText);
  const first = (await call({ from: 1, to: 1 })).value;
  let asked = 0;
  const failing = async (args) => {
    asked += 1;
    return asked === 2 ? { ok: false, error: { message: 'offline' } } : call(args);
  };
  const whole = await readWholePage(failing, first);
  assert.equal(whole.incomplete, true);
  assert.ok(longText.startsWith(whole.text) && whole.text.length < longText.length, 'keeps what did arrive');
});

test('#1418: a page that never advances cannot loop forever', async () => {
  const stuck = { shown: [{ page: 1, text: 'abc' }], next: { from: 1, offset: 3 } };
  let asked = 0;
  const whole = await readWholePage(async () => {
    asked += 1;
    return { ok: true, value: stuck };
  }, stuck);
  assert.equal(asked, 1, 'stops as soon as the offset stops growing');
  assert.equal(whole.text, 'abcabc');
});

test('#1418: the source.get fallback is read to its end too', async () => {
  const text = 'x'.repeat(SOURCE_SLICE_CHARS + 20000 + 123);
  const calls = [];
  const get = async ({ offset = 0, limit = 20000 }) => {
    calls.push({ offset, limit });
    return { ok: true, value: { id: 's1', chars: text.length, offset, text: text.slice(offset, offset + limit) } };
  };
  const first = (await get({ offset: 0, limit: 20000 })).value;
  const whole = await readWholeSource(get, first);
  assert.equal(whole.incomplete, false);
  assert.equal(whole.text.length, text.length);
  assert.deepEqual(calls.map((c) => c.offset), [0, 20000, 20000 + SOURCE_SLICE_CHARS]);
});

test('#1418: a load the reader has abandoned asks for nothing more', async () => {
  const { call, calls } = libraryWith(longText);
  const first = (await call({ from: 1, to: 1 })).value;
  const whole = await readWholePage(call, first, () => true);
  assert.equal(calls.length, 1, 'no follow-up request after the reader moved on');
  assert.equal(whole.incomplete, true);
});
