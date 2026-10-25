/* book.write's structural ops and the footnotes and code of a file (#480 review round 4): every mark keeps the footnote it cited (each mark is followed
   through the op, so a swap of two marks' footnotes is caught and the place is chosen again), code fences are code (no heading, no footnote inside one
   moves or changes), and a point brought back by an undo is no longer "deleted". No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindings } from '../lib/book-footnote-binding.js';
import { bookService } from './helpers/book-agent-library.mjs';

const FOURTEEN = (lecture, lectureKey) => [[1, 4], [2, 4], [3, 3], [4, 3]].map(([c, count], at, all) => {
  const before = all.slice(0, at).reduce((sum, [, n]) => sum + n, 0);
  return { id: `c${c}`, title: `第 ${c} 章`, children: Array.from({ length: count }, (_, i) => ({ id: `p${before + i + 1}`, title: `知识点 ${before + i + 1}`, anchors: [`${lectureKey(Math.floor((before + i) / 3) + 1)}#${(before + i) % 3}`] })) };
});
const byTitle = (toc, title) => toc.toc.find(row => row.title === title);

async function setup(t) {
  const made = await bookService(t, { chapters: FOURTEEN });
  const toc = await made.study.call('book.toc', { limit: 40 }), one = byTitle(toc, '知识点 1');
  const read = async () => (await made.study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine;
  const save = async text => { const file = await read(); await made.study.call('course.book.save', { file: file.name, text, version: file.version }); return read(); };
  const ids = file => Object.fromEntries(file.headings.map(heading => [heading.title, heading.id]));
  const run = args => made.study.call('book.write', { hid: one.hid, file: 'mine', ...args }).then(done => done, error => ({ refused: error.code, message: error.message }));
  return { ...made, toc, one, read, save, ids, run };
}
/** What each mark cites, by the words before it: ['进程文 -> 「进程的注」', ...]. */
const cites = text => { const lines = text.split('\n'); return bindings(lines).map(item => `${/([^\s。，]+)\[\^/.exec(lines[item.line])?.[1]} -> ${lines[item.def].replace(/^\[\^[^\]]+\]:\s*/, '').trim()}`).sort(); };

test('a delete (promote) lifts the sub-sections\' headings, never the `#` lines of a code fence in them', async t => {
  const s = await setup(t);
  const fence = ['```python', '# compute the sum', 'x = 1  # ok', '## also a comment', '```'];
  const file = await s.save(['#### 甲', '', '甲的引言。', '', '##### 甲一', '', ...fence, '', '甲一正文。'].join('\n'));
  const done = await s.run({ op: 'delete', heading: s.ids(file)['甲'] });
  assert.equal(done.status, 'saved');
  const now = await s.read();
  assert.deepEqual(now.headings.map(heading => [heading.level, heading.title]), [[4, '甲一']]);
  assert.ok(now.text.includes(fence.join('\n')), now.text);
});

test('the #459 layout: a section with its own [^1] list after an earlier list of [^1], moved up after 三: every mark keeps its own note', async t => {
  const s = await setup(t);
  const text = '#### 三、进程管理\n\n进程文[^1]。\n\n**出处**\n\n[^1]: 「进程的注」\n\n#### 四、内存\n\n内存文。\n\n#### 十一、性能测试\n\n性能文[^1]。\n\n**出处**\n\n[^1]: 「性能的注」\n\n##### 11.1 压测\n\n压测文[^1]。';
  const want = ['压测文 -> 「性能的注」', '性能文 -> 「性能的注」', '进程文 -> 「进程的注」'];
  for (const place of ['after', 'within']) {
    const file = await s.save(text), id = s.ids(file);
    assert.deepEqual(cites(file.text), want);
    const done = await s.run({ op: 'move', heading: id['十一、性能测试'], [place]: id['三、进程管理'] });
    assert.equal(done.status, 'saved', `${place}: ${done.message ?? ''}`);
    const now = await s.read();
    assert.deepEqual(cites(now.text), want, `${place}: no mark cites another note`);
    assert.ok(now.text.indexOf('十一、性能测试') < now.text.indexOf('四、内存'), `${place}: it moved up`);
  }
});

test('a section with a paragraph after its own list, moved after another: the place that would swap two marks\' notes is not taken', async t => {
  const s = await setup(t);
  const file = await s.save('#### P\n\nP文[^1]。\n\n**出处**\n\n[^1]: 乙注\n\n#### Q\n\nQ文。\n\n#### S\n\nS文[^1]。\n\n**出处**\n\n[^1]: 甲注\n\nS补充[^1]。'), id = s.ids(file);
  const want = ['P文 -> 乙注', 'S文 -> 甲注', 'S补充 -> 甲注'];
  assert.deepEqual(cites(file.text), want);
  const done = await s.run({ op: 'move', heading: id.S, after: id.P });
  assert.equal(done.status, 'saved');
  assert.deepEqual(done.warnings, []);
  let now = await s.read();
  assert.deepEqual(cites(now.text), want);
  assert.deepEqual(now.headings.map(heading => heading.title), ['P', 'S', 'Q']);
  // An ordinary section write afterwards keeps it so.
  await s.run({ section: { heading: id.Q, markdown: 'Q文，改。' } });
  now = await s.read();
  assert.match(now.text, /P文\[\^(\d+)\]。[\s\S]*\[\^\1\]: 乙注/);
  assert.match(now.text, /S文\[\^(\d+)\]。[\s\S]*\[\^\1\]: 甲注/);
});

test('a move whose marks cite the same notes from anywhere is taken as asked (before the 出处 list that ends the place)', async t => {
  const s = await setup(t);
  const file = await s.save('#### A\n\nA文[^1]。\n\n#### B\n\nB文[^2]。\n\n#### C\n\nC文[^3]，也引 A[^1]。\n\n**出处**\n\n[^1]: A的注\n[^2]: B的注\n[^3]: C的注'), id = s.ids(file);
  const done = await s.run({ op: 'move', heading: id.A, position: 'end' });
  assert.equal(done.status, 'saved');
  const now = await s.read();
  assert.deepEqual(now.headings.map(heading => heading.title), ['B', 'C', 'A']);
  assert.ok(now.text.indexOf('A文') < now.text.indexOf('**出处**'), 'before the list that ends the file');
  assert.deepEqual(cites(now.text), cites(file.text));
});

test('a code fence that shows a footnote definition is code: a move keeps the fence whole and every real mark on its note; a delete to 未归位 takes it whole', async t => {
  const s = await setup(t);
  const fence = '```md\n文字[^1]\n[^1]: 示例里的注\n```';
  const text = `#### 甲\n\n甲说[^1]。\n\n#### 乙\n\n示例：\n\n${fence}\n\n乙的话。\n\n#### 丙\n\n丙说。\n\n**出处**\n\n[^1]: 真正的注`;
  let file = await s.save(text), id = s.ids(file);
  assert.equal((await s.run({ op: 'move', heading: id['乙'], position: 'end' })).status, 'saved');
  let now = await s.read();
  assert.ok(now.text.includes(fence), now.text);
  assert.deepEqual(now.headings.map(heading => heading.title), ['甲', '丙', '乙']);
  assert.ok(cites(now.text).includes('甲说 -> 真正的注'));
  file = await s.save(text);
  id = s.ids(file);
  assert.equal((await s.run({ op: 'delete', heading: id['乙'], children: 'toUnplaced' })).status, 'saved');
  now = await s.read();
  assert.ok(now.text.includes('[^1]: 真正的注') && !now.text.includes('示例里的注'));
  const unplaced = (await s.study.call('course.book.open')).unplaced.text;
  assert.ok(unplaced.includes(fence), 'the fence is in 未归位 as it was, its lines not renamed');
});

test('a point brought back by an undo is no longer "deleted": after a rebuild a save of its old file says the plain sentence', async t => {
  const { study } = await bookService(t, { chapters: FOURTEEN });
  const toc = await study.call('book.toc', { limit: 40 }), five = byTitle(toc, '知识点 5');
  const mine = (await study.call('book.read', { hid: five.hid, file: 'mine' })).files.mine;
  await study.call('course.book.save', { file: mine.name, text: '五的笔记。', version: mine.version });
  await study.call('course.book.delete', { hid: five.hid, version: toc.structureVersion });
  await study.call('course.book.revert', { file: 'book.structure' });
  const back = (await study.call('book.read', { hid: five.hid, file: 'mine' })).files.mine;
  assert.equal(back.text, '五的笔记。');
  // A rebuild that gives every point a new id: the notes follow, the old file name is gone for another reason than a delete.
  await study.store.update(state => {
    const outline = state.sources.find(source => source.provenance === 'course-outline' && !source.archived), again = structuredClone(outline);
    again.id = `${outline.id}-again`;
    again.createdAt = '2026-10-10T00:00:00.000Z';
    for (const chapter of again.courseOutline.nodes) chapter.children = chapter.children.map(point => ({ ...point, id: `q${point.id}` }));
    outline.archived = true;
    state.sources.push(again);
    state.sources.find(source => source.provenance === 'course-outline-notes').courseNotes.outlineId = again.id;
  });
  await study.call('course.book.open');
  const refused = await study.call('course.book.save', { file: back.name, text: '编辑器里的新字。', version: back.version }).then(() => null, error => error);
  assert.equal(refused.code, 'course-book-file-missing');
  assert.equal(refused.message, '书里没有这份文件 / The book has no such file');
});
