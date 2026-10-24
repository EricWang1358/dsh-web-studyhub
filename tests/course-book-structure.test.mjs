/* The structure of the 复习全书 (#470): rename, move and delete a chapter or a knowledge point of the book without rebuilding the outline and without
   sending the book's text. Compare-and-set on the book's structure version (a stale one is refused like a stale 撤销), one writer queue and one store
   transaction each, the structure before the change kept in the version history (course.book.revert {file: 'book.structure'} undoes it), a deleted
   node leaves no shell, a renamed title survives a rebuilt outline, and the actions show their input schemas in study_capabilities. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCapabilities } from '../lib/runtime/tools.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { libraryContracts } from '../lib/study-contracts.js';
import { STRUCTURE_FILE } from '../lib/course-book-structure.js';
import { FILE_TEXT_MAX } from '../lib/course-book-edit.js';
import { bookService } from './helpers/book-agent-library.mjs';

/** 14 points in 4 chapters of lecture 1, as the owner's book of #470 (10 chapters / 14 points) at a smaller size. */
const FOURTEEN = (lecture, lectureKey) => [[1, 4], [2, 4], [3, 3], [4, 3]].map(([c, count], at, all) => {
  const before = all.slice(0, at).reduce((sum, [, n]) => sum + n, 0);
  return { id: `c${c}`, title: `第 ${c} 章`, children: Array.from({ length: count }, (_, i) => ({ id: `p${before + i + 1}`, title: `知识点 ${before + i + 1}`, anchors: [`${lectureKey(Math.floor((before + i) / 3) + 1)}#${(before + i) % 3}`] })) };
});
const rowsOf = toc => toc.toc.map(row => `${row.n} ${row.title}`);
const byTitle = (toc, title) => toc.toc.find(row => row.title === title);
const codeOf = promise => promise.then(() => null, error => error.code ?? error.message);

async function fourteen(t) {
  const made = await bookService(t, { chapters: FOURTEEN });
  const toc = await made.study.call('book.toc', { limit: 40 });
  return { ...made, toc };
}

test('#470 acceptance: in a 14-point book rename one point and move one point to the right place; no outline rebuild, no book text sent; undo walks back', async t => {
  const { study, toc } = await fourteen(t);
  assert.equal(toc.points, 14);
  const outlineBefore = (await study.store.read()).sources.find(source => source.provenance === 'course-outline' && !source.archived)?.id;
  let version = toc.structureVersion;
  assert.equal(Number.isInteger(version), true, 'book.toc says the structure version');

  // Rename: the title only, the id kept, the outline untouched; the call is small.
  const five = byTitle(toc, '知识点 5'), args = { hid: five.hid, title: '进程与线程', version };
  assert.ok(JSON.stringify(args).length < 120, 'a rename sends no book text');
  const renamed = await study.call('course.book.rename', args);
  assert.equal(renamed.write, 'renamed');
  assert.equal(renamed.hid, five.hid);
  assert.equal(renamed.structureVersion, version + 1);
  assert.ok(JSON.stringify(renamed).length < 1500, 'the answer is small (not the whole book)');
  version = renamed.structureVersion;
  let now = await study.call('book.toc', { limit: 40 });
  assert.equal(byTitle(now, '进程与线程').hid, five.hid);
  assert.equal(byTitle(now, '知识点 5'), undefined);
  const gen = await study.call('book.read', { hid: five.hid, file: 'gen' });
  assert.match(gen.files.gen.text, /练 5 道：进程与线程/, 'the generated file follows the new name');

  // Move: 知识点 12 (chapter 4) goes after 知识点 2 in chapter 1, with its own notes.
  const twelve = byTitle(now, '知识点 12'), two = byTitle(now, '知识点 2'), first = now.toc.find(row => row.title === '第 1 章');
  await study.call('book.write', { hid: twelve.hid, file: 'mine', markdown: '#### 我的小结\n\n十二的笔记。' });
  const moved = await study.call('course.book.move', { hid: twelve.hid, toParent: first.hid, afterHid: two.hid, version });
  assert.equal(moved.write, 'moved');
  version = moved.structureVersion;
  now = await study.call('book.toc', { limit: 40 });
  assert.deepEqual(rowsOf(now).slice(0, 6), ['1 第 1 章', '1.1 知识点 1', '1.2 知识点 2', '1.3 知识点 12', '1.4 知识点 3', '1.5 知识点 4']);
  assert.equal(byTitle(now, '知识点 12').hid, twelve.hid, 'the id stays');
  const mine = await study.call('book.read', { hid: twelve.hid, file: 'mine' });
  assert.match(mine.files.mine.text, /十二的笔记/, 'its files moved with it');
  assert.deepEqual(rowsOf(now).slice(-3), ['4 第 4 章', '4.1 知识点 13', '4.2 知识点 14']);
  assert.equal(now.points, 14);

  // The outline was never rebuilt.
  const outlineAfter = (await study.store.read()).sources.find(source => source.provenance === 'course-outline' && !source.archived)?.id;
  assert.equal(outlineAfter, outlineBefore);

  // A stale version is refused with the book's conflict code, and nothing changes.
  assert.equal(await codeOf(study.call('course.book.rename', { hid: five.hid, title: '又一个名字', version: version - 1 })), 'course-book-conflict');
  assert.equal(byTitle(await study.call('book.toc', { limit: 40 }), '进程与线程').hid, five.hid);

  // Undo, one step at a time: the move, then the rename.
  let back = await study.call('course.book.revert', { file: STRUCTURE_FILE });
  assert.equal(back.write, 'reverted');
  now = await study.call('book.toc', { limit: 40 });
  assert.deepEqual(rowsOf(now).slice(0, 5), ['1 第 1 章', '1.1 知识点 1', '1.2 知识点 2', '1.3 知识点 3', '1.4 知识点 4']);
  assert.equal(byTitle(now, '知识点 12').n, '4.1');
  assert.match((await study.call('book.read', { hid: twelve.hid, file: 'mine' })).files.mine.text, /十二的笔记/);
  back = await study.call('course.book.revert', { file: STRUCTURE_FILE });
  assert.equal(byTitle(await study.call('book.toc', { limit: 40 }), '知识点 5').hid, five.hid, 'the old title is back');
  assert.equal(await codeOf(study.call('course.book.revert', { file: STRUCTURE_FILE })), 'course-book-no-version');
});

test('delete: a shell point leaves nothing behind; a chapter promotes its points or sends what the learner wrote to 未归位; undo brings it all back', async t => {
  const { study, toc } = await fourteen(t);
  let version = toc.structureVersion;
  const shell = byTitle(toc, '知识点 7');
  await study.call('book.write', { hid: shell.hid, file: 'mine', markdown: '（待补）' });
  const gone = await study.call('course.book.delete', { hid: shell.hid, version });
  assert.equal(gone.write, 'deleted');
  assert.deepEqual(gone.removed.points, 1);
  version = gone.structureVersion;
  const opened = await study.call('course.book.open');
  const all = JSON.stringify(opened.nodes);
  assert.equal(all.includes('知识点 7'), false, 'course.book.open no longer has it');
  assert.equal(opened.unplaced.text, '', 'no placeholder text anywhere');
  assert.equal(Object.keys(opened.files).some(name => name.startsWith('p7.')), false, 'its files are gone');
  assert.equal((await study.call('book.toc', { limit: 40 })).points, 13);

  // A chapter: promote (the default) puts its points in its place; their files' headings come up one level with them.
  let now = await study.call('book.toc', { limit: 40 });
  const third = byTitle(now, '第 3 章'), ten = byTitle(now, '知识点 10');
  await study.call('book.write', { hid: ten.hid, file: 'mine', markdown: '#### 深处\n\n十的笔记。' });
  const promoted = await study.call('course.book.delete', { hid: third.hid, version });
  version = promoted.structureVersion;
  now = await study.call('book.toc', { limit: 40 });
  assert.equal(byTitle(now, '第 3 章'), undefined);
  assert.equal(byTitle(now, '知识点 9').n, '3', 'a promoted point takes the chapter\'s place');
  assert.equal(byTitle(now, '知识点 10').n, '4');
  assert.equal(now.points, 13);
  assert.equal((await study.call('book.read', { hid: ten.hid, file: 'mine' })).files.mine.headings[0].level, 3, 'headings sit below the point (level 2 now)');

  // A chapter to 未归位: the learner's text of its points goes there under their titles; a point with nothing of the learner's leaves nothing.
  const fourth = byTitle(now, '第 4 章'), twelve = byTitle(now, '知识点 12');
  const own = (await study.call('book.read', { hid: twelve.hid, file: 'mine' })).files.mine;
  await study.call('course.book.save', { file: own.name, text: '十二的笔记[^1]。\n\n[^1]: 我的脚注', version: own.version });
  const sent = await study.call('course.book.delete', { hid: fourth.hid, children: 'toUnplaced', version });
  version = sent.structureVersion;
  assert.equal(sent.removed.points, 3);
  const book = await study.call('course.book.open'), label = `${twelve.hid}m-1`;
  assert.match(book.unplaced.text, /### 知识点 12/);
  assert.ok(book.unplaced.text.includes(`十二的笔记[^${label}]。`), book.unplaced.text);
  assert.ok(book.unplaced.text.includes(`[^${label}]: 我的脚注`), 'its footnote is renamed with it, never colliding in 未归位');
  assert.doesNotMatch(book.unplaced.text, /知识点 13|知识点 14/, 'points with nothing of the learner\'s leave no heading');
  assert.equal((await study.call('book.toc', { limit: 40 })).points, 10);

  // Undo the three deletes: 未归位 is as it was, the chapters and points are back with their files.
  for (let step = 0; step < 3; step += 1) await study.call('course.book.revert', { file: STRUCTURE_FILE });
  const restored = await study.call('course.book.open');
  assert.equal(restored.unplaced.text, '');
  now = await study.call('book.toc', { limit: 40 });
  assert.equal(now.points, 14);
  assert.deepEqual(['第 3 章', '第 4 章', '知识点 7'].map(title => !!byTitle(now, title)), [true, true, true]);
  assert.equal((await study.call('book.read', { hid: shell.hid, file: 'mine' })).files.mine.text, '（待补）');
});

test('moving a point deeper or shallower moves the headings of its files with it; the files are kept as one structure change', async t => {
  const { study, toc } = await fourteen(t);
  let version = toc.structureVersion;
  const one = byTitle(toc, '知识点 1');
  await study.call('book.write', { hid: one.hid, file: 'mine', markdown: '#### 甲\n\n第一段。\n\n##### 甲一\n\n更深。' });
  // To the top level (a point of its own beside the chapters): two levels up become one.
  const up = await study.call('course.book.move', { hid: one.hid, toParent: 'book', version });
  version = up.structureVersion;
  let now = await study.call('book.toc', { limit: 40 });
  assert.equal(byTitle(now, '知识点 1').n, '5', 'appended as the last top-level node');
  assert.deepEqual((await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine.headings.map(heading => heading.level), [3, 4]);
  // Before the first chapter.
  const firstChapter = byTitle(now, '第 1 章');
  version = (await study.call('course.book.move', { hid: one.hid, beforeHid: firstChapter.hid, version })).structureVersion;
  now = await study.call('book.toc', { limit: 40 });
  assert.equal(byTitle(now, '知识点 1').n, '1');
  assert.equal(byTitle(now, '第 1 章').n, '2');
  // Back into chapter 1, first: the headings go back down.
  version = (await study.call('course.book.move', { hid: one.hid, toParent: firstChapter.hid, beforeHid: byTitle(now, '知识点 2').hid, version })).structureVersion;
  assert.deepEqual((await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine.headings.map(heading => heading.level), [4, 5]);
  // Undo three times: the file's headings follow every step back.
  await study.call('course.book.revert', { file: STRUCTURE_FILE });
  assert.deepEqual((await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine.headings.map(heading => heading.level), [3, 4]);
  await study.call('course.book.revert', { file: STRUCTURE_FILE });
  await study.call('course.book.revert', { file: STRUCTURE_FILE });
  now = await study.call('book.toc', { limit: 40 });
  assert.equal(byTitle(now, '知识点 1').n, '1.1');
  assert.deepEqual((await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine.headings.map(heading => heading.level), [4, 5]);
});

test('refusals name what is wrong and change nothing', async t => {
  const { study, toc } = await fourteen(t);
  const version = toc.structureVersion, one = byTitle(toc, '知识点 1'), two = byTitle(toc, '知识点 2'), first = byTitle(toc, '第 1 章'), second = byTitle(toc, '第 2 章');
  const cases = [
    [study.call('course.book.rename', { hid: 'h999', title: 'x', version }), 'course-book-node-missing'],
    [study.call('course.book.rename', { hid: one.hid, title: '   ', version }), 'course-book-title-invalid'],
    [study.call('course.book.rename', { hid: one.hid, title: 'x'.repeat(201), version }), 'course-book-title-invalid'],
    [study.call('course.book.rename', { hid: one.hid, title: '知识点 2', version }), 'course-book-title-taken'],
    [study.call('course.book.move', { hid: first.hid, toParent: first.hid, version }), 'course-book-move-invalid'],
    [study.call('course.book.move', { hid: first.hid, afterHid: one.hid, version }), 'course-book-move-invalid'],
    [study.call('course.book.move', { hid: two.hid, toParent: one.hid, version }), 'course-book-move-invalid'],
    [study.call('course.book.move', { hid: two.hid, version }), 'course-book-move-invalid'],
    [study.call('course.book.move', { hid: two.hid, toParent: second.hid, afterHid: one.hid, version }), 'course-book-move-invalid'],
    [study.call('course.book.move', { hid: two.hid, afterHid: two.hid, version }), 'course-book-move-invalid'],
    [study.call('course.book.delete', { hid: one.hid, children: 'drop', version }), 'course-book-children-invalid'],
    [study.call('course.book.delete', { hid: 'unplaced', version }), 'course-book-node-missing'],
    [study.call('course.book.delete', { hid: one.hid, version: version + 5 }), 'course-book-conflict'],
  ];
  for (const [promise, code] of cases) assert.equal(await codeOf(promise), code);
  // Bilingual: the Chinese interface gets both, the English one English.
  await assert.rejects(study.call('course.book.move', { hid: first.hid, toParent: first.hid, version }), error => error.message === '一个节点不能移到它自己里面 / A node cannot go inside itself');
  await assert.rejects(study.call('course.book.move', { hid: first.hid, toParent: first.hid, version, uiLanguage: 'en' }), error => error.message === 'A chapter or point cannot go inside itself' && error.code === 'course-book-move-invalid');
  // A missing version or a wrong type is said by the input schema before anything runs.
  await assert.rejects(study.call('course.book.rename', { hid: one.hid, title: 'x' }), /version is required/);
  await assert.rejects(study.call('course.book.move', { hid: one.hid, toParent: first.hid, version: '1' }), /version must be integer/);
  const after = await study.call('book.toc', { limit: 40 });
  assert.deepEqual(rowsOf(after), rowsOf(toc));
  assert.equal(after.structureVersion, version);
});

test('two structure changes at the same moment from the same version: one queue, the first is done, the second is refused, never half of each', async t => {
  const { study, toc } = await fourteen(t);
  const version = toc.structureVersion, one = byTitle(toc, '知识点 1'), first = byTitle(toc, '第 1 章'), mine = (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine;
  const [renamed, moved, saved] = await Promise.allSettled([
    study.call('course.book.rename', { hid: one.hid, title: '第一个', version }),
    study.call('course.book.move', { hid: one.hid, toParent: 'book', version }),
    study.call('course.book.save', { file: mine.name, text: '同时写的笔记。', version: mine.version }),
  ]);
  assert.equal(renamed.status, 'fulfilled');
  assert.equal(moved.status, 'rejected');
  assert.equal(moved.reason.code, 'course-book-conflict');
  assert.equal(saved.status, 'fulfilled', 'a file save does not need the structure version');
  const now = await study.call('book.toc', { limit: 40 });
  assert.equal(byTitle(now, '第一个').n, '1.1');
  assert.equal(now.structureVersion, version + 1);
  assert.equal(byTitle(now, '第 1 章').hid, first.hid);
  assert.equal((await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine.text, '同时写的笔记。');
});

test('a renamed title stays when the outline is rebuilt (matched by its id); the structure version moves with the rebuild', async t => {
  const { study } = await bookService(t);
  const toc = await study.call('book.toc'), what = toc.toc[1];
  const renamed = await study.call('course.book.rename', { hid: what.hid, title: '架构师做什么', version: toc.structureVersion });
  // The outline made again: a new record with the same points (a new id), as 重新整理 does.
  await study.store.update(state => {
    const outline = state.sources.find(source => source.courseOutline && !source.archived);
    const again = structuredClone(outline);
    again.id = `${outline.id}-again`;
    again.createdAt = '2026-10-10T00:00:00.000Z';
    again.courseOutline.nodes[0].children[0].title = 'What architects really do';
    outline.archived = true;
    state.sources.push(again);
    const notes = state.sources.find(source => source.provenance === 'course-outline-notes');
    notes.courseNotes.outlineId = again.id;
  });
  const rebuilt = await study.call('book.toc');
  const row = rebuilt.toc.find(item => item.hid === what.hid);
  assert.equal(row?.title, '架构师做什么', 'the learner\'s title is kept for the same point');
  assert.ok(rebuilt.structureVersion > renamed.structureVersion, 'a rebuild changes the structure: an old version is stale');
  const opened = await study.call('course.book.open');
  assert.equal(opened.moves, undefined, 'a kept title is not reported as a move');
  // The rename was made on the old outline: it can no longer be undone (that would bring back the old layout), and says so.
  assert.equal(await codeOf(study.call('course.book.revert', { file: STRUCTURE_FILE })), 'course-book-conflict');
});

test('the actions are registered with input schemas, write the sources, and are written in the book contract', async t => {
  const { study } = await bookService(t);
  const capabilities = study.runtime.capabilities();
  for (const [operation, keys] of [['course.book.rename', ['hid', 'title', 'version']], ['course.book.move', ['hid', 'toParent', 'afterHid', 'beforeHid', 'version']],
    ['course.book.delete', ['hid', 'children', 'version']], ['course.book.save', ['file', 'text', 'version']], ['book.write', ['hid', 'op', 'heading', 'after', 'before', 'within', 'position']]]) {
    const found = filterCapabilities(capabilities, { operation }).contexts[0]?.operations[0];
    assert.ok(found, operation);
    for (const key of keys) assert.ok(found.input?.properties?.[key], `${operation} declares ${key}`);
    assert.ok(found.description.length > 40, `${operation} says what it does`);
    if (operation.startsWith('course.book.') && operation !== 'course.book.save') assert.deepEqual(found.input.required, ['hid', 'version']);
    if (operation !== 'book.write') assert.deepEqual(writesFor('library', operation), ['sources']);
  }
  assert.match(filterCapabilities(capabilities, { operation: 'course.book.save' }).contexts[0].operations[0].description, new RegExp(String(FILE_TEXT_MAX)));
  for (const text of ['course.book.rename {course?,hid,title,version}', 'course.book.move {course?,hid,toParent?,afterHid?,beforeHid?,version}', 'course.book.delete {course?,hid,children?:promote|toUnplaced,version}', "book.write {course?,hid,file?,op:insert"])
    assert.ok(libraryContracts.book.includes(text), text);
  assert.ok(libraryContracts.book.length < 6000);
});

test('one file of the book holds up to FILE_TEXT_MAX characters (2 000 000, #458); one more is refused', async t => {
  const { study } = await bookService(t);
  assert.equal(FILE_TEXT_MAX, 2_000_000);
  const toc = await study.call('book.toc'), mine = (await study.call('book.read', { hid: toc.toc[1].hid, file: 'mine' })).files.mine;
  const long = `${'长'.repeat(999)}\n`.repeat(1000);
  const saved = await study.call('course.book.save', { file: mine.name, text: long, version: mine.version });
  assert.equal(saved.write, 'saved');
  assert.equal(saved.files[mine.name].version, mine.version + 1);
  const refused = await study.call('course.book.save', { file: mine.name, text: 'x'.repeat(FILE_TEXT_MAX + 1), version: mine.version + 1 }).then(() => null, error => error);
  assert.match(refused.code, /^course-book-text-/);
  assert.match(refused.message, /2000000/);
});
