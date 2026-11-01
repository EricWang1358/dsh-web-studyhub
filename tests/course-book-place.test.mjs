/* #489 item 5: a section of 未归位 goes back into a point in one write (course.book.place), and one undo takes it back. The main chat can read 未归位 too. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterCapabilities } from '../lib/runtime/tools.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { STRUCTURE_FILE } from '../lib/course-book-structure.js';
import { FILE_TEXT_MAX } from '../lib/course-book-edit.js';
import { unplacedSections } from '../lib/course-book-unplaced.js';
import { bookService } from './helpers/book-agent-library.mjs';

const POINTS = (lecture, lectureKey) => [{ id: 'c1', title: '第 1 章', children: ['一', '二', '三'].map((title, at) => ({ id: `p${at + 1}`, title: `知识点${title}`, anchors: [`${lectureKey}#${at}`] })) }];
const codeOf = promise => promise.then(() => null, error => error.code ?? error.message);

async function parked(t) {
  const { study } = await bookService(t, { chapters: POINTS });
  const toc = await study.call('book.toc');
  const [one, two, three] = toc.toc.filter(row => row.leaf !== false && /知识点/.test(row.title));
  const mine = (await study.call('book.read', { hid: one.hid, file: 'mine' })).files.mine;
  await study.call('course.book.save', { file: mine.name, text: '#### 小结\n\n一的笔记[^1]。\n\n[^1]: 一的注。', version: mine.version });
  const gone = await study.call('course.book.delete', { hid: one.hid, version: toc.structureVersion });
  return { study, two, three, version: gone.structureVersion };
}

test('sections of 未归位: split at its top headings, an unheaded start is one too, code fences are not headings, an id follows the text', () => {
  const text = 'A start.\n\n### 甲（已无对应知识点）\n\n甲文\n\n#### 甲的小节\n\n甲下\n\n```\n### not a heading\n```\n\n### 乙\n\n乙文';
  const sections = unplacedSections(text);
  assert.deepEqual(sections.map(item => item.title), ['', '甲', '乙'], 'the reason a parked title carries is not part of its name');
  assert.match(text.slice(sections[1].from, sections[1].to), /甲下[\s\S]*not a heading/);
  assert.equal(new Set(sections.map(item => item.id)).size, 3);
  assert.notEqual(unplacedSections(text.replace('甲文', '改过的甲文'))[1].id, sections[1].id, 'a section that changed is another section: a stale page cannot move it');
  assert.deepEqual(unplacedSections('  \n'), []);
  // Text with no heading of level 3 or above at all is one section.
  assert.equal(unplacedSections('#### 只有小节\n\n字').length, 1);
});

test('a parked section goes back into a point: in its notes, at the right depth, out of 未归位, in one write; one undo takes all of it back', async t => {
  const { study, two, version } = await parked(t);
  const before = await study.call('course.book.open');
  const [section] = before.unplaced.sections;
  assert.equal(section.title, '知识点一');
  const twoMine = before.nodes[0].children.find(node => node.hid === two.hid).files.mine;
  await study.call('course.book.save', { file: twoMine, text: '二自己的笔记[^1]。\n\n[^1]: 二的注。', version: before.files[twoMine].version });
  const placed = await study.call('course.book.place', { section: section.id, toHid: two.hid, version, answer: 'book' });
  assert.equal(placed.write, 'placed');
  const target = placed.nodes[0].children.find(node => node.hid === two.hid);
  assert.equal(placed.unplaced.text.trim(), '', 'out of 未归位');
  assert.deepEqual(placed.unplaced.sections, []);
  assert.match(target.mine, /^二自己的笔记/, 'what the point held stays first');
  // A point at depth 2 has its heading at level 3: the section is under it at level 4, and what is below goes along.
  assert.match(target.mine, /\n#### 知识点一 <!-- sh:id h\d+ -->\n/);
  assert.match(target.mine, /\n##### 小结/);
  assert.match(target.mine, /一的笔记\[\^[^\]]+\]/);
  const labels = [...target.mine.matchAll(/^\[\^([^\]]+)\]:/gm)].map(match => match[1]);
  assert.equal(new Set(labels).size, labels.length, 'no footnote label twice');
  assert.equal(labels.length, 2);
  const undone = await study.call('course.book.revert', { file: STRUCTURE_FILE, answer: 'book' });
  assert.equal(undone.write, 'reverted');
  assert.match(undone.unplaced.text, /一的笔记/, 'back in 未归位');
  assert.equal(undone.nodes[0].children.find(node => node.hid === two.hid).mine, '二自己的笔记[^1]。\n\n[^1]: 二的注。', 'and the point as it was');
});

test('the refusals name what is wrong and change nothing', async t => {
  const { study, two, version } = await parked(t);
  const book = await study.call('course.book.open'), [section] = book.unplaced.sections, chapter = book.nodes[0].hid;
  const before = JSON.stringify(book.unplaced);
  assert.equal(await codeOf(study.call('course.book.place', { section: section.id, toHid: two.hid, version: version - 1 })), 'course-book-conflict');
  assert.equal(await codeOf(study.call('course.book.place', { section: 'nope', toHid: two.hid, version })), 'course-book-section-missing');
  assert.equal(await codeOf(study.call('course.book.place', { section: section.id, toHid: 'nope', version })), 'course-book-node-missing');
  assert.equal(await codeOf(study.call('course.book.place', { section: section.id, toHid: chapter, version })), 'book-point-not-leaf');
  assert.equal(await codeOf(study.call('course.book.place', { section: section.id, version })), 'course-book-node-missing');
  // The point's notes would pass the limit of one file.
  const file = book.nodes[0].children.find(node => node.hid === two.hid).files.mine;
  await study.call('course.book.save', { file, text: 'x'.repeat(FILE_TEXT_MAX - 3), version: book.files[file].version });
  assert.equal(await codeOf(study.call('course.book.place', { section: section.id, toHid: two.hid, version })), 'course-book-text-too-long');
  assert.equal(JSON.stringify((await study.call('course.book.open')).unplaced), before);
});

test('the main chat reads 未归位: book.read {hid: "unplaced"} answers the text and the sections to place; a saved section moves a stale id out', async t => {
  const { study, two, version } = await parked(t);
  const read = await study.call('book.read', { hid: 'unplaced' });
  assert.equal(read.status, 'ok');
  assert.equal(read.hid, 'unplaced');
  assert.match(read.files.unplaced.text, /一的笔记/);
  assert.equal(read.sections[0].title, '知识点一');
  assert.ok(read.sections[0].chars > 0);
  assert.equal(await codeOf(study.call('book.read', { hid: 'unplaced', file: 'mine' })), 'book-file-invalid');
  const long = 'y'.repeat(9000);
  await study.call('course.book.save', { file: 'unplaced.md', text: `### 长的\n\n${long}`, version: read.files.unplaced.version });
  const first = await study.call('book.read', { hid: 'unplaced', file: 'unplaced' });
  assert.equal(first.files.unplaced.truncated, true);
  const next = await study.call('book.read', { hid: 'unplaced', file: 'unplaced', offset: first.files.unplaced.nextOffset });
  assert.ok(next.files.unplaced.from > 0);
  // The id it read is of a text that is no longer there.
  assert.equal(await codeOf(study.call('course.book.place', { section: read.sections[0].id, toHid: two.hid, version })), 'course-book-section-missing');
});

test('course.book.place is listed with its keys and is a write', async t => {
  const { study } = await bookService(t, { chapters: POINTS });
  const found = filterCapabilities(study.runtime.capabilities(), { operation: 'course.book.place' }).contexts[0].operations[0];
  assert.deepEqual(Object.keys(found.input.properties), ['section', 'toHid', 'version']);
  assert.ok(writesFor('library', 'course.book.place').includes('sources'));
});
