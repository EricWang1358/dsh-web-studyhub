/* 复习全书 S1 (docs/review-book.md "Open it", "Where you were") + #489 item 5 (course.book.place / 未归位):
   1) keepBook keeps { heading, offset } per library and course in the browser's storage; target, view, back, point, switched and chapter stay one-shots in
      memory and are never written; course.book.revision answers the book's revision alone, writes nothing, and moves with every write of the book; 复制编号.
   2) A section of 未归位 goes back into a point in one write (course.book.place), and one undo takes it back; the main chat can read 未归位 too.
   No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { filterCapabilities } from '../lib/runtime/tools.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { STRUCTURE_FILE } from '../lib/course-book-structure.js';
import { FILE_TEXT_MAX } from '../lib/course-book-edit.js';
import { unplacedSections } from '../lib/course-book-unplaced.js';
import { BOOK_COURSE, seedBookFixture } from './helpers/book-fixtures.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { bookService } from './helpers/book-agent-library.mjs';

const ui = await loadUi(`export * from './ui/book/model.js';
  export { holdPlace, placeKeeper, scrollTargetTop, scrollUnderBar, targetBox } from './ui/book/use-book-place.js';
  export { readShare, stickBar } from './ui/book/BookBar.jsx';`);

/** A Map with the Storage methods the page's storage helpers call. */
const memoryStorage = () => {
  const map = new Map();
  return { map, getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
};

test('keepBook: the place (heading, offset) is kept in storage per library and course; the one-shots stay in memory and are never written', () => {
  const storage = memoryStorage();
  ui.keepBook('lib-a', 'ArchSS', { heading: 'h7', offset: -812.4, target: 'bk:p3', view: 'flip', back: true, point: 'h7', switched: true, chapter: 'h1', folds: [0, 2] }, storage);
  assert.deepEqual([...storage.map.keys()], ['study-book-place:lib-a:ArchSS']);
  assert.deepEqual(JSON.parse(storage.map.get('study-book-place:lib-a:ArchSS')), { heading: 'h7', offset: -812 }, 'a small JSON: the heading and a whole offset');
  const kept = ui.keptBook('lib-a', 'ArchSS', storage);
  assert.equal(kept.heading, 'h7');
  assert.equal(kept.offset, -812);
  assert.equal(kept.target, 'bk:p3', 'the one-shots are read back from memory in this page load');
  assert.deepEqual(kept.folds, [0, 2]);
  for (const key of ['target', 'view', 'back', 'point', 'switched', 'chapter', 'folds']) assert.equal(storage.map.get('study-book-place:lib-a:ArchSS').includes(`"${key}"`), false, `${key} is never written`);
  // A later visit (a new page load: a new memory) has the place and nothing else.
  ui.keepBook('lib-a', 'ArchSS', { target: null, view: null, back: false, point: null, switched: false, chapter: null, folds: null }, storage);
  assert.deepEqual(ui.keptBook('lib-a', 'ArchSS', storage), { heading: 'h7', offset: -812, target: null, view: null, back: false, point: null, switched: false, chapter: null, folds: null });
  assert.deepEqual(ui.keptBook('lib-b', 'ArchSS', memoryStorage()), null, 'another library has no place');
  // A place only moves the part it is given; a corrupt value is no place.
  ui.keepBook('lib-a', 'ArchSS', { offset: 40 }, storage);
  assert.deepEqual(JSON.parse(storage.map.get('study-book-place:lib-a:ArchSS')), { heading: 'h7', offset: 40 });
  storage.setItem('study-book-place:lib-a:Other', '{nope');
  assert.equal(ui.keptBook('lib-a', 'Other', storage), null);
  storage.setItem('study-book-place:lib-a:Other', JSON.stringify({ heading: 7 }));
  assert.equal(ui.keptBook('lib-a', 'Other', storage), null);
  // No storage at all (a private window, blocked or full): the place survives in memory for this page load, so the way back from practice still lands there.
  ui.keepBook('lib-c', null, { heading: 'h2', offset: 10.4 }, null);
  assert.deepEqual(ui.keptBook('lib-c', null, null), { heading: 'h2', offset: 10 }, 'kept in memory without storage');
  ui.keepBook('lib-c', null, { offset: -300, back: true, point: 'h2' }, null);
  assert.deepEqual(ui.keptBook('lib-c', null, null), { heading: 'h2', offset: -300, back: true, point: 'h2' }, 'the way back keeps heading and offset in memory');
  // A storage that refuses every write (full): the memory copy is the latest within this page load.
  const full = { getItem: () => JSON.stringify({ heading: 'h1', offset: 0 }), setItem: () => { throw new Error('QuotaExceededError'); }, removeItem() {} };
  ui.keepBook('lib-d', 'ArchSS', { heading: 'h9', offset: 120 }, full);
  assert.deepEqual(ui.keptBook('lib-d', 'ArchSS', full), { heading: 'h9', offset: 120 }, 'a full storage: memory wins in this page load');
});

test('the place for the next visit is the last one measured: a write after the page went away (the sidebar, pagehide) keeps the last stretch of scrolling and reads no page', () => {
  let page = { heading: 'h3', offset: 120 }, reads = 0;
  const written = [], keeper = ui.placeKeeper(() => { reads += 1; return page; }, place => written.push(place));
  keeper.write();
  assert.deepEqual(written, [], 'nothing measured yet: nothing written');
  keeper.save();
  assert.deepEqual(written, [{ heading: 'h3', offset: 120 }]);
  // The learner scrolls on (each frame measured), then leaves within the 500 ms of the throttle: the page is gone (nothing to measure) when the write runs.
  page = { heading: 'h3', offset: -640 };
  keeper.measure();
  page = null;
  const before = reads;
  keeper.write();
  assert.equal(reads, before, 'the write on leaving reads nothing of the page');
  assert.deepEqual(written.at(-1), { heading: 'h3', offset: -640 }, 'the last measured place, not the one of the last throttled save');
  keeper.save();
  assert.deepEqual(written.at(-1), { heading: 'h3', offset: -640 }, 'a measure that finds no page keeps the last place');
  // The way back to practice keeps its own place (a row of 翻看, the heading above a link): the write on leaving puts no older measure back over it.
  keeper.keep({ heading: 'h9', offset: 80, point: 'h9' });
  keeper.measure();
  keeper.write();
  assert.deepEqual(written.slice(-2), [{ heading: 'h9', offset: 80, point: 'h9' }, { heading: 'h9', offset: 80, point: 'h9' }]);
  // The page is still there while it leaves: a save already on its way (the throttle's timer, a late change of the heading being read) measures another heading and
  // must not replace the way back's place; only the learner scrolling again does.
  page = { heading: 'h10', offset: 941 };
  keeper.save();
  assert.deepEqual(written.at(-1), { heading: 'h9', offset: 80, point: 'h9' }, 'a save on its way keeps the way back');
  keeper.resume();
  keeper.save();
  assert.deepEqual(written.at(-1), { heading: 'h10', offset: 941 }, 'after a new scroll the page is measured again');
});

test('the bar\'s reading line: a long point is read to the share the window\'s foot has passed once its top is under the bar; a short one is full once its end is on screen after a scroll', () => {
  const bar = 100, foot = 900;
  // Long (3000 px): nothing while its top is below the bar; part way as it scrolls; full once its end is on screen.
  assert.equal(ui.readShare({ top: 140, bottom: 3140, height: 3000 }, bar, foot, false), 0);
  assert.equal(ui.readShare({ top: 140, bottom: 3140, height: 3000 }, bar, foot, true), 0, 'its top not yet under the bar: 0 even after a scroll');
  assert.equal(ui.readShare({ top: 0, bottom: 3000, height: 3000 }, bar, foot, true), 0.3);
  assert.equal(ui.readShare({ top: -1500, bottom: 1500, height: 3000 }, bar, foot, true), 0.8);
  assert.equal(ui.readShare({ top: -2200, bottom: 800, height: 3000 }, bar, foot, true), 1, 'its end on screen: full');
  // Short (500 px): empty at the top of the page; full once the reader scrolled and the whole point is on screen, or its top went under the bar with its end visible.
  assert.equal(ui.readShare({ top: 160, bottom: 660, height: 500 }, bar, foot, false), 0, 'not scrolled yet: empty');
  assert.equal(ui.readShare({ top: 120, bottom: 620, height: 500 }, bar, foot, true), 1, 'all of it on screen after a scroll: full');
  assert.equal(ui.readShare({ top: -200, bottom: 300, height: 500 }, bar, foot, true), 1, 'its top under the bar, its end visible: full');
  assert.equal(ui.readShare({ top: 400, bottom: 900.5, height: 500.5 }, bar, foot, true), 0, 'its end just below the window: not all on screen');
  assert.equal(ui.readShare({ top: 0, bottom: 0, height: 0 }, bar, foot, true), 0, 'nothing drawn: 0');
});

test('复制编号: the lowercase hid the book tools match, then the number and title, then the course', () => {
  assert.equal(ui.pointCode({ hid: 'h7', number: '1.2.2', title: 'Architect the Solution (Asset)' }, 'ArchSS'), 'h7 · 1.2.2 Architect the Solution (Asset) · ArchSS');
  assert.equal(ui.pointCode({ hid: 'H12', number: '', title: '未归位' }, ''), 'h12 · 未归位 · 未分类课程');
});

test('course.book.revision: the book\'s revision alone, read only, moving with every write of the book', async t => {
  const base = await mkdtemp(join(tmpdir(), 'study-book-revision-')), root = join(base, 'library');
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedBookFixture(root, 'archss');
  const study = new StudyService(root);
  const book = await study.call('course.book.open', { course: BOOK_COURSE });
  const before = (await study.store.read()).revision;
  const first = await study.call('course.book.revision', { course: BOOK_COURSE });
  assert.deepEqual(first, { course: BOOK_COURSE, revision: book.revision });
  assert.equal((await study.store.read()).revision, before, 'reading it writes nothing');
  assert.deepEqual(await study.call('course.book.revision', {}), first, 'the current course by default');
  const leaves = nodes => nodes.flatMap(node => (node.leaf ? [node] : leaves(node.children || []))), point = leaves(book.nodes)[0];
  const saved = await study.call('course.book.save', { course: BOOK_COURSE, file: point.files.mine, text: 'Mine.', version: book.files[point.files.mine].version });
  const next = await study.call('course.book.revision', { course: BOOK_COURSE });
  assert.equal(next.revision, saved.revision);
  assert.ok(next.revision > first.revision, 'a save moves it');
  // The main chat's write (book.write) moves it too: what the chat wrote shows up when the page comes back.
  await study.call('book.write', { course: BOOK_COURSE, hid: point.hid, file: 'mine', markdown: 'Written by the chat.' });
  assert.ok((await study.call('course.book.revision', { course: BOOK_COURSE })).revision > next.revision);
  assert.deepEqual(await study.call('course.book.revision', { course: 'No such course' }), { course: 'No such course', revision: null }, 'no book: no revision');
  assert.deepEqual(writesFor('library', 'course.book.revision'), [], 'read only');
});

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

test('course.book.place refusals return specific error codes (conflict, missing section/node, non-leaf, text-too-long) and leave 未归位 unchanged', async t => {
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

test('undoing course.book.place never loses the placed section when 未归位 was edited after placing or when file history rolled past 20 writes', async t => {
  // 1) Chat undo and page undo (with structureVersion) after editing unplaced.md: the point reverts, the learner's new words stay, and the section returns to 未归位.
  for (const pageUndo of [false, true]) {
    const { study, two } = await parked(t);
    const open0 = await study.call('course.book.open');
    await study.call('course.book.save', { file: open0.unplaced.file, text: '### 甲\n\n独一甲文\n\n### 乙\n\n乙文', version: open0.files[open0.unplaced.file].version });
    const before = await study.call('course.book.open');
    const placed = await study.call('course.book.place', { section: before.unplaced.sections[0].id, toHid: two.hid, version: before.structureVersion, answer: 'book' });
    await study.call('course.book.save', { file: placed.unplaced.file, text: `${placed.unplaced.text}\n\n再加一行`, version: placed.files[placed.unplaced.file].version });
    const undone = await study.call('course.book.revert', { file: STRUCTURE_FILE, ...(pageUndo ? { version: placed.structureVersion } : {}), answer: 'book' });
    assert.equal(undone.write, 'reverted');
    assert.equal(undone.nodes[0].children.find(node => node.hid === two.hid).mine, '', 'the target point gave the placed section back');
    assert.match(undone.unplaced.text, /再加一行/, 'the learner\'s later edit in 未归位 stayed');
    assert.match(undone.unplaced.text, /独一甲文/, 'the placed section came back to 未归位 instead of vanishing');
  }
  // 2) Rolling file history (19 and 20 saves on another point's file): structure undo still preserves the placed text in the book.
  for (const writes of [19, 20]) {
    const { study, two, three } = await parked(t);
    const open0 = await study.call('course.book.open');
    await study.call('course.book.save', { file: open0.unplaced.file, text: '### 甲\n\n独一甲文\n\n### 乙\n\n乙文', version: open0.files[open0.unplaced.file].version });
    const before = await study.call('course.book.open');
    const placed = await study.call('course.book.place', { section: before.unplaced.sections[0].id, toHid: two.hid, version: before.structureVersion, answer: 'book' });
    const otherFile = placed.nodes[0].children.find(node => node.hid === three.hid).files.mine;
    let ver = placed.files[otherFile].version;
    for (let i = 0; i < writes; i += 1) ver = (await study.call('course.book.save', { file: otherFile, text: `第 ${i} 版`, version: ver })).files[otherFile].version;
    const undone = await study.call('course.book.revert', { file: STRUCTURE_FILE, answer: 'book' });
    const whole = undone.unplaced.text + undone.nodes[0].children.find(node => node.hid === two.hid).mine;
    assert.ok(whole.includes('独一甲文'), `after ${writes} writes on another file, undo keeps 独一甲文 in the book`);
  }
});

test('placing keeps LaTeX $ titles verbatim, avoids footnote self-collision, carries shared definitions, and distinguishes duplicate/CRLF sections', async t => {
  assert.equal(unplacedSections('### 甲\r\n\r\n字')[0].id, unplacedSections('### 甲\n\n字')[0].id, 'CRLF and LF hash identically');
  const dup = unplacedSections('### 同\n\n一样\n\n### 同\n\n一样');
  assert.equal(dup.length, 2);
  assert.notEqual(dup[0].id, dup[1].id, 'duplicate sections get distinct ids');

  const { study, two, three } = await parked(t);
  let book = await study.call('course.book.open');
  const twoMine = book.nodes[0].children.find(node => node.hid === two.hid).files.mine;
  await study.call('course.book.save', { file: twoMine, text: '已有[^a]\n\n[^a]: 老注', version: book.files[twoMine].version });
  await study.call('course.book.save', {
    file: book.unplaced.file,
    text: '### 公式 $$E=mc^2$$ 与 $& 尾\n\n甲[^a]与[^a-2]与共用[^1]，`[^a]` 代码\n\n~~~\n[^a]\n~~~\n\n[^a]: 注一\n[^a-2]: 注二\n\n### 乙\n\n乙[^1]\n\n[^1]: 共用注',
    version: book.files[book.unplaced.file].version,
  });
  book = await study.call('course.book.open');
  const placed = await study.call('course.book.place', { section: book.unplaced.sections[0].id, toHid: two.hid, version: book.structureVersion, answer: 'book' });
  const target = placed.nodes[0].children.find(node => node.hid === two.hid).mine;
  assert.match(target, /#### 公式 \$\$E=mc\^2\$\$ 与 \$& 尾 <!-- sh:id h\d+ -->/, '$ patterns in title stay literal');
  assert.match(target, /甲\[\^a-3\]与\[\^a-2\]与共用\[\^1\]，`\[\^a\]` 代码/, '[^a] skips [^a-2] and inline code stays untouched');
  assert.match(target, /\[\^a-3\]: 注一\n\[\^a-2\]: 注二/, 'both definitions stay distinct');
  assert.match(target, /\[\^1\]: 共用注/, 'shared footnote definition is copied along');
  assert.match(placed.unplaced.text, /乙\[\^1\][\s\S]*\[\^1\]: 共用注/, 'shared footnote definition also stays for 乙 in 未归位');
  void three;
});

test('book.read {hid: "unplaced"} stays under the 8 000-character budget and supports heading jumps', async t => {
  const { study } = await parked(t);
  const open0 = await study.call('course.book.open');
  const heavy = Array.from({ length: 40 }, (_, i) => `### 段 ${i} ${'题'.repeat(55)}\n\n${'\n'.repeat(20)}${'"\\'.repeat(30)}`).join('\n\n');
  await study.call('course.book.save', { file: open0.unplaced.file, text: heavy, version: open0.files[open0.unplaced.file].version });
  const first = await study.call('book.read', { hid: 'unplaced' });
  assert.ok(JSON.stringify(first).length < 8000, `JSON size ${JSON.stringify(first).length} stays under 8000`);
  assert.equal(first.sectionsTotal, 40);
  const jumped = await study.call('book.read', { hid: 'unplaced', heading: '段 38 ' + '题'.repeat(55) });
  assert.match(jumped.files.unplaced.text, /^### 段 38 /);
  assert.ok(jumped.sections.some(section => section.title.startsWith('段 38 ')), 'sections follow the read offset');
  assert.equal(await codeOf(study.call('book.read', { hid: 'unplaced', heading: '不存在' })), 'book-section-missing');
  assert.equal(await codeOf(study.call('book.read', { hid: 'unplaced', heading: '段 1', offset: 10 })), 'book-read-heading-offset');
});

function makeStickyBookDom({ scrollTop = 0, scrollerHeight = 800, zoom = 1, topbarHeight = 51, mainBottomAt0 = 5000, barTopAt0 = 180, barHeight = 46, targetTopAt0 = 1000, targetHeight = 40, scrollerContainsChrome = true }) {
  const styles = new Map();
  let currentScroll = scrollTop;
  let lastScrollTo = null;
  const stickyTopAt = s => Math.max(0, Math.min(topbarHeight, mainBottomAt0 - s));
  const barTopAt = s => Math.max(stickyTopAt(s), barTopAt0 - s);
  const topbar = {
    parentElement: { getBoundingClientRect: () => ({ top: -currentScroll * zoom, bottom: (mainBottomAt0 - currentScroll) * zoom }) },
    getBoundingClientRect: () => {
      const bottom = stickyTopAt(currentScroll) * zoom;
      return { top: bottom - topbarHeight * zoom, bottom, height: topbarHeight * zoom };
    },
  };
  const bar = {
    closest: sel => (sel.includes('.study-app') ? scroller : null),
    getBoundingClientRect: () => {
      const top = barTopAt(currentScroll) * zoom;
      return { top, bottom: top + barHeight * zoom, height: barHeight * zoom };
    },
  };
  const page = {
    style: {
      getPropertyValue: k => styles.get(k) || '',
      setProperty: (k, v) => { styles.set(k, v); },
    },
    closest: sel => (sel.includes('.study-app') ? scroller : null),
    querySelector: sel => (sel === '.book-bar' ? bar : null),
  };
  const scroller = {
    clientTop: 0,
    clientHeight: scrollerHeight,
    offsetHeight: scrollerHeight,
    scrollHeight: 6000,
    get scrollTop() { return currentScroll; },
    set scrollTop(v) { currentScroll = v; },
    getBoundingClientRect: () => ({ top: 0, bottom: scrollerHeight * zoom, height: scrollerHeight * zoom }),
    matches: sel => sel.includes('.study-app'),
    contains: node => (scrollerContainsChrome ? (node === bar || node === topbar || node === page) : false),
    querySelector: sel => (sel === '.topbar' ? topbar : null),
    scrollTo: opts => { lastScrollTo = opts; currentScroll = opts.top; },
  };
  const target = {
    isConnected: true,
    parentElement: scroller,
    closest: sel => (sel === '.book-page' ? page : null),
    getBoundingClientRect: () => {
      const top = (targetTopAt0 - currentScroll) * zoom;
      return { top, bottom: top + targetHeight * zoom, height: targetHeight * zoom };
    },
  };
  const prevWindow = globalThis.window;
  const prevDocument = globalThis.document;
  const prevGetComputedStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = node => {
    if (node === scroller) return { overflowY: 'auto' };
    if (node === topbar) return { position: 'sticky' };
    return {};
  };
  globalThis.window = { getComputedStyle: globalThis.getComputedStyle, innerHeight: scrollerHeight * zoom };
  globalThis.document = { scrollingElement: {} };
  return {
    scroller,
    page,
    target,
    styles,
    getScrollTo: () => lastScrollTo,
    restore: () => {
      globalThis.window = prevWindow;
      globalThis.document = prevDocument;
      globalThis.getComputedStyle = prevGetComputedStyle;
    },
  };
}

test('scrollTargetTop and scrollUnderBar clear sticky .topbar + .book-bar from scrollTop=0, when scrolling up into .topbar range, and for tall blocks', () => {
  // 1) Starting at scrollTop === 0 while .book-bar is still unstuck under .book-header (180..226): uses stuck bottom (51 + 46 = 97), not 226
  const atTop = makeStickyBookDom({ scrollTop: 0, barTopAt0: 180, barHeight: 46, topbarHeight: 51, mainBottomAt0: 5000, targetTopAt0: 1000 });
  try {
    assert.equal(ui.scrollTargetTop({ target: atTop.target, scroller: atTop.scroller, page: atTop.page, margin: 16 }), 887);
  } finally { atTop.restore(); }

  // 2) Starting scrolled down where .topbar scrolled away (--book-bar-top: 0px) and jumping UP into .topbar range: accounts for .topbar returning
  const upToTopbar = makeStickyBookDom({ scrollTop: 2000, barTopAt0: 180, barHeight: 46, topbarHeight: 51, mainBottomAt0: 900, targetTopAt0: 500 });
  try {
    assert.equal(ui.scrollTargetTop({ target: upToTopbar.target, scroller: upToTopbar.scroller, page: upToTopbar.page, margin: 16 }), 387);
  } finally { upToTopbar.restore(); }

  // 3) Jumping right near the .topbar transition boundary (950 with mainBottomAt0=900): stays cleanly below .topbar + .book-bar
  const boundary = makeStickyBookDom({ scrollTop: 0, barTopAt0: 180, barHeight: 46, topbarHeight: 51, mainBottomAt0: 900, targetTopAt0: 950 });
  try {
    assert.equal(ui.scrollTargetTop({ target: boundary.target, scroller: boundary.scroller, page: boundary.page, margin: 16 }), 837);
  } finally { boundary.restore(); }

  // 4) Jumping deep below .topbar range where .topbar is gone at destination: clears only stuck .book-bar (46 + 16 = 62)
  const pastTopbar = makeStickyBookDom({ scrollTop: 0, barTopAt0: 180, barHeight: 46, topbarHeight: 51, mainBottomAt0: 900, targetTopAt0: 1500 });
  try {
    assert.equal(ui.scrollTargetTop({ target: pastTopbar.target, scroller: pastTopbar.scroller, page: pastTopbar.page, margin: 16 }), 1438);
  } finally { pastTopbar.restore(); }

  // 5) scrollUnderBar({ center: true }): centers short block within remaining viewport below sticky bar, clamps tall block below sticky bar
  const shortBlock = makeStickyBookDom({ scrollTop: 0, scrollerHeight: 800, barTopAt0: 180, barHeight: 46, topbarHeight: 51, mainBottomAt0: 5000, targetTopAt0: 1200, targetHeight: 80 });
  try {
    ui.scrollUnderBar(shortBlock.target, { center: true, margin: 16 });
    assert.equal(shortBlock.getScrollTo().top, 1200 - (113 + (687 - 80) / 2));
  } finally { shortBlock.restore(); }

  const tallBlock = makeStickyBookDom({ scrollTop: 0, scrollerHeight: 800, barTopAt0: 180, barHeight: 46, topbarHeight: 51, mainBottomAt0: 5000, targetTopAt0: 1200, targetHeight: 1000 });
  try {
    ui.scrollUnderBar(tallBlock.target, { center: true, margin: 16 });
    assert.equal(tallBlock.getScrollTo().top, 1200 - 113);
  } finally { tallBlock.restore(); }

  // 6) Nested scroller that does not contain .book-bar / .topbar does not subtract their height
  const nested = makeStickyBookDom({ scrollTop: 0, scrollerHeight: 500, targetTopAt0: 400, targetHeight: 40, scrollerContainsChrome: false });
  try {
    assert.equal(ui.scrollTargetTop({ target: nested.target, scroller: nested.scroller, page: nested.page, margin: 16 }), 376);
  } finally { nested.restore(); }

  // 7) CSS zoom (offsetHeight: 800, rect.height: 1000 -> scale = 1.25): converts zoomed rects back to unzoomed scrollTop px & --book-bar-top
  const zoomed = makeStickyBookDom({ scrollTop: 0, scrollerHeight: 800, zoom: 1.25, barTopAt0: 180, barHeight: 46, topbarHeight: 51, mainBottomAt0: 5000, targetTopAt0: 1000 });
  try {
    ui.stickBar(zoomed.page);
    assert.equal(zoomed.styles.get('--book-bar-top'), '51px', 'stickBar writes unzoomed CSS px under zoom=1.25');
    assert.equal(ui.scrollTargetTop({ target: zoomed.target, scroller: zoomed.scroller, page: zoomed.page, margin: 16 }), 887);
    ui.scrollUnderBar(zoomed.target, { center: true, margin: 16 });
    assert.equal(zoomed.getScrollTo().top, 1000 - (113 + (687 - 40) / 2));
  } finally { zoomed.restore(); }

  // 8) Range with empty leading getClientRects() rects skips zero-size rects cleanly
  const rangeZoomed = makeStickyBookDom({ scrollTop: 0, scrollerHeight: 800, zoom: 1.5, barTopAt0: 180, barHeight: 46, topbarHeight: 51, mainBottomAt0: 5000, targetTopAt0: 1000 });
  try {
    const rangeTarget = {
      getClientRects: () => [
        { top: 0, bottom: 0, width: 0, height: 0 },
        { top: 1500, bottom: 1536, width: 200, height: 36 },
        { top: 1536, bottom: 1572, width: 120, height: 36 },
      ],
      getBoundingClientRect: () => ({ top: 0, bottom: 1572, height: 1572 }),
    };
    assert.deepEqual(ui.targetBox(rangeTarget), { top: 1500, bottom: 1572, height: 72 });
    assert.equal(ui.scrollTargetTop({ target: rangeTarget, scroller: rangeZoomed.scroller, page: rangeZoomed.page, margin: 16 }), 887);
  } finally { rangeZoomed.restore(); }

  // 9) holdPlace divides screen-px offset by zoom scale before adjusting scrollTop
  const holdZoomed = makeStickyBookDom({ scrollTop: 887, scrollerHeight: 800, zoom: 1.25, targetTopAt0: 1050 });
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;
  const prevWinAdd = globalThis.window.addEventListener;
  const prevWinRemove = globalThis.window.removeEventListener;
  try {
    let rafFn = null;
    globalThis.requestAnimationFrame = fn => { rafFn = fn; return 1; };
    globalThis.cancelAnimationFrame = () => {};
    globalThis.window.addEventListener = () => {};
    globalThis.window.removeEventListener = () => {};
    // Desired screen top is 113 * 1.25 = 141.25; target shifted down by 50 CSS px (62.5 screen px) to 1050 -> scrollTop should increase by 50 CSS px to 937
    const stop = ui.holdPlace(holdZoomed.target, holdZoomed.page, 113 * 1.25);
    rafFn();
    assert.equal(holdZoomed.getScrollTo().top, 937);
    stop();
  } finally {
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancelRaf;
    if (globalThis.window) {
      globalThis.window.addEventListener = prevWinAdd;
      globalThis.window.removeEventListener = prevWinRemove;
    }
    holdZoomed.restore();
  }
});
