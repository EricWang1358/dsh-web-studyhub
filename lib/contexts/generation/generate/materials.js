import { normalizeQuestionReferenceFormat, normalizeQuestionReferenceLimits, resolveQuestionReferences } from '../../../question-references.js';
import { MAX_SELECTED_CHARS } from '../../../batch.js';
import { usableMaterials } from '../../../coverage-materials.js';
import { ROUND_LIMIT } from '../../../coverage-round.js';
import { planningInputFor } from '../../../coverage-state.js';
import { assertMaterials } from '../../../exam-point-list.js';
import { COVERAGE_SELECTION_CHARS } from '../../../limits.js';
import { normalizeNotation, resolveNotation } from '../../../notation.js';
import { inputRefOf } from '../jobs/input-ref.js';
import { definitionRef } from '../jobs/generation.js';
import { narrowSelection } from '../retrieval-operations.js';
import { CONTINUE } from './messages.js';

/* What a run is written from: how many questions, the references, the sources and the text of them it reads. */

/** A coverage run is sized by its plan; every other run asks for 1 to ROUND_LIMIT questions, as it always did. */
export function countOf({ covering, request, wantsCoverage, roundLimit, previous }) {
  const count = covering ? covering.round.questions : Number(request.count ?? 10);
  const limit = covering ? roundLimit : ROUND_LIMIT;
  if (!wantsCoverage && (!Number.isInteger(count) || count < 1 || count > limit)) throw new Error(previous ? CONTINUE.nothingLeft : 'Choose 1–30 questions');
  return count;
}

const REFERENCE_ARGS = ['referenceSourceIds', 'referenceLimits', 'referenceFormat'];
export function applyReferences({ a, s, previous, request }) {
  if (previous) for (const key of REFERENCE_ARGS) if (a[key] !== undefined) request[key] = a[key];
  request.referenceLimits = normalizeQuestionReferenceLimits(request.referenceLimits);
  request.referenceFormat = normalizeQuestionReferenceFormat(request.referenceFormat);
  request.questionReferences = resolveQuestionReferences(s, request);
  request.referenceSourceIds = request.questionReferences.map(source => source.id);
}

/** The sources the library holds of those asked for. A new draft whose selection names sources the library no longer holds (removed while the form was open): what is
    left runs, and the job and the draft say how many were missing. */
export function selectedSources({ s, previous, extraIds, request }) {
  const sources = s.sources.filter(source => request.sourceIds?.includes(source.id));
  assertMaterials(sources);
  const asked = previous || extraIds ? [] : [...new Set(Array.isArray(request.sourceIds) ? request.sourceIds : [])];
  const missing = asked.filter(sourceId => !sources.some(source => source.id === sourceId)).length;
  if (missing && sources.length) request.missingSources = missing;
  return sources;
}

/** Every selected material gets a question (the owner's decision of 2026-10-11): a plain run asked for fewer questions than it has materials asks for one per material
    (at most one round), and says so. */
export function raisedCount({ s, previous, covering, wantsCoverage, request, sources, count }) {
  if (previous || covering || wantsCoverage || request.case || !sources.length || !Number.isInteger(count) || count < 1) return count;
  const raised = Math.min(ROUND_LIMIT, usableMaterials(planningInputFor(s, sources).materials).length);
  if (raised <= count) return count;
  request.countRaised = { from: count, to: raised };
  request.count = raised;
  return raised;
}

export function checkSourcesLeft({ previous, request, sources }) {
  if (previous && sources.length !== new Set(request.sourceIds).size) throw new Error(CONTINUE.sourceGone);
  if (!sources.length && !request.case?.scenario) throw new Error('Select at least one source');
}

/** A large selection is narrowed to the pages a retrieval provider finds for the topic (WP28); a continued draft keeps its sources. A coverage run reads its whole
    selection (each planning call is
    given only the sections assigned to it), so it is narrowed only when it is over the bound of COVERAGE_SELECTION_CHARS or the learner asked for retrieval. */
export function narrowingOf({ previous, part, request, retrieval, sources, wantsCoverage }) {
  if (previous || part || request.case) return null;
  return narrowSelection({ port: retrieval, sources, request, ...(wantsCoverage ? { limit: COVERAGE_SELECTION_CHARS, above: COVERAGE_SELECTION_CHARS } : {}) });
}

/** The learner's choice of notation stays on the draft (top-ups and repairs reuse it); "auto" is resolved once per run from this run's sources. */
export function applyNotation(request, sources) {
  request.notation = normalizeNotation(request.notation);
  request.notationResolved = resolveNotation(request.notation, sources);
}

export function checkSelectionSize({ sources, coverageRun, plannedSpec }) {
  const chars = sources.reduce((sum, source) => sum + source.text.length, 0), limit = coverageRun || plannedSpec?.rounds?.length ? COVERAGE_SELECTION_CHARS : MAX_SELECTED_CHARS;
  if (chars > limit) throw Object.assign(new Error(`Selected sources total ${chars} characters; the limit is ${limit}. Select fewer sources.`), { code: 'selection-too-large' });
}

/** What this run was asked, frozen with the draft that checkpoints it (jobs/input-ref.js): a later run judges whether the checkpoint still fits it.
    A draft that is continued keeps what its first run was asked: the later run is judged against that, never against what is left to ask (a top-up asks for more, so it
    freezes anew). */
export function inputRefFor({ a, previous, extraIds, publishTarget, request, count, fullSources }) {
  const kept = previous?.editorial?.generation?.inputRef;
  if (kept && !extraIds) return kept;
  return inputRefOf({ definition: definitionRef(publishTarget ? 'supplement' : 'generation'), request: { ...request, count }, sources: fullSources,
    ...(extraIds ? { extraSourceIds: extraIds, added: a.count } : {}) });
}
