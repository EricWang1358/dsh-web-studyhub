/* The card pass (#710 S6): a book written before 术语卡 existed gets its cards from the text it already has, never rewritten. The pass reads each unit's text
   and the checklist items it covers (names and gists), not the pages; one call per batch of units sized by CARD_PASS; the same card shape, reader and
   normaliser as the write call's (S1). A unit that has cards costs nothing. Fakes only: no model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { bookModel } from './helpers/course-book-model.mjs';
import { isCourseNotesSource } from '../lib/exam-point-list.js';
import { CARD_PASS } from '../lib/contexts/generation/book/constants.js';
import { cardBatches, cardEntries } from '../lib/contexts/generation/book/card-batches.js';
import { cardPassPrompt } from '../lib/contexts/generation/book/card-prompt.js';
import { readCardPass } from '../lib/contexts/generation/book/cards.js';

const ID = n => `i${String(n).padStart(11, '0')}`;
const must = (n, extra = {}) => ({ alias: `c${n}`, id: ID(n), kind: 'concept', name: `Concept ${n}`, gist: `what concept ${n} means`, priority: 'must', ...extra });
const unitOf = (covered, extra = {}) => ({ text: `A written explanation of ${covered.map(id => `concept ${Number(id.slice(1))}`).join(' and ')}.`, cites: [], covered, read: [], status: 'ok', ...extra });
/** A work item (book/work.js) whose body was written before cards existed: one unit over `ids`. */
const itemOf = (id, ids, { cards, checklist = ids.map(n => must(n)), text } = {}) => ({ id, title: `Point ${id}`, path: ['Chapter'], checklist,
  units: [{ n: 1, of: 1 }], body: { fingerprint: 'f'.repeat(16), units: [unitOf(ids.map(ID), { ...(cards ? { cards } : {}), ...(text !== undefined ? { text } : {}) })],
    coverage: { must: ids.length, covered: ids.map(ID), missing: [], optional: 0 }, issues: [], status: 'ok' } });

test('the entries: units with text and covered must items and no cards; a unit with cards, an empty or pending one, or one covering only optional items costs nothing', () => {
  const items = [itemOf('a', [1, 2]), itemOf('b', [3], { cards: [{ item: ID(3), name: 'C3', plain: 'p' }] }), itemOf('c', [4], { checklist: [must(4, { priority: 'optional' })] }),
    { id: 'd', title: 'Empty', path: [], checklist: [], units: [], body: { fingerprint: 'e'.repeat(16), empty: true } }, { id: 'e', title: 'Never written', path: [], checklist: [], units: [] },
    itemOf('f', [5], { text: '' }), itemOf('g', [6, 7])];
  items[6].body.coverage.covered = [ID(6)];
  items[6].body.units[0].covered = [ID(6)];
  const entries = cardEntries(items);
  assert.deepEqual(entries.map(entry => [entry.item.id, entry.at, entry.checklist.map(item => item.id)]), [['a', 0, [ID(1), ID(2)]], ['g', 0, [ID(6)]]],
    'only the items the text covers, and only must items, as the write call cards them');
  assert.deepEqual(entries[0].checklist[0], { id: ID(1), kind: 'concept', name: 'Concept 1', gist: 'what concept 1 means' }, 'names and gists, no pages');
  assert.deepEqual(cardEntries(items, { point: 'g' }).map(entry => entry.item.id), ['g'], 'filling one point: only that point');
});

test('the batches: at most CARD_PASS.units texts, CARD_PASS.items items and CARD_PASS.chars characters a call; aliases unique in a batch; a 283-point book is about 30 calls', () => {
  const book = Array.from({ length: 283 }, (_, at) => itemOf(`p${at}`, [3 * at + 1, 3 * at + 2, 3 * at + 3], { text: 'x'.repeat(2000) }));
  const batches = cardBatches(cardEntries(book));
  assert.equal(batches.length, Math.ceil(283 / CARD_PASS.units), 'sized by the budget, not by a number written here');
  assert.ok(batches.length >= 28 && batches.length <= 32, `${batches.length} calls`);
  for (const batch of batches) {
    assert.ok(batch.entries.length <= CARD_PASS.units);
    assert.equal(new Set(batch.checklist.map(item => item.alias)).size, batch.checklist.length, 'an alias names one item of the batch');
    assert.deepEqual(batch.entries.map(entry => entry.alias), batch.entries.map((_, at) => `k${at + 1}`));
  }
  assert.deepEqual(batches.flatMap(batch => batch.entries.map(entry => entry.item.id)), book.map(item => item.id), 'every unit once, in reading order');
  assert.equal(new Set(batches.map(batch => batch.key)).size, batches.length);
  assert.deepEqual(cardBatches(cardEntries(book)).map(batch => batch.key), batches.map(batch => batch.key), 'the same units, the same keys (a retry reuses the answers)');
  const long = cardBatches(cardEntries(book.slice(0, 6)), { ...CARD_PASS, chars: 4500 });
  assert.deepEqual(long.map(batch => batch.entries.length), [2, 2, 2], 'the characters close a batch before the count does');
  const many = cardBatches(cardEntries(book.slice(0, 6)), { ...CARD_PASS, items: 7 });
  assert.deepEqual(many.map(batch => batch.entries.length), [2, 2, 2], 'and so do the items asked for');
  assert.deepEqual(cardBatches([]), []);
});

const batchOf = () => cardBatches(cardEntries([itemOf('a', [1, 2]), itemOf('b', [3])]))[0];

test('the prompt shows each point\'s written text and its covered items, no pages; the pitch in the language the plan decided', () => {
  const sent = cardPassPrompt(batchOf(), { language: 'zh', pitchLanguage: 'en' });
  const data = JSON.parse(sent.prompt.slice(sent.prompt.indexOf('REQUEST DATA:\n') + 14));
  assert.equal(data.stage, 'cards');
  assert.deepEqual(data.points.map(point => [point.id, point.title, point.checklist.map(item => item.id)]), [['k1', 'Point a', ['c1', 'c2']], ['k2', 'Point b', ['c3']]]);
  assert.match(data.points[0].text, /A written explanation/);
  assert.ok(!('pages' in data) && data.points.every(point => !('pages' in point)), 'the pass never reads the source pages');
  assert.match(sent.prompt, /"cards"/);
  assert.match(sent.prompt, /pitch[^\n]*English/, 'the same pitch language as the write call');
});

test('the reply is read by the shared reader: cards go to the point whose item they name; a relation may name another point\'s item; unknown aliases are dropped', () => {
  const batch = batchOf();
  const read = readCardPass(JSON.stringify({ cards: [
    { item: 'c1', name: 'Concept 1', plain: 'One plainly.', pitch: 'One in an answer.', relations: [{ kind: 'related', item: 'c3' }, { kind: 'part', item: 'c99' }] },
    { item: 'c3', name: 'Concept 3', alt: 'C3', plain: 'Three plainly.', pitch: 'Three in an answer.', relations: [{ kind: 'opposite', name: 'Not three' }] },
    { item: 'c42', name: 'Invented', plain: 'x', pitch: 'y' },
    { item: 'c2', name: 'Name only' },
  ] }), batch);
  assert.deepEqual(read[0], [{ item: ID(1), name: 'Concept 1', plain: 'One plainly.', pitch: 'One in an answer.', relations: [{ kind: 'related', item: ID(3), name: 'Concept 3' }] }],
    'c99 is no item of the batch, c42 no card; a card with nothing to say is dropped (lib/course-book-term-cards.js)');
  assert.deepEqual(read[1], [{ item: ID(3), name: 'Concept 3', alt: 'C3', plain: 'Three plainly.', pitch: 'Three in an answer.', relations: [{ kind: 'opposite', name: 'Not three' }] }]);
  assert.equal(readCardPass('Not JSON at all.', batch), null, 'an unreadable reply is asked once more');
  assert.equal(readCardPass(JSON.stringify({ text: 'no cards' }), batch), null);
  assert.deepEqual(readCardPass(JSON.stringify({ cards: [] }), batch), [[], []]);
});

/** The service over the 134-material course with the fake model; `fake.calls` counts the calls of each stage. */
async function world(t) {
  const fake = bookModel(), root = await privateRoot(t, 'book-card-pass-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary({ paper: true });
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); state.focus = { mode: 'class', course: COURSE }; });
  const notes = async () => (await service.store.read()).sources.filter(isCourseNotesSource).find(record => !record.archived);
  const build = async (args = {}) => service.call('generation.courseBook.build', { course: COURSE, language: 'zh', sample: 'skip', ...args });
  const contract = () => [...service.runtime.work.jobs.values()].filter(job => job.type === 'course-book-build').at(-1).contract;
  const run = async (args = {}) => { const job = await settleJob(service, (await build(args)).jobId); assert.equal(job.status, 'complete', JSON.stringify(contract()?.error ?? null)); return contract(); };
  const stages = since => fake.calls.slice(since).reduce((count, call) => ({ ...count, [call.stage]: (count[call.stage] ?? 0) + 1 }), {});
  // An old book: the same book as written before 术语卡 existed (no unit has cards); `kit: false` also before the exam answer kit existed.
  const age = ({ kit = true } = {}) => service.store.update(state => {
    const record = state.sources.find(source => isCourseNotesSource(source) && !source.archived);
    for (const leaf of record.courseNotes.leaves) for (const unit of leaf.body?.units || []) delete unit.cards;
    if (!kit) delete record.courseNotes.examKit;
  });
  return { service, fake, notes, build, run, stages, age };
}
const withoutCards = leaves => leaves.map(leaf => ({ ...leaf, ...(leaf.body?.units ? { body: { ...leaf.body, units: leaf.body.units.map(({ cards: _cards, ...unit }) => unit) } } : {}) }));
const carded = leaves => leaves.flatMap(leaf => leaf.body?.units || []).filter(unit => unit.cards?.length).length;

test('an old book updated: one card call per batch, no write, review or repair; text, cites and coverage unchanged; a second run makes no call', async t => {
  const w = await world(t);
  await w.run();
  await w.age();
  const old = (await w.notes()).courseNotes;
  assert.equal(carded(old.leaves), 0, 'an old book has no cards');
  const units = old.leaves.flatMap(leaf => leaf.body?.units || []).filter(unit => unit.text && unit.covered.length).length;
  const before = w.fake.calls.length;
  const book = await w.run();
  const calls = w.stages(before);
  t.diagnostic(`old book, ${units} units without cards: ${JSON.stringify(calls)}`);
  assert.deepEqual(calls, { cards: Math.ceil(units / CARD_PASS.units) }, 'about one call per CARD_PASS.units points, nothing else');
  const now = (await w.notes()).courseNotes;
  assert.ok(carded(now.leaves) > 0 && carded(now.leaves) === units, 'every unit with covered must items has cards');
  assert.deepEqual(withoutCards(now.leaves), withoutCards(old.leaves), 'the explanations, cites and coverage are what they were');
  assert.deepEqual(now.coverage, old.coverage);
  const sent = w.fake.calls.slice(before).map(call => call.data);
  assert.ok(sent.every(data => data.points.every(point => point.text && !point.pages)), 'the written text, never the pages');
  assert.ok(now.leaves.some(leaf => leaf.body?.units?.some(unit => unit.cards?.some(card => card.relations?.some(relation => relation.item
    && !leaf.body.coverage.covered.includes(relation.item))))), 'a relation may name an item of another point of the batch');
  assert.equal(book.detail.book.cards.total, Math.ceil(units / CARD_PASS.units), 'the console shows the card calls as steps');
  assert.match(book.stage.text, /术语卡/);
  const again = w.fake.calls.length;
  await w.run();
  assert.equal(w.fake.calls.length - again, 0, 'nothing is missing: no call');
});

test('补术语卡 (cards: true): the estimate costs nothing, the pass touches no text even when the detail level changed, and with nothing to do no task starts', async t => {
  const w = await world(t);
  await w.run();
  await w.age();
  const old = (await w.notes()).courseNotes;
  assert.ok(old.examKit, 'the book has its exam answer kit');
  // The learner raised the detail level since: an update would rewrite; the card pass must not.
  await w.service.store.update(state => { state.settings = { ...(state.settings || {}), book: { ...(state.settings?.book || {}), coverage: 'full' } }; });
  const before = w.fake.calls.length;
  const estimate = await w.build({ cards: true, estimate: true });
  assert.equal(w.fake.calls.length, before, 'an estimate is no call');
  assert.equal(estimate.status, 'estimate');
  assert.ok(estimate.points > 0 && estimate.calls === Math.ceil(estimate.points / CARD_PASS.units), JSON.stringify(estimate));
  await w.run({ cards: true });
  assert.deepEqual(Object.keys(w.stages(before)), ['cards'], 'only the card pass');
  assert.equal(w.stages(before).cards, estimate.calls, 'the estimate is what it cost');
  const now = (await w.notes()).courseNotes;
  assert.deepEqual(withoutCards(now.leaves), withoutCards(old.leaves), 'no explanation rewritten');
  assert.ok(carded(now.leaves) > 0);
  assert.deepEqual(now.examKit, old.examKit, 'the answer kit is kept as it was');
  const nothing = await w.build({ cards: true });
  assert.deepEqual([nothing.status, nothing.calls, nothing.jobId], ['nothing', 0, undefined], 'no task, no call');
  // A book older than the answer kit too: 补术语卡 still adds only cards (the kit is 更新全书's to write).
  await w.age({ kit: false });
  const since = w.fake.calls.length;
  await w.run({ cards: true });
  assert.deepEqual(Object.keys(w.stages(since)), ['cards'], 'no kit call');
  assert.equal((await w.notes()).courseNotes.examKit, undefined);
});

test('补术语卡 on a course without a book is refused with a code before any call', async t => {
  const w = await world(t);
  await assert.rejects(w.build({ cards: true }), error => error.code === 'course-book-no-book');
  assert.equal(w.fake.calls.length, 0);
});
