/* Snapshot of chapter progress taken when a course batch starts, and pure
   comparison at summary time to report only chapters finished for the first
   time during this round (#1195). */

/**
 * Extract compact pre-round progress for the course chapters touched by `run`.
 * @param {{ chapters?: Array<{ deckId: string, learned: number, total: number }> } | null | undefined} route
 * @param {{ deckId?: string | null, entries?: Array<{ deckId?: string, retry?: boolean }> } | null | undefined} run
 * @returns {Array<{ index: number, deckId: string, learned: number, total: number }>}
 */
export function courseChaptersBefore(route, run) {
  const chapters = Array.isArray(route?.chapters) ? route.chapters : [];
  if (!chapters.length || !run) return [];
  const touched = new Set();
  for (const entry of run.entries || []) {
    if (entry?.retry) continue;
    const deckId = entry?.deckId ?? run.deckId;
    if (typeof deckId === "string" && deckId) touched.add(deckId);
  }
  if (!touched.size) return [];
  const before = [];
  for (let index = 0; index < chapters.length; index++) {
    const ch = chapters[index];
    if (!ch || !touched.has(ch.deckId)) continue;
    before.push({
      index,
      deckId: ch.deckId,
      learned: Number(ch.learned) || 0,
      total: Number(ch.total) || 0,
    });
  }
  return before;
}

/**
 * Derive per-chapter segment state (`done` / `started` / `upcoming`) for the course route.
 * @param {Array<{ learned: number, total: number }> | null | undefined} chapters
 * @returns {Array<"done" | "started" | "upcoming">}
 */
export function chapterSegments(chapters) {
  if (!Array.isArray(chapters)) return [];
  return chapters.map((ch) => {
    const total = Number(ch?.total) || 0;
    const learned = Number(ch?.learned) || 0;
    if (total > 0 && learned === total) return "done";
    if (learned > 0) return "started";
    return "upcoming";
  });
}

/**
 * Chapters that transitioned from unfinished (`learned < total`) at round start
 * to fully explored (`total > 0 && learned === total`) now.
 * Legacy runs without `chaptersBefore` return `[]` to avoid false positives.
 * @param {Array<{ index?: number, deckId?: string, learned: number, total: number }> | null | undefined} chaptersBefore
 * @param {Array<{ deckId?: string, title?: string, learned: number, total: number, weak?: number }> | null | undefined} currentChapters
 * @returns {Array<{ index: number, title: string, total: number, weak: number }>}
 */
export function finishedChapters(chaptersBefore, currentChapters) {
  if (!Array.isArray(chaptersBefore) || !chaptersBefore.length || !Array.isArray(currentChapters) || !currentChapters.length) {
    return [];
  }
  const byDeckId = new Map();
  const byIndex = new Map();
  for (const item of chaptersBefore) {
    if (!item) continue;
    if (typeof item.deckId === "string" && item.deckId) byDeckId.set(item.deckId, item);
    else if (Number.isInteger(item.index)) byIndex.set(item.index, item);
  }
  const finished = [];
  for (let index = 0; index < currentChapters.length; index++) {
    const ch = currentChapters[index];
    if (!ch) continue;
    const total = Number(ch.total) || 0;
    const learned = Number(ch.learned) || 0;
    if (total <= 0 || learned !== total) continue;
    const before = (typeof ch.deckId === "string" && ch.deckId ? byDeckId.get(ch.deckId) : undefined) ?? byIndex.get(index);
    if (!before) continue;
    const beforeTotal = Number(before.total) || 0;
    const beforeLearned = Number(before.learned) || 0;
    if (beforeTotal <= 0 || beforeLearned >= beforeTotal) continue;
    finished.push({
      index,
      title: ch.title ?? "",
      total,
      weak: Number(ch.weak) || 0,
    });
  }
  return finished;
}
