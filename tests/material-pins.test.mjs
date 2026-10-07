/* 置顶 on the 资料 page: the pure ordering, the two actions that change it, and how it is stored. The pins are an ordered list of
   row keys (lib/source-groups.js `key`: pdf:<hash>, doc:<materialId>, audio:<batch>, source:<id>) in the library's settings, a new
   optional field: no format version moves and a release that does not know it keeps it untouched. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { LATEST_VERSION, normalizeState } from '../lib/store.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { MAX_PINS, dropRequest, pinnedKeys, splitPinned, stepRequest } from '../lib/material-pins.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';

const row = (key, extra = {}) => ({ key, title: key, createdAt: '2026-10-01T08:00:00.000Z', chars: 10, ...extra });
const keys = items => items.map(item => item.key);

test('pinnedKeys reads the stored list defensively: text only, no repeats, nothing when it is missing or malformed', () => {
  assert.deepEqual(pinnedKeys(undefined), []);
  assert.deepEqual(pinnedKeys({}), []);
  assert.deepEqual(pinnedKeys({ materialPins: 'doc:a' }), []);
  assert.deepEqual(pinnedKeys({ materialPins: { 0: 'doc:a' } }), []);
  assert.deepEqual(pinnedKeys({ materialPins: ['doc:b', 7, '', null, 'doc:a', 'doc:b', '  '] }), ['doc:b', 'doc:a']);
  assert.equal(pinnedKeys({ materialPins: Array.from({ length: MAX_PINS + 40 }, (_, i) => `k${i}`) }).length, MAX_PINS);
});

test('splitPinned: no pins is today\'s list, the very same array', () => {
  const items = [row('a'), row('b'), row('c')];
  const { pinned, rest } = splitPinned(items, []);
  assert.deepEqual(pinned, []);
  assert.equal(rest, items, 'nothing pinned: the rest IS the input, so the day groups are byte for byte what they were');
  assert.equal(splitPinned(items, ['gone', 'also-gone']).rest, items, 'keys that match no row pin nothing');
});

test('splitPinned: the pinned rows come out in the learner\'s order, and a pinned row is not in the rest', () => {
  const items = [row('a'), row('b'), row('c'), row('d')];
  const { pinned, rest } = splitPinned(items, ['d', 'b']);
  assert.deepEqual(keys(pinned), ['d', 'b'], 'the pin order, not the list order');
  assert.deepEqual(keys(rest), ['a', 'c'], 'the others keep their order');
  assert.equal(pinned[0], items[3], 'the rows themselves, not copies');
});

test('splitPinned: dangling keys and rows outside the shown list are ignored but never reordered', () => {
  const all = [row('a'), row('b'), row('c')];
  // The course filter shows only a and c; b is pinned and out of scope, 'gone' no longer exists.
  const shown = [all[0], all[2]];
  const { pinned, rest } = splitPinned(shown, ['c', 'gone', 'b', 'a']);
  assert.deepEqual(keys(pinned), ['c', 'a']);
  assert.deepEqual(rest, []);
});

test('splitPinned: unpinning returns the row to its place among the others', () => {
  const items = [row('a'), row('b'), row('c')];
  assert.deepEqual(keys(splitPinned(items, ['b']).rest), ['a', 'c']);
  assert.deepEqual(keys(splitPinned(items, []).rest), ['a', 'b', 'c']);
});

test('stepRequest: 上移 / 下移 / 置顶到最前 are asked of the rows that are SHOWN; at the edge there is nothing to ask', () => {
  const shown = ['a', 'b', 'c'];
  assert.deepEqual(stepRequest(shown, 'b', 'up'), { key: 'b', before: 'a' });
  assert.deepEqual(stepRequest(shown, 'b', 'down'), { key: 'b', after: 'c' });
  assert.deepEqual(stepRequest(shown, 'c', 'front'), { key: 'c', front: true });
  assert.equal(stepRequest(shown, 'a', 'up'), null);
  assert.equal(stepRequest(shown, 'a', 'front'), null, 'already first');
  assert.equal(stepRequest(shown, 'c', 'down'), null);
  assert.equal(stepRequest(shown, 'zzz', 'up'), null, 'a row that is not shown has no neighbours');
  assert.equal(stepRequest(shown, 'b', 'sideways'), null);
});

test('dropRequest: dropped on a row it lands before it when it came from below and after it when it came from above', () => {
  const shown = ['a', 'b', 'c', 'd'];
  assert.deepEqual(dropRequest(shown, 'd', 'b'), { key: 'd', before: 'b' });
  assert.deepEqual(dropRequest(shown, 'a', 'c'), { key: 'a', after: 'c' });
  assert.equal(dropRequest(shown, 'b', 'b'), null, 'dropped on itself');
  assert.equal(dropRequest(shown, 'b', 'c') && dropRequest(shown, 'b', 'c').after, 'c');
  assert.equal(dropRequest(shown, 'x', 'b'), null);
  assert.equal(dropRequest(shown, 'b', 'x'), null);
});

/* ---------- the actions ---------- */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-pins-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const service = new StudyService(root, {});
  for (const id of ['a', 'b', 'c', 'd']) await service.call('source.add', { id, title: `Note ${id}`, text: `text of ${id}` });
  return { root, service };
}
const pinsOf = async service => (await service.call('snapshot')).settings.materialPins;

test('source.pin adds to the END of the pinned list; pinning again changes nothing; unpinning removes and is idempotent', async t => {
  const { service } = await fixture(t);
  assert.equal(await pinsOf(service), undefined, 'a library that never pinned has no field');
  assert.deepEqual((await service.call('source.pin', { key: 'source:b', pinned: true })).pins, ['source:b']);
  await service.call('source.pin', { key: 'source:d', pinned: true });
  await service.call('source.pin', { key: 'source:a', pinned: true });
  assert.deepEqual(await pinsOf(service), ['source:b', 'source:d', 'source:a'], 'each new pin goes last');
  await service.call('source.pin', { key: 'source:b', pinned: true });
  assert.deepEqual(await pinsOf(service), ['source:b', 'source:d', 'source:a'], 'already pinned: it keeps its place');
  await service.call('source.pin', { key: 'source:d', pinned: false });
  assert.deepEqual(await pinsOf(service), ['source:b', 'source:a']);
  assert.deepEqual((await service.call('source.pin', { key: 'source:d', pinned: false })).pins, ['source:b', 'source:a'], 'unpinning what is not pinned is fine');
});

test('source.pin refuses a key that is not a material and an unclear request, and writes nothing', async t => {
  const { service } = await fixture(t);
  await service.call('source.pin', { key: 'source:a', pinned: true });
  await assert.rejects(service.call('source.pin', { key: 'source:nope', pinned: true }), /not found/i);
  await assert.rejects(service.call('source.pin', { key: '', pinned: true }), /key/i);
  await assert.rejects(service.call('source.pin', { pinned: true }), /key/i);
  await assert.rejects(service.call('source.pin', { key: 'source:b' }), /pinned/i, 'pinned must be said');
  await assert.rejects(service.call('source.pin', { key: 'source:b', pinned: 'yes' }), /pinned/i);
  assert.deepEqual(await pinsOf(service), ['source:a']);
});

test('source.pin.move: before / after / front put a pinned row where it is asked and nothing else moves', async t => {
  const { service } = await fixture(t);
  for (const id of ['a', 'b', 'c', 'd']) await service.call('source.pin', { key: `source:${id}`, pinned: true });
  const order = async () => (await pinsOf(service)).map(key => key.slice(7)).join('');
  assert.equal(await order(), 'abcd');
  await service.call('source.pin.move', { key: 'source:c', before: 'source:b' });
  assert.equal(await order(), 'acbd');
  await service.call('source.pin.move', { key: 'source:a', after: 'source:b' });
  assert.equal(await order(), 'cbad');
  await service.call('source.pin.move', { key: 'source:d', front: true });
  assert.equal(await order(), 'dcba');
  await service.call('source.pin.move', { key: 'source:d', front: true });
  assert.equal(await order(), 'dcba', 'to the front twice is still the front');
  await service.call('source.pin.move', { key: 'source:c', before: 'source:c' });
  assert.equal(await order(), 'dcba', 'next to itself is no move');
  assert.deepEqual((await service.call('source.pin.move', { key: 'source:a', before: 'source:d' })).pins, ['source:a', 'source:d', 'source:c', 'source:b']);
});

test('source.pin.move refuses a row or a neighbour that is not pinned, a missing or doubled target, and changes nothing', async t => {
  const { service } = await fixture(t);
  await service.call('source.pin', { key: 'source:a', pinned: true });
  await service.call('source.pin', { key: 'source:b', pinned: true });
  await assert.rejects(service.call('source.pin.move', { key: 'source:c', front: true }), /not pinned/i);
  await assert.rejects(service.call('source.pin.move', { key: 'source:a', before: 'source:c' }), /not pinned/i);
  await assert.rejects(service.call('source.pin.move', { key: 'source:a' }), /where/i);
  await assert.rejects(service.call('source.pin.move', { key: 'source:a', front: true, before: 'source:b' }), /one of/i);
  await assert.rejects(service.call('source.pin.move', { key: 'source:a', before: 'source:b', after: 'source:b' }), /one of/i);
  assert.deepEqual(await pinsOf(service), ['source:a', 'source:b']);
});

test('a pin follows the row\'s stable key: a PDF by its content, a split recording by its batch, a document by its material id', async t => {
  const { service } = await fixture(t);
  const sha = 'a'.repeat(64);
  await service.store.update(s => {
    for (const n of [1, 2]) s.sources.push({ id: `pdf-${sha}-p${n}`, title: `Book · p.${n}`, text: `page ${n}`, createdAt: '2026-10-02T08:00:00.000Z', courses: [],
      document: { id: sha, filename: 'book.pdf', bookTitle: 'Book', page: n, totalPages: 3, extractionVersion: 2, materialId: `document-${sha}-pdf`, format: 'pdf' } });
    for (const n of [1, 2]) s.sources.push({ id: `rec-${n}`, title: `Lecture (${n}/3)`, text: `part ${n}`, createdAt: '2026-10-03T08:00:00.000Z', courses: [], audio: { batch: { id: 'batch-1', volume: n, title: 'Lecture' } } });
  });
  const items = groupSourcesByDocument((await service.call('snapshot')).sources);
  const book = items.find(item => item.format === 'pdf'), lecture = items.find(item => item.format === 'audio');
  assert.equal(book.key, `pdf:${sha}`);
  assert.equal(lecture.key, 'audio:batch-1');
  await service.call('source.pin', { key: book.key, pinned: true });
  await service.call('source.pin', { key: lecture.key, pinned: true });
  // A part is added to the recording, the book is renamed and a page is added: the keys do not move.
  await service.store.update(s => {
    s.sources.push({ id: 'rec-3', title: 'Lecture (3/3)', text: 'part 3', createdAt: '2026-10-03T09:00:00.000Z', courses: [], audio: { batch: { id: 'batch-1', volume: 3, title: 'Lecture' } } });
    s.sources.push({ id: `pdf-${sha}-p3`, title: 'Renamed · p.3', text: 'page 3', createdAt: '2026-10-02T09:00:00.000Z', courses: [],
      document: { id: sha, filename: 'book.pdf', bookTitle: 'Renamed', page: 3, totalPages: 3, extractionVersion: 2, materialId: `document-${sha}-pdf`, format: 'pdf' } });
  });
  const after = groupSourcesByDocument((await service.call('snapshot')).sources);
  assert.deepEqual(after.filter(item => item.format === 'pdf' || item.format === 'audio').map(item => item.key).sort(), [book.key, lecture.key].sort());
  assert.deepEqual(splitPinned(after, await pinsOf(service)).pinned.map(item => item.key), [book.key, lecture.key]);
});

test('a pin whose material is gone is pruned on the next write and never breaks a read', async t => {
  const { service } = await fixture(t);
  for (const id of ['a', 'b', 'c']) await service.call('source.pin', { key: `source:${id}`, pinned: true });
  await service.call('source.archive', { sourceIds: ['b'], archived: true });
  await service.call('source.remove', { sourceIds: ['b'], confirm: true });
  assert.deepEqual(await pinsOf(service), ['source:a', 'source:b', 'source:c'], 'nothing is rewritten until a pin changes');
  assert.deepEqual(pinnedKeys((await service.call('snapshot')).settings), ['source:a', 'source:b', 'source:c'], 'reading a dangling key is harmless');
  await service.call('source.pin', { key: 'source:d', pinned: true });
  assert.deepEqual(await pinsOf(service), ['source:a', 'source:c', 'source:d'], 'the dangling key leaves with the next write');
  await service.call('source.archive', { sourceIds: ['a'], archived: true });
  await service.call('source.pin.move', { key: 'source:d', front: true });
  assert.deepEqual(await pinsOf(service), ['source:d', 'source:a', 'source:c'], 'an archived material keeps its place: restoring it brings the pin back');
});

test('the list is bounded: pinning past the limit is refused with a sentence, unpinning makes room', async t => {
  const { service } = await fixture(t);
  await service.store.update(s => {
    for (let i = 0; i < MAX_PINS; i++) s.sources.push({ id: `bulk-${i}`, title: `Bulk ${i}`, text: `t${i}`, createdAt: '2026-10-01T08:00:00.000Z', courses: [] });
    s.settings.materialPins = Array.from({ length: MAX_PINS }, (_, i) => `source:bulk-${i}`);
  });
  await assert.rejects(service.call('source.pin', { key: 'source:a', pinned: true }), /at most/i);
  assert.equal((await pinsOf(service)).length, MAX_PINS);
  await service.call('source.pin', { key: 'source:bulk-3', pinned: false });
  assert.equal((await service.call('source.pin', { key: 'source:a', pinned: true })).pins.at(-1), 'source:a');
});

/* ---------- how it is stored ---------- */

test('stored format: one optional field inside the library\'s settings; no version moves, no other field appears', async t => {
  const { root, service } = await fixture(t);
  const before = JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
  await service.call('source.pin', { key: 'source:a', pinned: true });
  await service.call('source.pin', { key: 'source:c', pinned: true });
  const after = JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
  assert.equal(after.version, LATEST_VERSION);
  assert.equal(after.version, before.version, 'the library format version does not move');
  assert.deepEqual(after.settings.materialPins, ['source:a', 'source:c']);
  const { materialPins, ...settings } = after.settings, { materialPins: none, ...settingsBefore } = before.settings;
  assert.equal(none, undefined);
  assert.deepEqual(settings, settingsBefore, 'every other setting is as it was');
  assert.deepEqual(Object.keys(after).filter(key => !(key in before)).sort(), [], 'no top-level field was added');
  assert.ok((await readdir(root)).length > 0);
});

test('an older release opens a library with pins and an older library opens here: the field is just a setting it does not look at', async t => {
  const { service } = await fixture(t);
  await service.call('source.pin', { key: 'source:a', pinned: true });
  const exported = await service.call('export');
  // A release without pins normalizes settings as `{ ...defaults, ...stored, generation, dailyRecap }` (lib/store.js, unchanged): the unknown key rides along.
  const opened = normalizeState(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(opened.settings.materialPins, ['source:a']);
  assert.equal(opened.version, LATEST_VERSION);
  // And one written before pins existed has no field and reads as an empty list.
  const { materialPins, ...plain } = exported.settings;
  const legacy = normalizeState({ ...JSON.parse(JSON.stringify(exported)), settings: plain });
  assert.equal(legacy.settings.materialPins, undefined);
  assert.deepEqual(pinnedKeys(legacy.settings), []);
  // The settings form of a release that does not know pins writes the whole object back; the list survives it.
  await service.call('settings', { ...(await service.call('snapshot')).settings, second_interval_days: 5 });
  assert.deepEqual(await pinsOf(service), ['source:a']);
});

test('concurrent writes: pins and settings changes made at once all land', async t => {
  const { service } = await fixture(t);
  await Promise.all([
    service.call('source.pin', { key: 'source:a', pinned: true }),
    service.call('source.pin', { key: 'source:b', pinned: true }),
    service.call('source.pin', { key: 'source:c', pinned: true }),
    service.call('focus.set', { course: 'DB' }).catch(() => {}),
    service.call('source.add', { id: 'z', title: 'Late note', text: 'late' }),
  ]);
  const snapshot = await service.call('snapshot');
  assert.deepEqual([...snapshot.settings.materialPins].sort(), ['source:a', 'source:b', 'source:c']);
  assert.ok(snapshot.sources.some(source => source.id === 'z'), 'the other write is not lost');
});

test('the actions write the library settings and nothing else', () => {
  assert.deepEqual(writesFor('system', 'source.pin'), ['settings']);
  assert.deepEqual(writesFor('system', 'source.pin.move'), ['settings']);
});
