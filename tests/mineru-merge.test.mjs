import test from 'node:test';
import assert from 'node:assert/strict';
import { MineruResultError, mergeChunkResults, readResultZip } from '../lib/mineru-merge.js';
import { parseConvertedDocument } from '../lib/converted-document.js';
import { zipStored } from './helpers/zip.mjs';

/* Putting the pieces back together: each piece's content_list (pages counted from 0 inside the piece) becomes one list of
   the whole book, in the one format the importer already reads (lib/converted-document.js). */

const textItem = (text, page_idx, extra = {}) => ({ type: 'text', text, page_idx, ...extra });
const imageItem = (path, page_idx) => ({ type: 'image', img_path: path, image_caption: [`fig ${path}`], page_idx });
const chunk = (index, startPage, endPage, content, format = 'v1') => ({ index, startPage, endPage, format, content });

test('the result ZIP is read for its content list; images are not kept (StudyHub imports text and captions)', () => {
  const list = [textItem('Hello', 0)];
  const zip = zipStored({ 'abc/full.md': '# x', 'abc/abc_content_list.json': JSON.stringify(list), 'abc/layout.json': '{}', 'abc/images/p1.jpg': Buffer.from([1, 2]) });
  const result = readResultZip(zip);
  assert.equal(result.format, 'v1');
  assert.deepEqual(result.content, list);
  assert.deepEqual(result.images, ['abc/images/p1.jpg']);
});

test('content_list.json is found under either documented name, and the v1 list is preferred over content_list_v2.json', () => {
  const v1 = [textItem('one', 0)], v2 = [[{ type: 'paragraph', content: { text: 'two' } }]];
  assert.equal(readResultZip(zipStored({ 'content_list.json': JSON.stringify(v1) })).format, 'v1');
  const both = readResultZip(zipStored({ 'b_content_list_v2.json': JSON.stringify(v2), 'b_content_list.json': JSON.stringify(v1) }));
  assert.equal(both.format, 'v1');
  const only = readResultZip(zipStored({ 'b_content_list_v2.json': JSON.stringify(v2) }));
  assert.equal(only.format, 'v2');
  assert.deepEqual(only.content, v2);
});

test('an archive without a content list, or one that is not a ZIP, is a plain error', () => {
  assert.throws(() => readResultZip(zipStored({ 'full.md': '# only markdown' })), error => error instanceof MineruResultError && error.code === 'no-content-list' && /页码/.test(error.message));
  assert.throws(() => readResultZip(Buffer.from('not a zip at all')), error => error instanceof MineruResultError && error.code === 'bad-archive');
  assert.throws(() => readResultZip(zipStored({ 'x_content_list.json': '{broken' })), error => error.code === 'bad-content-list');
});

test('pages are renumbered to the book: a piece starting at page 201 puts its page 0 on page 201', () => {
  const merged = mergeChunkResults({ totalPages: 5, chunks: [
    chunk(0, 1, 3, [textItem('a1', 0), textItem('a2', 1), textItem('a3', 2)]),
    chunk(1, 4, 5, [textItem('b1', 0), textItem('b2', 1)]),
  ] });
  assert.equal(merged.format, 'v1');
  assert.equal(merged.pages, 5);
  assert.deepEqual(merged.content.filter(item => item.text).map(item => [item.text, item.page_idx]), [['a1', 0], ['a2', 1], ['a3', 2], ['b1', 3], ['b2', 4]]);
  const book = parseConvertedDocument(JSON.stringify(merged.content), { filename: 'Book.pdf' });
  assert.equal(book.totalPages, 5);
  assert.deepEqual(book.pages.map(page => [page.page, page.text]), [[1, 'a1'], [2, 'a2'], [3, 'a3'], [4, 'b1'], [5, 'b2']]);
  assert.equal(book.converter, 'mineru');
});

test('reading order inside a page and across pieces is kept', () => {
  const merged = mergeChunkResults({ totalPages: 4, chunks: [
    chunk(0, 1, 2, [textItem('first', 0), textItem('second', 0), textItem('third', 1)]),
    chunk(1, 3, 4, [textItem('fourth', 0), textItem('fifth', 0), textItem('sixth', 1)]),
  ] });
  assert.deepEqual(merged.content.filter(item => item.text).map(item => item.text), ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']);
  const book = parseConvertedDocument(JSON.stringify(merged.content));
  assert.equal(book.pages[3].text, 'sixth');
  assert.equal(book.pages[2].text, 'fourth\n\nfifth');
});

test('image names are prefixed per piece, so two pieces that both have images/a.jpg never collide', () => {
  const merged = mergeChunkResults({ totalPages: 2, chunks: [
    chunk(0, 1, 1, [imageItem('images/a.jpg', 0)]),
    chunk(1, 2, 2, [imageItem('images/a.jpg', 0)]),
  ] });
  const paths = merged.content.filter(item => item.img_path).map(item => item.img_path);
  assert.deepEqual(paths, ['c1/images/a.jpg', 'c2/images/a.jpg']);
  assert.equal(new Set(paths).size, 2);
});

test('the pieces given in any order are laid out in book order', () => {
  const merged = mergeChunkResults({ totalPages: 4, chunks: [chunk(1, 3, 4, [textItem('late', 0)]), chunk(0, 1, 2, [textItem('early', 0)])] });
  assert.deepEqual(merged.content.filter(item => item.text).map(item => [item.text, item.page_idx]), [['early', 0], ['late', 2]]);
});

test('the merged document keeps the ORIGINAL page count, even when the last pages have no text', () => {
  const merged = mergeChunkResults({ totalPages: 6, chunks: [chunk(0, 1, 3, [textItem('only page one', 0)]), chunk(1, 4, 6, [textItem('page four', 0)])] });
  const book = parseConvertedDocument(JSON.stringify(merged.content));
  assert.equal(book.totalPages, 6);
  assert.deepEqual(book.skippedPages, [2, 3, 5, 6]);
});

test('headings in different pieces become one chapter list of the whole book', () => {
  const heading = (text, page_idx) => ({ type: 'text', text, text_level: 1, page_idx });
  const merged = mergeChunkResults({ totalPages: 4, chunks: [
    chunk(0, 1, 2, [heading('Chapter 1', 0), textItem('body', 1)]),
    chunk(1, 3, 4, [heading('Chapter 2', 0), textItem('more', 1)]),
  ] });
  const book = parseConvertedDocument(JSON.stringify(merged.content));
  assert.deepEqual(book.chapters.map(item => [item.title, item.startPage, item.endPage]), [['Chapter 1', 1, 2], ['Chapter 2', 3, 4]]);
});

test('a missing piece is a clear message naming the pages that have no result', () => {
  assert.throws(() => mergeChunkResults({ totalPages: 450, chunks: [chunk(0, 1, 200, [textItem('a', 0)]), chunk(2, 401, 450, [textItem('c', 0)])] }),
    error => error instanceof MineruResultError && error.code === 'missing-chunk' && error.pages === '201–400' && /201.{0,3}400/.test(error.message));
  assert.throws(() => mergeChunkResults({ totalPages: 10, chunks: [chunk(0, 1, 5, [textItem('a', 0)])] }), error => error.code === 'missing-chunk' && /6.{0,3}10/.test(error.message));
});

test('a piece that reports a page beyond its own range is refused rather than silently shifting pages', () => {
  assert.throws(() => mergeChunkResults({ totalPages: 4, chunks: [chunk(0, 1, 2, [textItem('x', 5)]), chunk(1, 3, 4, [textItem('y', 0)])] }),
    error => error instanceof MineruResultError && error.code === 'page-mismatch' && /1.{0,3}2/.test(error.message));
});

test('overlapping pieces are refused', () => {
  assert.throws(() => mergeChunkResults({ totalPages: 4, chunks: [chunk(0, 1, 3, [textItem('a', 0)]), chunk(1, 3, 4, [textItem('b', 0)])] }), error => error.code === 'bad-plan');
});

test('the pieces given are not modified', () => {
  const source = [textItem('keep', 0), imageItem('images/z.jpg', 0)];
  const before = JSON.stringify(source);
  mergeChunkResults({ totalPages: 4, chunks: [chunk(0, 1, 2, source), chunk(1, 3, 4, [textItem('n', 0)])] });
  assert.equal(JSON.stringify(source), before);
});

test('v2 content lists (a list of pages) merge into one v2 list of the whole book', () => {
  const page = text => [{ type: 'paragraph', content: { paragraph_content: [{ type: 'text', content: text }] } }];
  const merged = mergeChunkResults({ totalPages: 5, chunks: [
    chunk(0, 1, 3, [page('a1'), page('a2')], 'v2'),
    chunk(1, 4, 5, [page('b1'), page('b2')], 'v2'),
  ] });
  assert.equal(merged.format, 'v2');
  assert.equal(merged.content.length, 5, 'one entry per page of the book; a page the piece left out is an empty page');
  assert.deepEqual(merged.content[2], []);
  const book = parseConvertedDocument(JSON.stringify(merged.content));
  assert.equal(book.totalPages, 5);
  assert.deepEqual(book.pages.map(item => item.page), [1, 2, 4, 5]);
});

test('pieces in different formats cannot be merged', () => {
  assert.throws(() => mergeChunkResults({ totalPages: 2, chunks: [chunk(0, 1, 1, [textItem('a', 0)], 'v1'), chunk(1, 2, 2, [[]], 'v2')] }), error => error.code === 'mixed-formats');
});
