const INTENT_TTL_MS = 2 * 60 * 1000;

// One runtime owns one transport. Session IDs alone never select another owner's state.
export function createPanelBridge({ intents = new Map(), observations = new Map(), visible = new Map(),
  visibleSequences = new Map(), notifiers = new Map() } = {}) {
  function queuePanelIntent(sessionId, intent, now = Date.now()) {
    intents.set(sessionId, { ...intent, queuedAt: now, expiresAt: now + INTENT_TTL_MS });
    return { queued: true, expiresAt: new Date(now + INTENT_TTL_MS).toISOString() };
  }

  function takePanelIntent(sessionId, now = Date.now()) {
    const intent = intents.get(sessionId);
    if (!intent) return null;
    intents.delete(sessionId);
    return intent.expiresAt > now ? intent : null;
  }

  function panelObservation(sessionId) {
    if (visible.has(sessionId)) {
      const seats = visible.get(sessionId);
      return seats.sidebar?.value || seats.main?.value || null;
    }
    return observations.get(sessionId)?.value || null;
  }

  const hasPanelVisibility = (sessionId) => visible.has(sessionId);

  function setPanelVisible(sessionId, placement, run, now = Date.now(), sequence) {
    const seats = visible.get(sessionId) || { main: null, sidebar: null };
    const where = placement === "sidebar" ? "sidebar" : "main";
    const key = `${sessionId}\0${where}`;
    if (Number.isSafeInteger(sequence)) {
      if (sequence <= (visibleSequences.get(key) || 0)) return panelObservation(sessionId);
      visibleSequences.set(key, sequence);
    }
    seats[where] = run ? { value: observePanelReview(sessionId, "review.visible", run, now) } : null;
    visible.set(sessionId, seats);
    return panelObservation(sessionId);
  }

  function registerPanelNotifier(sessionId, notify) {
    if (typeof notify === "function") notifiers.set(sessionId, notify);
  }

  function observePanelReview(sessionId, action, run, now = Date.now()) {
    if (!run || typeof run !== "object" || !action.startsWith("review.")) return null;
    const value = {
      runId: run.id || null,
      deckId: run.deckId || null,
      cardId: run.card?.id || null,
      index: run.index ?? null,
      total: run.total ?? null,
      mode: run.mode || null,
      selected: run.feedback?.selected || (run.mode === "exam"
        ? run.picks?.find((pick) => pick.cardId === run.card?.id)?.selected || null : null),
      correct: run.feedback?.correct ?? null,
      grade: run.feedback?.grade ?? null,
      revealed: !!run.revealed,
      complete: !!run.complete,
      observedAt: new Date(now).toISOString(),
    };
    const signature = JSON.stringify([value.runId, value.cardId, value.index,
      value.selected, value.correct, value.grade, value.revealed, value.complete]);
    const previous = observations.get(sessionId);
    observations.set(sessionId, { value, signature });
    // Plugin notices are queued for the agent's next step; they do not start a turn.
    if (signature !== previous?.signature && notifiers.has(sessionId)) {
      const summary = value.complete ? "学习轮次结束" : value.correct === null
        ? "当前题已切换" : "已记录本题作答";
      notifiers.get(sessionId)({
        text: `StudyHub 状态（被动上下文，不要主动打断用户）：${JSON.stringify(value)}`,
        summary,
      });
    }
    return value;
  }
  return Object.freeze({ queuePanelIntent, takePanelIntent, panelObservation, hasPanelVisibility,
    setPanelVisible, registerPanelNotifier, observePanelReview,
    clear() { for (const map of [intents, observations, visible, visibleSequences, notifiers]) map.clear(); },
  });
}

// Standalone low-level consumers retain their API; built-in contexts inject their own bridge.
export const { queuePanelIntent, takePanelIntent, panelObservation, hasPanelVisibility,
  setPanelVisible, registerPanelNotifier, observePanelReview } = createPanelBridge();
