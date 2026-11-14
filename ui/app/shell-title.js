import { useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { pageTitleOf } from '../pages.js';

/** The heading of the top bar and of the practice page: a run or its deck titles the practice page, every other page has its registry title. */
export function shellTitleOf(page, { run, decks } = {}) {
  if (page === 'review') return run?.title || decks?.find((deck) => deck.id === run?.deckId)?.title || ui('复习');
  const title = pageTitleOf(page);
  return title ? ui(title) : undefined;
}

/**
 * Format the browser tab title with live background job count or a hidden-tab completion prefix.
 */
export function formatDocumentTitle(baseTitle, { runningJobs = 0, completedWhileHidden = false } = {}) {
  const base = String(baseTitle || '').trim() || 'StudyHub';
  const active = Math.max(0, Number(runningJobs) || 0);
  if (active > 0) return `${uiFormat('[{0} 项进行中] ', [active])}${base}`;
  if (completedWhileHidden) return `${ui('[已完成 ✓] ')}${base}`;
  return base;
}

/**
 * Keep `document.title` updated with active background jobs and show `[已完成 ✓] ` when jobs finish
 * while the tab is hidden until `visibilitychange` restores visibility.
 */
export function useTabTitle(baseTitle = 'StudyHub', options = {}) {
  const runningJobs = Math.max(0, Number(typeof options === 'number' ? options : options?.runningJobs) || 0);
  const prevRunning = useRef(runningJobs);
  const [completedWhileHidden, setCompletedWhileHidden] = useState(false);

  useEffect(() => {
    if (runningJobs > 0) {
      setCompletedWhileHidden(false);
    } else if (prevRunning.current > 0 && typeof document !== 'undefined' && document.hidden) {
      setCompletedWhileHidden(true);
    }
    prevRunning.current = runningJobs;
  }, [runningJobs]);

  useEffect(() => {
    if (typeof document === 'undefined' || !completedWhileHidden) return undefined;
    const onVisibilityChange = () => {
      if (!document.hidden) setCompletedWhileHidden(false);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [completedWhileHidden]);

  const title = formatDocumentTitle(baseTitle, {
    runningJobs,
    completedWhileHidden: runningJobs === 0 && completedWhileHidden,
  });

  useEffect(() => {
    if (typeof document !== 'undefined' && document.title !== title) {
      document.title = title;
    }
  }, [title]);

  return title;
}
