import { isCaseDeck, WEAK_RATIO } from './case-study.js';
import {
  attemptPassed,
  isSelfReportedAttempt,
  latestAttempts,
  methodProgress,
  stageCards,
  stageMaterials,
} from './course-method-progress.js';
import { GATE_RULES, atLeast, courseMethod, gateRule } from './course-method.js';

/* 阶段检验 (#777 S3): what the current stage's check rests on, read from the learner's own answers — no model call, nothing generated.
   - Scoped to the stage's own questions when `stage.scope` is set, else the whole course's questions.
   - Rubric attempts (`assessment === 'rubric'`) pass when strictly > 50% of marks or criteria are met (`rubricAttemptPassed`).
   - Self-reported attempts (`assessment === 'self-report'`) are counted separately in `selfReported` and never conflated with verified passes.
   - Tracks missed questions (`missed`) for manual return-to-chat hand-off and `weakCaseDeckId` when a case set has weak criteria (< 60%) eligible for `case.drills`. */

export { GATE_RULES } from './course-method.js';
/** 约三分之二答对算过（标准宽松，owner 定的）: the default gate's check. */
export const CHECK_PASS_RATIO = GATE_RULES.medium.pass;
/** 过 80% 才建议进入下一阶段: the default gate's suggestion. */
export const ADVANCE_RATIO = GATE_RULES.medium.advance;

const MISSED_CAP = 20;

function hasWeakRubricCriteria(attempt) {
  if (!attempt || attempt.assessment !== 'rubric') return false;
  const criteria = Array.isArray(attempt.rubric?.criteria) ? attempt.rubric.criteria : [];
  return criteria.some(criterion => {
    const max = Number(criterion?.max);
    const score = Number(criterion?.score);
    return Number.isFinite(max) && max > 0 && Number.isFinite(score) && score / max < WEAK_RATIO;
  });
}

function measureStageGate(state, course, stage, index, totalStages, attemptOf, { skippedSet, selfReportedSet } = {}) {
  const level = GATE_RULES[stage?.level] ? stage.level : 'medium';
  const rule = gateRule(level);
  let total = 0, passed = 0, selfReported = 0, weakCaseDeckId = null;
  const missed = [];
  for (const { deck, card } of stageCards(state, course, stage)) {
    total += 1;
    const attempt = attemptOf(deck.id, card.id);
    if (isSelfReportedAttempt(attempt)) {
      selfReported += 1;
      continue;
    }
    if (attemptPassed(attempt, rule.counts)) {
      passed += 1;
    } else if (attempt) {
      if (missed.length < MISSED_CAP) {
        missed.push({
          deckId: deck.id,
          cardId: card.id,
          topic: card.topic || '',
          prompt: card.prompt || '',
          assessment: attempt.assessment || 'graded',
        });
      }
    }
    if (!weakCaseDeckId && isCaseDeck(deck) && hasWeakRubricCriteria(attempt)) {
      weakCaseDeckId = deck.id;
    }
  }
  const last = index >= totalStages - 1;
  const needed = atLeast(rule.advance, total);
  const checkPassed = total > 0 && passed >= atLeast(rule.pass, total);
  const ready = !last && total > 0 && passed >= needed;
  const publishVerified = stage?.activity === 'publish' && stageMaterials(state, course, stage).length > 0;
  const verified = publishVerified || checkPassed;
  const status = verified
    ? 'verified'
    : skippedSet?.has(index)
      ? 'skipped'
      : (selfReportedSet?.has(index) || selfReported > 0)
        ? 'self-reported'
        : 'pending';

  return {
    level,
    counts: rule.counts,
    total,
    passed,
    selfReported,
    missed,
    weakCaseDeckId,
    ratio: total ? passed / total : 0,
    checkPassed,
    ready,
    toReady: Math.max(0, needed - passed),
    last,
    status,
  };
}

/**
 * `{ course, index, stage, level, counts, total, passed, selfReported, missed, weakCaseDeckId, ratio, checkPassed, ready, toReady, last, basis, status, stages? }`
 * for `course`. Default `课堂跟学` (`own === false`) preserves exact course-wide counts; custom methods (`own === true`) include per-stage status summaries.
 */
export function stageGate(state, course, progress = methodProgress(state, course)) {
  const record = (state?.courses || []).find(item => item && item.name === course) ?? null;
  const own = progress.own ?? !!record?.method;
  const attemptOf = latestAttempts(state?.attempts || []);
  const skippedSet = new Set(Array.isArray(progress.skippedStages) ? progress.skippedStages : (record?.method?.skippedStages || []));
  const selfReportedSet = new Set(Array.isArray(progress.selfReportedStages) ? progress.selfReportedStages : (record?.method?.selfReportedStages || []));

  const current = measureStageGate(state, course, progress.stage, progress.index, progress.total, attemptOf, { skippedSet, selfReportedSet });
  let stages;
  if (own && record?.method) {
    const method = courseMethod(record);
    stages = method.stages.map((stage, idx) => {
      const item = measureStageGate(state, course, stage, idx, method.stages.length, attemptOf, { skippedSet, selfReportedSet });
      return {
        index: idx,
        total: item.total,
        passed: item.passed,
        selfReported: item.selfReported,
        checkPassed: item.checkPassed,
        ready: item.ready,
        status: item.status,
      };
    });
  }

  return {
    course,
    index: progress.index,
    stage: progress.stage,
    level: current.level,
    counts: current.counts,
    total: current.total,
    passed: current.passed,
    selfReported: current.selfReported,
    missed: current.missed,
    weakCaseDeckId: current.weakCaseDeckId,
    ratio: current.ratio,
    checkPassed: current.checkPassed,
    ready: current.ready,
    toReady: current.toReady,
    last: current.last,
    status: current.status,
    ...(stages ? { stages } : {}),
    basis: 'cards',
  };
}
