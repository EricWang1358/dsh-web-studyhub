/* The sample slice of a review book as its record keeps it (courseNotes.sample, #710; written by lib/contexts/generation/book/sample.js):
     status    'waiting' (written, the learner has not built the rest yet) | 'confirmed' (the rest was built from it: the style anchor of every later build)
     level, language   the detail level and language it was written at (a build at another one makes a new sample)
     leaves    the ids of its two points, the typical one first
     exemplar  the words every request of a build carries (the typical point's text, cut); band { low, high } characters per must item
     estimate  the scale of the rest when it was written ({ points, calls, totalTokens, ..., minutes, concurrency, stages }), in counts only: no prices
   Checked where it enters (the notes are read from disk): a state this release does not know is dropped, an unknown field is dropped. */

const STATUSES = ['waiting', 'confirmed'], LEVELS = ['brief', 'standard', 'full'];
const EXEMPLAR_MAX = 2000, LEAVES_MAX = 4, STAGES_MAX = 6;
const count = value => (Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);
const pair = value => (value && typeof value === 'object' ? { low: count(value.low), high: Math.max(count(value.low), count(value.high)) } : null);
const word = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

function normalizeEstimate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const points = raw.points && typeof raw.points === 'object' ? { total: count(raw.points.total), sample: count(raw.points.sample), rest: count(raw.points.rest) } : null;
  const ranges = Object.fromEntries(['calls', 'totalTokens', 'inputTokens', 'uncachedInputTokens', 'cacheReadTokens', 'outputTokens', 'minutes'].map(key => [key, pair(raw[key])]));
  if (!points || !ranges.calls) return null;
  const stages = (Array.isArray(raw.stages) ? raw.stages : []).slice(0, STAGES_MAX).filter(stage => typeof stage?.id === 'string')
    .map(stage => ({ id: word(stage.id, 40), calls: count(stage.calls), inputTokens: pair(stage.inputTokens) ?? { low: 0, high: 0 }, outputTokens: pair(stage.outputTokens) ?? { low: 0, high: 0 } }));
  const notes = (Array.isArray(raw.notes) ? raw.notes : []).filter(note => typeof note === 'string').slice(0, 6).map(note => word(note, 40));
  return { points, ...ranges, concurrency: Math.max(1, count(raw.concurrency)), stages, feature: 'other', notes };
}

/** The sample of a notes record, or null. */
export function normalizeSample(raw) {
  if (!raw || typeof raw !== 'object' || !STATUSES.includes(raw.status)) return null;
  const leaves = (Array.isArray(raw.leaves) ? raw.leaves : []).filter(id => typeof id === 'string' && id).slice(0, LEAVES_MAX).map(id => word(id, 40));
  const band = pair(raw.band) ?? { low: 0, high: 0 }, estimate = normalizeEstimate(raw.estimate);
  return { status: raw.status, level: LEVELS.includes(raw.level) ? raw.level : 'standard', language: raw.language === 'en' ? 'en' : 'zh', leaves,
    exemplar: word(raw.exemplar, EXEMPLAR_MAX), band, ...(estimate ? { estimate } : {}) };
}
