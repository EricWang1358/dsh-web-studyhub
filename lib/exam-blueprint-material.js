import { createHash } from 'node:crypto';
import { EXAM_POINT_LIST_PROVENANCE, isExamPointListSource } from './exam-point-list.js';

/* 考点清单 (exam point list; code name: exam blueprint) as a special kind of material (docs/plans/2026-10-07-1834-feat-exam-blueprint-3.1-plan.md, revision 5).

   It is an ordinary source record: `text` is the readable outline of the exam points (so the reader and citations treat it like any other Markdown material), and the structured list
   rides on the same record as `blueprint`, marked by `provenance: 'exam-blueprint'`. Older readers ignore both extra fields and show a Markdown material. Every exam point keeps the
   places it came from as material selections (sourceId, quote, offsets, revision, page: the shape of lib/contexts/materials/positions.js), so provenance is checked by the one resolver
   that checks every other citation. The lists that show the library's MATERIALS leave it out (`isExamPointListSource`); the record itself stays readable.

   Two levels: a 大考点 has no `parentId`, a 小考点 has one (never deeper). The tier of a point is computed from its places, never stated: 必学 (`must`) when at least one chosen sample
   paper reached it, 补充 (`extra`) when only the slides or the syllabus did. With no sample paper every point is 补充 and the list says so. A point a sample paper reached but the slides
   never mention is kept, and says so.

   Pure and import-light, like lib/note-material.js. Nothing here calls a model or writes a library. */

export const EXAM_BLUEPRINT_PROVENANCE = EXAM_POINT_LIST_PROVENANCE;
export const EXAM_BLUEPRINT_VERSION = 1;
/** What each material the list was built from stood for. A role is a property of the use, not of the material. */
export const BLUEPRINT_ROLES = Object.freeze(['lecture', 'syllabus', 'past-paper', 'textbook', 'answer-key']);
/** The roles that exam points come from. A list with none of them has nothing to list and is refused. */
export const PRIMARY_ROLES = Object.freeze(['lecture', 'syllabus']);
export const POINT_STATUSES = Object.freeze(['pending', 'confirmed', 'disputed']);
/** Fewer sample papers than this and no frequency is computed (a draft threshold). */
export const FREQUENCY_MIN_PAPERS = 3;
export const BLUEPRINT_LIMITS = Object.freeze({ points: 300, evidence: 12, inputs: 60, inputSources: 500, quoteChars: 400, titleChars: 200, noteChars: 600 });

const fail = message => { throw new Error(message); };
const text = (value, label, max, { required = false } = {}) => {
  const value_ = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!value_) { if (required) fail(`${label} is required`); return ''; }
  if (value_.length > max) fail(`${label} must be at most ${max} characters`);
  return value_;
};
const optionalInt = (value, label, min = 0) => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < min) fail(`${label} must be an integer of at least ${min}`);
  return value;
};

/** An input names the material by its document (every slide of a deck is a source of its own) and/or the source ids it covers. */
function normalizeInput(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) fail('An input must be an object');
  if (!BLUEPRINT_ROLES.includes(item.role)) fail(`Unknown input role: ${String(item.role).slice(0, 40)}`);
  const ids = [...(item.sourceId ? [item.sourceId] : []), ...(Array.isArray(item.sourceIds) ? item.sourceIds : [])]
    .map(id => text(id, 'Input sourceId', 200, { required: true }));
  const documentId = item.documentId ? text(item.documentId, 'Input documentId', 200) : undefined;
  if (!ids.length && !documentId) fail('An input names a documentId or sourceIds');
  if (ids.length > BLUEPRINT_LIMITS.inputSources) fail(`An input covers at most ${BLUEPRINT_LIMITS.inputSources} sources`);
  const skipped = Array.isArray(item.skippedPages) ? item.skippedPages.map(page => optionalInt(page, 'Input skippedPages entry', 1)) : [];
  return { role: item.role, ...(documentId ? { documentId } : {}), sourceIds: [...new Set(ids)],
    ...(item.title ? { title: text(item.title, 'Input title', BLUEPRINT_LIMITS.titleChars) } : {}),
    ...(item.revision ? { revision: text(item.revision, 'Input revision', 200) } : {}),
    // Pages or slides with no readable text (pictures only): reported, never filled in.
    ...(skipped.length ? { skippedPages: [...new Set(skipped)].sort((a, b) => a - b) } : {}) };
}

/** The key a sample paper is known by in `backing.papers` and `examShape`: its document, else its first source. */
export const inputKey = input => input.documentId || input.sourceIds[0];

/** The inputs an evidence place belongs to: by document, else by source id; the evidence's own role settles a source used in two roles. */
const inputsFor = (inputs, place) => inputs.filter(input => (place.documentId && input.documentId === place.documentId) || input.sourceIds.includes(place.sourceId))
  .filter(input => !place.role || input.role === place.role);

function normalizeEvidence(raw, inputs) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Exam point evidence must be an object');
  const sourceId = text(raw.sourceId, 'Evidence sourceId', 200, { required: true });
  const quote = text(raw.quote, 'Evidence quote', BLUEPRINT_LIMITS.quoteChars, { required: true });
  if (raw.role !== undefined && !BLUEPRINT_ROLES.includes(raw.role)) fail(`Unknown evidence role: ${String(raw.role).slice(0, 40)}`);
  const start = optionalInt(raw.start, 'Evidence start'), end = optionalInt(raw.end, 'Evidence end'), page = optionalInt(raw.page, 'Evidence page', 1);
  if ((start === undefined) !== (end === undefined) || (end !== undefined && end <= start)) fail('Evidence start and end must be given together, end after start');
  const place = { sourceId, quote, ...(raw.role ? { role: raw.role } : {}), ...(raw.documentId ? { documentId: text(raw.documentId, 'Evidence documentId', 200) } : {}) };
  const owners = inputsFor(inputs, place);
  if (!owners.length) fail(`Evidence names a material that is not an input: ${sourceId.slice(0, 80)}`);
  // The role is always written: it is what the point's backing is counted from.
  const role = place.role || (new Set(owners.map(input => input.role)).size === 1 ? owners[0].role : fail(`Evidence needs a role: ${sourceId.slice(0, 80)} is an input twice`));
  return { ...place, role, ...(raw.revision ? { revision: text(raw.revision, 'Evidence revision', 200) } : {}),
    ...(page !== undefined ? { page } : {}), ...(start !== undefined ? { start, end } : {}) };
}

/**
 * How a point is backed, counted from its places: slides (distinct slides or pages of the primary inputs), sample papers (distinct past-paper inputs, `papers` names them in input order).
 * `kind`: slides | sample-paper | both | none.
 */
export function pointBacking(places, inputs) {
  const slides = new Set(), reached = new Set();
  for (const place of places) {
    if (PRIMARY_ROLES.includes(place.role)) slides.add(place.sourceId);
    else if (place.role === 'past-paper') inputsFor(inputs, place).forEach(input => reached.add(input));
  }
  const papers = inputs.filter(input => reached.has(input)).map(inputKey);
  const withSlides = slides.size > 0, withPaper = papers.length > 0;
  return { slides: slides.size, samplePapers: papers.length, papers, kind: withSlides && withPaper ? 'both' : withSlides ? 'slides' : withPaper ? 'sample-paper' : 'none' };
}

/** What the list as a whole rests on, said plainly. `leaves` are the points nothing hangs under; a distribution is never claimed from fewer papers than FREQUENCY_MIN_PAPERS. */
export function blueprintBasis(inputs, leaves = []) {
  const samplePapers = inputs.filter(input => input.role === 'past-paper').length;
  const skippedSlides = inputs.filter(input => PRIMARY_ROLES.includes(input.role)).reduce((sum, input) => sum + (input.skippedPages?.length || 0), 0);
  const label = samplePapers === 0 ? '没有样卷，无法判断哪些是必学'
    : samplePapers === 1 ? '依据 1 份样卷；必学范围可能不全'
    : samplePapers < FREQUENCY_MIN_PAPERS ? `依据 ${samplePapers} 份样卷（取并集）；必学范围可能不全` : `依据 ${samplePapers} 份样卷（取并集）；样本由学生选定，不是随机样本`;
  return { samplePapers, frequency: samplePapers >= FREQUENCY_MIN_PAPERS ? 'allowed' : 'not-computed', skippedSlides,
    must: leaves.filter(point => point.tier === 'must').length, extra: leaves.filter(point => point.tier === 'extra').length,
    noCourseText: leaves.filter(point => point.backing.slides === 0).length, label };
}

/** A textbook the teacher only recommended: a note on the list, never an input, never evidence. */
function normalizeReading(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('recommendedReading must be an object');
  const url = raw.url ? text(raw.url, 'recommendedReading url', 500) : '';
  if (url && !/^https?:\/\//i.test(url)) fail('recommendedReading url must be an http or https address');
  return { title: text(raw.title, 'recommendedReading title', BLUEPRINT_LIMITS.titleChars, { required: true }),
    ...(raw.author ? { author: text(raw.author, 'recommendedReading author', BLUEPRINT_LIMITS.titleChars) } : {}),
    ...(url ? { url } : {}), ...(raw.note ? { note: text(raw.note, 'recommendedReading note', BLUEPRINT_LIMITS.noteChars) } : {}) };
}

/** What the sample papers look like: their questions (paper, label, type, marks) and the points each reaches; questions that reach no point are listed as unmatched. Describes those papers only. */
function normalizeShape(raw, pointIds, inputs) {
  if (raw === undefined || raw === null) return undefined;
  const papers = new Set(inputs.filter(item => item.role === 'past-paper').map(inputKey));
  if (!papers.size) fail('An exam shape needs a sample paper input');
  if (typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.questions) || raw.questions.length > 400) fail('examShape needs a list of at most 400 questions');
  const seen = new Set();
  const questions = raw.questions.map(item => {
    const label = text(item?.label, 'Question label', 40, { required: true });
    const paper = item.paper === undefined ? undefined : text(item.paper, 'Question paper', 200, { required: true });
    if (paper !== undefined && !papers.has(paper)) fail(`Question ${label}: ${paper.slice(0, 40)} is not a sample paper input`);
    const key = `${paper ?? ''}\u0000${label}`;
    if (seen.has(key)) fail(`Question label repeated: ${label}`);
    seen.add(key);
    if (item.marks !== undefined && !(Number.isFinite(item.marks) && item.marks >= 0)) fail(`Question ${label}: marks must be a non-negative number`);
    const reached = Array.isArray(item.pointIds) ? item.pointIds : [];
    for (const id of reached) if (!pointIds.has(id)) fail(`Question ${label}: point ${String(id).slice(0, 40)} is not in the list`);
    return { ...(paper !== undefined ? { paper } : {}), label, ...(item.type ? { type: text(item.type, 'Question type', 40) } : {}), ...(item.marks !== undefined ? { marks: item.marks } : {}), pointIds: [...new Set(reached)] };
  });
  const unmatched = (Array.isArray(raw.unmatched) ? raw.unmatched : []).map(label => text(label, 'Unmatched label', 40, { required: true }));
  return { questions, unmatched: [...new Set(unmatched)] };
}

/**
 * Check and shape the structured list. Throws a plain Error naming the first problem.
 * @param input { scope?: { label }, language?, recommendedReading?: { title, author?, url?, note? },
 *                inputs: [{ role, documentId?, sourceId?, sourceIds?, title?, revision?, skippedPages? }],
 *                points: [{ id?, title, requirement?, parentId?, status?, evidence: [selection with role?] }], examShape?, supersedes? }
 *   A point named as `parentId` by another is a 大考点 and may have no place of its own; every other point needs at least one.
 */
export function normalizeExamBlueprint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('An exam point list must be an object');
  const raw = Array.isArray(input.inputs) ? input.inputs : [];
  if (raw.length > BLUEPRINT_LIMITS.inputs) fail(`An exam point list names at most ${BLUEPRINT_LIMITS.inputs} materials`);
  const inputs = raw.map(normalizeInput);
  // The minimal valid set: something exam points can come from. No lecture slides (or syllabus) means no points: refused here, before any model call.
  if (!inputs.some(item => PRIMARY_ROLES.includes(item.role))) fail('An exam point list needs lecture slides or a syllabus to list exam points from');
  const keys = new Set();
  for (const item of inputs) {
    const key = `${item.role}\u0000${inputKey(item)}`;
    if (keys.has(key)) fail(`Input listed twice: ${inputKey(item).slice(0, 80)}`);
    keys.add(key);
  }
  const rawPoints = Array.isArray(input.points) ? input.points : [];
  if (!rawPoints.length) fail('An exam point list needs at least one exam point');
  if (rawPoints.length > BLUEPRINT_LIMITS.points) fail(`An exam point list holds at most ${BLUEPRINT_LIMITS.points} exam points`);
  const ids = new Set(), parents = new Set(rawPoints.map(entry => entry?.parentId).filter(Boolean));
  const points = rawPoints.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`Exam point ${index + 1} must be an object`);
    const id = text(entry.id ?? `p${index + 1}`, `Exam point ${index + 1} id`, 80, { required: true });
    if (ids.has(id)) fail(`Exam point id repeated: ${id}`);
    ids.add(id);
    const status = entry.status ?? 'pending';
    if (!POINT_STATUSES.includes(status)) fail(`Exam point ${id}: unknown status`);
    const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
    if (!evidence.length && !parents.has(id)) fail(`Exam point ${id} needs at least one place it came from`);
    if (evidence.length > BLUEPRINT_LIMITS.evidence) fail(`Exam point ${id} keeps at most ${BLUEPRINT_LIMITS.evidence} places`);
    const kept = evidence.map(place => normalizeEvidence(place, inputs));
    // A point comes from the slides or the syllabus, or from a sample paper that tested it (then it says the slides never mention it); never from a textbook or an answer key alone.
    if (kept.length && !kept.some(place => PRIMARY_ROLES.includes(place.role) || place.role === 'past-paper')) fail(`Exam point ${id} needs a place in the lecture slides, the syllabus or a sample paper`);
    return { id, title: text(entry.title, `Exam point ${id} title`, BLUEPRINT_LIMITS.titleChars, { required: true }),
      ...(entry.requirement ? { requirement: text(entry.requirement, `Exam point ${id} requirement`, BLUEPRINT_LIMITS.noteChars) } : {}),
      ...(entry.parentId ? { parentId: text(entry.parentId, `Exam point ${id} parentId`, 80) } : {}), status, evidence: kept };
  });
  const byId = new Map(points.map(point => [point.id, point]));
  for (const point of points) {
    if (!point.parentId) continue;
    const parent = byId.get(point.parentId);
    if (!parent) fail(`Exam point ${point.id}: parent ${point.parentId} is not in the list`);
    if (parent.parentId || parent === point) fail(`Exam point ${point.id}: at most two levels (a 大考点 has no parent)`);
  }
  const children = new Map();
  for (const point of points) if (point.parentId) children.set(point.parentId, [...(children.get(point.parentId) ?? []), point]);
  const shaped = points.map(point => {
    const places = [...point.evidence, ...(children.get(point.id) ?? []).flatMap(child => child.evidence)];
    const backing = pointBacking(places, inputs);
    // `noSlidePlace`: no place of the point (or of what hangs under it) is in the slides or the syllabus; derived from the same evidence as `backing.slides`.
    return { ...point, tier: backing.samplePapers > 0 ? 'must' : 'extra', backing, noSlidePlace: backing.slides === 0 };
  });
  const leaves = shaped.filter(point => !children.has(point.id));
  const reading = normalizeReading(input.recommendedReading), shape = normalizeShape(input.examShape, ids, inputs);
  return { version: EXAM_BLUEPRINT_VERSION, ...(input.scope?.label ? { scope: { label: text(input.scope.label, 'Scope label', BLUEPRINT_LIMITS.titleChars) } } : {}),
    ...(input.language ? { language: text(input.language, 'Language', 40) } : {}), basis: blueprintBasis(inputs, leaves), inputs, points: shaped,
    ...(reading ? { recommendedReading: reading } : {}), ...(shape ? { examShape: shape } : {}), ...(input.supersedes ? { supersedes: text(input.supersedes, 'supersedes', 200) } : {}) };
}

const ROLE_WORDS = Object.freeze({ lecture: '讲义', syllabus: '考试大纲', 'past-paper': '样卷', textbook: '教材', 'answer-key': '答案或评分说明' });
const STATUS_WORDS = Object.freeze({ pending: '待核对', confirmed: '已确认', disputed: '有争议' });
const TIER_WORDS = Object.freeze({ must: '必学', extra: '补充' });
const backingWords = backing => backing.kind === 'both' ? `讲义 ${backing.slides} 页 + 样卷 ${backing.samplePapers} 份` : backing.kind === 'slides' ? `讲义 ${backing.slides} 页` : backing.kind === 'sample-paper' ? `样卷 ${backing.samplePapers} 份` : '';

/** The readable text of a list: the outline the reader and any prompt see (大考点 with its 小考点 under it, each with its tier). */
export function examBlueprintText(title, blueprint) {
  const lines = [`# ${title}`, '', blueprint.basis.label, ''];
  if (blueprint.scope?.label) lines.push(`范围：${blueprint.scope.label}`, '');
  if (blueprint.inputs.length) lines.push('## 依据资料', '', ...blueprint.inputs.map(item => `- ${ROLE_WORDS[item.role]}：${item.title || item.documentId || item.sourceIds[0]}${item.skippedPages?.length ? `（第 ${item.skippedPages.join('、')} 页没有可读文字，未列入）` : ''}`), '');
  if (blueprint.recommendedReading) {
    const book = blueprint.recommendedReading;
    lines.push('## 推荐阅读（未导入，不作依据）', '', `- ${book.title}${book.author ? `，${book.author}` : ''}${book.url ? ` ${book.url}` : ''}${book.note ? `。${book.note}` : ''}`, '');
  }
  if (blueprint.examShape) {
    const titles = new Map(blueprint.inputs.filter(item => item.role === 'past-paper').map(item => [inputKey(item), item.title || inputKey(item)]));
    lines.push('## 样卷形态（只描述所选的样卷）', '');
    for (const question of blueprint.examShape.questions)
      lines.push(`- ${question.paper !== undefined ? `${titles.get(question.paper) ?? question.paper} ` : ''}${question.label}${question.type ? ` ${question.type}` : ''}${question.marks !== undefined ? ` ${question.marks} 分` : ''} → ${question.pointIds.length ? question.pointIds.join('、') : '没有对应考点'}`);
    lines.push('');
  }
  lines.push('## 考点', '');
  const children = new Map();
  for (const point of blueprint.points) if (point.parentId) children.set(point.parentId, [...(children.get(point.parentId) ?? []), point]);
  const write = (point, number, indent) => {
    const words = [TIER_WORDS[point.tier], STATUS_WORDS[point.status], backingWords(point.backing)].filter(Boolean).join('；');
    lines.push(`${number} [${point.id}] ${point.title}（${words}）`);
    if (point.requirement) lines.push(`${indent}要求：${point.requirement}`);
    for (const place of point.evidence) lines.push(`${indent}- 依据（${ROLE_WORDS[place.role]}${place.page ? ` 第 ${place.page} 页` : ''}）：“${place.quote}”`);
    if (point.noSlidePlace && !children.has(point.id)) lines.push(`${indent}- 课件里没找到对应内容`);
  };
  blueprint.points.filter(point => !point.parentId).forEach((point, index) => {
    write(point, `${index + 1}.`, '   ');
    (children.get(point.id) ?? []).forEach((child, at) => write(child, `${index + 1}.${at + 1}`, '      '));
  });
  return `${lines.join('\n')}\n`;
}

/**
 * A source record for the library, ready for `materials.v1 sources.ingest`. The id is a fingerprint of the content,
 * so the same list saved twice is one material and a changed list is a new one (the old stays readable).
 */
export function examBlueprintMaterial({ title, courses = [], ...input } = {}) {
  const name = text(title, 'Title', BLUEPRINT_LIMITS.titleChars, { required: true });
  if (!Array.isArray(courses) || courses.some(course => typeof course !== 'string')) fail('courses must be a list of names');
  const blueprint = normalizeExamBlueprint(input);
  const fingerprint = createHash('sha256').update(JSON.stringify([name, blueprint])).digest('hex');
  return { id: `exam-blueprint-${fingerprint.slice(0, 40)}`, title: name, text: examBlueprintText(name, blueprint), format: 'md',
    courses: [...new Set(courses.map(course => course.trim()).filter(Boolean))], provenance: EXAM_BLUEPRINT_PROVENANCE, blueprint };
}

export const isExamBlueprintSource = isExamPointListSource;
/** The name the lists use: is this record a 考点清单 (to be left out of every list of course materials, and shown by the 备考补习 page instead)? lib/exam-point-list.js is its home (browser-safe). */
export { isExamPointListSource };

/**
 * Where a list's places no longer resolve. `resolve(selection)` is the library's own resolver
 * (`resolveSelectionState(state, selection)` of lib/contexts/materials/operations.js); only `status === 'resolved'` counts.
 * @returns [{ pointId, index, sourceId, status }]
 */
export function blueprintEvidenceIssues(source, resolve) {
  if (!isExamBlueprintSource(source)) return [{ pointId: null, index: -1, sourceId: source?.id ?? null, status: 'not-a-blueprint' }];
  const issues = [];
  for (const point of source.blueprint.points || []) {
    (point.evidence || []).forEach((place, index) => {
      const answer = resolve({ sourceId: place.sourceId, quote: place.quote, ...(place.documentId ? { documentId: place.documentId } : {}),
        ...(place.revision ? { revision: place.revision } : {}), ...(place.start !== undefined ? { start: place.start, end: place.end } : {}),
        ...(place.page !== undefined ? { page: place.page } : {}) });
      if (answer?.status !== 'resolved') issues.push({ pointId: point.id, index, sourceId: place.sourceId, status: answer?.status || 'missing' });
    });
  }
  return issues;
}
