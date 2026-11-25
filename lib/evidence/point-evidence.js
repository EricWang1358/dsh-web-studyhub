/* Unified `hid` Evidence Spine (StudyHub 5.0.0 Evolution 1):
   100% pure, 0-token, zero I/O, browser-safe projection of per-knowledge-point learning evidence.
   - Preserves `lib/mastery.js` `cardLevel()` ("self-rating 5 = mastered") untouched: PointEvidence answers
     "what to do next", NEVER overrides or contradicts a card's `mastered` status.
   - Non-compensatory facets (`retention`, `comprehension`, `transfer`) -> `overall`.
   - Assisted / solution-exposed attempts count as `assisted` and cannot make `retention: 'solid'`
     or `transfer: 'verified'`.
   - Uses WeakMap caching over deep-frozen arrays (matching `lib/mastery.js`). */

import { cardLevel, isMasteryAttempt, isUnverifiedSelfReport, latestOutcomes } from '../mastery.js';
import { assistanceEvidence } from '../study-progress.js';
import { cardExposureStatus } from '../solution-exposure.js';
import { localDate } from '../board-model.js';
import { rubricAttemptPassed } from '../course-method.js';
import { defaults as sm2Defaults, examDayStart, focusScheduleSettings, retrievabilityAt } from '../sm2.js';
import { daysBetween, isDate } from '../crunch-plan.js';
import { crunchWindow } from '../book-settings.js';
import { currentCourse, decksInCourse } from '../focus.js';
import { stateFocusPredicate } from '../focus-points.js';
import { courseExamByName } from '../card-schedule.js';

/** Different days a question must be answered right independently to be solid (unless already mastered independently). */
export const SOLID_DAYS = 2;
const RIGHT_GRADE = 3;
const SLOW_MIN_MS = 25_000;
const SLOW_SOLO_MS = 60_000;
const INTERACTIVE_CHECK_KEY = /^(?:check|quiz|spot|say)(?:[:_-]|$)/i;
const QUIZ_CHECK_KEY = /^(?:check|quiz)(?:[:_-]|$)/i;

const cardRefKey = (deckId, cardId) => `${deckId ?? ''}|${cardId ?? ''}`;

/** A question is solid: mastered (independently), or answered right independently on SOLID_DAYS days; never weak or new. */
export const cardSolid = (level, rightDays) =>
  level !== 'weak' && level !== 'new' && (level === 'mastered' || rightDays >= SOLID_DAYS);

/** A point is solid (retention): at least half of its questions are solid and none is weak. */
export const pointSolid = cards =>
  cards.length > 0 && !cards.some(card => card.weak) && cards.filter(card => card.solid).length * 2 >= cards.length;

/** Non-compensatory `overall` rule (§6.3). */
export function computeOverall(facets = {}) {
  const retention = facets.retention || 'unstarted';
  const comprehension = facets.comprehension || 'unverified';
  const transfer = facets.transfer || 'unverified';
  if (retention === 'unstarted' && comprehension === 'unverified' && transfer === 'unverified') return 'unstarted';
  if (retention === 'weak' || retention === 'slip' || comprehension === 'gap') return 'shaky';
  if (retention === 'solid' && comprehension === 'verified' && transfer === 'verified') return 'solid';
  return 'in_progress';
}

const isTransferCard = card => Boolean(
  card && (
    card.originCardId ||
    card.variantOf ||
    card.isVariant ||
    card.transfer === true ||
    card.kind === 'open' ||
    card.kind === 'task' ||
    (Array.isArray(card.rubricCriteria) && card.rubricCriteria.length > 0) ||
    card.cognitiveLevel === 'apply' ||
    card.cognitiveLevel === 'analyze'
  ),
);

const isRightAttempt = attempt => {
  if (!attempt) return false;
  if (attempt.assessment === 'rubric' || attempt.assessment === 'task-static' || attempt.taskCheck) {
    return rubricAttemptPassed(attempt);
  }
  if (Number.isFinite(attempt.grade)) return attempt.grade >= RIGHT_GRADE;
  return attempt.correct === true;
};

const isRubricOrTaskAttempt = attempt =>
  Boolean(attempt && (attempt.assessment === 'rubric' || attempt.assessment === 'task-static' || attempt.taskCheck));

function medianElapsedOf(list) {
  const timings = [];
  for (const att of list) {
    if (!isMasteryAttempt(att) || isUnverifiedSelfReport(att)) continue;
    const ms = Number(att?.elapsed_ms);
    if (Number.isFinite(ms) && ms > 0) timings.push(ms);
  }
  if (timings.length < 3) return null;
  timings.sort((a, b) => a - b);
  const mid = Math.floor(timings.length / 2);
  return timings.length % 2 === 1 ? timings[mid] : (timings[mid - 1] + timings[mid]) / 2;
}

const isSlowRight = (attempt, medianMs) => {
  if (attempt?.slowCorrect === true || attempt?.hesitant === true) return true;
  const ms = Number(attempt?.elapsed_ms);
  if (!Number.isFinite(ms) || ms < SLOW_MIN_MS) return false;
  return medianMs !== null ? ms >= medianMs * 3 : ms >= SLOW_SOLO_MS;
};

function createAttemptRecord() {
  return {
    verified: false,
    unverified: false,
    latestAttempt: null,
    independentDays: new Set(),
    assistedDays: new Set(),
    independentPasses: 0,
    assistedPasses: 0,
    hintAssisted: false,
    exposedSolution: false,
    slowCorrectCount: 0,
    rubricPasses: 0,
    assistedRubricPasses: 0,
    explicitUnseenPasses: 0,
    cleanIndependentPasses: 0,
    partialTransfer: false,
  };
}

// WeakMap cache over frozen attempts arrays (and optional frozen solutionExposures arrays), matching lib/mastery.js.
const indexNoExpCache = new WeakMap();
const indexWithExpCache = new WeakMap();

function buildAttemptIndex(attempts, exposures) {
  const list = Array.isArray(attempts) ? attempts : [];
  const expList = Array.isArray(exposures) && exposures.length ? exposures : null;
  const frozenAttempts = Object.isFrozen(list);
  const frozenExposures = !expList || Object.isFrozen(expList);

  if (frozenAttempts && !expList && indexNoExpCache.has(list)) return indexNoExpCache.get(list);
  if (frozenAttempts && expList && frozenExposures) {
    const nested = indexWithExpCache.get(list);
    if (nested?.has(expList)) return nested.get(expList);
  }

  const medianMs = medianElapsedOf(list);
  const map = new Map();

  for (const attempt of list) {
    if (!attempt || !isMasteryAttempt(attempt)) continue;
    const deckId = attempt.deckId ?? null;
    const cardId = attempt.quiz_id ?? attempt.cardId ?? null;
    if (deckId === null && cardId === null) continue;
    const hasGrade = Number.isFinite(attempt.grade) || isRubricOrTaskAttempt(attempt) || typeof attempt.correct === 'boolean';
    if (!hasGrade) continue;

    const key = cardRefKey(deckId, cardId);
    if (isUnverifiedSelfReport(attempt)) {
      const found = map.get(key) ?? createAttemptRecord();
      found.unverified = true;
      map.set(key, found);
      continue;
    }

    const found = map.get(key) ?? createAttemptRecord();
    found.verified = true;
    found.unverified = false;
    found.latestAttempt = attempt;

    const ev = assistanceEvidence(attempt, attempt.assistance);
    const exp = expList ? cardExposureStatus(expList, { cardId, deckId, beforeAt: attempt.timestamp }) : null;
    const exposedSolution = Boolean(
      ev.revealedBeforeAnswer ||
      ev.askedTutorBeforeAnswer ||
      ev.blueprintExposed ||
      ev.sampleExposed ||
      ev.unseenStatus === 'exposed' ||
      exp?.exposed,
    );
    const unseenStatus = exposedSolution ? 'exposed' : (ev.unseenStatus || exp?.unseenStatus || null);
    const assisted = Boolean(ev.used || exposedSolution);
    const right = isRightAttempt(attempt);
    const rubric = isRubricOrTaskAttempt(attempt);
    const at = Date.parse(attempt.timestamp);
    const day = Number.isFinite(at) ? localDate(new Date(at)) : null;

    if (ev.hintUsed) found.hintAssisted = true;
    if (exposedSolution) found.exposedSolution = true;

    if (right) {
      if (!assisted) {
        found.independentPasses += 1;
        if (day) found.independentDays.add(day);
        if (isSlowRight(attempt, medianMs)) found.slowCorrectCount += 1;
        if (rubric) found.rubricPasses += 1;
        if (unseenStatus === 'unseen') found.explicitUnseenPasses += 1;
        if (unseenStatus !== 'exposed' && unseenStatus !== 'unknown') found.cleanIndependentPasses += 1;
      } else {
        found.assistedPasses += 1;
        if (day) found.assistedDays.add(day);
        if (rubric) found.assistedRubricPasses += 1;
      }
    } else if (rubric && !attempt.adjustedAt && Number(attempt.score) > 0 && !exposedSolution) {
      found.partialTransfer = true;
    }

    map.set(key, found);
  }

  if (frozenAttempts && !expList) {
    indexNoExpCache.set(list, map);
  } else if (frozenAttempts && expList && frozenExposures) {
    let nested = indexWithExpCache.get(list);
    if (!nested) indexWithExpCache.set(list, nested = new WeakMap());
    nested.set(expList, map);
  }
  return map;
}

/**
 * Unified solidity & evidence reader per question entry (`{ deckId, cardId, level, card? }`).
 * - Assisted/exposed attempts NEVER increment `right` (independent days) and NEVER produce `solid: true` or `unseenTransferPassed: true`.
 * - Preserves `cardLevel()` untouched: an independently mastered card (including self-rated 5 without assistance) stays `solid: true`.
 */
export function questionSolidity(attempts, { exposures } = {}) {
  const index = buildAttemptIndex(attempts, exposures);
  const expList = Array.isArray(exposures) && exposures.length ? exposures : null;
  return entry => {
    const record = index.get(cardRefKey(entry.deckId, entry.cardId));
    const right = record?.independentDays.size ?? 0;
    const assistedDays = record?.assistedDays.size ?? 0;
    const unverified = !!record?.unverified;
    const assistedPasses = record?.assistedPasses ?? 0;
    const independentPasses = record?.independentPasses ?? 0;
    const assistedOnly = assistedPasses > 0 && independentPasses === 0;
    const cardExposed = expList
      ? cardExposureStatus(expList, { cardId: entry.cardId, deckId: entry.deckId }).exposed
      : false;
    const exposedSolution = Boolean(record?.exposedSolution || (assistedPasses > 0 && cardExposed));
    const hintAssisted = Boolean(record?.hintAssisted);
    const weak = entry.level === 'weak';
    const solid = !unverified && !assistedOnly && cardSolid(entry.level, right);
    const transferCard = isTransferCard(entry.card);
    const unseenTransferPassed = Boolean(
      !unverified &&
      !exposedSolution &&
      (
        (record?.rubricPasses ?? 0) > 0 ||
        (record?.explicitUnseenPasses ?? 0) > 0 ||
        (transferCard && (record?.cleanIndependentPasses ?? 0) > 0)
      ),
    );
    const partialTransfer = Boolean(
      !unseenTransferPassed &&
      !exposedSolution &&
      (
        (record?.assistedRubricPasses ?? 0) > 0 ||
        (transferCard && assistedPasses > 0) ||
        record?.partialTransfer
      ),
    );
    return {
      right,
      assistedDays,
      answered: !!record?.verified,
      unverified,
      assisted: assistedPasses > 0,
      assistedOnly,
      hintAssisted,
      exposedSolution,
      solid,
      weak,
      slowCorrect: record?.slowCorrectCount ?? 0,
      unseenTransferPassed,
      rubricPassed: (record?.rubricPasses ?? 0) > 0,
      partialTransfer,
    };
  };
}

function examProjectionOf(cards, { examDate, today, settings }) {
  if (!isDate(examDate) || !isDate(today) || daysBetween(today, examDate) < 1) return null;
  if (!cards.some(item => item.answeredForExam)) return null;
  const at = examDayStart(examDate);
  const recall = retrievabilityAt(settings ?? sm2Defaults);
  const projected = cards.map(item => {
    if (!item.answeredForExam) return item;
    const target = Number(focusScheduleSettings(settings ?? sm2Defaults, { isFocus: item.focus === true })?.request_retention ?? sm2Defaults.request_retention);
    const value = recall(item.review, at);
    return value >= target ? item : { ...item, solid: false };
  });
  return !pointSolid(cards) ? 'weak' : pointSolid(projected) ? 'solid' : 'slip';
}

function retellInfoOf(bookRetell, cards) {
  let passes = 0;
  let lastGap = null;
  let lastAt = '';
  let latestPassed = false;
  const inspect = rec => {
    if (!rec || typeof rec !== 'object') return;
    if (Number.isInteger(rec.passes) && rec.passes > 0) passes += rec.passes;
    const at = typeof rec.at === 'string' ? rec.at : '';
    const isNewer = !lastAt || (at && at >= lastAt);
    if (rec.gap === 'none') {
      if (isNewer) { lastAt = at || lastAt; lastGap = null; latestPassed = true; }
    } else if (rec.gap === 'wrong' || rec.gap === 'missed') {
      if (isNewer) { lastAt = at || lastAt; lastGap = rec.gap; latestPassed = false; }
    } else if (Number.isInteger(rec.passes) && rec.passes > 0 && isNewer) {
      latestPassed = true;
    }
  };
  inspect(bookRetell);
  for (const item of cards) inspect(item.card?.retell);
  return { passes, lastGap, passed: latestPassed || (passes > 0 && lastGap === null) };
}

function markPassed(mark) {
  if (!mark) return false;
  if (mark === true || typeof mark === 'string') return true;
  if (typeof mark === 'object') {
    return mark.passed === true || (Number.isFinite(mark.passes) && mark.passes > 0);
  }
  return false;
}

function companionSignalsOf(companions) {
  let slidesDone = 0;
  let checksPassed = 0;
  let verified = false;
  for (const comp of companions || []) {
    const progress = comp?.progress;
    if (!progress || typeof progress !== 'object') continue;
    const slideTotal = Math.max(0, Math.floor(Number(progress.slideTotal || comp.slideCount || 0)));
    const slide = Math.max(0, Math.floor(Number(progress.slide || 0)));
    slidesDone += progress.completed ? Math.max(slide, slideTotal) : slide;

    const results = progress.checkResults && typeof progress.checkResults === 'object' ? progress.checkResults : null;
    let compPassed = 0;
    let quizFailed = false;
    if (results) {
      for (const [key, value] of Object.entries(results)) {
        if (INTERACTIVE_CHECK_KEY.test(key) && value === true) compPassed += 1;
        if (QUIZ_CHECK_KEY.test(key) && value === false) quizFailed = true;
      }
    } else if (Number.isFinite(progress.checksPassed) && progress.checksPassed > 0) {
      compPassed = Math.floor(progress.checksPassed);
    }
    checksPassed += compPassed;
    if (!quizFailed && (compPassed > 0 || progress.completed === true)) {
      verified = true;
    }
  }
  return { slidesDone, checksPassed, verified };
}

/**
 * Compute PointEvidence for a single knowledge point (`hid`).
 */
export function evaluatePointEvidence({
  hid,
  nodeId = null,
  key = null,
  title = '',
  cards = [],
  bookRetell = null,
  confusableMark = null,
  templateMark = null,
  companions = [],
  exam = null,
  prereqIds = [],
} = {}) {
  const cardsTotal = cards.length;
  let cardsSolid = 0;
  let cardsAssistedOnly = 0;
  let slowCorrectCount = 0;
  let unseenTransferPasses = 0;
  let anyWeak = false;
  let anyAnswered = false;
  let anyIndependent = false;
  let anyHintAssisted = false;
  let anyExposedSolution = false;
  let anyPartialTransfer = false;

  for (const card of cards) {
    if (card.solid) cardsSolid += 1;
    if (card.assistedOnly) cardsAssistedOnly += 1;
    if (card.weak) anyWeak = true;
    if (card.answered || card.unverified || (card.level && card.level !== 'new')) anyAnswered = true;
    if (card.solid || (card.answered && !card.assistedOnly && !card.weak)) anyIndependent = true;
    if (card.hintAssisted) anyHintAssisted = true;
    if (card.exposedSolution) anyExposedSolution = true;
    if (card.slowCorrect > 0) slowCorrectCount += card.slowCorrect;
    if (card.unseenTransferPassed) unseenTransferPasses += 1;
    if (card.partialTransfer) anyPartialTransfer = true;
  }

  const band = exam ? examProjectionOf(cards, exam) : null;
  const solidNow = pointSolid(cards);

  let retention = 'unstarted';
  if (cardsTotal === 0 || !anyAnswered) {
    retention = 'unstarted';
  } else if (anyWeak) {
    retention = 'weak';
  } else if (cardsAssistedOnly > 0 && !anyIndependent) {
    retention = 'assisted';
  } else if (solidNow && band === 'slip') {
    retention = 'slip';
  } else if (solidNow && band !== 'weak') {
    retention = 'solid';
  } else {
    retention = 'holding';
  }

  const retell = retellInfoOf(bookRetell, cards);
  const comp = companionSignalsOf(companions);
  const confusablePassed = markPassed(confusableMark);
  let comprehension = 'unverified';
  if (retell.passed || confusablePassed || comp.verified) {
    comprehension = 'verified';
  } else if (retell.lastGap) {
    comprehension = 'gap';
  }

  const templatePassed = markPassed(templateMark);
  if (templatePassed && unseenTransferPasses === 0) unseenTransferPasses = 1;
  let transfer = 'unverified';
  if (unseenTransferPasses > 0 || templatePassed) {
    transfer = 'verified';
  } else if (anyPartialTransfer) {
    transfer = 'partial';
  }

  const facets = { retention, comprehension, transfer };
  const overall = computeOverall(facets);

  const unverifiedReasons = [];
  if (band === 'slip' || retention === 'slip') unverifiedReasons.push('exam_slip');
  if (comprehension === 'gap') unverifiedReasons.push('retell_gap');
  if (anyExposedSolution && (retention !== 'solid' || transfer !== 'verified')) unverifiedReasons.push('exposed_solution');
  if ((cardsAssistedOnly > 0 || anyHintAssisted) && (retention !== 'solid' || transfer !== 'verified')) unverifiedReasons.push('hint_assisted');
  if (retention !== 'unstarted' && transfer !== 'verified') unverifiedReasons.push('no_unseen_transfer');

  return {
    hid,
    ...(nodeId ? { nodeId } : {}),
    ...(key ? { key } : {}),
    ...(title ? { title } : {}),
    facets,
    overall,
    unverifiedReasons,
    prereqGaps: [],
    ...(prereqIds.length ? { prereqIds: [...prereqIds] } : {}),
    signals: {
      cardsTotal,
      cardsSolid,
      cardsAssistedOnly,
      slowCorrectCount,
      retellPasses: retell.passes,
      retellLastGap: retell.lastGap,
      companionSlidesDone: comp.slidesDone,
      companionChecksPassed: comp.checksPassed,
      unseenTransferPasses,
    },
    ...(band ? { examDayBand: band } : {}),
  };
}

/** Populate `prereqGaps` on each PointEvidence using 0-token lookup over direct `prereqIds`. */
export function resolvePrereqGaps(points) {
  const byHid = new Map(points.map(point => [point.hid, point]));
  const byNodeId = new Map(points.filter(point => point.nodeId).map(point => [point.nodeId, point]));
  for (const point of points) {
    const raw = Array.isArray(point.prereqIds) ? point.prereqIds : [];
    const gaps = [];
    const seen = new Set();
    for (const ref of raw) {
      const target = byHid.get(ref) || byNodeId.get(ref);
      if (!target || target.hid === point.hid || seen.has(target.hid)) continue;
      seen.add(target.hid);
      if (target.facets.retention !== 'solid' || target.facets.comprehension === 'gap') {
        gaps.push(target.hid);
      }
    }
    point.prereqGaps = gaps;
  }
  return points;
}

/**
 * Conditional single actionable hint for UI (§2.1 & §3.1.3):
 * Shown ONLY on weak or exam-near points. Never contradicts card "mastered", never exposes facet names or percentages.
 */
export function derivePointGapHint(point, { titleByHid = null, examNear = false } = {}) {
  if (!point || point.overall === 'solid') return null;
  const isWeak = point.overall === 'shaky' || point.examDayBand === 'weak' || point.examDayBand === 'slip';
  if (!isWeak && !examNear) return null;

  if (point.prereqGaps?.length > 0) {
    const targetHid = point.prereqGaps[0];
    const targetTitle = titleByHid?.get?.(targetHid) || '';
    return { kind: 'prereq', hid: point.hid, targetHid, targetTitle };
  }
  if (point.facets.retention === 'weak') return { kind: 'weak_cards', hid: point.hid };
  if (point.facets.retention === 'slip' || point.examDayBand === 'slip') return { kind: 'exam_slip', hid: point.hid };
  if (point.facets.comprehension === 'gap') return { kind: 'retell_gap', hid: point.hid };
  if (point.facets.retention === 'assisted') return { kind: 'assisted_only', hid: point.hid };
  if (point.facets.comprehension === 'unverified') return { kind: 'retell', hid: point.hid };
  if (point.facets.transfer !== 'verified') return { kind: 'transfer', hid: point.hid };
  return { kind: 'practice', hid: point.hid };
}

/** Match course companions linked to a point via `hid`, `nodeId`, `targetCardIds`, or `card.companionRef`. */
export function companionsForPoint(allCompanions, { hid, nodeId, cardIds }) {
  if (!allCompanions?.length) return [];
  const matched = [];
  for (const comp of allCompanions) {
    if (!comp || typeof comp !== 'object') continue;
    const byHid = (hid && comp.hid === hid) || (nodeId && comp.hid === nodeId);
    const byTargets = !byHid && Array.isArray(comp.targetCardIds) && comp.targetCardIds.some(id => cardIds.has(id));
    const byRef = !byHid && !byTargets && cardIds.size > 0 && comp._linkedCardIds?.some(id => cardIds.has(id));
    if (byHid || byTargets || byRef) matched.push(comp);
  }
  return matched;
}

/** Finalize a course's points list: resolve prereqGaps, attach conditional gapHint, tally summary counts. */
export function finalizeCourseEvidence({ course, basis, examDate, daysLeft, examNear, points }) {
  resolvePrereqGaps(points);
  const titleByHid = new Map(points.map(point => [point.hid, point.title || '']));
  const summary = { total: points.length, unstarted: 0, shaky: 0, in_progress: 0, solid: 0 };
  for (const point of points) {
    summary[point.overall] = (summary[point.overall] || 0) + 1;
    const hint = derivePointGapHint(point, { titleByHid, examNear });
    if (hint) point.gapHint = hint;
  }
  return {
    status: 'ok',
    course,
    basis,
    examDate,
    daysLeft,
    examNear,
    points,
    summary,
  };
}

/**
 * Browser-safe deck/topic fallback evidence summary for courses without a review book or outline
 * (also usable in `courses` context / browser without `node:crypto`).
 */
export function fallbackCourseEvidence(state, args = {}, { now = Date.now() } = {}) {
  const rawCourse = args?.course === undefined ? currentCourse(state) : args.course;
  if (rawCourse === null || rawCourse === undefined || rawCourse === '*' || typeof rawCourse !== 'string') {
    return {
      status: 'no-course',
      course: null,
      basis: 'fallback',
      examDate: null,
      daysLeft: null,
      examNear: false,
      points: [],
      summary: { total: 0, unstarted: 0, shaky: 0, in_progress: 0, solid: 0 },
    };
  }
  const course = rawCourse;
  const today = isDate(args?.date) ? args.date : localDate(new Date(now));
  const normCourse = course.trim().toLowerCase();
  const courseRec = (state?.courses || []).find(item => item && (
    item.name === course
    || (typeof item.name === 'string' && item.name.trim().toLowerCase() === normCourse)
    || (Array.isArray(item.aliases) && item.aliases.some(a => typeof a === 'string' && a.trim().toLowerCase() === normCourse))
  )) ?? null;
  const examDate = courseExamByName(state, course)?.date ?? null;
  const daysLeft = isDate(examDate) ? daysBetween(today, examDate) : null;
  const examNear = daysLeft !== null && daysLeft >= 0 && daysLeft <= crunchWindow(state?.settings?.book);
  const examCtx = daysLeft !== null && daysLeft >= 1 ? { examDate, today, settings: state?.settings } : null;

  const solidity = questionSolidity(state?.attempts, { exposures: state?.learner?.solutionExposures });
  const isFocus = stateFocusPredicate(state);
  const outcome = latestOutcomes(state?.attempts);

  const compCardLinks = new Map();
  for (const deck of decksInCourse(state, course)) {
    for (const card of deck.cards || []) {
      const cid = card?.companionRef?.companionId;
      if (cid) {
        if (!compCardLinks.has(cid)) compCardLinks.set(cid, []);
        compCardLinks.get(cid).push(card.id);
      }
    }
  }
  const courseCompanions = (Array.isArray(courseRec?.companions) ? courseRec.companions : []).map(comp => ({
    ...comp,
    _linkedCardIds: compCardLinks.get(comp?.id) || [],
  }));

  const points = [];
  for (const deck of decksInCourse(state, course)) {
    const byTopic = new Map();
    for (const card of deck.cards || []) {
      if (!card || card.suspended) continue;
      const topic = card.topic || '未分类';
      if (!byTopic.has(topic)) byTopic.set(topic, []);
      const level = cardLevel(card, outcome(deck.id, card.id));
      const sol = solidity({ deckId: deck.id, cardId: card.id, level, card });
      byTopic.get(topic).push({
        ...sol,
        deckId: deck.id,
        cardId: card.id,
        level,
        card,
        review: card.review ?? null,
        answeredForExam: level !== 'new',
        focus: isFocus(deck, card),
      });
    }
    for (const [topic, cards] of byTopic) {
      const cardIds = new Set(cards.map(item => item.cardId));
      const hid = `topic:${deck.id}:${topic}`;
      points.push(evaluatePointEvidence({
        hid,
        key: hid,
        title: topic,
        cards,
        companions: companionsForPoint(courseCompanions, { hid, cardIds }),
        exam: examCtx,
      }));
    }
  }
  return finalizeCourseEvidence({ course, basis: 'fallback', examDate, daysLeft, examNear, points });
}
