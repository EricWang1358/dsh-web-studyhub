import test from 'node:test';
import assert from 'node:assert/strict';
import { ANNOTATION_LIMITS, checkThread, normalizeNode, passageKey, sameNode, viewOf } from '../lib/annotation.js';
import { ANNOTATION_MODE_KEY, annotationLinks, itemsOfPassage, keyOfSelection, loadAnnotationMode, nodesToKeep, saveAnnotationMode, staleCount, threadFromItems } from '../ui/document-preview/annotation/model.js';
import { addNode, answerNode, emptyThread, failNode, MAX_DEPTH, MAX_NODES } from '../ui/document-preview/ask-thread.js';

/* The pure rules of annotations: nodes, threads, anchoring and stale handling, and the reader's side of them (the mode, the thread
   restored from kept items, what is kept, the marks). */

const node = (id, extra = {}) => ({ id, parentId: null, question: `Q ${id}`, answer: `A ${id}`, ...extra });

test('the limits are the ones the panel asks within', () => {
  assert.deepEqual([ANNOTATION_LIMITS.items, ANNOTATION_LIMITS.thread, ANNOTATION_LIMITS.depth], [200, 8, 3]);
  assert.equal(MAX_NODES, ANNOTATION_LIMITS.thread); assert.equal(MAX_DEPTH, ANNOTATION_LIMITS.depth);
});

test('a node is checked and cut to size', () => {
  assert.deepEqual(normalizeNode({ id: 'n-1_a', question: ' Why? ', answer: 'Because', term: '  E  L  K ', label: 'x'.repeat(100), language: 'English', ignored: 1 }),
    { id: 'n-1_a', parentId: null, question: 'Why?', term: 'E L K', label: 'x'.repeat(ANNOTATION_LIMITS.label), answer: 'Because', language: 'English' });
  assert.equal(normalizeNode({ id: 'a', question: 'q', answer: 'z'.repeat(ANNOTATION_LIMITS.answer + 10) }).answer.length, ANNOTATION_LIMITS.answer);
  for (const [input, error] of [[null, /node is required/], [{ id: 'a b', question: 'q', answer: 'a' }, /id must be/], [{ id: 'a', parentId: 'x y', question: 'q', answer: 'a' }, /parent id/],
    [{ id: 'a', question: ' ', answer: 'a' }, /question/], [{ id: 'a', question: 'q', answer: '' }, /answer/], [{ id: '', question: 'q', answer: 'a' }, /id must be/]]) assert.throws(() => normalizeNode(input), error);
});

test('a thread: parents come first, three levels, eight nodes, no loops', () => {
  const ok = checkThread([], [node('c', { parentId: 'b' }), node('b', { parentId: 'a' }), node('a')]);
  assert.equal(ok.ok, true); assert.deepEqual(ok.nodes.map(item => item.id), ['a', 'b', 'c']);
  assert.equal(checkThread([node('a')], [node('b', { parentId: 'a' })]).ok, true, 'the parent may be kept already');
  assert.equal(checkThread([], [node('b', { parentId: 'a' })]).code, 'parent');
  assert.equal(checkThread([], [node('a', { parentId: 'b' }), node('b', { parentId: 'a' })]).code, 'cycle');
  assert.equal(checkThread([], [node('a'), node('b', { parentId: 'a' }), node('c', { parentId: 'b' }), node('d', { parentId: 'c' })]).code, 'depth');
  const kept = Array.from({ length: 8 }, (_, i) => node(`k${i}`));
  assert.equal(checkThread(kept, [node('k3')]).ok, true, 'an answer that is kept already needs no room');
  assert.equal(checkThread(kept, [node('extra')]).code, 'thread-full');
});

test('the same node is the same: nothing to write', () => {
  assert.equal(sameNode({ ...node('a'), term: 'ELK' }, { ...node('a'), term: 'ELK' }), true);
  assert.equal(sameNode(node('a'), { ...node('a'), answer: 'other' }), false);
  assert.equal(sameNode(node('a'), { ...node('a'), parentId: 'x' }), false);
  assert.equal(passageKey({ sourceId: 's', start: 3, end: 9 }), 's|3|9');
});

test('a kept item says whether its passage is still where it was', () => {
  const item = { id: 'a', key: 's|1|5', sourceId: 's', start: 1, end: 5, hash: 'h', quote: 'text', prefix: 'p', suffix: 's', parentId: null, question: 'q', answer: 'a', at: 't', updatedAt: 'u' };
  assert.equal(viewOf(item, true).status, 'resolved'); assert.equal(viewOf(item, false).status, 'stale');
  assert.deepEqual(viewOf(item, true).selection, { sourceId: 's', start: 1, end: 5, quote: 'text', prefix: 'p', suffix: 's' });
});

const store = (initial = null) => { const map = new Map(initial ? [[ANNOTATION_MODE_KEY, initial]] : []); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, value); }, map }; };

test('the mode is read by default and remembered; a blocked or odd store never breaks the page', () => {
  assert.equal(loadAnnotationMode(store()), 'read');
  const kept = store(); saveAnnotationMode('annotate', kept);
  assert.equal(loadAnnotationMode(kept), 'annotate');
  for (const odd of ['{', '"annotate"', JSON.stringify({ mode: 'draw' }), 'null', JSON.stringify({ mode: 7 })]) assert.equal(loadAnnotationMode(store(odd)), 'read', odd);
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(loadAnnotationMode(blocked), 'read'); assert.doesNotThrow(() => saveAnnotationMode('annotate', blocked));
  saveAnnotationMode('nonsense', kept); assert.equal(loadAnnotationMode(kept), 'read');
  assert.equal(loadAnnotationMode(null), 'read');
});

const selection = { sourceId: 's1', start: 10, end: 30, quote: 'the passage', prefix: 'a ', suffix: ' b' };
const item = (id, parentId, extra = {}) => ({ id, key: keyOfSelection(selection), parentId, question: `Q ${id}`, answer: `A ${id}`, status: 'resolved', selection, ...extra });

test('a kept thread comes back as the panel\'s thread, parents first, every node answered', () => {
  const items = [item('c', 'b'), item('b', 'a', { term: 'ELK' }), item('a', null, { label: 'I did not get it', language: 'English' }), item('z', null, { key: 'other|1|2' })];
  const mine = itemsOfPassage(items, selection);
  assert.deepEqual(mine.map(entry => entry.id), ['a', 'b', 'c']);
  const thread = threadFromItems(mine);
  assert.deepEqual(thread.nodes.map(entry => [entry.id, entry.parentId, entry.status, entry.term, entry.label]), [['a', null, 'answered', '', 'I did not get it'], ['b', 'a', 'answered', 'ELK', ''], ['c', 'b', 'answered', '', '']]);
  assert.deepEqual(itemsOfPassage(items, { sourceId: 's1' }), [], 'a selection with no offsets has no kept thread');
  assert.deepEqual(itemsOfPassage([item('s', null, { status: 'stale' })], selection), [], 'a passage that moved is not applied');
});

test('what is kept: the answered nodes, parents first, with the nodes above one answer when only it is asked for', () => {
  let thread = answerNode(addNode(emptyThread(), { id: 'a', parentId: null, question: 'q', label: 'Why' }), 'a', 'A [[ELK]]');
  thread = answerNode(addNode(thread, { id: 'b', parentId: 'a', question: 'q2', term: 'ELK' }), 'b', 'B');
  thread = failNode(addNode(thread, { id: 'c', parentId: 'a', question: 'q3' }), 'c', 'offline');
  thread = answerNode(addNode(thread, { id: 'd', parentId: 'a', question: 'q4' }), 'd', 'D');
  assert.deepEqual(nodesToKeep(thread).map(entry => entry.id), ['a', 'b', 'd'], 'the failed one is not kept');
  assert.deepEqual(nodesToKeep(thread, 'b').map(entry => entry.id), ['a', 'b']);
  assert.deepEqual(nodesToKeep(thread)[0], { id: 'a', parentId: null, question: 'q', label: 'Why', answer: 'A [[ELK]]' }, 'the answer is kept as it was written, markers and all');
  assert.deepEqual(nodesToKeep(emptyThread()), []);
});

test('the marks: one link per annotated passage, shaped like the links of questions', () => {
  const items = [item('a', null, { label: 'Why' }), item('b', 'a'), item('s', null, { key: 'old|1|2', selection: { sourceId: 'old', start: 1, end: 2, quote: 'x' }, status: 'stale' }),
    item('o', null, { key: 'other|1|9', selection: { sourceId: 'other', start: 1, end: 9, quote: 'another passage' } })];
  const links = annotationLinks(items);
  assert.equal(links.length, 2, 'a passage that moved is not marked');
  assert.deepEqual(links.map(link => [link.kind, link.status, link.nodes, link.prompt]), [['annotation', 'resolved', 2, 'Why'], ['annotation', 'resolved', 1, 'Q o']]);
  assert.deepEqual(links[0].selection, selection);
  assert.equal(links[0].cardId, `annotation:${keyOfSelection(selection)}`);
  assert.deepEqual(annotationLinks(undefined), []);
  assert.equal(staleCount([{ count: 2 }, { count: 3 }]), 5); assert.equal(staleCount(undefined), 0);
});
