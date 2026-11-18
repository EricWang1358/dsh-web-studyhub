import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, ui } from './i18n.js';
import { useStudy } from './study-context.jsx';
import { MAX_FOLDER_NAME_CHARS, normalizeFolderName } from '../lib/contexts/materials/material-folders.js';

const cleanProposalTitle = value =>
  String(value ?? '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.(md|markdown|txt|html?|tex|pdf|docx?|pptx?|json)$/i, '')
    .trim() || String(value ?? '');

export const CLASSIFY_BATCH_SIZE = 60;
export const CLASSIFY_CONCURRENCY = 2;
export const AUTO_MAX_FOLDERS = 12;
export const LARGE_MAX_FOLDERS = 14;

const IDLE_STATE = Object.freeze({
  phase: 'idle',
  done: 0,
  total: 0,
  groups: [],
  unmatchedCount: 0,
  error: '',
  applyError: '',
});

/**
 * Run `source.folder.suggest` for small (`<= 60`, single `auto` call) or large (`> 60`, 2-stage
 * `taxonomy` + `batch` chunks with concurrency 2) material sets, reporting live item progress.
 */
export async function runBatchedFolderSuggest({
  call,
  keys: rawKeys = [],
  course = '',
  isCancelled = () => false,
  onProgress,
}) {
  const keys = [...new Set(rawKeys.filter(key => typeof key === 'string' && key.trim()))];
  if (!keys.length) return { folders: [], suggestions: [], unmatchedKeys: [] };

  const courseArg = typeof course === 'string' && course.trim() && course !== '*' ? { course: course.trim() } : {};

  if (keys.length <= CLASSIFY_BATCH_SIZE) {
    const res = await call('source.folder.suggest', {
      keys,
      ...courseArg,
      mode: 'auto',
      maxFolders: AUTO_MAX_FOLDERS,
    });
    if (isCancelled()) return null;
    onProgress?.({ done: keys.length, total: keys.length });
    return {
      folders: Array.isArray(res?.folders) ? res.folders : [],
      suggestions: Array.isArray(res?.suggestions) ? res.suggestions : [],
      unmatchedKeys: Array.isArray(res?.unmatchedKeys) ? res.unmatchedKeys : [],
    };
  }

  const tax = await call('source.folder.suggest', {
    keys,
    ...courseArg,
    mode: 'taxonomy',
    maxFolders: LARGE_MAX_FOLDERS,
  });
  if (isCancelled()) return null;

  const targetFolders = [];
  const seenTax = new Set();
  for (const raw of Array.isArray(tax?.folders) ? tax.folders : []) {
    const name = normalizeFolderName(raw);
    if (!name || seenTax.has(name)) continue;
    seenTax.add(name);
    targetFolders.push(name);
  }

  const chunks = [];
  for (let i = 0; i < keys.length; i += CLASSIFY_BATCH_SIZE) {
    chunks.push(keys.slice(i, i + CLASSIFY_BATCH_SIZE));
  }

  const chunkResults = new Array(chunks.length);
  let cursor = 0;
  let completed = 0;

  async function worker() {
    while (cursor < chunks.length) {
      if (isCancelled()) return;
      const index = cursor;
      cursor += 1;
      const batchKeys = chunks[index];
      const res = await call('source.folder.suggest', {
        keys: batchKeys,
        ...courseArg,
        mode: targetFolders.length > 0 ? 'batch' : 'auto',
        ...(targetFolders.length > 0 ? { targetFolders } : {}),
        maxFolders: LARGE_MAX_FOLDERS,
      });
      if (isCancelled()) return;
      chunkResults[index] = res;
      completed += batchKeys.length;
      onProgress?.({ done: Math.min(completed, keys.length), total: keys.length });
    }
  }

  const workers = Math.min(CLASSIFY_CONCURRENCY, chunks.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  if (isCancelled()) return null;

  const folders = [...targetFolders];
  const seenFolders = new Set(folders);
  const suggestions = [];
  const seenKeys = new Set();
  const unmatchedKeys = [];

  for (const res of chunkResults) {
    for (const rawFolder of Array.isArray(res?.folders) ? res.folders : []) {
      const name = normalizeFolderName(rawFolder);
      if (name && !seenFolders.has(name)) {
        seenFolders.add(name);
        folders.push(name);
      }
    }
    for (const entry of Array.isArray(res?.suggestions) ? res.suggestions : []) {
      if (!entry?.key || seenKeys.has(entry.key)) continue;
      seenKeys.add(entry.key);
      const folderName = normalizeFolderName(entry.suggestedFolder);
      if (folderName && !seenFolders.has(folderName)) {
        seenFolders.add(folderName);
        folders.push(folderName);
      }
      suggestions.push(entry);
    }
    for (const unmatched of Array.isArray(res?.unmatchedKeys) ? res.unmatchedKeys : []) {
      if (typeof unmatched === 'string' && unmatched && !seenKeys.has(unmatched)) {
        unmatchedKeys.push(unmatched);
      }
    }
  }

  return { folders, suggestions, unmatchedKeys: [...new Set(unmatchedKeys)] };
}

/** Group per-item suggestions into editable category buckets ordered by `folderOrder`. */
export function buildProposalGroups(suggestions = [], folderOrder = [], titleByKey = new Map()) {
  const buckets = new Map();
  for (const entry of Array.isArray(suggestions) ? suggestions : []) {
    const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
    const folder = normalizeFolderName(entry?.suggestedFolder);
    if (!key || !folder) continue;
    if (!buckets.has(folder)) buckets.set(folder, []);
    const rawTitle = entry.title || titleByKey.get(key) || key;
    buckets.get(folder).push({
      key,
      title: cleanProposalTitle(rawTitle),
      currentFolder: entry.currentFolder ?? null,
    });
  }

  const orderedNames = [];
  const seen = new Set();
  for (const raw of Array.isArray(folderOrder) ? folderOrder : []) {
    const folder = normalizeFolderName(raw);
    if (folder && buckets.has(folder) && !seen.has(folder)) {
      seen.add(folder);
      orderedNames.push(folder);
    }
  }
  for (const folder of buckets.keys()) {
    if (!seen.has(folder)) {
      seen.add(folder);
      orderedNames.push(folder);
    }
  }

  return orderedNames.map((folder, index) => ({
    id: `cat-${index}`,
    originalName: folder,
    name: folder,
    include: true,
    items: buckets.get(folder),
  }));
}

/** Convert checked category buckets into atomic `source.folder.apply` assignments. */
export function buildApplyAssignments(groups = []) {
  const assignments = [];
  const seenKeys = new Set();
  for (const group of Array.isArray(groups) ? groups : []) {
    if (!group?.include) continue;
    const folder = normalizeFolderName(group.name);
    if (!folder || folder.length > MAX_FOLDER_NAME_CHARS) continue;
    for (const item of Array.isArray(group.items) ? group.items : []) {
      if (!item?.key || seenKeys.has(item.key)) continue;
      seenKeys.add(item.key);
      assignments.push({ key: item.key, folder });
    }
  }
  return assignments;
}

/** True when at least one group is checked and every checked group has a valid folder name (1..80 chars). */
export function canApplyProposalGroups(groups = []) {
  if (!Array.isArray(groups) || !groups.length) return false;
  const included = groups.filter(group => group?.include);
  if (!included.length) return false;
  for (const group of included) {
    const name = normalizeFolderName(group.name);
    if (!name || name.length > MAX_FOLDER_NAME_CHARS) return false;
  }
  return buildApplyAssignments(included).length > 0;
}

/**
 * Shared React hook for `AI 智能分类`:
 * - Reads `call`, `act`, `busy` from `useStudy()` directly (zero prop handoff).
 * - Supports live batched progress, epoch cancellation, grouped category review/rename, and atomic apply.
 */
export function useMaterialClassify({ items = [], course = '' } = {}) {
  const { call, act, busy } = useStudy();
  const [state, setState] = useState(IDLE_STATE);
  const epochRef = useRef(0);
  const prevCourseRef = useRef(course);

  useEffect(() => () => {
    epochRef.current += 1;
  }, []);

  useEffect(() => {
    if (prevCourseRef.current !== course) {
      prevCourseRef.current = course;
      epochRef.current += 1;
      setState(IDLE_STATE);
    }
  }, [course]);

  const cancel = useCallback(() => {
    epochRef.current += 1;
    setState(IDLE_STATE);
  }, []);

  const start = useCallback(
    async overrideItems => {
      const targetItems = Array.isArray(overrideItems) && overrideItems.length ? overrideItems : items;
      const keys = targetItems.map(item => item?.key).filter(Boolean);
      if (!keys.length) return;

      const titleByKey = new Map(targetItems.map(item => [item.key, item.title]));
      const token = ++epochRef.current;
      setState({
        phase: 'running',
        done: 0,
        total: keys.length,
        groups: [],
        unmatchedCount: 0,
        error: '',
        applyError: '',
      });

      try {
        const result = await runBatchedFolderSuggest({
          call,
          keys,
          course,
          isCancelled: () => token !== epochRef.current,
          onProgress: ({ done, total }) => {
            if (token !== epochRef.current) return;
            setState(prev => (prev.phase === 'running' ? { ...prev, done, total } : prev));
          },
        });
        if (!result || token !== epochRef.current) return;
        const groups = buildProposalGroups(result.suggestions, result.folders, titleByKey);
        if (!groups.length) {
          setState({
            phase: 'error',
            done: 0,
            total: keys.length,
            groups: [],
            unmatchedCount: result.unmatchedKeys.length,
            error: ui('未能生成有效的分类建议，请再试一次。'),
            applyError: '',
          });
          return;
        }
        setState({
          phase: 'review',
          done: keys.length,
          total: keys.length,
          groups,
          unmatchedCount: result.unmatchedKeys.length,
          error: '',
          applyError: '',
        });
      } catch (err) {
        if (token !== epochRef.current) return;
        setState({
          phase: 'error',
          done: 0,
          total: keys.length,
          groups: [],
          unmatchedCount: 0,
          error: errorMessage(err),
          applyError: '',
        });
      }
    },
    [call, course, items],
  );

  const toggleGroup = useCallback((groupId, include) => {
    setState(prev => ({
      ...prev,
      applyError: '',
      groups: prev.groups.map(group => (group.id === groupId ? { ...group, include: Boolean(include) } : group)),
    }));
  }, []);

  const renameGroup = useCallback((groupId, name) => {
    setState(prev => ({
      ...prev,
      applyError: '',
      groups: prev.groups.map(group => (group.id === groupId ? { ...group, name } : group)),
    }));
  }, []);

  const apply = useCallback(async () => {
    if (!canApplyProposalGroups(state.groups)) return false;
    const assignments = buildApplyAssignments(state.groups);
    if (!assignments.length) return false;
    setState(prev => ({ ...prev, applyError: '' }));
    try {
      let applied = false;
      await act(
        'source.folder.apply',
        { assignments },
        () => {
          applied = true;
          epochRef.current += 1;
          setState(IDLE_STATE);
        },
        { rethrow: true },
      );
      return applied;
    } catch (err) {
      setState(prev => ({ ...prev, applyError: errorMessage(err) }));
      return false;
    }
  }, [act, state.groups]);

  return {
    ...state,
    busy,
    canApply: canApplyProposalGroups(state.groups),
    start,
    loadSuggestions: start,
    cancel,
    discard: cancel,
    toggleGroup,
    renameGroup,
    apply,
  };
}
