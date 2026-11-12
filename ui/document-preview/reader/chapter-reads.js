/* 已读 of the reader's chapters (#1014), the pure part: what a chapter is called in the library (materials.reading.*), when it counts as read,
   and which key turns to the chapter before or after. The store side is lib/contexts/materials/reading-operations.js, the hook useChapterReads.js. */

/** Scrolled this far through a chapter (0..1), it is read. */
export const READ_AT = 0.9;

/** The chapters as the library names them: { id, title, startPage, endPage } (a kept ✓ counts while all four match, reading-model.js). */
export const chapterRefs = chapters => (chapters || []).map(chapter => ({ id: chapter.id, title: String(chapter.title || ''), startPage: chapter.startPage, endPage: chapter.endPage }));

/** How far through the scroll area the reader is, 0..1; a chapter that fits on the screen is seen whole (1). */
export function scrollProgress({ scrollTop = 0, clientHeight = 0, scrollHeight = 0 } = {}) {
  const range = scrollHeight - clientHeight;
  return range > 1 ? Math.min(1, Math.max(0, scrollTop / range)) : 1;
}

/**
 * The reads waiting to be written (useChapterReads), each kept with what it was made under: the material and revision (`target`), the chapter list and
 * the chapter's ref of that moment, so a write after an outline was applied or a revision loaded still names the chapter that was read.
 * queue: a Map; a chapter changed again replaces its entry. A read of a chapter not in `chapters` is not queued.
 */
export function queueRead(queue, { target, chapters, id, value }) {
  const ref = (chapters || []).find(chapter => chapter.id === id) || null;
  if (!target || (value && !ref)) return queue;
  const key = `${target.sourceId}|${target.revision}|${id}`;
  queue.delete(key);
  queue.set(key, { key, target, chapters, id, ref, value: !!value });
  return queue;
}

/** Empties `queue` into one save per material and revision: [{ target, chapters, read: [ref], unread: [id], entries }] (entries: to queue again on a failure). */
export function drainReads(queue) {
  const groups = new Map();
  for (const entry of queue.values()) {
    const at = `${entry.target.sourceId}|${entry.target.revision}`;
    if (!groups.has(at)) groups.set(at, { target: entry.target, chapters: entry.chapters, read: [], unread: [], entries: [] });
    const group = groups.get(at);
    group.chapters = entry.chapters; // the list of the latest change under that revision
    if (entry.value) group.read.push(entry.ref); else group.unread.push(entry.id);
    group.entries.push(entry);
  }
  queue.clear();
  return [...groups.values()];
}

/**
 * Which 目录 row shows a chapter's ✓ (and 标为未读): Map row id -> chapter id. The automatic outline lists the chapters themselves (kind 'chapter');
 * a kept AI outline lists its own entries, so the first entry placed inside a chapter (by its sourceId) stands for that chapter.
 */
export function outlineChapterMarks(items, chapters) {
  const marks = new Map(), chapterOf = new Map(), taken = new Set();
  for (const chapter of chapters || []) for (const id of chapter.sourceIds || []) chapterOf.set(id, chapter.id);
  for (const item of items || []) {
    const chapterId = item.kind === 'chapter' ? item.id : chapterOf.get(item.sourceId);
    if (!chapterId || taken.has(chapterId) || item.kind === 'page') continue;
    taken.add(chapterId); marks.set(item.id, chapterId);
  }
  return marks;
}

const EDITABLE = 'input,textarea,select,[contenteditable]:not([contenteditable="false"])';
/**
 * `[` / `]`: the chapter before / after (-1 / 1), else 0. Not with a modifier (Alt+← is the browser's back, and the brackets are typed with AltGr on some
 * layouts), not while typing in a field. The key is read by its code too, so a keyboard layout or an input method that names it differently still works.
 */
export function chapterStep(event) {
  if (!event || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return 0;
  if (event.target?.closest?.(EDITABLE)) return 0;
  if (event.key === '[' || (event.code === 'BracketLeft' && !event.shiftKey)) return -1;
  if (event.key === ']' || (event.code === 'BracketRight' && !event.shiftKey)) return 1;
  return 0;
}
