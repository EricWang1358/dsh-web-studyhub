/* 「加入复习全书」 (M3, docs/plans/review-book.md): a follow-up kept on a card (card.followups, which stay as they are, the card's own record) put into the
   course's book, or taken out again. Mutations of the state, no I/O; the ops run them in the book's writer queue (lib/contexts/library/operations.js),
   one store transaction each, the text they replace into the version history. Nothing here runs by itself: the learner presses the button, or the
   practice page calls the same op when the learner chose 自动加入 (no backend hook).

   book.qa.add { course?, deckId?, cardId, followupId } -> { status: 'added' | 'unchanged', course, file, before }
     The block (lib/course-book-qa-text.js) goes into the point's Q&A file `<leaf>.qa.md` (made on the first add), the point being the knowledge point
     whose anchors hold the card; a card of no point goes to 未归位. When nothing under the point links the card yet, its link is written at the top of the
     Q&A file first and the block under it. Once per follow-up id: adding again changes nothing. The course is the card's deck's unless given.
   book.qa.remove { course?, followupId } -> { status: 'removed' | 'unchanged', removed: [{ file, before }] }: only that block, from the files that hold it.
   book.qa.list { course? } -> { followupIds, answerCardIds }: what the books hold, so a Q&A says 已加入 · 撤回.

   The 分析题答案卡 of a case question (M5) the same way: book.qa.add { cardId, deckId?, answerCard: true } puts the card's rendered Markdown
   (lib/answer-card.js renderAnswerCard) into the point's Q&A file once per question, under its link; book.qa.remove { cardId, answerCard: true }
   takes it out. A card without an answer card is refused (book-qa-no-card). */
import { currentCourse } from './focus.js';
import { courseRowsOf } from './course-outline.js';
import { bookKey } from './course-outline-book-view.js';
import { genFile, mineFile, openCourseBook, qaFile, recordOf, UNPLACED } from './course-book-files.js';
import { isCourseBookDocSource } from './exam-point-list.js';
import { bookLinks } from './course-book-links.js';
import { answerCardBlock, cardBlocks, holdsAnswerCard, holdsFollowup, linksCard, placeBlock, qaBlock, qaBlocks, removeBlock, removeCardBlock } from './course-book-qa-text.js';
import { renderAnswerCard } from './answer-card.js';

const fail = (message, code) => { throw Object.assign(new Error(message), { code }); };
const oneLine = (value, max = 160) => { const text = String(value ?? '').replace(/\{\{[^{}]+\}\}/g, '＿＿').replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; };
const touch = doc => Object.assign(doc, { revision: doc.revision + 1, updatedAt: new Date().toISOString() });
const books = state => (state.sources || []).filter(source => isCourseBookDocSource(source) && !source.archived);
const leavesOf = nodes => (nodes || []).flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));

/** The knowledge point (a manifest leaf) whose anchors' rows hold the card, or null. */
function leafOfCard(state, course, doc, ref) {
  const { rowOf, entriesOf } = courseRowsOf(state, course);
  return leavesOf(doc.manifest.nodes).find(leaf => { const row = rowOf(bookKey(leaf.id)); return row && entriesOf(row).some(entry => entry.deckId === ref.deckId && entry.cardId === ref.cardId); }) ?? null;
}

/** book.qa.add (see the top of this file). */
export function addBookQa(state, args = {}) {
  const deck = (state.decks || []).find(item => (args.deckId ? item.id === args.deckId : (item.cards || []).some(card => card?.id === args.cardId)));
  const card = deck?.cards?.find(item => item?.id === args.cardId), asCard = args.answerCard === true;
  const followup = card && !asCard ? (card.followups || []).find(item => item.id === args.followupId) : null;
  if (asCard && !card?.answerCard) fail('这道题还没有答题卡 / This question has no answer card yet', 'book-qa-no-card');
  if (!asCard && !followup) fail('找不到这条问答 / This Q&A is not there', 'book-qa-missing');
  const course = args.course !== undefined ? args.course : deck.course ?? deck.folder ?? currentCourse(state);
  if (!recordOf(state, course) && openCourseBook(state, { course }).status !== 'ok') fail('这门课还没有复习全书（先生成总纲） / This course has no review book yet (organise the outline first)', 'book-qa-no-book');
  const record = recordOf(state, course), doc = record.bookDoc;
  const holds = text => (asCard ? holdsAnswerCard(text, card.id) : holdsFollowup(text, followup.id));
  if (Object.values(doc.files).some(file => holds(file.text))) return { status: 'unchanged', course, file: null, before: null };
  const leaf = leafOfCard(state, course, doc, { deckId: deck.id, cardId: card.id }), name = leaf ? qaFile(leaf.id) : UNPLACED;
  const file = doc.files[name] || (doc.files[name] = { text: '', version: 1 });
  const before = { file: name, version: file.version, text: file.text };
  let text = file.text;
  // The question's link, when nothing under the point links it yet: at the top of the Q&A file, so the block has its question above it.
  const under = leaf ? [doc.files[genFile(leaf.id)]?.text, doc.files[mineFile(leaf.id)]?.text, text] : [text];
  if (!under.some(part => linksCard(part, card.id))) {
    const words = doc.language === 'en' ? { card: 'Practise', sep: ': ' } : { card: '练习', sep: '：' };
    text = `- [${words.card}${words.sep}${oneLine(card.prompt)}](${bookLinks.card(deck.id, card.id)})\n${text.trim() ? `\n${text.replace(/^\n+/, '')}` : ''}`;
  }
  const block = asCard ? answerCardBlock({ cardId: card.id, markdown: renderAnswerCard(card.answerCard) }, card.answerCard.language)
    : qaBlock({ cardId: card.id, followupId: followup.id, question: followup.question, answer: followup.answer }, doc.language);
  text = placeBlock(text, card.id, block);
  Object.assign(file, { text, version: file.version + 1 });
  touch(doc);
  return { status: 'added', course, file: name, before };
}

/** book.qa.remove (see the top of this file). */
export function removeBookQa(state, args = {}) {
  const asCard = args.answerCard === true, key = asCard ? args.cardId : args.followupId;
  if (typeof key !== 'string' || !key) fail(asCard ? 'cardId is required' : 'followupId is required', 'book-qa-missing');
  const removed = [];
  for (const record of books(state).filter(item => args.course === undefined || item.bookDoc.course === args.course)) {
    for (const [name, file] of Object.entries(record.bookDoc.files)) {
      const next = asCard ? removeCardBlock(file.text, key) : removeBlock(file.text, key);
      if (next === null) continue;
      removed.push({ file: name, before: { file: name, version: file.version, text: file.text }, course: record.bookDoc.course });
      Object.assign(file, { text: next, version: file.version + 1 });
      touch(record.bookDoc);
    }
  }
  return { status: removed.length ? 'removed' : 'unchanged', removed };
}

/** book.qa.list (see the top of this file; `courses`: the courses that have a book, so a page offers the button only where it can work). Read only. */
export const bookQaList = (state, args = {}) => {
  const records = books(state).filter(item => args.course === undefined || item.bookDoc.course === args.course);
  const files = records.flatMap(record => Object.values(record.bookDoc.files));
  return { followupIds: [...new Set(files.flatMap(file => qaBlocks(file.text).map(block => block.fid)))],
    answerCardIds: [...new Set(files.flatMap(file => cardBlocks(file.text).map(block => block.cardId)))], courses: records.map(record => record.bookDoc.course) };
};
