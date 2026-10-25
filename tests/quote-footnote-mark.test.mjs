/* #467: a quote copied out of the 复习全书 often ends in Chinese quotation marks with a footnote mark glued on (「……」[^12]). The mark is the book's, not
   the material's words: the comparison key ignores it (the citation check, the quote locator, book.write's footnotes), so a quote that is really in the
   material is found; Chinese and ASCII quotation marks compare alike; and the mark in the book's own text stays where it was. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { citationCheck, quoteFound } from '../lib/quote-match.js';
import { locateQuote } from '../lib/quote-locate.js';
import { writeBookPoint } from '../lib/book-agent-write.js';
import { parseFootnote } from '../lib/book-footnotes.js';
import { openCourseBook } from '../lib/course-book-files.js';
import { resolveQuote } from '../ui/document-preview/selection.js';
import { bookLibrary } from './helpers/book-agent-library.mjs';

const PAGE = '老师在第一讲里强调：“架构师要把每个决定和背后的理由都写下来”，这样以后的人才知道系统为什么是现在这个样子。';
const WORDS = '架构师要把每个决定和背后的理由都写下来';

test('the citation check finds a real quote that carries a footnote mark after its Chinese quotation marks', () => {
  const pages = [{ id: 'p1', text: PAGE }];
  for (const quote of [`「${WORDS}」[^12]`, `“${WORDS}”[^3]`, `"${WORDS}"[^3]`, `${WORDS}[^n-2]`, `${WORDS}[^h4g-3]`, `${WORDS}[^e3]`, `「${WORDS}[^7]」`])
    assert.deepEqual(citationCheck(pages, { sourceId: 'p1', quote }), { ok: true, span: 'page' }, quote);
  assert.equal(quoteFound(PAGE, `「${WORDS}」[^12]`), true);
  // Digits that are the material's own still count: a changed number is still not found.
  assert.equal(citationCheck([{ id: 'p1', text: 'The p99 latency target is 200 ms for every request.' }], { sourceId: 'p1', quote: 'The p99 latency target is 300 ms for every request.' }).ok, false);
  // A negated character class of a lecture is wording, not a footnote mark: a changed class still differs.
  const regex = [{ id: 'p1', text: 'The pattern [^0-9]+ matches every run of characters that are not digits.' }];
  assert.equal(citationCheck(regex, { sourceId: 'p1', quote: 'The pattern [^0-9]+ matches every run of characters' }).ok, true);
  assert.equal(citationCheck(regex, { sourceId: 'p1', quote: 'The pattern [^a-z]+ matches every run of characters' }).ok, false);
  // A digits-only class written as regex code (inside a group, before a quantifier) is wording too.
  const digits = [{ id: 'p1', text: 'Use the group ([^01]+) to find every run of the other digits in the input.' }];
  assert.equal(citationCheck(digits, { sourceId: 'p1', quote: 'Use the group ([^01]+) to find every run' }).ok, true);
  assert.equal(citationCheck(digits, { sourceId: 'p1', quote: 'Use the group ([^23]+) to find every run' }).ok, false);
  // A material that has a mark of its own (a converted book) is found by the quote without it.
  assert.equal(citationCheck([{ id: 'p1', text: PAGE.replace('理由', '理由[^4]') }], { sourceId: 'p1', quote: `「${WORDS}」` }).ok, true);
});

test('the quote locator ignores footnote marks on either side and points at the material\'s own words', () => {
  const at = locateQuote(PAGE, `「${WORDS}」[^12]`);
  assert.ok(at, 'found');
  assert.equal(PAGE.slice(at.start, at.end), WORDS);
  const marked = PAGE.replace('理由', '理由[^4]'), inside = locateQuote(marked, WORDS);
  assert.ok(inside, 'found across the material\'s own mark');
  assert.equal(marked.slice(inside.start, inside.end), WORDS.replace('理由', '理由[^4]'));
});

test('a footnote\'s quote is read to its own closing mark: inner quotation marks and a trailing [^n] are not the end of it', () => {
  assert.deepEqual(parseFootnote(`「“${WORDS}”」 (p1)`), { quote: `“${WORDS}”`, sourceId: 'p1' });
  assert.deepEqual(parseFootnote(`「什么是「架构」的决定」 (p1)`), { quote: '什么是「架构」的决定', sourceId: 'p1' });
  assert.deepEqual(parseFootnote(`「${WORDS}」[^12] (p1)`), { quote: WORDS, sourceId: 'p1' });
  assert.deepEqual(parseFootnote(`「${WORDS}[^12]」（p1）`), { quote: WORDS, sourceId: 'p1' });
  assert.deepEqual(parseFootnote(`[「${WORDS}」](studyhub://source/p1) · 讲义`), { quote: WORDS, sourceId: 'p1' });
});

test('a quote of a material that holds its own mark is stored without it, found again on every later write, and survives a whole-file rewrite', () => {
  const { state } = bookLibrary();
  state.sources.find(source => source.id === 'document-l1-p1').text += ` ${PAGE.replace('理由', '理由[^4]')}`;
  const what = openCourseBook(state, {}).nodes[0].children[0];
  const file = () => state.sources.find(source => source.provenance === 'course-book-doc').bookDoc.files[what.files.gen].text;
  const stored = writeBookPoint(state, { hid: what.hid, markdown: `讲义说要写下理由[^1]。\n\n[^1]: 「${WORDS}」 (document-l1-p1)` });
  assert.deepEqual(stored.dropped, []);
  const definition = file().split('\n').find(line => line.startsWith('[^1]:'));
  assert.match(definition, new RegExp(`^\\[\\^1\\]: \\[「${WORDS}」\\]`), 'stored without the material\'s mark');
  const edited = writeBookPoint(state, { hid: what.hid, edits: [{ find: '讲义说', replace: '讲义里说' }] });
  assert.deepEqual([edited.dropped, edited.warnings.filter(warning => /footnote/.test(warning))], [[], []], 'found again, not merely kept as written');
  // The chat reads the file and writes it back whole: the stored footnote is a new footnote of the write, checked and found.
  const rewritten = writeBookPoint(state, { hid: what.hid, markdown: `讲义里说要写下理由[^1]，这一点很重要。\n\n${definition}` });
  assert.deepEqual([rewritten.dropped, rewritten.warnings.filter(warning => /footnote/.test(warning))], [[], []]);
  assert.match(file(), /这一点很重要/);
  assert.match(file(), /写下理由\[\^1\]，/);
  assert.equal(file().split('\n').find(line => line.startsWith('[^1]:')), definition);
});

test('a footnote an older release stored with the material\'s mark as " ^4 " is still found: verified on an unrelated edit, stored anew, and placed by the reader', () => {
  const { state } = bookLibrary();
  const material = PAGE.replace('理由', '理由[^4]');
  state.sources.find(source => source.id === 'document-l1-p1').text += ` ${material}`;
  const what = openCourseBook(state, {}).nodes[0].children[0];
  const record = state.sources.find(source => source.provenance === 'course-book-doc'), file = () => record.bookDoc.files[what.files.gen];
  // The base rendering: the found words with their brackets made spaces.
  const legacy = WORDS.replace('理由', '理由 ^4 ');
  file().text = `讲义说要写下理由[^1]。\n\n**出处**\n\n[^1]: [「${legacy}」](studyhub://source/document-l1-p1) · 01. Introduction`;
  assert.equal(resolveQuote(material, legacy).status, 'fuzzy', 'the reader still places the old quote');
  const done = writeBookPoint(state, { hid: what.hid, edits: [{ find: '讲义说', replace: '讲义里说' }] });
  assert.deepEqual([done.dropped, done.warnings.filter(warning => /footnote/.test(warning))], [[], []], 'found, not merely kept as written');
  assert.match(file().text, new RegExp(`^\\[\\^1\\]: \\[「${WORDS}」\\]\\(studyhub://source/document-l1-p1\\)`, 'm'), 'stored anew without the mark');
  // A quote that really holds " ^2 " is still compared with it first.
  const power = 'In the slides the power is written as 2 ^4 and means sixteen, and 2 ^5 means thirty-two.';
  const at = locateQuote(power, 'the power is written as 2  ^4 and means sixteen');
  assert.equal(power.slice(at.start, at.end), 'the power is written as 2 ^4 and means sixteen');
});

test('book.write: 「quote」[^12] in the text keeps its mark, and the footnote whose words are in the material is found', () => {
  const { state } = bookLibrary();
  state.sources.find(source => source.id === 'document-l1-p1').text += ` ${PAGE}`;
  const what = openCourseBook(state, {}).nodes[0].children[0];
  const file = () => state.sources.find(source => source.provenance === 'course-book-doc').bookDoc.files[what.files.gen].text;
  const done = writeBookPoint(state, { hid: what.hid, markdown: `讲义说「${WORDS}」[^12]，这是第一讲的重点。\n\n[^12]: 「“${WORDS}”」[^12] (document-l1-p1)` });
  assert.deepEqual(done.dropped, []);
  assert.match(file(), new RegExp(`讲义说「${WORDS}」\\[\\^1\\]，这是第一讲的重点。`), 'the mark stays right after the closing quotation mark');
  assert.match(file(), new RegExp(`^\\[\\^1\\]: \\[「“${WORDS}”」\\]\\(studyhub://source/document-l1-p1\\)`, 'm'), 'the material\'s own words and quotation marks');
});
