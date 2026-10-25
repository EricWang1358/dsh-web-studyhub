/* The structure of the 复习全书 (#470, docs/review-book.md): its chapters and knowledge points renamed, moved and deleted by the learner or the main
   chat, without rebuilding the outline (the outline itself is never edited by hand, docs/course-outline.md) and without sending the book's text.
   Mutations of the state, no I/O; the ops run them as they run course.book.save (lib/contexts/library/operations.js: the book's writer queue, one store
   transaction each, what a change replaced kept in the version history, lib/course-book-history.js).

   The book has a structure version (lib/course-book-own-titles.js structureVersionOf; course.book.open and book.toc say it): every change of its tree
   moves it, and so does a rebuilt outline. Each action is compare-and-set on it: a stale `version` is refused (course-book-conflict), nothing changes.
   course.book.rename { course?, hid, title, version }: the title the book shows for that chapter or point; its id, files and questions stay, and the
     outline keeps its own title (`doc.ownTitles`, so a rebuilt outline that keeps the point's id keeps the learner's title too).
   course.book.move { course?, hid, toParent?, afterHid?, beforeHid?, version }: the node with everything below it under another chapter or section
     (`toParent`, or 'book' for the top level; last there) or next to a node (`afterHid` / `beforeHid`; with `toParent` too, that node must be its child).
     A point's files go with it (they are named by it, not by the place); the headings in its files follow its new depth. A move that would put a
     heading past level 6 is refused (it could only be flattened).
   course.book.delete { course?, hid, children?: promote | toUnplaced, version }: the node goes and nothing stays in its place. promote (the default):
     what is below it takes its place. toUnplaced: everything below it goes too. Either way what the learner wrote in a point that goes (notes, Q&A, a
     generated text they changed) is never destroyed: it waits in 未归位 under the point's title (refused when 未归位 would pass FILE_TEXT_MAX); a point
     with nothing of the learner's leaves nothing. A chapter left empty stays (`emptied` says so).
   -> { status: renamed | moved | deleted | unchanged, before, also, facts } where `before` is the history entry of the book as it was, { file: STRUCTURE_FILE,
     version, text: JSON { outlineId, version, nodes, ownTitles, files: { [name]: the file as it was | null }, after: { [name]: hash of its text after | null } } },
     and `also` the files' own history entries ({ file, version, text } as they were) of every file the change rewrote and kept: a file's 回退到上一版
     then steps back exactly this one write, as after any other write.
   revertBookStructure (course.book.revert { file: STRUCTURE_FILE }) takes the latest change back while the outline is the same and every file it touched
   holds the text it left (a later undo gives a file its text back, so undos in a row work). A rebuilt outline lays the book out by the new outline again: the learner's titles are kept, moves and deletes are not. */
import { courseOf, genFile, mineFile, qaFile, recordOf, textHash, UNPLACED } from './course-book-files.js';
import { bookLinks } from './course-book-links.js';
import { cleanTitle, headingsOf, sameTitle, shiftLevels } from './book-section-ops.js';
import { MAX_TITLE_CHARS } from './document-title.js';
import { STRUCTURE_FILE, structureVersionOf } from './course-book-own-titles.js';
import { FILE_TEXT_MAX } from './course-book-edit.js';

/** The name the structure's versions are kept under in the version history (never a file of the book: no `.md`). */
export { STRUCTURE_FILE };
export const DELETE_NODE_CHILDREN = Object.freeze(['promote', 'toUnplaced']);
const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const FILES = [['g', genFile], ['m', mineFile], ['q', qaFile]];
const linesOf = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
const leavesOf = node => (node.leaf ? [node] : (node.children || []).flatMap(leavesOf));
const subtree = node => [node, ...(node.children || []).flatMap(subtree)];

function bookOf(state, args) {
  const course = courseOf(state, args), record = course === null || course === undefined ? null : recordOf(state, course);
  if (!record) fail('这门课还没有复习全书，先打开书页 / This course has no review book yet; open the book page first', 'course-book-missing');
  return record.bookDoc;
}
function checkVersion(doc, version) {
  if (!Number.isInteger(version)) fail('version is required: the book\'s structureVersion (book.toc or course.book.open says it)', 'course-book-version-required');
  if (version !== structureVersionOf(doc)) fail(`书的目录在这之后改过了，请重新看一下再改 / The book's structure changed since version ${version} (it is ${structureVersionOf(doc)} now); read it again (book.toc) and retry`, 'course-book-conflict');
}
const missing = hid => fail(`书里没有 id 为 ${hid} 的章节或知识点；用 book.toc 看目录 / The book has no chapter or point of id ${hid}; book.toc lists them`, 'course-book-node-missing');

/** Where a node is: { node, list (its siblings, itself included), index, parent (null at the top), depth }, or null. */
function locate(nodes, hid, parent = null, depth = 1) {
  for (const [index, node] of (nodes || []).entries()) {
    if (node.hid === hid) return { node, list: nodes, index, parent, depth };
    const found = locate(node.children, hid, node, depth + 1);
    if (found) return found;
  }
  return null;
}
/** Each point's depth: { [leaf id]: depth }. */
function depthsOf(nodes, depth = 1, out = {}) {
  for (const node of nodes || []) { if (node.leaf) out[node.id] = depth; depthsOf(node.children, depth + 1, out); }
  return out;
}

/** The structure before a change; `keep` records a file before the change touches it. */
function snapshot(doc) {
  const snap = { outlineId: doc.outlineId ?? null, version: structureVersionOf(doc), nodes: structuredClone(doc.manifest?.nodes || []), ownTitles: structuredClone(doc.ownTitles || {}), files: {}, after: {} };
  return { snap, keep: name => { if (!Object.hasOwn(snap.files, name)) snap.files[name] = doc.files[name] ? structuredClone(doc.files[name]) : null; } };
}
/** Each file a change rewrote and kept, as it was: its own history entry ({ file, version, text }). */
const rewritten = (files, now) => Object.entries(files).filter(([name, was]) => was && now[name] && now[name].text !== was.text)
  .map(([name, was]) => ({ file: name, version: was.version, text: was.text }));
/** The change done: the files' versions after it, the structure version moved, the book touched; -> { before (the structure's history entry), also
    (the rewritten files' own entries) }. */
function finish(doc, snap) {
  for (const name of Object.keys(snap.files)) snap.after[name] = doc.files[name] ? textHash(doc.files[name].text) : null;
  Object.assign(doc, { structureVersion: snap.version + 1, revision: doc.revision + 1, updatedAt: new Date().toISOString() });
  return { before: { file: STRUCTURE_FILE, version: snap.version, text: JSON.stringify(snap) }, also: rewritten(snap.files, doc.files) };
}

/** The headings of the files of every point whose depth changed follow it (a point at depth d has its heading at level d + 1, its sections deeper). */
function followDepths(doc, was, keep) {
  const now = depthsOf(doc.manifest.nodes);
  for (const [id, depth] of Object.entries(now)) {
    const delta = depth - (was[id] ?? depth);
    if (!delta) continue;
    for (const [, name] of FILES) {
      const file = doc.files[name(id)];
      // A generated file nobody changed has no headings and is written again from the notes.
      if (!file || (name === genFile && !file.forked) || !headingsOf(linesOf(file.text)).length) continue;
      keep(name(id));
      const text = shiftLevels(linesOf(file.text), delta, depth + 2).join('\n');
      if (text !== file.text) Object.assign(file, { text, version: file.version + 1 });
    }
  }
}

/** course.book.rename (see the top of this file). */
export function renameBookNode(state, args = {}) {
  const doc = bookOf(state, args);
  checkVersion(doc, args.version);
  const title = cleanTitle(args.title);
  if (!title) fail(`title must be one line of 1-${MAX_TITLE_CHARS} characters`, 'course-book-title-invalid');
  const place = locate(doc.manifest?.nodes, args.hid) ?? missing(args.hid);
  if (place.list.some(node => node !== place.node && sameTitle(node.title) === sameTitle(title)))
    fail(`同一层已经有「${title}」了 / A chapter or point next to it already has this title`, 'course-book-title-taken');
  if (place.node.title === title) return { status: 'unchanged', before: null, facts: { hid: place.node.hid, title } };
  const { snap } = snapshot(doc), own = { ...(doc.ownTitles || {}) }, outline = own[place.node.hid]?.outline ?? place.node.title;
  if (title === outline) delete own[place.node.hid]; else own[place.node.hid] = { title, outline };
  doc.ownTitles = own;
  place.node.title = title;
  return { status: 'renamed', ...finish(doc, snap), facts: { hid: place.node.hid, title, outlineTitle: outline } };
}

/** course.book.move (see the top of this file). */
export function moveBookNode(state, args = {}) {
  const doc = bookOf(state, args);
  checkVersion(doc, args.version);
  const nodes = doc.manifest?.nodes || [], place = locate(nodes, args.hid) ?? missing(args.hid);
  const invalid = message => fail(message, 'course-book-move-invalid');
  if (args.afterHid !== undefined && args.beforeHid !== undefined) invalid('give afterHid or beforeHid, not both');
  const anchorHid = args.afterHid ?? args.beforeHid;
  if (args.toParent === undefined && anchorHid === undefined) invalid('say where: toParent (a chapter or section id, or "book" for the top level), afterHid or beforeHid');
  const inside = new Set(subtree(place.node).map(node => node.hid));
  let parent;
  if (anchorHid !== undefined) {
    if (inside.has(anchorHid)) invalid('一个节点不能移到它自己旁边或里面 / A node cannot go next to or inside itself');
    const anchor = locate(nodes, anchorHid) ?? missing(anchorHid);
    parent = anchor.parent;
    if (args.toParent !== undefined && (args.toParent === 'book' ? parent !== null : parent?.hid !== args.toParent)) invalid(`${args.afterHid !== undefined ? 'afterHid' : 'beforeHid'} must be a node directly under toParent`);
  } else if (args.toParent === 'book') parent = null;
  else {
    if (inside.has(args.toParent)) invalid('一个节点不能移到它自己里面 / A node cannot go inside itself');
    const target = locate(nodes, args.toParent) ?? missing(args.toParent);
    if (target.node.leaf) invalid('知识点下面不能再放章节或知识点；请选一个章或节 / A knowledge point holds no other node; name a chapter or a section');
    parent = target.node;
  }
  const depth = (parent ? locate(nodes, parent.hid).depth : 0) + 1;
  if (deepestAfter(doc, place.node, depth - place.depth, place.depth) > 6)
    invalid('移到这里会有标题超过第 6 级；换一个浅一些的位置 / There a heading would pass level 6 (Markdown has no deeper level); choose a shallower place');
  const was = depthsOf(nodes), { snap, keep } = snapshot(doc);
  place.list.splice(place.index, 1);
  const siblings = parent ? (parent.children ||= []) : nodes;
  const at = anchorHid === undefined ? siblings.length : siblings.findIndex(node => node.hid === anchorHid) + (args.afterHid !== undefined ? 1 : 0);
  siblings.splice(at, 0, place.node);
  if (JSON.stringify(nodes) === JSON.stringify(snap.nodes)) return { status: 'unchanged', before: null, facts: { hid: place.node.hid } };
  followDepths(doc, was, keep);
  const emptied = place.parent && place.parent !== parent && !place.parent.children.length ? { emptied: { hid: place.parent.hid, title: place.parent.title } } : {};
  return { status: 'moved', ...finish(doc, snap), facts: { hid: place.node.hid, parent: parent?.hid ?? 'book', ...emptied } };
}

/** The deepest heading level `node` and the files of its points would have `delta` levels deeper (a node at depth d has its heading at level d + 1). */
function deepestAfter(doc, node, delta, depth) {
  let deepest = depth + delta + 1;
  for (const child of node.children || []) deepest = Math.max(deepest, deepestAfter(doc, child, delta, depth + 1));
  if (node.leaf && delta > 0) for (const [, name] of FILES) {
    const file = doc.files[name(node.id)];
    if (!file || (name === genFile && !file.forked)) continue;
    for (const heading of headingsOf(linesOf(file.text))) deepest = Math.max(deepest, heading.level + delta);
  }
  return deepest;
}

/** What the learner wrote in a point, as it waits in 未归位: under `### title`, footnotes named for the point's file, its 练 / 问答 links left out. */
function learnerText(doc, leaf) {
  // The links of this heading exactly (h12's, not h120's).
  const gone = [`${bookLinks.practice(leaf.hid).split('&')[0]}&`, `${bookLinks.qa(leaf.hid)})`];
  const parts = FILES.map(([part, name]) => {
    const file = doc.files[name(leaf.id)];
    if (!file || (name === genFile && !file.forked) || !String(file.text ?? '').trim()) return '';
    const lines = linesOf(file.text).filter(line => !gone.some(link => line.includes(link)));
    const top = Math.min(...headingsOf(lines).map(heading => heading.level));
    return (Number.isFinite(top) && top < 4 ? shiftLevels(lines, 4 - top) : lines).join('\n').replace(/\[\^([\w-]{1,40})\]/g, (mark, label) => `[^${leaf.hid}${part}-${label}]`).trim();
  }).filter(Boolean);
  return parts.length ? [`### ${leaf.title}`, ...parts].join('\n\n') : '';
}

/** course.book.delete (see the top of this file). */
export function deleteBookNode(state, args = {}) {
  const doc = bookOf(state, args);
  checkVersion(doc, args.version);
  const children = args.children ?? 'promote';
  if (!DELETE_NODE_CHILDREN.includes(children)) fail(`children must be ${DELETE_NODE_CHILDREN.join(' or ')}`, 'course-book-children-invalid');
  const nodes = doc.manifest?.nodes || [], place = locate(nodes, args.hid) ?? missing(args.hid);
  const was = depthsOf(nodes), { snap, keep } = snapshot(doc);
  const promote = children === 'promote', gone = promote ? [place.node] : subtree(place.node), leaves = promote ? leavesOf(place.node).filter(node => node === place.node) : leavesOf(place.node);
  // What the learner wrote in the points that go waits in 未归位 (never only in the history, which keeps a limited number of versions).
  const texts = leaves.map(leaf => learnerText(doc, leaf)).filter(Boolean), unplaced = doc.files[UNPLACED] ?? { text: '', version: 0 };
  const kept = texts.length ? [String(unplaced.text ?? '').trim(), ...texts].filter(Boolean).join('\n\n') : null;
  if (kept !== null && kept.length > FILE_TEXT_MAX)
    fail(`未归位放不下这些笔记（${kept.length} / ${FILE_TEXT_MAX} 字符）；先整理一下未归位 / 未归位 cannot hold the learner's text of what is deleted (${kept.length} of at most ${FILE_TEXT_MAX} characters); tidy 未归位 first`, 'course-book-unplaced-full');
  place.list.splice(place.index, 1, ...(promote ? place.node.children || [] : []));
  if (kept !== null) {
    keep(UNPLACED);
    doc.files[UNPLACED] = { ...unplaced, text: kept, version: unplaced.version + 1 };
  }
  const aside = texts.length;
  let files = 0;
  for (const leaf of leaves) for (const [, name] of FILES) if (doc.files[name(leaf.id)]) { keep(name(leaf.id)); delete doc.files[name(leaf.id)]; files += 1; }
  const own = { ...(doc.ownTitles || {}) };
  for (const node of gone) delete own[node.hid];
  doc.ownTitles = own;
  followDepths(doc, was, keep);
  const emptied = place.parent && !place.parent.children.length ? { emptied: { hid: place.parent.hid, title: place.parent.title } } : {};
  return { status: 'deleted', ...finish(doc, snap), facts: { hid: place.node.hid, children, removed: { points: leaves.length, sections: gone.filter(node => !node.leaf).length, files, toUnplaced: aside }, ...emptied } };
}

/** 撤销 of a structure change: `text` is its history entry (`textVersion` that entry's version). With `version` (the page's 撤销), only while the
    structure is still at that version and the entry is the change just before it. */
export function revertBookStructure(state, args = {}) {
  const doc = bookOf(state, args);
  let snap = null;
  try { snap = JSON.parse(String(args.text)); } catch { snap = null; }
  if (!snap || !Array.isArray(snap.nodes)) fail('没有更早的版本 / There is no earlier version', 'course-book-no-version');
  if ((snap.outlineId ?? null) !== (doc.outlineId ?? null)) fail('总纲在这之后重新整理过，这次改动不能再撤销 / The outline was rebuilt since; this change can no longer be undone', 'course-book-conflict');
  if (args.version !== undefined && (args.version !== structureVersionOf(doc) || (Number.isInteger(args.textVersion) && args.textVersion !== args.version - 1)))
    fail('这之后书的目录又改过了，只能撤销最近一次的改动 / The book\'s structure changed since; only the latest change can be undone', 'course-book-conflict');
  for (const [name, hash] of Object.entries(snap.after || {})) if ((doc.files[name] ? textHash(doc.files[name].text) : null) !== hash)
    fail(`这次改动之后 ${name} 又被改过了，先撤销那一处 / ${name} was written after this change; undo that first`, 'course-book-conflict');
  doc.manifest = { ...doc.manifest, nodes: snap.nodes };
  doc.ownTitles = snap.ownTitles || {};
  const also = [];
  for (const [name, file] of Object.entries(snap.files || {})) {
    const now = doc.files[name];
    // A file this undo rewrites keeps the text it replaces in its own history, as after any other write.
    if (now && file && now.text !== file.text) also.push({ file: name, version: now.version, text: now.text });
    if (file === null) delete doc.files[name];
    // A file the change removed comes back as it was; one it changed gets its text back as a new version.
    else doc.files[name] = now ? { ...file, version: Math.max(file.version, now.version) + 1 } : file;
  }
  Object.assign(doc, { structureVersion: structureVersionOf(doc) + 1, revision: doc.revision + 1, updatedAt: new Date().toISOString() });
  return { status: 'reverted', before: null, also };
}

/** The small answer of a structure action (the chat's; `answer: 'book'` gets the whole book like course.book.save). */
export const structureAnswer = book => ({ course: book.course, write: book.write, ...(book.structureFacts || {}), structureVersion: book.structureVersion, revision: book.revision,
  history: book.history?.[STRUCTURE_FILE] ?? 0,
  note: book.write === 'unchanged' ? 'Nothing changed.' : `course.book.revert {file: "${STRUCTURE_FILE}"} undoes it.` });
