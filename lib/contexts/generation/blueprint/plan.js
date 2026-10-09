import { createHash } from 'node:crypto';
import { BLUEPRINT_LIMITS, BLUEPRINT_ROLES, PRIMARY_ROLES, isExamPointListSource, normalizeReading } from '../../../exam-blueprint-material.js';
import { inputFingerprint } from '../../../exam-point-list.js';
import { PAPER_CHUNK_CHARS, WINDOW_CHARS, WINDOW_SLIDES } from './constants.js';
import { REFUSALS } from './jobs/messages.js';

export * from './constants.js';
export * from './prompts.js';
export * from './read.js';
export { estimateCalls } from './estimate.js';
export { normTitle, repairGroups } from './union.js';

/* The plan of one exam point list build (docs/plans/2026-10-07-1834-feat-exam-blueprint-3.1-plan.md, revision 5), pure: no model, no library, no clock.
   Stage 0 (`planBuild`) turns a request and the library into the inputs, the chunks of the sample papers and the windows of slides, or refuses with a code (in the learner's words),
   and it refuses before any model call when a limit of the list is already exceeded. The prompts (prompts.js), the readers of the answers (read.js) and the estimate
   (estimate.js) sit beside it. Bottom-up: papers, then their united points, then slides, then the extra points of the slides. */

const refuse = (code, language) => Object.assign(new Error(REFUSALS[code](language)), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const short = value => createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
const tidy = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';

/** The sources an input stands for: its own list, else the current pages of its document. */
function membersOf(state, input, language) {
  const byId = new Map((state.sources || []).map(source => [source.id, source]));
  let found;
  if (Array.isArray(input.sourceIds) && input.sourceIds.length) {
    found = input.sourceIds.map(id => byId.get(id));
    if (found.some(source => !source)) throw refuse('blueprint-input-missing', language);
  } else if (typeof input.documentId === 'string' && input.documentId) {
    const document = (state.documents || []).find(item => item.id === input.documentId);
    const current = document?.versions?.find(version => version.revision === document.currentRevision);
    found = current ? current.sourceIds.map(id => byId.get(id)).filter(Boolean)
      : (state.sources || []).filter(source => !source.historical && (source.document?.id === input.documentId || source.document?.materialId === input.documentId));
    if (!found.length) throw refuse('blueprint-input-missing', language);
  } else throw refuse('blueprint-input-missing', language);
  // An exam point list is not course material: it cannot be the input of another one.
  if (found.some(isExamPointListSource)) throw refuse('blueprint-input-invalid', language);
  return found;
}

const pageOf = source => Number.isInteger(source.document?.page) ? source.document.page : undefined;
const ordered = members => members.every(source => pageOf(source) !== undefined)
  ? [...members].sort((a, b) => pageOf(a) - pageOf(b)) : members;

/** Pages (or slides) of a deck with nothing readable: sources with no text, and numbers missing from a deck whose page count is known. */
function skippedOf(members) {
  const skipped = new Set(members.filter(source => !String(source.text ?? '').trim() && pageOf(source) !== undefined).map(pageOf));
  const total = members.map(source => source.document?.totalPages).find(Number.isInteger);
  if (total && total <= 2000 && members.every(source => pageOf(source) !== undefined)) {
    const present = new Set(members.map(pageOf));
    for (let page = 1; page <= total; page++) if (!present.has(page)) skipped.add(page);
  }
  return [...skipped].sort((a, b) => a - b);
}

function chunk(items, fits) {
  const groups = [];
  let current = [];
  for (const item of items) {
    if (current.length && !fits(current, item)) { groups.push(current); current = []; }
    current.push(item);
  }
  if (current.length) groups.push(current);
  return groups;
}

/** The limits of the list that the request already breaks, before anything is read: refused with a code, no model call. */
function checkLimits(request, title, language) {
  if (title.length > BLUEPRINT_LIMITS.titleChars) throw refuse('blueprint-title-too-long', language);
  if (tidy(request.scope?.label).length > BLUEPRINT_LIMITS.titleChars) throw refuse('blueprint-scope-too-long', language);
  try { normalizeReading(request.recommendedReading); } catch { throw refuse('blueprint-reading-invalid', language); }
}

/**
 * Stage 0. Throws an Error with a `code` and spends nothing; otherwise the plan of the build.
 * @param request { title, course?, scope?: { label }, language?, recommendedReading?, inputs: [{ role, sourceIds? | documentId?, title? }] }  (any number of past-paper inputs)
 */
export function planBuild(state, request = {}) {
  const language = request.language === 'en' ? 'en' : 'zh';
  const title = tidy(request.title);
  if (!title) throw refuse('blueprint-title-required', language);
  checkLimits(request, title, language);
  // A rebuild names the list it replaces: it must be an exam point list of this library (it is archived only when the new one is saved).
  const replaced = request.supersedes;
  const isList = id => (state.sources || []).some(source => source.id === id && isExamPointListSource(source));
  if (replaced !== undefined && replaced !== null && !(typeof replaced === 'string' && isList(replaced))) throw refuse('blueprint-supersedes-invalid', language);
  const asked = Array.isArray(request.inputs) ? request.inputs : [];
  for (const input of asked) if (!input || !BLUEPRINT_ROLES.includes(input.role)) throw refuse('blueprint-input-invalid', language);
  if (asked.length > BLUEPRINT_LIMITS.inputs) throw refuse('blueprint-too-many-inputs', language);
  if (!asked.some(input => PRIMARY_ROLES.includes(input.role))) throw refuse('blueprint-needs-primary-input', language);
  const sources = new Map(), inputs = [];
  asked.forEach(input => {
    const all = ordered(membersOf(state, input, language));
    const readable = all.filter(source => String(source.text ?? '').trim());
    if (readable.length > BLUEPRINT_LIMITS.inputSources) throw refuse('blueprint-input-too-large', language);
    all.forEach(source => sources.set(source.id, source));
    const skippedPages = skippedOf(all);
    // `fingerprint`: of the texts the build reads, in the order of `sourceIds`; the list is out of date when they change.
    inputs.push({ role: input.role, ...(input.documentId ? { documentId: input.documentId } : {}), sourceIds: readable.map(source => source.id),
      ...(input.title ? { title: String(input.title).slice(0, BLUEPRINT_LIMITS.titleChars) } : {}), ...(skippedPages.length ? { skippedPages } : {}),
      fingerprint: inputFingerprint(readable.map(source => source.text)) });
  });
  // A sample paper or any other input with nothing to read is refused; a deck with nothing to read is left out, and the build needs at least one deck that has text.
  if (inputs.some(input => !input.sourceIds.length && !PRIMARY_ROLES.includes(input.role))) throw refuse('blueprint-no-readable-text', language);
  const usable = inputs.filter(input => input.sourceIds.length);
  if (!usable.some(input => PRIMARY_ROLES.includes(input.role))) throw refuse('blueprint-no-readable-text', language);
  inputs.splice(0, inputs.length, ...usable);
  const slide = id => { const source = sources.get(id); return { id, page: pageOf(source) ?? null, text: source.text }; };
  const windows = [];
  inputs.forEach((input, index) => {
    if (!PRIMARY_ROLES.includes(input.role)) return;
    for (const group of chunk(input.sourceIds.map(slide), (current, next) =>
      current.length < WINDOW_SLIDES && current.reduce((sum, item) => sum + item.text.length, 0) + next.text.length <= WINDOW_CHARS)) {
      windows.push({ number: windows.length + 1, inputIndex: index, slides: group, key: `bp:s3:${windows.length + 1}:${short(group[0].id)}` });
    }
  });
  const paperChunks = [];
  inputs.forEach((input, index) => {
    if (input.role !== 'past-paper') return;
    for (const group of chunk(input.sourceIds.map(id => ({ id, text: sources.get(id).text })), (current, next) =>
      current.reduce((sum, item) => sum + item.text.length, 0) + next.text.length <= PAPER_CHUNK_CHARS)) {
      const number = paperChunks.length + 1;
      paperChunks.push({ number, inputIndex: index, key: input.documentId || input.sourceIds[0], sources: group, askKey: `bp:s1:${number}:${short(group[0].id)}` });
    }
  });
  // Points are united whenever they come from more than one chunk of paper (two papers, or one paper read in pieces),
  // and the extra points whenever they come from more than one window.
  const mergeNeeded = paperChunks.length >= 2, extraMergeNeeded = windows.length >= 2;
  const reading = request.recommendedReading;
  const scope = tidy(request.scope?.label) ? { label: tidy(request.scope.label) } : undefined;
  const course = tidy(request.course) || undefined;
  // What the scope was when the build was asked for: the texts of every material, so a later change shows as "the basis has been updated".
  const scopeHash = digest(inputs.map(input => input.sourceIds.map(id => [id, digest(sources.get(id).text)])));
  const plan = { title, course, scope, language, ...(request.supersedes ? { supersedes: request.supersedes } : {}), ...(reading ? { recommendedReading: reading } : {}),
    inputs, windows, paperChunks,
    papers: inputs.filter(input => input.role === 'past-paper').length, mergeNeeded, mergeKey: 'bp:s2:merge', extraMergeNeeded, extraMergeKey: 'bp:s4:extras',
    steps: paperChunks.length + (mergeNeeded ? 1 : 0) + windows.length + (extraMergeNeeded ? 1 : 0), scopeHash };
  // The answers kept for a retry are the answers to THIS plan: the same texts, language and scope, and the same calls.
  const calls = [...paperChunks.map(item => item.askKey), ...windows.map(item => item.key), plan.mergeKey, plan.extraMergeKey];
  return { ...plan, planKey: digest([scopeHash, language, scope?.label ?? '', calls]) };
}
