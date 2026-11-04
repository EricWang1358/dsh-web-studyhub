/* The 术语卡 as the book shows them (#710 S1, S2): numbered K001… in reading order each time the book is viewed (never stored), their relations made links;
   the glossary's A–Z with each card's other name, a by-chapter card index and a formula page, all made by the program; and a whole build with the fake model.
   Fakes only: no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardCode, withCardNumbers } from '../lib/course-book-card-numbers.js';
import { termIndexes } from '../lib/course-book-card-index.js';
import { bookLookup } from '../lib/course-book-lookup.js';
import { StudyService } from '../lib/service.js';
import { isCourseNotesSource } from '../lib/exam-point-list.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { bookModel } from './helpers/course-book-model.mjs';

const ID = n => `i${String(n).padStart(11, '0')}`;
const card = (n, name, extra = {}) => ({ item: ID(n), name, plain: `${name} plainly`, pitch: `${name} in one exam sentence.`, ...extra });
/** A book as course.book.open answers it: two chapters, three points; the cards on the points as stored. */
const bookOf = () => ({ status: 'ok', title: 'Book', language: 'zh', unplaced: { title: '未归位', text: '' },
  glossary: [{ term: 'Coupling', item: ID(2), gist: 'how much modules depend', kind: 'concept', hid: 'h3', material: 'L1', page: 4 },
    { term: 'Little’s law', item: ID(5), gist: 'L = λW', kind: 'formula', hid: 'h6', material: 'L2', page: 9 },
    { term: 'Architecture', item: ID(1), gist: 'the skeleton', kind: 'definition', hid: 'h3', material: 'L1', page: 2 },
    { term: 'Amdahl’s law', item: ID(6), gist: 'S = 1/((1-p)+p/s)', kind: 'formula', hid: 'h3', material: 'L1', page: 3 }],
  nodes: [
    { hid: 'h1', title: 'Basics', number: '1', depth: 1, leaf: false, children: [
      { hid: 'h3', title: 'What architecture is', number: '1.1', depth: 2, leaf: true, gen: '', mine: '', qa: '', children: [],
        cards: [card(1, 'Architecture', { alt: 'SA', relations: [{ kind: 'related', item: ID(2), name: 'Coupling' }, { kind: 'opposite', name: 'big ball of mud' }] }), card(2, 'Coupling')] }] },
    { hid: 'h2', title: 'Performance', number: '2', depth: 1, leaf: false, children: [
      { hid: 'h5', title: 'Nothing carded', number: '2.1', depth: 2, leaf: true, gen: '', mine: '', qa: '', children: [] },
      { hid: 'h6', title: 'Queues', number: '2.2', depth: 2, leaf: true, gen: '', mine: '', qa: '', children: [],
        cards: [card(4, 'Big Ball of Mud', { relations: [{ kind: 'parallel', item: ID(1), name: 'Architecture' }, { kind: 'part', name: 'Somewhere else' }] })] }] }] });

test('cards are numbered K001… in reading order when the book is viewed, and relations to a carded item or name become links', () => {
  assert.equal(cardCode(7), 'K007');
  const nodes = withCardNumbers(bookOf().nodes);
  const shown = nodes.flatMap(node => node.children).flatMap(point => point.cards || []);
  assert.deepEqual(shown.map(each => [each.code, each.name, each.hid]), [['K001', 'Architecture', 'h3'], ['K002', 'Coupling', 'h3'], ['K003', 'Big Ball of Mud', 'h6']]);
  assert.deepEqual(shown[0].relations, [{ kind: 'related', item: ID(2), name: 'Coupling', code: 'K002', hid: 'h3' },
    { kind: 'opposite', name: 'big ball of mud', code: 'K003', hid: 'h6' }], 'by item, else by name (case aside)');
  assert.deepEqual(shown[2].relations, [{ kind: 'parallel', item: ID(1), name: 'Architecture', code: 'K001', hid: 'h3' }, { kind: 'part', name: 'Somewhere else' }],
    'a concept with no card stays a name');
  // A moved point renumbers cleanly: nothing of the number is stored.
  const moved = bookOf().nodes.reverse();
  const again = withCardNumbers(moved).flatMap(node => node.children).flatMap(point => point.cards || []);
  assert.deepEqual(again.map(each => [each.code, each.name]), [['K001', 'Big Ball of Mud'], ['K002', 'Architecture'], ['K003', 'Coupling']]);
  assert.equal(again[0].relations[0].code, 'K002');
  assert.deepEqual(withCardNumbers([{ hid: 'x', leaf: true, children: [] }]), [{ hid: 'x', leaf: true, children: [] }], 'a book without cards is unchanged');
});

test('the indexes: A–Z with each card\'s other name as a second entry, a by-chapter card index, the formula page in reading order', () => {
  const book = { ...bookOf(), nodes: withCardNumbers(bookOf().nodes) };
  const { glossary, chapters, formulas } = termIndexes({ nodes: book.nodes, glossary: book.glossary, language: 'en' });
  assert.deepEqual(glossary.map(entry => [entry.term, entry.code ?? null, entry.see ?? null]), [
    ['Amdahl’s law', null, null], ['Architecture', 'K001', null], ['Big Ball of Mud', 'K003', null], ['Coupling', 'K002', null], ['Little’s law', null, null], ['SA', 'K001', 'Architecture']]);
  assert.equal(glossary.find(entry => entry.term === 'Big Ball of Mud').hid, 'h6', 'a card the glossary lacks is listed from the card');
  assert.deepEqual(chapters.map(chapter => [chapter.hid, chapter.cards.map(each => each.code)]), [['h1', ['K001', 'K002']], ['h2', ['K003']]]);
  assert.deepEqual(formulas.map(entry => [entry.term, entry.hid, entry.page]), [['Amdahl’s law', 'h3', 3], ['Little’s law', 'h6', 9]], 'in the book\'s order');
  const lookup = bookLookup(book);
  assert.equal(lookup.glossary.find(entry => entry.term === 'SA').code, 'K001', 'the lookup page carries the A–Z');
  assert.equal(lookup.cardChapters.length, 2);
  assert.equal(lookup.formulas.length, 2);
  const plain = bookLookup({ ...bookOf(), nodes: bookOf().nodes.map(node => ({ ...node, children: node.children.map(({ cards: _c, ...rest }) => rest) })), glossary: [] });
  assert.deepEqual([plain.glossary, plain.cardChapters, plain.formulas], [[], [], []], 'an old book without cards or glossary has empty indexes');
});

test('a build with the fake model: the write call returns cards (no extra call), the notes keep them, the book shows them numbered in reading order', async t => {
  const fake = bookModel(), root = await privateRoot(t, 'book-cards-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary({ paper: true });
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); });
  // The whole book at once (the sample slice before a big build: tests/book-sample-job.test.mjs).
  const job = await settleJob(service, (await service.call('generation.courseBook.build', { course: COURSE, language: 'zh', sample: 'skip' })).jobId);
  assert.equal(job.status, 'complete');
  assert.deepEqual([...new Set(fake.stages())].filter(stage => !['write', 'review', 'repair', 'place', 'exam'].includes(stage) && /card/.test(stage)), [], 'no call of its own');
  assert.match(fake.of('write')[0].prompt, /pitch[^\n]*English/, 'the papers are English: the pitch is too, in a Chinese book');
  const notes = (await service.store.read()).sources.find(source => isCourseNotesSource(source) && !source.archived).courseNotes;
  const stored = notes.leaves.flatMap(leaf => leaf.body?.units || []).flatMap(unit => unit.cards || []);
  assert.ok(stored.length > 5, `cards kept (${stored.length})`);
  assert.ok(stored.every(each => !('code' in each)), 'the number is never stored');
  const book = await service.call('course.book.open', { course: COURSE });
  const leaves = [], walk = nodes => nodes.forEach(node => (node.leaf ? leaves.push(node) : walk(node.children)));
  walk(book.nodes);
  const shown = leaves.flatMap(each => each.cards || []);
  assert.deepEqual(shown.map(each => each.code), shown.map((_, at) => cardCode(at + 1)), 'K001… in reading order');
  assert.ok(shown.some(each => each.relations?.some(relation => relation.code)), 'a related item with a card is a link');
  assert.ok(book.glossary.length && book.glossary.every(entry => entry.item), 'the glossary names its items, so its entries find their cards');
});
