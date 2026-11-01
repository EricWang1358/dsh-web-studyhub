/* The main chat's reads of the 复习全书 (docs/review-book-agent.md): book.toc, book.read, source.pages, book.coverage. Every result well under the host's
   8 192-character cut; source.pages shows at most 4 pages and 6 000 characters and records what it showed beside the book history (not in the library),
   so book.coverage counts pages really opened. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportHistoryFiles } from '../lib/course-book-history.js';
import { addRange, coveredChars, RANGES_KEPT } from '../lib/book-reading.js';
import { pageRanges, wordCount, citedSources } from '../lib/book-agent-view.js';
import { summaryOf } from '../lib/book-agent-read.js';
import { libraryContracts, studyToolDescription } from '../lib/study-contracts.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { FILE_TEXT_MAX } from '../lib/course-book-edit.js';
import { bookService, sizeOf, COURSE } from './helpers/book-agent-library.mjs';

const LIMIT = 8000;

test('book.toc makes the book when there is none, lists every point with its files, versions, words and pages opened; small and paged', async t => {
  const { study } = await bookService(t);
  const toc = await study.call('book.toc');
  assert.equal(toc.status, 'ok');
  assert.equal(toc.course, COURSE);
  assert.equal(toc.points, 2);
  assert.deepEqual(toc.toc.map(row => [row.n, row.title]), [['1', 'Introduction'], ['1.1', 'What architects do'], ['1.2', 'Stakeholders']]);
  const what = toc.toc[1];
  assert.match(what.hid, /^h\d+$/);
  assert.equal(what.files.gen.v, 1);
  assert.ok(what.files.gen.words > 3, 'the generated file has words');
  assert.deepEqual(what.files.mine, { v: 1, words: 0 });
  assert.equal(what.read, '0/2', 'two pages, none opened yet');
  assert.equal(what.cited, 1, 'the generated file cites page 1');
  assert.equal(toc.toc[0].files, undefined, 'a chapter row has no files');
  assert.ok(sizeOf(toc) < LIMIT);
  const paged = await study.call('book.toc', { limit: 1, offset: 1 });
  assert.deepEqual(paged.toc.map(row => row.n), ['1.1']);
  assert.equal(paged.nextOffset, 2);
  assert.equal((await study.call('book.toc', { limit: 1, offset: 2 })).nextOffset, null);
  assert.deepEqual(await study.call('book.toc', { course: 'Nope' }), { status: 'empty', course: 'Nope', reason: 'no-outline' });
});

test('book.toc of a large book stays under the cut at its largest page', async t => {
  const titles = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, title: `Point ${i}: ${'a rather long title about the architecture of systems '.repeat(3)}`, anchors: [] }));
  const { study } = await bookService(t, { points: titles });
  const toc = await study.call('book.toc', { limit: 1000 });
  assert.equal(toc.toc.length, 40, 'at most 40 rows a call');
  assert.ok(sizeOf(toc) < LIMIT, `${sizeOf(toc)} characters`);
  assert.ok(toc.toc.every(row => row.title.length <= 61));
});

test('book.toc compact (#489 item 12): hid, n and title only, more rows a call; a 400-point book is walked in a few calls, each under the cut', async t => {
  const titles = Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, title: `Point ${i}: ${'a rather long title about the architecture of systems '.repeat(3)}`, anchors: [] }));
  const { study } = await bookService(t, { points: titles });
  const plain = [];
  for (let at = 0; at !== null;) { const page = await study.call('book.toc', { offset: at, limit: 40 }); plain.push(...page.toc.map(row => row.hid)); at = page.nextOffset; }
  const seen = [], sizes = [];
  let calls = 0;
  for (let at = 0; at !== null;) {
    const page = await study.call('book.toc', { offset: at, compact: true, limit: 1000 });
    calls += 1; sizes.push(sizeOf(page)); seen.push(...page.toc);
    assert.ok(page.toc.length <= 60, 'at most 60 compact rows a call');
    at = page.nextOffset;
  }
  assert.deepEqual(seen.map(row => row.hid), plain, 'the same rows in the same order as the full table of contents');
  assert.ok(calls <= 8, `${calls} calls`);
  assert.ok(Math.max(...sizes) < LIMIT, `${Math.max(...sizes)} characters`);
  assert.deepEqual(Object.keys(seen[1]).sort(), ['hid', 'n', 'title'], 'a point row: id, number, title');
  assert.deepEqual(Object.keys(seen[0]).sort(), ['chapter', 'hid', 'n', 'title'], 'a chapter row says so, as it has no point to read');
  assert.equal((await study.call('book.toc', { compact: true })).toc.length, 60, 'compact rows default to the most a call carries');
  assert.equal((await study.call('book.toc', { compact: true, limit: 5 })).toc.length, 5);
});

test('book.read heading: a file read from one heading (id or title) on, its headings listed from there; no heading, or heading with offset, is refused', async t => {
  const { study } = await bookService(t);
  const toc = await study.call('book.toc'), what = toc.toc[1], opened = await study.call('course.book.open');
  const file = opened.nodes[0].children[0].files.mine, long = Array.from({ length: 300 }, (_, i) => `## Part ${i}\n\nLine ${i} of my own long notes about architects.`).join('\n\n');
  await study.call('course.book.save', { file, text: long, version: opened.files[file].version });
  const first = (await study.call('book.read', { hid: what.hid, file: 'mine' })).files.mine;
  assert.equal(first.headings.length, 30, 'a long file lists 30 headings from its start');
  let all = '';
  for (let at = 0; at !== null;) { const page = (await study.call('book.read', { hid: what.hid, file: 'mine', offset: at })).files.mine; all += page.text; at = page.truncated ? page.nextOffset : null; }
  const idOf = title => new RegExp(`## ${title} <!-- sh:id (h\\d+) -->`).exec(all)[1];
  for (const wanted of [idOf('Part 100'), 'Part 100']) {
    const view = (await study.call('book.read', { hid: what.hid, file: 'mine', heading: wanted })).files.mine;
    assert.match(view.text, /^## Part 100 /);
    assert.equal(view.from, all.indexOf('## Part 100 '), 'the text starts at the heading line');
    assert.equal(view.headings[0].id, idOf('Part 100'));
    assert.equal(view.headings[0].title, 'Part 100');
    assert.equal(view.headings.length, 30);
  }
  // It goes on as any cut file does: by nextOffset.
  const cut = (await study.call('book.read', { hid: what.hid, file: 'mine', heading: 'Part 100' })).files.mine;
  assert.equal(cut.truncated, true);
  assert.equal((await study.call('book.read', { hid: what.hid, file: 'mine', offset: cut.nextOffset })).files.mine.from, cut.nextOffset);
  const codeOf = async args => (await study.call('book.read', args).then(() => ({}), error => error)).code;
  assert.equal(await codeOf({ hid: what.hid, file: 'mine', heading: 'No such part' }), 'book-section-missing');
  assert.equal(await codeOf({ hid: what.hid, heading: 'Part 100' }), 'book-offset-needs-file');
  assert.equal(await codeOf({ hid: what.hid, file: 'mine', heading: 'Part 100', offset: 10 }), 'book-read-heading-offset');
  assert.equal(await codeOf({ hid: what.hid, file: 'mine', heading: 7 }), 'book-section-missing');
});

test('book.read: one point, its files, headings, neighbours and pages; a long file is cut and continued with file/offset', async t => {
  const { study } = await bookService(t);
  const toc = await study.call('book.toc'), [what, who] = toc.toc.slice(1);
  const read = await study.call('book.read', { hid: what.hid });
  assert.equal(read.title, 'What architects do');
  assert.deepEqual(read.path, ['Introduction']);
  assert.equal(read.previous, null);
  assert.equal(read.next.hid, who.hid);
  assert.match(read.next.summary, /Stakeholders/);
  assert.match(read.files.gen.text, /About What architects do/);
  assert.equal(read.files.mine.text, '');
  assert.equal(read.files.qa, undefined, 'no Q&A file yet');
  assert.equal(read.materials.length, 1);
  assert.equal(read.materials[0].pages, '1-2');
  assert.deepEqual(read.reading, { pages: 2, opened: 0, partial: 0, cited: 1, citedOutside: 0 });
  assert.ok(sizeOf(read) < LIMIT);

  // A long own file: the answer is cut at the budget and says where to go on.
  const opened = await study.call('course.book.open');
  const file = opened.nodes[0].children[0].files.mine, long = Array.from({ length: 300 }, (_, i) => `## Part ${i}\n\nLine ${i} of my own long notes about architects.`).join('\n\n');
  await study.call('course.book.save', { file, text: long, version: opened.files[file].version });
  const cut = await study.call('book.read', { hid: what.hid });
  assert.ok(sizeOf(cut) < LIMIT, `${sizeOf(cut)} characters`);
  assert.equal(cut.more.file, 'mine');
  assert.ok(cut.files.gen.text.length + cut.files.mine.text.length <= 4500);
  assert.ok(cut.files.mine.headings.length <= 30 && cut.files.mine.headings[0].id, 'headings with their ids');
  const rest = await study.call('book.read', { hid: what.hid, file: 'mine', offset: cut.more.offset });
  assert.deepEqual(Object.keys(rest.files), ['mine']);
  assert.equal(rest.files.mine.from, cut.more.offset);
  assert.ok(rest.files.mine.text.length <= 5500);
  assert.ok(sizeOf(rest) < LIMIT);
  // A cut file says so and where to go on; reading on by nextOffset rebuilds the file exactly; an offset without a file is refused, not ignored.
  assert.equal(cut.files.mine.truncated, true);
  assert.equal(cut.files.mine.nextOffset, cut.more.offset);
  await assert.rejects(study.call('book.read', { hid: what.hid, offset: 100 }), error => error.code === 'book-offset-needs-file' || /offset needs file/.test(error.message));
  let rebuilt = '', at = 0;
  for (let step = 0; step < 100; step += 1) {
    const page = (await study.call('book.read', { hid: what.hid, file: 'mine', offset: at })).files.mine;
    rebuilt += page.text;
    if (!page.truncated) break;
    at = page.nextOffset;
  }
  assert.equal(rebuilt.length, cut.files.mine.chars, 'pages by nextOffset neither overlap nor skip');
  assert.equal((rebuilt.match(/^## Part \d+ /gm) || []).length, 300, 'every part once');

  // course.book.save names what is wrong: no text, no version, a text too long are three different refusals.
  const codeOf = async args => (await study.call('course.book.save', args).then(() => ({}), error => error)).code;
  assert.equal(await codeOf({ file, nodes: [] }), 'course-book-text-missing');
  await assert.rejects(study.call('course.book.save', { file, nodes: [] }), /got keys: file, nodes; expected \{ file, text, version \}/);
  assert.equal(await codeOf({ file, text: 'x' }), 'course-book-version-required');
  assert.equal(await codeOf({ file, text: 'x'.repeat(FILE_TEXT_MAX + 1), version: opened.files[file].version }), 'course-book-text-too-long');
  await assert.rejects(study.call('book.read', { hid: toc.toc[0].hid }), error => error.code === 'book-point-not-leaf');
  await assert.rejects(study.call('book.read', { hid: 'h999' }), error => error.code === 'book-point-missing');
  await assert.rejects(study.call('book.read', { hid: what.hid, file: 'qa' }), error => error.code === 'book-file-invalid');
});

test('source.pages: at most 4 pages and 6 000 characters, continued with next; refuses the library\'s own lists', async t => {
  const { study, root } = await bookService(t, { long: true });
  const toc = await study.call('book.toc'), what = toc.toc[1];
  const { materials } = await study.call('book.read', { hid: what.hid });
  const documentId = materials[0].documentId;
  const first = await study.call('source.pages', { documentId, from: 1, to: 9 });
  assert.ok(first.shown.length <= 4);
  assert.ok(first.shown.reduce((sum, page) => sum + page.text.length, 0) <= 6000);
  assert.ok(sizeOf(first) < LIMIT, `${sizeOf(first)} characters`);
  assert.deepEqual(first.shown.map(page => page.page), [1, 2]);
  assert.equal(first.shown[0].text.length, first.shown[0].chars, 'page 1 whole');
  assert.equal(first.next.from, 2);
  assert.ok(first.next.offset > 0, 'page 2 goes on from where it was cut');
  const second = await study.call('source.pages', { documentId, from: first.next.from, offset: first.next.offset, hid: what.hid });
  assert.equal(second.shown[0].offset, first.next.offset);
  assert.equal(second.shown[0].page, 2);
  // By a page's sourceId alone: that page.
  const byPage = await study.call('source.pages', { sourceId: 'document-l1-p3' });
  assert.equal(byPage.shown[0].page, 3);
  for (const id of [(await study.store.read()).sources.find(source => source.provenance === 'course-book-doc').id, (await study.store.read()).sources.find(source => source.provenance === 'course-outline').id])
    await assert.rejects(study.call('source.pages', { sourceId: id }), error => error.code === 'source-pages-missing');
  await assert.rejects(study.call('source.pages', {}), error => error.code === 'source-pages-target');
  await assert.rejects(study.call('source.pages', { documentId, from: 50 }), error => error.code === 'source-pages-range');

  // The record lives beside the history, never in the library, and the history's backup leaves it out.
  assert.ok((await readdir(join(root, 'book-history'))).includes('reading.json'));
  const record = JSON.parse(await readFile(join(root, 'book-history', 'reading.json'), 'utf8'));
  assert.deepEqual(record.sources['document-l1-p1'], [[0, first.shown[0].chars]]);
  assert.equal(Object.keys(record.points).length, 1, 'the call that named the point recorded it');
  assert.equal(JSON.stringify(await study.store.read()).includes('reading.json'), false);
  assert.deepEqual((await exportHistoryFiles(root)).map(file => file.name).filter(name => name === 'reading.json'), []);
});

test('book.coverage: the point\'s pages opened, partly opened, not opened and cited, per document, with where to read next', async t => {
  const { study } = await bookService(t, { long: true });
  const toc = await study.call('book.toc'), [what, who] = toc.toc.slice(1);
  const before = await study.call('book.coverage', { hid: what.hid });
  assert.deepEqual(before.totals, { pages: 2, opened: 0, partial: 0, cited: 1, citedOutside: 0 });
  assert.equal(before.documents[0].unopened, '1-2');
  assert.equal(before.documents[0].cited, '1');
  assert.deepEqual([before.readNext.from, before.readNext.to], [1, 4]);
  const shown = await study.call('source.pages', { documentId: before.documents[0].documentId, from: 1, to: 2 });
  const middle = await study.call('book.coverage', { hid: what.hid });
  assert.equal(middle.documents[0].opened, '1');
  assert.equal(middle.documents[0].partial, '2');
  assert.equal(middle.readNext.from, 2);
  await study.call('source.pages', { documentId: before.documents[0].documentId, from: shown.next.from, offset: shown.next.offset, to: 2 });
  const after = await study.call('book.coverage', { hid: what.hid });
  assert.deepEqual(after.totals, { pages: 2, opened: 2, partial: 0, cited: 1, citedOutside: 0 });
  assert.equal(after.readNext, undefined);
  assert.equal((await study.call('book.toc')).toc[1].read, '2/2');
  assert.equal((await study.call('book.coverage', { hid: who.hid })).totals.opened, 0, 'the other point\'s pages are its own');
  assert.ok(sizeOf(after) < LIMIT);
});

test('the tool contract names the reads in area book, and the description points there', () => {
  for (const action of ['book.toc {course?', 'book.read {course?,hid', 'source.pages {documentId|sourceId', 'book.coverage {course?,hid}']) assert.ok(libraryContracts.book.includes(action), action);
  assert.match(libraryContracts.book, /never use course\.book\.open or course\.book\.save/);
  for (const text of ['book.toc {course?,offset?,limit?<=40,compact?}', 'offset?|heading? (only with file']) assert.ok(libraryContracts.book.includes(text), text);
  assert.match(studyToolDescription, /book\.toc\/read\/coverage, source\.pages \(details: book\)/);
  assert.deepEqual([writesFor('library', 'book.toc'), writesFor('library', 'book.read'), writesFor('library', 'source.pages'), writesFor('library', 'book.coverage')], [['sources'], [], [], []]);
});

test('the pure helpers: ranges merge and count, page ranges, words, cited sources, summaries', () => {
  assert.deepEqual(addRange(addRange([], 0, 10), 5, 20), [[0, 20]]);
  assert.deepEqual(addRange([[0, 5]], 10, 12), [[0, 5], [10, 12]]);
  let many = [];
  for (let at = 0; at < RANGES_KEPT + 10; at++) many = addRange(many, at * 10, at * 10 + 5);
  assert.equal(many.length, RANGES_KEPT);
  assert.equal(coveredChars([[0, 5], [10, 20]], 3, 15), 7);
  assert.equal(pageRanges([5, 1, 2, 3, 3, 9, 10]), '1-3,5,9-10');
  assert.equal(wordCount('微服务 splits a system <!-- sh:id h3 --> [link](studyhub://source/x)'), 3 + 3 + 1);
  assert.deepEqual([...citedSources('Text [^1].\n\n[^1]: [「a」](studyhub://source/s-1) · T\n[^2]: 「b words」 (s-2)\n[^3]: no id')], ['s-1', 's-2']);
  assert.equal(summaryOf('**考情** 样卷考过。\n\n**知识梳理**\n\n- First point [^1].\n'), '考情 样卷考过。');
  assert.equal(summaryOf('**知识梳理**\n\n- First point [^1].\n'), 'First point .');
});
