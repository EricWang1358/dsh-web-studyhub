/* 资料重命名 (materials.document.rename): a rename changes ONLY title fields. Cards cite a source by sourceId + quote and look the
   title up when they are shown, so ids, text, revisions, selections, citations and card links must resolve exactly as before.
   No network, no model; generated PDFs and a temporary library. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { StudyService } from '../lib/service.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { materialsSchemas } from '../lib/contexts/materials/contracts.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { checkTitle, retitleSources, MAX_TITLE_CHARS } from '../lib/document-title.js';
import { prepareJsonImport } from '../lib/json-import.js';
import { validateDeck } from '../lib/domain.js';
import { makeTextPdf, LECTURE_PAGES } from './helpers/text-pdf.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'document-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  store.registerCollection('documents');
  const links = [];
  const ops = createMaterialsOperations({ root, ...store.scoped(['sources', 'documents']),
    bankCards: async () => links });
  const call = (action, args = {}) => ops.handlers[action](args, {});
  return { root, store, call, links };
}
const MD = Buffer.from('# Operating systems\n\nA process is the unit of resource allocation in an operating system.\n\nVirtual memory gives every process its own address space.\n');
const importMd = (call, extra = {}) => call('materials.document.import', { dataBase64: MD.toString('base64'), filename: 'os-notes.md', ...extra });
const importPdf = async call => call('materials.document.import', { dataBase64: (await makeTextPdf(LECTURE_PAGES)).toString('base64'), filename: 'lecture.pdf' });
const titlesOf = async store => (await store.read()).sources.map(source => source.title);
const frozen = sources => sources.map(({ id, text, document, createdAt, importedAt, courses }) => ({ id, text, createdAt, importedAt, courses, page: document?.page, materialId: document?.materialId, materialRevision: document?.materialRevision }));

/* ---------- validation ---------- */

test('a title is trimmed, whitespace is collapsed, and 1-200 characters without control characters or only dots are accepted', () => {
  assert.deepEqual(checkTitle('  Operating   systems \n notes\t'), { ok: true, title: 'Operating systems notes' });
  assert.deepEqual(checkTitle('操作系统　讲义'), { ok: true, title: '操作系统 讲义' });
  assert.equal(checkTitle('a'.repeat(MAX_TITLE_CHARS)).ok, true);
  assert.equal(MAX_TITLE_CHARS, 200);
  for (const [value, code] of [['', 'empty'], ['   \n ', 'empty'], [undefined, 'empty'], [null, 'empty'], [42, 'empty'],
    ['a'.repeat(201), 'too-long'], ['bad\u0000name', 'control'], ['esc\u001b[0m', 'control'], ['...', 'dots'], [' . . ', 'dots'], ['…', 'dots']])
    assert.deepEqual(checkTitle(value), { ok: false, code }, JSON.stringify(value));
  assert.equal(checkTitle('😀'.repeat(200)).ok, true, 'length counts characters, not UTF-16 units');
});

test('the rename operation is declared with its contract', () => {
  const schema = materialsSchemas['materials.document.rename'];
  assert.ok(schema, 'declared');
  assert.ok(schema.input.properties.title && schema.input.properties.expectedTitle && schema.input.properties.restore);
  assert.match(schema.description, /only (?:the )?title/i);
});

/* ---------- which titles follow the document title ---------- */

test('page titles derived from the document title follow it; titles that came from the content never change', () => {
  const members = [
    { id: 'a', title: 'lecture.pdf · p.1', text: 'x', document: { page: 1, filename: 'lecture.pdf' } },
    { id: 'b', title: 'lecture.pdf · 第 2 页', text: 'y', document: { page: 2, filename: 'lecture.pdf' } },
    { id: 'c', title: 'Chapter 3: Scheduling', text: 'z', document: { page: 3, filename: 'lecture.pdf' } },
    { id: 'd', title: 'Other.pdf · p.4', text: 'w', document: { page: 4, filename: 'lecture.pdf' } },
  ];
  const result = retitleSources(members, { from: 'lecture.pdf', to: 'OS lecture 1' });
  assert.deepEqual(members.map(source => source.title), ['OS lecture 1 · p.1', 'OS lecture 1 · 第 2 页', 'Chapter 3: Scheduling', 'Other.pdf · p.4']);
  assert.deepEqual(result.changed, ['a', 'b']);
  assert.ok(members.slice(0, 2).every(source => source.document.bookTitle === 'OS lecture 1'), 'the book title follows');
  assert.deepEqual(members[0].titleAliases, ['lecture.pdf · p.1'], 'the old page title stays resolvable');
  assert.equal(members[0].renamedFrom, 'lecture.pdf');
  assert.equal(members[2].titleAliases, undefined);
  assert.deepEqual(members.map(source => source.text), ['x', 'y', 'z', 'w']);
  assert.deepEqual(members.map(source => source.id), ['a', 'b', 'c', 'd']);
});

test('a single text takes the whole title; a recording of several files keeps its part suffix and its batch title follows', () => {
  const note = [{ id: 'n', title: 'Pasted notes', text: 'hello world', courses: [] }];
  retitleSources(note, { from: 'Pasted notes', to: 'Week 1' });
  assert.equal(note[0].title, 'Week 1');
  const batch = id => ({ id, title: `PE1 · 中英对照逐字稿 (${id.slice(-1)}/2)`, text: id, audio: { batch: { id: 'pe1', title: 'PE1', volume: Number(id.slice(-1)), volumes: 2, members: [{ filename: 'a.m4a' }] }, sourceIds: ['p1', 'p2'] } });
  const parts = [batch('p1'), batch('p2')];
  retitleSources(parts, { from: 'PE1', to: 'Programming Exam 1' });
  assert.deepEqual(parts.map(part => part.title), ['Programming Exam 1 · 中英对照逐字稿 (1/2)', 'Programming Exam 1 · 中英对照逐字稿 (2/2)']);
  assert.ok(parts.every(part => part.audio.batch.title === 'Programming Exam 1'));
  assert.deepEqual(parts[0].audio.batch.members, [{ filename: 'a.m4a' }], 'the original file names are never touched');
});

test('the list shows the document title, its file name, and what it was called before', () => {
  const sources = [{ id: 'a', title: 'OS lecture 1 · p.1', text: 'x', renamedFrom: 'lecture.pdf', document: { id: 'h'.repeat(64), page: 1, filename: 'lecture.pdf', bookTitle: 'OS lecture 1' } }];
  const [item] = groupSourcesByDocument(sources);
  assert.equal(item.title, 'OS lecture 1');
  assert.equal(item.filename, 'lecture.pdf');
  assert.equal(item.renamedFrom, 'lecture.pdf');
  const [plain] = groupSourcesByDocument([{ id: 'p', title: 'Plain', text: 'x' }]);
  assert.equal(plain.renamedFrom, undefined);
});

/* ---------- the operation ---------- */

test('renaming a Markdown document changes only its title: ids, text, revision, selections and card links resolve as before', async t => {
  const { call, store, links } = await fixture(t);
  const imported = await importMd(call);
  const selected = await call('materials.selection.resolve', { documentId: imported.documentId, revision: imported.revision, quote: 'A process is the unit of resource allocation' });
  assert.equal(selected.status, 'resolved');
  links.push({ deckId: 'd1', card: { id: 'c1', prompt: 'Q', selections: [selected.selection], citations: [{ sourceId: imported.sourceIds[0], quote: 'A process is the unit of resource allocation' }] } });
  const before = { stored: await store.read(), links: await call('materials.links.list', { documentId: imported.documentId }), selection: await call('materials.selection.resolve', selected.selection) };

  const result = await call('materials.document.rename', { documentId: imported.documentId, title: '  操作系统   第一讲 ' });
  assert.equal(result.status, 'renamed');
  assert.equal(result.title, '操作系统 第一讲');
  assert.equal(result.previousTitle, 'os-notes.md');
  assert.equal(result.revision, imported.revision);

  const after = { stored: await store.read(), links: await call('materials.links.list', { documentId: imported.documentId }), selection: await call('materials.selection.resolve', selected.selection) };
  assert.equal(after.stored.documents[0].title, '操作系统 第一讲');
  assert.equal(after.stored.documents[0].filename, 'os-notes.md', 'the file name is the original and stays');
  assert.deepEqual(after.stored.documents[0].titleHistory, ['os-notes.md']);
  assert.equal(after.stored.sources[0].title, '操作系统 第一讲');
  assert.equal(after.stored.sources[0].renamedFrom, 'os-notes.md');
  assert.deepEqual(frozen(after.stored.sources), frozen(before.stored.sources));
  assert.equal(after.stored.documents[0].currentRevision, before.stored.documents[0].currentRevision);
  assert.deepEqual(after.stored.documents[0].versions, before.stored.documents[0].versions);
  assert.deepEqual(after.links, before.links, 'links resolve identically');
  assert.deepEqual(after.selection, before.selection, 'selections resolve identically');
  const deck = { title: 'D', cards: [{ id: 'c1', kind: 'flashcard', prompt: 'Q', answer: 'A', citations: [{ sourceId: imported.sourceIds[0], quote: 'A process is the unit of resource allocation' }] }] };
  assert.deepEqual(validateDeck(deck, before.stored.sources).errors, validateDeck(deck, after.stored.sources).errors, 'citations validate the same');
  const described = await call('materials.document.get', { documentId: imported.documentId });
  assert.equal(described.title, '操作系统 第一讲');
});

test('rename is idempotent, guarded by the title the person saw and by the revision, and reports plain errors', async t => {
  const { call, store } = await fixture(t);
  const imported = await importMd(call);
  const id = imported.documentId;
  const first = await call('materials.document.rename', { documentId: id, title: 'OS notes' });
  const revisionAfter = (await store.read()).revision;
  const again = await call('materials.document.rename', { documentId: id, title: 'OS   notes ' });
  assert.equal(again.status, 'unchanged');
  assert.equal((await store.read()).revision, revisionAfter, 'nothing is written when nothing changes');
  await assert.rejects(call('materials.document.rename', { documentId: id, title: 'Another', expectedTitle: 'os-notes.md' }), /changed|expected/i);
  assert.equal((await store.read()).documents[0].title, 'OS notes');
  const ok = await call('materials.document.rename', { documentId: id, title: 'Another', expectedTitle: 'OS notes', revision: first.revision });
  assert.equal(ok.status, 'renamed');
  await assert.rejects(call('materials.document.rename', { documentId: id, title: 'X', revision: 'not-the-current-revision' }), /revision/i);
  for (const title of ['', '   ', '...', 'x'.repeat(201), 'a\u0000b']) await assert.rejects(call('materials.document.rename', { documentId: id, title }), /title/i, JSON.stringify(title));
  await assert.rejects(call('materials.document.rename', { documentId: 'document-nope', title: 'X' }), /not found/i);
  assert.equal((await store.read()).documents[0].title, 'Another');
});

test('restore puts the original name back, undo goes back one rename, and the history keeps the last ten', async t => {
  const { call, store } = await fixture(t);
  const { documentId } = await importMd(call);
  await call('materials.document.rename', { documentId, title: 'One' });
  await call('materials.document.rename', { documentId, title: 'Two' });
  assert.equal((await store.read()).sources[0].renamedFrom, 'os-notes.md', 'the original is kept across renames');
  const undone = await call('materials.document.rename', { documentId, undo: true });
  assert.equal(undone.title, 'One');
  assert.deepEqual((await store.read()).documents[0].titleHistory, ['os-notes.md']);
  await call('materials.document.rename', { documentId, title: 'Three' });
  const restored = await call('materials.document.rename', { documentId, restore: true });
  assert.equal(restored.status, 'renamed');
  assert.equal(restored.title, 'os-notes.md');
  const state = await store.read();
  assert.equal(state.sources[0].title, 'os-notes.md');
  assert.equal(state.sources[0].renamedFrom, undefined, 'back to the original: nothing to restore');
  assert.equal((await call('materials.document.rename', { documentId, restore: true })).status, 'unchanged');
  for (let n = 1; n <= 14; n++) await call('materials.document.rename', { documentId, title: `Name ${n}` });
  const history = (await store.read()).documents[0].titleHistory;
  assert.equal(history.length, 10);
  assert.equal(history.at(-1), 'Name 13');
  assert.equal((await store.read()).sources[0].renamedFrom, 'os-notes.md', 'the original survives the history limit');
  const back = await call('materials.document.rename', { documentId, restore: true });
  assert.equal(back.title, 'os-notes.md');
});

test('a PDF: the document title leads, page titles follow it, the file name stays, and the 资料 page shows the new name', async t => {
  const { call, store } = await fixture(t);
  const imported = await importPdf(call);
  const before = await store.read();
  assert.equal(groupSourcesByDocument(before.sources)[0].title, 'lecture.pdf');
  const result = await call('materials.document.rename', { sourceId: imported.sourceIds[1], title: 'Databases lecture 3' });
  assert.equal(result.status, 'renamed');
  const after = await store.read();
  assert.deepEqual(after.sources.map(source => source.title), ['Databases lecture 3 · p.1', 'Databases lecture 3 · p.2', 'Databases lecture 3 · p.3']);
  assert.ok(after.sources.every(source => source.document.filename === 'lecture.pdf'));
  const [item] = groupSourcesByDocument(after.sources);
  assert.equal(item.title, 'Databases lecture 3');
  assert.equal(item.filename, 'lecture.pdf');
  assert.equal(item.renamedFrom, 'lecture.pdf');
  assert.deepEqual(frozen(after.sources), frozen(before.sources));
  const restored = await call('materials.document.rename', { documentId: imported.documentId, restore: true });
  assert.equal(restored.title, 'lecture.pdf');
  assert.deepEqual((await store.read()).sources.map(source => source.title), before.sources.map(source => source.title));
});

test('a legacy document (no record): the first rename creates the record with the identity it already had', async t => {
  const { call, store } = await fixture(t);
  const imported = await importPdf(call);
  await store.update(state => {
    state.documents = [];
    for (const source of state.sources) { delete source.document.materialId; delete source.document.materialRevision; delete source.document.format; }
  });
  const legacy = await call('materials.document.get', { sourceId: imported.sourceIds[0] });
  assert.equal(legacy.legacy, true);
  const result = await call('materials.document.rename', { sourceId: imported.sourceIds[2], title: 'Lecture, renamed' });
  assert.equal(result.status, 'renamed');
  assert.equal(result.documentId, legacy.documentId, 'same identity');
  const state = await store.read();
  assert.equal(state.documents.length, 1);
  assert.equal(state.documents[0].id, legacy.documentId);
  assert.equal(state.documents[0].title, 'Lecture, renamed');
  assert.deepEqual(state.sources.map(source => source.title), ['Lecture, renamed · p.1', 'Lecture, renamed · p.2', 'Lecture, renamed · p.3']);
  const after = await call('materials.document.get', { sourceId: imported.sourceIds[0] });
  assert.equal(after.revision, legacy.revision, 'the revision does not change');
  assert.equal(after.title, 'Lecture, renamed');
  assert.equal((await call('materials.document.rename', { sourceId: imported.sourceIds[0], title: 'Lecture, renamed' })).status, 'unchanged');
});

test('a recording of several files is renamed as one document and its original file names are untouched', async t => {
  const { call, store } = await fixture(t);
  await store.update(state => {
    for (const n of [1, 2, 3]) state.sources.push({ id: `pe1-${n}`, title: `PE1 · 中英对照逐字稿 (${n}/3)`, text: `part ${n} of the lecture`, courses: [], createdAt: '2026-10-01T08:00:00.000Z',
      audio: { batch: { id: 'pe1', title: 'PE1', volume: n, volumes: 3, members: [{ order: n, filename: `week${n}.m4a`, hash: String(n) }] }, sourceIds: ['pe1-1', 'pe1-2', 'pe1-3'] } });
  });
  assert.equal(groupSourcesByDocument((await store.read()).sources)[0].title, 'PE1');
  const result = await call('materials.document.rename', { sourceId: 'pe1-2', title: 'Programming Exam 1' });
  assert.equal(result.status, 'renamed');
  const state = await store.read();
  assert.deepEqual(state.sources.map(source => source.title), [1, 2, 3].map(n => `Programming Exam 1 · 中英对照逐字稿 (${n}/3)`));
  assert.ok(state.sources.every(source => source.audio.batch.title === 'Programming Exam 1'));
  assert.deepEqual(state.sources.map(source => source.audio.batch.members[0].filename), ['week1.m4a', 'week2.m4a', 'week3.m4a']);
  const [item] = groupSourcesByDocument(state.sources);
  assert.equal(item.title, 'Programming Exam 1');
  assert.equal(item.renamedFrom, 'PE1');
  assert.deepEqual(item.sourceIds, ['pe1-1', 'pe1-2', 'pe1-3']);
});

test('importing a deck JSON that names the old title still finds the renamed source', async t => {
  const { call, store } = await fixture(t);
  const imported = await importMd(call);
  await call('materials.document.rename', { documentId: imported.documentId, title: 'Operating systems, week 1' });
  const sources = (await store.read()).sources;
  const quote = 'A process is the unit of resource allocation in an operating system.';
  const json = title => JSON.stringify({ title: 'Imported', cards: [{ kind: 'flashcard', prompt: 'What is a process?', answer: 'The unit of resource allocation.', citations: [{ sourceTitle: title, quote }] }] });
  for (const title of ['os-notes.md', 'Operating systems, week 1']) {
    const { deck } = prepareJsonImport(json(title), sources);
    assert.deepEqual(deck.cards[0].citations, [{ sourceId: sources[0].id, quote }], title);
  }
  assert.deepEqual(prepareJsonImport(json('some other title'), sources).deck.cards[0].citations, []);
});

test('a revised original attached after a rename keeps the document title', async t => {
  const { call, store } = await fixture(t);
  const first = await importPdf(call);
  await call('materials.document.rename', { documentId: first.documentId, title: 'Databases lecture 3' });
  const revised = await makeTextPdf([...LECTURE_PAGES, ['Bitmap indexes', 'A bitmap index keeps one bit vector per distinct value of a column.']]);
  const attached = await call('materials.document.attach', { documentId: first.documentId, dataBase64: revised.toString('base64'), filename: 'lecture.pdf' });
  assert.notEqual(attached.revision, first.revision);
  const state = await store.read();
  assert.equal(state.documents[0].title, 'Databases lecture 3');
  const fresh = state.sources.filter(source => source.document.materialRevision === attached.revision);
  assert.equal(fresh.length, 4);
  assert.ok(fresh.every(source => source.title.startsWith('Databases lecture 3 · p.')), fresh.map(source => source.title).join('|'));
  assert.equal(groupSourcesByDocument(fresh)[0].title, 'Databases lecture 3');
});

test('the document list searches the new title and the old file name', async t => {
  const { call } = await fixture(t);
  const imported = await importMd(call);
  await call('materials.document.rename', { documentId: imported.documentId, title: 'Process theory' });
  assert.equal((await call('materials.document.list', { query: 'process theory' })).total, 1);
  assert.equal((await call('materials.document.list', { query: 'os-notes' })).total, 1);
  assert.equal((await call('materials.document.list', { query: 'unrelated' })).total, 0);
});

test('a backup carries the new title and restoring it keeps the rename', async t => {
  const { call, root } = await fixture(t);
  const imported = await importMd(call);
  await call('materials.document.rename', { documentId: imported.documentId, title: 'Kept after restore' });
  const backup = JSON.parse(JSON.stringify(await new StudyService(root).call('export')));
  const target = await mkdtemp(join(tmpdir(), 'document-rename-restored-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  await new StudyService(target).call('restore', { state: backup });
  const restored = new Store(target);
  restored.registerCollection('documents');
  const state = await restored.read();
  assert.equal(state.documents[0].title, 'Kept after restore');
  assert.deepEqual(state.documents[0].titleHistory, ['os-notes.md']);
  assert.equal(groupSourcesByDocument(state.sources)[0].title, 'Kept after restore');
  assert.equal(groupSourcesByDocument(state.sources)[0].renamedFrom, 'os-notes.md');
});

test('what other records snapshotted when they were made is left as it was', async t => {
  const { call, store } = await fixture(t);
  const imported = await importMd(call);
  await store.update(state => {
    state.inbox = [{ id: 'm1', kind: 'audio-result', jobId: 'j1', filename: 'os-notes.md', sourceIds: imported.sourceIds, detail: 'done', at: '2026-10-01T00:00:00.000Z', read: true }];
    state.decks.push({ id: 'd', title: 'From os-notes.md', cards: [{ id: 'c', kind: 'flashcard', prompt: 'Q', answer: 'A', topic: 'os-notes.md', citations: [{ sourceId: imported.sourceIds[0], quote: 'unit of resource allocation' }] }] });
  });
  await call('materials.document.rename', { documentId: imported.documentId, title: 'Renamed' });
  const state = await store.read();
  assert.equal(state.inbox[0].filename, 'os-notes.md');
  assert.equal(state.decks[0].title, 'From os-notes.md');
  assert.equal(state.decks[0].cards[0].topic, 'os-notes.md');
  assert.deepEqual(Object.keys(state.decks[0].cards[0].citations[0]).sort(), ['quote', 'sourceId']);
});
