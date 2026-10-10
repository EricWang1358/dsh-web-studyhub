/* 复习全书 M2 (docs/plans/review-book.md): editing the book's files. The fork rule and suggestions (I2), compare-and-set saves through one writer queue
   per course with the 书已更新 merge by file (I1), typed headings get ids that never collide with the outline's (I4), footnotes stay per file, the version
   history outside the sources with its cap and 回退到上一版 (I7), a failing write leaves the book as it was. A fuzz test of the heading and footnote rules.
   No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { openCourseBook } from '../lib/course-book-files.js';
import { saveBookFile, bookSuggestion, takenIds } from '../lib/course-book-edit.js';
import { capHistory, HISTORY_KEPT } from '../lib/course-book-history.js';
import { assignHeadingIds, bookIndex, stitchBook } from '../lib/course-book-links.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

function library() {
  const { sources, decks } = outlineLibrary();
  const state = { revision: 1, sources, documents: [], decks, drafts: [], attempts: [], runs: [], courses: [], focus: { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] } };
  const lecture = groupSourcesByDocument(sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
  const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
    nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }, { id: 'who', title: 'Stakeholders', anchors: [`${lecture}#1`] }] }],
    other: { anchors: [] }, counts: { units: 2, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
  state.sources.push(outline);
  const page = sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes[0].children;
  state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
    body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} [^1].`], explain: `About ${leaf.title}.`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] } })) }),
    createdAt: '2026-10-09T01:00:00.000Z' });
  return state;
}
const leaves = nodes => nodes.flatMap(node => (node.leaf ? [node] : leaves(node.children)));
const notesOf = state => state.sources.find(source => source.provenance === 'course-outline-notes');
const rewrite = (state, explain) => { const notes = notesOf(state); notes.courseNotes.leaves[0].body = { ...notes.courseNotes.leaves[0].body, explain }; state.revision += 1; };

test('the fork rule: editing a generated file forks it; a new generated text waits as a suggestion; 忽略 keeps it away, 采用 takes it; the own file is never touched (I2)', () => {
  const state = library(), book = openCourseBook(state, {}), [what, who] = leaves(book.nodes);
  const mine = saveBookFile(state, { file: who.files.mine, text: 'My own note on stakeholders.', version: book.files[who.files.mine].version });
  assert.equal(mine.status, 'saved');
  const saved = saveBookFile(state, { file: what.files.gen, text: `${what.gen}\n\nMy addition.`, version: book.files[what.files.gen].version });
  assert.equal(saved.status, 'saved');
  let view = openCourseBook(state, {});
  assert.equal(view.files[what.files.gen].forked, true, 'edited: forked');
  rewrite(state, 'A better explanation.');
  view = openCourseBook(state, {});
  assert.match(leaves(view.nodes)[0].gen, /My addition\./, 'the learner\'s text stays');
  assert.match(view.files[what.files.gen].suggestion.text, /A better explanation\./, 'the new generated text is a suggestion');
  assert.equal(view.files[what.files.gen].suggestion.kind, 'generated');
  assert.equal(leaves(view.nodes)[1].mine, 'My own note on stakeholders.', 'regeneration never changes an own file');
  const version = view.files[what.files.gen].version;
  assert.equal(bookSuggestion(state, { file: what.files.gen, action: 'ignore', version }).status, 'ignored');
  view = openCourseBook(state, {});
  assert.equal(view.files[what.files.gen].suggestion, null);
  state.revision += 1;
  assert.equal(openCourseBook(state, {}).files[what.files.gen].suggestion, null, 'the text set aside is not offered again');
  rewrite(state, 'The best explanation.');
  view = openCourseBook(state, {});
  assert.match(view.files[what.files.gen].suggestion.text, /The best explanation\./, 'a newer one is');
  assert.throws(() => bookSuggestion(state, { file: what.files.gen, action: 'accept', version: version - 1 }), error => error.code === 'course-book-conflict');
  assert.equal(bookSuggestion(state, { file: what.files.gen, action: 'accept', version: view.files[what.files.gen].version }).status, 'accepted');
  view = openCourseBook(state, {});
  assert.match(leaves(view.nodes)[0].gen, /The best explanation\./);
  assert.equal(view.files[what.files.gen].forked, false, 'taking the generated text unforks it: the next one replaces it again');
  rewrite(state, 'Later.');
  assert.match(leaves(openCourseBook(state, {}).nodes)[0].gen, /Later\./);
  assert.throws(() => saveBookFile(state, { file: 'nope.md', text: 'x', version: 1 }), error => error.code === 'course-book-file-missing');
  assert.throws(() => saveBookFile(state, { file: what.files.gen, text: 'x' }), error => error.code === 'course-book-version-required');
});

test('a typed heading gets an id on save that no heading of the outline or another file has; a copied id is given anew; footnotes stay per file (I4)', () => {
  const state = library(), book = openCourseBook(state, {}), [what, who] = leaves(book.nodes), doc = state.sources.find(source => source.provenance === 'course-book-doc').bookDoc;
  saveBookFile(state, { file: what.files.mine, text: '## My section\n\nA note [^1].\n\n[^1]: mine', version: 1 });
  const first = bookIndex(doc.files[what.files.mine].text).flat[0].id;
  assert.ok(/^h\d+$/.test(first));
  const manifestIds = takenIds({ manifest: doc.manifest, files: {} });
  assert.ok(!manifestIds.includes(first), 'not an id of the outline');
  saveBookFile(state, { file: who.files.mine, text: `## Copied <!-- sh:id ${first} -->\n\n## Also copied <!-- sh:id ${what.hid} -->\n\nB [^1].\n\n[^1]: other`, version: 1 });
  const ids = bookIndex(doc.files[who.files.mine].text).flat.map(heading => heading.id);
  assert.ok(!ids.includes(first) && !ids.includes(what.hid) && new Set(ids).size === 2, `copied ids are given anew: ${ids}`);
  saveBookFile(state, { file: what.files.mine, text: `${doc.files[what.files.mine].text}\n\n## Second`, version: 2 });
  assert.equal(bookIndex(doc.files[what.files.mine].text).flat[0].id, first, 'an id once given stays');
  const view = openCourseBook(state, {}), stitched = stitchBook({ title: view.title, nodes: view.nodes, unplaced: view.unplaced });
  const all = bookIndex(stitched).flat.map(heading => heading.id);
  assert.equal(new Set(all).size, all.length, 'every heading of the stitched book has its own id');
  const marks = [...stitched.matchAll(/^\[\^([^\]]+)\]:/gm)].map(match => match[1]);
  assert.equal(new Set(marks).size, marks.length, `no footnote shared between files: ${marks}`);
});

test('fuzz: random edits of headings, ids and footnotes keep every id unique, keep the ids already given, never take an outline id, keep footnotes per file', () => {
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = list => list[Math.floor(random() * list.length)];
  const outlineIds = ['h1', 'h2', 'h3'], files = { a: '', b: '' };
  let next = 4;
  for (let round = 0; round < 300; round++) {
    const name = pick(['a', 'b']), lines = files[name] ? files[name].split('\n') : [];
    const known = Object.values(files).flatMap(text => bookIndex(text).flat.map(heading => heading.id)).filter(Boolean);
    const action = pick(['heading', 'copy', 'outline-copy', 'footnote', 'delete', 'move', 'text']);
    if (action === 'heading') lines.splice(Math.floor(random() * (lines.length + 1)), 0, `${'#'.repeat(1 + Math.floor(random() * 4))} Title ${round}`);
    if (action === 'copy' && known.length) lines.push(`## Copy ${round} <!-- sh:id ${pick(known)} -->`);
    if (action === 'outline-copy') lines.push(`### Outline copy ${round} <!-- sh:id ${pick(outlineIds)} -->`);
    if (action === 'footnote') lines.push(`Text [^${1 + Math.floor(random() * 3)}].`, '', `[^${1 + Math.floor(random() * 3)}]: note ${round}`);
    if (action === 'delete' && lines.length) lines.splice(Math.floor(random() * lines.length), 1);
    if (action === 'move' && lines.length > 1) { const [line] = lines.splice(Math.floor(random() * lines.length), 1); lines.splice(Math.floor(random() * lines.length), 0, line); }
    if (action === 'text') lines.push('```', '# not a heading', '```', `plain ${round}`);
    const before = bookIndex(files[name]).flat.filter(heading => heading.id).map(heading => heading.id);
    const other = bookIndex(files[name === 'a' ? 'b' : 'a']).flat.map(heading => heading.id).filter(Boolean);
    const named = assignHeadingIds(lines.join('\n'), { next, taken: [...outlineIds, ...other] });
    next = named.next;
    files[name] = named.text;
    const after = bookIndex(files[name]).flat;
    assert.ok(after.every(heading => heading.id), `round ${round}: every heading has an id`);
    const all = Object.values(files).flatMap(text => bookIndex(text).flat.map(heading => heading.id));
    assert.equal(new Set(all).size, all.length, `round ${round}: ids unique in the book (${action})`);
    assert.ok(after.every(heading => !outlineIds.includes(heading.id)), `round ${round}: no outline id taken`);
    const survived = after.map(heading => heading.id);
    // An id the file had, still on a heading there (not moved into a code fence), once, and nowhere else in the book, is kept.
    const headingIds = bookIndex(lines.join('\n')).flat.map(heading => heading.id);
    for (const id of before) if (!other.includes(id) && headingIds.filter(item => item === id).length === 1) assert.ok(survived.includes(id), `round ${round}: ${id} kept`);
    const stitched = stitchBook({ title: 'T', nodes: [{ hid: 'h1', number: '1', title: 'A', leaf: true, gen: '', mine: files.a, children: [] }, { hid: 'h2', number: '2', title: 'B', leaf: true, gen: '', mine: files.b, children: [] }], unplaced: { title: 'U', text: '' } });
    const stitchedIds = bookIndex(stitched).flat.map(heading => heading.id);
    assert.deepEqual(stitchedIds, ['book', 'h1', ...bookIndex(files.a).flat.map(heading => heading.id), 'h2', ...bookIndex(files.b).flat.map(heading => heading.id)],
      `round ${round}: stitched, every file keeps its headings (an open code fence never swallows the next file)`);
    for (const [file, text] of [['h1m', files.a], ['h2m', files.b]]) {
      const local = new Set([...text.matchAll(/\[\^([\w-]+)\]/g)].map(match => match[1]));
      for (const n of local) assert.ok(stitched.includes(`[^${file}-${n}]`), `round ${round}: footnote ${n} of ${file} named for its file`);
    }
  }
});

async function service(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-book-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  await study.call('snapshot');
  const state = library();
  await study.store.update(own => { own.sources.push(...state.sources); own.decks.push(...state.decks); own.focus = state.focus; });
  return { root, study, rewrite: async explain => study.store.update(own => { const notes = own.sources.find(source => source.provenance === 'course-outline-notes'); notes.courseNotes.leaves[0].body = { ...notes.courseNotes.leaves[0].body, explain }; }) };
}

test('interleaving: a program refresh, an editor save from before it and a second editor save land one after another; nothing is lost (I1)', async t => {
  const { study, rewrite: renote } = await service(t);
  const book = await study.call('course.book.open'), [what] = leaves(book.nodes), gen = what.files.gen, start = book.files[gen].version;
  // The editor opened the file at `start`; meanwhile the notes change and the program refreshes the (unforked) generated file.
  await renote('Refreshed by the program.');
  const refreshed = await study.call('course.book.open');
  assert.match(leaves(refreshed.nodes)[0].gen, /Refreshed by the program\./);
  assert.equal(refreshed.files[gen].version, start + 1);
  const late = await study.call('course.book.save', { file: gen, text: 'The learner\'s own text.', version: start });
  assert.equal(late.write, 'merged', '书已更新');
  assert.equal(leaves(late.nodes)[0].gen, 'The learner\'s own text.', 'the unsaved edit is kept');
  assert.match(late.files[gen].suggestion.text, /Refreshed by the program\./, 'the other text is offered');
  assert.equal(late.files[gen].suggestion.kind, 'theirs');
  // Two editors save the same file from the same version at once: the queue runs them one after the other; the second keeps its text and offers the first.
  const version = late.files[gen].version;
  const [one, two] = await Promise.all([study.call('course.book.save', { file: gen, text: 'Editor one.', version }), study.call('course.book.save', { file: gen, text: 'Editor two.', version }),
    study.call('course.book.open')]);
  assert.deepEqual([one.write, two.write], ['saved', 'merged']);
  assert.equal(leaves(two.nodes)[0].gen, 'Editor two.');
  assert.equal(two.files[gen].suggestion.text, 'Editor one.');
  assert.equal(two.files[gen].version, version + 2);
  // A save of another file from an old version is no conflict: only that file's version counts.
  const other = await study.call('course.book.save', { file: what.files.mine, text: 'Mine.', version: 1 });
  assert.equal(other.write, 'saved');
});

test('crash safety: a write that fails leaves the book and its history as they were', async t => {
  const { study } = await service(t);
  const book = await study.call('course.book.open'), [what] = leaves(book.nodes);
  await study.call('course.book.save', { file: what.files.mine, text: 'Kept.', version: 1 });
  const before = await study.call('course.book.open');
  const commit = study.store.commit;
  study.store.commit = async () => { throw new Error('disk full'); };
  try { await assert.rejects(study.call('course.book.save', { file: what.files.mine, text: 'Lost?', version: before.files[what.files.mine].version }), /disk full/); } finally { study.store.commit = commit; }
  const after = await study.call('course.book.open');
  assert.equal(leaves(after.nodes)[0].mine, 'Kept.');
  assert.deepEqual(after.history, before.history);
  assert.equal(after.files[what.files.mine].version, before.files[what.files.mine].version);
});

test('versions: kept outside the sources, at most 20, 回退到上一版 per file takes them back one by one (I7)', async t => {
  const { root, study, rewrite: renote } = await service(t);
  let book = await study.call('course.book.open');
  const [what] = leaves(book.nodes), mine = what.files.mine, gen = what.files.gen;
  for (let i = 1; i <= 25; i++) book = await study.call('course.book.save', { file: mine, text: `Version ${i}.`, version: book.files[mine].version });
  assert.equal(book.history[mine], HISTORY_KEPT, 'at most 20 versions');
  assert.deepEqual(await readdir(join(root, 'book-history')).then(list => list.length), 1, 'one history file a course, beside the library');
  const record = (await study.store.read()).sources.find(source => source.provenance === 'course-book-doc');
  assert.equal(JSON.stringify(record).includes('Version 3.'), false, 'the versions are not in the sources');
  book = await study.call('course.book.revert', { file: mine });
  assert.equal(leaves(book.nodes)[0].mine, 'Version 24.');
  book = await study.call('course.book.revert', { file: mine });
  assert.equal(leaves(book.nodes)[0].mine, 'Version 23.');
  // A program write can be taken back too: the generated file returns to what it was, and is then the learner's (forked), so the program does not write it again.
  await renote('Program rewrite.');
  book = await study.call('course.book.open');
  assert.match(leaves(book.nodes)[0].gen, /Program rewrite\./);
  book = await study.call('course.book.revert', { file: gen });
  assert.doesNotMatch(leaves(book.nodes)[0].gen, /Program rewrite/);
  assert.equal(book.files[gen].forked, true);
  assert.equal((await study.call('course.book.open')).files[gen].suggestion, null, 'the text taken back is not written or offered again');
  await renote('A newer program text.');
  const newer = await study.call('course.book.open');
  assert.doesNotMatch(leaves(newer.nodes)[0].gen, /newer/, 'a newer one is not written over the learner\'s choice either');
  assert.match(newer.files[gen].suggestion.text, /A newer program text\./, 'it is offered');
  await assert.rejects(study.call('course.book.revert', { file: 'unplaced.md' }), error => error.code === 'course-book-no-version');
  const big = Array.from({ length: 30 }, (_, i) => ({ file: 'x', version: i, text: 'y'.repeat(300000) }));
  const capped = capHistory(big);
  assert.ok(capped.length < HISTORY_KEPT && capped.reduce((sum, entry) => sum + entry.text.length, 0) <= 4_000_000, 'fewer versions when they are large');
});
