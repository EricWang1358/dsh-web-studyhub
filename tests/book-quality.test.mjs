/* The program's part of the 复习全书 quality workflow, without a model: every item in exactly one leaf (by the outline, by its anchor, by the place call, else
   in the unplaced point), the writer's claimed coverage cross-checked by a lexical check, the review's verdict, the glossary. And, with a fake model, a range
   read after the outline was made: its items are placed into the outline without rebuilding it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { bookModel } from './helpers/course-book-model.mjs';
import { assignItems, checklistOf, priorityOf } from '../lib/contexts/generation/book/checklist.js';
import { judge, mentions } from '../lib/contexts/generation/book/coverage.js';
import { extendNodes } from '../lib/contexts/generation/book/extend.js';
import { buildGlossary } from '../lib/contexts/generation/book/glossary.js';
import { isCourseInventorySource, isCourseNotesSource, isCourseOutlineSource } from '../lib/exam-point-list.js';

const place = (sourceId, start, verified = true) => ({ range: 'd~1', doc: 'doc:d', sourceId, start, end: start + 5, quote: 'q', verified });
const item = (id, name, kind, places, extra = {}) => ({ id, kind, name, gist: `${name} means something`, places, ...extra });
const inventory = { items: [item('i000000000001', 'CIA triad', 'concept', [place('s1', 10)]), item('i000000000002', 'Risk', 'term', [place('s2', 0)]),
  item('i000000000003', 'Threat tree', 'example', [place('s3', 0)]), item('i000000000004', 'Loose idea', 'claim', [place('nowhere', 0, false)])], documents: [{ key: 'doc:d', title: 'Lecture' }] };

test('every item is in exactly one leaf: the outline\'s, else the first whose pages hold its anchor, else the place call\'s, else unplaced', () => {
  const leaves = [{ id: 'a', items: ['i000000000001'], segments: [{ sourceId: 's1', start: 0, end: 100 }] }, { id: 'b', segments: [{ sourceId: 's1', start: 0, end: 100 }, { sourceId: 's2', start: 0, end: 50 }] },
    { id: 'c', segments: [] }];
  const first = assignItems(leaves, inventory);
  assert.deepEqual(Object.fromEntries(first.byLeaf), { a: ['i000000000001'], b: ['i000000000002'], c: [] });
  assert.deepEqual(first.unplaced, ['i000000000003', 'i000000000004'], 'no anchor in any leaf');
  const placed = assignItems(leaves, inventory, new Map([['i000000000003', 'c']]));
  assert.deepEqual([placed.byLeaf.get('c'), placed.unplaced], [['i000000000003'], ['i000000000004']]);
  const all = [...placed.byLeaf.values()].flat().concat(placed.unplaced);
  assert.equal(new Set(all).size, inventory.items.length, 'each once');
  // What nothing placed goes to the unplaced point of the last chapter (made when there is none): every item in a leaf.
  const nodes = extendNodes([{ id: 'ch', title: 'Ch', children: [{ id: 'a', title: 'A', anchors: [], items: ['i000000000001'] }] }], [{ id: 'a', items: ['i000000000001', 'i000000000002'] }],
    placed.unplaced, { unplacedChapter: '其他 / 未归位', unplacedLeaf: '未归位的概念', unplacedIntro: '' });
  assert.deepEqual(nodes.map(node => node.title), ['Ch', '其他 / 未归位']);
  assert.deepEqual([nodes[0].children[0].items, nodes[1].children[0].items], [['i000000000001', 'i000000000002'], ['i000000000004']]);
});

test('the checklist: must by the detail level, a stressed or tested item always a must', () => {
  assert.deepEqual(['brief', 'standard', 'full'].map(level => priorityOf({ kind: 'step' }, level, false)), ['optional', 'must', 'must']);
  assert.equal(priorityOf({ kind: 'example' }, 'standard', false), 'optional');
  assert.equal(priorityOf({ kind: 'example', key: true }, 'brief', false), 'must');
  assert.equal(priorityOf({ kind: 'claim' }, 'brief', true), 'must', 'a point the papers test covers everything');
  const list = checklistOf(['i000000000001', 'i000000000003'], inventory, { level: 'standard', tested: false, titles: new Map([['doc:d', 'Lecture']]) });
  assert.deepEqual(list.map(entry => [entry.alias, entry.priority, entry.material]), [['c1', 'must', 'Lecture'], ['c2', 'optional', 'Lecture']]);
});

test('the writer\'s claim is cross-checked: an item claimed but not named in the text is missing; one only named is flagged by the review', () => {
  const unit = { checklist: [{ alias: 'c1', id: 'x1', name: '威胁建模（threat modelling）', priority: 'must' }, { alias: 'c2', id: 'x2', name: 'CIA triad', priority: 'must' },
    { alias: 'c3', id: 'x3', name: 'Attack tree', priority: 'optional' }] };
  assert.ok(mentions('We use Threat Modelling to …', unit.checklist[0]), 'the gloss of a bilingual name counts');
  const draft = { text: 'Threat modelling is how … [^1]', claimed: ['x1', 'x2', 'x3'] };
  const verdict = judge(unit, draft, { issues: [] }, 0);
  assert.deepEqual([verdict.covered, verdict.missing.map(entry => entry.id), verdict.pass], [['x1'], ['x2'], false], 'claimed, never named: missing');
  const named = judge(unit, { text: 'Threat modelling and the CIA triad.', claimed: ['x1', 'x2'] }, { issues: [{ kind: 'namedrop', item: 'x2', note: '' }] }, 0);
  assert.deepEqual(named.missing.map(entry => entry.id), ['x2'], 'only named: the review flags it');
  const ok = judge(unit, { text: 'Threat modelling and the CIA triad.', claimed: ['x1', 'x2'] }, { issues: [{ kind: 'transition', note: 'no lead-in' }] }, 0);
  assert.equal(ok.pass, true, 'a missing transition is repaired when there is a repair, but never fails a unit');
  assert.equal(judge(unit, { text: 'Threat modelling and the CIA triad.', claimed: ['x1', 'x2'] }, { issues: [{ kind: 'unsupported', note: '' }] }, 0).pass, false);
  assert.equal(judge(unit, { text: 'Threat modelling and the CIA triad.', claimed: ['x1', 'x2'] }, null, 0).pass, false, 'no review, nothing claimed as checked');
});

test('the glossary is made by the program from the covered items, alphabetical, each with its point and page', () => {
  const leaves = [{ id: 'n2', body: { coverage: { covered: ['i000000000002'] } } }, { id: 'n1', body: { coverage: { covered: ['i000000000001', 'i000000000002'] } } }];
  const glossary = buildGlossary(leaves, { items: inventory.items.map(entry => ({ ...entry, places: [{ ...entry.places[0], page: 3 }] })) }, new Map([['doc:d', 'Lecture']]), 'en');
  assert.deepEqual(glossary.map(entry => [entry.name, entry.leaf, entry.page, entry.material]), [['CIA triad', 'n1', 3, 'Lecture'], ['Risk', 'n2', 3, 'Lecture']]);
});

test('a range read after the outline was made: its items are placed into the outline\'s points without rebuilding it, and written', async t => {
  let failing = true;
  const fake = bookModel({ fail: call => failing && call.stage === 'inventory' && call.data.part === 3 });
  const root = await privateRoot(t, 'book-quality-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); });
  const build = async () => { const job = await settleJob(service, (await service.call('generation.courseBook.build', { course: COURSE, language: 'zh' })).jobId); assert.equal(job.status, 'complete'); };
  await build();
  const read = async () => (await service.store.read()).sources;
  const first = (await read()).find(isCourseInventorySource).courseInventory;
  assert.ok(first.ranges.some(range => range.status === 'failed'));
  failing = false;
  const mark = fake.calls.length;
  await build();
  const stages = [...new Set(fake.calls.slice(mark).map(call => call.stage))];
  assert.ok(!stages.includes('cluster') && !stages.includes('order'), `the outline is not rebuilt (${stages})`);
  const inventory = (await read()).find(isCourseInventorySource).courseInventory, outline = (await read()).find(source => isCourseOutlineSource(source) && !source.archived);
  const held = [];
  const walk = nodes => nodes.forEach(node => (node.children ? walk(node.children) : held.push(...(node.items || []))));
  walk(outline.courseOutline.nodes);
  assert.equal(held.length, new Set(held).size);
  assert.deepEqual(new Set(held), new Set(inventory.items.map(entry => entry.id)), 'every item of the inventory, now read in full, in exactly one leaf');
  const notes = (await read()).find(source => isCourseNotesSource(source) && !source.archived).courseNotes;
  assert.equal(notes.outlineId, outline.id);
  assert.equal(notes.coverage.items.covered, notes.coverage.items.total);
});
