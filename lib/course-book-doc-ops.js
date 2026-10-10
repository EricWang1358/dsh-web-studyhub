/* The 复习全书's Markdown text as a hidden personal record of the library (lib/course-book-doc.js says what the text holds). One record a course,
   `provenance: 'course-book-doc'`: like the outline and its notes it is a reference, never a material (lib/exam-point-list.js isLibraryListSource hides it
   from every list, assertMaterials refuses it), and it is the learner's: a program write is a read-modify-write of the CURRENT saved text, here, and touches
   only its own regions (lib/course-book-doc.js).

   course.book.doc.open { course?, language? }  -> view { status: 'ok' | 'empty', course, text, revision, suggestions, notes, language, versions }
     The text with the program's regions brought up to date (mergeBook); written when that changed it, or created the first time. 'empty': no outline.
   course.book.doc.save { course?, text, revision }  -> view, plus `merged: true, conflicts` when the book changed since `revision` (compare-and-set: the
     learner's text is rebased on the saved one region by region, rebaseBook; a region both changed keeps the learner's text, the program's is a suggestion).
     Refused (course-book-doc-conflict) only when `revision` is older than the versions kept.
   course.book.doc.suggestion { course?, id, action: 'accept' | 'ignore', revision }  -> view.
   course.book.doc.undo { course?, revision }  -> view: the version before the current one comes back (as a new version, so it can be undone in turn).
   Each change keeps the text before it: the last VERSIONS_KEPT versions (the newest first in `versions`: { revision, at, by }).
   book.qa.add / book.qa.remove / book.qa.list: a Q&A kept on a card goes into the book (or out again) only when the learner says so (「加入复习全书」, or the
   page's 自动加入 setting calling the same op); the card keeps its follow-ups either way. Mutations of the state; no I/O of their own. */
import { createHash } from 'node:crypto';
import { currentCourse } from './focus.js';
import { courseRowsOf } from './course-outline.js';
import { currentCourseOutline } from './course-outline-book.js';
import { bookKey } from './course-outline-book-view.js';
import { courseNotesOf, leafNotes } from './course-book-view.js';
import { COURSE_BOOK_DOC_PROVENANCE, isCourseBookDocSource } from './exam-point-list.js';
import { acceptSuggestion, assembleBook, assignHeadingIds, genSections, insertCardLink, insertFollowup, linksCard, mergeBook, qaSections, rebaseBook, removeFollowup } from './course-book-doc.js';

export const BOOK_TEXT_MAX = 2_000_000;
export const VERSIONS_KEPT = 20;
const HISTORY_CHARS = 8_000_000;
const fail = (message, code) => { throw Object.assign(new Error(message), code ? { code } : {}); };
const docId = course => `course-book-doc-${createHash('sha256').update(JSON.stringify(['course-book-doc', course])).digest('hex').slice(0, 40)}`;
const courseOf = (state, args) => {
  const course = args.course === undefined ? currentCourse(state) : args.course;
  if (course !== null && typeof course !== 'string') fail('course.book.doc: course must be a course name or an empty string (uncategorised)');
  return course === '*' ? null : course;
};
const recordOf = (state, course) => (state.sources || []).find(source => isCourseBookDocSource(source) && source.bookDoc.course === course && !source.archived) ?? null;

/** The book as the program would write it now, or null when the course has no outline. */
export function freshBook(state, course, { language } = {}) {
  const outline = currentCourseOutline(state.sources, course);
  if (!outline) return null;
  const { index, rowOf, entriesOf } = courseRowsOf(state, course);
  const notes = courseNotesOf(state, index.allDocuments, outline), byId = new Map((state.sources || []).map(source => [source.id, source]));
  const tree = list => (list || []).map(node => ({ id: node.id, key: bookKey(node.id), title: node.title, leaf: !node.children?.length, children: tree(node.children) }));
  const questionsOf = key => { const row = rowOf(key); return row ? entriesOf(row).sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]).map(entry => ({ deckId: entry.deckId, cardId: entry.cardId, prompt: entry.prompt })) : []; };
  const lang = notes?.record.courseNotes.language || (language === 'en' ? 'en' : 'zh');
  return { text: assembleBook({ title: course || '—', nodes: tree(outline.courseOutline.nodes), notesOf: id => leafNotes(notes, id, byId), questionsOf, language: lang }), language: lang, notes: !!notes };
}

const viewOf = (record, course, fresh, suggestions) => ({ status: 'ok', course, text: record.text, revision: record.bookDoc.revision, suggestions, notes: !!fresh?.notes,
  language: record.bookDoc.language, versions: (record.bookDoc.history || []).map(({ revision, at, by }) => ({ revision, at, by })).reverse() });
/** A new version of the text: the one before it is kept (at most VERSIONS_KEPT, and not more than HISTORY_CHARS in all). `by`: 'program' | 'learner'. */
function touch(record, text, by) {
  const doc = record.bookDoc, history = [...(doc.history || []), { revision: doc.revision, text: record.text, at: doc.updatedAt, by: doc.by || 'program' }].slice(-VERSIONS_KEPT);
  while (history.length > 1 && history.reduce((sum, item) => sum + item.text.length, 0) > HISTORY_CHARS) history.shift();
  Object.assign(doc, { history, revision: doc.revision + 1, updatedAt: new Date().toISOString(), by });
  record.text = text;
}

/** course.book.doc.open (see the top of this file). */
export function openBookDoc(state, args = {}) {
  const course = courseOf(state, args);
  if (course === null || course === undefined) return { status: 'empty', course: null };
  const fresh = freshBook(state, course, args);
  if (!fresh) return { status: 'empty', course };
  let record = recordOf(state, course);
  if (!record) {
    const now = new Date().toISOString();
    const first = assignHeadingIds(fresh.text);
    record = { id: docId(course), title: `${fresh.language === 'en' ? 'Review book' : '复习全书'} · ${course || '—'}`, text: first.text, format: 'md', courses: course ? [course] : [], provenance: COURSE_BOOK_DOC_PROVENANCE,
      createdAt: now, bookDoc: { course, language: fresh.language, revision: 1, updatedAt: now, by: 'program', known: mergeBook('', fresh.text).known, ignored: {}, written: [], history: [], nextId: first.next } };
    state.sources.push(record);
    return viewOf(record, course, fresh, []);
  }
  const merged = mergeBook(record.text, fresh.text, record.bookDoc);
  if (merged.text !== record.text) touch(record, merged.text, 'program');
  if (JSON.stringify(merged.known) !== JSON.stringify(record.bookDoc.known)) record.bookDoc.known = merged.known;
  return viewOf(record, course, fresh, merged.suggestions);
}

const ownRecord = (state, args) => {
  const course = courseOf(state, args), record = course === null || course === undefined ? null : recordOf(state, course);
  if (!record) fail('这门课还没有复习全书的文本，先打开书页 / This course has no review book text yet; open the book page first', 'course-book-doc-missing');
  if (!Number.isInteger(args.revision)) fail('revision is required');
  return { course, record };
};
const conflict = () => fail('书页已在别处改过很多次，请重新打开再改 / The book changed too often elsewhere; open it again before editing', 'course-book-doc-conflict');

/** course.book.doc.save: the learner's text, as it is (markers included; a generated region changed by hand is now theirs); rebased when the book moved on. */
export function saveBookDoc(state, args = {}) {
  if (typeof args.text !== 'string' || args.text.length > BOOK_TEXT_MAX) fail(`text must be a string of at most ${BOOK_TEXT_MAX} characters`);
  const { course, record } = ownRecord(state, args);
  // A heading typed by hand gets its stable id now (never one used before: the counter only grows).
  const named = assignHeadingIds(args.text.replace(/\r\n?/g, '\n'), { next: record.bookDoc.nextId }), mine = named.text;
  record.bookDoc.nextId = named.next;
  if (args.revision === record.bookDoc.revision) {
    if (mine !== record.text) touch(record, mine, 'learner');
    return openBookDoc(state, { course });
  }
  const base = (record.bookDoc.history || []).find(item => item.revision === args.revision);
  if (!base) conflict();
  const rebased = rebaseBook(mine, base.text, record.text);
  if (rebased.text !== record.text) touch(record, rebased.text, 'learner');
  return { ...openBookDoc(state, { course }), merged: true, conflicts: rebased.conflicts };
}

/** course.book.doc.suggestion: take the program's new text of an edited region (accept), or keep the learner's and stop offering this one (ignore). */
export function bookDocSuggestion(state, args = {}) {
  if (args.action !== 'accept' && args.action !== 'ignore') fail('action must be accept or ignore');
  const { course, record } = ownRecord(state, args);
  if (args.revision !== record.bookDoc.revision) conflict();
  const fresh = freshBook(state, course), offered = fresh && mergeBook(record.text, fresh.text, record.bookDoc).suggestions.find(item => item.id === args.id);
  if (!offered) return openBookDoc(state, { course });
  if (args.action === 'accept') {
    touch(record, acceptSuggestion(record.text, fresh.text, args.id), 'learner');
    record.bookDoc.known = { ...record.bookDoc.known, [args.id]: offered.fp };
  } else record.bookDoc.ignored = { ...record.bookDoc.ignored, [args.id]: offered.fp };
  return openBookDoc(state, { course });
}

/** course.book.doc.undo: the version before the current one, back as a new version (any program write can be undone this way). */
export function undoBookDoc(state, args = {}) {
  const { course, record } = ownRecord(state, args);
  if (args.revision !== record.bookDoc.revision) conflict();
  const history = record.bookDoc.history || [], previous = history[history.length - 1];
  if (!previous) fail('没有更早的版本 / There is no earlier version', 'course-book-doc-no-version');
  const older = history.slice(0, -1);
  touch(record, previous.text, 'learner');
  // The version taken back is the current text now; undoing again goes one further back.
  record.bookDoc.history = older;
  // What the program would write now is set aside for the regions taken back, so opening the book does not write it again (a newer text of it would be).
  const fresh = freshBook(state, course), ignored = { ...record.bookDoc.ignored };
  for (const section of fresh ? genSections(fresh.text) : []) { const mine = genSections(record.text).find(item => item.id === section.id); if (mine && mine.fp !== section.fp) ignored[section.id] = section.fp; }
  record.bookDoc.ignored = ignored;
  return openBookDoc(state, { course });
}

const books = state => (state.sources || []).filter(source => isCourseBookDocSource(source) && !source.archived);

/** The knowledge point of the outline that holds a card (its anchors' rows hold the card), as a bk: key, or null. */
function leafOfCard(state, course, ref) {
  const outline = currentCourseOutline(state.sources, course);
  if (!outline) return null;
  const { rowOf, entriesOf } = courseRowsOf(state, course), leaves = [];
  const walk = list => (list || []).forEach(node => (node.children?.length ? walk(node.children) : leaves.push(bookKey(node.id))));
  walk(outline.courseOutline.nodes);
  return leaves.find(key => { const row = rowOf(key); return row && entriesOf(row).some(entry => entry.deckId === ref.deckId && entry.cardId === ref.cardId); }) ?? null;
}

/**
 * book.qa.add { deckId, cardId, followupId, course? }: a Q&A kept on a card (card.followups, which stay as they are) into the course's book, under the card's
 * link; when the book has no link to the card yet, the link is written first under the card's knowledge point (else under 「未归位」). Once per follow-up:
 * adding again changes nothing. The course is the card's deck's unless given. -> { status: 'added' | 'unchanged', course, revision }.
 */
export function addBookQa(state, args = {}) {
  const deck = (state.decks || []).find(item => item.id === args.deckId), card = deck?.cards?.find(item => item?.id === args.cardId);
  const followup = card ? (card.followups || []).find(item => item.id === args.followupId) : null;
  if (!followup) fail('找不到这条问答 / This Q&A is not there', 'book-qa-missing');
  const course = args.course !== undefined ? args.course : deck.course ?? deck.folder ?? currentCourse(state);
  if (!recordOf(state, course) && openBookDoc(state, { course }).status !== 'ok') fail('这门课还没有复习全书（先生成总纲） / This course has no review book yet (organise the outline first)', 'book-qa-no-book');
  const record = recordOf(state, course);
  if (record.text.includes(`fid=${followup.id} -->`)) return { status: 'unchanged', course, revision: record.bookDoc.revision };
  const ref = { deckId: deck.id, cardId: card.id, followupId: followup.id };
  let text = record.text;
  if (!linksCard(text, card.id)) text = insertCardLink(text, { node: leafOfCard(state, course, ref), deckId: deck.id, cardId: card.id, prompt: card.prompt }, record.bookDoc);
  touch(record, insertFollowup(text, { cardId: card.id, followupId: followup.id, question: followup.question, answer: followup.answer }, record.bookDoc), 'learner');
  return { status: 'added', course, revision: record.bookDoc.revision };
}

/** book.qa.remove { followupId }: the Q&A taken out of every book that holds it (only its region; the card keeps it). -> { status: 'removed' | 'unchanged', removed }. */
export function removeBookQa(state, args = {}) {
  let removed = 0;
  for (const record of books(state)) { const next = removeFollowup(record.text, args.followupId); if (next !== null) { touch(record, next, 'learner'); removed += 1; } }
  return { status: removed ? 'removed' : 'unchanged', removed };
}

/** book.qa.list {}: the follow-up ids the books hold, so a Q&A shows 「已加入 · 撤回」. Read only. */
export const bookQaList = state => ({ followupIds: [...new Set(books(state).flatMap(record => qaSections(record.text).map(item => item.fid)))] });
