/* #1038 re-gate: book.write meets setext headings. A text the chat writes with an underlined title is put below the point's own level like any other (the
   headings count toward `top` and are moved with it), and a section's own first heading may be underlined. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftHeadings } from '../lib/book-agent-write.js';
import { bookService } from './helpers/book-agent-library.mjs';

const read = async (study, hid, kind = 'gen') => (await study.call('book.read', { hid, file: kind })).files[kind];
const outline = file => file.headings.map(heading => [heading.level, heading.title]);

test('shiftHeadings moves a setext heading with the others, as an ATX heading', () => {
  assert.equal(shiftHeadings('Intro\n=====\n\nSome text.\n\n## Sub\n\nmore', 4).text, '#### Intro\n\n\nSome text.\n\n##### Sub\n\nmore');
  assert.equal(shiftHeadings('Intro\n=====\n\nSome text.\n\n## Sub\n\nmore', 4).shifted, true);
  assert.equal(shiftHeadings('Intro\n---\nx', 4).text, '#### Intro\n\nx');
});

test('a whole file written with an underlined title lands below the point\'s level, as the answer says', async t => {
  const { study, toc } = await (async () => { const made = await bookService(t); return { ...made, toc: (await made.study.call('book.toc')).toc }; })();
  const what = toc[1];
  const done = await study.call('book.write', { hid: what.hid, markdown: 'Intro\n=====\n\nSome text.\n\n## Sub\n\nmore' });
  assert.equal(done.status, 'saved');
  assert.ok(done.warnings.some(warning => /headings moved/.test(warning)));
  const file = await read(study, what.hid);
  assert.deepEqual(outline(file), [[4, 'Intro'], [5, 'Sub']]);
  assert.doesNotMatch(file.text, /^={3,}$/m);
});

test('a section whose own first heading is underlined is written at the level its place asks, under that title', async t => {
  const made = await bookService(t), what = (await made.study.call('book.toc')).toc[1];
  await made.study.call('book.write', { hid: what.hid, markdown: '#### One\n\nfirst.' });
  const done = await made.study.call('book.write', { hid: what.hid, op: 'insert', position: 'end', section: { heading: 'Sub', markdown: 'Sub title\n---\nbody' } });
  assert.equal(done.status, 'saved');
  const file = await read(made.study, what.hid);
  assert.deepEqual(outline(file), [[4, 'One'], [4, 'Sub title']]);
  assert.match(file.text, /body/);
  assert.doesNotMatch(file.text, /^-{3}$/m);
});
