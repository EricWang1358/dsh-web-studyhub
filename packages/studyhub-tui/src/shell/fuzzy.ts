/**
 * Tiny dependency-free fuzzy matcher (subsequence with contiguity / word-start bonuses).
 * Works for CJK (per-code-point) and Latin text alike.
 */

export interface FuzzyResult<T> {
  item: T;
  score: number;
  /** Code-point indices into the matched label (for highlighting). */
  positions: number[];
}

const BOUNDARY = /[\s\-_/.:·|()[\]]/;

export function fuzzyScore(query: string, text: string): { score: number; positions: number[] } | null {
  const q = Array.from(query.toLowerCase().trim());
  if (q.length === 0) return { score: 0, positions: [] };
  const t = Array.from(text.toLowerCase());
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const qc of q) {
    if (qc === ' ') continue;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === qc) {
        found = ti;
        break;
      }
      ti += 1;
    }
    if (found < 0) return null;
    let s = 1;
    if (found === prev + 1) s += 4; // contiguous
    if (found === 0 || BOUNDARY.test(t[found - 1] ?? '')) s += 3; // word start
    if (found === 0) s += 2;
    score += s;
    positions.push(found);
    prev = found;
    ti = found + 1;
  }
  // Prefer shorter labels & exact substring hits.
  const joined = q.join('');
  const idx = t.join('').indexOf(joined);
  if (idx >= 0) score += 8 + (idx === 0 ? 6 : 0);
  score -= Math.min(10, Math.floor(t.length / 12));
  return { score, positions };
}

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
  getKeywords?: (item: T) => readonly string[] | undefined,
  limit = 200,
): FuzzyResult<T>[] {
  const q = query.trim();
  if (!q) return items.slice(0, limit).map((item) => ({ item, score: 0, positions: [] }));
  const out: FuzzyResult<T>[] = [];
  for (const item of items) {
    const label = getText(item);
    let best = fuzzyScore(q, label);
    if (!best && getKeywords) {
      for (const kw of getKeywords(item) ?? []) {
        const r = fuzzyScore(q, kw);
        if (r && (!best || r.score - 2 > best.score)) best = { score: r.score - 2, positions: [] };
      }
    }
    if (best) out.push({ item, score: best.score, positions: best.positions });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
