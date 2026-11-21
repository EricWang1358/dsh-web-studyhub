// @ts-check

/**
 * Pure 0-token helpers for Review Book's knowledge-point gap lens and TOC gap status markers.
 * Consumes `course.book.open`'s `pointGaps` report (`lib/evidence/point-report.js coursePointReport`).
 */

/**
 * Whether a leaf status represents an uncovered knowledge point (no question yet, coverable or uncoverable).
 *
 * @param {string | undefined} status
 * @returns {boolean}
 */
export const isGapLeafStatus = (status) => status === 'uncovered' || status === 'uncoverable';

/**
 * Keeps uncovered leaf TOC entries together with their ancestor chapter/section headings in reading order.
 *
 * @param {Array<{ id: string, level: number, title: string, chapter?: string }>} entries
 * @param {Record<string, any> | null | undefined} pointGaps
 * @returns {{ gapCount: number, entries: Array<{ id: string, level: number, title: string, chapter?: string }> }}
 */
export function filterGapTocEntries(entries, pointGaps) {
  if (!Array.isArray(entries) || !entries.length || pointGaps?.status !== 'ok' || !pointGaps.leaves) {
    return { gapCount: 0, entries: [] };
  }
  const leaves = pointGaps.leaves;
  /** @type {number[]} */
  const matched = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (entry?.id && isGapLeafStatus(leaves[entry.id]?.status)) matched.push(i);
  }
  if (!matched.length) return { gapCount: 0, entries: [] };

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
    gapCount: matched.length,
    entries: entries.filter((_, idx) => keep.has(idx)),
  };
}

/**
 * Builds a Map(hid -> gap metadata) for chapters, sections, and leaves so BookTocList can render
 * quiet per-chapter/per-section coverage ratios and per-leaf gap dots.
 *
 * @param {Record<string, any> | null | undefined} pointGaps
 * @returns {Map<string, { kind: 'group' | 'leaf', covered?: number, points?: number, uncovered?: number, status?: string }>}
 */
export function tocGapMeta(pointGaps) {
  const map = new Map();
  if (pointGaps?.status !== 'ok') return map;
  const walk = (groups) => {
    for (const group of groups || []) {
      if (group?.hid && group.points > 0) {
        map.set(group.hid, { kind: 'group', covered: group.covered, points: group.points, uncovered: group.uncovered });
      }
      if (Array.isArray(group?.sections)) walk(group.sections);
    }
  };
  walk(pointGaps.chapters);
  for (const [hid, leaf] of Object.entries(pointGaps.leaves || {})) {
    if (hid && leaf?.status && !map.has(hid)) {
      map.set(hid, { kind: 'leaf', status: leaf.status });
    }
  }
  return map;
}
