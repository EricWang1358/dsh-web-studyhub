/* #486: a quote that is not on the page it cites used to say only "quote-not-found", which left a writer guessing between very different
   faults. The check now carries a diagnosis: the quote and its letters-and-digits key, the closest passage of the cited page (sourceId, page,
   offsets, its own words and key, how much it shares), the first character that differs, and a kind — 'absent' (the material has no such
   passage), 'near-miss' (it has it with a few characters different), 'across-page' (the page break cuts it in two: the citing page holds one
   part, the neighbouring page the rest) or 'other-page' (the quote is verbatim on another page). The comparison is the same one the check
   makes (lib/quote-match.js: letters and digits only, NFKC and lower case, markup and footnote marks out): normalisation is for matching, so
   no stored text is ever rewritten, and the scan stops at the cited page and its two neighbours. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { citationCheck, citationProblems, quoteDiagnosis } from '../lib/quote-match.js';

const page = (id, text, number) => ({ id, title: id, text, ...(Number.isInteger(number) ? { document: { page: number } } : {}) });
/** One plain sentence: no second sentence, no line break, nothing of the fields stuffed in. */
const oneSentence = (say) => assert.match(say, /^[^.?!\n]+\.$/u, say);
const key = (value) => assert.match(value, /^[\p{L}\p{N}\p{M}]+$/u, value);

const CN = '老师在第一讲里强调：“架构师要把每个决定和背后的理由都写下来”，这样以后的人才知道系统为什么是现在这个样子。';
const WORDS = '架构师要把每个决定和背后的理由都写下来';

/* ---------- a quote that is found needs no diagnosis ---------- */

test('an exact quote, a quote with a trailing [^n], and Chinese quotation-mark variants are found: no diagnosis is carried', () => {
  const sources = [page('p1', CN, 2)];
  for (const quote of [WORDS, `「${WORDS}」[^12]`, `“${WORDS}”[^3]`, `"${WORDS}"[^3]`, `「${WORDS}[^7]」`])
    assert.deepEqual(citationCheck(sources, { sourceId: 'p1', quote }), { ok: true, span: 'page' }, quote);
  const exact = citationCheck([page('p2', 'An architectural style is a named collection of design decisions that recur.')],
    { sourceId: 'p2', quote: 'a named collection of design decisions' });
  assert.deepEqual(exact, { ok: true, span: 'page' });
  assert.equal('diagnosis' in exact, false, 'a found quote carries nothing to diagnose');
});

/* ---------- present, a few characters apart ---------- */

test('a passage that differs by a few characters says how many, where the first one is, and which passage is meant', () => {
  const TEXT = 'The p99 latency target is 200 ms for every request, and a slow query is cut off at 500 ms.';
  const check = citationCheck([page('p1', TEXT, 12)], { sourceId: 'p1', quote: 'The p95 latency target is 300 ms for every request' });
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'quote-not-found');
  const { diagnosis: d } = check;
  assert.equal(d.kind, 'near-miss');
  assert.equal(d.sourceId, 'p1');
  assert.equal(d.page, 12);
  assert.equal(d.quote, 'The p95 latency target is 300 ms for every request', 'the requested words, as asked');
  assert.equal(d.key, 'thep95latencytargetis300msforeveryrequest', 'and their normalised key');
  key(d.key);
  // The closest passage of the page, with its own words and its own key over the same window.
  assert.equal(d.candidate.sourceId, 'p1');
  assert.equal(d.candidate.page, 12);
  assert.equal(d.candidate.key, 'thep99latencytargetis200msforeveryrequest');
  assert.equal(TEXT.slice(d.candidate.start, d.candidate.end), 'The p99 latency target is 200 ms for every request');
  assert.match(d.candidate.quote, /^The p99 latency target is 200 ms for every request/);
  assert.equal(d.candidate.different, 2, 'the two changed numbers');
  assert.ok(d.candidate.shared > 0 && d.candidate.shared < d.key.length);
  assert.ok(d.candidate.similarity > 0.9 && d.candidate.similarity <= 1, String(d.candidate.similarity));
  assert.deepEqual(d.candidate.difference, { index: 5, asked: '5', found: '9' }, 'the 5 of p95 against the 9 of p99');
  oneSentence(d.message);
  assert.match(d.message, /2 of its 41 letters and digits different, the first at index 5/);
});

test('a Chinese quote whose words differ says where they differ, and the footnote mark is not part of either key', () => {
  const check = citationCheck([page('p1', CN, 3)], { sourceId: 'p1', quote: `「${WORDS.replace('理由', '原因')}」[^12]` });
  const { diagnosis: d } = check;
  assert.equal(d.kind, 'near-miss');
  assert.equal(d.key, WORDS.replace('理由', '原因'), 'quotation marks and the mark after them are not wording');
  assert.equal(d.candidate.key, WORDS);
  assert.deepEqual(d.candidate.difference, { index: 13, asked: '原', found: '理' });
  oneSentence(d.message);
});

/* ---------- present, but the page break cuts it ---------- */

test('a passage the page break cuts in two is reported as such, with the page the rest begins on', () => {
  const sources = [page('p1', '…the layered style. A layer may only call the layer', 4),
    page('p2', '42\n\nCHAPTER 2 · DESIGN\ndirectly below it. This keeps coupling low across the system.', 5)];
  const quote = 'A layer may only call the layer directly below it.';
  const check = citationCheck(sources, { sourceId: 'p1', quote });
  assert.equal(check.ok, false, 'the running header of the next page keeps the joined pages from holding it');
  const { diagnosis: d } = check;
  assert.equal(d.kind, 'across-page');
  assert.equal(d.continuedOn, 'p2');
  assert.equal(d.continuedFrom, undefined);
  assert.equal(d.candidate.sourceId, 'p1');
  assert.equal(sources[0].text.slice(d.candidate.start, d.candidate.end), 'A layer may only call the layer', 'this page holds the beginning');
  assert.deepEqual(d.candidate.difference, { index: 25, asked: 'd', found: null }, 'the page stops at the page break');
  oneSentence(d.message);
  assert.match(d.message, /p2/);
});

test('the previous page may hold the beginning: continuedFrom, with this page\'s own part of the passage', () => {
  const sources = [page('p1', '…so the layer above may only call the layer', 4),
    page('p2', '43\n\nCHAPTER 2 · DESIGN\nbelow it, and never the other way around.', 5)];
  const check = citationCheck(sources, { sourceId: 'p2', quote: 'the layer above may only call the layer below it' });
  const { diagnosis: d } = check;
  assert.equal(d.kind, 'across-page');
  assert.equal(d.continuedFrom, 'p1');
  assert.equal(d.continuedOn, undefined);
  assert.equal(d.candidate.key, 'belowit', 'only the part this page holds');
  assert.equal(sources[1].text.slice(d.candidate.start, d.candidate.end), 'below it');
  oneSentence(d.message);
});

/* ---------- not in the material ---------- */

test('a quote the material does not hold says so, and shows the nearest passage only when it is close', () => {
  const check = citationCheck([page('p1', 'The service must survive a dependency outage without losing requests.', 7)],
    { sourceId: 'p1', quote: 'Every dependency outage teaches a team something about resilience and about patience' });
  const { diagnosis: d } = check;
  assert.equal(d.kind, 'absent');
  assert.ok(d.candidate, 'even here the closest passage is worth showing');
  assert.equal(d.candidate.shared, 16);
  assert.ok(d.candidate.similarity < 0.5, String(d.candidate.similarity));
  assert.match(d.message, /shares 16 of its 73 letters and digits/);
  oneSentence(d.message);
});

test('a quote that is verbatim on another page is named as such, not called invented', () => {
  const sources = [page('p1', '…the layered style. A layer may only call the layer', 4),
    page('p2', ' directly below it. This keeps coupling low across the system.', 5)];
  const check = citationCheck(sources, { sourceId: 'p1', quote: 'This keeps coupling low across the system.' });
  const { diagnosis: d } = check;
  assert.deepEqual(d.foundIn, ['p2']);
  assert.equal(d.kind, 'other-page');
  assert.equal(d.candidate.sourceId, 'p2');
  assert.equal(d.candidate.similarity, 1);
  oneSentence(d.message);
});

test('the scan stays on the cited page and its neighbours: a near miss eight pages away is not a candidate', () => {
  const book = Array.from({ length: 60 }, (_, i) => page(`b-p${i + 1}`, `Page ${i + 1} explains tactic number ${i + 1} and how it keeps the quality attribute within budget.`, i + 1));
  book[28] = page('b-p29', 'Caching reduces the load on the database for hot keys.', 29);
  book[29] = page('b-p30', 'Queues and buffers smooth a burst of writes before the storage tier sees them.', 30);
  book[30] = page('b-p31', 'Retries with jitter avoid synchronised thundering herds.', 31);
  book[55] = page('b-p56', 'Page 56 explains tactic number 56 and how it keeps the quality attribute within budget.', 56);
  const check = citationCheck(book, { sourceId: 'b-p30', quote: 'Page 56 explains tactic number 57 and how it keeps the quality attribute within budget' });
  assert.equal(check.diagnosis.kind, 'absent');
  assert.ok(!check.diagnosis.candidate || check.diagnosis.candidate.sourceId !== 'b-p56', 'only the page and its neighbours are read');
  oneSentence(check.diagnosis.message);
});

/* ---------- a converted page: the passage in its own words and place ---------- */

test('a page with markup and entities shows the passage as a reader sees it, with offsets into the stored text', () => {
  const TEXT = '<table><tr><td>Latency</td><td>Time to respond</td></tr></table>\n\nThe p99 latency target is 200 ms &amp; every request is queued.';
  const check = citationCheck([page('p1', TEXT, 3)], { sourceId: 'p1', quote: 'The p95 latency target is 200 ms & every request is queued' });
  const { diagnosis: d } = check;
  assert.equal(d.kind, 'near-miss');
  assert.equal(d.candidate.key, 'thep99latencytargetis200mseveryrequestisqueued', 'the entity is decoded for the comparison');
  assert.deepEqual(d.candidate.difference, { index: 5, asked: '5', found: '9' });
  assert.equal(TEXT.slice(d.candidate.start, d.candidate.end), 'The p99 latency target is 200 ms &amp; every request is queued', 'offsets into the stored text');
  assert.equal(d.candidate.quote, 'Latency Time to respond The p99 latency target is 200 ms & every request is queued.', 'the passage reads as a reader sees it');
  oneSentence(d.message);
});

/* ---------- the same answer for every caller, and nothing rewritten ---------- */

test('quoteDiagnosis answers for a caller that has only the pages and the citation, and citationProblems carries it', () => {
  const sources = [page('p1', 'Caching reduces the load on the database for hot keys.', 1)];
  const ref = { sourceId: 'p1', quote: 'Caching reduces the load on the application server' };
  const check = citationCheck(sources, ref);
  assert.deepEqual(quoteDiagnosis(sources, ref), check.diagnosis);
  assert.equal(quoteDiagnosis(sources, { sourceId: 'p9', quote: ref.quote }), null, 'an unknown page has nothing to diagnose');
  const [problem] = citationProblems({ citations: [ref] }, sources);
  assert.equal(problem.reason, 'quote-not-found');
  assert.deepEqual(problem.diagnosis, check.diagnosis);
  oneSentence(problem.diagnosis.message);
});

test('normalisation is for matching only: the stored text is compared as it is and never rewritten', () => {
  const sources = [page('p1', 'Original **words** stay exactly as they are stored, [^3] marks included.', 1)];
  const before = structuredClone(sources);
  citationCheck(sources, { sourceId: 'p1', quote: 'Original words do not stay exactly as they are stored' });
  assert.deepEqual(sources, before);
});
