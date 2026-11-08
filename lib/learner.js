export const LEARNER_PREFERENCES_MAX = 12;
export const LEARNER_PREFERENCE_MAX_CHARS = 120;

/** Normalize a stored list of free-form learner preferences without throwing on legacy data. */
export function cleanLearnerPreferences(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim().slice(0, LEARNER_PREFERENCE_MAX_CHARS).trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= LEARNER_PREFERENCES_MAX) break;
  }
  return out;
}

/** Learner profile defaults, shared by storage normalization and the coach. */
export function emptyLearner() {
  return {
    consent: { prep: null },
    goal: "",
    preferences: [],
    summary: "",
    signals: { got: 0, confused: 0, easy: 0, hard: 0, up: 0, down: 0 },
    levels: {},
    solutionExposures: [],
    examCoach: {},
    updatedAt: null,
    memoryRevision: 0,
    prepRevision: 0,
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
    goal: typeof l.goal === "string" ? l.goal : "",
    preferences: cleanLearnerPreferences(l.preferences),
    summary: typeof l.summary === "string" ? l.summary : "",
    signals: { ...base.signals, ...(l.signals || {}) },
    levels: { ...(l.levels || {}) },
    solutionExposures: Array.isArray(l.solutionExposures) ? l.solutionExposures : [],
    examCoach: l.examCoach && typeof l.examCoach === "object" && !Array.isArray(l.examCoach) ? { ...l.examCoach } : {},
    memoryRevision: Number.isSafeInteger(l.memoryRevision) && l.memoryRevision >= 0 ? l.memoryRevision : 0,
    prepRevision: Number.isSafeInteger(l.prepRevision) && l.prepRevision >= 0 ? l.prepRevision : 0,
  };
}
