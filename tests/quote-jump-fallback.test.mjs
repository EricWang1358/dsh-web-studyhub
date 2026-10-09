/* The reader finds a citation the way the citation was checked. A citation passes verification by its letters and digits only (lib/quote-match.js);
   the reader used to search for it letter for letter (ui/document-preview/selection.js locateQuote) and, when that failed, showed no highlight and
   did not scroll. resolveQuote / fuzzyPassageRange are the second chance: the shared fuzzy locator (lib/quote-locate.js), whose answer is the text's
   own words. The real layout (highlight in view at 1280 and 420 px) is checked in tests/quote-jump-browser.test.mjs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyPassageRange, isPlaced, locateFuzzy, locateQuote, renderedPassageRange, resolveQuote } from '../ui/document-preview/selection.js';
import { citationCheck } from '../lib/quote-match.js';

const literal = (text, hit) => text.slice(hit.start, hit.end);

test('a quote that is in the text as written is found as before, never fuzzily', () => {
  const text = 'A B-tree keeps keys sorted. A hash index does not.';
  assert.deepEqual(resolveQuote(text, 'hash index does not'), { status: 'resolved', start: 30, end: 49 });
  assert.equal(resolveQuote(text, 'hash index does not').status, locateQuote(text, 'hash index does not').status);
});

test('hyphenation, full and half width and markup differ from the stored text but resolve to the literal range', () => {
  const cases = [
    ['hyphenation', 'The B-tree index re-\nduces the number of disk reads. It is used widely.', 'reduces the number of disk reads', 're-\nduces the number of disk reads'],
    ['full width', 'Ｔ Ｃ Ｐ　ｈａｎｄｓｈａｋｅ uses three steps to open a link.', 'TCP handshake uses three steps', 'Ｔ Ｃ Ｐ　ｈａｎｄｓｈａｋｅ uses three steps'],
    ['markup', 'You can use **hash** `index` to speed up lookups on keys.', 'use hash index to speed up lookups', 'use **hash** `index` to speed up lookups'],
    ['typography', 'The “quick” brown fox—jumps over the lazy dog.', 'The "quick" brown fox - jumps over the lazy dog', 'The “quick” brown fox—jumps over the lazy dog'],
    ['CJK punctuation', '微服务把系统拆成各自拥有数据的服务（每个服务一个库）。', '微服务把系统拆成各自拥有数据的服务(每个服务一个库)', '微服务把系统拆成各自拥有数据的服务（每个服务一个库'],
  ];
  for (const [name, text, quote, expected] of cases) {
    assert.equal(locateQuote(text, quote).status, 'missing', `${name}: the strict search misses it`);
    assert.equal(citationCheck([{ id: 's1', text }], { sourceId: 's1', quote }).ok, true, `${name}: verification accepts this citation`);
    const hit = resolveQuote(text, quote);
    assert.equal(hit.status, 'fuzzy', name);
    assert.equal(literal(text, hit), expected, `${name}: the text's own words between the offsets`);
    assert.equal(hit.quote, expected, `${name}: ... which is what the reader takes as the quote`);
  }
});

test('an elided quote resolves from its first part to its last part', () => {
  const text = 'Replication copies data. It keeps copies in step. Lag appears when a follower is slow. Reads may be stale.';
  const hit = resolveQuote(text, 'Replication copies data … reads may be stale');
  assert.equal(hit.status, 'fuzzy');
  assert.equal(literal(text, hit), text.slice(0, text.length - 1), 'from the first word of the first part to the last word of the last');
});

test('a quote in two places is ambiguous (never silently the first); one in none, or too short to prove anything, is missing', () => {
  const twice = 'Use the B-tree index here. Elsewhere: use the b tree index again.';
  assert.equal(resolveQuote(twice, 'use the btree index').status, 'ambiguous');
  assert.equal(resolveQuote('Totally different words in this text.', 'a citation the model made up').status, 'missing');
  assert.equal(resolveQuote('The index is here.', 'ab').status, 'missing', 'two letters prove nothing');
  assert.equal(resolveQuote('', 'something quoted').status, 'missing');
  assert.equal(resolveQuote('anything at all', '').status, 'missing');
  assert.equal(locateFuzzy('Totally different words', 'a citation the model made up').status, 'missing');
});

test('the strict answers stay: ambiguous and stale are not turned into a fuzzy hit', () => {
  assert.equal(resolveQuote('same passage; same passage', 'same passage').status, 'ambiguous');
  assert.equal(resolveQuote('new prefix; same passage', 'same passage', { start: 0 }).status, 'stale');
  assert.deepEqual(resolveQuote('same passage; same passage', 'same passage', { start: 14 }), { status: 'resolved', start: 14, end: 26 });
});

test('a paged document is resolved in the page that carries the citation, and only there', () => {
  const pages = [{ id: 'p1', text: 'Page one talks about hash tables and their load factor.' }, { id: 'p2', text: 'Page two: the B-\ntree keeps its keys in sorted order on disk.' }];
  const quote = 'the Btree keeps its keys in sorted order';
  const own = pages.find(page => page.id === 'p2');
  assert.equal(resolveQuote(own.text, quote).status, 'fuzzy');
  assert.equal(literal(own.text, resolveQuote(own.text, quote)), 'the B-\ntree keeps its keys in sorted order');
  assert.equal(resolveQuote(pages[0].text, quote).status, 'missing', 'the same quote is not on the other page: nothing is highlighted there');
});

test('only a quote with a place takes the scroll from the page', () => {
  assert.equal(isPlaced('resolved'), true);
  assert.equal(isPlaced('fuzzy'), true);
  for (const status of ['missing', 'ambiguous', 'stale', undefined]) assert.equal(isPlaced(status), false);
});

/* ---------- the drawn text: a fake DOM of text nodes (the real one is in the browser test) ---------- */

/** Text nodes in a row; `translation` lists the ones inside a translation block (data-tr-key), `marks` the ones inside a reader mark. */
function fakeDom(texts, { translation = [], marks = [] } = {}) {
  const nodes = texts.map((text, index) => ({ nodeType: 3, textContent: text, data: text, parentElement: {
    closest: selector => (/data-tr-key|data-study-marker/.test(selector) && (translation.includes(index) || marks.includes(index)) ? {} : null) } }));
  const range = () => { const state = {}; state.setStart = (node, offset) => { state.startContainer = node; state.startOffset = offset; };
    state.setEnd = (node, offset) => { state.endContainer = node; state.endOffset = offset; }; return state; };
  const walker = () => { let at = 0; return { nextNode: () => nodes[at++] ?? null }; };
  return { nodes, container: { querySelectorAll: () => [], ownerDocument: { createTreeWalker: walker, createRange: range } } };
}

test('the drawn text is searched by letters and digits, and the range covers the text own words', () => {
  const dom = fakeDom(['An index is a ', 'sorted struc-', 'ture on disk.']);
  const found = fuzzyPassageRange(dom.container, { sourceId: 's1', quote: 'a sorted structure on disk' });
  assert.equal(found.status, 'fuzzy');
  assert.equal(found.quote, 'a sorted struc-ture on disk');
  assert.equal(found.range.startContainer, dom.nodes[0]); assert.equal(found.range.startOffset, 'An index is '.length);
  assert.equal(found.range.endContainer, dom.nodes[2]); assert.equal(found.range.endOffset, 'ture on disk'.length);
});

test('a translation block next to the original is not searched: only the original language matches', () => {
  const dom = fakeDom(['The packet is retransmitted after a timeout.', 'La retransmission du paquet apres un delai. The packet is retransmitted after a timeout.'], { translation: [1] });
  const found = fuzzyPassageRange(dom.container, { sourceId: 's1', quote: 'the packet is retransmitted after a time-out' });
  assert.equal(found.status, 'fuzzy', 'one hit: the copy inside the translation block is not a second place');
  assert.equal(found.range.startContainer, dom.nodes[0]);
  const onlyTranslated = fakeDom(['Intro.', 'Le paquet est retransmis apres un delai.'], { translation: [1] });
  assert.equal(fuzzyPassageRange(onlyTranslated.container, { sourceId: 's1', quote: 'Le paquet est retransmis apres un delai' }).status, 'missing');
  assert.equal(renderedPassageRange(onlyTranslated.container, { sourceId: 's1', quote: 'Le paquet est retransmis apres un delai' }), null);
});

test('the drawn text with the quote in two places is ambiguous; nothing drawn is missing', () => {
  const dom = fakeDom(['Use the B-tree index. ', 'Later: use the b tree index again.']);
  assert.equal(fuzzyPassageRange(dom.container, { sourceId: 's1', quote: 'use the btree index' }).status, 'ambiguous');
  assert.equal(fuzzyPassageRange(null, { sourceId: 's1', quote: 'use the btree index' }).status, 'missing');
  assert.equal(fuzzyPassageRange(fakeDom([]).container, { sourceId: 's1', quote: 'use the btree index' }).status, 'missing');
});
