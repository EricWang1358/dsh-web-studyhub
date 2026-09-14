/** Learner profile defaults, shared by storage normalization and the coach. */
export function emptyLearner() {
  return {
    consent: { prep: null },
    goal: "",
    summary: "",
    signals: { got: 0, confused: 0, easy: 0, hard: 0, up: 0, down: 0 },
    levels: {},
    updatedAt: null,
  };
}
/** A complete learner record built from whatever an older library stored. */
export function normalizeLearner(value) {
  const l = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const base = emptyLearner();
  return {
    ...base,
    ...l,
    consent: { ...base.consent, ...(l.consent || {}) },
    signals: { ...base.signals, ...(l.signals || {}) },
    levels: { ...(l.levels || {}) },
  };
}
