/* 备考补习: which role each material most likely has in a 考点清单 (课件, 样卷, 大纲, or none). A material nothing marks has no role (none): the learner picks
   what to use, so a long library is never all used by default. Pure and browser-safe: the create form,
   the Settings pane and the tests share it. Deliberately conservative: a lecture wrongly taken for a sample paper makes false 样卷考过 badges
   (costly), a paper that is missed only leaves every point as 补充 (cheap). So a role other than lecture needs a STRONG word in the title or
   file name AND a size that fits the role; a WEAK word only leaves a hint on the lecture row. Items are the documents of
   lib/source-groups.js; the result keeps their order and depends on nothing but the item itself and the options. */
import { bigDocuments } from './large-documents.js';

/** A sample paper is short: at most this many pages (or, when the page count is unknown, characters). */
export const PAPER_MAX_PAGES = 20;
export const PAPER_MAX_CHARS = 60000;
/** A syllabus is short too, a little longer than a paper. */
export const SYLLABUS_MAX_PAGES = 30;
export const SYLLABUS_MAX_CHARS = 100000;

/** Words that, with a short document, make it a sample paper (Latin words match whole words, case-insensitive; Chinese by substring). */
export const PAPER_WORDS = Object.freeze(['样卷', '真题', '试卷', '历年', '往年', '模拟卷', '期中', '期末', 'past paper', 'sample paper', 'exam paper',
  'midterm', 'mid-term', 'final exam', 'mock exam']);
/** Words that, with a short document, make it a syllabus. */
export const SYLLABUS_WORDS = Object.freeze(['大纲', '教学大纲', '考试大纲', '考试范围', 'syllabus', 'course outline']);
/** Words that never assign a role; they only leave hint "maybe-paper" on a lecture row. */
export const WEAK_PAPER_WORDS = Object.freeze(['paper', 'sample', 'exam', 'final', 'quiz', 'test', '试题', '习题', '卷子']);

/** Every reason code a suggestion can carry. */
export const REASON_CODES = Object.freeze(['no-signal', 'slides', 'name-paper', 'name-syllabus', 'course-guidance', 'too-big', 'not-text', 'auto-off']);

const ASCII = /^[\x00-\x7f]*$/;
const escape = word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Spaces, underscores and hyphens are one separator: "past_paper_2023.pdf" and "mid-term" read as words.
const normal = value => String(value ?? '').toLowerCase().replace(/[\s_-]+/g, ' ').trim();

/** The first of `words` the text contains (Latin words as whole words, other words anywhere), or null. */
function findWord(text, words) {
  for (const word of words) {
    const wanted = normal(word);
    if (!wanted) continue;
    if (!ASCII.test(wanted)) { if (text.includes(wanted)) return word; continue; }
    if (new RegExp(`(?<![a-z0-9])${escape(wanted)}(?![a-z0-9])`).test(text)) return word;
  }
  return null;
}

const idOf = item => item?.id ?? item?.key ?? item?.documentId ?? '';
const nameOf = item => normal(`${item?.title ?? ''} ${item?.filename ?? ''}`);
const wordsOf = value => (Array.isArray(value) ? value : []).filter(word => typeof word === 'string' && word.trim()).map(word => word.trim());

/* Pages as the learner counts them: the declared length, else (for a PDF) the pages imported. Other formats carry one source per text, not per page. */
const pagesOf = item => Math.max(Number(item?.totalPages) || 0, item?.format === 'pdf' ? item.pages?.length || 0 : 0);

function fits(item, maxPages, maxChars) {
  const pages = pagesOf(item);
  return pages > 0 ? pages <= maxPages : (Number(item?.chars) || 0) <= maxChars;
}

function isGuided(item, guidance) {
  if (!guidance.size) return false;
  return guidance.has(idOf(item)) || (Array.isArray(item?.sourceIds) && item.sourceIds.some(id => guidance.has(id)));
}

function suggestOne(item, { auto, guidance, paperWords }) {
  const id = idOf(item);
  if (item?.format === 'json') return { id, role: 'none', reason: { code: 'not-text' } };
  if (bigDocuments([item]).length) return { id, role: 'none', reason: { code: 'too-big' } };
  const slides = item?.format === 'pptx';
  // Without automatic recognition, and for a material nothing marks, the role is none: only a real signal (a slide deck, a word in the name, the course's guidance) chooses a use.
  if (!auto) return { id, role: 'none', reason: { code: 'auto-off' } };
  const lecture = slides ? { id, role: 'lecture', reason: { code: 'slides' } } : { id, role: 'none', reason: { code: 'no-signal' } };
  if (isGuided(item, guidance)) return { id, role: 'syllabus', reason: { code: 'course-guidance' } };
  const name = nameOf(item);
  // A slide deck is never a paper or (by its name alone) a syllabus; a syllabus wins when a name says both ("期末考试大纲").
  if (!slides) {
    const syllabus = findWord(name, SYLLABUS_WORDS);
    if (syllabus && fits(item, SYLLABUS_MAX_PAGES, SYLLABUS_MAX_CHARS)) return { id, role: 'syllabus', reason: { code: 'name-syllabus', word: syllabus } };
    const paper = findWord(name, [...paperWords, ...PAPER_WORDS]);
    if (paper && fits(item, PAPER_MAX_PAGES, PAPER_MAX_CHARS)) return { id, role: 'past-paper', reason: { code: 'name-paper', word: paper } };
  }
  return findWord(name, WEAK_PAPER_WORDS) ? { ...lecture, hint: 'maybe-paper' } : lecture;
}

/**
 * The likely role of each document, in the order of `items` (groupSourcesByDocument items).
 * options: { guidanceSourceIds: [ids of materials the course marks as its syllabus], paperWords: [the learner's own sample-paper words], autoRoles: true }.
 * @returns [{ id, role: 'lecture' | 'past-paper' | 'syllabus' | 'none', reason: { code, word? }, hint?: 'maybe-paper' }]
 */
export function suggestRoles(items, options = {}) {
  const settings = { auto: options?.autoRoles !== false, guidance: new Set(wordsOf(options?.guidanceSourceIds)), paperWords: wordsOf(options?.paperWords) };
  return (Array.isArray(items) ? items : []).map(item => suggestOne(item, settings));
}
