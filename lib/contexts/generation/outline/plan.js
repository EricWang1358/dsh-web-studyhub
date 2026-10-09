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
  // A rebuild that names no papers keeps the ones the outline it replaces rested on (those still in the course); `papers: []` drops them.
  const previous = replaced ? (state.sources.find(source => source.id === replaced)?.courseOutline?.papers || []).map(paper => paper.key) : [];
  const explicit = Array.isArray(request.papers);
  const described = describeCourse(state, course, { papers: explicit ? request.papers : previous });
  if (!described.documents.length) throw refuse('course-outline-no-materials', language);
  const asked = explicit ? request.papers : previous.filter(key => described.documents.some(item => item.key === key));
  const { papers, chunks } = papersOf(state, described.documents, asked, language);
  const batches = batchesOf(described.descriptors);
  const fingerprint = materialsFingerprint(described.documents);
  // The answers kept for a retry are the answers to THIS plan: the same materials, papers and language.
  const planKey = digest([fingerprint, language, course, batches.map(batch => batch.key), chunks.map(chunk => chunk.key), described.syllabus?.text ?? '']);
  return { course, language, title: outlineTitle(language, course), ...(replaced ? { supersedes: replaced } : {}), described, batches, papers, paperChunks: chunks,
    syllabus: described.syllabus, fingerprint, planKey, steps: batches.length + 1 + chunks.length, scopeHash: digest([course, fingerprint, papers.map(paper => paper.key)]) };
}

/** An outline's nodes as a papers-only build starts from them: the same ids, titles and anchors, no paper places. */
const unmarked = nodes => nodes.map(({ exam: _exam, ...node }) => (node.children ? { ...node, children: unmarked(node.children) } : node));

/**
 * Stage 0 of a papers-only build: the course's current outline keeps its chapters, sections and knowledge points (the same node ids, no map or reduce call);
 * only the sample papers mark its leaves again (a call per chunk of paper), and the result replaces it. `papers` names them (`[]`: none); omitted, the outline's own.
 * Its `base` is what the job starts from instead of map and reduce.
 */
export function planPapersOnly(state, request = {}) {
  const language = request.language === 'en' ? 'en' : 'zh', course = request.course;
  if (typeof course !== 'string' || course === '*') throw refuse('course-outline-no-course', language);
  const current = currentCourseOutline(state.sources, course);
  if (!current) throw refuse('course-outline-no-outline', language);
  const outline = current.courseOutline, asked = Array.isArray(request.papers) ? request.papers : (outline.papers || []).map(paper => paper.key);
  const described = describeCourse(state, course, { papers: asked });
  const { papers, chunks } = papersOf(state, described.documents, asked, language);
  const planKey = digest(['papers', current.id, language, chunks.map(chunk => chunk.key)]);
  return { course, language, title: current.title, supersedes: current.id, described, batches: [], papers, paperChunks: chunks, syllabus: null,
    fingerprint: outline.fingerprint, planKey, steps: chunks.length, scopeHash: digest([course, current.id, papers.map(paper => paper.key), 'papers']),
    base: { nodes: unmarked(outline.nodes), other: outline.other, orderBasis: outline.orderBasis, counts: { ...outline.counts, invalid: 0, merged: 0 } } };
}
