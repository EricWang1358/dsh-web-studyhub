import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

const { PAGE_IMAGE_EDGE, renderPageImages } = await loadUi("export { PAGE_IMAGE_EDGE, renderPageImages } from './ui/document-preview/peek/page-image.js';");

/* 原始 PDF, the picture of a page for 发给主会话 (#488): drawn through the peek's renderer, one file per page, the document closed after; what cannot be shown truly
   (a page the file does not have, images that did not decode, a page count that disagrees) gives no picture, because a blank or wrong picture is worse than none. */

function fakeRenderer({ numPages = 5, undecoded = 0, size = { width: 600, height: 800 } } = {}) {
  const log = { renders: [], closed: 0, destroyed: 0 };
  return { log, open: async () => ({ numPages,
    pageSize: async () => size,
    render: async (page, { scale, onReport }) => { log.renders.push({ page, scale }); onReport?.({ undecoded }); return { page, close() { log.closed += 1; } }; },
    destroy: async () => { log.destroyed += 1; } }) };
}
const encode = async bitmap => ({ name: `page-${bitmap.page}.jpg`, type: 'image/jpeg' });
const bytes = async () => new Uint8Array(1);

test('one picture per page, long edge held to the cap, every bitmap closed, the document destroyed', async () => {
  const { log, open } = fakeRenderer();
  const files = await renderPageImages({ loadBytes: bytes, pages: [3, 5], totalPages: 5, openRenderer: open, encode });
  assert.deepEqual(files.map(file => file.name), ['page-3.jpg', 'page-5.jpg']);
  assert.deepEqual(log.renders.map(item => item.page), [3, 5]);
  assert.equal(log.renders[0].scale, PAGE_IMAGE_EDGE / 800);
  assert.equal(log.closed, 2);
  assert.equal(log.destroyed, 1);
});

test('no bytes, a page count that disagrees, or images that did not decode: no picture, never a blank or wrong one', async () => {
  assert.deepEqual(await renderPageImages({ loadBytes: async () => null, pages: [1], openRenderer: fakeRenderer().open, encode }), []);
  const other = fakeRenderer({ numPages: 9 });
  assert.deepEqual(await renderPageImages({ loadBytes: bytes, pages: [1], totalPages: 5, openRenderer: other.open, encode }), []);
  assert.equal(other.log.destroyed, 1);
  const blank = fakeRenderer({ undecoded: 2 });
  assert.deepEqual(await renderPageImages({ loadBytes: bytes, pages: [1], totalPages: 5, openRenderer: blank.open, encode }), []);
  assert.equal(blank.log.closed, 1, 'the bitmap is still let go');
  assert.equal(blank.log.destroyed, 1);
});
