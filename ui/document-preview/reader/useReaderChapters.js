import { useCallback, useEffect, useMemo, useState } from 'react';
import { adjacentChapters, chapterAt, readerChapters } from './chapters.js';
import { scrollToNode } from './useReadingPosition.js';

const escape = value => String(value).replace(/["\\]/g, '\\$&');

/** The element a jump lands on: the outline entry it names, else the page of its source, else its page. */
export function goalNode(root, goal) {
  if (!root || !goal) return null;
  const id = goal.outlineId ?? goal.sectionId;
  return (id != null && root.querySelector(`[data-outline-id="${escape(id)}"],[data-ai-outline-id="${escape(id)}"]`))
    || (goal.sourceId != null && root.querySelector(`[data-study-source="${escape(goal.sourceId)}"]`))
    || (Number.isInteger(goal.page) && root.querySelector(`[data-study-page="${goal.page}"]`)) || null;
}

/**
 * The chapter the reader draws (reader/chapters.js) and the way to another one. `sections` are every reading section of the document (data, cheap);
 * `chapters` groupSourcesByDocument's; `opening` the place the reader was opened at ({ sectionId, sourceId, page }) and `openKey` what names that
 * opening (a new source or a new resume starts at its own chapter again).
 * Returns { chapters, index, current, sections (the drawn ones), around, goTo(target) → whether it changed chapter, goal, reached() }.
 * A target is { chapterId } or { sectionId, sourceId, page, outlineId }; `goal` is where to scroll once the chapter is drawn (useChapterGoal).
 */
export function useReaderChapters({ paged, sections, chapters: documentChapters, opening, openKey }) {
  const chapters = useMemo(() => readerChapters({ paged, sections, chapters: documentChapters }), [paged, sections, documentChapters]);
  const [pick, setPick] = useState({ key: openKey, id: null }), [goal, setGoal] = useState(null);
  const picked = pick.key === openKey ? pick.id : null;
  const chosen = picked == null ? -1 : chapters.findIndex(chapter => chapter.id === picked);
  const index = chapters.length ? (chosen >= 0 ? chosen : Math.max(0, chapterAt(chapters, opening))) : -1;
  const current = chapters[index] ?? null;
  const drawn = useMemo(() => {
    if (!current) return sections;
    const ids = new Set(current.sectionIds);
    return sections.filter(section => ids.has(section.id));
  }, [current, sections]);
  const goTo = useCallback(target => {
    const at = target.chapterId != null ? chapters.findIndex(chapter => chapter.id === target.chapterId) : chapterAt(chapters, target);
    if (at < 0) return false;
    setGoal({ ...target, top: target.chapterId != null, nonce: Date.now() });
    if (at === index) return false;
    setPick({ key: openKey, id: chapters[at].id });
    return true;
  }, [chapters, index, openKey]);
  const reached = useCallback(() => setGoal(null), []);
  return { chapters, index, current, sections: drawn, around: adjacentChapters(chapters, index), goTo, goal, reached };
}

/**
 * Scroll to a chapter's goal once it is drawn: its top, or the entry / page it names. Call it after every effect that tags the drawn text
 * (the AI outline) and after the effect that puts a new view at its top, so the goal is the last word. `ready` is false while loading.
 */
export function useChapterGoal({ goal, reached, scroller, body, ready, drawn }) {
  useEffect(() => {
    if (!goal || !ready) return;
    const area = scroller.current;
    if (goal.top) area?.scrollTo?.({ top: 0, behavior: 'auto' });
    else scrollToNode(area, goalNode(body.current, goal), { smooth: false });
    reached(goal);
  }, [goal, ready, drawn, scroller, body, reached]);
}
