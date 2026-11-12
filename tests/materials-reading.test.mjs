/* Which chapters of a material the learner has read (materials.reading.*, #1014): kept in the study library beside the marks and the 批注, per document
   revision and chapter, so another device or browser sees the same ✓. A fake store on disk; no model, no network. A restart (a new Store and new
   operations over the same folder) reads the same result; a new revision keeps the chapters that still match and drops the rest silently. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.js';
import { createMaterialsOperations } from '../lib/contexts/materials/operations.js';
import { chapterRef, readChapterIds, READING_LIMITS } from '../lib/contexts/materials/reading-model.js';
import { readingSchemas } from '../lib/contexts/materials/reading-contracts.js';

const page = n => `Page ${n} explains part ${n} of the lecture in plain words.`;
const markdown = (...lines) => `# Notes\n\n${lines.join('\n\n')}\n`;
const CHAPTERS = [
  { id: 'chapter-0', title: 'Demand', startPage: 1, endPage: 20 },
  { id: 'chapter-1', title: 'Supply', startPage: 21, endPage: 40 },
  { id: 'chapter-2', title: 'Markets', startPage: 41, endPage: 60 },
];

function operationsOver(root) {
  const store = new Store(root);
  return createMaterialsOperations({ root,
    read: async () => { const state = await store.read(); return structuredClone({ sources: state.sources, documents: state.documents || [] }); },
    update: fn => store.update(async state => {
      const own = { sources: state.sources, documents: state.documents || [] };
      const result = await fn(own); state.sources = own.sources; state.documents = own.documents; return result;
    }) });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'materials-reading-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  let ops = operationsOver(root);
  const raw = (action, args = {}) => ops.handlers[action](args, {});
  const reading = (action, args = {}) => raw(`materials.reading.${action}`, args);
  const imported = async (body = markdown(page(1), page(2)), filename = 'notes.md', documentId) => {
    const result = await raw('materials.document.import', { filename, ...(documentId ? { documentId } : {}), dataBase64: Buffer.from(body).toString('base64') });
    return raw('materials.document.get', { id: result.documentId });
  };
  return { root, raw, reading, imported, restart: () => { ops = operationsOver(root); } };
}

test('a chapter read is kept in the library and read back after a restart; 标为未读 takes it back', async t => {
  const f = await fixture(t), document = await f.imported();
  // The reader names its material by the source it opened (as materials.document.get does), so a material with no record of its own works too.
  const id = { sourceId: document.sources[0].id, revision: document.revision };
  assert.deepEqual((await f.reading('get', { ...id, chapters: CHAPTERS })).read, [], 'nothing read yet');
  const saved = await f.reading('save', { ...id, chapters: CHAPTERS, read: [CHAPTERS[0], CHAPTERS[2]] });
  assert.deepEqual(saved.read, ['chapter-0', 'chapter-2']);
  f.restart();
  const again = await f.reading('get', { ...id, chapters: CHAPTERS });
  assert.deepEqual(again.read, ['chapter-0', 'chapter-2'], 'the same after a restart');
  assert.equal(again.count, 2);
  // Saving the same thing twice changes nothing (idempotent).
  await f.reading('save', { ...id, chapters: CHAPTERS, read: [CHAPTERS[0]] });
  assert.deepEqual((await f.reading('get', { ...id, chapters: CHAPTERS })).read, ['chapter-0', 'chapter-2']);
  await f.reading('save', { ...id, chapters: CHAPTERS, unread: [CHAPTERS[0]] });
  f.restart();
  assert.deepEqual((await f.reading('get', { ...id, chapters: CHAPTERS })).read, ['chapter-2'], '标为未读 is kept too');
  // The document as the reader gets it never carries the record.
  const got = await f.raw('materials.document.get', { id: document.documentId });
  assert.ok(got.versions.every(version => !('reading' in version)));
  assert.ok(got.sources.every(source => !('reading' in source)));
});

test('a chapter counts only while its id, title and pages still match (an applied outline or a new revision); the rest is dropped silently', async t => {
  const f = await fixture(t), first = await f.imported(markdown(page(1), page(2)), 'notes.md');
  await f.reading('save', { sourceId: first.sources[0].id, revision: first.revision, chapters: CHAPTERS, read: CHAPTERS });
  const second = await f.imported(markdown(page(1), page(2), page(3)), 'notes.md', first.documentId);
  assert.notEqual(second.revision, first.revision);
  // The new revision: chapter 1 moved (its pages changed), chapter 2 was renamed; chapter 0 is the same.
  const changed = [CHAPTERS[0], { ...CHAPTERS[1], endPage: 42 }, { ...CHAPTERS[2], title: 'Market failure' }];
  const id = { sourceId: second.sources[0].id, revision: second.revision };
  assert.deepEqual((await f.reading('get', { ...id, chapters: changed })).read, ['chapter-0'], 'only the chapter that still matches');
  // The first save in the new revision keeps what matched and forgets the rest; the old revision's record is left alone.
  await f.reading('save', { ...id, chapters: changed, read: [changed[1]] });
  assert.deepEqual((await f.reading('get', { ...id, chapters: changed })).read, ['chapter-0', 'chapter-1']);
  assert.deepEqual((await f.reading('get', { ...id, chapters: CHAPTERS })).read, ['chapter-0'], 'the old shape of chapter 1 is gone from the new revision');
  assert.deepEqual((await f.reading('get', { sourceId: first.sources[0].id, revision: first.revision, chapters: CHAPTERS })).read, ['chapter-0', 'chapter-1', 'chapter-2']);
  // Unread in the new revision is not undone by the older revision's record.
  await f.reading('save', { ...id, chapters: changed, unread: [changed[0], changed[1]] });
  assert.deepEqual((await f.reading('get', { ...id, chapters: changed })).read, []);
});

test('within one revision a save never erases what another window read under another chapter list (gate review of #1021, 4)', async t => {
  const f = await fixture(t), document = await f.imported();
  const id = { sourceId: document.sources[0].id, revision: document.revision };
  // Window A applied an outline: two parts. Window B still shows the old three chapters.
  const parts = [{ id: 'chapter-0', title: 'Part A', startPage: 1, endPage: 10 }, { id: 'chapter-1', title: 'Part B', startPage: 11, endPage: 60 }];
  await f.reading('save', { ...id, chapters: parts, read: [parts[1]] });
  await f.reading('save', { ...id, chapters: CHAPTERS, read: [CHAPTERS[1], CHAPTERS[2]] });
  assert.deepEqual((await f.reading('get', { ...id, chapters: parts })).read, ['chapter-1'], 'window A still sees its part read');
  assert.deepEqual((await f.reading('get', { ...id, chapters: CHAPTERS })).read, ['chapter-1', 'chapter-2'],
    'window B sees its own chapter-1 (another title and pages) read too: both are kept (re-review L1)');
  // 标为未读 takes back only the chapter as it is shown, not another chapter of the same id.
  await f.reading('save', { ...id, chapters: CHAPTERS, unread: [CHAPTERS[1]] });
  assert.deepEqual((await f.reading('get', { ...id, chapters: CHAPTERS })).read, ['chapter-2']);
  assert.deepEqual((await f.reading('get', { ...id, chapters: parts })).read, ['chapter-1'], 'window A keeps its part');
  await assert.rejects(f.reading('save', { ...id, chapters: parts, unread: ['chapter-1'] }), /unread must list chapters/);
});

test('a save on an older revision never takes away what a newer one read (re-review of #1021, R1)', async t => {
  const f = await fixture(t), first = await f.imported(markdown(page(1), page(2)), 'notes.md');
  const second = await f.imported(markdown(page(1), page(2), page(3)), 'notes.md', first.documentId);
  const r1 = { sourceId: first.sources[0].id, revision: first.revision }, r2 = { sourceId: second.sources[0].id, revision: second.revision };
  const changed = [{ ...CHAPTERS[0], title: 'Demand again' }, CHAPTERS[1], CHAPTERS[2]];
  await f.reading('save', { ...r1, chapters: CHAPTERS, read: [CHAPTERS[0]] });
  await f.reading('save', { ...r2, chapters: changed, read: [changed[1], changed[2]] });
  // A citation opens the old revision (or an old window is still open): it saves there.
  await f.reading('save', { ...r1, chapters: CHAPTERS, read: [CHAPTERS[1]] });
  await f.reading('save', { ...r1, chapters: CHAPTERS, unread: [CHAPTERS[0]] });
  f.restart();
  assert.deepEqual((await f.reading('get', { ...r2, chapters: changed })).read, ['chapter-1', 'chapter-2'], 'the newer revision still reads both');
  assert.deepEqual((await f.reading('get', { ...r1, chapters: CHAPTERS })).read, ['chapter-1']);
});

test('at most the newest three revision records are kept, never the current revision\'s (re-review of #1021, R1)', async t => {
  const f = await fixture(t), revisions = [];
  let document = await f.imported(markdown(page(1)), 'notes.md');
  revisions.push(document);
  for (let n = 2; n <= 5; n += 1) { document = await f.imported(markdown(...Array.from({ length: n }, (_, i) => page(i + 1))), 'notes.md', document.documentId); revisions.push(document); }
  const current = revisions.at(-1), idOf = doc => ({ sourceId: doc.sources[0].id, revision: doc.revision });
  // The current revision is saved first (the oldest write), then four older ones.
  await f.reading('save', { ...idOf(current), chapters: CHAPTERS, read: [CHAPTERS[0]] });
  for (const doc of revisions.slice(0, 4)) await f.reading('save', { ...idOf(doc), chapters: CHAPTERS, read: [CHAPTERS[1]] });
  const stored = (await new Store(f.root).read()).documents.find(item => item.id === current.documentId);
  const kept = stored.versions.filter(version => version.reading).map(version => version.revision);
  assert.equal(kept.length, 3, `three records (${kept.length})`);
  assert.ok(kept.includes(current.revision), 'the current revision keeps its record');
  assert.deepEqual(kept.filter(revision => revision !== current.revision).sort(), [revisions[2].revision, revisions[3].revision].sort(), 'and the two newest writes');
  assert.deepEqual((await f.reading('get', { ...idOf(current), chapters: CHAPTERS })).read, ['chapter-0']);
});

test('a converted book with no materials record of its own keeps its chapters read on its first source, out of the library snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'materials-reading-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const store = new Store(root);
  await store.update(state => {
    for (let n = 1; n <= 3; n += 1) state.sources.push({ id: `book-p${n}`, title: `Book · p.${n}`, text: page(n), createdAt: '2026-11-01T08:00:00.000Z',
      document: { id: 'book-hash', materialId: 'document-book', page: n, totalPages: 3, format: 'pdf', origin: 'converted', filename: 'book.pdf' } });
  });
  const ops = operationsOver(root), call = (action, args) => ops.handlers[action](args, {});
  const document = await call('materials.document.get', { sourceId: 'book-p2' });
  const id = { sourceId: 'book-p2', revision: document.revision };
  await call('materials.reading.save', { ...id, chapters: CHAPTERS, read: [CHAPTERS[1]] });
  assert.deepEqual((await operationsOver(root).handlers['materials.reading.get']({ sourceId: 'book-p1', revision: document.revision, chapters: CHAPTERS }, {})).read, ['chapter-1']);
  const { stampSegmentations } = await import('../lib/document-outline.js');
  assert.ok(stampSegmentations((await store.read()).sources, []).every(source => !('reading' in source)), 'the snapshot never carries the record');
});

test('bad input is refused where it enters, and the record has a limit', async t => {
  assert.equal(chapterRef({ id: '', title: 'x', startPage: 1, endPage: 2 }), null);
  assert.equal(chapterRef({ id: 'chapter-1', title: 'x', startPage: 3, endPage: 2 }), null, 'a range that ends before it starts');
  assert.deepEqual(chapterRef({ id: 'chapter-1', title: ' Supply ', startPage: 21, endPage: 40, extra: 1 }), { id: 'chapter-1', title: 'Supply', startPage: 21, endPage: 40 });
  assert.deepEqual(readChapterIds([{ ...CHAPTERS[0], at: 'x' }], null), ['chapter-0'], 'without the chapters to match, what is kept is read as it is');
  const f = await fixture(t), document = await f.imported(), id = { sourceId: document.sources[0].id, revision: document.revision };
  await assert.rejects(f.reading('save', { ...id, read: 'chapter-0' }), /read must be a list/);
  const many = Array.from({ length: READING_LIMITS.chapters + 5 }, (_, index) => ({ id: `block-${index}`, title: '', startPage: index + 1, endPage: index + 1 }));
  const saved = await f.reading('save', { ...id, read: many });
  assert.equal(saved.count, READING_LIMITS.chapters, 'at most the limit is kept');
});

test('the contracts name the operations the handlers answer', () => {
  assert.deepEqual(Object.keys(readingSchemas).sort(), ['materials.reading.get', 'materials.reading.save']);
});
