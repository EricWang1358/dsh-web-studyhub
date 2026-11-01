/* #461, the rest of it: a rebuilt outline does not move the learner's own text behind their back. One gate decides, in openCourseBook: while a rebuild would move or park
   their text every open answers the preview (old title -> new title, the first line of the body the new title would hold, what goes to 未归位) and nothing moves; only
   course.book.rebuild {action: 'apply'} moves it. {action: 'undo'} takes back this one rebuild and nothing else, and refuses clearly, leaving everything as it is, when the book
   changed since or a build of the course is running. No network; the jobs run on a fake model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { firstBodyLine, REBUILD_FILE, structureEdits } from '../lib/course-book-moves.js';
import { REBUILD_JOB_KINDS } from '../lib/course-book-rebuild.js';
import { COURSE_BOOK_KIND } from '../lib/contexts/generation/book/jobs/course-book-build.js';
import { COURSE_OUTLINE_KIND } from '../lib/contexts/generation/outline/jobs/course-outline-build.js';
import { MOVES_KEPT, openCourseBook } from '../lib/course-book-files.js';
import { readHistory, readRebuild } from '../lib/course-book-history.js';
import { courseOutlineMaterial, currentCourseOutline, materialsFingerprint, OUTLINE_LIMITS } from '../lib/course-outline-book.js';
import { currentCourseNotes, courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { StudyService } from '../lib/service.js';
import { settleJob, until } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';

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
async function setUp(t, options = {}) {
  const root = await privateRoot(t, 'course-book-rebuild-');
  const service = new StudyService(root, options);
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
  const apply = outlineId => service.call('course.book.rebuild', { course: COURSE, action: 'apply', outlineId });
  const undo = outlineId => service.call('course.book.rebuild', { course: COURSE, action: 'undo', outlineId });
  return { root, service, first, what, who, saved, lecture, other, rebuild, apply, undo };
}
const view = service => service.store.read();
const docOf = async service => structuredClone(bookOf(await view(service)).bookDoc);
const pending = error => error.code === 'course-book-rebuild-pending';

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

test('any open, with no flag: a rebuild that would move the learner\'s text answers the preview and writes nothing; only apply moves it, once', async t => {
  const { service, rebuild, saved, apply } = await setUp(t);
  const before = await docOf(service);
  const newId = await rebuild();
  const preview = await service.call('course.book.open', { course: COURSE });
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
  await assert.rejects(apply('course-outline-nope'), error => error.code === 'course-book-rebuild-conflict', 'the moves looked at are the moves applied');
  const book = await apply(newId);
  assert.equal(book.status, 'ok');
  assert.equal(book.write, 'applied');
  assert.equal(book.moves.undoable, true);
  assert.match(book.unplaced.text, /A long note on stakeholders and views\./);
  assert.match(leaves(book.nodes).find(node => node.title === 'The architect\'s job').mine, /Note on what architects do\./);
  assert.equal((await service.call('course.book.open', { course: COURSE })).status, 'ok', 'it is the book now');
  assert.equal((await apply(newId)).status, 'ok', 'twice is the same');
});

// #489 item 2: a rebuild lays the book out by the new outline, so what the learner did to the book's structure does not survive it. That is said before it happens, and an undo gives it back.
test('the learner\'s moves, deletes and renames that a rebuild would not keep: pure diff against the outline the book was laid out by', () => {
  const outline = [{ id: 'c1', title: 'One', children: [{ id: 'a', title: 'A', anchors: ['x'] }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }] }, { id: 'c2', title: 'Two', children: [{ id: 'd', title: 'D' }] }];
  const leaf = (id, title = id.toUpperCase()) => ({ id, hid: `h-${id}`, title, leaf: true, children: [] });
  const same = [{ id: 'c1', hid: 'h1', title: 'One', children: [leaf('a'), leaf('b'), leaf('c')] }, { id: 'c2', hid: 'h2', title: 'Two', children: [leaf('d')] }];
  assert.deepEqual(structureEdits(outline, same), { moved: [], deleted: [] }, 'a book as the outline laid it out has none, renamed or not');
  // One point up inside its chapter: only that one moved, not its neighbours.
  const reordered = [{ ...same[0], children: [leaf('c'), leaf('a'), leaf('b')] }, same[1]];
  assert.deepEqual(structureEdits(outline, reordered).moved.map(node => node.title), ['C']);
  const across = [{ ...same[0], children: [leaf('a'), leaf('c')] }, { ...same[1], children: [leaf('d'), leaf('b', 'My B')] }];
  assert.deepEqual(structureEdits(outline, across).moved.map(node => node.title), ['My B'], 'under another chapter, under the title the book shows');
  const deleted = structureEdits(outline, [{ ...same[0], children: [leaf('a'), leaf('c')] }, same[1]]);
  assert.deepEqual(deleted.deleted.map(node => node.title), ['B']);
  assert.deepEqual(deleted.moved, []);
  // A chapter deleted with its points promoted: the chapter is the delete; its points did not move by themselves.
  const promoted = structureEdits(outline, [same[0], leaf('d')]);
  assert.deepEqual(promoted.deleted.map(node => node.title), ['Two']);
  assert.deepEqual(promoted.moved, []);
});

test('a rebuild that would drop a move or bring back a deleted point is held even with no text moving; undo gives them back', async t => {
  const { service, rebuild, apply, undo, lecture, other } = await setUp(t);
  const nodes = [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'who', title: 'Stakeholders and views', anchors: [`${lecture}#1`, `${lecture}#2`] },
    { id: 'third', title: 'A third point', anchors: [other] }] }];
  // The book follows an outline of three points; the learner moves one up and deletes another, keeping their notes where they are.
  const three = await rebuild(nodes, '2026-10-09T12:00:00.000Z');
  const opened = await service.call('course.book.open', { course: COURSE });
  assert.equal(opened.status, 'ok');
  assert.equal(opened.moves, undefined, 'the same points under the same titles: nothing to say');
  const [what, , third] = leaves(opened.nodes);
  const moved = await service.call('course.book.move', { course: COURSE, hid: what.hid, afterHid: leaves(opened.nodes)[1].hid, version: opened.structureVersion });
  await service.call('course.book.rename', { course: COURSE, hid: opened.nodes[0].hid, title: 'My own chapter name', version: moved.structureVersion });
  const named = await service.call('course.book.open', { course: COURSE });
  await service.call('course.book.delete', { course: COURSE, hid: third.hid, version: named.structureVersion });
  const shaped = await service.call('course.book.open', { course: COURSE }), before = await docOf(service);
  assert.deepEqual(leaves(shaped.nodes).map(node => node.title), ['Stakeholders and views', 'What architects do']);
  // The outline is made again: the same pages under the same titles, in a chapter of another name. Not one line of the learner's text moves.
  const newId = await rebuild([{ ...nodes[0], title: 'Opening' }], '2026-10-10T00:00:00.000Z');
  assert.notEqual(newId, three);
  const preview = await service.call('course.book.open', { course: COURSE });
  assert.equal(preview.status, 'rebuild-pending', 'held, though no text moves');
  assert.deepEqual(preview.moves.list, []);
  assert.deepEqual(preview.moves.structure, { moved: ['What architects do'], revived: ['A third point'], renamed: ['My own chapter name'] });
  assert.deepEqual(await docOf(service), before, 'nothing happened yet');
  // Applied: exactly what the preview said.
  const book = await apply(newId);
  assert.deepEqual(leaves(book.nodes).map(node => node.title), ['What architects do', 'Stakeholders and views', 'A third point']);
  assert.equal(book.nodes[0].title, 'Opening');
  assert.deepEqual(book.moves.structure, preview.moves.structure, 'said again after, while it can be looked at');
  assert.equal(book.moves.undoable, true);
  // Undone: the move, the delete and the name are back.
  await undo(newId);
  const back = await service.call('course.book.open', { course: COURSE });
  assert.equal(back.status, 'ok');
  assert.deepEqual(leaves(back.nodes).map(node => node.title), ['Stakeholders and views', 'What architects do']);
  assert.equal(back.nodes[0].title, 'My own chapter name');
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
  const book = await service.call('course.book.open', { course: COURSE });
  assert.equal(book.status, 'ok');
  assert.equal(book.moves.list.length, 1, 'still recorded');
  assert.equal(book.moves.list[0].own, undefined);
});

test('while a rebuild is pending: what needs the layout is refused and moves nothing; a write to a named file lands where it is and follows on apply', async t => {
  const { service, rebuild, apply, what } = await setUp(t);
  const newId = await rebuild();
  const before = await docOf(service);
  const stillPending = async () => {
    const doc = await docOf(service);
    assert.equal(doc.outlineId, before.outlineId, 'the book still follows the old outline');
    assert.deepEqual(doc.manifest, before.manifest);
    assert.equal((await service.call('course.book.open', { course: COURSE })).status, 'rebuild-pending');
  };
  // The main chat's tools.
  const toc = await service.call('book.toc', { course: COURSE });
  assert.equal(toc.status, 'rebuild-pending');
  assert.equal(toc.moves.outlineId, newId, 'the chat sees what would move');
  await assert.rejects(service.call('book.write', { course: COURSE, hid: what.hid, markdown: 'x' }), pending);
  await stillPending();
  // The book's structure.
  await assert.rejects(service.call('course.book.rename', { course: COURSE, hid: what.hid, title: 'New', version: 1 }), pending);
  await stillPending();
  // 加入复习全书, and 自动加入 calling the same op: the question's place is only known on the new layout, so it waits; the card keeps the follow-up.
  const { deckId, cardId, followupId } = await service.store.update(state => {
    const deck = state.decks.find(item => item.course === COURSE || item.folder === COURSE) ?? state.decks[0], card = deck.cards[0];
    card.followups = [{ id: 'fu-1', question: 'Why?', answer: 'Because.' }];
    return { deckId: deck.id, cardId: card.id, followupId: 'fu-1' };
  });
  await assert.rejects(service.call('book.qa.add', { course: COURSE, deckId, cardId, followupId }), error => {
    assert.ok(pending(error), error.message);
    assert.match(error.message, /复习全书/);
    return true;
  });
  await stillPending();
  assert.deepEqual((await docOf(service)).files, before.files, 'nothing was written by any of them');
  // A save from an editor left open: not lost, not moved; it answers the preview, whose words are the new text, and goes with the note on apply.
  const file = what.files.mine, saved = await service.call('course.book.save', { course: COURSE, file, text: 'Saved while pending.', version: before.files[file].version });
  assert.equal(saved.status, 'rebuild-pending');
  assert.equal(saved.write, 'saved');
  assert.equal(saved.moves.list[0].first, 'Saved while pending.');
  await stillPending();
  const book = await apply(newId);
  assert.equal(leaves(book.nodes).find(node => node.title === 'The architect\'s job').mine, 'Saved while pending.');
});

test('read-only views while a rebuild is pending see the layout it would make and still write nothing', async t => {
  const { service, rebuild } = await setUp(t);
  await rebuild();
  const before = await docOf(service);
  const exported = await service.call('course.book.export', { course: COURSE });
  assert.equal(exported.status, 'ok');
  assert.ok(exported.text.includes('The architect\'s job'));
  assert.deepEqual(await docOf(service), before);
});

test('undo takes back this one rebuild: every text, title, heading id and 未归位 as before; the outline before it is current again; a second undo is refused', async t => {
  const { root, service, rebuild, first, what, who, apply, undo } = await setUp(t);
  const before = await docOf(service), newId = await rebuild();
  const applied = await apply(newId);
  assert.ok(await readRebuild(root, COURSE), 'the state before the rebuild is kept beside the history');
  const undone = await undo(newId);
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
  await assert.rejects(undo(newId), error => error.code === 'course-book-rebuild-conflict');
  assert.equal((await service.call('course.book.open', { course: COURSE })).status, 'ok');
  assert.equal((await docOf(service)).outlineId, first.id, 'opening again does not rebuild what was undone');
});

test('undo is refused when the book changed after the rebuild, and leaves the edit, the moved text and the outline exactly as they are', async t => {
  const { service, rebuild, apply, undo } = await setUp(t);
  const newId = await rebuild();
  const applied = await apply(newId);
  const job = leaves(applied.nodes).find(node => node.title === 'The architect\'s job');
  await service.call('course.book.save', { course: COURSE, file: job.files.mine, text: `${job.mine}\n\nWritten after the rebuild.`, version: applied.files[job.files.mine].version });
  const before = await docOf(service);
  await assert.rejects(undo(newId), error => {
    assert.equal(error.code, 'course-book-rebuild-conflict');
    assert.match(error.message, /改过/);
    assert.match(error.message, /changed/);
    return true;
  });
  assert.deepEqual(await docOf(service), before);
  const page = await service.call('course.book.open', { course: COURSE });
  assert.match(leaves(page.nodes).find(node => node.hid === job.hid).mine, /Written after the rebuild\./);
  assert.equal(currentCourseOutline((await view(service)).sources, COURSE).id, newId);
  assert.equal(page.moves.undoable, false, 'the page does not offer it either');
});

test('undo is refused when something wrote a file without moving the revision: the text is compared, not only the number', async t => {
  const { service, rebuild, apply, undo } = await setUp(t);
  const newId = await rebuild();
  const applied = await apply(newId);
  const job = leaves(applied.nodes).find(node => node.title === 'The architect\'s job');
  await service.store.update(state => { bookOf(state).bookDoc.files[job.files.mine].text += '\n\nA write that forgot the revision.'; });
  await assert.rejects(undo(newId), error => error.code === 'course-book-rebuild-conflict');
  assert.match((await docOf(service)).files[job.files.mine].text, /A write that forgot the revision\./);
});

test('undo is refused after another rebuild and for an outline that is not current; with the kept state gone it is refused and not offered', async t => {
  const { root, service, rebuild, lecture, other, apply, undo } = await setUp(t);
  const newId = await rebuild();
  assert.equal((await apply(newId)).moves.undoable, true);
  await assert.rejects(undo('course-outline-nope'), error => error.code === 'course-book-rebuild-conflict');
  await assert.rejects(service.call('course.book.rebuild', { course: COURSE, action: 'undo' }), error => error.code === 'course-book-rebuild-conflict');
  await assert.rejects(service.call('course.book.rebuild', { course: COURSE, action: 'nope', outlineId: newId }), error => error.code === 'course-book-rebuild-action');
  const folder = join(root, 'book-history'), names = (await readdir(folder)).filter(name => name.endsWith('.rebuild.json'));
  assert.equal(names.length, 1);
  const before = await docOf(service);
  await rm(join(folder, names[0]));
  assert.equal((await service.call('course.book.open', { course: COURSE })).moves.undoable, false, 'the page does not offer what cannot work');
  await assert.rejects(undo(newId), error => error.code === 'course-book-rebuild-no-undo');
  assert.deepEqual(await docOf(service), before);
  const third = await rebuild(firstNodes(lecture).map(node => ({ ...node, title: `${node.title} again` })).concat([{ id: 'z1', title: 'More', children: [{ id: 'z2', title: 'Other lecture', anchors: [other] }] }]), '2026-10-11T00:00:00.000Z');
  await assert.rejects(undo(newId), error => error.code === 'course-book-rebuild-conflict');
  assert.equal(currentCourseOutline((await view(service)).sources, COURSE).id, third);
});

test('a snapshot that cannot be written costs the undo, never the book or a version of a file', async t => {
  const { root, rebuild, apply, undo } = await setUp(t);
  const newId = await rebuild();
  const history = (await readHistory(root, COURSE)).length;
  // The path of the snapshot is taken by a folder, so its rename fails.
  const name = (await readdir(join(root, 'book-history'))).find(item => item.endsWith('.json') && !item.includes('reading'));
  await mkdir(join(root, 'book-history', name.replace(/\.json$/, '.rebuild.json'), 'x'), { recursive: true });
  const book = await apply(newId);
  assert.equal(book.status, 'ok', 'the book was written');
  assert.equal(book.moves.undoable, false);
  assert.ok((await readHistory(root, COURSE)).length > history, 'the versions the open replaced were kept');
  assert.ok(leaves(book.nodes).some(node => /Note on what architects do\./.test(node.mine)));
  await assert.rejects(undo(newId), error => error.code === 'course-book-rebuild-no-undo');
});

test('the rebuild left pending can be given up: the outline before it is current again, not one file of the book changes', async t => {
  const { service, rebuild, first, undo } = await setUp(t);
  const before = await docOf(service), newId = await rebuild();
  await assert.rejects(undo('course-outline-nope'), error => error.code === 'course-book-rebuild-conflict');
  const book = await undo(newId);
  assert.deepEqual([book.status, book.write], ['ok', 'discarded']);
  const after = await docOf(service);
  assert.deepEqual(after.files, before.files);
  assert.deepEqual(after.manifest, before.manifest);
  assert.equal(after.outlineId, first.id);
  const state = await view(service);
  assert.equal(currentCourseOutline(state.sources, COURSE).id, first.id);
  assert.equal(state.sources.find(source => source.id === newId).archived, true);
  assert.equal((await service.call('course.book.open', { course: COURSE })).status, 'ok');
});

test('giving up and undoing are refused while a build of the course runs: its save would leave notes for an archived outline, or two current outlines', async t => {
  assert.deepEqual([...REBUILD_JOB_KINDS].sort(), [COURSE_BOOK_KIND, COURSE_OUTLINE_KIND].sort());
  const fake = outlineModel({ inventory: 'none' });
  // The fake model answers only when told, so the build is really running at the undo.
  let release, gate = new Promise(resolve => { release = resolve; });
  const complete = async (...args) => { await gate; return fake.complete(...args); };
  const { service, rebuild, undo } = await setUp(t, { complete, ...switchOptions('runtime', { complete, paths: [] }) });
  const newId = await rebuild();
  const before = await docOf(service), outlines = (await view(service)).sources.filter(source => source.provenance === 'course-outline').map(source => [source.id, source.archived]);
  for (const action of ['generation.courseOutline.build', 'generation.courseBook.build']) {
    const { jobId } = await service.call(action, { course: COURSE, language: 'zh', confirm: true });
    await assert.rejects(undo(newId), error => {
      assert.equal(error.code, 'course-book-rebuild-job-running', error.message);
      assert.match(error.message, /正在/);
      return true;
    });
    assert.deepEqual(await docOf(service), before);
    assert.deepEqual((await view(service)).sources.filter(source => source.provenance === 'course-outline').map(source => [source.id, source.archived]).slice(0, outlines.length), outlines);
    await service.call('job.cancel', { jobId });
    release();
    await settleJob(service, jobId);
    gate = new Promise(resolve => { release = resolve; });
  }
  release();
});

/** A build started on the rebuilt outline with the fake model held, so it is really running. `go` lets the model answer. */
async function heldBuild(t) {
  const fake = outlineModel({ inventory: 'none' });
  let go;
  const gate = new Promise(resolve => { go = resolve; });
  const complete = async (...args) => { await gate; return fake.complete(...args); };
  const set = await setUp(t, { complete, ...switchOptions('runtime', { complete, paths: [] }) });
  return { ...set, fake, go, newId: await set.rebuild() };
}
const outlinesOf = state => state.sources.filter(source => source.provenance === 'course-outline' && !source.archived).map(source => source.id);

for (const [action, code] of [['generation.courseBook.build', 'course-book-outline-changed'], ['generation.courseOutline.build', 'course-outline-changed']]) {
  test(`${action}: stopped, the rebuild given up, then retried from the console: refused at once, no model call, nothing saved on an outline that is not current`, async t => {
    const { service, go, fake, undo, first, newId } = await heldBuild(t);
    const { jobId } = await service.call(action, { course: COURSE, language: 'zh', confirm: true });
    await service.call('job.cancel', { jobId });
    go();
    await settleJob(service, jobId);
    assert.equal((await undo(newId)).write, 'discarded');
    const calls = fake.calls.length, sources = (await view(service)).sources.length;
    await service.call('job.control', { jobId, action: 'retry' });
    const job = await settleJob(service, jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.errorCode ?? job.error?.code ?? job.contract?.error?.code ?? code, code, JSON.stringify(job.error));
    assert.match(JSON.stringify(job), /总纲在这个任务开始之后变过了/);
    assert.equal(fake.calls.length, calls, 'no further model call');
    const state = await view(service);
    assert.equal(state.sources.length, sources, 'nothing saved');
    assert.deepEqual(outlinesOf(state), [first.id]);
    assert.equal(currentCourseNotes(state.sources, COURSE), null);
  });
}

test('a paused build still counts as running for the undo; and if its outline moved anyway, resuming saves nothing', async t => {
  const { service, go, undo, first, newId } = await heldBuild(t);
  const { jobId } = await service.call('generation.courseBook.build', { course: COURSE, language: 'zh', confirm: true });
  await service.call('job.control', { jobId, action: 'pause' });
  go();
  await until(() => [...service.runtime.work.jobs.values()].find(job => job.id === jobId)?.contract?.status === 'paused', 'a checkpoint');
  await assert.rejects(undo(newId), error => error.code === 'course-book-rebuild-job-running');
  // The outline moved all the same (another app process over the same library): the job's own check is the last word.
  await service.store.update(state => {
    state.sources.find(source => source.id === newId).archived = true;
    state.sources.find(source => source.id === first.id).archived = false;
  });
  await service.call('job.control', { jobId, action: 'resume' });
  const job = await settleJob(service, jobId);
  assert.equal(job.status, 'failed');
  assert.match(JSON.stringify(job), /总纲在这个任务开始之后变过了/);
  const state = await view(service);
  assert.deepEqual(outlinesOf(state), [first.id]);
  assert.equal(currentCourseNotes(state.sources, COURSE), null);
});

test('the export of a pending rebuild says it is that layout, not the book as it stands', async t => {
  const { service, rebuild, apply } = await setUp(t);
  const newId = await rebuild();
  const exported = await service.call('course.book.export', { course: COURSE });
  assert.equal(exported.rebuildPending?.outlineId, newId);
  assert.match(exported.rebuildPending.note, /not applied/);
  await apply(newId);
  assert.equal((await service.call('course.book.export', { course: COURSE })).rebuildPending, undefined);
});

test('undo of a rebuild a book update made with its notes: the explanations written before it are current again', async t => {
  const { service, rebuild, lecture, first, apply, undo } = await setUp(t);
  const notes = (outlineId, id, text, supersedes) => courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId, leaves: [{ id, title: id, anchors: [`${lecture}#0`],
    body: { fingerprint: 'abcdef0123456789', points: [text], explain: text, cites: [] } }], counts: {}, ...(supersedes ? { supersedes } : {}) });
  const older = notes(first.id, 'what', 'Explanation for the old point.');
  await service.store.update(state => { state.sources.push({ ...older, createdAt: '2026-10-09T01:00:00.000Z' }); });
  await service.call('course.book.open', { course: COURSE });
  const newId = await rebuild();
  const newer = notes(newId, 'k2', 'Explanation for the new point.', older.id);
  await service.store.update(state => { state.sources.find(source => source.id === older.id).archived = true; state.sources.push({ ...newer, createdAt: '2026-10-10T01:00:00.000Z' }); });
  const applied = await apply(newId);
  assert.match(leaves(applied.nodes).find(node => node.title === 'The architect\'s job').gen, /Explanation for the new point/);
  const undone = await undo(newId);
  const state = await view(service);
  assert.equal(currentCourseNotes(state.sources, COURSE).id, older.id);
  assert.equal(state.sources.find(source => source.id === newer.id).archived, true);
  assert.match(leaves(undone.nodes).find(node => node.title === 'What architects do').gen, /Explanation for the old point/);
});

test('undo keeps the 读完了 / 已看 marks made since (they move no revision), and the book\'s own titles as they were', async t => {
  const { service, rebuild, what, apply, undo } = await setUp(t);
  const version = (await service.call('course.book.open', { course: COURSE })).structureVersion;
  await service.call('course.book.rename', { course: COURSE, hid: what.hid, title: 'My own title', version });
  const newId = await rebuild();
  await apply(newId);
  await service.call('book.crunch.mark', { course: COURSE, hid: what.hid, kind: 'read' });
  const undone = await undo(newId);
  assert.equal(leaves(undone.nodes).find(node => node.hid === what.hid).title, 'My own title');
  assert.ok((await docOf(service)).marks.read[what.hid], 'the mark stays');
});

test('every move of a book at the outline limit is kept', () => {
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
  const book = openCourseBook(state, {});
  assert.equal(book.status, 'rebuild-pending');
  assert.deepEqual([book.moves.gone, book.moves.goneList], [1, [{ from: 'What architects do', first: 'A note on a lecture that left the course.' }]]);
});

test('two points of one title merged into the same new title count as a move: held for the preview, listed, undone', async t => {
  const root = await privateRoot(t, 'course-book-rebuild-fold-');
  const service = new StudyService(root, {});
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); state.focus = { mode: 'class', course: COURSE }; });
  const lecture = lectureKey(sources);
  await service.store.update(state => { state.sources.push(outlineOf(state, [{ id: 'c', title: 'Intro', children: [{ id: 'a', title: 'Layers', anchors: [`${lecture}#0`] }, { id: 'b', title: 'Layers', anchors: [`${lecture}#1`] }] }], '2026-10-09T00:00:00.000Z')); });
  const opened = await service.call('course.book.open', { course: COURSE });
  const [one, two] = leaves(opened.nodes);
  await service.call('course.book.save', { course: COURSE, file: two.files.mine, text: 'The note of the second one.', version: opened.files[two.files.mine].version });
  const before = await docOf(service);
  const newId = await service.store.update(state => { currentCourseOutline(state.sources, COURSE).archived = true; const made = outlineOf(state, [{ id: 'k', title: 'Intro', children: [{ id: 'm', title: 'Layers', anchors: [`${lecture}#0`, `${lecture}#1`] }] }], '2026-10-10T00:00:00.000Z'); state.sources.push(made); return made.id; });
  const preview = await service.call('course.book.open', { course: COURSE });
  assert.equal(preview.status, 'rebuild-pending', 'merged text is not moved unseen just because the titles match');
  assert.ok(preview.moves.list.some(move => move.from === 'Layers' && move.to === 'Layers' && move.folded && move.own), JSON.stringify(preview.moves.list));
  const applied = await service.call('course.book.rebuild', { course: COURSE, action: 'apply', outlineId: newId });
  assert.equal(applied.moves.undoable, true);
  assert.match(leaves(applied.nodes)[0].mine, /The note of the second one\./);
  await service.call('course.book.rebuild', { course: COURSE, action: 'undo', outlineId: newId });
  assert.deepEqual((await docOf(service)).files, before.files);
  assert.ok(one);
});

test('the kept state is never written to the book\'s version list and is not in an answer', async t => {
  const { root, rebuild, apply } = await setUp(t);
  const applied = await apply(await rebuild());
  assert.ok(!applied.replaced.some(item => item.file === REBUILD_FILE), 'the answer does not carry the whole book again');
  assert.ok(!(await readHistory(root, COURSE)).some(entry => entry.file === REBUILD_FILE));
  assert.equal(applied.history[REBUILD_FILE], undefined);
});

test('a list saved again after it was archived is current again (an identical outline made again after an undo must not leave the course without one)', async t => {
  const { service, rebuild, undo } = await setUp(t);
  const newId = await rebuild();
  await undo(newId);
  const state = await view(service), record = state.sources.find(source => source.id === newId), old = currentCourseOutline(state.sources, COURSE);
  await service.runtime.invoke('materials.v1', 'sources.ingest', { sources: [structuredClone({ ...record, archived: undefined })], archive: [old.id] });
  assert.equal(currentCourseOutline((await view(service)).sources, COURSE).id, newId);
});
