/* book.write's section operations (#459): insert a section at a place (after / before / within a heading, or the file's start or end) instead of the
   end of the file, delete one (its sub-sections promoted, deleted with it, or sent to 未归位 with their footnotes), rename one (title only, id kept),
   move one with what is below it (id kept, levels follow the new place). Headings are named by their ids (book.read lists them); a second heading of
   the same title is refused; an unknown op is refused naming the allowed ones; every op keeps the version it replaced. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookService, pageLine } from './helpers/book-agent-library.mjs';
import { SECTION_OPS } from '../lib/book-section-ops.js';

const REAL = 'the architect records this decision and its reasons';
const codeOf = promise => promise.then(() => null, error => error.code ?? error.message);
const read = async (study, hid, kind = 'gen') => (await study.call('book.read', { hid, file: kind })).files[kind];
const outline = file => file.headings.map(heading => `${'#'.repeat(heading.level)} ${heading.title}`);
const idOf = (file, title) => file.headings.find(heading => heading.title === title)?.id;

/** One point whose generated file has 三 sections, the second with a sub-section, and a footnote in the first. */
async function setup(t) {
  const made = await bookService(t);
  const toc = await made.study.call('book.toc'), what = toc.toc[1];
  await made.study.call('book.write', { hid: what.hid, markdown: `#### 一、概念\n\n架构师做决定[^1]。\n\n#### 二、做法\n\n先写日志。\n\n##### 二点一、细节\n\n日志要有理由。\n\n#### 三、误区\n\n以为不用写。\n\n[^1]: 「${REAL}」 (document-l1-p1)` });
  return { ...made, what, file: await read(made.study, what.hid) };
}

test('insert: at the place named, never the end unless asked; a same-named heading is refused; the answer names the new id', async t => {
  const { study, what, file } = await setup(t);
  const after = await study.call('book.write', { hid: what.hid, op: 'insert', after: idOf(file, '一、概念'), section: { heading: '一点五、补充', markdown: '补写的一节。' } });
  assert.equal(after.status, 'saved');
  assert.match(after.section?.id ?? '', /^h\d+$/, 'the new heading\'s id is in the answer');
  let now = await read(study, what.hid);
  assert.deepEqual(outline(now), ['#### 一、概念', '#### 一点五、补充', '#### 二、做法', '##### 二点一、细节', '#### 三、误区']);
  assert.equal(idOf(now, '一点五、补充'), after.section.id);
  assert.match(now.text, /一点五、补充 <!-- sh:id h\d+ -->\n\n补写的一节。\n\n#### 二、做法/);
  assert.match(now.text, /\*\*出处\*\*/, 'the footnotes stay at the end, after every section');
  assert.ok(now.text.indexOf('补写的一节') < now.text.indexOf('**出处**'));

  await study.call('book.write', { hid: what.hid, op: 'insert', before: idOf(now, '一、概念'), section: { heading: '零、引子', markdown: '开场。' } });
  await study.call('book.write', { hid: what.hid, op: 'insert', within: idOf(now, '二、做法'), section: { heading: '二点二、例子', markdown: '一个例子。' } });
  await study.call('book.write', { hid: what.hid, op: 'insert', position: 'end', section: { heading: '四、小结', markdown: '收尾[^1]。\n\n[^1]: 「' + pageLine('document-l1-p2', 0).slice(0, 60) + '」 (document-l1-p2)' } });
  now = await read(study, what.hid);
  assert.deepEqual(outline(now), ['#### 零、引子', '#### 一、概念', '#### 一点五、补充', '#### 二、做法', '##### 二点一、细节', '##### 二点二、例子', '#### 三、误区', '#### 四、小结']);
  assert.match(now.text, /收尾\[\^2\]。/, 'a new footnote is numbered with the file\'s');
  // A second heading of a title the file has is refused (no 十一、性能测试 ×3), whatever the spacing or case.
  assert.equal(await codeOf(study.call('book.write', { hid: what.hid, op: 'insert', position: 'end', section: { heading: ' 三、误区 ', markdown: 'x' } })), 'book-section-exists');
  // The same title is the same whatever the spaces, the case or the width of its punctuation (#459's 十一、性能测试 ×3); numbering still counts.
  await study.call('book.write', { hid: what.hid, op: 'insert', position: 'end', section: { heading: '十一、性能测试', markdown: '正文。' } });
  for (const heading of ['十一，性能测试', '十一 、 性能测试', '十一,性能测试', '十一、　性能测试', '十一、性能测试 ']) assert.equal(await codeOf(study.call('book.write', { hid: what.hid, op: 'insert', position: 'end', section: { heading, markdown: 'x' } })), 'book-section-exists', heading);
  for (const heading of ['十二、性能测试', '11、性能测试', 'Ten, Testing']) assert.equal((await study.call('book.write', { hid: what.hid, op: 'insert', position: 'end', section: { heading, markdown: 'y' } })).status, 'saved', heading);
  assert.equal(await codeOf(study.call('book.write', { hid: what.hid, op: 'insert', position: 'end', section: { heading: 'TEN，TESTING', markdown: 'y' } })), 'book-section-exists');
  // A section that starts with its own heading line takes it as its heading (as section writes do).
  const own = await study.call('book.write', { hid: what.hid, op: 'insert', position: 'start', section: { heading: '序', markdown: '#### 序\n\n最前面。' } });
  assert.equal(outline(await read(study, what.hid))[0], '#### 序');
  assert.ok(own.section.id);
});

test('rename keeps the id and the text; move carries the sub-sections and follows the new level; delete leaves no shell', async t => {
  const { study, what, file } = await setup(t);
  const two = idOf(file, '二、做法'), sub = idOf(file, '二点一、细节'), three = idOf(file, '三、误区'), one = idOf(file, '一、概念');
  const renamed = await study.call('book.write', { hid: what.hid, op: 'rename', heading: two, title: '二、怎么做' });
  assert.equal(renamed.section.id, two);
  let now = await read(study, what.hid);
  assert.equal(idOf(now, '二、怎么做'), two);
  assert.match(now.text, /二、怎么做 <!-- sh:id h\d+ -->\n\n先写日志。/);
  assert.equal(await codeOf(study.call('book.write', { hid: what.hid, op: 'rename', heading: two, title: '三、误区' })), 'book-section-exists');

  // Move 三 before 一: the order changes, ids stay.
  await study.call('book.write', { hid: what.hid, op: 'move', heading: three, before: one });
  now = await read(study, what.hid);
  assert.deepEqual(outline(now), ['#### 三、误区', '#### 一、概念', '#### 二、怎么做', '##### 二点一、细节']);
  assert.equal(idOf(now, '三、误区'), three);
  // Move 二 (with its sub-section) inside 一: one level deeper each.
  await study.call('book.write', { hid: what.hid, op: 'move', heading: two, within: one });
  now = await read(study, what.hid);
  assert.deepEqual(outline(now), ['#### 三、误区', '#### 一、概念', '##### 二、怎么做', '###### 二点一、细节']);
  assert.match(now.text, /架构师做决定\[\^1\]。\n\n##### 二、怎么做/, 'it goes after the text of 一');
  // A section cannot go inside itself.
  assert.equal(await codeOf(study.call('book.write', { hid: what.hid, op: 'move', heading: two, after: sub })), 'book-section-move-invalid');
  assert.equal(await codeOf(study.call('book.write', { hid: what.hid, op: 'move', heading: two, within: two })), 'book-section-move-invalid');
  // Back to the end of the file, at the top level of the point.
  await study.call('book.write', { hid: what.hid, op: 'move', heading: two, position: 'end' });
  assert.deepEqual(outline(await read(study, what.hid)), ['#### 三、误区', '#### 一、概念', '#### 二、怎么做', '##### 二点一、细节']);

  // Delete with promote (the default): 二's own text goes, its sub-section takes its level.
  await study.call('book.write', { hid: what.hid, op: 'delete', heading: two });
  now = await read(study, what.hid);
  assert.deepEqual(outline(now), ['#### 三、误区', '#### 一、概念', '#### 二点一、细节']);
  assert.doesNotMatch(now.text, /先写日志|怎么做/);
  // Delete 一 with what it cites: its footnote leaves the 出处 too, no shell or placeholder stays.
  await study.call('book.write', { hid: what.hid, op: 'delete', heading: one, children: 'delete' });
  now = await read(study, what.hid);
  assert.deepEqual(outline(now), ['#### 三、误区', '#### 二点一、细节']);
  assert.doesNotMatch(now.text, /架构师做决定|出处|待补|一、概念/);
  // The version before each op is kept: one revert brings 一 back.
  await study.call('course.book.revert', { file: now.name });
  assert.match((await read(study, what.hid)).text, /架构师做决定\[\^1\]/);
});

test('delete to 未归位: the section and its sub-sections leave the point and wait in 未归位 with their footnotes', async t => {
  const { study, what, file } = await setup(t);
  const done = await study.call('book.write', { hid: what.hid, op: 'delete', heading: idOf(file, '一、概念'), children: 'toUnplaced' });
  assert.equal(done.status, 'saved');
  assert.deepEqual(outline(await read(study, what.hid)), ['#### 二、做法', '##### 二点一、细节', '#### 三、误区']);
  const book = await study.call('course.book.open');
  assert.match(book.unplaced.text, /^### 一、概念 <!-- sh:id h\d+ -->/m, 'the heading keeps its id in 未归位');
  const mark = /架构师做决定\[\^([\w-]+)\]。/.exec(book.unplaced.text)?.[1];
  assert.ok(mark && mark !== '1', 'the footnote is renamed for 未归位');
  assert.ok(book.unplaced.text.includes(`[^${mark}]: [「${REAL}」](studyhub://source/document-l1-p1)`), 'its definition comes along');
  assert.ok(book.history['unplaced.md'] >= 1 && book.history[file.name] >= 2, 'both files keep the version before');
});

test('refusals: an unknown op names the allowed ones; a missing id, a missing place, a mix of modes; nothing is written', async t => {
  const { study, what, file } = await setup(t);
  const unknown = await study.call('book.write', { hid: what.hid, op: 'replace', heading: idOf(file, '一、概念') }).then(() => null, error => error);
  assert.equal(unknown.code, 'book-write-op');
  for (const op of SECTION_OPS) assert.match(unknown.message, new RegExp(op));
  assert.deepEqual(SECTION_OPS, ['insert', 'delete', 'rename', 'move']);
  const one = idOf(file, '一、概念');
  for (const [args, code] of [
    [{ op: 'delete', heading: 'h999' }, 'book-section-missing'],
    [{ op: 'rename', heading: one, title: '' }, 'book-write-op'],
    [{ op: 'move', heading: one }, 'book-write-op'],
    [{ op: 'move', heading: one, after: one, before: one }, 'book-write-op'],
    [{ op: 'insert', after: 'h999', section: { heading: '新', markdown: 'x' } }, 'book-section-missing'],
    [{ op: 'insert', after: one, section: { heading: '新', markdown: 'x' }, markdown: 'y' }, 'book-write-mode'],
    [{ op: 'insert', position: 'middle', section: { heading: '新', markdown: 'x' } }, 'book-write-op'],
    [{ op: 'delete', heading: one, children: 'drop' }, 'book-write-op'],
    [{ op: 'insert', position: 'end', section: { heading: '新', markdown: 'x'.repeat(20_001) } }, 'book-write-too-long'],
  ]) assert.equal(await codeOf(study.call('book.write', { hid: what.hid, ...args })), code, JSON.stringify(args).slice(0, 80));
  assert.equal((await read(study, what.hid)).version, file.version, 'nothing was written');
});
