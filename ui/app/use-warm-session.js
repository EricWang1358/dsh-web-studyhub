import { useCallback, useEffect, useRef, useState } from 'react';
import { pageAvailable } from '../capabilities.js';
import { initialGeneration } from './use-library-connection.js';
import { generationFormDefaults, syncGenerationDefaults } from '../generation-status.js';
import { relocalizeSnapshotRuns } from '../run-titles.js';
import { syncScheduleSettings } from '../schedule-settings.js';
import { RESTORABLE_PAGES, clearWarmSession, readWarmSession, writeWarmBoard, writeWarmDailyPlan, writeWarmView } from './warm-session.js';

/** Seed warm session state, initial landing page, and library defaults on mount without keeping state inside App.jsx. */
export function useWarmEntry(host, language) {
  const [warm] = useState(() => {
    const entry = readWarmSession(host.warmKey);
    if (!entry?.data) return entry;
    const relocalized = relocalizeSnapshotRuns(entry.data);
    if (relocalized === entry.data) return entry;
    const snapshotKey = { ...entry.snapshotKey };
    for (const key of ['runs', 'exams', 'lastRun']) {
      if (Object.hasOwn(relocalized, key)) snapshotKey[key] = JSON.stringify(relocalized[key]) ?? '';
    }
    return { ...entry, data: relocalized, snapshotKey };
  });
  const placement = host.placement || 'main';
  const savedView = warm && placement !== 'sidebar' ? warm.views?.[placement] : null;
  const restoredPage = Boolean(savedView && RESTORABLE_PAGES.has(savedView.page) && pageAvailable(warm.data, savedView.page));
  const initialPage = restoredPage ? savedView.page : 'library';
  const initialBoardView = restoredPage && savedView.boardView ? savedView.boardView : 'today';
  const [initialLib] = useState(() => {
    const base = initialGeneration(host, language);
    return {
      gen: warm?.data?.settings ? syncGenerationDefaults(base, base, generationFormDefaults(warm.data.settings?.generation, language)) : base,
      settings: warm?.data?.settings ? syncScheduleSettings({}, undefined, warm.data.settings) : undefined,
      notebooks: warm?.notebooks ?? undefined,
      boardView: initialBoardView,
    };
  });
  const clear = useCallback(() => clearWarmSession(host.warmKey), [host.warmKey]);
  const saveBoard = useCallback((root, next) => writeWarmBoard(host.warmKey, root, next), [host.warmKey]);
  const saveDailyPlan = useCallback((root, next) => writeWarmDailyPlan(host.warmKey, root, next), [host.warmKey]);
  return { warm, placement, restoredPage, initialPage, initialLib, clear, saveBoard, saveDailyPlan };
}

/** Sync confirmed board/page state back into the warm session cache and keep LiveClass unmounted until visited. */
export function useWarmSync({ host, placement, loading, root, board, page, boardView }) {
  const liveVisited = useRef({ root: '', visited: false });
  if (liveVisited.current.root !== root) {
    liveVisited.current = { root, visited: false };
  }
  if (page === 'live') liveVisited.current.visited = true;

  useEffect(() => {
    if (root && board) writeWarmBoard(host.warmKey, root, board);
  }, [host.warmKey, root, board]);

  useEffect(() => {
    if (!loading && root) {
      writeWarmView(host.warmKey, root, placement, { page, boardView });
    }
  }, [loading, root, host.warmKey, placement, page, boardView]);

  return liveVisited.current.visited;
}
