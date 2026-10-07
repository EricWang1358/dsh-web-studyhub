import { createHash } from 'node:crypto';

/* 考试蓝图 (exam blueprint) as a special kind of material (docs/plans/2026-10-07-1834-feat-exam-blueprint-3.1-plan.md).

   It is an ordinary source record: `text` is the readable list of exam points (so the reader, the 资料 list, citations and every
   picker treat it like any other Markdown material), and the structured list rides on the same record as `blueprint`, marked by
   `provenance: 'exam-blueprint'`. Older readers ignore both extra fields and show a Markdown material. Every exam point keeps the
   places it came from as material selections (sourceId, quote, offsets, revision: the shape of lib/contexts/materials/positions.js),
   so provenance is checked by the one resolver that checks every other citation.

   Pure and import-light, like lib/note-material.js. Nothing here calls a model or writes a library. */

export const EXAM_BLUEPRINT_PROVENANCE = 'exam-blueprint';
export const EXAM_BLUEPRINT_VERSION = 1;
/** What each material the blueprint was built from stood for. A role is a property of the use, not of the material. */
export const BLUEPRINT_ROLES = Object.freeze(['past-paper', 'syllabus', 'textbook', 'answer-key']);
export const POINT_STATUSES = Object.freeze(['pending', 'confirmed', 'disputed']);
export const BLUEPRINT_LIMITS = Object.freeze({ points: 300, evidence: 6, inputs: 60, quoteChars: 400, titleChars: 200, noteChars: 600 });

const fail = message => { throw new Error(message); };
const text = (value, label, max, { required = false } = {}) => {
  const value_ = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!value_) { if (required) fail(`${label} is required`); return ''; }
  if (value_.length > max) fail(`${label} must be at most ${max} characters`);
  return value_;
};
const optionalInt = (value, label) => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) fail(`${label} must be a non-negative integer`);
  return value;
};

/** The places one exam point came from. Offsets and revision are kept when given; the quote and the source are always there. */
function normalizeEvidence(raw, roles) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Exam point evidence must be an object');
  const sourceId = text(raw.sourceId, 'Evidence sourceId', 200, { required: true });
  const quote = text(raw.quote, 'Evidence quote', BLUEPRINT_LIMITS.quoteChars, { required: true });
  const role = raw.role === undefined ? undefined : raw.role;
  if (role !== undefined && !BLUEPRINT_ROLES.includes(role)) fail(`Unknown evidence role: ${String(role).slice(0, 40)}`);
  const start = optionalInt(raw.start, 'Evidence start'), end = optionalInt(raw.end, 'Evidence end');
  if ((start === undefined) !== (end === undefined) || (end !== undefined && end <= start)) fail('Evidence start and end must be given together, end after start');
  if (roles && !roles.has(sourceId)) fail(`Evidence names a material that is not an input of the blueprint: ${sourceId.slice(0, 80)}`);
  return { sourceId, quote, ...(role ? { role } : {}), ...(raw.documentId ? { documentId: text(raw.documentId, 'Evidence documentId', 200) } : {}),
    ...(raw.revision ? { revision: text(raw.revision, 'Evidence revision', 200) } : {}), ...(start !== undefined ? { start, end } : {}) };
}

/**
 * Check and shape the structured blueprint. Throws a plain Error naming the first problem.
 * @param input { scope?: { label }, language?, inputs: [{ role, sourceId, title?, documentId?, revision? }],
 *                points: [{ id?, title, requirement?, parentId?, status?, evidence: [selection] }], supersedes? }
 */
export function normalizeExamBlueprint(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('An exam blueprint must be an object');
  const inputs = Array.isArray(input.inputs) ? input.inputs : [];
  if (inputs.length > BLUEPRINT_LIMITS.inputs) fail(`An exam blueprint names at most ${BLUEPRINT_LIMITS.inputs} materials`);
  const seenInputs = new Set();
  const kept = inputs.map(item => {
    if (!item || typeof item !== 'object') fail('A blueprint input must be an object');
    const sourceId = text(item.sourceId, 'Input sourceId', 200, { required: true });
    if (!BLUEPRINT_ROLES.includes(item.role)) fail(`Unknown input role: ${String(item.role).slice(0, 40)}`);
    const key = `${item.role}\u0000${sourceId}`;
    if (seenInputs.has(key)) fail(`Input listed twice: ${sourceId.slice(0, 80)}`);
    seenInputs.add(key);
    return { role: item.role, sourceId, ...(item.title ? { title: text(item.title, 'Input title', BLUEPRINT_LIMITS.titleChars) } : {}),
      ...(item.documentId ? { documentId: text(item.documentId, 'Input documentId', 200) } : {}), ...(item.revision ? { revision: text(item.revision, 'Input revision', 200) } : {}) };
  });
  // A blueprint built by hand with no named inputs may cite any material; one with inputs may cite only those.
  const allowed = kept.length ? new Set(kept.map(item => item.sourceId)) : null;
  const rawPoints = Array.isArray(input.points) ? input.points : [];
  if (!rawPoints.length) fail('An exam blueprint needs at least one exam point');
  if (rawPoints.length > BLUEPRINT_LIMITS.points) fail(`An exam blueprint holds at most ${BLUEPRINT_LIMITS.points} exam points`);
  const ids = new Set();
  const points = rawPoints.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`Exam point ${index + 1} must be an object`);
    const id = text(raw.id ?? `p${index + 1}`, `Exam point ${index + 1} id`, 80, { required: true });
    if (ids.has(id)) fail(`Exam point id repeated: ${id}`);
    ids.add(id);
    const status = raw.status ?? 'pending';
    if (!POINT_STATUSES.includes(status)) fail(`Exam point ${id}: unknown status`);
    const evidence = Array.isArray(raw.evidence) ? raw.evidence : [];
    if (!evidence.length) fail(`Exam point ${id} needs at least one place it came from`);
    if (evidence.length > BLUEPRINT_LIMITS.evidence) fail(`Exam point ${id} keeps at most ${BLUEPRINT_LIMITS.evidence} places`);
    return { id, title: text(raw.title, `Exam point ${id} title`, BLUEPRINT_LIMITS.titleChars, { required: true }),
      ...(raw.requirement ? { requirement: text(raw.requirement, `Exam point ${id} requirement`, BLUEPRINT_LIMITS.noteChars) } : {}),
      ...(raw.parentId ? { parentId: text(raw.parentId, `Exam point ${id} parentId`, 80) } : {}), status,
      evidence: evidence.map(item => normalizeEvidence(item, allowed)) };
  });
  for (const point of points) if (point.parentId && !ids.has(point.parentId)) fail(`Exam point ${point.id}: parent ${point.parentId} is not in the list`);
  return { version: EXAM_BLUEPRINT_VERSION, ...(input.scope?.label ? { scope: { label: text(input.scope.label, 'Scope label', BLUEPRINT_LIMITS.titleChars) } } : {}),
    ...(input.language ? { language: text(input.language, 'Language', 40) } : {}), inputs: kept, points,
    ...(input.supersedes ? { supersedes: text(input.supersedes, 'supersedes', 200) } : {}) };
}

const ROLE_WORDS = Object.freeze({ 'past-paper': '历年试卷', syllabus: '考试大纲', textbook: '教材', 'answer-key': '答案或评分说明' });
const STATUS_WORDS = Object.freeze({ pending: '待核对', confirmed: '已确认', disputed: '有争议' });

/** The readable text of a blueprint: what the reader, the picker and any model prompt see. */
export function examBlueprintText(title, blueprint) {
  const lines = [`# ${title}`, ''];
  if (blueprint.scope?.label) lines.push(`范围：${blueprint.scope.label}`, '');
  if (blueprint.inputs.length) lines.push('## 依据资料', '', ...blueprint.inputs.map(item => `- ${ROLE_WORDS[item.role]}：${item.title || item.sourceId}`), '');
  lines.push('## 考点', '');
  blueprint.points.forEach((point, index) => {
    lines.push(`${index + 1}. [${point.id}] ${point.title}（${STATUS_WORDS[point.status]}）`);
    if (point.requirement) lines.push(`   要求：${point.requirement}`);
    for (const place of point.evidence) lines.push(`   - 依据：“${place.quote}”`);
  });
  return `${lines.join('\n')}\n`;
}

/**
 * A source record for the library, ready for `materials.v1 sources.ingest`. The id is a fingerprint of the content,
 * so the same blueprint saved twice is one material and a changed blueprint is a new one (the old stays readable).
 */
export function examBlueprintMaterial({ title, courses = [], ...input } = {}) {
  const name = text(title, 'Blueprint title', BLUEPRINT_LIMITS.titleChars, { required: true });
  if (!Array.isArray(courses) || courses.some(course => typeof course !== 'string')) fail('courses must be a list of names');
  const blueprint = normalizeExamBlueprint(input);
  const fingerprint = createHash('sha256').update(JSON.stringify([name, blueprint])).digest('hex');
  return { id: `exam-blueprint-${fingerprint.slice(0, 40)}`, title: name, text: examBlueprintText(name, blueprint), format: 'md',
    courses: [...new Set(courses.map(course => course.trim()).filter(Boolean))], provenance: EXAM_BLUEPRINT_PROVENANCE, blueprint };
}

export const isExamBlueprintSource = source => source?.provenance === EXAM_BLUEPRINT_PROVENANCE && !!source.blueprint && typeof source.blueprint === 'object';

/**
 * Where a blueprint's places no longer resolve. `resolve(selection)` is the library's own resolver
 * (`resolveSelectionState(state, selection)` of lib/contexts/materials/operations.js); only `status === 'resolved'` counts.
 * @returns [{ pointId, index, sourceId, status }]
 */
export function blueprintEvidenceIssues(source, resolve) {
  if (!isExamBlueprintSource(source)) return [{ pointId: null, index: -1, sourceId: source?.id ?? null, status: 'not-a-blueprint' }];
  const issues = [];
  for (const point of source.blueprint.points || []) {
    (point.evidence || []).forEach((place, index) => {
      const answer = resolve({ sourceId: place.sourceId, quote: place.quote, ...(place.documentId ? { documentId: place.documentId } : {}),
        ...(place.revision ? { revision: place.revision } : {}), ...(place.start !== undefined ? { start: place.start, end: place.end } : {}) });
      if (answer?.status !== 'resolved') issues.push({ pointId: point.id, index, sourceId: place.sourceId, status: answer?.status || 'missing' });
    });
  }
  return issues;
}
