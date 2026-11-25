/* Zero-copy personal Trap Ledger projection for `study.scene.get` (StudyHub 5.0.0 Evolution 4).
   Pure, 0-token, browser-safe, read-only over frozen viewState.
   Strictly separates non-spoiling `cue` data from tier-gated `hint` and `full` content. */

import { courseKey } from '../../courses.js';
import { TRIAGE_REASONS } from '../../evidence/mistake-triage.js';
import { isMasteryAttempt, isUnverifiedSelfReport } from '../../mastery.js';
import {
  clipText,
  collectCatchupAndDoubts,
  collectConfusableTraps,
  collectQaTraps,
  indexTrapSources,
  pushUnique,
} from './trap-sources.js';

export const TRAP_ERROR_REASONS = TRIAGE_REASONS;
const REASON_SET = new Set(TRAP_ERROR_REASONS);
const SLOW_SOLO_MS = 60_000;

function collectAttemptTraps(attempts, targetId, card) {
  const opts = Array.isArray(card?.options) ? card.options : [];
  const correctOptIds = new Set(opts.filter(o => o?.correct === true).map(o => o.id));
  const optTextById = new Map(opts.map(o => [o.id, clipText(o.text, 50)]));
  let failedCount = 0;
  let slowCorrectCount = 0;
  let latestErrorReason = null;
  const errorReasons = {};
  const thinkingNotes = [];
  const wrongChoices = [];
  const list = Array.isArray(attempts) ? attempts : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const att = list[i];
    if (!att || (att.quiz_id !== targetId && att.cardId !== targetId)) continue;
    if (!isMasteryAttempt(att) || isUnverifiedSelfReport(att)) continue;
    const right = Number.isFinite(att.grade) ? att.grade >= 3 : att.correct === true;
    if (right) {
      if (att.slowCorrect === true || att.hesitant === true || (att.assessment !== 'oral' && Number.isFinite(att.elapsed_ms) && att.elapsed_ms >= SLOW_SOLO_MS)) {
        slowCorrectCount += 1;
      }
    } else {
      failedCount += 1;
      const sel = Array.isArray(att.selected) ? att.selected : Array.isArray(att.feedback?.selected) ? att.feedback.selected : [];
      for (const optId of sel) {
        if (correctOptIds.has(optId)) continue;
        pushUnique(wrongChoices, optTextById.get(optId) || clipText(optId, 40), 3);
      }
    }
    if (REASON_SET.has(att.errorReason)) {
      errorReasons[att.errorReason] = (errorReasons[att.errorReason] || 0) + 1;
      if (!latestErrorReason) latestErrorReason = att.errorReason;
    }
    if (typeof att.thinkingNote === 'string' && att.thinkingNote.trim()) {
      pushUnique(thinkingNotes, clipText(att.thinkingNote, 120), 2);
    }
  }
  return { failedCount, slowCorrectCount, latestErrorReason, errorReasons, thinkingNotes, wrongChoices };
}

function buildCueSummary({ hid, failedCount, errorReasons, slowCorrectCount, confusableIds, pitfallCount, doubtCount, catchupCount }) {
  const parts = [];
  if (failedCount > 0) {
    const tags = Object.entries(errorReasons).map(([k, v]) => `${k}x${v}`).join(', ');
    parts.push(tags ? `failed ${failedCount}x (${tags})` : `failed ${failedCount}x`);
  }
  if (slowCorrectCount > 0) parts.push(`slow-correct ${slowCorrectCount}x`);
  if (confusableIds.length) parts.push(`confusable ${confusableIds.join('/')}`);
  if (pitfallCount > 0) parts.push(`${pitfallCount} pitfall${pitfallCount > 1 ? 's' : ''}`);
  if (doubtCount > 0) parts.push(`${doubtCount} doubt${doubtCount > 1 ? 's' : ''}`);
  if (catchupCount > 0) parts.push(`${catchupCount} catchup${catchupCount > 1 ? 's' : ''}`);
  if (!parts.length) return '';
  const prefix = hid && !String(hid).startsWith('topic:') && !String(hid).startsWith('doc:') ? `${hid}: ` : '';
  return clipText(`${prefix}${parts.join('; ')}`, 180);
}

/**
 * Project personal trap ledger for the active card/hid from frozen viewState (zero-copy, 0-token).
 * Returns `{ hasTraps, hid, cue, hint, full }` with strict anti-spoiling tier separation.
 */
export function projectTrapLedger(viewState = {}, { card, cardId, hid = null, course = '' } = {}) {
  const targetId = card?.id || cardId || null;
  const emptyCue = {
    trapCue: '', failedCount: 0, errorReasons: {}, latestErrorReason: null, thinkingNotes: [],
    slowCorrectCount: 0, wrongChoices: [], confusableIds: [], confusablePairs: [],
    qaQuestions: [], pitfallCount: 0, doubtCount: 0, doubtCues: [], catchupCount: 0, catchupCues: [],
  };
  const empty = {
    hasTraps: false, hid, cue: emptyCue,
    hint: { cardHint: '', pitfalls: [], confusableMistakes: [] },
    full: { qaAnswers: [], answerCardConclusion: '', confusableComparisons: [], doubtAnswers: [], catchupAnswers: [] },
  };
  if (!targetId) return empty;

  const att = collectAttemptTraps(viewState.attempts, targetId, card);
  const srcIdx = indexTrapSources(viewState.sources);
  const cKey = courseKey(course);
  const bookSrc = cKey ? srcIdx.books.get(cKey) : null;
  const qa = collectQaTraps({ card, targetId, hid, bookSrc });
  const rawPitfalls = Array.isArray(card?.answerCard?.pitfalls) ? card.answerCard.pitfalls : [];
  const pitfalls = rawPitfalls.map(p => clipText(p, 110)).filter(Boolean).slice(0, 2);
  const answerCardConclusion = clipText(card?.answerCard?.conclusion, 220);
  const conf = collectConfusableTraps({
    notesSrc: cKey ? srcIdx.notes.get(cKey) : null,
    outlineSrc: cKey ? srcIdx.outlines.get(cKey) : null,
    hid, card,
  });
  const extra = collectCatchupAndDoubts({ viewState, srcIdx, card, targetId, cKey });

  const pitfallCount = pitfalls.length;
  const trapCue = buildCueSummary({
    hid, failedCount: att.failedCount, errorReasons: att.errorReasons,
    slowCorrectCount: att.slowCorrectCount, confusableIds: conf.confusableIds,
    pitfallCount, doubtCount: extra.doubtCount, catchupCount: extra.catchupCount,
  });
  const hasTraps = Boolean(trapCue || att.thinkingNotes.length || att.wrongChoices.length || qa.qaQuestions.length);

  return {
    hasTraps,
    hid,
    cue: {
      trapCue,
      failedCount: att.failedCount,
      errorReasons: att.errorReasons,
      latestErrorReason: att.latestErrorReason,
      thinkingNotes: att.thinkingNotes,
      slowCorrectCount: att.slowCorrectCount,
      wrongChoices: att.wrongChoices,
      confusableIds: conf.confusableIds,
      confusablePairs: conf.confusablePairs,
      qaQuestions: qa.qaQuestions,
      pitfallCount,
      doubtCount: extra.doubtCount,
      doubtCues: extra.doubtCues,
      catchupCount: extra.catchupCount,
      catchupCues: extra.catchupCues,
    },
    hint: { cardHint: clipText(card?.hint, 140), pitfalls, confusableMistakes: conf.confusableMistakes },
    full: {
      qaAnswers: qa.qaAnswers,
      answerCardConclusion,
      confusableComparisons: conf.confusableComparisons,
      doubtAnswers: extra.doubtAnswers,
      catchupAnswers: extra.catchupAnswers,
    },
  };
}
