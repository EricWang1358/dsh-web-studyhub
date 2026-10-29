const INTENT_TTL_MS = 2 * 60 * 1000;

// One runtime owns one transport. Session IDs alone never select another owner's state.
export function createPanelBridge({
  intents = new Map(),
  observations = new Map(),
  visible = new Map(),
  visibleSequences = new Map(),
  notifiers = new Map(),
  intentSequences = new Map(),
  ackResolvers = new Map(),
  latestAcks = new Map(),
} = {}) {
  function queuePanelIntent(sessionId, intent, now = Date.now()) {
    const seq = (intentSequences.get(sessionId) || 0) + 1;
    intentSequences.set(sessionId, seq);
    const intentId = intent.intentId || `pi_${now}_${seq}`;
    const queued = {
      ...intent,
      intentId,
      intentSeq: seq,
      issuedAt: now,
      queuedAt: now,
      expiresAt: now + INTENT_TTL_MS,
    };
    intents.set(sessionId, queued);
    return { queued: true, intentId, intentSeq: seq, expiresAt: new Date(now + INTENT_TTL_MS).toISOString() };
  }

  function takePanelIntent(sessionId, now = Date.now()) {
    const intent = intents.get(sessionId);
    if (!intent) return null;
    intents.delete(sessionId);
    return intent.expiresAt > now ? intent : null;
  }

  function ackPanelIntent(sessionId, ack, now = Date.now()) {
    const intentId = ack?.intentId || ack?.ackIntentId;
    if (!intentId) return null;
    const result = {
      intentId,
      status: ack.status || 'displayed',
      placement: ack.placement || 'sidebar',
      runId: ack.runId || null,
      at: now,
    };
    const key = `${sessionId}\0${intentId}`;
    latestAcks.set(key, result);
    const waiters = ackResolvers.get(key);
    if (waiters) {
      for (const resolve of waiters) resolve(result);
      ackResolvers.delete(key);
    }
    return result;
  }

  function waitForIntentAck(sessionId, intentId, timeoutMs = 2200) {
    if (!intentId) return Promise.resolve(null);
    const key = `${sessionId}\0${intentId}`;
    if (latestAcks.has(key)) return Promise.resolve(latestAcks.get(key));

    return new Promise((resolve) => {
      let handle;
      const timer = setTimeout(() => {
        const list = ackResolvers.get(key);
        if (list && handle) {
          const idx = list.indexOf(handle);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) ackResolvers.delete(key);
        }
        resolve(null);
      }, timeoutMs);

      handle = (ack) => {
        clearTimeout(timer);
        resolve(ack);
      };

      const list = ackResolvers.get(key) || [];
      list.push(handle);
      ackResolvers.set(key, list);
    });
  }

  function panelObservation(sessionId) {
    if (visible.has(sessionId)) {
      const seats = visible.get(sessionId);
      return seats.sidebar?.value || seats.main?.value || null;
    }
    return observations.get(sessionId)?.value || null;
  }

  const hasPanelVisibility = (sessionId) => visible.has(sessionId);

  function setPanelVisible(sessionId, placement, run, now = Date.now(), sequence, options) {
    const seats = visible.get(sessionId) || { main: null, sidebar: null };
    const where = placement === 'sidebar' ? 'sidebar' : 'main';
    const key = `${sessionId}\0${where}`;
    if (Number.isSafeInteger(sequence)) {
      if (sequence <= (visibleSequences.get(key) || 0)) return panelObservation(sessionId);
      visibleSequences.set(key, sequence);
    }
    seats[where] = run ? { value: observePanelReview(sessionId, 'review.visible', run, now) } : null;
    visible.set(sessionId, seats);

    const extra = (options && typeof options === 'object') ? options : (sequence && typeof sequence === 'object') ? sequence : null;
    if (extra && (extra.ackIntentId || extra.intentId)) {
      ackPanelIntent(sessionId, {
        intentId: extra.ackIntentId || extra.intentId,
        status: extra.status || 'displayed',
        placement: where,
        runId: run?.id,
      }, now);
    }

    return panelObservation(sessionId);
  }

  function registerPanelNotifier(sessionId, notify) {
    if (typeof notify === 'function') notifiers.set(sessionId, notify);
  }

  function observePanelReview(sessionId, action, run, now = Date.now()) {
    if (!run || typeof run !== 'object' || !action.startsWith('review.')) return null;
    const value = {
      runId: run.id || null,
      deckId: run.deckId || null,
      cardId: run.card?.id || null,
      index: run.index ?? null,
      total: run.total ?? null,
      mode: run.mode || null,
      selected: run.feedback?.selected || (run.mode === 'exam'
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
      const summary = value.complete ? '学习轮次结束' : value.correct === null
        ? '当前题已切换' : '已记录本题作答';
      notifiers.get(sessionId)({
        text: `StudyHub 状态（被动上下文，不要主动打断用户）：${JSON.stringify(value)}`,
        summary,
      });
    }
    return value;
  }

  return Object.freeze({
    queuePanelIntent,
    takePanelIntent,
    ackPanelIntent,
    waitForIntentAck,
    panelObservation,
    hasPanelVisibility,
    setPanelVisible,
    registerPanelNotifier,
    observePanelReview,
    clear() {
      for (const map of [intents, observations, visible, visibleSequences, notifiers, intentSequences, ackResolvers, latestAcks]) {
        map.clear();
      }
    },
  });
}

// Standalone low-level consumers retain their API; built-in contexts inject their own bridge.
export const {
  queuePanelIntent,
  takePanelIntent,
  ackPanelIntent,
  waitForIntentAck,
  panelObservation,
  hasPanelVisibility,
  setPanelVisible,
  registerPanelNotifier,
  observePanelReview,
} = createPanelBridge();
