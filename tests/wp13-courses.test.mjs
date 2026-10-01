/* WP13 · course as a first-class entity. A course gets a stable id, a record of
   its own (exam profile, examiner guidance, focus topics) and transactional
   rename/merge, while every older reader keeps seeing course names. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { Store, LATEST_VERSION } from '../lib/store.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { courseIdFor, courseIdsOf, courseOf, courseIdOf, courseEntities, examProfile } from '../lib/courses.js';
import { courseOf as legacyCourseOf } from '../lib/focus.js';
import { sourcesWithCourses } from '../lib/source-courses.js';
import { sampleAction } from '../lib/sample-library.js';

const text = 'Transactions isolate concurrent changes and preserve database consistency.';
async function directory(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  return root;
}
async function library(t, options = {}) {
  const root = await directory(t, 'study-wp13-');
  const service = new StudyService(root, options);
  t.after(() => service.dispose());
  return service;
}
const card = (id, extra = {}) => ({ id, kind: 'flashcard', topic: 'Transactions', front: `Q ${id}`, back: 'A', ...extra });
/** A card that passes draft validation; it cites source `s`. */
const draftCard = id => ({ id, kind: 'flashcard', topic: 'Transactions', objective: 'Explain isolation', prompt: 'What does isolation guarantee?',
  answer: 'Concurrent transactions do not see each other\'s partial changes.', hint: 'Think about concurrent writers.',
  explanation: 'Isolation keeps concurrent changes apart.', misconception: 'Isolation is not durability.', citations: [{ sourceId: 's', quote: text }] });

/* A library exactly as the previous build (store version 3) wrote it: sharded,
   no `courses` collection and no ids on any record. */
const legacyState = () => ({
  sources: [
    { id: 'explicit', title: 'Lecture', text, courses: ['Databases', 'Systems'] },
    { id: 'inferred', title: 'Reading', text, course: 'Old name only' },
    { id: 'cited', title: 'Cited', text },
  ],
  decks: [
    { id: 'db', title: 'Week 1', course: 'Databases', cards: [card('q1', { citations: [{ sourceId: 'cited', quote: text }] }), card('q2', { requires: [{ deckId: 'db', cardId: 'q1' }] })] },
    { id: 'sys', title: 'Week 2', course: 'Systems', cards: [card('q3')] },
    { id: 'folder', title: 'Legacy folder', folder: 'Networks', cards: [card('q4')] },
    { id: 'loose', title: 'Unassigned', course: '', cards: [card('q5')] },
  ],
  drafts: [{ id: 'draft', title: 'Draft', course: 'Databases', cards: [card('d1')] }],
  attempts: [{ id: 'a1', quiz_id: 'q1', deckId: 'db', grade: 4, timestamp: '2026-09-01T00:00:00.000Z' }],
  runs: [{ id: 'run', purpose: 'course', course: 'Databases', deckId: 'db', mode: 'path', entries: [{ deckId: 'db', card: card('q1') }], index: 0 }],
});
async function writeVersion3Library(root, state = legacyState()) {
  const shards = {};
  for (const [field, values] of Object.entries(state)) {
    await mkdir(join(root, 'shards', field), { recursive: true });
    shards[field] = [];
    if (field === 'attempts') {
      const name = `${field}/0.legacy.json`;
      await writeFile(join(root, 'shards', name), JSON.stringify(values));
      shards[field].push(name);
      continue;
    }
    for (const [index, value] of values.entries()) {
      const name = `${field}/${value.id}.legacy${index}.json`;
      await writeFile(join(root, 'shards', name), JSON.stringify(value));
      shards[field].push(name);
    }
  }
  const manifest = { format: 'study-sharded', version: 3, revision: 7, settings: {}, focus: { mode: 'class', course: 'Databases' }, shards };
  await writeFile(join(root, 'study-workspace.json'), JSON.stringify(manifest, null, 2));
}
const manifestOf = async root => JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
const byName = (state, name) => courseEntities(state).find(course => course.name === name);

test('course ids are deterministic short hashes of the normalised name', () => {
  const id = courseIdFor('Databases');
  assert.match(id, /^course-[0-9a-f]{12}$/);
  assert.equal(courseIdFor('Databases'), id, 'two devices derive the same id');
  assert.equal(courseIdFor('  Databases  '), id, 'surrounding spaces do not change identity');
  assert.equal(courseIdFor('Ｄａｔａｂａｓｅｓ'), id, 'full-width letters normalise (NFKC)');
  assert.equal(courseIdFor('Data   bases'), courseIdFor('Data bases'), 'inner whitespace collapses');
  assert.notEqual(courseIdFor('Systems'), id);
  assert.notEqual(courseIdFor('databases'), id, 'case is kept: differently cased courses stay separate until merged');
});

test('an old library reads with virtual course entities and ids; the first write upgrades it with a backup', async t => {
  const root = await directory(t, 'study-wp13-v3-');
  await writeVersion3Library(root);
  const read = await new Store(root).read();
  assert.equal(LATEST_VERSION, 4);
  assert.equal(read.version, LATEST_VERSION, 'migrated in memory on read');
  assert.equal((await manifestOf(root)).version, 3, 'reading never rewrites the library');
  const names = courseEntities(read).map(course => course.name).sort();
  assert.deepEqual(names, ['Databases', 'Networks', 'Old name only', 'Systems']);
  for (const course of courseEntities(read)) assert.equal(course.id, courseIdFor(course.name));
  assert.equal(read.decks.find(deck => deck.id === 'db').courseId, courseIdFor('Databases'));
  assert.equal(read.decks.find(deck => deck.id === 'folder').courseId, courseIdFor('Networks'), 'a folder that served as course gets the id');
  assert.equal(read.decks.find(deck => deck.id === 'folder').course, undefined, 'without freezing the folder into a course field');
  assert.equal(read.decks.find(deck => deck.id === 'loose').courseId, undefined, 'unassigned stays unassigned');
  assert.deepEqual(read.sources.find(source => source.id === 'explicit').courseIds, [courseIdFor('Databases'), courseIdFor('Systems')]);
  for (const id of ['inferred', 'cited']) {
    const source = read.sources.find(item => item.id === id);
    assert.equal(source.courseIds, undefined, 'inferred courses are never frozen into an assignment');
    assert.equal(source.courses, undefined);
  }

  const service = new StudyService(root);
  t.after(() => service.dispose());
  const before = (await service.call('course.list')).courses;
  assert.deepEqual(before.map(course => course.id).sort(), names.map(courseIdFor).sort(), 'the API sees the same virtual ids');
  await service.call('focus.set', { course: 'Systems' });
  const manifest = await manifestOf(root);
  assert.equal(manifest.version, LATEST_VERSION, 'the first write upgrades the format');
  assert.ok(Array.isArray(manifest.shards.courses) && manifest.shards.courses.length === 4, 'course entities are persisted as item shards');
  const backups = await readdir(join(root, 'backups'));
  assert.ok(backups.some(name => /^study-workspace-v3-/.test(name)), 'the normal upgrade path keeps a pre-upgrade backup');
  const after = (await service.call('course.list')).courses;
  assert.deepEqual(after.map(course => course.id).sort(), before.map(course => course.id).sort(), 'persisting does not change ids');
  const fresh = await new Store(root).read();
  assert.equal(fresh.decks.find(deck => deck.id === 'db').courseId, courseIdFor('Databases'));
  assert.deepEqual(fresh.sources.find(source => source.id === 'explicit').courseIds, [courseIdFor('Databases'), courseIdFor('Systems')]);
  assert.equal(fresh.sources.find(source => source.id === 'inferred').courseIds, undefined);
});

test('old-format readers still see names and the helpers understand both forms', async t => {
  const root = await directory(t, 'study-wp13-readers-');
  await writeVersion3Library(root);
  const service = new StudyService(root);
  t.after(() => service.dispose());
  const state = await service.store.read();
  const deck = state.decks.find(item => item.id === 'db');
  assert.equal(deck.course, 'Databases', 'the legacy name field is still there');
  assert.equal(legacyCourseOf(deck), 'Databases');
  assert.equal(courseOf(deck, state), 'Databases');
  assert.equal(courseIdOf(deck, state), courseIdFor('Databases'));
  assert.equal(courseOf({ course: 'Databases' }, state), 'Databases', 'a record without an id resolves by name');
  assert.equal(courseIdOf({ course: 'Databases' }, state), courseIdFor('Databases'));
  assert.equal(courseOf({ courseId: courseIdFor('Systems') }, state), 'Systems', 'a record with only an id resolves by id');
  assert.equal(courseOf({ folder: 'Networks' }, state), 'Networks');
  assert.equal(courseOf({ course: '' }, state), '');
  assert.equal(courseIdOf({ course: '' }, state), null);
  assert.deepEqual(courseIdsOf({ courses: ['Systems'] }, state), [courseIdFor('Systems')]);
  assert.deepEqual(courseIdsOf({ courseIds: [courseIdFor('Databases')] }, state), [courseIdFor('Databases')]);
  const inferred = sourcesWithCourses(state).find(source => source.id === 'cited');
  assert.deepEqual(inferred.courses, ['Databases']);
  assert.equal(inferred.coursesInferred, true);
  assert.deepEqual(courseIdsOf(state.sources.find(source => source.id === 'cited'), state), [courseIdFor('Databases')], 'inferred ids are derived on read');
  const snapshot = await service.call('snapshot');
  assert.deepEqual(snapshot.decks.find(item => item.id === 'db').course, 'Databases');
  assert.ok(snapshot.focus.courses.some(course => course.name === 'Databases'));
  assert.ok(snapshot.courses.some(course => course.id === courseIdFor('Databases') && course.name === 'Databases'), 'the snapshot carries course entities');
});

test('every write keeps ids in sync with names, and free text still creates a course', async t => {
  const service = await library(t);
  await service.call('source.add', { id: 's', title: 'Lecture', text, courses: ['Databases'] });
  await service.call('draft.save', { deck: { id: 'draft', title: 'Draft', course: 'Brand new course', cards: [draftCard('x1')] } });
  let state = await service.store.read();
  assert.deepEqual(state.sources[0].courseIds, [courseIdFor('Databases')]);
  assert.equal(state.drafts[0].courseId, courseIdFor('Brand new course'));
  assert.ok(state.courses.some(course => course.id === courseIdFor('Brand new course') && !course.virtual), 'free text persisted a course entity');
  await service.call('source.courses.set', { assignments: [{ id: 's', courses: ['Systems'] }] });
  state = await service.store.read();
  assert.deepEqual(state.sources[0].courseIds, [courseIdFor('Systems')], 'an older writer that only changed the name is followed by its id');
  await service.call('source.courses.set', { assignments: [{ id: 's', courses: [] }] });
  state = await service.store.read();
  assert.deepEqual(state.sources[0].courseIds, []);
});

test('course.save, course.get and course.list hold course-level knowledge', async t => {
  const service = await library(t);
  await service.call('source.add', { id: 'brief', title: 'Exam briefing transcript', text, courses: ['Architecture'] });
  const saved = await service.call('course.save', { name: 'Architecture', exam: { format: 'open-book-case', totalMarks: 60, writingMinutes: 120,
    date: '2026-12-01', sections: [{ title: 'Part A', lecturer: 'Dr Tan', marks: 30, topics: ['Microservices', 'Event sourcing'] }, { title: 'Part B', marks: 30, topics: [] }] },
  guidanceSourceIds: ['brief'], focusTopics: ['Migration strategy'] });
  assert.equal(saved.id, courseIdFor('Architecture'));
  assert.equal(saved.exam.format, 'open-book-case');
  assert.deepEqual(saved.guidanceSourceIds, ['brief']);
  assert.ok(saved.createdAt && saved.updatedAt);
  assert.deepEqual(await service.call('course.get', { id: saved.id }), await service.call('course.get', { name: 'Architecture' }));
  assert.equal((await service.call('course.get', { name: 'Architecture' })).exam.sections[0].lecturer, 'Dr Tan');
  const updated = await service.call('course.save', { id: saved.id, name: 'Architecture', focusTopics: ['Strangler fig'] });
  assert.deepEqual(updated.focusTopics, ['Strangler fig']);
  assert.equal(updated.exam.totalMarks, 60, 'fields that are not sent are kept');
  const standalone = await service.call('course.save', { name: 'Exam-only course', exam: { format: 'closed-book' } });
  assert.ok((await service.call('course.list')).courses.some(course => course.id === standalone.id), 'a course can exist before it has decks');
  assert.ok((await service.call('snapshot')).focus.courses.some(course => course.name === 'Exam-only course'), 'and can be chosen in the switcher');
  await assert.rejects(service.call('course.save', { name: 'Bad', exam: { format: 'take-home' } }), /考试形式/);
  await assert.rejects(service.call('course.save', { name: 'Bad', guidanceSourceIds: ['missing'] }), /资料/);
  await assert.rejects(service.call('course.save', { id: saved.id, name: 'Renamed by save' }), /course\.rename|改名/);
  await assert.rejects(service.call('course.get', { name: 'Nope' }), /课程不存在/);
  await assert.rejects(service.call('course.save', { name: 'Architecture', exam: { format: 'closed-book' }, uiLanguage: 'en', id: 'course-000000000000' }), /Course not found/);
});

test('course.profile fills documented defaults', async t => {
  assert.deepEqual(examProfile(undefined), { format: 'other', totalMarks: 40, writingMinutes: 120, readingMinutes: 10, minutesPerMark: 3, sections: [] });
  assert.deepEqual(examProfile({ totalMarks: 60, writingMinutes: 120 }), { format: 'other', totalMarks: 60, writingMinutes: 120, readingMinutes: 10, minutesPerMark: 2, sections: [] });
  const sections = [{ title: 'A', marks: 20, topics: ['x'] }, { title: 'B', marks: 30, topics: [] }];
  assert.deepEqual(examProfile({ format: 'mixed', sections }), { format: 'mixed', totalMarks: 50, writingMinutes: 150, readingMinutes: 13, minutesPerMark: 3, sections });
  assert.deepEqual(examProfile({ writingMinutes: 90 }), { format: 'other', totalMarks: 30, writingMinutes: 90, readingMinutes: 8, minutesPerMark: 3, sections: [] });
  assert.equal(examProfile({ writingMinutes: 180, readingMinutes: 30 }).readingMinutes, 30, 'an explicit reading time wins');
  assert.equal(examProfile({ minutesPerMark: 1.5, totalMarks: 100 }).writingMinutes, 150);
  assert.equal(examProfile({ date: '2026-12-01' }).date, '2026-12-01');

  const service = await library(t);
  await service.call('source.add', { id: 's', title: 'Lecture', text, courses: [] });
  await service.call('draft.save', { deck: { id: 'draft', title: 'Draft', course: 'Databases', cards: [draftCard('x1')] } });
  await service.call('focus.set', { course: 'Databases' });
  const profile = await service.call('course.profile', {});
  assert.deepEqual(profile, { courseId: courseIdFor('Databases'), name: 'Databases', exam: examProfile(undefined), guidanceSourceIds: [], focusTopics: [] });
  assert.deepEqual(await service.call('course.profile', { name: 'Databases' }), profile);
  assert.deepEqual(await service.call('course.profile', { courseId: courseIdFor('Databases') }), profile);
  await assert.rejects(service.call('course.profile', { name: 'Unknown' }), /课程不存在/);
});

async function richLibrary(t) {
  const service = await library(t);
  await service.store.update(s => {
    s.sources.push({ id: 'explicit', title: 'Lecture', text, courses: ['Databases', 'Systems'] },
      { id: 'legacy', title: 'Legacy', text, course: 'Databases', audio: { course: 'Databases' } });
    s.audioResults = [{ id: 'audio', title: 'Recording', text, courses: ['Databases'], audio: { course: 'Databases' } }];
    s.decks.push({ id: 'db', title: 'Week 1', course: 'Databases', cards: [card('q1', { review: { due_at: '2026-10-02T00:00:00.000Z', repetitions: 3 } }), card('q2', { requires: [{ deckId: 'db', cardId: 'q1' }] })],
      editorial: { generation: { course: 'Databases' } } },
    { id: 'folder', title: 'Folder', folder: 'Databases', cards: [card('q3')] },
    { id: 'sys', title: 'Week 2', course: 'Systems', cards: [card('q4', { requires: [{ deckId: 'db', cardId: 'q2' }] })] });
    s.drafts.push({ id: 'draft', title: 'Draft', course: 'Databases', cards: [card('d1')] });
    s.attempts.push({ id: 'a1', quiz_id: 'q1', deckId: 'db', grade: 4 }, { id: 'a2', quiz_id: 'q4', deckId: 'sys', grade: 2 });
    s.runs.push({ id: 'run', purpose: 'course', course: 'Databases', deckId: 'db', mode: 'path', entries: [{ deckId: 'db', card: card('q1') }], index: 0 });
    s.workflowSessions.push({ id: 'flow', course: { name: 'Databases', label: 'Week 1' }, steps: [] });
    s.focus = { mode: 'class', course: 'Databases' };
  });
  return service;
}

test('course.rename updates every collection in one transaction and keeps the old name as an alias', async t => {
  const service = await richLibrary(t);
  const id = courseIdFor('Databases');
  const result = await service.call('course.rename', { id, name: 'Database Systems' });
  assert.equal(result.course.id, id, 'identity survives a rename');
  assert.equal(result.course.name, 'Database Systems');
  assert.deepEqual(result.course.aliases, ['Databases']);
  const s = await service.store.read();
  assert.deepEqual(s.sources.find(x => x.id === 'explicit').courses, ['Database Systems', 'Systems']);
  assert.deepEqual(s.sources.find(x => x.id === 'explicit').courseIds, [id, courseIdFor('Systems')]);
  const legacy = s.sources.find(x => x.id === 'legacy');
  assert.equal(legacy.course, 'Database Systems');
  assert.equal(legacy.audio.course, 'Database Systems');
  assert.equal(legacy.courses, undefined, 'an inferred source stays inferred');
  assert.deepEqual(s.audioResults[0].courses, ['Database Systems']);
  assert.equal(s.decks.find(x => x.id === 'db').course, 'Database Systems');
  assert.equal(s.decks.find(x => x.id === 'db').editorial.generation.course, 'Database Systems');
  assert.equal(s.decks.find(x => x.id === 'folder').course, 'Database Systems', 'a folder-as-course deck follows the rename');
  assert.equal(s.decks.find(x => x.id === 'folder').folder, 'Databases', 'without touching the folder');
  assert.equal(s.decks.find(x => x.id === 'sys').course, 'Systems');
  assert.equal(s.drafts[0].course, 'Database Systems');
  assert.equal(s.runs[0].course, 'Database Systems');
  assert.equal(s.workflowSessions[0].course.name, 'Database Systems');
  assert.equal(s.focus.course, 'Database Systems');
  assert.equal((await service.call('course.get', { name: 'Databases' })).id, id, 'the old name still finds the course');
  assert.equal((await service.call('snapshot')).focus.course, 'Database Systems');
  await assert.rejects(service.call('course.rename', { id, name: 'Systems' }), /同名课程|合并/);
  assert.equal((await service.store.read()).decks.find(x => x.id === 'sys').course, 'Systems');
});

test('a rename that fails mid-commit changes nothing', async t => {
  const service = await richLibrary(t);
  const before = JSON.stringify(await service.call('export'));
  const commit = service.store.commit;
  service.store.commit = async () => { throw new Error('disk full'); };
  await assert.rejects(service.call('course.rename', { id: courseIdFor('Databases'), name: 'Database Systems' }), /disk full/);
  service.store.commit = commit;
  const fresh = new Store(service.store.root);
  const after = await fresh.read();
  assert.equal(after.decks.find(x => x.id === 'db').course, 'Databases');
  assert.equal(after.focus.course, 'Databases');
  assert.deepEqual(after.sources.find(x => x.id === 'explicit').courses, ['Databases', 'Systems']);
  assert.equal(JSON.stringify(await service.call('export')), before, 'not one collection moved');
});

test('course.merge keeps cards, attempts, progress and prerequisites and preserves aliases', async t => {
  const service = await richLibrary(t);
  const into = courseIdFor('Systems'), from = courseIdFor('Databases');
  await service.call('course.save', { id: into, name: 'Systems', exam: { format: 'closed-book', totalMarks: 50 } });
  await service.call('course.save', { id: from, name: 'Databases', focusTopics: ['Isolation'], guidanceSourceIds: ['explicit'] });
  const before = await service.store.read();
  const result = await service.call('course.merge', { from: [from], into });
  assert.equal(result.course.id, into);
  assert.deepEqual(result.course.aliases, ['Databases']);
  assert.deepEqual(result.course.focusTopics, ['Isolation']);
  assert.deepEqual(result.course.guidanceSourceIds, ['explicit']);
  assert.equal(result.course.exam.format, 'closed-book', 'the destination profile wins');
  const s = await service.store.read();
  assert.ok(!s.courses.some(course => course.id === from), 'the merged course is gone');
  assert.deepEqual(s.attempts, before.attempts, 'answers are untouched');
  for (const deck of s.decks) {
    assert.equal(deck.course, 'Systems');
    assert.equal(deck.courseId, into);
    assert.deepEqual(deck.cards, before.decks.find(x => x.id === deck.id).cards, 'cards, review progress and prerequisites are untouched');
  }
  assert.deepEqual(s.sources.find(x => x.id === 'explicit').courses, ['Systems'], 'a source in both courses ends up in one');
  assert.equal(s.focus.course, 'Systems');
  assert.equal(s.runs[0].course, 'Systems');
  assert.equal((await service.call('course.get', { name: 'Databases' })).id, into);
  await assert.rejects(service.call('course.merge', { from: [into], into }), /合并/);
  await assert.rejects(service.call('course.merge', { from: ['course-000000000000'], into }), /课程不存在/);
});

test('the course context sits low in the graph and loads on its own', async t => {
  const root = await directory(t, 'study-wp13-standalone-');
  const storage = new Store(root);
  await storage.update(state => { state.decks = [{ id: 'deck', title: 'Deck', course: 'Databases', cards: [card('q')] }]; });
  const alone = createStudyRuntime(root, { contexts: ['courses'], storage });
  t.after(() => alone.dispose());
  assert.deepEqual(alone.describe().map(context => context.id), ['courses']);
  assert.ok((await alone.invoke('courses.v1', 'state.read')).courses.some(course => course.name === 'Databases'));
  assert.equal((await alone.call('course.profile', { name: 'Databases' })).exam.minutesPerMark, 3);
  const full = createStudyRuntime(root);
  t.after(() => full.dispose());
  const graph = Object.fromEntries(full.describe().map(context => [context.id, context.dependencies]));
  for (const higher of ['library.v1', 'audio.v1', 'generation.v1', 'authoring.v1', 'study.v1', 'coach.v1'])
    assert.ok(!graph.courses.includes(higher), `courses must not depend on ${higher}, so case practice and generation can read course profiles`);
  assert.ok(graph.library.includes('courses.v1'), 'the library coordinator renames and merges across contexts');
});

test('a backup round-trip keeps course ids and profiles', async t => {
  const service = await richLibrary(t);
  await service.call('course.save', { name: 'Databases', id: courseIdFor('Databases'), exam: { format: 'mixed', date: '2026-12-01' } });
  await service.call('course.rename', { id: courseIdFor('Databases'), name: 'DB' });
  const backup = await service.call('export');
  const target = await library(t);
  await target.call('restore', { state: backup });
  const restored = (await target.call('course.list')).courses;
  const original = (await service.call('course.list')).courses;
  assert.deepEqual(restored.map(({ id, name, aliases, exam }) => ({ id, name, aliases, exam })), original.map(({ id, name, aliases, exam }) => ({ id, name, aliases, exam })));
  // An export written before WP13 (version 3, no ids) restores with the same derived ids.
  const old = { ...legacyState(), version: 3, revision: 2, settings: {} };
  const third = await library(t);
  await third.call('restore', { state: old });
  assert.deepEqual((await third.call('course.list')).courses.map(course => course.id).sort(),
    ['Databases', 'Networks', 'Old name only', 'Systems'].map(courseIdFor).sort());
});

test('the sample course comes with a course entity and an exam profile; removing the sample removes it', async t => {
  const service = await library(t);
  const host = { call: (name, input) => service.call(name, input), store: service.store, has: name => service.runtime.hasAction(name) };
  const status = await sampleAction(host, 'sample.load', { language: 'en' });
  const course = await service.call('course.get', { name: status.course });
  assert.equal(course.sample, true);
  assert.equal(course.exam.format, 'open-book-case');
  assert.ok(course.exam.date && Date.parse(course.exam.date) > Date.now(), 'the sample exam is in the future');
  assert.ok(course.exam.sections.length >= 2 && course.exam.sections.every(section => section.topics.length));
  const profile = await service.call('course.profile', { name: status.course });
  assert.equal(profile.exam.totalMarks, course.exam.totalMarks);
  await sampleAction(host, 'sample.remove');
  await assert.rejects(service.call('course.get', { name: status.course }), /课程不存在/);
  assert.ok(!(await service.store.read()).courses.some(item => item.sample));
});
