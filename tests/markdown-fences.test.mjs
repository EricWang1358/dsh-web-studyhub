import test from 'node:test';
import assert from 'node:assert/strict';
import { closeFences, bookIndex, assignHeadingIds } from '../lib/course-book-links.js';
import { headingsOf, shiftLevels } from '../lib/book-section-ops.js';
import { definedTerms } from '../lib/course-book-lookup.js';
import { weaveBlocks } from '../lib/course-book-ai-text.js';
import { fenceMask, closingFence, markdownHeadings } from '../lib/contexts/notes/markdown-fences.js';

/* #1029: a code fence is read the way CommonMark reads it (one helper, lib/contexts/notes/markdown-fences.js): it is closed only by a fence of the same
   character that is at least as long, and a heading may be written with an underline (setext). The book, the export and the note from a question share it. */

const rows = text => text.split('\n');

test('fenceMask: a ``` fence is closed by ``` only, a ~~~ line inside it is code', () => {
  assert.deepEqual(fenceMask(rows('a\n```js\n~~~\ncode\n```\nb')), [false, true, true, true, true, false]);
});

test('fenceMask: a longer opening fence needs a closing run at least as long', () => {
  assert.deepEqual(fenceMask(rows('````\n```\nstill code\n````\nafter')), [true, true, true, true, false]);
  assert.deepEqual(fenceMask(rows('~~~~\n~~~\nstill code')), [true, true, true]);
});

test('fenceMask: a closing fence carries no text; an info string does not close', () => {
  assert.deepEqual(fenceMask(rows('```\n```js\ncode\n```\nafter')), [true, true, true, true, false]);
});

test('fenceMask: a backtick fence whose info string holds a backtick is no fence', () => {
  assert.deepEqual(fenceMask(rows('``` a`b\nplain')), [false, false]);
});

test('closingFence: the line that closes what is left open, in the opening character and at least its length', () => {
  assert.equal(closingFence(rows('text\n```js\ncode')), '```');
  assert.equal(closingFence(rows('~~~js\ncode')), '~~~');
  assert.equal(closingFence(rows('`````\ncode\n```')), '`````');
  assert.equal(closingFence(rows('~~~\ncode\n~~~')), '');
  assert.equal(closingFence(rows('no fence')), '');
});

test('closeFences closes an open ~~~ with ~~~, a long fence with a long one, and leaves a closed text alone', () => {
  assert.equal(closeFences('stem\n~~~js\nx = 1\n'), 'stem\n~~~js\nx = 1\n~~~');
  assert.equal(closeFences('````md\n```\ninner\n```\n'), '````md\n```\ninner\n```\n````');
  const closed = 'a\n~~~\nb\n~~~\nc';
  assert.equal(closeFences(closed), closed);
  assert.equal(closeFences('a\n```\nb\n~~~\n'), 'a\n```\nb\n~~~\n```', 'a ~~~ line does not close a ``` fence');
});

test('closeFences: the text stitched after a file with an open ~~~ is no longer code', () => {
  const first = closeFences('stem\n~~~js\nx = 1');
  const lines = rows(`${first}\n\n## Next`);
  assert.equal(fenceMask(lines).at(-1), false);
});

test('headings: a heading line inside a ~~~ fence that holds ``` lines is no heading', () => {
  const lines = rows('# One\n~~~\n```\n# not a heading\n~~~\n## Two');
  assert.deepEqual(headingsOf(lines).map(heading => heading.title), ['One', 'Two']);
  assert.deepEqual(bookIndex(lines.join('\n')).flat.map(node => node.title), ['One', 'Two']);
});

test('setext: Title + === is a level 1 heading, Title + --- a level 2 heading', () => {
  const lines = rows('Stem\n===\ntext\n\nSecond\n---\nmore');
  assert.deepEqual(headingsOf(lines).map(heading => [heading.at, heading.level, heading.title]), [[0, 1, 'Stem'], [4, 2, 'Second']]);
  assert.deepEqual(bookIndex(lines.join('\n')).flat.map(node => [node.level, node.title]), [[1, 'Stem'], [2, 'Second']]);
});

test('setext: a --- after a blank line is a thematic break, not a heading; so is one after a list item, a quote or a heading', () => {
  for (const text of ['text\n\n---\nmore', '- item\n---', '> quote\n---', '# Heading\n---', '---\nafter', 'a\n\n===\nb', '<!-- sh:qa id=1 -->\n---']) {
    assert.deepEqual(headingsOf(rows(text)).filter(heading => heading.title !== 'Heading'), [], text);
  }
});

test('setext: an underline inside a code fence is no heading', () => {
  assert.deepEqual(headingsOf(rows('```\nStem\n---\n```')), []);
});

test('setext: an id comment at the end of the text line is kept as the heading id', () => {
  const index = bookIndex('Title <!-- sh:id h7 -->\n===\n');
  assert.deepEqual(index.flat.map(node => [node.id, node.level, node.title]), [['h7', 1, 'Title']]);
});

test('setext: a heading that spans two lines is one heading', () => {
  assert.deepEqual(markdownHeadings(rows('First line\nsecond line\n---')).map(item => [item.at, item.level, item.text]), [[0, 2, 'First line second line']]);
});

test('shiftLevels writes a setext heading as an ATX heading of the shifted level and keeps the line count', () => {
  const lines = rows('Stem\n---\nbody\n# Own');
  const shifted = shiftLevels(lines, 1);
  assert.equal(shifted.length, lines.length);
  assert.deepEqual(shifted, ['### Stem', '', 'body', '## Own']);
  assert.deepEqual(shiftLevels(rows('Big\n===\nx'), 2), ['### Big', '', 'x']);
  assert.deepEqual(shiftLevels(rows('Big\nand wide\n===\nx'), 1), ['## Big and wide', '', '', 'x']);
});

test('shiftLevels leaves a thematic break and a fenced underline as they are', () => {
  const lines = rows('text\n\n---\n~~~\nStem\n---\n~~~');
  assert.deepEqual(shiftLevels(lines, 2), lines);
});

test('assignHeadingIds gives a setext heading an id on its text line', () => {
  assert.equal(assignHeadingIds('Stem\n===\n', { next: 1 }).text, 'Stem <!-- sh:id h1 -->\n===\n');
});

test('definedTerms skips what a ~~~ fence holding ``` lines holds', () => {
  const text = '~~~\n```\n**Hidden**: x\n~~~\n**Shown**: y\n';
  assert.deepEqual(definedTerms(text).map(item => item.term), ['Shown']);
});

test('weaveBlocks keeps a paragraph that holds a ~~~ fence with a blank line and ``` lines whole', () => {
  const text = 'Intro.\n\n~~~\n```\n\nneedle words here\n~~~\n\nLast.';
  const block = { id: 'b', at: 'zzzzzzzz', about: 'needle words here', raw: '<ai>', start: 0, end: 0 };
  const woven = weaveBlocks([{ name: 'g', text }], [block]);
  const kinds = woven.parts.map(part => (part.block ? 'block' : part.text));
  assert.deepEqual(kinds, ['Intro.\n\n~~~\n```\n\nneedle words here\n~~~', 'block', 'Last.']);
});
