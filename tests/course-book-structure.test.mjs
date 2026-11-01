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

const leafOf = (book, hid) => { const walk = list => list.flatMap(node => [node, ...walk(node.children || [])]); return walk(book.nodes).find(node => node.hid === hid); };
/** The outline made again (a new record, as 重新整理 does), each point's title through `retitle`; `keep` picks the points that stay. */
async function rebuild(study, retitle, keep = () => true, chapter = title => title) {
  await study.store.update(state => {
    const outline = state.sources.find(source => source.provenance === 'course-outline' && !source.archived), again = structuredClone(outline);
    again.id = `${outline.id}-again`;
    again.createdAt = '2026-10-10T00:00:00.000Z';
    for (const node of again.courseOutline.nodes) Object.assign(node, { title: chapter(node.title), children: node.children.filter(keep).map(point => ({ ...point, title: retitle(point.title) })) });
    outline.archived = true;
    state.sources.push(again);
    state.sources.find(source => source.provenance === 'course-outline-notes').courseNotes.outlineId = again.id;
  });
  // These tests are about the layout after it: the learner's go-ahead (the gate itself is tests/course-book-rebuild-undo.test.mjs).
  const looked = await study.call('course.book.open');
  if (looked.status === 'rebuild-pending') await study.call('course.book.rebuild', { action: 'apply', outlineId: looked.moves.outlineId });
}

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
  // A shell: only the generated text, nothing of the learner's.
  const shell = byTitle(toc, '知识点 7');
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
  assert.match((await study.call('book.read', { hid: shell.hid, file: 'gen' })).files.gen.text, /练 5 道：知识点 7/);
});

test('a deleted point with the learner\'s notes: the notes wait in 未归位 by default (never only in the history); undo still works after 20 small writes', async t => {
  const { study, toc } = await fourteen(t);
  const five = byTitle(toc, '知识点 5'), six = byTitle(toc, '知识点 6');
  const mine = (await study.call('book.read', { hid: five.hid, file: 'mine' })).files.mine;
  await study.call('course.book.save', { file: mine.name, text: '#### 五的小结\n\n五的笔记，只有这一份。', version: mine.version });
  const gone = await study.call('course.book.delete', { hid: five.hid, version: toc.structureVersion });
  assert.equal(gone.removed.toUnplaced, 1);
  let book = await study.call('course.book.open');
  assert.match(book.unplaced.text, /### 知识点 5\n\n#### 五的小结 <!-- sh:id h\d+ -->\n\n五的笔记，只有这一份。/);
  // 20 small writes of another file: the files' history allowance rolls over (未归位's entry of the delete with it), the structure's is its own.
  const other = (await study.call('book.read', { hid: six.hid, file: 'mine' })).files.mine;
  for (let i = 1, version = other.version; i <= 20; i += 1, version += 1) await study.call('course.book.save', { file: other.name, text: `第 ${i} 版。`, version });
  book = await study.call('course.book.revert', { file: STRUCTURE_FILE, answer: 'book' });
  assert.equal(book.write, 'reverted');
  assert.match((await study.call('book.read', { hid: five.hid, file: 'mine' })).files.mine.text, /五的笔记，只有这一份。/, 'the point is back with its notes');
  assert.deepEqual(book.kept, ['unplaced.md'], '未归位 is left as it is (its text from before is no longer kept): the notes are in both, never in neither');
  assert.match(book.unplaced.text, /五的笔记，只有这一份。/);
});

test('every file a structure change rewrites keeps its own previous version: the file\'s 回退到上一版 steps back exactly that write', async t => {
  const { study, toc } = await fourteen(t);
  const one = byTitle(toc, '知识点 1');
  // mine T1, T2, then a move that shifts its headings; the file's revert gives T2 back (shifted back), then T1.
  let mine = (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine;
  await study.call('course.book.save', { file: mine.name, text: '#### 甲\n\nT1', version: mine.version });
  await study.call('course.book.save', { file: mine.name, text: '#### 甲\n\nT2', version: mine.version + 1 });
  await study.call('course.book.move', { hid: one.hid, toParent: 'book', version: toc.structureVersion });
  mine = (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine;
  assert.match(mine.text, /^### 甲 <!-- sh:id h\d+ -->\n\nT2$/);
  let back = await study.call('course.book.revert', { file: mine.name });
  assert.match(leafOf(back, one.hid).mine, /^#### 甲 <!-- sh:id h\d+ -->\n\nT2$/, 'one step back: the text before the move');
  back = await study.call('course.book.revert', { file: mine.name });
  assert.match(leafOf(back, one.hid).mine, /T1$/, 'then the save before');
  // The structure undo still works: the file written since is left as it is and named.
  back = await study.call('course.book.revert', { file: STRUCTURE_FILE, answer: 'book' });
  assert.deepEqual(back.kept, [mine.name]);
  assert.equal(byTitle(await study.call('book.toc', { limit: 40 }), '知识点 1').n, '1.1');
  assert.match(leafOf(back, one.hid).mine, /T1$/);
  // A revert never destroys a text: redo brings back what each revert replaced, newest first.
  back = await study.call('course.book.revert', { file: mine.name, redo: true });
  assert.equal(back.write, 'redone');
  assert.match(leafOf(back, one.hid).mine, /T2$/);
});

test('T1: notes sent to 未归位 by a delete, then 未归位\'s 回退到上一版, then the structure undo: the notes are back in their point, never lost', async t => {
  const { study, toc } = await fourteen(t);
  const five = byTitle(toc, '知识点 5'), mine = (await study.call('book.read', { hid: five.hid, file: 'mine' })).files.mine;
  await study.call('course.book.save', { file: mine.name, text: '五的笔记。', version: mine.version });
  await study.call('course.book.delete', { hid: five.hid, version: toc.structureVersion });
  let book = await study.call('course.book.revert', { file: 'unplaced.md' });
  assert.equal(book.unplaced.text, '');
  // The revert kept what it replaced: redo would bring the notes back to 未归位 ...
  book = await study.call('course.book.revert', { file: STRUCTURE_FILE, answer: 'book' });
  assert.equal(book.write, 'reverted');
  assert.equal(book.kept, undefined, '未归位 already holds its text from before: nothing to leave');
  assert.equal(book.unplaced.text, '');
  assert.equal(leafOf(book, five.hid).mine, '五的笔记。', '... and the undo puts them back in their point');
  // ... and the reverted text can still be brought back to 未归位 (a second copy, never a lost one).
  book = await study.call('course.book.revert', { file: 'unplaced.md', redo: true });
  assert.match(book.unplaced.text, /五的笔记。/);
});

test('T7: an edit after a move, then the structure undo: the edit stays where it is; an undo never asks for a destructive revert and never blocks older ones', async t => {
  const { study, toc } = await fourteen(t);
  const one = byTitle(toc, '知识点 1'), three = byTitle(toc, '知识点 3');
  let mine = (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine;
  await study.call('course.book.save', { file: mine.name, text: '#### 旧笔记\n\nold notes', version: mine.version });
  const version = (await study.call('course.book.move', { hid: one.hid, toParent: 'book', version: toc.structureVersion })).structureVersion;
  mine = (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine;
  await study.call('course.book.save', { file: mine.name, text: `${mine.text}\n\n新的一段。`, version: mine.version });
  // A second change after the edit; then both are undone, newest first: neither is refused.
  assert.equal((await study.call('course.book.rename', { hid: three.hid, title: '第三个', version })).write, 'renamed');
  let back = await study.call('course.book.revert', { file: STRUCTURE_FILE });
  assert.equal(byTitle(await study.call('book.toc', { limit: 40 }), '知识点 3').hid, three.hid);
  back = await study.call('course.book.revert', { file: STRUCTURE_FILE });
  // The undo answers small (the chat sees `kept` whole, under the host's cut), with what to tell the learner.
  assert.ok(JSON.stringify(back).length < 1500, `${JSON.stringify(back).length} characters`);
  assert.equal(back.write, 'reverted');
  assert.deepEqual(back.kept, [mine.name]);
  assert.match(back.note, /tell the learner; never revert them/);
  back = await study.call('course.book.open');
  assert.match(leafOf(back, one.hid).mine, /old notes\n\n新的一段。$/, 'the new paragraph is still in the book');
  // There is no redo of a structure undo: refused, not taken as another undo.
  assert.equal(await codeOf(study.call('course.book.revert', { file: STRUCTURE_FILE, redo: true })), 'course-book-no-redo');
  assert.equal(byTitle(await study.call('book.toc', { limit: 40 }), '知识点 1').n, '1.1');
  // The file's own revert takes the edit out, and redo brings it back: it is never in neither the book nor the history.
  back = await study.call('course.book.revert', { file: mine.name });
  assert.doesNotMatch(leafOf(back, one.hid).mine, /新的一段/);
  back = await study.call('course.book.revert', { file: mine.name, redo: true });
  assert.match(leafOf(back, one.hid).mine, /新的一段。$/);
  assert.equal(await codeOf(study.call('course.book.revert', { file: 'unplaced.md', redo: true })), 'course-book-no-version');
});

test('未归位 gets the learner\'s text as written: every footnote label renamed (CJK too), code untouched, a line of the learner\'s with a link kept', async t => {
  const { study, toc } = await fourteen(t);
  const two = byTitle(toc, '知识点 2'), three = byTitle(toc, '知识点 3');
  const write = async (row, text) => { const file = (await study.call('book.read', { hid: row.hid, file: 'mine' })).files.mine; await study.call('course.book.save', { file: file.name, text, version: file.version }); };
  await write(two, `注一句[^注]。正则 \`[^abc]\` 不是脚注。\n\n\`\`\`\nx = s[^y]\n\`\`\`\n\n见 [练 5 道：知识点 2](studyhub://practice?heading=${two.hid}&n=5)，我常回来练。\n\n[^注]: 我的注`);
  await write(three, '另一句[^注]。\n\n[^注]: 另一个注');
  let version = (await study.call('course.book.delete', { hid: two.hid, version: toc.structureVersion })).structureVersion;
  await study.call('course.book.delete', { hid: three.hid, version });
  const text = (await study.call('course.book.open')).unplaced.text;
  assert.ok(text.includes(`注一句[^${two.hid}m-注]。`) && text.includes(`[^${two.hid}m-注]: 我的注`), text);
  assert.ok(text.includes(`另一句[^${three.hid}m-注]。`) && text.includes(`[^${three.hid}m-注]: 另一个注`), 'two points\' [^注] never collide');
  assert.ok(text.includes('正则 `[^abc]` 不是脚注。'), 'inline code untouched');
  assert.ok(text.includes('x = s[^y]'), 'fenced code untouched');
  assert.ok(text.includes('，我常回来练。'), 'a line of the learner\'s that holds a link is kept');
});

test('a point\'s headings keep their levels to each other when it moves up; one that would go above level 1 refuses the move', async t => {
  const { study, toc } = await fourteen(t);
  const one = byTitle(toc, '知识点 1'), two = byTitle(toc, '知识点 2');
  const write = async (row, text) => { const file = (await study.call('book.read', { hid: row.hid, file: 'mine' })).files.mine; await study.call('course.book.save', { file: file.name, text, version: file.version }); };
  await write(one, '### 和知识点同级\n\n文。\n\n#### 下一级\n\n文。');
  const moved = await study.call('course.book.move', { hid: one.hid, toParent: 'book', version: toc.structureVersion });
  assert.deepEqual((await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine.headings.map(heading => heading.level), [2, 3], 'shifted together, none flattened');
  await write(two, '# 顶层\n\n文。');
  assert.equal(await codeOf(study.call('course.book.move', { hid: two.hid, toParent: 'book', version: moved.structureVersion })), 'course-book-move-invalid');
  assert.equal((await study.call('book.read', { hid: two.hid, file: 'mine' })).files.mine.headings[0].level, 1);
});

test('a save on a file whose point was deleted says so and where its text is', async t => {
  const { study, toc } = await fourteen(t);
  const one = byTitle(toc, '知识点 1'), mine = (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine;
  await study.call('course.book.save', { file: mine.name, text: '笔记。', version: mine.version });
  await study.call('course.book.delete', { hid: one.hid, version: toc.structureVersion });
  const refused = await study.call('course.book.save', { file: mine.name, text: '编辑器里的新字。', version: mine.version + 1 }).then(() => null, error => error);
  assert.equal(refused.code, 'course-book-file-missing');
  assert.match(refused.message, /已被删除；里面你写的内容在「未归位」里/);
  const english = await study.call('course.book.save', { file: mine.name, text: 'x', version: 1, uiLanguage: 'en' }).then(() => null, error => error);
  assert.match(english.message, /^This point was deleted; what was written in it is in 未归位/);
  // A point deleted with nothing of the learner's says that; a file missing for any other reason keeps the plain sentence.
  const two = byTitle(toc, '知识点 2'), gen = (await study.call('book.read', { hid: two.hid, file: 'gen' })).files.gen;
  await study.call('course.book.delete', { hid: two.hid, version: toc.structureVersion + 1 });
  assert.match((await study.call('course.book.save', { file: gen.name, text: 'x', version: 1 }).then(() => null, error => error)).message, /已被删除（里面没有你写的内容）/);
  const other = await study.call('course.book.save', { file: 'p999.mine.md', text: 'x', version: 1 }).then(() => null, error => error);
  assert.equal(other.code, 'course-book-file-missing');
  assert.equal(other.message, '书里没有这份文件 / The book has no such file');
});

test('two 出处 lists that share [^1]: rename, move, delete and insert keep every mark on its own list, and a later section write keeps both notes', async t => {
  const { study, toc } = await fourteen(t);
  const one = byTitle(toc, '知识点 1');
  const text = '#### 甲\n\n甲文[^1]。\n\n**出处**\n\n[^1]: 甲的注\n\n#### 乙\n\n乙文[^1]。\n\n**出处**\n\n[^1]: 乙的注';
  const fresh = async () => {
    const book = await study.call('course.book.open'), name = leafOf(book, one.hid).files.mine;
    await study.call('course.book.save', { file: name, text, version: book.files[name].version });
    return (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine;
  };
  const both = async label => {
    const now = (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine;
    assert.match(now.text, /甲的注/, `${label}: 甲's note`);
    assert.match(now.text, /乙的注/, `${label}: 乙's note`);
    return now;
  };
  // Each op, then an ordinary section write (the footnote pipeline): both notes survive, each mark on its own.
  const ops = [['rename', (a, b) => ({ op: 'rename', heading: a, title: 'A2' })], ['move', (a, b) => ({ op: 'move', heading: b, before: a })],
    ['move within', (a, b) => ({ op: 'move', heading: b, within: a })], ['delete promote', a => ({ op: 'delete', heading: a })],
    ['insert', a => ({ op: 'insert', after: a, section: { heading: 'C', markdown: 'C text.' } })]];
  for (const [label, make] of ops) {
    const file = await fresh(), [a, b] = file.headings.map(heading => heading.id);
    const done = await study.call('book.write', { hid: one.hid, file: 'mine', ...make(a, b) });
    assert.deepEqual(done.dropped, [], label);
    const now = label === 'delete promote' ? (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine : await both(label);
    if (label === 'delete promote') { assert.doesNotMatch(now.text, /甲的注|甲文/, 'the deleted section took its own note'); assert.match(now.text, /乙文\[\^1\]。[\s\S]*\[\^1\]: 乙的注/); continue; }
    if (label !== 'insert') {
      // The bytes of every mark and note are as they were.
      for (const line of ['甲文[^1]。', '乙文[^1]。', '[^1]: 甲的注', '[^1]: 乙的注']) assert.ok(now.text.includes(line), `${label}: ${line}`);
    }
    // An ordinary section write afterwards (a section that holds no other one, with its own note): one list, each mark still on its own note.
    const [who, id] = label === 'move within' ? ['乙', b] : ['甲', a];
    await study.call('book.write', { hid: one.hid, file: 'mine', section: { heading: id, markdown: `${who}文[^1]，补一句。\n\n[^1]: ${who}的注` } });
    const after = await both(`${label} + section write`);
    const marks = [...after.text.matchAll(/甲文\[\^(\d+)\]|乙文\[\^(\d+)\]/g)].map(match => match[1] ? ['甲', match[1]] : ['乙', match[2]]);
    for (const [who, n] of marks) assert.match(after.text, new RegExp(`\\[\\^${n}\\]: ${who}的注`), `${label}: ${who}'s mark cites ${who}'s note`);
  }
  // Delete to 未归位: 甲 goes there with its own note under a label of its own; 乙 keeps its note.
  const file = await fresh();
  await study.call('book.write', { hid: one.hid, file: 'mine', op: 'delete', heading: file.headings[0].id, children: 'toUnplaced' });
  const now = (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine;
  assert.ok(now.text.includes('乙文[^1]。') && now.text.includes('[^1]: 乙的注') && !now.text.includes('甲的注'));
  const unplaced = (await study.call('course.book.open')).unplaced.text, label = /甲文\[\^([^\]]+)\]。/.exec(unplaced)?.[1];
  assert.ok(label && label !== '1' && unplaced.includes(`[^${label}]: 甲的注`), unplaced);
});

test('a rebuild parks a gone point\'s text as written: another point\'s link and the learner\'s words on its line, code and a CJK footnote all intact', async t => {
  const points = lecture => Array.from({ length: 15 }, (_, i) => ({ id: `q${i}`, title: `知识点 ${i}`, anchors: [`${lecture(Math.floor(i / 3) + 1)}#${i % 3}`] }));
  const { study } = await bookService(t, { chapters: (lecture, lectureKey) => [{ id: 'c1', title: '一', children: points(lectureKey) }] });
  const toc = await study.call('book.toc', { limit: 40 }), zero = byTitle(toc, '知识点 0'), fourteen14 = byTitle(toc, '知识点 14');
  const mine = (await study.call('book.read', { hid: zero.hid, file: 'mine' })).files.mine;
  const line = `这一点和知识点 14 一起复习：[练 5 道：知识点 14](studyhub://practice?heading=${fourteen14.hid}&n=5)，重点是边界条件，只写在这里。`;
  const own = `回到本点：[练 5 道：知识点 0](studyhub://practice?heading=${zero.hid}&n=5)，下次再看。`;
  await study.call('course.book.save', { file: mine.name, text: `${line}\n\n正则 \`[^abc]\` 匹配非 abc。\n\n${own}\n\n注一句[^注]。\n\n[^注]: 我自己的注`, version: mine.version });
  await rebuild(study, title => title, point => point.id !== 'q0');
  const parked = (await study.call('course.book.open')).unplaced.text;
  assert.ok(parked.includes(line), 'another point\'s link and the words around it stay');
  assert.ok(parked.includes('正则 `[^abc]` 匹配非 abc。'), 'inline code untouched');
  assert.ok(parked.includes('回到本点：练 5 道：知识点 0，下次再看。'), 'the gone point\'s own link is cut, the learner\'s words on its line stay');
  assert.match(parked, /注一句\[\^注-u\d+\]。/);
  assert.match(parked, /\[\^注-u\d+\]: 我自己的注/);
});

test('a delete is refused when 未归位 cannot take the learner\'s text; a section sent there likewise; nothing changes', async t => {
  const { study, toc } = await fourteen(t);
  const one = byTitle(toc, '知识点 1'), mine = (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine;
  await study.call('course.book.save', { file: mine.name, text: '#### 节\n\n一的笔记。', version: mine.version });
  const unplaced = (await study.call('course.book.open')).files['unplaced.md'];
  await study.call('course.book.save', { file: 'unplaced.md', text: 'u'.repeat(FILE_TEXT_MAX - 5), version: unplaced.version });
  assert.equal(await codeOf(study.call('course.book.delete', { hid: one.hid, version: toc.structureVersion })), 'course-book-unplaced-full');
  const heading = (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine.headings[0].id;
  assert.equal(await codeOf(study.call('book.write', { hid: one.hid, file: 'mine', op: 'delete', heading, children: 'toUnplaced' })), 'course-book-unplaced-full');
  const after = await study.call('book.toc', { limit: 40 });
  assert.equal(after.points, 14);
  assert.equal(after.structureVersion, toc.structureVersion);
  assert.match((await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine.text, /一的笔记/);
});

test('a version read before the outline was rebuilt is refused, and nothing changes', async t => {
  const { study } = await bookService(t);
  const toc = await study.call('book.toc'), what = toc.toc[1];
  const mine = (await study.call('book.read', { hid: what.hid, file: 'mine' })).files.mine;
  await study.call('course.book.save', { file: mine.name, text: '我的笔记。', version: mine.version });
  await rebuild(study, title => title);
  for (const args of [{ hid: what.hid, version: toc.structureVersion }])
    assert.equal(await codeOf(study.call('course.book.delete', args)), 'course-book-conflict');
  assert.equal(await codeOf(study.call('course.book.move', { hid: what.hid, toParent: 'book', version: toc.structureVersion })), 'course-book-conflict');
  const now = await study.call('book.toc');
  assert.equal(now.toc[1].hid, what.hid);
  assert.equal(now.points, 2);
  assert.equal((await study.call('book.read', { hid: what.hid, file: 'mine' })).files.mine.text, '我的笔记。');
  assert.ok(now.structureVersion > toc.structureVersion);
});

test('a heading is never pushed past level 6: such a move is refused, not flattened', async t => {
  const { study } = await bookService(t, { chapters: lecture => [{ id: 'c1', title: '一', children: [{ id: 's1', title: '小节', children: [{ id: 'p1', title: '深的点', anchors: [`${lecture}#0`] }] }, { id: 'p2', title: '浅的点', anchors: [`${lecture}#1`] }] }] });
  const toc = await study.call('book.toc'), shallow = toc.toc.find(row => row.title === '浅的点'), section = toc.toc.find(row => row.title === '小节');
  await study.call('book.write', { hid: shallow.hid, file: 'mine', markdown: '#### 甲\n\n##### 乙\n\n###### 丙\n\n最深。' });
  assert.equal(await codeOf(study.call('course.book.move', { hid: shallow.hid, toParent: section.hid, version: toc.structureVersion })), 'course-book-move-invalid');
  const file = (await study.call('book.read', { hid: shallow.hid, file: 'mine' })).files.mine;
  assert.deepEqual(file.headings.map(heading => heading.level), [4, 5, 6]);
  // Inside one file: a section within the level-6 heading, or 甲 (levels 4-6) moved inside another level-4 section, is refused too.
  const [a, , c] = file.headings.map(heading => heading.id);
  assert.equal(await codeOf(study.call('book.write', { hid: shallow.hid, file: 'mine', op: 'insert', within: c, section: { heading: '丁', markdown: 'x' } })), 'book-section-move-invalid');
  const added = await study.call('book.write', { hid: shallow.hid, file: 'mine', op: 'insert', position: 'end', section: { heading: '戊', markdown: '另一节。' } });
  assert.equal(await codeOf(study.call('book.write', { hid: shallow.hid, file: 'mine', op: 'move', heading: a, within: added.section.id })), 'book-section-move-invalid');
  assert.deepEqual((await study.call('book.read', { hid: shallow.hid, file: 'mine' })).files.mine.headings.map(heading => heading.level), [4, 5, 6, 4]);
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

test('a rebuild keeps a point\'s title by its id; a renamed chapter only while the outline titles it the same; a point that is gone waits in 未归位 under the title the book showed', async t => {
  const { study } = await bookService(t);
  const toc = await study.call('book.toc'), [chapter, what] = toc.toc;
  let version = (await study.call('course.book.rename', { hid: chapter.hid, title: '导论', version: toc.structureVersion })).structureVersion;
  await study.call('course.book.rename', { hid: what.hid, title: '架构师做什么', version });
  const mine = (await study.call('book.read', { hid: what.hid, file: 'mine' })).files.mine;
  await study.call('course.book.save', { file: mine.name, text: '我的笔记。', version: mine.version });
  // The new outline titles the chapter differently and no longer has the point.
  await rebuild(study, title => title, point => point.id !== 'what', () => 'Intro (rebuilt)');
  const book = await study.call('course.book.open');
  assert.equal(book.nodes[0].title, 'Intro (rebuilt)', 'a chapter is matched by the outline\'s title: renamed by the outline, the learner\'s title goes');
  assert.match(book.unplaced.text, /### 架构师做什么（已无对应知识点）\n\n我的笔记。/);
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
  // course.book.save and book.write only describe their keys: every mistake still gets the action's own coded refusal, not a schema error.
  for (const operation of ['course.book.save', 'book.write']) assert.equal(filterCapabilities(capabilities, { operation }).contexts[0].operations[0].input.required, undefined, operation);
  const toc = await study.call('book.toc'), point = toc.toc[1], file = (await study.call('book.read', { hid: point.hid, file: 'mine' })).files.mine;
  for (const [action, args, code] of [
    ['course.book.save', { file: file.name, version: file.version }, 'course-book-text-missing'],
    ['course.book.save', { file: file.name, text: 42, version: file.version }, 'course-book-text-missing'],
    ['course.book.save', { file: file.name, text: 'x' }, 'course-book-version-required'],
    ['course.book.save', { file: file.name, text: 'x', version: '1' }, 'course-book-version-required'],
    ['book.write', { markdown: 'x' }, 'book-point-missing'],
    ['book.write', { hid: point.hid, section: 'x' }, 'book-write-mode'],
    ['book.write', { hid: point.hid, edits: 'x' }, 'book-write-mode'],
    ['book.write', { hid: point.hid, op: 7, heading: 'h1' }, 'book-write-op'],
  ]) assert.equal(await codeOf(study.call(action, args)), code, `${action} ${JSON.stringify(args)}`);
  // Short: the library context's listing must stay under what the host shows of a tool result (8 192 characters). It was 9 979 before source.courses.set
  // got its schema (#465, +216) and 10 195 with it; leaving out the fields at their default (empty description and output, requiresModel false, available true) made it 6 268.
  const listing = JSON.stringify(filterCapabilities(capabilities, { context: 'library' }));
  assert.ok(listing.length < 6_400, `study_capabilities {context: 'library'} is ${listing.length} characters`);
  for (const operation of ['course.book.save', 'course.book.rename', 'course.book.move', 'course.book.delete', 'book.write'])
    assert.ok(JSON.stringify(filterCapabilities(capabilities, { operation }).contexts[0].operations[0]).length < 450, operation);
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
