import { createHash } from 'node:crypto';
import { OUTLINE_GRANULARITIES, OUTLINE_LIMITS, currentCourseOutline, isCourseOutlineSource, materialsFingerprint, outlineShape } from '../../../course-outline-book.js';
import { inputFingerprint, isLibraryListSource } from '../../../exam-point-list.js';
import { displayTitle } from '../../../document-title.js';
import { BATCH_CHARS, PAPER_CHUNK_CHARS, cutSalt } from './constants.js';
import { describeCourse } from './describe.js';
import { MAX_PAPERS, choosePapers, paperKeys, paperProblem } from './papers.js';
import { planInventory } from '../inventory/plan.js';
import { effortsOf } from '../inventory/policy.js';
import { REFUSALS, outlineTitle } from './jobs/messages.js';

export { nameHints, describeCourse } from './describe.js';

/* The plan of one course outline build, pure: no model, no library write, no clock. Stage 0 (`planOutline`) turns a request and the library into the
   descriptors of the course's materials in batches (the map calls), the key of the reduce call and the chunks of the chosen sample papers, or refuses with
   a code (in the learner's words) before any model call. It needs no cap on the number of materials: the model is shown descriptors, never their texts. */

const refuse = (code, language, detail) => Object.assign(new Error(REFUSALS[code](language, detail)), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const short = value => createHash('sha1').update(String(value)).digest('hex').slice(0, 12);

/** Every option a `generation.courseOutline.build` request may carry: the plan reads them below, and start.js reads `papersOnly`, `confirm` and `estimate`
    before the plan. The contract of the op declares exactly these (contracts.js), so a parameter the build accepts is also discoverable (#462). */
export const OUTLINE_BUILD_OPTIONS = Object.freeze(['course', 'supersedes', 'language', 'papers', 'papersBy', 'papersOnly', 'inventory', 'concurrency',
  'granularity', 'maxPoints', 'minBodyChars', 'confirm', 'estimate']);

/** The text a knowledge point's warning reads when the request names no `minBodyChars`: 200 characters; 0 turns the warning off (#462). */
export const DEFAULT_MIN_BODY_CHARS = 200;

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

/** The descriptors of the chosen papers say so (the map call groups them as exam review, not as teaching). */
function tagPapers(described, keys) {
  const chosen = new Set(keys);
  for (const item of described.descriptors) if (item.role !== 'syllabus' && described.aliases.get(item.id).some(key => chosen.has(key))) item.role = 'sample paper';
}

/** The chosen sample papers: documents of the course, read in chunks. An id may name a document or any of its pages (papers.js paperKeys). A paper the
    learner chose with no text is refused; one only recognised by name (`by: 'auto'`) is left out and noted (`skipped`): it must not stop the course. */
function papersOf(state, course, documents, asked, language, by = 'learner', { saved = false } = {}) {
  const byId = new Map((state.sources || []).map(source => [source.id, source]));
  if (!Array.isArray(asked)) return { papers: [], chunks: [], skipped: [] };
  // An id that names no material of the course is refused first, for what it is; only then are the materials counted (the limit counts nothing else).
  const keys = paperKeys(documents, asked), byKey = new Map(documents.map(document => [document.key, document]));
  const stray = keys.findIndex(key => !byKey.has(key));
  if (stray >= 0) throw refuse('course-outline-paper-invalid', language, paperProblem(state, keys[stray], course, { saved }));
  if (keys.length > MAX_PAPERS) throw refuse('course-outline-paper-invalid', language, { count: keys.length });
  const papers = [], chunks = [], skipped = [];
  for (const key of keys) {
    const item = byKey.get(key);
    const sources = item.sourceIds.map(id => byId.get(id)).filter(source => source && !isLibraryListSource(source) && String(source.text ?? '').trim());
    if (!sources.length && by === 'auto') { skipped.push({ key, title: displayTitle(item.title) }); continue; }
    if (!sources.length) throw refuse('course-outline-no-readable-text', language, { id: key, title: displayTitle(item.title) || key });
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
  return { papers, chunks, skipped };
}

/** The cut of a build (#462): `granularity` and `maxPoints` as asked (null removes one), else the outline's it replaces; a value out of range is refused
    naming the field. -> { granularity?, maxPoints? } */
function shapeOf(request, previous, language) {
  const asked = key => Object.prototype.hasOwnProperty.call(request, key) && request[key] !== undefined;
  const shape = { ...outlineShape(previous?.shape) };
  if (asked('granularity')) {
    if (request.granularity !== null && !OUTLINE_GRANULARITIES.includes(request.granularity))
      throw refuse('course-outline-shape-invalid', language, { field: 'granularity', value: request.granularity });
    if (request.granularity === null) delete shape.granularity; else shape.granularity = request.granularity;
  }
  if (asked('maxPoints')) {
    const value = request.maxPoints, ok = Number.isInteger(value) && value >= 1 && value <= OUTLINE_LIMITS.nodes;
    if (value !== null && !ok) throw refuse('course-outline-shape-invalid', language, { field: 'maxPoints', value, max: OUTLINE_LIMITS.nodes });
    if (value === null) delete shape.maxPoints; else shape.maxPoints = value;
  }
  return shape;
}

/** The threshold under which the build reports the text of its knowledge points (#462): the request's whole number of characters (0 turns the report off), else
    the default; anything else is refused naming the field. */
function minBodyOf(request, language) {
  if (!Object.prototype.hasOwnProperty.call(request, 'minBodyChars') || request.minBodyChars === undefined) return DEFAULT_MIN_BODY_CHARS;
  const value = request.minBodyChars;
  if (!Number.isInteger(value) || value < 0 || value > OUTLINE_LIMITS.introChars)
    throw refuse('course-outline-shape-invalid', language, { field: 'minBodyChars', value, max: OUTLINE_LIMITS.introChars });
  return value;
}

/**
 * Stage 0. Throws an Error with a `code` and spends nothing; otherwise the plan of the build.
 * @param request { course, language?, papers?: [document key, document id or page id], supersedes? }  `supersedes` defaults to the course's current outline (a rebuild replaces it).
 */
export function planOutline(state, request = {}) {
  const language = request.language === 'en' ? 'en' : 'zh';
  const course = request.course;
  if (typeof course !== 'string' || course === '*') throw refuse('course-outline-no-course', language);
  const replaced = request.supersedes ?? currentCourseOutline(state.sources, course)?.id ?? null;
  if (replaced !== null && !(typeof replaced === 'string' && (state.sources || []).some(source => source.id === replaced && isCourseOutlineSource(source))))
    throw refuse('course-outline-supersedes-invalid', language);
  // The sample papers: the learner's (asked now, or chosen for the outline this one replaces), else the ones recognised by name (outline/papers.js).
  const described = describeCourse(state, course);
  if (!described.documents.length) throw refuse('course-outline-no-materials', language);
  const previous = replaced ? state.sources.find(source => source.id === replaced)?.courseOutline ?? null : null;
  const shape = shapeOf(request, previous, language);
  const chosen = choosePapers(described.documents, { asked: Array.isArray(request.papers) ? request.papers : null, outline: previous });
  tagPapers(described, chosen.keys);
  const papersBy = request.papersBy ?? chosen.by;
  const { papers, chunks, skipped } = papersOf(state, course, described.documents, chosen.keys, language, papersBy);
  const batches = batchesOf(described.descriptors);
  const fingerprint = materialsFingerprint(described.documents);
  // A granularity other than the default asks the map calls again (their keys change); the default one keeps them.
  if (cutSalt(shape.granularity, 'perBatch').length) batches.forEach(batch => { batch.key = `${batch.key}:${shape.granularity}`; });
  // The 清点 runs first (inventory/plan.js): every page range of every material but the papers; an unchanged range is not asked again.
  const inventory = request.inventory === false ? null : planInventory(state, described.documents, { course, language, papers: new Set(papers.map(paper => paper.key)) });
  // The answers kept for a retry are the answers to THIS plan: the same materials, papers and language.
  const planKey = digest([fingerprint, language, course, batches.map(batch => batch.key), chunks.map(chunk => chunk.key), described.syllabus?.text ?? '',
    inventory?.calls.map(call => call.key) ?? null, ...(Object.keys(shape).length ? [shape] : [])]);
  return { course, language, title: outlineTitle(language, course), ...(replaced ? { supersedes: replaced } : {}), described, batches, papers,
    papersBy, papersSkipped: skipped, paperChunks: chunks, syllabus: described.syllabus, fingerprint, planKey, inventory, efforts: effortsOf(state.settings),
    concurrency: request.concurrency, shape, ...shape,
    // The warning a build reads its own knowledge points' text by (#462): a report only, so it changes no prompt, no call and no planKey.
    minBodyChars: minBodyOf(request, language),
    steps: batches.length + 1 + chunks.length + (inventory?.steps ?? 0), scopeHash: digest([course, fingerprint, papers.map(paper => paper.key)]) };
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
  const outline = current.courseOutline, described = describeCourse(state, course);
  const asked = paperKeys(described.documents, Array.isArray(request.papers) ? request.papers : (outline.papers || []).map(paper => paper.key));
  tagPapers(described, asked);
  const papersBy = request.papersBy ?? (Array.isArray(request.papers) ? 'learner' : outline.papersBy);
  const saved = !Array.isArray(request.papers);
  const { papers, chunks, skipped } = papersOf(state, course, described.documents, asked, language, papersBy ?? 'learner', { saved });
  const planKey = digest(['papers', current.id, language, chunks.map(chunk => chunk.key)]);
  const shape = outlineShape(outline.shape);
  return { course, language, title: current.title, supersedes: current.id, described, batches: [], papers, ...(papersBy ? { papersBy } : {}), papersSkipped: skipped, shape,
    minBodyChars: minBodyOf(request, language), paperChunks: chunks, syllabus: null,
    fingerprint: outline.fingerprint, planKey, steps: chunks.length, scopeHash: digest([course, current.id, papers.map(paper => paper.key), 'papers']),
    base: { nodes: unmarked(outline.nodes), other: outline.other, orderBasis: outline.orderBasis, counts: { ...outline.counts, invalid: 0, merged: 0 },
      ...(outline.from ? { from: outline.from } : {}), ...(outline.inventoryPrint ? { inventoryPrint: outline.inventoryPrint } : {}), ...(outline.minReader ? { minReader: outline.minReader } : {}) } };
}
