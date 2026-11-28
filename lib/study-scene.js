import { assistanceEvidence, computeSessionProgress } from './study-progress.js';
import { isActiveAttempt } from './mastery.js';
import { sceneDraft } from './review-draft.js';
import { pointEvidenceForCard } from './evidence/course-evidence.js';
import { TRIAGE_REASONS } from './evidence/mistake-triage.js';
import { cardExposureStatus } from './solution-exposure.js';

export const MAX_SCENE_PROMPT_CHARS = 600;
export const MAX_RECENT_ATTEMPTS = 5;
export const MAX_SCENE_BYTES = 4096;

const ERROR_REASONS = new Set(TRIAGE_REASONS);
const SLOW_SOLO_MS = 60_000;
const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const utf8Bytes = text => (encoder ? encoder.encode(text).length : text.length * 3);
const clip = (val, max) => {
  const text = String(val ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}...` : text;
};

/** Resolve explicit disclosure escalation requested by caller (`'full' | 'hint' | null`). */
export function requestedDisclosureEscalation(options = {}) {
  if (!options || typeof options !== 'object') return null;
  if (
    options.releaseAnswer === true ||
    options.explicitRelease === true ||
    options.disclosureTier === 'full' ||
    Number(options.hintTier) >= 2
  ) return 'full';
  if (
    options.disclosureTier === 'hint' ||
    options.hintTier === 'hint' ||
    Number(options.hintTier) === 1
  ) return 'hint';
  return null;
}

/** Deterministic disclosure tier gate: `'cue_only' | 'hint' | 'full'`. Active exams never disclose. */
export function resolveDisclosureTier({ revealed = false, isActiveExam = false, options = {} } = {}) {
  if (isActiveExam) return 'cue_only';
  if (revealed) return 'full';
  if (options?.assistanceReceipt?.denied === true || options?.assistanceReceipt?.recorded === false) return 'cue_only';
  return requestedDisclosureEscalation(options) || 'cue_only';
}

function fallbackTrapProjection(card, filteredAttempts, hid) {
  const opts = Array.isArray(card?.options) ? card.options : [];
  const correctOptIds = new Set(opts.filter(o => o?.correct === true).map(o => o.id));
  const optTextById = new Map(opts.map(o => [o.id, clip(o.text, 50)]));
  let failedCount = 0;
  let slowCorrectCount = 0;
  let latestErrorReason = null;
  const errorReasons = {};
  const thinkingNotes = [];
  const wrongChoices = [];
  for (let i = filteredAttempts.length - 1; i >= 0; i--) {
    const att = filteredAttempts[i];
    const selfReported = !!(att.selfReported || att.unverified || att.assessment === 'self-report');
    if (selfReported) continue;
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
        const label = optTextById.get(optId) || clip(optId, 40);
        if (label && wrongChoices.length < 3 && !wrongChoices.includes(label)) wrongChoices.push(label);
      }
    }
    if (ERROR_REASONS.has(att.errorReason)) {
      errorReasons[att.errorReason] = (errorReasons[att.errorReason] || 0) + 1;
      if (!latestErrorReason) latestErrorReason = att.errorReason;
    }
    if (typeof att.thinkingNote === 'string' && att.thinkingNote.trim()) {
      const note = clip(att.thinkingNote, 120);
      if (thinkingNotes.length < 2 && !thinkingNotes.includes(note)) thinkingNotes.push(note);
    }
  }
  const followups = Array.isArray(card?.followups) ? card.followups : [];
  const qaQuestions = followups.map(f => clip(f?.question, 90)).filter(Boolean).slice(0, 3);
  const qaAnswers = followups
    .map(f => ({ question: clip(f?.question, 80), answer: clip(f?.answer, 220) }))
    .filter(item => item.question && item.answer)
    .slice(0, 2);
  const pitfalls = (Array.isArray(card?.answerCard?.pitfalls) ? card.answerCard.pitfalls : [])
    .map(p => clip(p, 110))
    .filter(Boolean)
    .slice(0, 2);
  const answerCardConclusion = clip(card?.answerCard?.conclusion, 220);
  const parts = [];
  if (failedCount > 0) {
    const tags = Object.entries(errorReasons).map(([k, v]) => `${k}x${v}`).join(', ');
    parts.push(tags ? `failed ${failedCount}x (${tags})` : `failed ${failedCount}x`);
  }
  if (slowCorrectCount > 0) parts.push(`slow-correct ${slowCorrectCount}x`);
  if (pitfalls.length) parts.push(`${pitfalls.length} pitfall${pitfalls.length > 1 ? 's' : ''}`);
  const prefix = hid && !String(hid).startsWith('topic:') && !String(hid).startsWith('doc:') ? `${hid}: ` : '';
  const trapCue = parts.length ? clip(`${prefix}${parts.join('; ')}`, 180) : '';
  const hasTraps = Boolean(trapCue || thinkingNotes.length || wrongChoices.length || qaQuestions.length);
  return {
    hasTraps,
    hid,
    cue: {
      trapCue, failedCount, errorReasons, latestErrorReason, thinkingNotes, slowCorrectCount,
      wrongChoices, confusableIds: [], confusablePairs: [], qaQuestions,
      pitfallCount: pitfalls.length, doubtCount: 0, doubtCues: [], catchupCount: 0, catchupCues: [],
    },
    hint: { cardHint: clip(card?.hint, 140), pitfalls, confusableMistakes: [] },
    full: { qaAnswers, answerCardConclusion, confusableComparisons: [], doubtAnswers: [], catchupAnswers: [] },
  };
}

function buildTieredTrapLedger(raw, { tier, exposed }) {
  const cue = raw?.cue || {};
  const ledger = {
    disclosureTier: tier,
    cueOnly: tier === 'cue_only',
    hasTraps: !!raw?.hasTraps,
    solutionExposed: !!exposed,
    trapCue: cue.trapCue || '',
    failedCount: cue.failedCount || 0,
    ...(cue.errorReasons && Object.keys(cue.errorReasons).length ? { errorReasons: { ...cue.errorReasons } } : {}),
    ...(cue.latestErrorReason ? { latestErrorReason: cue.latestErrorReason } : {}),
    ...(cue.thinkingNotes?.length ? { thinkingNotes: [...cue.thinkingNotes] } : {}),
    ...(cue.slowCorrectCount ? { slowCorrectCount: cue.slowCorrectCount } : {}),
    ...(cue.wrongChoices?.length ? { wrongChoices: [...cue.wrongChoices] } : {}),
    ...(cue.confusableIds?.length ? { confusableIds: [...cue.confusableIds] } : {}),
    ...(cue.confusablePairs?.length ? { confusablePairs: cue.confusablePairs.map(p => ({ id: p.id, names: [...(p.names || [])] })) } : {}),
    ...(cue.pitfallCount ? { pitfallCount: cue.pitfallCount } : {}),
    ...(cue.doubtCount ? { doubtCount: cue.doubtCount, doubtCues: [...(cue.doubtCues || [])] } : {}),
    ...(cue.catchupCount ? { catchupCount: cue.catchupCount, catchupCues: [...(cue.catchupCues || [])] } : {}),
  };
  if (tier === 'hint' || tier === 'full') {
    const h = raw?.hint || {};
    const hintBlock = {
      ...(h.cardHint ? { cardHint: h.cardHint } : {}),
      ...(h.pitfalls?.length ? { pitfalls: [...h.pitfalls] } : {}),
      ...(h.confusableMistakes?.length ? { confusableMistakes: h.confusableMistakes.map(m => ({ id: m.id, mistake: [...(m.mistake || [])] })) } : {}),
    };
    if (Object.keys(hintBlock).length) ledger.hint = hintBlock;
  }
  if (tier === 'full') {
    const f = raw?.full || {};
    const fullBlock = {
      ...(f.qaAnswers?.length ? { qaAnswers: f.qaAnswers.map(a => ({ question: a.question, answer: a.answer })) } : {}),
      ...(f.answerCardConclusion ? { answerCardConclusion: f.answerCardConclusion } : {}),
      ...(f.confusableComparisons?.length ? { confusableComparisons: f.confusableComparisons.map(c => ({ ...c })) } : {}),
      ...(f.doubtAnswers?.length ? { doubtAnswers: f.doubtAnswers.map(d => ({ question: d.question, answer: d.answer })) } : {}),
      ...(f.catchupAnswers?.length ? { catchupAnswers: f.catchupAnswers.map(c => ({ prompt: c.prompt, answer: c.answer })) } : {}),
    };
    if (Object.keys(fullBlock).length) ledger.full = fullBlock;
  }
  return ledger;
}

function fitSceneBudget(scene) {
  if (utf8Bytes(JSON.stringify(scene)) <= MAX_SCENE_BYTES) return scene;
  const trimSteps = [
    () => { if (scene.trapLedger?.full) { delete scene.trapLedger.full.doubtAnswers; delete scene.trapLedger.full.catchupAnswers; } },
    () => { if (scene.trapLedger?.full?.confusableComparisons) scene.trapLedger.full.confusableComparisons = scene.trapLedger.full.confusableComparisons.slice(0, 1); },
    () => { if (scene.trapLedger?.full?.qaAnswers) scene.trapLedger.full.qaAnswers = scene.trapLedger.full.qaAnswers.slice(0, 1).map(q => ({ question: clip(q.question, 60), answer: clip(q.answer, 120) })); },
    () => { if (scene.trapLedger?.full?.answerCardConclusion) scene.trapLedger.full.answerCardConclusion = clip(scene.trapLedger.full.answerCardConclusion, 120); },
    () => { if (scene.trapLedger?.full) delete scene.trapLedger.full.confusableComparisons; },
    () => { if (scene.trapLedger?.hint?.confusableMistakes) delete scene.trapLedger.hint.confusableMistakes; },
    () => { if (scene.trapLedger?.hint?.pitfalls) scene.trapLedger.hint.pitfalls = scene.trapLedger.hint.pitfalls.slice(0, 1).map(p => clip(p, 70)); },
    () => { if (scene.focusObject?.explanation) scene.focusObject.explanation = clip(scene.focusObject.explanation, 160); },
    () => { if (scene.focusObject?.answer) scene.focusObject.answer = clip(scene.focusObject.answer, 140); },
    () => { if (scene.trapLedger) { delete scene.trapLedger.doubtCues; delete scene.trapLedger.catchupCues; delete scene.trapLedger.confusablePairs; } },
    () => { if (scene.trapLedger?.thinkingNotes) scene.trapLedger.thinkingNotes = scene.trapLedger.thinkingNotes.slice(0, 1).map(n => clip(n, 70)); },
    () => { if (scene.trapLedger?.wrongChoices) scene.trapLedger.wrongChoices = scene.trapLedger.wrongChoices.slice(0, 2).map(w => clip(w, 30)); },
    () => { if (Array.isArray(scene.relatedQARefs) && scene.relatedQARefs.length > 2) scene.relatedQARefs = scene.relatedQARefs.slice(0, 2); },
    () => { if (Array.isArray(scene.recentAttempts)) scene.recentAttempts = scene.recentAttempts.slice(-3).map(({ thinkingNote: _tn, ...rest }) => rest); },
    () => { if (scene.trapLedger?.full) delete scene.trapLedger.full; },
    () => { if (scene.trapLedger?.hint) delete scene.trapLedger.hint; },
    () => { if (Array.isArray(scene.relatedQARefs)) scene.relatedQARefs = []; },
    () => { if (scene.focusObject?.draft) scene.focusObject.draft = null; },
    () => { if (Array.isArray(scene.recentAttempts) && scene.recentAttempts.length > 1) scene.recentAttempts = scene.recentAttempts.slice(-1); },
    () => { if (scene.focusObject?.prompt && scene.focusObject.prompt.length > 240) { scene.focusObject.prompt = `${scene.focusObject.prompt.slice(0, 237)}...`; scene.focusObject.truncated = true; } },
    () => { if (Array.isArray(scene.focusObject?.options)) scene.focusObject.options = scene.focusObject.options.map(o => ({ ...o, text: clip(o.text, 50) })); },
    () => { if (scene.focusObject?.explanation) scene.focusObject.explanation = clip(scene.focusObject.explanation, 80); if (scene.focusObject?.answer) scene.focusObject.answer = clip(scene.focusObject.answer, 80); },
    () => { if (scene.focusObject?.prompt && scene.focusObject.prompt.length > 120) { scene.focusObject.prompt = `${scene.focusObject.prompt.slice(0, 117)}...`; scene.focusObject.truncated = true; } },
  ];
  for (const step of trimSteps) {
    step();
    if (utf8Bytes(JSON.stringify(scene)) <= MAX_SCENE_BYTES) break;
  }
  return scene;
}

/**
 * Builds a compact, bounded study scene projection from frozen viewState.
 * Zero-copy, anti-spoiling gated, strictly bounded <= 4 KB (4096 UTF-8 bytes).
 */
export function buildCompactScene(viewState = {}, options = {}) {
  const sessions = viewState.studySessions || [];
  const sessionId = options.sessionId;
  const session = sessionId
    ? sessions.find((s) => s.id === sessionId)
    : sessions.at(-1) || null;

  const runs = viewState.runs || [];
  const attempts = viewState.attempts || [];

  // Locate active run and card (scan backwards to avoid allocating a filtered runs copy)
  let activeRun = null;
  if (session?.focus?.runId) {
    activeRun = runs.find((r) => r.id === session.focus.runId) || null;
  }
  if (!activeRun && runs.length > 0) {
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      if (!runs[i]?.closedAt) {
        activeRun = runs[i];
        break;
      }
    }
    if (!activeRun) activeRun = runs[runs.length - 1];
  }

  const currentEntry = activeRun && activeRun.entries ? activeRun.entries[activeRun.index] : null;
  const currentCard = currentEntry?.card || null;
  const isActiveExam = activeRun?.mode === 'exam' && !activeRun?.submittedAt;
  const revealed = !!currentEntry?.revealed;
  const disclosureTier = resolveDisclosureTier({ revealed, isActiveExam, options });
  const canRevealAnswer = disclosureTier === 'full';
  const receipt = options.assistanceReceipt || null;

  // Build compact focusObject
  let focusObject = null;
  let compactEv = null;
  let focusDeckId = null;
  let focusCardId = null;
  if (session?.focus?.kind === 'artifact') {
    const art = session.artifactRefs?.find((a) => a.id === session.focus.id);
    if (art) {
      focusObject = {
        kind: 'artifact',
        id: art.id,
        title: art.title,
        artifactKind: art.kind,
        topic: art.topic || null,
        sourceAnchors: art.sourceAnchors || [],
        markdown: art.markdown ? art.markdown.slice(0, MAX_SCENE_PROMPT_CHARS) : '',
      };
    }
  } else if (currentCard || session?.focus?.kind === 'card') {
    const rawPrompt = String(currentCard?.prompt || '');
    const isTruncated = rawPrompt.length > MAX_SCENE_PROMPT_CHARS;
    const prompt = isTruncated ? rawPrompt.slice(0, MAX_SCENE_PROMPT_CHARS) + '...' : rawPrompt;

    // Sanitized options: hide correct answer unless disclosureTier === 'full'
    const optionsList = Array.isArray(currentCard?.options)
      ? currentCard.options.map((opt) => ({
          id: opt.id,
          text: opt.text,
          ...(canRevealAnswer ? { correct: !!opt.correct } : {}),
        }))
      : [];

    focusDeckId = currentEntry?.deckId ?? activeRun?.deckId ?? session?.focus?.deckId ?? null;
    focusCardId = currentCard?.id ?? session?.focus?.id ?? null;
    const cardEv = options.cardEvidence !== undefined
      ? options.cardEvidence
      : (focusDeckId && focusCardId
        ? pointEvidenceForCard(viewState, { deckId: focusDeckId, cardId: focusCardId, outlineOnly: true })
        : null);
    compactEv = cardEv && !String(cardEv.hid).startsWith('topic:') && !String(cardEv.hid).startsWith('doc:')
      ? { hid: cardEv.hid, facets: cardEv.facets, overall: cardEv.overall, prereqGaps: cardEv.prereqGaps }
      : null;

    const entryAssist = assistanceEvidence(currentEntry?.assistance, receipt?.assistance);
    const escalatedBeforeAnswer = !revealed && !isActiveExam && (disclosureTier === 'hint' || disclosureTier === 'full');

    focusObject = {
      kind: 'card',
      deckId: focusDeckId,
      cardId: focusCardId,
      runId: activeRun?.id ?? null,
      cardKind: currentCard?.kind ?? 'quiz',
      topic: currentCard?.topic ?? null,
      prompt,
      truncated: isTruncated,
      options: optionsList,
      revealed,
      disclosureTier,
      ...(({ draft, draftTruncated }) => ({ draft, ...(draftTruncated ? { draftTruncated } : {}) }))(sceneDraft(currentEntry?.draft)),
      hintUsed: !!(entryAssist.hintUsed || (escalatedBeforeAnswer && disclosureTier === 'hint')),
      ...(entryAssist.askedTutorBeforeAnswer || escalatedBeforeAnswer ? { askedTutorBeforeAnswer: true } : {}),
      ...(canRevealAnswer && currentCard?.answer ? { answer: clip(currentCard.answer, 280) } : {}),
      ...(canRevealAnswer && currentCard?.explanation !== undefined ? { explanation: clip(currentCard.explanation, 360) } : {}),
      ...(compactEv ? { pointEvidence: compactEv } : {}),
    };
  }

  // Filter recent attempts for current card or session (max 5); sanitize `selected` before reveal so prior right or partial-right selections never leak correct option IDs.
  // When targeting a specific card, check `quiz_id` first in one pass so non-matching attempts skip predicate calls and avoid an intermediate full-history copy.
  // When no card is focused, trapLedger is unused so scanning backwards stops after collecting MAX_RECENT_ATTEMPTS.
  const targetCardId = focusObject?.kind === 'card' ? focusObject.cardId : null;
  let filteredAttempts;
  if (targetCardId) {
    filteredAttempts = [];
    for (let i = 0; i < attempts.length; i += 1) {
      const att = attempts[i];
      if (att && att.quiz_id === targetCardId && isActiveAttempt(att)) {
        filteredAttempts.push(att);
      }
    }
  } else {
    filteredAttempts = [];
    for (let i = attempts.length - 1; i >= 0 && filteredAttempts.length < MAX_RECENT_ATTEMPTS; i -= 1) {
      const att = attempts[i];
      if (att && isActiveAttempt(att)) {
        filteredAttempts.push(att);
      }
    }
    filteredAttempts.reverse();
  }
  const correctOptIds = new Set(
    (Array.isArray(currentCard?.options) ? currentCard.options : [])
      .filter((o) => o?.correct === true)
      .map((o) => o.id),
  );

  const recentAttempts = filteredAttempts.slice(-MAX_RECENT_ATTEMPTS).map((att) => {
    const selfReported = !!(att.selfReported || att.unverified || att.assessment === 'self-report');
    const isCorrect = selfReported ? false : (att.correct ?? (typeof att.grade === 'number' && att.grade >= 3));
    const rawSelected = att.feedback?.selected ?? null;
    let selected = rawSelected;
    if (!canRevealAnswer && targetCardId && att.quiz_id === targetCardId) {
      if (isCorrect) {
        selected = null;
      } else if (Array.isArray(rawSelected)) {
        const wrongOnly = rawSelected.filter((id) => !correctOptIds.has(id));
        selected = wrongOnly.length ? wrongOnly : null;
      } else {
        selected = null;
      }
    }
    return {
      id: att.id,
      at: att.timestamp,
      correct: isCorrect,
      ...(att.assessment ? { assessment: att.assessment } : {}),
      ...(selfReported ? { selfReported: true, unverified: true } : {}),
      grade: att.grade,
      selected,
      ...(ERROR_REASONS.has(att.errorReason) ? { errorReason: att.errorReason } : {}),
      ...(typeof att.thinkingNote === 'string' && att.thinkingNote.trim() ? { thinkingNote: clip(att.thinkingNote, 100) } : {}),
      assistance: att.assistance || { used: false },
    };
  });

  // Related QA references on current card (question only, never answer)
  let relatedQARefs = [];
  if (currentCard && Array.isArray(currentCard.followups)) {
    relatedQARefs = currentCard.followups.slice(0, 5).map((f) => ({
      id: f.id,
      question: f.question ? f.question.slice(0, 100) : '',
      source: f.source || 'user',
      updatedAt: f.at || f.updatedAt,
    }));
  }

  // Tier-gated Trap Ledger (anti-spoiling contract)
  let trapLedger = null;
  if (focusObject?.kind === 'card') {
    const deck = focusDeckId ? (viewState.decks || []).find(d => d?.id === focusDeckId) : null;
    const exposure = cardExposureStatus(viewState.learner?.solutionExposures, {
      cardId: focusCardId,
      deckId: focusDeckId,
      draftId: focusDeckId,
      jobId: deck?.editorial?.generation?.runId,
    });
    const rawTrap = options.trapData || fallbackTrapProjection(currentCard, filteredAttempts, compactEv?.hid || null);
    trapLedger = buildTieredTrapLedger(rawTrap, { tier: disclosureTier, exposed: exposure.exposed });
  }

  // Assistance receipt when explicitly escalating before answering
  let assistanceReceipt = receipt;
  if (!assistanceReceipt && focusObject?.kind === 'card' && !revealed && !isActiveExam && (disclosureTier === 'hint' || disclosureTier === 'full')) {
    assistanceReceipt = {
      recorded: false,
      required: true,
      runId: activeRun?.id ?? null,
      cardId: focusCardId,
      disclosureTier,
      assistance: assistanceEvidence(
        currentEntry?.assistance,
        disclosureTier === 'hint' ? { askedTutorBeforeAnswer: true, hintUsed: true } : { askedTutorBeforeAnswer: true },
      ),
    };
  }

  // Progress summary
  let progressSummary = null;
  if (session) {
    const fullProgress = computeSessionProgress(session, attempts);
    progressSummary = {
      independentPassedCount: fullProgress.independentPassedCount,
      assistedCount: fullProgress.assistedCount,
      pendingCount: fullProgress.pendingCount,
      needsReviewCount: fullProgress.needsReviewCount,
      totalCount: fullProgress.totalCount,
      independentRatio: fullProgress.independentRatio,
      displayLine: fullProgress.displayLine,
    };
  }

  // Session summary
  const sessionSummary = session
    ? {
        id: session.id,
        courseId: session.courseId,
        scope: session.scope || [],
        goal: session.goal
          ? { title: session.goal.title, checkItemCount: session.goal.checkItems?.length || 0 }
          : null,
        settings: session.settings || {},
        status: session.status,
        version: session.version,
        returnPathDepth: session.returnPath?.length || 0,
      }
    : null;

  // Compute lightweight deterministic fingerprint (includes reveal & disclosure tier)
  const latestAttempt = attempts.at(-1);
  const latestAttemptAt = latestAttempt?.timestamp || 0;
  const panelSig = options.panelObservation?.signature || '';
  const fingerprint = `v${session?.version || 0}:q${activeRun?.queueVersion || 0}:a${latestAttemptAt}:r${revealed ? 1 : 0}:d${disclosureTier}:p${panelSig}`;

  if (options.sinceFingerprint && options.sinceFingerprint === fingerprint && !assistanceReceipt) {
    return {
      unchanged: true,
      fingerprint,
    };
  }

  const scene = {
    unchanged: false,
    session: sessionSummary,
    focusObject,
    recentAttempts,
    relatedQARefs,
    ...(trapLedger ? { trapLedger } : {}),
    ...(assistanceReceipt ? { assistanceReceipt } : {}),
    progressSummary,
    fingerprint,
  };
  return fitSceneBudget(scene);
}
