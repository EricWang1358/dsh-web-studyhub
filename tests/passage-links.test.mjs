/* Link underlines in the source reader: which passages are underlined (the model), where they are in the
   rendered text (ranges, computed once), how they are painted and hit. The DOM here is a minimal fake in the
   style of tests/reader.test.mjs; the real layout is checked in the browser preview. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupPassageLinks } from '../ui/document-preview/selection.js';
import { buildLinkModel, groupKey, linkKind, groupTitle } from '../ui/document-preview/links/link-model.js';
import { locateGroups, paintLinkHighlights, hitTest, overText, HIGHLIGHT_NAMES } from '../ui/document-preview/links/link-ranges.js';

const sel = (quote, extra = {}) => ({ documentId: 'doc', revision: 'r1', sourceId: 's1', quote, prefix: '', suffix: '', start: 0, end: quote.length, ...extra });
const link = (cardId, selection, extra = {}) => ({ deckId: 'd1', deckTitle: 'Deck one', cardId, prompt: `Prompt ${cardId}`, answer: 'A', selection, status: 'resolved', kind: 'quiz', followups: [], ...extra });

/* ---------- the model ---------- */

test('a link is a question, or a Q&A card when it was saved from an answer about the passage', () => {
  assert.equal(linkKind({ kind: 'flashcard' }), 'question');
  assert.equal(linkKind({ kind: 'flashcard', sourceQa: true }), 'qa');
  assert.equal(linkKind({}), 'question');
});

test('resolved passages are underlined; stale, missing and ambiguous ones are listed to be selected again, with the reason', () => {
  const a = sel('first passage here', { start: 10 }), b = sel('second passage here', { start: 50 }), c = sel('third passage here', { start: 90 }), d = sel('fourth passage here', { start: 130 });
  const groups = groupPassageLinks([link('q1', a), link('q2', b, { status: 'stale' }), link('q3', c, { status: 'missing' }), link('q4', d, { status: 'ambiguous' })]);
  const model = buildLinkModel(groups);
  assert.deepEqual(model.groups.map(group => group.selection.quote), ['first passage here']);
  assert.deepEqual(model.stale.map(group => [group.selection.quote, group.reason]), [['second passage here', 'stale'], ['third passage here', 'missing'], ['fourth passage here', 'ambiguous']]);
  assert.deepEqual(model.groups.concat(model.stale).map(group => group.number), [1, 2, 3, 4], 'the [n] numbers stay those of the full list');
  assert.equal(new Set(model.groups.concat(model.stale).map(group => group.key)).size, 4);
});

test('one passage with a question and a Q&A card is one underline, looks like a question and counts both', () => {
  const s = sel('shared passage text');
  const model = buildLinkModel(groupPassageLinks([link('q1', s), link('qa1', s, { kind: 'flashcard', sourceQa: true, followups: [{ id: 'f1', question: 'Why?', answer: 'Because.' }] })]));
  assert.equal(model.groups.length, 1);
  const [group] = model.groups;
  assert.equal(group.kind, 'question');
  assert.deepEqual(group.counts, { question: 1, qa: 1 });
  assert.equal(group.followups, 1);
  assert.equal(buildLinkModel(groupPassageLinks([link('qa1', s, { sourceQa: true })])).groups[0].kind, 'qa');
});

test('notes written from the linked cards belong to the passage, once each, newest information from the snapshot', () => {
  const s = sel('noted passage text');
  const badges = { q1: [{ noteId: 'n1', title: 'My note', status: 'draft', url: null }], q2: [{ noteId: 'n1', title: 'My note', status: 'draft', url: null }, { noteId: 'n2', title: 'Published', status: 'published', url: 'https://example.com/a' }] };
  const model = buildLinkModel(groupPassageLinks([link('q1', s), link('q2', s), link('q3', s)]), { noteBadges: badges });
  assert.deepEqual(model.groups[0].notes.map(note => note.noteId), ['n1', 'n2']);
  assert.deepEqual(buildLinkModel(groupPassageLinks([link('q1', s)])).groups[0].notes, []);
});

test('groupKey is stable for the same passage and differs between passages', () => {
  assert.equal(groupKey(sel('same words here')), groupKey(sel('same words here')));
  assert.notEqual(groupKey(sel('same words here')), groupKey(sel('same words here', { start: 5 })));
});

test('the tooltip says what is linked in plain words and needs no legend', () => {
  const t = { questions: n => `${n} questions`, qa: n => `${n} Q&A`, notes: n => `${n} notes` };
  assert.equal(groupTitle({ counts: { question: 2, qa: 1 }, notes: [{}] }, t), '2 questions · 1 Q&A · 1 notes');
  assert.equal(groupTitle({ counts: { question: 0, qa: 1 }, notes: [] }, t), '1 Q&A');
});

/* ---------- where the passages are in the rendered text ---------- */

/** One text node per string; a node in `skip` sits inside a passage mark. A fake DOM with a counting tree walker. */
function fakeDom(shape) {
  const stats = { walks: 0 };
  const make = texts => texts.map((text, index) => ({ textContent: text, parentElement: { closest: () => (texts.skip?.includes(index) ? {} : null) } }));
  const roots = Array.isArray(shape) ? { '': shape } : shape;
  const pages = Object.entries(roots).map(([id, texts]) => ({ dataset: { studySource: id }, nodes: make(texts) }));
  const all = Array.isArray(shape) ? { nodes: pages[0].nodes } : null;
  const ownerDocument = {
    createTreeWalker(root) { stats.walks++; const nodes = (root.nodes || []); let at = 0; return { nextNode: () => nodes[at++] ?? null }; },
    createRange() {
      const range = { setStart(node, offset) { range.start = [node, offset]; }, setEnd(node, offset) { range.end = [node, offset]; }, cloneRange: () => ({ ...range }) };
      return range;
    },
  };
  const container = Array.isArray(shape)
    ? { ownerDocument, nodes: all.nodes, querySelectorAll: () => [] }
    : { ownerDocument, nodes: [], querySelectorAll: () => pages };
  return { container, stats, nodesOf: id => (Array.isArray(shape) ? all.nodes : pages.find(page => page.dataset.studySource === id).nodes) };
}
const at = (dom, range, id = '') => [dom.nodesOf(id).indexOf(range.start[0]), range.start[1], dom.nodesOf(id).indexOf(range.end[0]), range.end[1]];
const group = (selection, extra = {}) => ({ key: groupKey(selection), selection, kind: 'question', ...extra });

test('a passage is found in the rendered text, also across text nodes, using the stored context', () => {
  const dom = fakeDom(['Heading', 'Alpha beta ', 'gamma delta.']);
  const [entry] = locateGroups(dom.container, [group(sel('beta gamma', { prefix: 'Alpha ', suffix: ' delta.' }))]);
  assert.deepEqual(at(dom, entry.range), [1, 6, 2, 5]);
});

test('context that only exists in the source (Markdown marks) does not hide a passage that is unique in the rendered text', () => {
  const dom = fakeDom(['Notes', 'Indexes keep rows findable without scanning.']);
  const entries = locateGroups(dom.container, [group(sel('without scanning', { prefix: '# Notes\n\nIndexes keep rows findable ', suffix: '.\n\n' }))]);
  assert.equal(entries.length, 1);
});

test('a repeated passage is picked by the best matching context, and stays unlinked when nothing decides', () => {
  const dom = fakeDom(['Part one repeated phrase here. Part two repeated phrase there.']);
  const second = locateGroups(dom.container, [group(sel('repeated phrase', { prefix: '## Part two ', suffix: ' there.' }))]);
  assert.equal(second.length, 1);
  assert.equal(second[0].range.start[1], 'Part one repeated phrase here. Part two '.length);
  assert.deepEqual(locateGroups(dom.container, [group(sel('repeated phrase'))]), [], 'a bare repeated quote is never silently placed at its first occurrence');
  assert.deepEqual(locateGroups(dom.container, [group(sel('text that is not there at all'))]), []);
});

test('text inside passage marks is not part of the passage text', () => {
  const texts = ['The index ', '[1]', 'speeds lookups.']; texts.skip = [1];
  const dom = fakeDom(texts);
  const [entry] = locateGroups(dom.container, [group(sel('index speeds lookups', { prefix: '', suffix: '' }))]);
  assert.deepEqual(at(dom, entry.range), [0, 4, 2, 14]);
});

test('on a paged document a passage is only looked for on its own page, and every page is read once', () => {
  const dom = fakeDom({ p1: ['Same sentence on both pages.'], p2: ['Same sentence on both pages.'] });
  const entries = locateGroups(dom.container, [
    group(sel('Same sentence on both pages', { sourceId: 'p1' })), group(sel('Same sentence on both pages', { sourceId: 'p2', start: 1 })),
    group(sel('both pages', { sourceId: 'p2', start: 14 })), group(sel('Same sentence', { sourceId: 'p1', start: 3 }))]);
  assert.equal(entries.length, 4);
  assert.equal(dom.nodesOf('p2').includes(entries[1].range.start[0]), true);
  assert.equal(dom.nodesOf('p1').includes(entries[0].range.start[0]), true);
  assert.equal(dom.stats.walks, 2, 'one walk per page, not one per link');
});

test('hundreds of links in a long document are located in one pass and well under a second', () => {
  const texts = Array.from({ length: 600 }, (_, index) => `Paragraph ${index} opens a long stretch of ordinary words to read. `.repeat(2) + `Unique-claim-${index} is the point of this paragraph. ` + 'Followed by filler words to make it long. '.repeat(3));
  const dom = fakeDom(texts);
  assert.ok(texts.join('').length > 150000);
  const groups = Array.from({ length: 400 }, (_, index) => group(sel(`Unique-claim-${index * 1} is the point of this paragraph`, { start: index })));
  const started = performance.now();
  const entries = locateGroups(dom.container, groups);
  const elapsed = performance.now() - started;
  assert.equal(entries.length, 400);
  assert.equal(dom.stats.walks, 1);
  assert.ok(elapsed < 1000, `took ${Math.round(elapsed)} ms`);
});

/* ---------- painting and hitting ---------- */

function fakeHighlightEnv() {
  const registry = new Map();
  class Highlight { constructor(...ranges) { this.ranges = ranges; this.priority = 0; } }
  return { registry, Highlight };
}
const rangeFake = (name, contains = () => false) => ({ name, isPointInRange: contains });

test('every link kind has its own named highlight; overlapping passages share one and merge visually', () => {
  const env = fakeHighlightEnv();
  const a = rangeFake('a'), b = rangeFake('b'), c = rangeFake('c'), d = rangeFake('d');
  const clear = paintLinkHighlights([{ group: { kind: 'question' }, range: a }, { group: { kind: 'question' }, range: b }, { group: { kind: 'qa' }, range: c }, { group: { kind: 'note' }, range: d }], env);
  assert.deepEqual([...env.registry.keys()].sort(), Object.values(HIGHLIGHT_NAMES).sort());
  assert.deepEqual(env.registry.get(HIGHLIGHT_NAMES.question).ranges, [a, b], 'two overlapping ranges, one highlight');
  assert.ok(env.registry.get(HIGHLIGHT_NAMES.question).priority > env.registry.get(HIGHLIGHT_NAMES.qa).priority, 'a question wins over a Q&A card where they overlap');
  assert.ok(env.registry.get(HIGHLIGHT_NAMES.qa).priority > env.registry.get(HIGHLIGHT_NAMES.note).priority);
  clear();
  assert.equal(env.registry.size, 0, 'clearing leaves nothing painted');
});

test('only the kinds that are present are painted, and a re-paint replaces the old highlights', () => {
  const env = fakeHighlightEnv();
  paintLinkHighlights([{ group: { kind: 'qa' }, range: rangeFake('x') }], env);
  assert.deepEqual([...env.registry.keys()], [HIGHLIGHT_NAMES.qa]);
  paintLinkHighlights([{ group: { kind: 'question' }, range: rangeFake('y') }], env);
  assert.deepEqual([...env.registry.keys()], [HIGHLIGHT_NAMES.question], 'the Q&A highlight of the first paint is gone');
});

test('without the Custom Highlight API nothing happens and nothing throws', () => {
  assert.doesNotThrow(() => paintLinkHighlights([{ group: { kind: 'question' }, range: rangeFake('x') }], { registry: null, Highlight: null })());
  assert.doesNotThrow(() => paintLinkHighlights([], {})());
});

test('hit testing returns the passages under a point, the innermost (shortest) first', () => {
  const inside = [], outer = { group: { key: 'outer', selection: { quote: 'a long enclosing passage of text' } }, range: rangeFake('outer', () => true) };
  const inner = { group: { key: 'inner', selection: { quote: 'enclosing' } }, range: rangeFake('inner', () => true) };
  const elsewhere = { group: { key: 'else', selection: { quote: 'unrelated' } }, range: rangeFake('else', () => false) };
  inside.push(outer, inner, elsewhere);
  assert.deepEqual(hitTest(inside, {}, 3).map(entry => entry.group.key), ['inner', 'outer']);
  assert.deepEqual(hitTest(inside, null, 0), []);
  assert.deepEqual(hitTest([], {}, 0), []);
  const throwing = { group: { key: 't', selection: { quote: 'x' } }, range: { isPointInRange() { throw new Error('detached'); } } };
  assert.deepEqual(hitTest([throwing], {}, 0), [], 'a range whose text was replaced never breaks a click');
});

test('a click in blank space after a line that ends a passage is not a click on the passage', () => {
  const rects = [{ left: 10, right: 110, top: 20, bottom: 40 }, { left: 10, right: 60, top: 40, bottom: 60 }];
  const range = { getClientRects: () => rects };
  assert.equal(overText(range, 50, 30), true);
  assert.equal(overText(range, 50, 50), true, 'the second line of the passage');
  assert.equal(overText(range, 300, 30), false, 'blank space to the right of the first line');
  assert.equal(overText(range, 100, 50), false, 'beyond where the second line ends');
  assert.equal(overText(range, 109, 30.5), true);
  assert.equal(overText({}, 5, 5), true, 'without layout information the offset test stands');
  assert.equal(overText({ getClientRects: () => [] }, 5, 5), true);
});
