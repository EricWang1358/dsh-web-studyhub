/* The 复习全书 of a course as Markdown files (docs/plans/review-book.md): for each knowledge point (leaf) of the 总纲 a generated file `<leaf>.gen.md`
   (the program's: 考情, 知识梳理, 讲解, 例子, 补充, 出处 as footnotes, the point's questions as links) and the learner's `<leaf>.mine.md`; a manifest (the
   outline's tree with a stable heading id per node, `hid`, and each leaf's anchors and title, to map the files again after the outline is rebuilt); and
   `unplaced.md` for text whose point is gone. All in ONE hidden record of the library, `provenance: 'course-book-doc'` (lib/exam-point-list.js: never a
   material, in no list, search or retrieval index). Stitched in order by lib/course-book-links.js stitchBook.

   course.book.open { course?, language? } -> { status: 'ok' | 'empty', course, reason?, revision, title, language, notes, papers, nodes, unplaced }
     Creates the files when there are none (no model call); otherwise brings the generated files that nobody changed (`forked: false`) up to date with the
     notes and questions as they are now, and after an outline rebuild maps the files to the new points (by anchors, then title; what cannot be mapped goes
     to 未归位, 「已无对应知识点」, nothing is deleted). A learner's file is never changed here. `nodes`: [{ hid, key, title, number, depth, leaf, gen, mine,
     questions, children }]. 'empty' with reason 'no-outline'. A mutation of the state; no I/O of its own. M1 writes nothing else (no editing yet). */
import { createHash } from 'node:crypto';
import { currentCourse } from './focus.js';
import { courseRowsOf } from './course-outline.js';
import { currentCourseOutline } from './course-outline-book.js';
import { bookKey } from './course-outline-book-view.js';
import { courseNotesOf, leafNotes } from './course-book-view.js';
import { COURSE_BOOK_DOC_PROVENANCE, isCourseBookDocSource } from './exam-point-list.js';
import { bookLinks, CHUNK } from './course-book-links.js';

export const BOOK_FILES_VERSION = 1;
/** The most question links a point's generated file lists; the rest come through its 练 5 道 link. */
export const LINKS_SHOWN = 20;
const WORDS = {
  zh: { book: '复习全书', exam: '考情', tested: '样卷考过。', untested: '样卷没有考到这一点。', points: '知识梳理', explain: '讲解', example: '例子', extra: '补充（资料以外）',
    cites: '出处', questions: '本节的题', card: '练习', practice: n => `练 ${n} 道`, qa: '本节问答', more: n => `还有 ${n} 道题，在「练 ${CHUNK} 道」里按顺序出。`, none: '这一节还没有题。',
    sep: '：', quote: text => `「${text}」`, unplaced: '未归位', gone: '已无对应知识点' },
  en: { book: 'Review book', exam: 'In the sample papers', tested: 'Tested in the sample papers.', untested: 'The sample papers do not test this point.', points: 'Key points',
    explain: 'Explanation', example: 'Example', extra: 'Extra (beyond the materials)', cites: 'Sources', questions: 'Questions of this point', card: 'Practise', practice: n => `Practise ${n}`,
    qa: 'Questions and answers', more: n => `${n} more questions come in order through “Practise ${CHUNK}”.`, none: 'This point has no questions yet.',
    sep: ': ', quote: text => `“${text}”`, unplaced: 'Not placed', gone: 'no longer a point of the outline' },
};
const wordsOf = language => WORDS[language === 'en' ? 'en' : 'zh'];
const oneLine = (value, max = 160) => { const text = String(value ?? '').replace(/\{\{[^{}]+\}\}/g, '＿＿').replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; };
const sameTitle = title => String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const docId = course => `course-book-doc-${createHash('sha256').update(JSON.stringify(['course-book-doc', course])).digest('hex').slice(0, 40)}`;
const genFile = id => `${id}.gen.md`, mineFile = id => `${id}.mine.md`, UNPLACED = 'unplaced.md';

/** A point's generated file: its notes (footnotes numbered in the file, each 出处 a footnote with a link to the place), its questions as links, the 练 5 道 and 本节问答 links. */
export function genText({ notes, questions, hid, title, language }) {
  const words = wordsOf(language), lines = [], body = notes?.body, name = oneLine(title, 80);
  if (notes?.exam) lines.push(`**${words.exam}** ${notes.exam.tested ? words.tested : words.untested}${notes.exam.note ? ` ${notes.exam.note}` : ''}`, '');
  if (body?.points?.length) lines.push(`**${words.points}**`, '', ...body.points.map(point => `- ${point}`), '');
  if (body?.explain) lines.push(`**${words.explain}**`, '', body.explain, '');
  if (body?.example) lines.push(`**${words.example}**`, '', body.example, '');
  if (body?.extra?.length) lines.push(`**${words.extra}**`, '', ...body.extra.map(item => `- ${item}`), '');
  if (body?.cites?.length) lines.push(`**${words.cites}**`, '', ...body.cites.map(cite => `[^${cite.n}]: [${words.quote(oneLine(cite.quote, 200))}](${bookLinks.source(cite.sourceId)})${cite.title ? ` · ${oneLine(cite.title, 120)}` : ''}`), '');
  if (!questions.length) lines.push(words.none);
  else {
    const shown = questions.slice(0, LINKS_SHOWN);
    lines.push(`**${words.questions}**`, '', ...shown.map(item => `- [${words.card}${words.sep}${oneLine(item.prompt)}](${bookLinks.card(item.deckId, item.cardId)})`));
    if (questions.length > shown.length) lines.push('', words.more(questions.length - shown.length));
    lines.push('', `[${words.practice(CHUNK)}${words.sep}${name}](${bookLinks.practice(hid)}) · [${words.qa}${words.sep}${name}](${bookLinks.qa(hid)})`);
  }
  return lines.join('\n').trim();
}

/**
 * The manifest of a new outline, keeping what can be kept of the old one: a leaf takes the heading id (and so the files) of the old leaf sharing the most
 * anchors with it, else of an old leaf of the same title; a chapter or section the id of one of the same title. -> { nodes, moved: Map<old id, new id>, lost: [old leaf], next }.
 */
export function remapManifest(old, outlineNodes, next = 1) {
  const oldLeaves = [], oldParents = [], taken = new Set();
  const collect = list => (list || []).forEach(node => { (node.leaf ? oldLeaves : oldParents).push(node); collect(node.children); });
  collect(old?.nodes);
  let counter = next;
  const used = new Set([...oldLeaves, ...oldParents].map(node => node.hid));
  const fresh = () => { while (used.has(`h${counter}`)) counter += 1; used.add(`h${counter}`); return `h${counter++}`; };
  const moved = new Map();
  const pick = (pool, test) => pool.find(node => !taken.has(node.hid) && test(node));
  const build = list => (list || []).map(node => {
    const leaf = !node.children?.length, anchors = leaf ? [...(node.anchors || [])] : [];
    let match = null;
    if (leaf) {
      const overlap = candidate => candidate.anchors.filter(anchor => anchors.includes(anchor)).length;
      match = oldLeaves.filter(candidate => !taken.has(candidate.hid) && overlap(candidate) > 0).sort((a, b) => overlap(b) - overlap(a))[0]
        ?? pick(oldLeaves, candidate => sameTitle(candidate.title) === sameTitle(node.title));
    } else match = pick(oldParents, candidate => sameTitle(candidate.title) === sameTitle(node.title));
    if (match) { taken.add(match.hid); if (leaf) moved.set(match.id, node.id); }
    return { id: node.id, hid: match?.hid ?? fresh(), title: node.title, leaf, anchors, children: leaf ? [] : build(node.children) };
  });
  const nodes = build(outlineNodes);
  return { nodes, moved, lost: oldLeaves.filter(node => !taken.has(node.hid)), next: counter };
}

const leavesOf = nodes => (nodes || []).flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));
const recordOf = (state, course) => (state.sources || []).find(source => isCourseBookDocSource(source) && source.bookDoc.course === course && !source.archived) ?? null;
const courseOf = (state, args) => {
  const course = args.course === undefined ? currentCourse(state) : args.course;
  if (course !== null && typeof course !== 'string') throw new Error('course.book.open: course must be a course name or an empty string (uncategorised)');
  return course === '*' ? null : course;
};

/** course.book.open (see the top of this file). */
export function openCourseBook(state, args = {}) {
  const course = courseOf(state, args);
  if (course === null || course === undefined) return { status: 'empty', course: null, reason: 'no-course' };
  const outline = currentCourseOutline(state.sources, course);
  if (!outline) return { status: 'empty', course, reason: 'no-outline' };
  const { index, rowOf, entriesOf } = courseRowsOf(state, course);
  const notes = courseNotesOf(state, index.allDocuments, outline), byId = new Map((state.sources || []).map(source => [source.id, source]));
  const language = notes?.record.courseNotes.language || (args.language === 'en' || args.uiLanguage === 'en' ? 'en' : 'zh'), words = wordsOf(language);
  let record = recordOf(state, course), changed = false;
  const now = new Date().toISOString();
  if (!record) {
    record = { id: docId(course), title: `${words.book} · ${course || '—'}`, text: '', format: 'md', courses: course ? [course] : [], provenance: COURSE_BOOK_DOC_PROVENANCE, createdAt: now,
      bookDoc: { version: BOOK_FILES_VERSION, course, language, outlineId: null, revision: 0, updatedAt: now, nextId: 1, manifest: { nodes: [] }, files: { [UNPLACED]: { text: '', version: 1 } } } };
    state.sources.push(record);
    changed = true;
  }
  const doc = record.bookDoc;
  if (doc.outlineId !== outline.id) {
    const remapped = remapManifest(doc.manifest, outline.courseOutline.nodes, doc.nextId), files = { [UNPLACED]: doc.files[UNPLACED] || { text: '', version: 1 } };
    for (const [from, to] of remapped.moved) for (const name of [genFile, mineFile]) if (doc.files[name(from)]) files[name(to)] = doc.files[name(from)];
    // What has no point any more goes to 未归位 with the point's title: the learner's file, and a generated file the learner changed. Nothing is deleted.
    const kept = remapped.lost.flatMap(node => {
      const parts = [doc.files[mineFile(node.id)]?.text, doc.files[genFile(node.id)]?.forked ? doc.files[genFile(node.id)].text : ''].filter(text => String(text ?? '').trim());
      return parts.length ? [`### ${oneLine(node.title, 120)}（${words.gone}）`, '', ...parts.map(text => text.trim()), ''] : [];
    });
    if (kept.length) files[UNPLACED] = { text: [files[UNPLACED].text.trim(), kept.join('\n').trim()].filter(Boolean).join('\n\n'), version: files[UNPLACED].version + 1 };
    Object.assign(doc, { manifest: { nodes: remapped.nodes }, files, outlineId: outline.id, nextId: remapped.next });
    changed = true;
  }
  const questionsOf = node => { const row = rowOf(bookKey(node.id)); return row ? entriesOf(row).sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]) : []; };
  for (const leaf of leavesOf(doc.manifest.nodes)) {
    const text = genText({ notes: leafNotes(notes, leaf.id, byId), questions: questionsOf(leaf), hid: leaf.hid, title: leaf.title, language: doc.language || language });
    const file = doc.files[genFile(leaf.id)];
    if (!file) { doc.files[genFile(leaf.id)] = { text, version: 1, forked: false }; changed = true; } else if (!file.forked && file.text !== text) { file.text = text; file.version += 1; changed = true; }
    if (!doc.files[mineFile(leaf.id)]) { doc.files[mineFile(leaf.id)] = { text: '', version: 1 }; changed = true; }
  }
  if (changed) Object.assign(doc, { revision: doc.revision + 1, updatedAt: now });
  const view = (list, prefix, depth) => (list || []).map((node, at) => {
    const number = `${prefix}${at + 1}`;
    return { hid: node.hid, key: bookKey(node.id), title: node.title, number, depth, leaf: node.leaf,
      ...(node.leaf ? { gen: doc.files[genFile(node.id)]?.text ?? '', mine: doc.files[mineFile(node.id)]?.text ?? '', questions: questionsOf(node).length } : {}),
      children: view(node.children, `${number}.`, depth + 1) };
  });
  return { status: 'ok', course, revision: doc.revision, title: record.title, language: doc.language || language, notes: !!notes, papers: (outline.courseOutline.papers || []).length,
    nodes: view(doc.manifest.nodes, '', 1), unplaced: { title: words.unplaced, text: doc.files[UNPLACED]?.text ?? '' } };
}
