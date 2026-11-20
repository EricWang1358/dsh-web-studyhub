import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { errorMessage, ui } from './i18n.js';
import { useStudy } from './study-context.jsx';
import { AppContext } from './app/app-context.js';
import { browserSession, readJSON, removeKey, writeJSON } from './storage.js';
import { JOB_STATUS } from '../lib/job-status.js';
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
export const LIVE_MATERIAL_JOB_STATUSES = new Set([JOB_STATUS.QUEUED, JOB_STATUS.RUNNING, 'pausing', 'paused', JOB_STATUS.CANCELLING]);

const ORGANIZE_OPEN_KEY = 'study-sources-organize-open:v1';
let pendingOrganizeOpenFlag = false;

/** Signal `Sources` to open `<details class="source-organize">` on arrival (e.g. from `任务` -> `查看归属建议`). */
export function requestOpenSourcesOrganize() {
  pendingOrganizeOpenFlag = true;
  writeJSON(ORGANIZE_OPEN_KEY, Date.now(), browserSession());
}

/** Consume any pending request to open `<details class="source-organize">`. */
export function consumeOpenSourcesOrganize() {
  const fromMemory = pendingOrganizeOpenFlag;
  pendingOrganizeOpenFlag = false;
  const fromSession = Boolean(readJSON(ORGANIZE_OPEN_KEY, null, browserSession()));
  if (fromSession) removeKey(ORGANIZE_OPEN_KEY, browserSession());
  return fromMemory || fromSession;
}

const MAX_EDIT_CACHE = 16;
const pendingGroupEdits = new Map();

function rememberGroupEdit(jobKey, originalName, patch) {
  if (!jobKey || !originalName) return;
  if (!pendingGroupEdits.has(jobKey)) {
    if (pendingGroupEdits.size >= MAX_EDIT_CACHE) {
      const oldest = pendingGroupEdits.keys().next().value;
      pendingGroupEdits.delete(oldest);
    }
    pendingGroupEdits.set(jobKey, new Map());
  }
  const map = pendingGroupEdits.get(jobKey);
  const prev = map.get(originalName) || {};
  map.set(originalName, { ...prev, ...patch });
}

export function clearPendingClassifyEdits(jobKey) {
  if (jobKey) pendingGroupEdits.delete(jobKey);
  else pendingGroupEdits.clear();
}

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
 * Kept for standalone callers/tests when `AppContext` job snapshots are absent.
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

const normalizeScopeCourse = value =>
  typeof value === 'string' && value.trim() && value.trim() !== '*' ? value.trim() : '';

/**
 * Shared React hook for `AI 智能分类`:
 * - Inside `<App>` (`Array.isArray(appData?.jobs)`): starts `source.folder.classify` background job,
 *   never cancels on page switch, tracks `taxonomy` vs `batch` progress from `appData.jobs`,
 *   and hydrates durable pending proposals from `appData.settings?.materialClassifyPending`.
 * - Outside `<App>` (isolated unit tests): falls back to `runBatchedFolderSuggest`.
 */
export function useMaterialClassify({ items = [], course = '' } = {}) {
  const { call, act, busy } = useStudy();
  const app = useContext(AppContext);
  const appData = app?.data;
  const jobBacked = Array.isArray(appData?.jobs);

  const [state, setState] = useState(IDLE_STATE);
  const [startingTotal, setStartingTotal] = useState(0);
  const [optimisticJob, setOptimisticJob] = useState(null);
  const [jobError, setJobError] = useState('');
  const [applyError, setApplyError] = useState('');
  const [editRevision, setEditRevision] = useState(0);
  const epochRef = useRef(0);
  const prevCourseRef = useRef(course);

  // Only cancel local standalone runs on unmount; background jobs survive page switches!
  useEffect(() => () => {
    epochRef.current += 1;
  }, []);

  useEffect(() => {
    if (prevCourseRef.current !== course) {
      prevCourseRef.current = course;
      epochRef.current += 1;
      setState(IDLE_STATE);
      setOptimisticJob(null);
      setJobError('');
      setApplyError('');
    }
  }, [course]);

  const scopeCourse = normalizeScopeCourse(course);
  const matchesScope = useCallback(
    targetCourse => {
      const normalized = normalizeScopeCourse(targetCourse);
      return !normalized || !scopeCourse || normalized === scopeCourse;
    },
    [scopeCourse],
  );

  const snapshotActiveJob = useMemo(() => {
    if (!jobBacked) return null;
    return (
      appData.jobs.find(
        job =>
          job?.type === 'material-classify' &&
          LIVE_MATERIAL_JOB_STATUSES.has(job?.contract?.status || job?.status) &&
          matchesScope(job?.course ?? job?.contract?.detail?.course),
      ) || null
    );
  }, [jobBacked, appData?.jobs, matchesScope]);

  const pending = useMemo(() => {
    const raw = appData?.settings?.materialClassifyPending;
    if (!raw || !Array.isArray(raw.suggestions)) return null;
    return matchesScope(raw.course) ? raw : null;
  }, [appData?.settings?.materialClassifyPending, matchesScope]);

  useEffect(() => {
    if (!optimisticJob) return;
    const inSnapshot = jobBacked && appData.jobs.find(job => job?.id === optimisticJob.id);
    if (inSnapshot || (pending && (!pending.jobId || pending.jobId === optimisticJob.id))) {
      setOptimisticJob(null);
    }
  }, [optimisticJob, jobBacked, appData?.jobs, pending]);

  const activeJob = snapshotActiveJob || (optimisticJob && LIVE_MATERIAL_JOB_STATUSES.has(optimisticJob.contract?.status || optimisticJob.status) && matchesScope(optimisticJob.course) ? optimisticJob : null);

  const pendingKey = pending ? String(pending.jobId || pending.createdAt || 'pending') : '';

  const titleByKey = useMemo(
    () => new Map((Array.isArray(items) ? items : []).map(item => [item?.key, item?.title]).filter(([k]) => k)),
    [items],
  );

  const pendingGroups = useMemo(() => {
    if (!pending) return [];
    const base = buildProposalGroups(pending.suggestions, pending.folders, titleByKey);
    const saved = pendingKey ? pendingGroupEdits.get(pendingKey) : null;
    if (!saved?.size) return base;
    return base.map(group => {
      const edit = saved.get(group.originalName);
      if (!edit) return group;
      return {
        ...group,
        name: edit.name !== undefined ? edit.name : group.name,
        include: edit.include !== undefined ? Boolean(edit.include) : group.include,
      };
    });
  }, [pending, pendingKey, titleByKey, editRevision]); // eslint-disable-line react-hooks/exhaustive-deps

  const runStandalone = useCallback(
    async (keys, localTitleByKey) => {
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
          course: scopeCourse,
          isCancelled: () => token !== epochRef.current,
          onProgress: ({ done, total }) => {
            if (token !== epochRef.current) return;
            setState(prev => (prev.phase === 'running' ? { ...prev, done, total } : prev));
          },
        });
        if (!result || token !== epochRef.current) return;
        const groups = buildProposalGroups(result.suggestions, result.folders, localTitleByKey);
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
    [call, scopeCourse],
  );

  const start = useCallback(
    async overrideItems => {
      const targetItems = Array.isArray(overrideItems) && overrideItems.length ? overrideItems : items;
      const keys = [...new Set(targetItems.map(item => item?.key).filter(Boolean))];
      if (!keys.length) return;

      const localTitleByKey = new Map(targetItems.map(item => [item.key, item.title]));
      setJobError('');
      setApplyError('');

      if (!jobBacked) {
        await runStandalone(keys, localTitleByKey);
        return;
      }

      const maxFolders = keys.length > CLASSIFY_BATCH_SIZE ? LARGE_MAX_FOLDERS : AUTO_MAX_FOLDERS;
      setStartingTotal(keys.length);
      try {
        const res = await call('source.folder.classify', {
          keys,
          ...(scopeCourse ? { course: scopeCourse } : {}),
          maxFolders,
        });
        if (res?.job && LIVE_MATERIAL_JOB_STATUSES.has(res.job.contract?.status || res.job.status)) {
          setOptimisticJob(res.job);
        }
        await Promise.resolve(app?.core?.refresh?.()).catch(() => {});
      } catch (err) {
        if (/unknown action|not found|未知操作|未注册/i.test(String(err?.message || ''))) {
          setStartingTotal(0);
          await runStandalone(keys, localTitleByKey);
          return;
        }
        setJobError(errorMessage(err));
      } finally {
        setStartingTotal(0);
      }
    },
    [app, call, items, jobBacked, runStandalone, scopeCourse],
  );

  const cancel = useCallback(async () => {
    epochRef.current += 1;
    setStartingTotal(0);
    setOptimisticJob(null);
    setState(IDLE_STATE);
    if (activeJob?.id) {
      try {
        await call('job.control', { jobId: activeJob.id, action: 'cancel' });
        await Promise.resolve(app?.core?.refresh?.()).catch(() => {});
      } catch (err) {
        setJobError(errorMessage(err));
      }
    }
  }, [activeJob?.id, app, call]);

  const discard = useCallback(async () => {
    epochRef.current += 1;
    setJobError('');
    setApplyError('');
    if (pending) {
      await act(
        'source.folder.dismiss',
        pending.jobId ? { jobId: pending.jobId } : {},
        () => {
          if (pendingKey) pendingGroupEdits.delete(pendingKey);
          setEditRevision(v => v + 1);
          setState(IDLE_STATE);
        },
      );
      return;
    }
    setState(IDLE_STATE);
  }, [act, pending, pendingKey]);

  const toggleGroup = useCallback(
    (groupId, include) => {
      setApplyError('');
      if (pending && pendingGroups.length > 0) {
        const target = pendingGroups.find(group => group.id === groupId);
        if (target && pendingKey) {
          rememberGroupEdit(pendingKey, target.originalName, { include: Boolean(include) });
          setEditRevision(v => v + 1);
        }
        return;
      }
      setState(prev => ({
        ...prev,
        applyError: '',
        groups: prev.groups.map(group => (group.id === groupId ? { ...group, include: Boolean(include) } : group)),
      }));
    },
    [pending, pendingGroups, pendingKey],
  );

  const renameGroup = useCallback(
    (groupId, name) => {
      setApplyError('');
      if (pending && pendingGroups.length > 0) {
        const target = pendingGroups.find(group => group.id === groupId);
        if (target && pendingKey) {
          rememberGroupEdit(pendingKey, target.originalName, { name });
          setEditRevision(v => v + 1);
        }
        return;
      }
      setState(prev => ({
        ...prev,
        applyError: '',
        groups: prev.groups.map(group => (group.id === groupId ? { ...group, name } : group)),
      }));
    },
    [pending, pendingGroups, pendingKey],
  );

  const activeGroups = pending && pendingGroups.length > 0 ? pendingGroups : state.groups;

  const apply = useCallback(async () => {
    if (!canApplyProposalGroups(activeGroups)) return false;
    const assignments = buildApplyAssignments(activeGroups);
    if (!assignments.length) return false;
    setApplyError('');
    setState(prev => ({ ...prev, applyError: '' }));
    try {
      let applied = false;
      await act(
        'source.folder.apply',
        { assignments },
        () => {
          applied = true;
          epochRef.current += 1;
          if (pendingKey) pendingGroupEdits.delete(pendingKey);
          setEditRevision(v => v + 1);
          setState(IDLE_STATE);
        },
        { rethrow: true },
      );
      return applied;
    } catch (err) {
      const msg = errorMessage(err);
      setApplyError(msg);
      setState(prev => ({ ...prev, applyError: msg }));
      return false;
    }
  }, [act, activeGroups, pendingKey]);

  let view = state;
  let jobId = null;
  let jobStage = null;

  if (activeJob || startingTotal > 0) {
    const done = activeJob ? Number(activeJob.contract?.progress?.done ?? activeJob.done ?? 0) : 0;
    const total = activeJob
      ? Number(activeJob.contract?.progress?.total ?? activeJob.total ?? items.length)
      : startingTotal;
    jobId = activeJob?.id || null;
    jobStage = activeJob?.phase === 'taxonomy' || done === 0 ? 'taxonomy' : 'batch';
    view = {
      phase: 'running',
      done,
      total,
      groups: [],
      unmatchedCount: 0,
      error: '',
      applyError: '',
    };
  } else if (pending && pendingGroups.length > 0) {
    const matchedCount = pendingGroups.reduce((sum, group) => sum + group.items.length, 0);
    jobId = pending.jobId || null;
    jobStage = 'done';
    view = {
      phase: 'review',
      done: matchedCount,
      total: matchedCount,
      groups: pendingGroups,
      unmatchedCount: Array.isArray(pending.unmatchedKeys)
        ? pending.unmatchedKeys.length
        : Number(pending.unmatchedCount) || 0,
      error: '',
      applyError,
    };
  } else if (jobError) {
    view = {
      phase: 'error',
      done: 0,
      total: 0,
      groups: [],
      unmatchedCount: 0,
      error: jobError,
      applyError: '',
    };
  }

  return {
    ...view,
    jobId,
    jobStage,
    busy,
    canApply: canApplyProposalGroups(view.groups),
    start,
    loadSuggestions: start,
    cancel,
    discard,
    toggleGroup,
    renameGroup,
    apply,
  };
}
