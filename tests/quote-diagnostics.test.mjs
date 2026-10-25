/* #486: a quote that is not on its page says why — the two normalised sides, the closest place on the page with a piece of its own text, the first
   character that differs, and whether the page ends in the middle of the quote (a cut, not a wrong quote). The match itself is unchanged: a real quote
   still passes, a too-short one is still too short, an unknown page is still unknown. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { citationCheck, citationProblems } from '../lib/quote-match.js';

const PAGE = 'The architect writes down every decision and the reason behind it, so the next person knows why the system looks the way it does today.';
const NEAR = 'The architect writes down every decision and the reason behind it, so the next person knows why the system looks the way it did yesterday.';
const ABSENT = 'Completely unrelated words about cooking pasta with tomato sauce and basil.';
const CUT_PAGE = 'The architect writes down every decision and the reason';
const CUT_QUOTE = 'The architect writes down every decision and the reason behind it, so the next person knows.';
const PAGE_ZH = '老师在第一讲里强调：“架构师要把每个决定和背后的理由都写下来”，这样以后的人才知道系统为什么是现在这个样子。';
const WORDS_ZH = '架构师要把每个决定和背后的理由都写下来';

const pages = () => [{ id: 'p1', text: PAGE }];

test('a quote that differs near its end is a near miss, and the diagnosis quotes the page back', () => {
  const check = citationCheck(pages(), { sourceId: 'p1', quote: NEAR });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'quote-not-found');
  assert.equal(check.diagnostics.kind, 'near-miss');
  assert.equal(check.diagnostics.closest.sourceId, 'p1');
  assert.equal(check.diagnostics.closest.page, 0);
  assert.ok(check.diagnostics.closest.matchedChars >= 40, String(check.diagnostics.closest.matchedChars));
  assert.ok(check.diagnostics.closest.similarity >= 0.6, String(check.diagnostics.closest.similarity));
  assert.ok(check.diagnostics.closest.quote.startsWith('The architect writes down'), check.diagnostics.closest.quote);
  assert.ok(check.diagnostics.firstDifference.index > 0);
  assert.equal(check.diagnostics.requested.key, check.diagnostics.requested.key.toLowerCase());
});

test('a quote that is not there at all is absent, with nothing shared to point at', () => {
  const check = citationCheck(pages(), { sourceId: 'p1', quote: ABSENT });
  assert.equal(check.reason, 'quote-not-found');
  assert.equal(check.diagnostics.kind, 'absent');
  assert.equal(check.diagnostics.closest.matchedChars, 0);
  assert.equal(check.diagnostics.closest.similarity, 0);
  assert.equal(check.diagnostics.closest.quote, '');
});

test('a page that ends in the middle of the quote is a cut, not a wrong quote', () => {
  const check = citationCheck([{ id: 'p1', text: CUT_PAGE }], { sourceId: 'p1', quote: CUT_QUOTE });
  assert.equal(check.reason, 'quote-not-found');
  assert.equal(check.diagnostics.kind, 'truncated');
  assert.ok(check.diagnostics.closest.matchedChars >= 4);
});

test('the first character that differs is reported with both sides', () => {
  const check = citationCheck(pages(), { sourceId: 'p1', quote: NEAR });
  const { index, requested, source } = check.diagnostics.firstDifference;
  assert.equal(typeof index, 'number');
  assert.notEqual(requested, source);
  assert.ok(check.diagnostics.requested.key.length > index);
});

test('a real quote, including one with a footnote mark after Chinese quotation marks, still passes untouched', () => {
  assert.deepEqual(citationCheck([{ id: 'p1', text: PAGE_ZH }], { sourceId: 'p1', quote: `「${WORDS_ZH}」[^12]` }), { ok: true, span: 'page' });
  assert.deepEqual(citationCheck(pages(), { sourceId: 'p1', quote: 'writes down every decision' }), { ok: true, span: 'page' });
});

test('the other failure reasons keep their shape: no diagnosis for a short quote or an unknown page', () => {
  assert.deepEqual(citationCheck(pages(), { sourceId: 'p1', quote: 'short' }), { ok: false, reason: 'too-short', foundIn: [] });
  assert.deepEqual(citationCheck(pages(), { sourceId: 'nope', quote: NEAR }), { ok: false, reason: 'unknown-source', foundIn: [] });
});

test('a card problem carries the diagnosis, so the author can see it without another call', () => {
  const problems = citationProblems({ citations: [{ sourceId: 'p1', quote: NEAR }] }, pages());
  assert.equal(problems.length, 1);
  assert.equal(problems[0].reason, 'quote-not-found');
  assert.equal(problems[0].diagnostics.kind, 'near-miss');
});
