import { computeSessionProgress } from './study-progress.js';

export const MAX_SCENE_PROMPT_CHARS = 600;
export const MAX_RECENT_ATTEMPTS = 5;

/**
 * Builds a compact, bounded study scene projection from frozen viewState.
 * Zero-copy, strictly bounded <= 4 KB.
 */
export function buildCompactScene(viewState = {}, options = {}) {
  const sessions = viewState.studySessions || [];
  const sessionId = options.sessionId;
  const session = sessionId
    ? sessions.find((s) => s.id === sessionId)
    : sessions.at(-1) || null;

  const runs = viewState.runs || [];
  const attempts = viewState.attempts || [];

  // Locate active run and card
  let activeRun = null;
  if (session?.focus?.runId) {
    activeRun = runs.find((r) => r.id === session.focus.runId) || null;
  }
  if (!activeRun && runs.length > 0) {
    activeRun = runs.filter((r) => !r.closedAt).at(-1) || runs.at(-1);
  }

  const currentEntry = activeRun && activeRun.entries ? activeRun.entries[activeRun.index] : null;
  const currentCard = currentEntry?.card || null;

  // Build compact focusObject
  let focusObject = null;
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

    const revealed = !!currentEntry?.revealed;
    // Sanitized options: hide correct answer if not revealed
    const optionsList = Array.isArray(currentCard?.options)
      ? currentCard.options.map((opt) => ({
          id: opt.id,
          text: opt.text,
          ...(revealed ? { correct: !!opt.correct } : {}),
        }))
      : [];

    focusObject = {
      kind: 'card',
      deckId: currentEntry?.deckId ?? activeRun?.deckId ?? session?.focus?.deckId ?? null,
      cardId: currentCard?.id ?? session?.focus?.id ?? null,
      runId: activeRun?.id ?? null,
      cardKind: currentCard?.kind ?? 'quiz',
      topic: currentCard?.topic ?? null,
      prompt,
      truncated: isTruncated,
      options: optionsList,
      revealed,
      draft: currentEntry?.draft || null,
      hintUsed: !!currentEntry?.assistance?.hintUsed,
      ...(revealed ? { explanation: currentCard?.explanation } : {}),
    };
  }

  // Filter recent attempts for current card or session (max 5)
  const targetCardId = focusObject?.kind === 'card' ? focusObject.cardId : null;
  const filteredAttempts = targetCardId
    ? attempts.filter((a) => a.quiz_id === targetCardId)
    : attempts;

  const recentAttempts = filteredAttempts.slice(-MAX_RECENT_ATTEMPTS).map((att) => ({
    id: att.id,
    at: att.timestamp,
    correct: att.correct ?? (typeof att.grade === 'number' && att.grade >= 3),
    grade: att.grade,
    selected: att.feedback?.selected ?? null,
    assistance: att.assistance || { used: false },
  }));

  // Related QA references on current card
  let relatedQARefs = [];
  if (currentCard && Array.isArray(currentCard.followups)) {
    relatedQARefs = currentCard.followups.slice(0, 5).map((f) => ({
      id: f.id,
      question: f.question ? f.question.slice(0, 100) : '',
      source: f.source || 'user',
      updatedAt: f.at || f.updatedAt,
    }));
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

  // Compute lightweight deterministic fingerprint
  const latestAttempt = attempts.at(-1);
  const latestAttemptAt = latestAttempt?.timestamp || 0;
  const panelSig = options.panelObservation?.signature || '';
  const fingerprint = `v${session?.version || 0}:q${activeRun?.queueVersion || 0}:a${latestAttemptAt}:p${panelSig}`;

  if (options.sinceFingerprint && options.sinceFingerprint === fingerprint) {
    return {
      unchanged: true,
      fingerprint,
    };
  }

  return {
    unchanged: false,
    session: sessionSummary,
    focusObject,
    recentAttempts,
    relatedQARefs,
    progressSummary,
    fingerprint,
  };
}
