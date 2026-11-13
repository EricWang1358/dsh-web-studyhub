import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assignHeadingIds, bookIndex, stitchBook } from '../lib/course-book-links.js';
import { exportBook as runExport } from '../lib/course-book-export.js';
import { markdownHeadings } from '../lib/contexts/notes/markdown-fences.js';
import { cardOf, exportBook } from './helpers/course-book-export-book.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* #1038 gate review: the reader, the 目录 and the export know ATX headings only, so a setext heading ("Some text." over "---") is written as an ATX heading
   wherever the book takes it in (assignHeadingIds, stitching, export): the id marker then sits on a line the reader reads, the 目录 target exists, and the
   export prints its anchor and keeps it under its point. */

const ui = await loadUi(`
  export { default as BookFile } from './ui/book/BookFile.jsx';
  export * from './ui/book/model.js';
  export { StudyServicesContext } from './ui/study-context.jsx';`);
const noop = () => {}, h = React.createElement;
const services = { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
const handlers = { gone: ui.goneSet([]), qaOpen: () => false, toggleQa: noop, source: noop, card: noop, practice: noop, create: noop, files: {}, choose: noop, busy: false };
const render = text => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, h(ui.BookFile, { text, hid: 'h2', handlers })));

test('assignHeadingIds writes a setext heading as an ATX heading with its id, the line count unchanged, and does so only once', () => {
  const first = assignHeadingIds('Some text.\n---\nbody', { next: 1 });
  assert.equal(first.text, '## Some text. <!-- sh:id h1 -->\n\nbody');
  assert.equal(first.text.split('\n').length, 3);
  const again = assignHeadingIds(first.text, { next: first.next });
  assert.equal(again.text, first.text, 'an ATX heading with its id is left as it is');
  assert.equal(assignHeadingIds('Big title\n===\nx', { next: 4 }).text, '# Big title <!-- sh:id h4 -->\n\nx');
  assert.equal(assignHeadingIds('Two\nlines\n---\nx', { next: 1 }).text, '## Two lines <!-- sh:id h1 -->\n\n\nx');
});

test('a setext heading that already carries an id keeps it and becomes ATX', () => {
  assert.equal(assignHeadingIds('Title <!-- sh:id h7 -->\n===\nx', { next: 1 }).text, '# Title <!-- sh:id h7 -->\n\nx');
});

test('a thematic break and a fenced underline are left as they are', () => {
  const text = 'text\n\n---\n~~~\nStem\n---\n~~~';
  assert.equal(assignHeadingIds(text).text, text);
});

test('the 目录 of the saved text has the heading, and the reader draws the element it points at, without the marker as text', () => {
  const saved = assignHeadingIds('Some text.\n---\nbody', { next: 1 }).text;
  const [node] = bookIndex(saved).flat;
  assert.deepEqual([node.id, node.level, node.title], ['h1', 2, 'Some text.']);
  const html = render(saved);
  assert.match(html, /id="book-h1"/, 'the target of the 目录 exists');
  assert.doesNotMatch(html, /sh:id/, 'no marker shows as text');
  assert.match(html, />Some text\.</);
});

test('stitching writes a setext heading of a file as ATX, so the stitched book has no underline the reader cannot read', () => {
  const text = stitchBook({ title: 'Book', nodes: [{ hid: 'h2', title: 'Point', number: '1', leaf: true, gen: '', mine: 'Raw title\n===\nbody', children: [] }] });
  assert.doesNotMatch(text, /^={3}$/m);
  assert.deepEqual(markdownHeadings(text.split('\n')).map(item => [item.setext, item.text]), [[false, 'Book <!-- sh:id book -->'], [false, '1 Point <!-- sh:id h2 -->'], [false, 'Raw title']]);
});

test('the export prints a setext heading with its anchor and code and keeps it under its point', () => {
  const saved = assignHeadingIds('Some text.\n---\nbody', { next: 20 }).text;
  const done = runExport(exportBook({ mine: saved }), { cardOf, questions: 'none' });
  assert.match(done.text, /^#{3,6} Some text\. 〔H20〕 \{#h20\}$/m);
  const raw = runExport(exportBook({ mine: 'Raw title\n===\nbody' }), { cardOf, questions: 'none' });
  assert.match(raw.text, /^#{3,6} Raw title$/m, 'a heading never sits above its point, an === one included');
  assert.doesNotMatch(raw.text, /^={3}$/m);
});

test('many alternating list lines and --- lines are read in linear time', () => {
  const lines = Array.from({ length: 20000 }, (_, at) => (at % 2 ? '---' : '- item'));
  const started = Date.now();
  assert.deepEqual(markdownHeadings(lines), []);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});
