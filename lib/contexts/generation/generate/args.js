import { assertMaterials } from '../../../exam-point-list.js';
import { isLevel } from '../../../coverage-strength.js';
import { coverageRequested } from '../../../coverage-plan.js';
import { GOAL_QUESTIONS_MAX } from '../../../limits.js';
import { COVERAGE, CONTINUE, EXTRA, GOAL, PART, RUN } from './messages.js';

/* The checks of what `generate` was asked, each pure, in the order the caller makes them: which refusal a request gets when it has several things wrong is part of the contract.
   `say(zh, en)` words a refusal. Nothing here reads the library but what it is handed. */

export const refuse = (say, pair) => { throw new Error(say(...pair)); };
const given = value => value !== undefined && value !== null;
const isBoolean = value => typeof value === 'boolean';
const isStringList = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const isBudget = value => Number.isInteger(value) && value >= 1000;
const optional = (value, ok) => value === undefined || ok(value);

/** The sources a continuation is to be written from: null when none were named. Whatever is not a string is dropped; what is not a list is an empty list, which is refused. */
export const extraIdsOf = a => a.extraSourceIds === undefined ? null
  : [...new Set(Array.isArray(a.extraSourceIds) ? a.extraSourceIds.filter(item => typeof item === 'string') : [])];
/** The coverage asked for, or null. A value that is falsy but given (0, '') stays what it is: it asks for nothing, and only an object or a truthy mistake is judged. */
export const coverageAskedOf = a => a.coverage === undefined || a.coverage === null ? null : a.coverage;
export const partAskedOf = a => given(a.documentId);

export function checkExtra(a, { previous, extraIds, sources, say }) {
  if (!extraIds) return;
  if (!previous) refuse(say, EXTRA.needsDraft);
  assertMaterials(sources.filter(source => extraIds.includes(source.id)));
  if (!extraIds.length || extraIds.some(sourceId => !sources.some(source => source.id === sourceId))) refuse(say, EXTRA.chooseSources);
  if (!Number.isInteger(a.count) || a.count < 1 || a.count > 30) refuse(say, EXTRA.count);
}

const namesDocument = id => typeof id === 'string' && !!id.trim();
const namesDeck = partOf => partOf === undefined || (typeof partOf === 'string' && !!partOf);
const makesNewDraft = (a, { previous, extraIds, publishTarget }) => !previous && !extraIds && !publishTarget && a.mergeTargetId === undefined;
export function checkPartArgs(a, asked) {
  const { coverageAsked, say } = asked;
  if (!namesDocument(a.documentId)) refuse(say, PART.documentId);
  if (!makesNewDraft(a, asked)) refuse(say, PART.makesNewDraft);
  if (!coverageAsked || coverageAsked.run !== undefined) refuse(say, PART.needsCoverage);
  if (!namesDeck(a.partOf)) refuse(say, PART.partOf);
}

const COVERAGE_KEYS = ['sectionIds', 'run', 'autoComplete', 'tokenBudget', 'manual'];
const manualFits = coverage => manual => isBoolean(manual) && (!manual || Array.isArray(coverage.sectionIds));
const coverageShapeHolds = coverage => typeof coverage === 'object' && !Array.isArray(coverage) && Object.keys(coverage).every(key => COVERAGE_KEYS.includes(key))
  && optional(coverage.sectionIds, isStringList) && optional(coverage.run, isBoolean) && optional(coverage.autoComplete, isBoolean)
  && optional(coverage.manual, manualFits(coverage)) && optional(coverage.tokenBudget, isBudget);

export function checkCoverageArgs({ previous, partAsked, extraIds, coverageAsked, say }) {
  if (!previous && !partAsked) refuse(say, COVERAGE.needsDraft);
  if (extraIds) refuse(say, COVERAGE.notWithExtra);
  if (!coverageShapeHolds(coverageAsked)) refuse(say, COVERAGE.shape);
}

export function checkRunArgs({ runAsked, coverageAsked, plannedSpec, say }) {
  if (!runAsked) return;
  if (coverageAsked.sectionIds !== undefined) refuse(say, RUN.notWithSections);
  if (!plannedSpec?.rounds?.length) refuse(say, RUN.noPlan);
}

/** A draft can be continued when it says how it was made, and it is the version the learner saw. */
export function checkContinuation(a, previous) {
  const generation = previous.editorial?.generation;
  if (previous.editingDeckId || !generation?.sourceIds?.length || !Number.isInteger(previous.editorial.requested)) throw new Error(CONTINUE.noRecord);
  if (!Number.isInteger(a.draftVersion) || a.draftVersion !== previous.draftVersion) throw new Error(CONTINUE.stale);
}

export const checkLevel = (a, say) => { if (given(a.coverageLevel) && !isLevel(a.coverageLevel)) refuse(say, GOAL.level); };

/** A new draft from sources that is asked for a coverage level or for more than one round: it runs by a plan. */
export const wantsCoverageOf = (a, { previous, extraIds, coverageAsked, publishTarget }) =>
  !previous && !extraIds && !coverageAsked && !publishTarget && a.kind !== 'case' && coverageRequested(a);

export function checkGoal(a, say) {
  if (given(a.count) && (!Number.isInteger(a.count) || a.count < 1 || a.count > GOAL_QUESTIONS_MAX)) refuse(say, GOAL.count(GOAL_QUESTIONS_MAX));
  if (a.autoComplete !== undefined && !isBoolean(a.autoComplete)) refuse(say, GOAL.autoComplete);
  if (a.tokenBudget !== undefined && !isBudget(a.tokenBudget)) refuse(say, GOAL.tokenBudget);
}

const KINDS = ['quiz', 'multi', 'flashcard', 'open', 'cloze', 'mixed', 'case'];
export const checkKind = kind => { if (kind && !KINDS.includes(kind)) throw new Error('Unknown question kind'); };

const CONSTRAINTS = ['topicNoAnswer', 'hintNoAnswer', 'oneTargetPerStem', 'optionsSameAxis'];
const constraintsHold = constraints => constraints && typeof constraints === 'object' && !Array.isArray(constraints)
  && Object.entries(constraints).every(([key, value]) => CONSTRAINTS.includes(key) && isBoolean(value));
export function checkConstraints(constraints) {
  if (constraints !== undefined && !constraintsHold(constraints))
    throw new Error('constraints accepts boolean topicNoAnswer, hintNoAnswer, oneTargetPerStem and optionsSameAxis only');
}
