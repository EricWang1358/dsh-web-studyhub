/* #232: a line of dashes (the divider an audio transcript keeps between its parts) is a thematic break, not literal text. The reader draws a
   standalone break as a quiet <hr> in the text sections, keeps its characters as the stored text (selection, find and citations count them),
   and leaves code, tables and layout text alone; new transcripts are written with the standard `---`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment } from 'parse5';
import { loadUi } from './helpers/ui-module.mjs';
import { buildDocuments } from '../lib/transcript.js';

const ui = await loadUi(`
  export { default as ReadingSections } from './ui/document-preview/reader/ReadingSections.jsx';
  export { readingSections, splitParagraphs } from './ui/document-preview/reader/text-sections.js';
  export { renderReaderMarkdown } from './ui/document-preview/reader/markdown.js';`);
const DASHES = '-'.repeat(80);
const kinds = text => ui.splitParagraphs(text).map(paragraph => paragraph.kind);
const render = text => renderToStaticMarkup(React.createElement(ui.ReadingSections, { sections: ui.readingSections({ paged: false, sources: [{ id: 's', text }], text }), labelOf: () => '' }));
/** What selection / find / citations count in rendered markup: the text outside every data-study-marker. */
const countedText = html => {
  let text = '';
  const walk = node => {
    if (node.attrs?.some(attribute => attribute.name === 'data-study-marker')) return;
    if (node.nodeName === '#text') text += node.value;
    node.childNodes?.forEach(walk);
  };
  walk(parseFragment(html));
  return text;
};

test('three or more of - * _ alone on a line are a rule; nothing else is', () => {
  for (const line of [DASHES, '---', '-----', '***', '*****', '___', '_____', '- - -', '* * *', '  ---', '--- ']) assert.deepEqual(kinds(`Before it.\n\n${line}\n\nAfter it.`), ['prose', 'rule', 'prose'], JSON.stringify(line));
  for (const line of ['--', '-', '**', '__', '-*-', '---x', 'x---', '--- --- a', '----|----', '|---|---|', '- item', '— — —', '===']) assert.ok(!kinds(`Before it.\n\n${line}\n\nAfter it.`).includes('rule'), JSON.stringify(line));
  assert.deepEqual(kinds(DASHES), ['rule'], 'a document that is one line of dashes');
});

test('a dash line next to text, in a table or in layout text stays text', () => {
  const next = 'Name\n----\nAda';
  assert.deepEqual(kinds(next), ['prose'], 'an underline directly below a line is not a break in plain text');
  assert.ok(!render(next).includes('<hr'));
  const table = 'Name\tAge\n----\t---\nAda\t36';
  assert.deepEqual(kinds(table), ['layout']);
  assert.ok(!render(table).includes('<hr'));
  assert.ok(!render('| a | b |\n|---|---|\n| 1 | 2 |').includes('<hr'));
});

test('the reader draws a rule as an hr and keeps its characters as the stored text', () => {
  const stored = `第一部分的最后一句。\n\n${DASHES}\n\n【第二部分】\n\n第二部分的第一句。`;
  const html = render(stored);
  assert.equal((html.match(/<hr/g) || []).length, 1);
  assert.match(html, /<hr class="reader-rule"\/?>/);
  assert.doesNotMatch(html, /<p[^>]*>-{3,}/, 'the dashes are not drawn as a paragraph');
  assert.equal(countedText(html).replace(/\s+/g, ''), stored.replace(/\s+/g, ''), 'the text a selection or a citation sees is the stored text');
  assert.match(html, /<span class="reader-bracket" aria-hidden="true">-{80}<\/span>/, 'the dashes stay in the text, hidden like a heading mark');
  assert.equal(render('One.\n\n***\n\nTwo.\n\n___\n\nThree.').match(/<hr/g).length, 2);
});

test('Markdown sources already draw a standalone rule as an hr, and code keeps its dashes', () => {
  const html = ui.renderReaderMarkdown(`first\n\n${DASHES}\n\nsecond\n\n\`\`\`\n${DASHES}\n\`\`\``);
  assert.equal((html.match(/<hr/g) || []).length, 1);
  assert.match(html, /<pre><code>-{80}\n<\/code><\/pre>/);
});

test('new transcripts are written with the standard --- between parts', () => {
  const [document] = buildDocuments({ filename: 'a.mp3', titleEn: 'T', language: 'zh',
    parts: [{ titleZh: '一', titleEn: 'One', english: ['e1'], chinese: ['c1'] }, { titleZh: '二', titleEn: 'Two', english: ['e2'], chinese: ['c2'] }] });
  assert.match(document, /c1\n\n---\n\n【第二部分/);
  assert.doesNotMatch(document, /-{4,}/, 'no long dash line');
  const [english] = buildDocuments({ filename: 'a.mp3', titleEn: 'T', language: 'en',
    parts: [{ titleZh: '一', titleEn: 'One', english: ['e1'], chinese: ['c1'] }, { titleZh: '二', titleEn: 'Two', english: ['e2'], chinese: ['c2'] }] });
  assert.match(english, /c1\n\n---\n\n\[Part 2/);
});
