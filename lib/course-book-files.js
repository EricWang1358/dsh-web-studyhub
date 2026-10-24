/* The 复习全书 of a course as Markdown files (docs/plans/review-book.md): for each knowledge point (leaf) of the 总纲 a generated file `<leaf>.gen.md`
   (the program's: 考情, 知识梳理, 讲解, 例子, 补充, 出处 as footnotes, the 练 5 道 and 本节问答 links) and the learner's `<leaf>.mine.md`; a manifest (the
   outline's tree with a stable heading id per node, `hid`, and each leaf's anchors and title, to map the files again after the outline is rebuilt); and
   `unplaced.md` for text whose point is gone. All in ONE hidden record of the library, `provenance: 'course-book-doc'` (lib/exam-point-list.js: never a
   material, in no list, search or retrieval index). Stitched in order by lib/course-book-links.js stitchBook.

   course.book.open { course?, language? } -> { status: 'ok' | 'empty', course, reason?, revision, title, language, notes, papers, nodes, unplaced, missing, changed,
     answerCards, caseTypes } (M6: the 查找页's inputs, lib/course-book-cards.js; read live like the questions, never stored)
     Creates the files when there are none (no model call); otherwise brings the generated files that nobody changed (`forked: false`) up to date with the
     notes as they are now, and after an outline rebuild maps the files to the new points (by anchors, then title; what cannot be mapped goes to 未归位,
     「已无对应知识点」; nothing the learner wrote, edited or forked is deleted). A learner's file is never changed here. A generated file holds no list of
     questions: those are the point's questions NOW (`questions` of a node, read live, never stored), so a new or deleted question changes no file.
     `nodes`: [{ hid, key, title, number, depth, leaf, gen, mine, questions: [{ deckId, cardId, prompt }], questionTotal, children }]; `missing`: the
     'deckId|cardId' of questions the files link that are gone. 'empty' with reason 'no-outline'. With `{ write: false }` nothing is changed and `changed`
     says whether opening would write (the op writes only then: an unchanged open does not touch the library).
   M2: a generated file the learner edited is `forked`: the program never writes over it; a newer generated text waits in `suggestions` (采用/忽略,
   lib/course-book-edit.js: newest first, at most SUGGESTIONS_KEPT, the same text once) unless the learner set that very text aside (`ignored`: hashes).
   Every file has a `version` (compare-and-set of a save) and a generated file keeps the text it was last generated as (`generated`). A point may also
   have a third file, `<leaf>.qa.md` (the Q&A put into the book, M3: written only by book.qa.add/remove), stitched after the learner's; it is absent until
   then. `files`: { [name]: { version, forked, suggestions } }; `replaced`: the files this
   open wrote over ({ file, version, text } before), for the version history (lib/course-book-history.js). */
import { createHash } from 'node:crypto';
import { currentCourse } from './focus.js';
import { courseRowsOf } from './course-outline.js';
import { currentCourseOutline } from './course-outline-book.js';
import { bookKey } from './course-outline-book-view.js';
import { courseNotesOf, leafNotes } from './course-book-view.js';
import { remapManifest } from './course-book-remap.js';
import { anchorSources, documentIndex } from './course-book-inputs.js';
import { partHeading, partsNamed } from './course-book.js';
import { COURSE_BOOK_DOC_PROVENANCE, isCourseBookDocSource } from './exam-point-list.js';
import { bookLinks, CHUNK, parseBookLink } from './course-book-links.js';
import { bookCardsOf } from './course-book-cards.js';
import { keepOwnTitles, outlineTitled, structureVersionOf } from './course-book-own-titles.js';

export const BOOK_FILES_VERSION = 1;
/** The most questions of a point the page is given (it shows the first few; all are practised through 练 5 道). */
export const QUESTIONS_SHOWN = 200;
const WORDS = {
  zh: { book: '复习全书', exam: '考情', tested: '样卷考过。', untested: '样卷没有考到这一点。', points: '知识梳理', explain: '讲解', example: '例子', extra: '补充（资料以外）',
    cites: '出处', practice: n => `练 ${n} 道`, qa: '本节问答', sep: '：', quote: text => `「${text}」`, unplaced: '未归位', gone: '已无对应知识点',
    short: (n, names) => `**未达标**：缺 ${n} 个概念（${names}）。「补漏」只补这些。`,
    notice: '复习全书（由 StudyHub 3.4 以上管理，请勿删除）' },
  en: { book: 'Review book', exam: 'In the sample papers', tested: 'Tested in the sample papers.', untested: 'The sample papers do not test this point.', points: 'Key points',
    explain: 'Explanation', example: 'Example', extra: 'Extra (beyond the materials)', cites: 'Sources', practice: n => `Practise ${n}`, qa: 'Questions and answers',
    sep: ': ', quote: text => `“${text}”`, unplaced: 'Not placed', gone: 'no longer a point of the outline',
    short: (n, names) => `**Short**: ${n} concept(s) missing (${names}). Fill the gaps does only those.`,
    notice: 'Review book (managed by StudyHub 3.4 or later; do not delete)' },
};
const wordsOf = language => WORDS[language === 'en' ? 'en' : 'zh'];
const oneLine = (value, max = 160) => { const text = String(value ?? '').replace(/\{\{[^{}]+\}\}/g, '＿＿').replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; };
const docId = course => `course-book-doc-${createHash('sha256').update(JSON.stringify(['course-book-doc', course])).digest('hex').slice(0, 40)}`;
export const genFile = id => `${id}.gen.md`, mineFile = id => `${id}.mine.md`, qaFile = id => `${id}.qa.md`, UNPLACED = 'unplaced.md';
/** The most suggestions a file keeps waiting, and the most set-aside texts it remembers. */
export const SUGGESTIONS_KEPT = 3, IGNORED_KEPT = 50;
/** A file's waiting suggestions, newest first (a file of M2's first form kept one, `suggestion`). */
export const suggestionsOf = file => (Array.isArray(file?.suggestions) ? file.suggestions : file?.suggestion ? [{ id: textHash(file.suggestion.text), ...file.suggestion }] : []);
const ignoredOf = file => (Array.isArray(file?.ignored) ? file.ignored : typeof file?.ignored === 'string' ? [file.ignored] : []);
/** Offers a text on a file: first in its list, the same text once, at most SUGGESTIONS_KEPT; a text the learner set aside is not offered. -> offered? */
export function offerSuggestion(file, text, kind) {
  const id = textHash(text);
  if (ignoredOf(file).includes(id) || file.text === text) return false;
  file.suggestions = [{ id, text, kind }, ...suggestionsOf(file).filter(item => item.id !== id)].slice(0, SUGGESTIONS_KEPT);
  delete file.suggestion;
  return true;
}
/** Sets a suggestion aside: it leaves the list and its text is not offered again. */
export function dropSuggestion(file, id, { remember = false } = {}) {
  if (remember) file.ignored = [...ignoredOf(file).filter(item => item !== id), id].slice(-IGNORED_KEPT);
  file.suggestions = suggestionsOf(file).filter(item => item.id !== id);
  delete file.suggestion;
}
/** The short hash a set-aside suggestion is remembered by. */
export const textHash = text => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);

/** A point's generated file: its notes (footnotes numbered in the file, each 出处 a footnote with a link to the place), then the 练 5 道 and 本节问答 links. It
    depends on the notes and the point only: the point's questions are shown live by the page, never written here. */
export function genText({ notes, hid, title, language }) {
  const words = wordsOf(language), lines = [], body = notes?.body, name = oneLine(title, 80);
  // The transitions (过渡句) as plain italic lines: leading in above the point, leading on (or the chapter's wrap-up) below it; older notes have none.
  if (notes?.bridge?.in) lines.push(`*${notes.bridge.in}*`, '');
  if (notes?.exam) lines.push(`**${words.exam}** ${notes.exam.tested ? words.tested : words.untested}${notes.exam.note ? ` ${notes.exam.note}` : ''}`, '');
  if (body?.points?.length) lines.push(`**${words.points}**`, '', ...body.points.map(point => `- ${point}`), '');
  if (body?.explain) lines.push(`**${words.explain}**`, '', body.explain, '');
  if (body?.example) lines.push(`**${words.example}**`, '', body.example, '');
  // Written by the quality workflow: one free text; a point still short says what it misses (never claimed complete).
  if (body?.text) lines.push(body.text, '');
  if (body?.text && body.status === 'short' && body.coverage?.missing.length) lines.push(words.short(body.coverage.missing.length, body.coverage.missing.map(item => item.name).join(language === 'en' ? ', ' : '、')), '');
  // Read in passes (讲解详尽程度 标准 / 详尽): each pass under the pages it read, in page order; a body written before levels existed has no parts.
  for (const part of body?.parts || []) {
    lines.push(`**${partHeading(part, language, partsNamed(body.parts))}**`, '');
    if (part.points.length) lines.push(...part.points.map(point => `- ${point}`), '');
    if (part.explain) lines.push(part.explain, '');
    if (part.example) lines.push(`*${words.example}*${words.sep}${part.example}`, '');
  }
  if (body?.extra?.length) lines.push(`**${words.extra}**`, '', ...body.extra.map(item => `- ${item}`), '');
  for (const text of [notes?.bridge?.out, notes?.bridge?.wrap].filter(Boolean)) lines.push(`*${text}*`, '');
  if (body?.cites?.length) lines.push(`**${words.cites}**`, '', ...body.cites.map(cite => `[^${cite.n}]: [${words.quote(oneLine(cite.quote, 200))}](${bookLinks.source(cite.sourceId)})${cite.title ? ` · ${oneLine(cite.title, 120)}` : ''}`), '');
  lines.push(`[${words.practice(CHUNK)}${words.sep}${name}](${bookLinks.practice(hid)}) · [${words.qa}${words.sep}${name}](${bookLinks.qa(hid)})`);
  return lines.join('\n').trim();
}

/** The manifest of a new outline, keeping what can be kept of the old one: lib/course-book-remap.js. */
export { remapManifest } from './course-book-remap.js';

const leavesOf = nodes => (nodes || []).flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));
export const recordOf = (state, course) => (state.sources || []).find(source => isCourseBookDocSource(source) && source.bookDoc.course === course && !source.archived) ?? null;
export const courseOf = (state, args) => {
  const course = args.course === undefined ? currentCourse(state) : args.course;
  if (course !== null && typeof course !== 'string') throw new Error('course.book.open: course must be a course name or an empty string (uncategorised)');
  return course === '*' ? null : course;
};

/** course.book.revision { course? } -> { course, revision }: the book's revision alone (null without a book), read only. The book page asks it when it comes
    back into view and reads course.book.open again only when it moved (a save, an AI block, a write of the main chat all move it). */
export function bookRevision(state, args = {}) {
  const course = courseOf(state, args), record = course === null || course === undefined ? null : recordOf(state, course);
  return { course: course ?? null, revision: record ? record.bookDoc.revision : null };
}

/** course.book.open (see the top of this file). `write: false` works on a copy (the state may be the store's frozen view); `questions`: how many of a
    point's questions the answer lists (the export takes them all). M6: `answerCards` and `caseTypes` (lib/course-book-cards.js) for the 查找页. */
export function openCourseBook(state, args = {}, { write = true, questions: shown = QUESTIONS_SHOWN } = {}) {
  const course = courseOf(state, args);
  if (course === null || course === undefined) return { status: 'empty', course: null, reason: 'no-course' };
  const outline = currentCourseOutline(state.sources, course);
  if (!outline) return { status: 'empty', course, reason: 'no-outline' };
  const { index, rowOf, entriesOf } = courseRowsOf(state, course);
  const notes = courseNotesOf(state, index.allDocuments, outline), byId = new Map((state.sources || []).map(source => [source.id, source]));
  const language = notes?.record.courseNotes.language || (args.language === 'en' || args.uiLanguage === 'en' ? 'en' : 'zh'), words = wordsOf(language);
  const existing = recordOf(state, course), now = new Date().toISOString();
  let changed = false;
  const replaced = [];
  // A working copy: the record is written back only when something changed (and only with `write`).
  const record = existing ? { ...existing, bookDoc: structuredClone(existing.bookDoc) }
    // `text` is a one-line notice: an older release that lists the record as a material shows what it is instead of an empty material.
    : { id: docId(course), title: `${words.book} · ${course || '—'}`, text: words.notice, format: 'md', courses: course ? [course] : [], provenance: COURSE_BOOK_DOC_PROVENANCE, createdAt: now,
      bookDoc: { version: BOOK_FILES_VERSION, course, language, outlineId: null, revision: 0, updatedAt: now, nextId: 1, manifest: { nodes: [] }, files: { [UNPLACED]: { text: '', version: 1 } } } };
  if (!existing) changed = true;
  const doc = record.bookDoc;
  if (doc.outlineId !== outline.id) {
    // Leaves are matched by the pages their anchors hold (spans of an outline built from the inventory, chapters and documents of an older one), then items, then titles.
    const docs = documentIndex(index.allDocuments);
    // Matched against the outline's own titles; the learner's titles (course.book.rename) stay on the points that keep their id (lib/course-book-own-titles.js).
    const remapped = keepOwnTitles(doc, remapManifest(outlineTitled(doc.manifest, doc.ownTitles), outline.courseOutline.nodes, doc.nextId, { sourcesOf: anchor => anchorSources(docs, anchor, id => byId.get(id)?.text?.length) }));
    const files = { [UNPLACED]: doc.files[UNPLACED] || { text: '', version: 1 } };
    for (const [from, to] of remapped.moved) for (const name of [genFile, mineFile, qaFile]) if (doc.files[name(from)]) files[name(to)] = doc.files[name(from)];
    // An old point folded into a new one that another old point already went to: its own text joins the new point's files under its old title.
    const oldNodes = new Map(leavesOf(doc.manifest.nodes).map(node => [node.id, node]));
    let folds = 1;
    for (const [from, to] of remapped.folded) {
      const title = `### ${oneLine(oldNodes.get(from)?.title, 120)}`, fold = folds++;
      // Its footnotes renamed (they would collide with the point's own [^1]), its 练 / 问答 links of the old heading left out (that heading is gone).
      const oldHid = oldNodes.get(from)?.hid, gone = oldHid ? [bookLinks.practice(oldHid).split('&')[0], bookLinks.qa(oldHid)] : [];
      const tidy = text => String(text).split('\n').filter(lineText => !gone.some(link => lineText.includes(link))).join('\n')
        .replace(/\[\^([\w-]{1,40})\]/g, (_, label) => `[^${label}-f${fold}]`);
      const join = (name, text) => { if (!String(text ?? '').trim()) return; const own = files[name(to)] || { text: '', version: 1 };
        files[name(to)] = { ...own, text: [String(own.text ?? '').trim(), `${title}\n\n${tidy(text).trim()}`].filter(Boolean).join('\n\n'), version: own.version + 1 }; };
      join(mineFile, [doc.files[genFile(from)]?.forked ? doc.files[genFile(from)].text : '', doc.files[mineFile(from)]?.text].filter(text => String(text ?? '').trim()).join('\n\n'));
      join(qaFile, doc.files[qaFile(from)]?.text);
    }
    // What has no point any more goes to 未归位 with the point's title: the learner's file, and a generated file the learner changed. Nothing is deleted.
    const kept = remapped.lost.flatMap(node => {
      const parts = [doc.files[genFile(node.id)]?.forked ? doc.files[genFile(node.id)].text : '', doc.files[mineFile(node.id)]?.text, doc.files[qaFile(node.id)]?.text].filter(text => String(text ?? '').trim());
      return parts.length ? [`### ${oneLine(node.title, 120)}（${words.gone}）`, '', ...parts.map(text => text.trim()), ''] : [];
    });
    if (kept.length) files[UNPLACED] = { text: [files[UNPLACED].text.trim(), kept.join('\n').trim()].filter(Boolean).join('\n\n'), version: files[UNPLACED].version + 1 };
    // What moved to another name, said once on the book page (old title -> new title).
    const newTitle = new Map(leavesOf(remapped.nodes).map(node => [node.id, node.title])), moves = [];
    for (const [from, to] of [...remapped.moved, ...remapped.folded]) {
      const before = oldNodes.get(from)?.title, after = newTitle.get(to);
      if (before && after && oneLine(before, 200).toLowerCase() !== oneLine(after, 200).toLowerCase()) moves.push({ from: oneLine(before, 120), to: oneLine(after, 120), folded: remapped.folded.has(from) });
    }
    Object.assign(doc, { manifest: { nodes: remapped.nodes }, files, outlineId: outline.id, nextId: remapped.next, ...(moves.length ? { lastMoves: { at: now, list: moves.slice(0, 200) } } : {}) });
    changed = true;
  }
  const asked = new Map();
  const questionsOf = node => {
    if (!asked.has(node.id)) { const row = rowOf(bookKey(node.id)); asked.set(node.id, row ? entriesOf(row).sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]) : []); }
    return asked.get(node.id);
  };
  for (const leaf of leavesOf(doc.manifest.nodes)) {
    const text = genText({ notes: leafNotes(notes, leaf.id, byId), hid: leaf.hid, title: leaf.title, language: doc.language || language });
    const file = doc.files[genFile(leaf.id)];
    if (!file) { doc.files[genFile(leaf.id)] = { text, version: 1, forked: false, generated: text }; changed = true; }
    else if (!file.forked) {
      if (file.text !== text) { replaced.push({ file: genFile(leaf.id), version: file.version, text: file.text }); Object.assign(file, { text, generated: text, version: file.version + 1 }); changed = true; }
    } else if ((file.generated ?? file.text) !== text) {
      // Forked: the learner's text stays; the new generated text is offered, unless the learner set this very text aside.
      file.generated = text;
      offerSuggestion(file, text, 'generated');
      changed = true;
    }
    if (!doc.files[mineFile(leaf.id)]) { doc.files[mineFile(leaf.id)] = { text: '', version: 1 }; changed = true; }
  }
  if (changed) {
    Object.assign(doc, { revision: doc.revision + 1, updatedAt: now });
    if (write && existing) Object.assign(existing, { bookDoc: doc, text: existing.text || words.notice });
    else if (write) state.sources.push(record);
  }
  const leafView = node => {
    const questions = questionsOf(node);
    const qa = doc.files[qaFile(node.id)];
    return { gen: doc.files[genFile(node.id)]?.text ?? '', mine: doc.files[mineFile(node.id)]?.text ?? '', qa: qa?.text ?? '', ...(node.movedFrom ? { movedFrom: node.movedFrom } : {}),
      files: { gen: genFile(node.id), mine: mineFile(node.id), ...(qa ? { qa: qaFile(node.id) } : {}) }, questionTotal: questions.length,
      questions: questions.slice(0, shown).map(entry => ({ deckId: entry.deckId, cardId: entry.cardId, prompt: entry.prompt })) };
  };
  const view = (list, prefix, depth) => (list || []).map((node, at) => {
    const number = `${prefix}${at + 1}`;
    return { hid: node.hid, key: bookKey(node.id), title: node.title, number, depth, leaf: node.leaf,
      ...(node.leaf ? leafView(node) : {}),
      children: view(node.children, `${number}.`, depth + 1) };
  });
  // The questions the files link to that are gone (deleted, slain, suspended, in an archived deck): the page says so in their place (I5).
  const live = new Set((state.decks || []).filter(deck => !deck.archived).flatMap(deck => (deck.cards || []).filter(card => card && !card.suspended).map(card => `${deck.id}|${card.id}`)));
  const missing = new Set();
  for (const file of Object.values(doc.files)) for (const match of String(file.text ?? '').matchAll(/\]\((studyhub:\/\/card\/[^)\s]+)\)/g)) {
    const link = parseBookLink(match[1]);
    if (link && !live.has(`${link.deckId}|${link.cardId}`)) missing.add(`${link.deckId}|${link.cardId}`);
  }
  const { answerCards, caseTypes } = bookCardsOf(state, { course, leaves: leavesOf(doc.manifest.nodes), files: doc.files, questionsOf,
    fileNames: list => [...list.flatMap(leaf => [genFile, mineFile, qaFile].map(name => ({ hid: leaf.hid, name: name(leaf.id) }))), { hid: 'unplaced', name: UNPLACED }] });
  // The glossary (生词与概念) the build made from the inventory items the book covers: each entry with the heading of the point that explains it.
  const hidOf = new Map(leavesOf(doc.manifest.nodes).map(leaf => [leaf.id, leaf.hid]));
  const glossary = (notes?.record.courseNotes.glossary || []).filter(entry => hidOf.has(entry.leaf)).map(entry => ({ term: entry.name, gist: entry.gist, kind: entry.kind,
    hid: hidOf.get(entry.leaf), material: entry.material, ...(Number.isInteger(entry.page) ? { page: entry.page } : {}) }));
  return { status: 'ok', course, revision: doc.revision, structureVersion: structureVersionOf(doc), title: record.title, language: doc.language || language, notes: !!notes, papers: (outline.courseOutline.papers || []).length, glossary, ...(doc.lastMoves ? { moves: doc.lastMoves } : {}),
    // The book's coverage at three levels (materials and pages read, points complete, concepts covered), when the quality workflow wrote it.
    ...(notes?.record.courseNotes.coverage ? { coverage: notes.record.courseNotes.coverage } : {}),
    nodes: view(doc.manifest.nodes, '', 1), unplaced: { title: words.unplaced, text: doc.files[UNPLACED]?.text ?? '', file: UNPLACED }, missing: [...missing], changed, replaced,
    answerCards, caseTypes,
    files: Object.fromEntries(Object.entries(doc.files).map(([name, file]) => [name, { version: file.version, forked: !!file.forked, suggestions: suggestionsOf(file) }])) };
}
