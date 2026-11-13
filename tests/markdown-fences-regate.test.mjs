import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assignHeadingIds, closeFences } from '../lib/course-book-links.js';
import { fenceMask, fenceOpening, closesFence, markdownHeadings } from '../lib/contexts/notes/markdown-fences.js';
import { relabelFootnotes } from '../lib/book-parked-text.js';
import { loadUi } from './helpers/ui-module.mjs';

/* #1038 re-gate: a line that is the book's own (a footnote definition, a link reference definition, a math block) is never the text of an underlined title;
   the lines over an underline are read once; a fence the book closes is closed the way the reader reads it, and the reader, the book's HTML and the
   footnote tools read fences with the same scanner. */

const rows = text => text.split('\n');
const titles = text => markdownHeadings(rows(text)).map(item => item.text);

test('a footnote definition, a link reference definition or a math block over --- is no heading', () => {
  const footnotes = 'Body [^1] [^2].\n\n[^1]: 「a」 · S\n[^2]: 「b」 · S\n---\nend';
  assert.deepEqual(titles(footnotes), []);
  assert.equal(assignHeadingIds(footnotes).text, footnotes, 'the 出处 list is left as it is');
  assert.deepEqual(titles('[x]: http://e.com\n---'), []);
  assert.deepEqual(titles('$$\na^2+b^2=c^2\n$$\n---'), []);
  assert.deepEqual(titles('$$ a^2 $$\n---'), []);
  assert.deepEqual(titles('$$\nx\ny\n---\n$$'), [], 'an underline inside a math block');
  assert.deepEqual(titles('$$\nx\n===\n$$\ntext\n---'), ['text'], 'text after the block is read again');
  assert.deepEqual(titles('Cost is $$5 today.\n---'), ['Cost is $$5 today.'], 'a $$ in the middle of a line opens no block');
  assert.deepEqual(titles('$$\nnever closed\n---'), ['$$ never closed'], 'a $$ line with no closing one is no block');
});

test('lines over an underline are read once, whichever underline: = or ---', () => {
  for (const underline of ['=', '---']) {
    const lines = ['- item', ...Array.from({ length: 20000 }, (_, at) => (at % 2 ? underline : 'x'))];
    const started = Date.now();
    assert.deepEqual(markdownHeadings(lines), []);
    assert.ok(Date.now() - started < 500, `${underline}: ${Date.now() - started} ms`);
  }
});

test('an underline after an underline that belonged to a list item is no heading either', () => {
  assert.deepEqual(titles('- item\n===\nx\n==='), []);
});

test('fenceOpening and closesFence are the one rule of a fence', () => {
  assert.deepEqual(fenceOpening('````js'), { char: '`', length: 4 });
  assert.deepEqual(fenceOpening('  ~~~'), { char: '~', length: 3 });
  assert.equal(fenceOpening('``` a`b'), null);
  assert.equal(fenceOpening('text'), null);
  const open = { char: '`', length: 4 };
  assert.equal(closesFence('```', open), false);
  assert.equal(closesFence('````', open), true);
  assert.equal(closesFence('`````  ', open), true);
  assert.equal(closesFence('````js', open), false);
  assert.equal(closesFence('~~~~', open), false);
});

const ui = await loadUi(`
  export { default as Markdown } from './ui/Markdown.jsx';
  export { default as BookFile } from './ui/book/BookFile.jsx';
  export * from './ui/book/model.js';
  export { StudyServicesContext } from './ui/study-context.jsx';`);
const noop = () => {}, h = React.createElement;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const handlers = { gone: ui.goneSet([]), qaOpen: () => false, toggleQa: noop, source: noop, card: noop, practice: noop, create: noop, files: {}, choose: noop, busy: false };
const render = text => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, h(ui.BookFile, { text, hid: 'h2', handlers })));
const headingsOutsideCode = html => [...html.replace(/<pre[\s\S]*?<\/pre>/g, '').matchAll(/<h\d[^>]*>(.*?)<\/h\d>/g)].map(match => match[1]);

test('a file the book closes with closeFences never swallows the text stitched after it, in the reader', () => {
  for (const open of ['```js\nx\n```js', '````\nx\n```', '~~~js\nx', '```\nx\n~~~', '````md\n```\ninner\n```']) {
    const stitched = `${closeFences(open)}\n\n## After`;
    assert.deepEqual(headingsOutsideCode(render(stitched)), ['After'], JSON.stringify(open));
    assert.deepEqual(fenceMask(rows(stitched)).slice(-1), [false], 'the scanner agrees');
  }
});

test('the reader closes a fence the way CommonMark does: a shorter or other fence line inside is code', () => {
  const html = render('````\n```\n## not a heading\n```\n````\n\n## Real');
  assert.deepEqual(headingsOutsideCode(html), ['Real']);
  assert.match(html, /## not a heading/);
});

test('the footnote tools do not relabel what a mixed fence holds', () => {
  const text = '~~~\n```\n[^1]\n~~~\nBody [^1].\n\n[^1]: note';
  const relabeled = relabelFootnotes(text, label => `x-${label}`);
  assert.match(relabeled, /~~~\n```\n\[\^1\]\n~~~/, 'the mark inside the fence stays');
  assert.match(relabeled, /Body \[\^x-1\]/);
});
