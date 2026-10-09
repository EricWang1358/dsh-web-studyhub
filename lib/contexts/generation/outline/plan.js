import { createHash } from 'node:crypto';
import { currentCourseOutline, isCourseOutlineSource, materialsFingerprint } from '../../../course-outline-book.js';
import { inputFingerprint, isLibraryListSource } from '../../../exam-point-list.js';
import { displayTitle } from '../../../document-title.js';
import { BATCH_CHARS, PAPER_CHUNK_CHARS } from './constants.js';
import { describeCourse } from './describe.js';
import { REFUSALS, outlineTitle } from './jobs/messages.js';

export { nameHints, describeCourse } from './describe.js';

/* The plan of one course outline build, pure: no model, no library write, no clock. Stage 0 (`planOutline`) turns a request and the library into the
   descriptors of the course's materials in batches (the map calls), the key of the reduce call and the chunks of the chosen sample papers, or refuses with
   a code (in the learner's words) before any model call. It needs no cap on the number of materials: the model is shown descriptors, never their texts. */

const refuse = (code, language) => Object.assign(new Error(REFUSALS[code](language)), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const short = value => createHash('sha1').update(String(value)).digest('hex').slice(0, 12);

/** Consecutive descriptors in batches of at most BATCH_CHARS characters (one descriptor longer than that is a batch of its own). */
export function batchesOf(descriptors, limit = BATCH_CHARS) {
  const batches = [];
  let current = [], size = 0;
  for (const descriptor of descriptors) {
    const length = JSON.stringify(descriptor).length;
    if (current.length && size + length > limit) { batches.push(current); current = []; size = 0; }
    current.push(descriptor); size += length;
  }
  if (current.length) batches.push(current);
  return batches.map((items, at) => ({ number: at + 1, descriptors: items, key: `co:map:${at + 1}:${short(JSON.stringify(items))}` }));
}

/** The chosen sample papers: documents of the course, read in chunks; a paper with no text is refused. */
function papersOf(state, documents, asked, language) {
  const byId = new Map((state.sources || []).map(source => [source.id, source]));
  if (!Array.isArray(asked)) return { papers: [], chunks: [] };
  if (asked.length > 20) throw refuse('course-outline-paper-invalid', language);
  const papers = [], chunks = [];
  for (const key of [...new Set(asked)]) {
    const item = documents.find(document => document.key === key);
    if (typeof key !== 'string' || !item) throw refuse('course-outline-paper-invalid', language);
    const sources = item.sourceIds.map(id => byId.get(id)).filter(source => source && !isLibraryListSource(source) && String(source.text ?? '').trim());
    if (!sources.length) throw refuse('course-outline-no-readable-text', language);
    papers.push({ key, title: displayTitle(item.title), sourceIds: sources.map(source => source.id), fingerprint: inputFingerprint(sources.map(source => source.text)) });
    let group = [];
    const flush = () => {
      if (group.length) chunks.push({ number: chunks.length + 1, paper: key, sources: group, key: `co:paper:${chunks.length + 1}:${short(group[0].id)}` });
      group = [];
    };
    for (const source of sources) {
      if (group.length && group.reduce((sum, part) => sum + part.text.length, 0) + source.text.length > PAPER_CHUNK_CHARS) flush();
      group.push({ id: source.id, text: source.text });
    }
    flush();
  }
  return { papers, chunks };
}

/**
 * Stage 0. Throws an Error with a `code` and spends nothing; otherwise the plan of the build.
 * @param request { course, language?, papers?: [document key], supersedes? }  `supersedes` defaults to the course's current outline (a rebuild replaces it).
 */
export function planOutline(state, request = {}) {
  const language = request.language === 'en' ? 'en' : 'zh';
  const course = request.course;
  if (typeof course !== 'string' || course === '*') throw refuse('course-outline-no-course', language);
  const replaced = request.supersedes ?? currentCourseOutline(state.sources, course)?.id ?? null;
  if (replaced !== null && !(typeof replaced === 'string' && (state.sources || []).some(source => source.id === replaced && isCourseOutlineSource(source))))
    throw refuse('course-outline-supersedes-invalid', language);
  const described = describeCourse(state, course, { papers: Array.isArray(request.papers) ? request.papers : [] });
  if (!described.documents.length) throw refuse('course-outline-no-materials', language);
  const { papers, chunks } = papersOf(state, described.documents, request.papers, language);
  const batches = batchesOf(described.descriptors);
  const fingerprint = materialsFingerprint(described.documents);
  // The answers kept for a retry are the answers to THIS plan: the same materials, papers and language.
  const planKey = digest([fingerprint, language, course, batches.map(batch => batch.key), chunks.map(chunk => chunk.key), described.syllabus?.text ?? '']);
  return { course, language, title: outlineTitle(language, course), ...(replaced ? { supersedes: replaced } : {}), described, batches, papers, paperChunks: chunks,
    syllabus: described.syllabus, fingerprint, planKey, steps: batches.length + 1 + chunks.length, scopeHash: digest([course, fingerprint, papers.map(paper => paper.key)]) };
}
