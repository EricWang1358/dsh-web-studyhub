import { decksInCourse } from './focus.js';
import { isMasteryAttempt } from './mastery.js';
import { atLeast, courseMethod, gateRule, rubricAttemptPassed, stageScope } from './course-method.js';

export { rubricAttemptPassed };

/* Where the learner is in a course's 学法 (#775 S1b; #777 S3): read from what the library holds — no model call.
   - Default 「课堂跟学」 (`own === false`) measures the whole course identically to before: publish when a material exists, practise when 80% is reached,
     review once earlier stages are passed.
   - A course with its own method (`own === true`) measures each stage over its optional stage scope (`deckIds` / `sourceIds` / `topics`, falling back to
     the whole course when omitted), counts rubric attempts with strictly > 50% score or met criteria as right, keeps `self-report` attempts distinct from
     verified answers, respects explicit manual `stageIndex`, and auto-clears `skippedStages` once a skipped stage's check is satisfied. */

const text = value => typeof value === 'string' && value.trim().length > 0;

const attemptsOfFrozen = new WeakMap();

/** Lookup `(deckId, cardId) -> latest mastery attempt` (cached on frozen `attempts`, like `latestOutcomes`). */
export function latestAttempts(attempts = []) {
  const list = Array.isArray(attempts) ? attempts : [];
  const frozen = Object.isFrozen(list);
  if (frozen && attemptsOfFrozen.has(list)) return attemptsOfFrozen.get(list);
  const byDeck = new Map();
  for (const attempt of list) {
    if (!attempt || !isMasteryAttempt(attempt)) continue;
    const deck = attempt.deckId ?? null;
    let cards = byDeck.get(deck);
    if (!cards) byDeck.set(deck, cards = new Map());
    cards.set(attempt.quiz_id ?? attempt.cardId ?? null, attempt);
  }
  const lookup = (deckId, cardId) => byDeck.get(deckId ?? null)?.get(cardId ?? null);
  if (frozen) attemptsOfFrozen.set(list, lookup);
  return lookup;
}

/** Explicit learner self-report (`assessment === 'self-report'` or `selfReported: true` or `unverified: true`), kept distinct from verified question attempts. */
export const isSelfReportedAttempt = attempt =>
  Boolean(attempt && (attempt.assessment === 'self-report' || attempt.selfReported === true || attempt.unverified === true));

/** Whether a latest attempt satisfies a gate count mode (`'answered'` vs `'right'`), excluding `self-report`. */
export function attemptPassed(attempt, countsMode = 'right') {
  if (!attempt || isSelfReportedAttempt(attempt)) return false;
  if (countsMode === 'answered') {
    return attempt.grade !== undefined || attempt.assessment === 'rubric' || attempt.assessment === 'task-static' || Boolean(attempt.taskCheck);
  }
  if (attempt.assessment === 'rubric' || attempt.assessment === 'task-static' || attempt.taskCheck) return rubricAttemptPassed(attempt);
  return Number.isFinite(attempt.grade) && attempt.grade >= 3;
}

/** Materials belonging to `stage` (filtered by `stageScope(stage).sourceIds` when present, else all non-archived text materials of `course`). */
export function stageMaterials(state, course, stage = null) {
  const sources = Array.isArray(state?.sources) ? state.sources : [];
  const scope = stageScope(stage);
  if (scope?.sourceIds?.length) {
    const wanted = new Set(scope.sourceIds);
    return sources.filter(source => source && !source.archived && text(source.text) && wanted.has(source.id));
  }
  return sources.filter(source => source && !source.archived && text(source.text)
    && (Array.isArray(source.courses) ? source.courses.includes(course) : source.course === course));
}

/**
 * Predicate `(deckOrId, card) => boolean` for whether a card of `course` belongs to `stage`'s scope (#777).
 * When `stage` defines no scope, every card of the course matches. Case drill decks (`deck.case.drillDeckId`) inherit their parent case deck's stage scope.
 */
export function stageCardMatcher(state, course, stage = null) {
  const scope = stageScope(stage);
  if (!scope) return () => true;
  const decks = Array.isArray(state?.decks) ? state.decks : [];
  const deckById = new Map(decks.map(deck => [deck.id, deck]));

  let deckSet = null;
  if (scope.deckIds?.length) {
    deckSet = new Set(scope.deckIds);
    for (const id of [...deckSet]) {
      const deck = deckById.get(id);
      if (deck?.case?.drillDeckId) deckSet.add(deck.case.drillDeckId);
    }
  }

  const topicSet = scope.topics?.length ? new Set(scope.topics) : null;

  let sourceSet = null;
  const drillDeckIdsFromSources = new Set();
  if (!deckSet && !topicSet && scope.sourceIds?.length) {
    sourceSet = new Set(scope.sourceIds);
    for (const deck of decks) {
      const hitsCase = deck?.case?.sourceId && sourceSet.has(deck.case.sourceId);
      const hitsGen = Array.isArray(deck?.editorial?.generation?.sourceIds) && deck.editorial.generation.sourceIds.some(id => sourceSet.has(id));
      if ((hitsCase || hitsGen) && deck?.case?.drillDeckId) drillDeckIdsFromSources.add(deck.case.drillDeckId);
    }
  }

  return (deckOrId, card) => {
    if (!card || card.suspended) return false;
    const deck = typeof deckOrId === 'object' && deckOrId ? deckOrId : deckById.get(deckOrId);
    const deckId = deck?.id ?? deckOrId;
    if (deckSet && !deckSet.has(deckId)) return false;
    if (sourceSet) {
      const cited = Array.isArray(card.citations) && card.citations.some(cite => sourceSet.has(cite?.sourceId));
      const fromCase = Boolean(deck?.case?.sourceId && sourceSet.has(deck.case.sourceId));
      const fromGen = Array.isArray(deck?.editorial?.generation?.sourceIds) && deck.editorial.generation.sourceIds.some(id => sourceSet.has(id));
      const fromDrill = drillDeckIdsFromSources.has(deckId);
      if (!cited && !fromCase && !fromGen && !fromDrill) return false;
    }
    if (topicSet && !topicSet.has(card.topic || '未分类')) return false;
    return true;
  };
}

/** Active, unsuspended `{ deck, card }` pairs of `course` within `stage`'s scope. */
export function stageCards(state, course, stage = null) {
  const matches = stageCardMatcher(state, course, stage);
  const items = [];
  for (const deck of decksInCourse(state, course)) {
    for (const card of deck.cards || []) {
      if (card.suspended || !matches(deck, card)) continue;
      items.push({ deck, card });
    }
  }
  return items;
}

export function measureStageCounts(state, course, stage, attemptOf = latestAttempts(state?.attempts)) {
  const materials = stageMaterials(state, course, stage).length;
  let cards = 0, answered = 0, right = 0;
  for (const { deck, card } of stageCards(state, course, stage)) {
    cards += 1;
    const attempt = attemptOf(deck.id, card.id);
    if (attemptPassed(attempt, 'answered')) answered += 1;
    if (attemptPassed(attempt, 'right')) right += 1;
  }
  return { materials, cards, answered, right };
}

/** Whether a stage's check (2/3 pass by default, or materials > 0 for publish) has been verified, clearing any earlier skipped marker. */
export function stageCheckSatisfied(stageOrState, countsOrCourse, maybeStage = null, attemptOf) {
  if (maybeStage) {
    return stageCheckSatisfied(maybeStage, measureStageCounts(stageOrState, countsOrCourse, maybeStage, attemptOf));
  }
  const stage = stageOrState;
  const { materials = 0, cards = 0, answered = 0, right = 0 } = countsOrCourse || {};
  if (!stage) return false;
  if (stage.activity === 'publish') return materials > 0;
  const rule = gateRule(stage.level);
  return cards > 0 && (rule.counts === 'answered' ? answered : right) >= atLeast(rule.pass, cards);
}

/** Whether the work a stage stands for has been done automatically (publish: a material; practice: 80% advance threshold). */
function stageDone(stage, { materials, cards, answered, right }) {
  if (stage.activity === 'publish') return materials > 0;
  if (stage.activity === 'practice') {
    const rule = gateRule(stage.level);
    return cards > 0 && (rule.counts === 'answered' ? answered : right) >= atLeast(rule.advance, cards);
  }
  return false;
}

/**
 * `{ course, index, stage, total, counts: { materials, cards, answered, right }, own }` for `course` (plus `computed, manual, nextStage, skippedStages,
 * selfReportedStages` when `own === true`). The default package (`own === false`) behaves 100% identically to before.
 */
export function methodProgress(state, course) {
  const record = (state?.courses || []).find(item => item && item.name === course) ?? null;
  const own = !!record?.method;
  const method = courseMethod(record);
  const attemptOf = latestAttempts(state?.attempts);

  if (!own) {
    const counts = measureStageCounts(state, course, null, attemptOf);
    let index = 0;
    while (index < method.stages.length - 1 && stageDone(method.stages[index], counts)) index += 1;
    return { course, index, stage: method.stages[index], total: method.stages.length, counts, own: false };
  }

  const perStageCounts = method.stages.map(stage => measureStageCounts(state, course, stage, attemptOf));
  let computed = 0;
  while (computed < method.stages.length - 1 && stageDone(method.stages[computed], perStageCounts[computed])) computed += 1;

  const manual = Number.isInteger(method.stageIndex) && method.stageIndex >= 0 && method.stageIndex < method.stages.length;
  const index = manual ? method.stageIndex : computed;
  const skippedStages = (Array.isArray(method.skippedStages) ? method.skippedStages : [])
    .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < method.stages.length && !stageCheckSatisfied(method.stages[idx], perStageCounts[idx]));
  const selfReportedStages = (Array.isArray(method.selfReportedStages) ? method.selfReportedStages : [])
    .filter(idx => Number.isInteger(idx) && idx >= 0 && idx < method.stages.length && !stageCheckSatisfied(method.stages[idx], perStageCounts[idx]));

  return {
    course,
    index,
    computed,
    manual,
    stage: method.stages[index],
    nextStage: method.stages[index + 1] ?? null,
    total: method.stages.length,
    counts: perStageCounts[index],
    own: true,
    skippedStages,
    selfReportedStages,
  };
}
