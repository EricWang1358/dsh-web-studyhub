/* #461, the rest of it: a rebuilt outline does not move the learner's own text behind their back. The book page asks course.book.open with `holdRebuild`:
   while a rebuild would move or park their text the answer is the preview (old title -> new title, the first line of the body the new title would hold, what
   goes to 未归位) and nothing is written. Applied (or brought up to date by any other path), course.book.rebuild.undo takes back this one rebuild and nothing
   else, and refuses clearly, leaving everything as it is, when the book changed since. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { firstBodyLine, REBUILD_FILE } from '../lib/course-book-moves.js';
import { MOVES_KEPT, openCourseBook } from '../lib/course-book-files.js';
import { pushHistory, readHistory, readRebuild } from '../lib/course-book-history.js';
import { courseOutlineMaterial, currentCourseOutline, materialsFingerprint, OUTLINE_LIMITS } from '../lib/course-outline-book.js';
import { currentCourseNotes, courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { StudyService } from '../lib/service.js';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

const leaves = nodes => nodes.flatMap(node => (node.leaf ? [node] : leaves(node.children)));
const bookOf = state => state.sources.find(source => source.provenance === 'course-book-doc');
const lectureKey = sources => groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
const otherKey = sources => groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l3-p1')).key;

function outlineOf(state, nodes, createdAt) {
  return { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes, other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt };
}
const firstNodes = lecture => [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] },
  { id: 'who', title: 'Stakeholders and views', anchors: [`${lecture}#1`, `${lecture}#2`] }] }];
// "What architects do" keeps its pages under a new name; only one page of "Stakeholders and views" is in a point that is mostly another lecture: held.
const secondNodes = (lecture, other) => [{ id: 'k1', title: 'Introduction', children: [{ id: 'k2', title: 'The architect\'s job', anchors: [`${lecture}#0`] },
  { id: 'k3', title: 'Databases state failure conditions', anchors: [`${lecture}@s2-2`, other] }] }];

/** A service over a library with an outline and a book whose first two points hold the learner's notes. */
async function setUp(t) {
  const root = await privateRoot(t, 'course-book-rebuild-');
  const service = new StudyService(root, {});
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); state.focus = { mode: 'class', course: COURSE }; });
  const lecture = lectureKey(sources), other = otherKey(sources);
  let first;
  await service.store.update(state => { first = outlineOf(state, firstNodes(lecture), '2026-10-09T00:00:00.000Z'); state.sources.push(first); });
  const opened = await service.call('course.book.open', { course: COURSE });
  const [what, who] = leaves(opened.nodes);
  await service.call('course.book.save', { course: COURSE, file: what.files.mine, text: '# My heading\n\nNote on what architects do.', version: opened.files[what.files.mine].version });
  const saved = await service.call('course.book.save', { course: COURSE, file: who.files.mine, text: 'A long note on stakeholders and views.', version: opened.files[who.files.mine].version });
  const rebuild = (nodes = secondNodes(lecture, other), at = '2026-10-10T00:00:00.000Z') => service.store.update(state => {
    const made = outlineOf(state, nodes, at), now = currentCourseOutline(state.sources, COURSE);
    now.archived = true;
    state.sources.push(made);
    return made.id;
  });
  return { root, service, first, what, who, saved, lecture, other, rebuild };
}
const view = service => service.store.read();
const docOf = async service => structuredClone(bookOf(await view(service)).bookDoc);

test('the first line of a body: blank lines, ids, labels and the 练 5 道 link are skipped, a heading says what it is about, a long line is cut', () => {
  assert.equal(firstBodyLine(['\n\n## 云原生架构 <!-- sh:id h25 -->\n\nbody']), '云原生架构');
  assert.equal(firstBodyLine(['', '**知识梳理**\n\n- 第一点 [^1]\n']), '第一点');
  assert.equal(firstBodyLine(['**考情** 样卷没有考到这一点。\n\n*承上：* 讲解的第一句。']), '承上： 讲解的第一句。');
  assert.equal(firstBodyLine(['[练 5 道：x](studyhub://practice?heading=h1&n=5) · [本节问答：x](studyhub://qa?heading=h1)']), '');
  assert.equal(firstBodyLine(['<!-- sh:qa card=a fid=b -->\n问：什么是分层？']), '问：什么是分层？');
  assert.equal(firstBodyLine(['[^1]: [「引文」](studyhub://source/x)']), '');
  assert.equal(firstBodyLine(['x'.repeat(300)]).length, 121);
  assert.equal(firstBodyLine([null, undefined, '   ']), '');
});

test('the page\'s open holds a rebuild that would move the learner\'s text: the preview says from, to, the first line and what waits in 未归位, and nothing is written', async t => {
  const { service, rebuild, saved } = await setUp(t);
  const before = await docOf(service);
  const newId = await rebuild();
  const preview = await service.call('course.book.open', { course: COURSE, holdRebuild: true });
  assert.equal(preview.status, 'rebuild-pending');
  assert.equal(preview.moves.outlineId, newId);
  assert.deepEqual(preview.moves.list, [{ from: 'What architects do', to: 'The architect\'s job', folded: false, share: 1, own: true, first: 'My heading' }]);
  assert.equal(preview.moves.held, 1);
  assert.equal(preview.moves.heldList[0].from, 'Stakeholders and views');
  assert.equal(preview.moves.heldList[0].closest, 'Databases state failure conditions');
  assert.equal(preview.moves.heldList[0].first, 'A long note on stakeholders and views.');
  assert.equal(preview.moves.undoable, false, 'nothing moved yet: nothing to undo');
  assert.equal(preview.nodes, undefined, 'the preview is not a book');
  assert.deepEqual(await docOf(service), before, 'the book is exactly as it was');
  assert.equal((await service.call('course.book.revision', { course: COURSE })).revision, saved.revision);
  // Going on is the ordinary open.
  const book = await service.call('course.book.open', { course: COURSE });
  assert.equal(book.status, 'ok');
  assert.equal(book.moves.undoable, true);
  assert.equal(book.moves.list[0].first, 'My heading');
  assert.match(book.unplaced.text, /A long note on stakeholders and views\./);
  const job = leaves(book.nodes).find(node => node.title === 'The architect\'s job');
  assert.match(job.mine, /Note on what architects do\./);
  // Held once only: the book now follows the outline, so the page's open reads it.
  assert.equal((await service.call('course.book.open', { course: COURSE, holdRebuild: true })).status, 'ok');
});

test('a rebuild that moves nothing of the learner\'s is not held; a book without their text goes straight on', async t => {
  const root = await privateRoot(t, 'course-book-rebuild-plain-');
  const service = new StudyService(root, {});
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); state.focus = { mode: 'class', course: COURSE }; });
  const lecture = lectureKey(sources), other = otherKey(sources);
  await service.store.update(state => { state.sources.push(outlineOf(state, firstNodes(lecture), '2026-10-09T00:00:00.000Z')); });
  await service.call('course.book.open', { course: COURSE });
  await service.store.update(state => { currentCourseOutline(state.sources, COURSE).archived = true; state.sources.push(outlineOf(state, secondNodes(lecture, other), '2026-10-10T00:00:00.000Z')); });
  const book = await service.call('course.book.open', { course: COURSE, holdRebuild: true });
  assert.equal(book.status, 'ok');
  assert.equal(book.moves.list.length, 1, 'still recorded');
  assert.equal(book.moves.list[0].own, undefined);
});

test('undo takes back this one rebuild: every text, title, heading id and 未归位 as before; the outline before it is current again; a second undo is refused', async t => {
  const { root, service, rebuild, first, what, who } = await setUp(t);
  const before = await docOf(service), newId = await rebuild();
  const applied = await service.call('course.book.open', { course: COURSE });
  assert.ok(await readRebuild(root, COURSE), 'the state before the rebuild is kept beside the history');
  assert.equal((await service.call('course.book.revision', { course: COURSE })).revision, applied.revision);
  const undone = await service.call('course.book.rebuild.undo', { course: COURSE, outlineId: newId });
  assert.equal(undone.status, 'ok');
  assert.equal(undone.write, 'undone');
  assert.ok(undone.revision > applied.revision, 'the revision moves on, so an open page reads the book again');
  const after = await docOf(service);
  for (const name of Object.keys(before.files)) assert.equal(after.files[name]?.text, before.files[name].text, name);
  assert.deepEqual(Object.keys(after.files).sort(), Object.keys(before.files).sort());
  assert.deepEqual(after.manifest, before.manifest);
  assert.equal(after.outlineId, first.id);
  const [backWhat, backWho] = leaves(undone.nodes);
  assert.deepEqual([backWhat.hid, backWhat.title, backWho.hid, backWho.title], [what.hid, what.title, who.hid, who.title]);
  assert.match(backWhat.mine, /Note on what architects do\./);
  assert.equal(backWho.mine, 'A long note on stakeholders and views.');
  assert.equal(undone.unplaced.text.trim(), '');
  const state = await view(service);
  assert.equal(currentCourseOutline(state.sources, COURSE).id, first.id);
  assert.equal(state.sources.find(source => source.id === newId).archived, true, 'the new outline stays in the library, archived: nothing is deleted');
  assert.equal(await readRebuild(root, COURSE), null);
  await assert.rejects(service.call('course.book.rebuild.undo', { course: COURSE, outlineId: newId }), error => error.code === 'course-book-rebuild-conflict');
  assert.deepEqual((await service.call('course.book.open', { course: COURSE })).status, 'ok');
  assert.equal((await docOf(service)).outlineId, first.id, 'opening again does not rebuild what was undone');
});

test('undo is refused when the book changed after the rebuild, and leaves the edit, the moved text and the outline exactly as they are', async t => {
  const { service, rebuild } = await setUp(t);
  const newId = await rebuild();
  const applied = await service.call('course.book.open', { course: COURSE });
  const job = leaves(applied.nodes).find(node => node.title === 'The architect\'s job');
  await service.call('course.book.save', { course: COURSE, file: job.files.mine, text: `${job.mine}\n\nWritten after the rebuild.`, version: applied.files[job.files.mine].version });
  const before = await docOf(service);
  await assert.rejects(service.call('course.book.rebuild.undo', { course: COURSE, outlineId: newId }), error => {
    assert.equal(error.code, 'course-book-rebuild-conflict');
    assert.match(error.message, /改过/);
    assert.match(error.message, /changed/);
    return true;
  });
  assert.deepEqual(await docOf(service), before);
  assert.match((await service.call('course.book.open', { course: COURSE })).nodes.flatMap(function all(node) { return [node, ...node.children.flatMap(all)]; }).find(node => node.hid === job.hid).mine, /Written after the rebuild\./);
  assert.equal(currentCourseOutline((await view(service)).sources, COURSE).id, newId);
  const page = await service.call('course.book.open', { course: COURSE });
  assert.equal(page.moves.undoable, false, 'the page does not offer it either');
});

test('undo is refused when something wrote a file without moving the revision: the text is compared, not only the number', async t => {
  const { service, rebuild } = await setUp(t);
  const newId = await rebuild();
  const applied = await service.call('course.book.open', { course: COURSE });
  const job = leaves(applied.nodes).find(node => node.title === 'The architect\'s job');
  await service.store.update(state => { bookOf(state).bookDoc.files[job.files.mine].text += '\n\nA write that forgot the revision.'; });
  await assert.rejects(service.call('course.book.rebuild.undo', { course: COURSE, outlineId: newId }), error => error.code === 'course-book-rebuild-conflict');
  assert.match((await docOf(service)).files[job.files.mine].text, /A write that forgot the revision\./);
});

test('undo is refused after another rebuild, for an outline that is not the current one, and when the record of the state before is gone', async t => {
  const { root, service, rebuild, lecture, other } = await setUp(t);
  const newId = await rebuild();
  await service.call('course.book.open', { course: COURSE });
  await assert.rejects(service.call('course.book.rebuild.undo', { course: COURSE, outlineId: 'course-outline-nope' }), error => error.code === 'course-book-rebuild-conflict');
  await assert.rejects(service.call('course.book.rebuild.undo', { course: COURSE }), error => error.code === 'course-book-rebuild-conflict');
  // The kept state gone (a backup restored elsewhere): refused, nothing changes.
  const { rm } = await import('node:fs/promises');
  const folder = join(root, 'book-history'), names = (await readdir(folder)).filter(name => name.endsWith('.rebuild.json'));
  assert.equal(names.length, 1);
  const before = await docOf(service);
  await rm(join(folder, names[0]));
  await assert.rejects(service.call('course.book.rebuild.undo', { course: COURSE, outlineId: newId }), error => error.code === 'course-book-rebuild-no-undo');
  assert.deepEqual(await docOf(service), before);
  // A later rebuild: the first one can no longer be taken back.
  const third = await rebuild(firstNodes(lecture).map(node => ({ ...node, title: `${node.title} again` })).concat([{ id: 'z1', title: 'More', children: [{ id: 'z2', title: 'Other lecture', anchors: [other] }] }]), '2026-10-11T00:00:00.000Z');
  await assert.rejects(service.call('course.book.rebuild.undo', { course: COURSE, outlineId: newId }), error => error.code === 'course-book-rebuild-conflict');
  assert.equal(currentCourseOutline((await view(service)).sources, COURSE).id, third);
});

test('the rebuild left pending can be given up: the outline before it is current again, not one file of the book changes', async t => {
  const { service, rebuild, first } = await setUp(t);
  const before = await docOf(service), newId = await rebuild();
  await assert.rejects(service.call('course.book.rebuild.undo', { course: COURSE, outlineId: 'course-outline-nope' }), error => error.code === 'course-book-rebuild-conflict');
  const book = await service.call('course.book.rebuild.undo', { course: COURSE, outlineId: newId });
  assert.deepEqual([book.status, book.write], ['ok', 'discarded']);
  const after = await docOf(service);
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(after.manifest, before.manifest);
  assert.equal(after.outlineId, first.id);
  const state = await view(service);
  assert.equal(currentCourseOutline(state.sources, COURSE).id, first.id);
  assert.equal(state.sources.find(source => source.id === newId).archived, true);
  assert.equal((await service.call('course.book.open', { course: COURSE, holdRebuild: true })).status, 'ok');
});

test('undo of a rebuild a book update made with its notes: the explanations written before it are current again', async t => {
  const { service, rebuild, lecture, first } = await setUp(t);
  const notes = (outlineId, id, text, supersedes) => courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId, leaves: [{ id, title: id, anchors: [`${lecture}#0`],
    body: { fingerprint: 'abcdef0123456789', points: [text], explain: text, cites: [] } }], counts: {}, ...(supersedes ? { supersedes } : {}) });
  const older = notes(first.id, 'what', 'Explanation for the old point.');
  await service.store.update(state => { state.sources.push({ ...older, createdAt: '2026-10-09T01:00:00.000Z' }); });
  await service.call('course.book.open', { course: COURSE });
  const newId = await rebuild();
  const newer = notes(newId, 'k2', 'Explanation for the new point.', older.id);
  await service.store.update(state => { state.sources.find(source => source.id === older.id).archived = true; state.sources.push({ ...newer, createdAt: '2026-10-10T01:00:00.000Z' }); });
  const applied = await service.call('course.book.open', { course: COURSE });
  assert.match(leaves(applied.nodes).find(node => node.title === 'The architect\'s job').gen, /Explanation for the new point/);
  const undone = await service.call('course.book.rebuild.undo', { course: COURSE, outlineId: newId });
  const state = await view(service);
  assert.equal(currentCourseNotes(state.sources, COURSE).id, older.id);
  assert.equal(state.sources.find(source => source.id === newer.id).archived, true);
  assert.match(leaves(undone.nodes).find(node => node.title === 'What architects do').gen, /Explanation for the old point/);
});

test('undo keeps the 读完了 / 已看 marks made since (they move no revision), and the book\'s own titles as they were', async t => {
  const { service, rebuild, what } = await setUp(t);
  const version = (await service.call('course.book.open', { course: COURSE })).structureVersion;
  await service.call('course.book.rename', { course: COURSE, hid: what.hid, title: 'My own title', version });
  const newId = await rebuild();
  await service.call('course.book.open', { course: COURSE });
  await service.call('book.crunch.mark', { course: COURSE, hid: what.hid, kind: 'read' });
  const undone = await service.call('course.book.rebuild.undo', { course: COURSE, outlineId: newId });
  assert.equal(leaves(undone.nodes).find(node => node.hid === what.hid).title, 'My own title');
  assert.ok((await docOf(service)).marks.read[what.hid], 'the mark stays');
});

test('every move of a book at the outline limit is kept; held and gone points are listed; a list never falls back to a short cut', () => {
  assert.ok(MOVES_KEPT >= OUTLINE_LIMITS.nodes, 'a book at the outline\'s limit is listed in full');
});

test('a point gone from the outline with the learner\'s text is said too (it waits in 未归位)', () => {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = lectureKey(sources), other = otherKey(sources);
  const first = outlineOf(state, firstNodes(lecture), '2026-10-09T00:00:00.000Z');
  state.sources.push(first);
  openCourseBook(state, {});
  const record = bookOf(state), [what] = leaves(record.bookDoc.manifest.nodes);
  record.bookDoc.files[`${what.id}.mine.md`].text = 'A note on a lecture that left the course.';
  first.archived = true;
  state.sources.push(outlineOf(state, [{ id: 'k', title: 'Other', children: [{ id: 'k1', title: 'Other lecture', anchors: [other] }] }], '2026-10-10T00:00:00.000Z'));
  const book = openCourseBook(state, {}, { write: false });
  assert.equal(book.rebuildPending, true);
  assert.deepEqual([book.moves.gone, book.moves.goneList], [1, [{ from: 'What architects do', first: 'A note on a lecture that left the course.' }]]);
});

test('the kept state is never written to the book\'s version list: not a version of a file, not in an answer, one per course, the latest rebuild\'s', async t => {
  const { root, service, rebuild } = await setUp(t);
  await rebuild();
  const applied = await service.call('course.book.open', { course: COURSE });
  assert.ok(!applied.replaced.some(item => item.file === REBUILD_FILE), 'the answer does not carry the whole book again');
  assert.ok(!(await readHistory(root, COURSE)).some(entry => entry.file === REBUILD_FILE));
  assert.equal(applied.history[REBUILD_FILE], undefined);
  await pushHistory(root, COURSE, [{ file: REBUILD_FILE, version: 1, text: '{"replaced":true}' }]);
  assert.deepEqual(await readRebuild(root, COURSE), { replaced: true });
});

test('a list saved again after it was archived is current again (an identical outline made again after an undo must not leave the course without one)', async t => {
  const { service, rebuild, lecture, other } = await setUp(t);
  const newId = await rebuild();
  await service.call('course.book.rebuild.undo', { course: COURSE, outlineId: newId });
  const state = await view(service), record = state.sources.find(source => source.id === newId), old = currentCourseOutline(state.sources, COURSE);
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: [structuredClone({ ...record, archived: undefined })], archive: [old.id] });
  assert.equal(currentCourseOutline((await view(service)).sources, COURSE).id, newId);
  assert.ok(lecture && other);
});
