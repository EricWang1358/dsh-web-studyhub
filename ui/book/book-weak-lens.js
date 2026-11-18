// @ts-check

/**
 * Pure 0-token filter for Review Book's opt-in 「薄弱节」 TOC lens (`settings.book.inlinePractice`).
 * Guards against `computeCrunch` setting `weakness: 0.6` when `questions === 0` or every question is untouched `new`:
 * only sections with actual weak/due questions or practised below-threshold mastery qualify.
 *
 * @param {Record<string, any> | null | undefined} point
 * @returns {boolean}
 */
export function isWeakCrunchPoint(point) {
  if (!point || typeof point !== 'object') return false;
  if ((point.weak ?? 0) > 0 || (point.due ?? 0) > 0) return true;
  const total = Number(point.questions ?? 0);
  const fresh = Number(point.fresh ?? 0);
  const weakness = Number(point.weakness ?? 0);
  return total > 0 && fresh < total && weakness >= 0.45;
}

/**
 * Keeps matching weak leaf TOC entries together with their ancestor chapter/section headings in reading order.
 *
 * @param {Array<{ id: string, level: number, title: string, chapter?: string }>} entries
 * @param {Array<Record<string, any>> | null | undefined} crunchPoints
 * @returns {{ weakCount: number, entries: Array<{ id: string, level: number, title: string, chapter?: string }> }}
 */
export function filterWeakTocEntries(entries, crunchPoints) {
  if (!Array.isArray(entries) || !entries.length || !Array.isArray(crunchPoints) || !crunchPoints.length) {
    return { weakCount: 0, entries: [] };
  }
  const weakIds = new Set(crunchPoints.filter(isWeakCrunchPoint).map((point) => point.id));
  if (!weakIds.size) return { weakCount: 0, entries: [] };

  /** @type {number[]} */
  const matched = [];
  for (let i = 0; i < entries.length; i += 1) {
    if (weakIds.has(entries[i]?.id)) matched.push(i);
  }
  if (!matched.length) return { weakCount: 0, entries: [] };

  const keep = new Set(matched);
  for (const idx of matched) {
    let minLevel = entries[idx].level;
    for (let j = idx - 1; j >= 0 && minLevel > 2; j -= 1) {
      if (entries[j].level < minLevel) {
        keep.add(j);
        minLevel = entries[j].level;
      }
    }
  }
  return {
    weakCount: matched.length,
    entries: entries.filter((_, idx) => keep.has(idx)),
  };
}
