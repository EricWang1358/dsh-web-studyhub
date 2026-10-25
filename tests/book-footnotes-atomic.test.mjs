/* #460: the footnotes of a 复习全书 file stay ONE list through book.write. Marks and definitions move together: a file that holds several 出处 lists of
   [^1]…[^n] (written by an older release or saved by hand) is repaired to one when it is next written, each mark keeping the words its own list gave it;
   rounds of edits never make a second list; an edit that takes out a definition whose marks are still in the text is refused instead of taking the marks
   out; a footnote of the file that cannot be found again is kept as written, not deleted; writing twice changes nothing. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeBookPoint } from '../lib/book-agent-write.js';
import { DEFINITION, footnoteProblems, parseFootnote, takeFootnotes } from '../lib/book-footnotes.js';
import { openCourseBook } from '../lib/course-book-files.js';
import { citedSources } from '../lib/book-agent-view.js';
import { bookLibrary, pageLine } from './helpers/book-agent-library.mjs';

const words = (id, from, to) => pageLine(id, 0).slice(from, to);
const A = words('document-l1-p1', 0, 60), B = words('document-l1-p2', 0, 60), C = words('document-l1-p1', 20, 80), D = words('document-l1-p2', 25, 85);
const link = (quote, id) => `[「${quote}」](studyhub://source/${id}) · Lecture`;

function setup() {
  const { state } = bookLibrary();
  const what = openCourseBook(state, {}).nodes[0].children[0];
  const record = state.sources.find(source => source.provenance === 'course-book-doc');
  const file = () => record.bookDoc.files[what.files.gen];
  return { state, what, text: () => file().text, put: text => { file().text = text; } };
}
const lists = text => text.split('\n').filter(line => /^\*\*出处\*\*$/.test(line.trim())).length;
const definitions = text => text.split('\n').map(line => DEFINITION.exec(line.trim())).filter(Boolean).map(found => found[1]);
/** The footnote words each sentence's mark points at, in the file as written. */
function citedBy(text) {
  const pool = new Map(text.split('\n').map(line => DEFINITION.exec(line.trim())).filter(Boolean).map(found => [found[1], parseFootnote(found[2])?.quote ?? found[2]]));
  return Object.fromEntries([...text.matchAll(/(句[甲乙丙丁戊一二三四五六七八九]+)\[\^(\d+)\]/g)].map(([, sentence, key]) => [sentence, pool.get(key)]));
}

test('a file with three 出处 lists of [^1]…[^2] is repaired to one list when it is edited; each mark keeps its own list\'s words', () => {
  const { state, what, text, put } = setup();
  put([
    '#### 甲 <!-- sh:id h4 -->', '', '句甲[^1]，句乙[^2]。', '', '**出处**', '', `[^1]: ${link(A, 'document-l1-p1')}`, `[^2]: ${link(B, 'document-l1-p2')}`, '',
    '#### 乙 <!-- sh:id h5 -->', '', '句丙[^1]，句丁[^2]。', '', '**出处**', '', `[^1]: ${link(C, 'document-l1-p1')}`, `[^2]: ${link(D, 'document-l1-p2')}`, '',
    '#### 丙 <!-- sh:id h6 -->', '', '句戊[^1]。', '', '**出处**', '', `[^1]: ${link(A, 'document-l1-p1')}`,
  ].join('\n'));
  const meant = { 句甲: A, 句乙: B, 句丙: C, 句丁: D, 句戊: A };
  const done = writeBookPoint(state, { hid: what.hid, edits: [{ find: '句丙', replace: '句丙（改过）' }] });
  assert.equal(done.status, 'saved');
  assert.deepEqual(done.dropped, []);
  const after = text().replace('句丙（改过）', '句丙');
  assert.equal(lists(after), 1, 'one 出处 list');
  assert.deepEqual(definitions(after), ['1', '2', '3', '4'], 'numbered 1…n once each (A is cited twice: one number)');
  assert.deepEqual(footnoteProblems(after.split('\n').filter(line => !/^\[练/.test(line)).join('\n')), []);
  assert.deepEqual(citedBy(after), meant, 'every mark still points at the words its own list gave it');
  // Idempotent: the repaired file written again is the same file.
  const again = writeBookPoint(state, { hid: what.hid, edits: [{ find: '句甲', replace: '句甲' }] });
  assert.equal(again.status, 'unchanged');
});

test('three rounds of edits on a multi-section file keep one list numbered 1…n with no duplicate', () => {
  const { state, what, text } = setup();
  writeBookPoint(state, { hid: what.hid, markdown: `#### 甲\n\n句甲[^1]，句乙[^2]。\n\n#### 乙\n\n句丙[^1]，句丁[^3]。\n\n[^1]: 「${A}」 (document-l1-p1)\n[^2]: 「${B}」 (document-l1-p2)\n[^3]: 「${C}」 (document-l1-p1)` });
  const rounds = [
    [{ find: '句乙[^2]', replace: '句乙' }],
    [{ find: '句丁[^2]。', replace: `句丁[^2]，句戊[^9]。\n\n[^9]: 「${D}」 (document-l1-p2)` }],
    [{ find: '句甲[^1]', replace: `句甲[^1]，句六[^7]\n\n[^7]: 「${B}」 (document-l1-p2)` }],
  ];
  for (const [round, edits] of rounds.entries()) {
    const done = writeBookPoint(state, { hid: what.hid, edits });
    assert.equal(done.status, 'saved', `round ${round + 1}`);
    assert.deepEqual(done.dropped, [], `round ${round + 1}`);
    const body = text().split('\n').filter(line => !/^\[练/.test(line)).join('\n');
    assert.equal(lists(body), 1, `round ${round + 1}: one list`);
    assert.deepEqual(footnoteProblems(body), [], `round ${round + 1}`);
  }
  assert.deepEqual(citedBy(text()), { 句甲: A, 句六: B, 句丙: A, 句丁: C, 句戊: D });
});

test('an edit that takes out a definition still marked in the text is refused and names the marks; taking out both is fine', () => {
  const { state, what, text } = setup();
  writeBookPoint(state, { hid: what.hid, markdown: `句甲[^1]，句乙[^2]，句丙[^2]。\n\n[^1]: 「${A}」 (document-l1-p1)\n[^2]: 「${B}」 (document-l1-p2)` });
  const before = text(), definition = before.split('\n').find(line => line.startsWith('[^2]:'));
  assert.throws(() => writeBookPoint(state, { hid: what.hid, edits: [{ find: definition, replace: '' }] }),
    error => error.code === 'book-footnote-in-use' && /\[\^2\]/.test(error.message) && /2/.test(error.message));
  assert.equal(text(), before, 'nothing was written: the marks are still there');
  const done = writeBookPoint(state, { hid: what.hid, edits: [{ find: definition, replace: '' }, { find: '句乙[^2]，句丙[^2]', replace: '句乙，句丙' }] });
  assert.equal(done.status, 'saved');
  assert.deepEqual(definitions(text()), ['1']);
  assert.match(text(), /句甲\[\^1\]，句乙，句丙。/);
});

test('a mark whose last mark is taken out takes its definition with it (named in the warnings); a footnote of the file that is not found again is kept as written', () => {
  const { state, what, text, put } = setup();
  put(`句甲[^1]，句乙[^2]，句丙[^3]。\n\n**出处**\n\n[^1]: ${link(A, 'document-l1-p1')}\n[^2]: ${link(B, 'document-l1-p2')}\n[^3]: 见讲义第三章的图（手写的说明）`);
  const done = writeBookPoint(state, { hid: what.hid, edits: [{ find: '句乙[^2]', replace: '句乙' }] });
  assert.equal(done.status, 'saved');
  assert.deepEqual(done.dropped, []);
  assert.ok(done.warnings.some(warning => /2 found but marked nowhere/.test(warning)));
  assert.ok(done.warnings.some(warning => /\[\^2\] \(written \[\^3\]\) of the saved file.*kept as they were written/.test(warning)), done.warnings.join(' | '));
  assert.match(text(), /句甲\[\^1\]，句乙，句丙\[\^2\]。/, 'the hand-written footnote\'s mark stays (renumbered)');
  assert.match(text(), /^\[\^2\]: 见讲义第三章的图（手写的说明）$/m);
  assert.deepEqual(footnoteProblems(text().split('\n').filter(line => !/^\[练/.test(line)).join('\n')), []);
});

test('a footnote an edit adds or whose words it changes is always checked: made-up words are dropped with their mark, never kept as written', () => {
  const FAKE = 'the architect never writes anything down and nobody agrees';
  const { state, what, text } = setup();
  writeBookPoint(state, { hid: what.hid, markdown: `句甲[^1]。\n\n[^1]: 「${A}」 (document-l1-p1)` });
  const added = writeBookPoint(state, { hid: what.hid, edits: [{ find: '句甲[^1]。', replace: `句甲[^1]。句乙[^2]。\n\n[^2]: 「${FAKE}」 (document-l1-p1)` }] });
  assert.deepEqual(added.dropped, [{ n: '2', quote: FAKE, reason: 'not-found' }]);
  assert.match(text(), /句甲\[\^1\]。句乙。/, 'the made-up footnote\'s mark is taken out');
  assert.doesNotMatch(text(), /never writes anything down/);
  assert.equal(added.warnings.some(warning => /kept as they were written/.test(warning)), false);
  // The words of a checked footnote changed by an edit are checked again: made-up words are not kept as a source.
  const definition = text().split('\n').find(line => line.startsWith('[^1]:'));
  const changed = writeBookPoint(state, { hid: what.hid, edits: [{ find: definition, replace: `[^1]: 「${FAKE}」 (document-l1-p1)` }] });
  assert.deepEqual(changed.dropped, [{ n: '1', quote: FAKE, reason: 'not-found' }]);
  assert.doesNotMatch(text(), /never writes anything down/);
  assert.doesNotMatch(text(), /\[\^1\]/, 'its mark went with it');
});

test('a section mark with no footnote of its own cites the file\'s footnote of that number, and the answer says so', () => {
  const { state, what, text } = setup();
  writeBookPoint(state, { hid: what.hid, markdown: `#### 甲\n\n句甲[^1]。\n\n#### 乙\n\n旧的。\n\n[^1]: 「${A}」 (document-l1-p1)` });
  const done = writeBookPoint(state, { hid: what.hid, section: { heading: '乙', markdown: '句乙[^1]。' } });
  assert.ok(done.warnings.some(warning => /\[\^1\] have no footnote in the new text/.test(warning)), done.warnings.join(' | '));
  assert.deepEqual(citedBy(text()), { 句甲: A, 句乙: A });
});

test('the cited-sources view reads a full-width-colon definition like the writer does', () => {
  assert.deepEqual([...citedSources('句[^1]。\n\n[^1]：「words of the page」（document-l1-p1）')], ['document-l1-p1']);
});

test('a definition written with a full-width colon is a definition, not a mark', () => {
  const { state, what, text } = setup();
  const done = writeBookPoint(state, { hid: what.hid, markdown: `句甲[^1]。\n\n[^1]：「${A}」（document-l1-p1）` });
  assert.deepEqual(done.dropped, []);
  assert.deepEqual(definitions(text()), ['1']);
  assert.match(text(), /^\[\^1\]: \[「/m);
  assert.equal(citedBy(text()).句甲, A, 'the mark cites the words written for it, not the file\'s older [^1]');
});

test('the pure rules: duplicate lists bound by place, the same words once, a missing definition counted', () => {
  const taken = takeFootnotes(['a[^1] b[^2]', '[^1]: x', '[^2]: y', 'c[^1]', '[^1]: z', 'd[^1] e[^3]', '[^1]: x'], 'o');
  assert.deepEqual(taken.lines, ['a[^o-1] b[^o-2]', 'c[^o2-1]', 'd[^o-1] e[^o-3]']);
  assert.deepEqual([...taken.pool], [['o-1', 'x'], ['o-2', 'y'], ['o2-1', 'z']]);
  assert.deepEqual([...taken.missing], [['3', 1]]);
  assert.deepEqual([...taken.defined], ['1', '2']);
  assert.deepEqual(footnoteProblems('a[^1] b[^2]\n\n[^1]: x\n[^2]: y'), []);
  assert.equal(footnoteProblems('a[^1]\n\n[^1]: x\n[^1]: y').length > 0, true, 'two definitions of [^1]');
  assert.equal(footnoteProblems('a[^2]\n\n[^2]: x').length > 0, true, 'not numbered from 1');
  assert.equal(footnoteProblems('a[^1] b[^2]\n\n[^1]: x').length > 0, true, 'a mark with no definition');
});
