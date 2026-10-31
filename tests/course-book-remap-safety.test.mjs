/* #461: after the 总纲 is organised again, the review book's points follow their pages to the new points (lib/course-book-remap.js). A point's own text (the
   learner's file, a generated file the learner changed, its Q&A) moves to a new point of ANOTHER title only when that point holds most of the old point's
   pages (MOVE_MIN_SHARE); otherwise it waits in 未归位 under its old title, saying which point was closest, instead of sitting under a wrong title. Every
   move is recorded with how much of the old point the new one holds. A rebuild of an outline whose book holds the learner's own text asks for `confirm`
   first. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MOVE_MIN_SHARE, remapManifest } from '../lib/course-book-remap.js';
import { openCourseBook } from '../lib/course-book-files.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { StudyService } from '../lib/service.js';
import { settleJob } from './helpers/wait.mjs';
import { privateRoot } from './helpers/model-family-baseline.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { COURSE, outlineLibrary, outlineModel } from './helpers/course-outline-library.mjs';

const leaf = (id, hid, title, anchors) => ({ id, hid, title, leaf: true, anchors, children: [] });
const span = (sourceId, start, end) => ({ sourceId, start, end });

test('a point of another title takes the old point\'s text only when it holds most of its pages; else the old point is held back, with the closest point named', () => {
  const pages = { a: [span('s1', 0, 100)], b: [span('s1', 0, 10), span('s2', 0, 1000)], c: [span('s3', 0, 100)], d: [span('s3', 0, 70), span('s4', 0, 30)] };
  const sourcesOf = anchor => pages[anchor];
  const old = { nodes: [leaf('A', 'h1', 'Cloud native', ['a']), leaf('C', 'h2', 'Layers', ['c'])] };
  const { nodes, moved, held, lost } = remapManifest(old, [{ id: 'B', title: 'Databases state failure conditions', anchors: ['b'] },
    { id: 'D', title: 'Layered style', anchors: ['d'] }], 3, { sourcesOf });
  assert.ok(MOVE_MIN_SHARE > 0.1 && MOVE_MIN_SHARE <= 0.7);
  assert.equal(moved.has('A'), false, 'one tenth of "Cloud native" is in the new point: its text does not go under that title');
  assert.deepEqual(held.map(item => [item.node.id, item.likely, item.share]), [['A', 'B', 0.1]]);
  assert.equal(nodes[0].hid, 'h3', 'the new point gets a new heading id, not the old one');
  assert.deepEqual([moved.get('C'), nodes[1].hid, nodes[1].movedFrom, nodes[1].moveShare], ['D', 'h2', 'Layers', 0.7], 'a renamed point holding most of the pages keeps them');
  assert.deepEqual(lost, []);
  // A new point that is mostly a part of the old one (a point cut into its sections) takes it too.
  const part = remapManifest({ nodes: [leaf('W', 'h1', 'Whole lecture', ['w'])] }, [{ id: 'P', title: 'Its first section', anchors: ['p1'] }, { id: 'Q', title: 'Its second', anchors: ['p2'] },
    { id: 'R', title: 'Its third', anchors: ['p3'] }], 3, { sourcesOf: anchor => ({ w: [span('s9', 0, 300)], p1: [span('s9', 0, 100)], p2: [span('s9', 100, 200)], p3: [span('s9', 200, 300)] })[anchor] });
  assert.deepEqual([part.moved.get('W'), part.held.length, part.nodes[0].moveShare], ['P', 0, 0.33]);
  // However many parts: a lecture cut into 6 or 12 points follows into its first part, nothing held, nothing lost.
  for (const count of [6, 12]) {
    const parts = Array.from({ length: count }, (_, at) => ({ id: `P${at}`, title: `Section ${at + 1}`, anchors: [`p${at}`] }));
    const sourcesOf = anchor => (anchor === 'w' ? [span('s9', 0, count * 100)] : [span('s9', Number(anchor.slice(1)) * 100, Number(anchor.slice(1)) * 100 + 100)]);
    const cut = remapManifest({ nodes: [leaf('W', 'h1', 'Whole lecture', ['w'])] }, parts, 3, { sourcesOf });
    assert.deepEqual([cut.moved.get('W'), cut.held.length, cut.lost.length, cut.nodes[0].hid], ['P0', 0, 0, 'h1'], `${count} parts`);
  }
  // The same title moves whatever the share; an old point held back may still be matched by its title.
  const titled = remapManifest(old, [{ id: 'B', title: 'Cloud native', anchors: ['b'] }], 3, { sourcesOf });
  assert.deepEqual([titled.moved.get('A'), titled.held.length, titled.nodes[0].hid], ['B', 0, 'h1']);
  // A fold (two old points into one new one) is held back the same way when the new point holds little of the folded one.
  const fold = remapManifest({ nodes: [leaf('A', 'h1', 'Cloud native', ['a']), leaf('E', 'h2', 'Edge', ['e'])] }, [{ id: 'B', title: 'Databases', anchors: ['b', 'f'] }], 3,
    { sourcesOf: anchor => ({ ...pages, e: [span('s5', 0, 100)], f: [span('s5', 0, 2000)] })[anchor] });
  assert.deepEqual([[...fold.moved], [...fold.folded], fold.held.map(item => item.node.id)], [[['E', 'B']], [], ['A']]);
});

test('the text goes to the new point that holds most of the old one\'s pages: a small part is never paired first (17% / 83%); a sliver that is not the closest takes nothing', () => {
  // An old point of 600 characters: a new point holds its first 100 (all of it inside the old one), another holds the other 500 plus a long other text.
  const split = remapManifest({ nodes: [leaf('O', 'h1', 'Cloud native', ['o'])] }, [{ id: 'A', title: 'Databases state failure conditions', anchors: ['a'] },
    { id: 'B', title: 'Cloud-native architecture', anchors: ['b'] }], 3,
    { sourcesOf: anchor => ({ o: [span('s1', 0, 600)], a: [span('s1', 0, 100)], b: [span('s1', 100, 600), span('s2', 0, 3000)] })[anchor] });
  assert.deepEqual([split.moved.get('O'), split.held.length, split.nodes[1].hid, split.nodes[1].moveShare], ['B', 0, 'h1', 0.83], 'the 83% point, not the 17% one');
  // The round-2 regression (not the mapping the issue recorded): a long note (21 sections) whose pages went to two points that are mostly other lectures, and
  // one section to a point on databases wholly inside it: no new point is mostly it and the databases point is not the closest one, so the note is held.
  const h25 = remapManifest({ nodes: [leaf('O', 'h25', '云原生架构', ['o'])] }, [{ id: 'D', title: '数据库题须写失败条件', anchors: ['d'] },
    { id: 'M', title: 'Microservices', anchors: ['m'] }, { id: 'K', title: 'Kubernetes', anchors: ['k'] }], 30,
    { sourcesOf: anchor => ({ o: [span('cn', 0, 2100)], d: [span('cn', 0, 100)], m: [span('cn', 100, 1100), span('x', 0, 2000)], k: [span('cn', 1100, 2100), span('y', 0, 2000)] })[anchor] });
  assert.deepEqual([h25.moved.size, h25.folded.size, h25.held.map(item => [item.node.id, item.likely, item.share])], [0, 0, [['O', 'M', 0.48]]]);
  assert.ok(h25.nodes.every(node => node.hid !== 'h25'), 'no new point takes the old heading');
});

test('the mechanism behind the issue\'s mapping on main: one-to-one pairing handed the big piece to another old point and the note fell to a sliver; now it folds into the big piece', () => {
  // Old "云原生架构" (1000 chars) and old "Microservices" (5000 chars elsewhere). New M holds 900 of the first and all of the second; new D holds the other 100.
  // On main the pair scores were shared / the bigger side: Microservices-M 0.85 won M, so 云原生架构 was paired to D (0.1) and its note sat under D's title.
  const pages = { a: [span('cn', 0, 1000)], b: [span('ms', 0, 5000)], m: [span('cn', 100, 1000), span('ms', 0, 5000)], d: [span('cn', 0, 100)] };
  const result = remapManifest({ nodes: [leaf('A', 'h25', '云原生架构', ['a']), leaf('B', 'h2', 'Microservices', ['b'])] },
    [{ id: 'D', title: '数据库题须写失败条件', anchors: ['d'] }, { id: 'M', title: 'Microservices', anchors: ['m'] }], 30, { sourcesOf: anchor => pages[anchor] });
  assert.deepEqual([result.moved.get('B'), result.moved.has('A'), result.folded.get('A')], ['M', false, 'M'], 'folded (under its own heading) into the point holding 90% of it');
  assert.notEqual(result.nodes.find(node => node.id === 'D').hid, 'h25');
});

test('MOVE_MIN_SHARE is compared unrounded: 49.5% is not half', () => {
  const at = end => remapManifest({ nodes: [leaf('O', 'h1', 'Old', ['o'])] }, [{ id: 'N', title: 'Other', anchors: ['n'] }], 3,
    { sourcesOf: anchor => ({ o: [span('s', 0, 1000)], n: [span('s', 0, end), span('t', 0, 5000)] })[anchor] });
  assert.deepEqual([at(495).moved.size, at(495).held.map(item => item.share)], [0, [0.5]], 'held, though it shows as 0.5');
  assert.equal(at(500).moved.get('O'), 'N');
});

test('property: over random cuts, a moved or folded point always goes to a new point holding the biggest share of its pages (ties: the first)', () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let round = 0; round < 300; round++) {
    const olds = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, at) => ({ id: `O${at}`, size: 100 * (1 + Math.floor(random() * 10)) }));
    const pages = {}, fresh = [];
    olds.forEach(old => { pages[old.id] = [span(old.id, 0, old.size)]; });
    // Cut every old point into random pieces; a new point takes one or two neighbouring pieces (possibly of two old points) and maybe some other text.
    const pieces = olds.flatMap(old => { const cuts = [0, ...Array.from({ length: Math.floor(random() * 4) }, () => Math.floor(random() * old.size)), old.size].sort((a, b) => a - b);
      return cuts.slice(1).map((end, at) => span(old.id, cuts[at], end)).filter(piece => piece.end > piece.start); });
    for (let at = 0; at < pieces.length;) {
      const take = 1 + Math.floor(random() * 2), id = `N${fresh.length}`;
      pages[id] = [...pieces.slice(at, at + take), ...(random() < 0.5 ? [span(`x${id}`, 0, Math.floor(random() * 2000))] : [])].filter(piece => piece.end > piece.start);
      fresh.push({ id, title: `New ${fresh.length}`, anchors: [id] });
      at += take;
    }
    const result = remapManifest({ nodes: olds.map((old, at) => leaf(old.id, `h${at + 1}`, `Old ${at}`, [old.id])) }, fresh, 10, { sourcesOf: anchor => pages[anchor] });
    const shareOf = (old, id) => { const own = pages[old.id][0]; let common = 0;
      for (const piece of pages[id]) if (piece.sourceId === old.id) common += Math.max(0, Math.min(piece.end, own.end) - Math.max(piece.start, own.start));
      return Math.round((common / old.size) * 100) / 100; };
    for (const old of olds) {
      const to = result.moved.get(old.id) ?? result.folded.get(old.id);
      if (!to) continue;
      const top = Math.max(...fresh.map(item => shareOf(old, item.id)));
      assert.equal(shareOf(old, to), top, `round ${round}: ${old.id} went to ${to} holding ${shareOf(old, to)} where one holds ${top}`);
    }
  }
});

test('a held point is not put back by its title onto a new point it shares nothing with; one that shares nothing at all still is (as before)', () => {
  const pages = { a: [span('s1', 0, 100)], b: [span('s1', 0, 10), span('s2', 0, 1000)], c: [span('s9', 0, 50)], z: [span('s3', 0, 100)] };
  const result = remapManifest({ nodes: [leaf('A', 'h1', 'Cloud native', ['a']), leaf('Z', 'h2', 'Glossary', ['z'])] },
    [{ id: 'B', title: 'Databases', anchors: ['b'] }, { id: 'C', title: 'Cloud native', anchors: ['c'] }, { id: 'G', title: 'Glossary', anchors: ['g'] }], 3,
    { sourcesOf: anchor => pages[anchor] ?? [span('s8', 0, 10)] });
  assert.deepEqual([result.moved.has('A'), result.held.map(item => item.node.id)], [false, ['A']], 'held, not moved to the namesake that holds none of its pages');
  assert.equal(result.moved.get('Z'), 'G', 'an old point sharing nothing with any new point still goes to its namesake');
});

const lectureKey = sources => groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
function outlineOf(state, nodes, createdAt) {
  return { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes, other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt };
}
const leaves = nodes => nodes.flatMap(node => (node.leaf ? [node] : leaves(node.children)));
const bookOf = state => state.sources.find(source => source.provenance === 'course-book-doc');

test('the book: a learner\'s note whose pages went mostly elsewhere waits in 未归位 under its old title; the moves say what moved where and how much', () => {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = lectureKey(sources), other = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l3-p1')).key;
  const first = outlineOf(state, [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] },
    { id: 'who', title: 'Stakeholders and views', anchors: [`${lecture}#1`, `${lecture}#2`] }] }], '2026-10-09T00:00:00.000Z');
  state.sources.push(first);
  openCourseBook(state, {});
  const record = bookOf(state), [what, who] = leaves(record.bookDoc.manifest.nodes);
  record.bookDoc.files[`${what.id}.mine.md`].text = 'Note on what architects do.';
  record.bookDoc.files[`${who.id}.mine.md`].text = 'A long note on stakeholders and views.';
  // The rebuild: "What architects do" keeps its chapter under a new name; one page of the four of "Stakeholders and views" is now in a point that is mostly
  // another lecture (a point on another topic).
  const rebuilt = outlineOf(state, [{ id: 'k1', title: 'Introduction', children: [{ id: 'k2', title: 'The architect\'s job', anchors: [`${lecture}#0`] },
    { id: 'k3', title: 'Databases state failure conditions', anchors: [`${lecture}@s2-2`, other] }] }], '2026-10-10T00:00:00.000Z');
  state.sources = state.sources.map(source => (source.id === first.id ? { ...source, archived: true } : source)).concat(rebuilt);
  const book = openCourseBook(state, {}), [job, databases] = leaves(book.nodes);
  assert.deepEqual([job.hid, job.mine, job.movedFrom], [what.hid, 'Note on what architects do.', 'What architects do']);
  assert.equal(databases.mine, '', 'the note on stakeholders is not put under a point on databases');
  assert.notEqual(databases.hid, who.hid);
  assert.match(book.unplaced.text, /### Stakeholders and views（总纲重新整理后对不上新的知识点，先放在这里；最接近的是「Databases state failure conditions」，只有 \d+% 的页在那里）\n\nA long note on stakeholders and views\./);
  // The moves list only what moved; what was held back is listed apart (it is in 未归位, not under the closest point).
  assert.deepEqual(book.moves.list, [{ from: 'What architects do', to: 'The architect\'s job', folded: false, share: 1, own: true, first: 'Note on what architects do.' }]);
  assert.equal(book.moves.total, book.moves.list.length, 'how many moves there were, so a cut list says so');
  assert.equal(book.moves.held, 1);
  assert.equal(book.moves.heldList.length, 1, 'only the held point whose text was parked: "What architects do" had text and moved; nothing else was held');
  const [kept] = book.moves.heldList;
  assert.deepEqual([kept.from, kept.closest], ['Stakeholders and views', 'Databases state failure conditions']);
  assert.ok(kept.share > 0 && kept.share < MOVE_MIN_SHARE);
});

test('the book: a 3.4 point of a whole lecture cut into six points follows to the first of them; nothing waits in 未归位', () => {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = lectureKey(sources);
  const first = outlineOf(state, [{ id: 'c1', title: 'Materials', children: [{ id: 'lec', title: '01. Introduction to Solution Architecture v2.1', anchors: [lecture] }] }],
    '2026-10-09T00:00:00.000Z');
  state.sources.push(first);
  openCourseBook(state, {});
  bookOf(state).bookDoc.files['lec.mine.md'].text = 'My own note on the lecture.';
  const six = Array.from({ length: 6 }, (_, at) => ({ id: `s${at}`, title: `Page ${at + 1} topic`, anchors: [`${lecture}@s${at}-${at}`] }));
  state.sources = state.sources.map(source => (source.id === first.id ? { ...source, archived: true } : source))
    .concat(outlineOf(state, [{ id: 'c2', title: 'Introduction', children: six }], '2026-10-10T00:00:00.000Z'));
  const book = openCourseBook(state, {});
  assert.equal(book.unplaced.text.trim(), '');
  assert.equal(leaves(book.nodes).filter(point => point.mine === 'My own note on the lecture.').length, 1, 'the note is in the part it shares most with');
  assert.equal(book.moves.held, 0);
});

test('two held points that both use [^1] are parked with their own footnote labels, without the links of their gone headings', () => {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = lectureKey(sources), keyOf = id => groupSourcesByDocument(sources).find(item => item.sourceIds.includes(id)).key;
  const first = outlineOf(state, [{ id: 'c1', title: 'Introduction', children: [{ id: 'one', title: 'Point one', anchors: [`${lecture}#0`, `${lecture}#1`] },
    { id: 'two', title: 'Point two', anchors: [`${lecture}#2`, keyOf('document-l2-p1')] }] }], '2026-10-09T00:00:00.000Z');
  state.sources.push(first);
  openCourseBook(state, {});
  const record = bookOf(state), [one, two] = leaves(record.bookDoc.manifest.nodes);
  record.bookDoc.files[`${one.id}.mine.md`].text = `First note [^1].\n\n[^1]: one\n\n[练 5 道：x](studyhub://practice?heading=${one.hid}&n=5)`;
  record.bookDoc.files[`${two.id}.mine.md`].text = 'Second note [^1].\n\n[^1]: two';
  // Each old point keeps one page, in a point that is mostly another lecture: both held.
  const rebuilt = outlineOf(state, [{ id: 'k1', title: 'Other', children: [{ id: 'x', title: 'Databases', anchors: [`${lecture}@s0-0`, keyOf('document-l3-p1')] },
    { id: 'y', title: 'Networks', anchors: [`${lecture}@s4-4`, keyOf('document-l4-p1')] }] }], '2026-10-10T00:00:00.000Z');
  state.sources = state.sources.map(source => (source.id === first.id ? { ...source, archived: true } : source)).concat(rebuilt);
  const book = openCourseBook(state, {}), text = book.unplaced.text;
  assert.equal(book.moves.held, 2);
  const labels = [...text.matchAll(/^\[\^([^\]]+)\]:/gm)].map(match => match[1]);
  assert.deepEqual([labels.length, new Set(labels).size], [2, 2], text);
  assert.doesNotMatch(text, new RegExp(`heading=${one.hid}`), 'the 练 link of a gone heading is left out');
});

test('organising the outline again when the book holds the learner\'s own text asks for confirm first, saying what will happen; an empty book does not', async t => {
  const fake = outlineModel({ inventory: 'none' }), root = await privateRoot(t, 'course-book-remap-safety-');
  const service = new StudyService(root, { complete: fake.complete, ...switchOptions('runtime', { complete: fake.complete, paths: [] }) });
  t.after(() => service.dispose());
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => { state.sources.push(...structuredClone(sources)); state.decks.push(...structuredClone(decks)); state.focus = { mode: 'class', course: COURSE }; });
  const build = async (extra = {}) => service.call('generation.courseOutline.build', { course: COURSE, language: 'zh', ...extra });
  const settle = async extra => assert.equal((await settleJob(service, (await build(extra)).jobId)).status, 'complete');
  await settle();
  const opened = await service.call('course.book.open', { course: COURSE });
  await settle();
  const calls = fake.calls.length, point = leaves(opened.nodes)[0];
  await service.call('course.book.save', { course: COURSE, file: point.files.mine, text: 'My own note.', version: opened.files[point.files.mine].version });
  await assert.rejects(build(), error => {
    assert.equal(error.code, 'course-outline-book-confirm', error.message);
    assert.match(error.message, new RegExp(`复习全书里有你自己写的内容（1 个知识点：「${point.title}」）.*未归位.*confirm: true`));
    return true;
  });
  await assert.rejects(build({ language: 'en' }), error => error.code === 'course-outline-book-confirm' && /confirm: true/.test(error.message) && /1 knowledge point/.test(error.message));
  assert.equal(fake.calls.length, calls, 'refused before any model call');
  // The review book asked to organise it again (rebuildOutline, here over an outline of an older version) asks the same.
  await service.store.update(state => { for (const source of state.sources) if (source.provenance === 'course-outline' && !source.archived) delete source.courseOutline.from; });
  await assert.rejects(service.call('generation.courseBook.build', { course: COURSE, language: 'zh', rebuildOutline: true }),
    error => error.code === 'course-outline-book-confirm' && /confirm: true/.test(error.message));
  assert.equal(fake.calls.length, calls);
  await settle({ confirm: true });
});
