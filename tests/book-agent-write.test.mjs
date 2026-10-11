/* book.write (docs/review-book-agent.md): the main chat writes one point's file, one section or a few edits of the 复习全书. Footnotes checked word for
   word against the materials (an unfound quote is taken out and named, twice -> advice to delete the sentence), the learner's own files only when named,
   a stale whole-file write saved with the other text as a suggestion, course.book.revert undoes, a language warning, a small answer, and the book's one
   writer queue shared with the editor's saves. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shiftHeadings, writeBookPoint } from '../lib/book-agent-write.js';
import { parseFootnote, settleFootnotes } from '../lib/book-footnotes.js';
import { openCourseBook } from '../lib/course-book-files.js';
import { libraryContracts } from '../lib/study-contracts.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { bookLibrary, bookService, pageLine, sizeOf } from './helpers/book-agent-library.mjs';

const REAL = 'the architect records this decision and its reasons';
const FAKE = 'the architect always flies to the moon before lunch';
const SMALL = 1500;

async function setup(t, options) {
  const made = await bookService(t, options);
  const toc = await made.study.call('book.toc'), [what, who] = toc.toc.slice(1);
  return { ...made, what, who };
}
const fileOf = async (study, hid, kind = 'gen') => (await study.call('book.read', { hid, file: kind })).files[kind];

test('a whole generated file: the real quote is kept in the book\'s form, the made-up one taken out and named; the answer is small and holds no text', async t => {
  const { study, what } = await setup(t);
  const done = await study.call('book.write', { hid: what.hid, markdown: `## 为什么要记决策\n\n架构师要把每个决定和理由写下来[^1]，而且不是事后补[^2]。（资料以外）\n\n[^1]: 「${REAL}」 (document-l1-p1)\n[^2]: 「${FAKE}」 (document-l1-p1)` });
  assert.equal(done.status, 'saved');
  assert.equal(done.file, 'gen');
  assert.deepEqual(done.dropped, [{ n: '2', quote: FAKE, reason: 'not-found' }]);
  assert.equal(done.outsideCount, 1);
  assert.ok(sizeOf(done) < SMALL, `${sizeOf(done)} characters`);
  assert.equal(JSON.stringify(done).includes('为什么要记决策'), false, 'no book text in the answer');
  const gen = await fileOf(study, what.hid);
  assert.equal(gen.forked, true, 'the chat\'s text is the learner\'s: the generator never writes over it');
  assert.match(gen.text, /写下来\[\^1\]，而且不是事后补。/, 'the unfound mark is taken out');
  assert.match(gen.text, new RegExp(`\\[\\^1\\]: \\[「${REAL}」\\]\\(studyhub://source/document-l1-p1\\)`));
  assert.doesNotMatch(gen.text, /flies to the moon/);
  assert.match(gen.text, /\*\*出处\*\*/);
  assert.match(gen.text.trim().split('\n').at(-1), /^\[练 5 道：What architects do\]\(studyhub:\/\/practice\?/, 'the 练 5 道 line stays last');
  assert.equal(gen.headings[0].level, 4, 'headings below the point\'s own (level 3)');
  assert.ok(done.warnings.some(warning => /headings moved/.test(warning)));
  assert.equal(done.version, gen.version);

  // The same made-up quote again: named as dropped twice, with the advice to delete the sentence.
  const again = await study.call('book.write', { hid: what.hid, section: { heading: '为什么要记决策', markdown: `不是事后补[^1]。\n\n[^1]: 「${FAKE}」 (document-l1-p1)` } });
  assert.equal(again.dropped[0].again, true);
  assert.match(again.advice, /Delete the sentence/);
  // A real quote whose source id is wrong is still found in the point's own pages.
  const moved = await study.call('book.write', { hid: what.hid, section: { heading: '为什么要记决策', markdown: `要写下来[^1]。\n\n[^1]: 「${REAL}」 (no-such-source)` } });
  assert.deepEqual(moved.dropped, []);
  assert.match((await fileOf(study, what.hid)).text, /studyhub:\/\/source\/document-l1-p/);
});

test('the learner\'s own file is written only when named; a point gets a Q&A file when it is named', async t => {
  const { study, what } = await setup(t);
  await study.call('book.write', { hid: what.hid, markdown: '这一节讲架构师做什么。' });
  const mine = await fileOf(study, what.hid, 'mine');
  assert.deepEqual([mine.text, mine.version], ['', 1], 'the own file is untouched by a write of gen');
  const own = await study.call('book.write', { hid: what.hid, file: 'mine', markdown: '我的笔记：先记住为什么。' });
  assert.equal(own.status, 'saved');
  assert.equal((await fileOf(study, what.hid, 'mine')).text, '我的笔记：先记住为什么。');
  const qa = await study.call('book.write', { hid: what.hid, file: 'qa', markdown: '问：为什么要写决策日志？答：以后的人要知道理由。' });
  assert.equal(qa.status, 'saved');
  assert.match((await fileOf(study, what.hid, 'qa')).text, /决策日志/);
  await assert.rejects(study.call('book.write', { hid: what.hid, file: 'notes', markdown: 'x' }), error => error.code === 'book-file-invalid');
});

test('a section: only that heading\'s part changes, its footnotes numbered with the file\'s; a new heading is added; edits replace exact words once', async t => {
  const { study, what } = await setup(t);
  await study.call('book.write', { hid: what.hid, markdown: `#### 是什么\n\n架构师做决定[^1]。\n\n#### 怎么做\n\n旧的做法。\n\n[^1]: 「${REAL}」 (document-l1-p1)` });
  const before = await fileOf(study, what.hid), how = before.headings.find(heading => heading.title === '怎么做');
  const done = await study.call('book.write', { hid: what.hid, section: { heading: how.id, markdown: `新的做法：写进日志[^1]。\n\n[^1]: 「${pageLine('document-l1-p2', 0).slice(0, 70)}」 (document-l1-p2)` } });
  assert.deepEqual(done.dropped, []);
  const after = await fileOf(study, what.hid);
  assert.match(after.text, /架构师做决定\[\^1\]。/, 'the other section and its footnote stay');
  assert.match(after.text, /新的做法：写进日志\[\^2\]。/, 'the section\'s own [^1] is the file\'s [^2]');
  assert.doesNotMatch(after.text, /旧的做法/);
  assert.equal(after.headings.find(heading => heading.title === '怎么做').id, how.id, 'the heading keeps its id');
  const added = await study.call('book.write', { hid: what.hid, section: { heading: '常见误区', markdown: '以为决定不用写理由。' } });
  assert.ok(added.warnings.some(warning => /added as a new section/.test(warning)));
  assert.match((await fileOf(study, what.hid)).text, /#### 常见误区 <!-- sh:id h\d+ -->\n\n以为决定不用写理由。/);
  await assert.rejects(study.call('book.write', { hid: what.hid, section: { heading: 'h999', markdown: 'x' } }), error => error.code === 'book-section-missing');
  const edited = await study.call('book.write', { hid: what.hid, edits: [{ find: '以为决定不用写理由。', replace: '以为决定不用写理由，其实理由最重要。' }] });
  assert.equal(edited.status, 'saved');
  await assert.rejects(study.call('book.write', { hid: what.hid, edits: [{ find: '。', replace: '！' }] }), error => error.code === 'book-edit-find');
  assert.match((await fileOf(study, what.hid)).text, /其实理由最重要/);
  const same = await study.call('book.write', { hid: what.hid, edits: [{ find: '其实理由最重要', replace: '其实理由最重要' }] });
  assert.equal(same.status, 'unchanged');
});

test('a stale whole-file write is saved and the editor\'s text waits as a suggestion; course.book.revert undoes the chat\'s write', async t => {
  const { study, what } = await setup(t);
  const start = await fileOf(study, what.hid);
  await study.call('course.book.save', { file: start.name, text: `${start.text}\n\n编辑器里加的一句。`, version: start.version });
  const done = await study.call('book.write', { hid: what.hid, version: start.version, markdown: '主会话重写的这一节。' });
  assert.equal(done.status, 'merged');
  assert.match(done.note, /suggestion/);
  const opened = await study.call('course.book.open');
  assert.equal(opened.files[start.name].suggestions[0].kind, 'theirs');
  assert.match(opened.files[start.name].suggestions[0].text, /编辑器里加的一句/);
  assert.match((await fileOf(study, what.hid)).text, /^主会话重写的这一节。\n\n\[练 5 道/);
  await study.call('course.book.revert', { file: start.name });
  assert.match((await fileOf(study, what.hid)).text, /编辑器里加的一句/, 'the version before the chat\'s write is back');
});

test('the editor\'s save and the chat\'s section write in the same moment: one queue, both kept', async t => {
  const { study, what } = await setup(t);
  await study.call('book.write', { hid: what.hid, file: 'mine', markdown: '#### 甲\n\n第一段。\n\n#### 乙\n\n第二段。' });
  const mine = await fileOf(study, what.hid, 'mine');
  const [saved, written] = await Promise.all([
    study.call('course.book.save', { file: mine.name, text: mine.text.replace('第一段。', '第一段（编辑器改过）。'), version: mine.version }),
    study.call('book.write', { hid: what.hid, file: 'mine', version: mine.version, section: { heading: '乙', markdown: '第二段（主会话改过）。' } }),
  ]);
  assert.equal(saved.write, 'saved');
  assert.equal(written.status, 'saved');
  assert.ok(written.warnings.some(warning => /changed since version/.test(warning)), 'the section went onto the file as it is now');
  const text = (await fileOf(study, what.hid, 'mine')).text;
  assert.match(text, /第一段（编辑器改过）。/);
  assert.match(text, /第二段（主会话改过）。/);
});

test('a write in another language than the book is warned about; the generator never writes over a chat-written file', async t => {
  const { study, what } = await setup(t);
  const english = await study.call('book.write', { hid: what.hid, markdown: 'Architects write down every decision and the reasons behind it, so that later readers know why the system looks the way it does.' });
  assert.ok(english.warnings.some(warning => /written in Chinese/.test(warning)));
  assert.ok(english.warnings.some(warning => /none of this point's 2 page\(s\) were opened/.test(warning)), 'writing before reading is named');
  await study.call('source.pages', { sourceId: 'document-l1-p1', to: 2, hid: what.hid });
  const chinese = await study.call('book.write', { hid: what.hid, markdown: '架构师把每个决定和背后的理由写下来，以后的人才知道系统为什么是现在这个样子。这里的 ADR 指架构决策记录。' });
  assert.deepEqual(chinese.warnings, []);
  // The notes are rebuilt (a new generated text): the chat's text stays, the new text waits as a suggestion.
  await study.store.update(state => { const notes = state.sources.find(source => source.provenance === 'course-outline-notes'); notes.courseNotes.leaves[0].body = { ...notes.courseNotes.leaves[0].body, explain: 'A newer explanation.' }; });
  const opened = await study.call('course.book.open'), gen = opened.nodes[0].children[0];
  assert.match(gen.gen, /以后的人才知道/);
  assert.equal(opened.files[gen.files.gen].suggestions[0].kind, 'generated');
  assert.ok(opened.history[gen.files.gen] >= 2, 'every write kept the version it replaced');
});

test('requests that cannot be one small write are refused before anything is written', async t => {
  const { study, what, root } = await setup(t);
  for (const args of [{}, { markdown: 'a', edits: [{ find: 'a', replace: 'b' }] }, { section: { heading: '', markdown: 'x' } }, { edits: [] }, { markdown: 'x'.repeat(20_001) }])
    await assert.rejects(study.call('book.write', { hid: what.hid, ...args }), error => /^book-write-/.test(error.code), JSON.stringify(args).slice(0, 60));
  await assert.rejects(study.call('book.write', { hid: 'h999', markdown: 'x' }), error => error.code === 'book-point-missing');
  assert.equal((await fileOf(study, what.hid)).version, 1, 'nothing was written');
  await assert.rejects(readFile(join(root, 'book-history', 'reading.json'), 'utf8'), error => error.code === 'ENOENT');
  assert.match(libraryContracts.book, /book\.write \{course\?,hid,file\?:gen\|mine\|qa/);
  assert.deepEqual(writesFor('library', 'book.write'), ['sources']);
});

test('the pure rules: footnote forms, settling, heading shift, Q&A blocks kept as they are', () => {
  assert.deepEqual(parseFootnote(`「${REAL}」 (s1)`), { quote: REAL, sourceId: 's1' });
  assert.deepEqual(parseFootnote(`[「${REAL}」](studyhub://source/s%201) · Lecture`), { quote: REAL, sourceId: 's 1' });
  assert.deepEqual(parseFootnote(`“${REAL}”（s2）`), { quote: REAL, sourceId: 's2' });
  assert.equal(parseFootnote('just a note'), null);
  const byId = new Map([['s1', { id: 's1', title: 'Lecture 1', text: `Intro. ${REAL} in the log.` }]]);
  const pool = new Map([['n-1', `「${REAL}」 (s1)`], ['n-2', `「${REAL}」 (s1)`], ['n-3', '「nothing like this at all here」 (s1)']]);
  const settled = settleFootnotes('A [^n-1] and B [^n-2] and C [^n-3] and D [^n-9].', pool, { byId });
  assert.equal(settled.text.split('\n')[0], 'A [^1] and B [^1] and C and D.', 'one place one number; the unfound and the missing taken out');
  assert.deepEqual(settled.dropped.map(item => [item.n, item.reason]), [['3', 'not-found'], ['9', 'no-footnote']]);
  assert.equal(shiftHeadings('## A\n\n### B', 4).text, '#### A\n\n##### B');
  assert.equal(shiftHeadings('##### A', 4).shifted, false);
  const { state } = bookLibrary();
  const book = openCourseBook(state, {}), what = book.nodes[0].children[0];
  const block = '<!-- sh:qa card=q1 fid=f1 -->\n> **追问：** 为什么[^1]？\n>\n> **答：** 因为。\n<!-- /sh:qa -->';
  state.sources.find(source => source.provenance === 'course-book-doc').bookDoc.files[what.files.mine].text = `我的话。\n\n${block}`;
  const done = writeBookPoint(state, { hid: what.hid, file: 'mine', edits: [{ find: '我的话。', replace: '我改过的话。' }] });
  assert.equal(done.status, 'saved');
  assert.ok(state.sources.find(source => source.provenance === 'course-book-doc').bookDoc.files[what.files.mine].text.includes(block), 'the block is kept byte for byte');
  assert.deepEqual(done.dropped, [], 'a block\'s own marks are not the file\'s footnotes');
});
