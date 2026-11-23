import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getUiLanguage } from '../i18n.js';
import { localizedRun, relocalizeSnapshotRuns } from '../run-titles.js';
import { isTransientStudyError } from '../transport.js';
import { shareUnchanged, sameExceptFingerprint, mergePartial } from '../snapshot-share.js';
import { POLL_FAST_MS } from '../poll-schedule.js';
import { usePolling } from '../use-polling.js';
import { syncScheduleSettings } from '../schedule-settings.js';
import { GENERATION_DEFAULTS, generationFormDefaults, syncGenerationDefaults } from '../generation-status.js';
import { isActiveJob, isCancellable } from '../job-visibility.js';
import { JOB_TYPES } from '../../lib/job-status.js';
import { uiFormat } from '../i18n.js';
import { attachWake, createSnapshotPoll, shouldHandleLibraryEvent } from './snapshot-poll.js';
import { applyLiveJobs } from './live-jobs.js';
import { flushUndoable } from '../undoable.js';
import { sessionPerformance, snapshotChars } from '../session-performance.js';
import { clearWarmSession, writeWarmBinding, writeWarmSnapshot } from './warm-session.js';
import { bindingNotice } from './binding-notice.js';

/* The connection to the library: the binding (which folder, which model), the snapshot the whole app reads, how it is kept
   fresh (the first handshake, then the shared polling loop) and what happens when the library underneath changes. */

/** The generate form of a library that has not been opened yet: the defaults of its settings plus the content language. */
const CONTENT_LANGUAGE = { en: 'English', zh: '中文' };
export const initialGeneration = (host, language) => ({ ...GENERATION_DEFAULTS, language: host.defaultContentLanguage || CONTENT_LANGUAGE[language] || CONTENT_LANGUAGE.zh });
export const freshGeneration = (settings, language = getUiLanguage()) => ({ ...generationFormDefaults(settings?.generation, language), title: '', course: undefined });

export async function performBindingUpdate({
  patch,
  bindingRef,
  refs,
  host,
  language,
  call,
  refresh,
  resetLibraryState,
  setBinding,
  setData,
  setLoading,
  setBusy,
  setError,
  notify,
  flushUndoable: flush = flushUndoable,
  writeWarmBinding: saveWarmBinding = writeWarmBinding,
  clearWarmSession: dropWarmSession = clearWarmSession,
  customBinding,
}) {
  const prevRoot = bindingRef.current?.root ?? '';
  if (Object.hasOwn(patch, 'root') && patch.root !== prevRoot) {
    // A 删除 still in its 撤销 time goes to the library it was made in, before the move.
    await flush();
  }
  setBusy(true);
  setError('');
  try {
    const value = await call('binding.set', customBinding(patch));
    const moved = value.root !== prevRoot;
    if (moved) {
      resetLibraryState('binding', { gen: initialGeneration(host, language) });
      refs.dataRef.current = null;
      refs.snapshotKey.current = {};
      setData(null);
      setLoading(true);
      setBusy(true);
      bindingRef.current = value;
      setBinding(value);
      if (value.root) saveWarmBinding(host.warmKey, value);
      else dropWarmSession(host.warmKey);
      try {
        await refresh();
      } finally {
        setLoading(false);
      }
    } else {
      bindingRef.current = value;
      setBinding(value);
      saveWarmBinding(host.warmKey, value);
      await refresh();
    }
    notify(bindingNotice({ patch, moved, value, host }));
    return true;
  } catch (failure) {
    setError(failure.message);
    return false;
  } finally {
    setBusy(false);
  }
}

export function useLibraryConnection({ core, libApi, resetLibraryState, session, host, language, warm = null }) {
  const { call, quick, quickStamp, setError, setBusy, notify, refs } = core;
  const bindingUpdatingRef = useRef(false);
  const [serverData, setData] = useState(() => warm?.data ?? null);
  const [binding, setBinding] = useState(() => warm?.binding ?? { root: '', provider: '', model: '' });
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const [loading, setLoading] = useState(() => !warm?.data), [connecting, setConnecting] = useState(''), [syncIssue, setSyncIssueText] = useState(''), [syncTransient, setSyncTransient] = useState(false);
  // The bar says 重新连接中… for a host that is not up yet; the code of the error says so, the text alone cannot (the host's words are Chinese).
  const setSyncIssue = useCallback((text, transient = false) => { setSyncIssueText(text); setSyncTransient(!!text && !!transient); }, []);
  /* Light actions (知道了, 全部已读) patch what is on screen at once and run in the background; see ui/quick-actions.js.
     `data` is the server snapshot with those pending patches applied. */
  const data = useMemo(() => quick.view(serverData), [quick, serverData, quickStamp]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { quick.reconcile(serverData); }, [quick, serverData]);
  refs.bindingRoot.current = binding.root;

  const refresh = useCallback(async () => {
    const sequence = ++refs.requestSequence.current;
    const started = refs.epoch.current;
    const since = refs.dataRef.current?.fingerprint;
    /* A running job's progress, usage, calls and output are not in the fingerprint (lib/job-structure.js): an answer that is not a whole snapshot is followed by
       the small read of the running jobs, put over the snapshot's own rows (ui/app/live-jobs.js); nothing is asked when no job runs. A later request, or a
       snapshot that landed meanwhile, owns the panel; a failed live read keeps what the panel holds and never fails the refresh (applyLiveJobs). */
    const liveJobs = () => applyLiveJobs({ call, refs, started, sequence, setData });
    // `partial`: when only the clock moved since `since`, the host answers just the parts that read it (#567); older hosts ignore it.
    let next = await call('snapshot', since ? { since, partial: true } : {});
    if (started !== refs.epoch.current) return refs.dataRef.current;
    // Nothing visible changed: skip transferring, diffing and re-rendering.
    if (next.unchanged && refs.dataRef.current) return liveJobs();
    // A partial answer only applies on top of the snapshot it was asked against; a later request owns the panel, and one that finds
    // a snapshot other than `since` under it asks for the whole snapshot instead.
    if (next.partial) {
      if (sequence !== refs.requestSequence.current) return refs.dataRef.current;
      if (refs.dataRef.current?.fingerprint !== since) {
        next = await call('snapshot', {});
        if (started !== refs.epoch.current) return refs.dataRef.current;
      }
    }
    let result = next;
    if (sequence === refs.requestSequence.current && !next.unchanged) {
      // Root, model availability and due counts can change without a store write.
      // Compare the public snapshot key by key before skipping a render; a key that did not change keeps its
      // identity, so memoised views over data.sources, data.decks ... survive a poll that only moved `progress`.
      const cur = refs.dataRef.current;
      const applyStarted = performance.now();
      const shared = next.partial ? mergePartial(cur, next, refs.snapshotKey.current) : shareUnchanged(cur, next, refs.snapshotKey.current);
      const value = shared.value;
      if (shared.changed) {
        const nextBinding = cur && cur.root !== value.root ? { ...bindingRef.current, root: value.root } : bindingRef.current;
        if (cur && cur.root !== value.root) {
          resetLibraryState('switch', { gen: freshGeneration(value.settings), settings: value.settings });
          bindingRef.current = nextBinding;
          setBinding(nextBinding);
        }
        if (!cur || (cur.root === value.root && cur.settings !== value.settings)) {
          const lang = getUiLanguage();
          const before = cur ? generationFormDefaults(cur.settings?.generation, lang) : initialGeneration(host, lang);
          const after = generationFormDefaults(value.settings?.generation, lang);
          libApi.setGen((current) => syncGenerationDefaults(current, before, after));
        }
        refs.dataRef.current = value;
        refs.snapshotKey.current = shared.texts;
        setData(value);
        writeWarmSnapshot(host.warmKey, { binding: nextBinding, data: value, snapshotKey: shared.texts });
        libApi.setSettings((current) => syncScheduleSettings(current, cur?.settings, value.settings));
        result = value;
        // Only a snapshot that changed more than the clock counts; its size is read from the texts the diff above made, not measured again.
        if (!sameExceptFingerprint(cur, value)) sessionPerformance.recordSnapshot(snapshotChars(shared.texts, next), performance.now() - applyStarted);
      } else result = cur;
    }
    return next.partial ? liveJobs() : result;
  }, [call, refs, resetLibraryState, libApi, host.defaultContentLanguage, host.warmKey]); // eslint-disable-line react-hooks/exhaustive-deps
  refs.refreshRef.current = refresh;

  // The interface language is also the default language of what gets generated, and run titles are localized.
  const previousLanguage = useRef(language);
  useEffect(() => {
    if (previousLanguage.current === language) return;
    const before = generationFormDefaults(refs.dataRef.current?.settings?.generation, previousLanguage.current);
    previousLanguage.current = language;
    const after = generationFormDefaults(refs.dataRef.current?.settings?.generation, language);
    libApi.setGen((current) => syncGenerationDefaults(current, before, after));
    session.patchRun((current) => localizedRun(current));
    if (refs.dataRef.current) {
      const relocalized = relocalizeSnapshotRuns(refs.dataRef.current);
      if (relocalized !== refs.dataRef.current) {
        const nextTexts = { ...refs.snapshotKey.current };
        for (const key of ['runs', 'exams', 'lastRun']) {
          if (Object.hasOwn(relocalized, key)) nextTexts[key] = JSON.stringify(relocalized[key]) ?? '';
        }
        refs.dataRef.current = relocalized;
        refs.snapshotKey.current = nextTexts;
        setData(relocalized);
        writeWarmSnapshot(host.warmKey, { binding: bindingRef.current, data: relocalized, snapshotKey: nextTexts });
      }
    }
    void refresh().catch((failure) => setError(failure.message));
  }, [language, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    (async () => {
      // Right after a host restart the plugin route may not exist yet; keep retrying for a while instead of stranding the panel on an error.
      for (let attempt = 0; live; attempt++) {
        try {
          // Both requests resolve the library on the server; firing them together saves a full round trip on first open.
          const [b, snapshot] = await Promise.allSettled([call('binding.get'), refresh()]);
          if (b.status === 'rejected') throw b.reason;
          if (live) {
            if (refs.dataRef.current && b.value.root !== refs.dataRef.current.root) {
              resetLibraryState('switch', { gen: freshGeneration(undefined) });
              refs.dataRef.current = null;
              refs.snapshotKey.current = {};
              setData(null);
              bindingRef.current = b.value;
              setBinding(b.value);
              if (b.value.root) {
                writeWarmBinding(host.warmKey, b.value);
                await refresh();
              } else {
                clearWarmSession(host.warmKey);
              }
            } else {
              bindingRef.current = b.value;
              setBinding((current) => JSON.stringify(current) === JSON.stringify(b.value) ? current : b.value);
              writeWarmBinding(host.warmKey, b.value);
              if (refs.dataRef.current && refs.dataRef.current.root === b.value.root) {
                writeWarmSnapshot(host.warmKey, { binding: b.value, data: refs.dataRef.current, snapshotKey: refs.snapshotKey.current });
              }
            }
          }
          if (b.value.root && snapshot.status === 'rejected') throw snapshot.reason;
          break;
        } catch (failure) {
          if (!live) return;
          if (isTransientStudyError(failure) && attempt < 20) {
            setConnecting(uiFormat('正在连接 StudyHub…（第 {0} 次重试）', [attempt + 1]));
            await new Promise((done) => setTimeout(done, Math.min(1000 * (attempt + 1), 5000)));
            continue;
          }
          setError(failure.message);
          break;
        }
      }
      if (live) { setConnecting(''); setLoading(false); }
    })();
    return () => { live = false; };
  }, [call, refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  /* Work the host is doing for the learner keeps the quick poll rhythm; see ui/poll-schedule.js. */
  const running = !!data?.jobs?.some(isActiveJob);
  const publishing = !!data?.jobs?.some((job) => job.type === JOB_TYPES.DRAFT_PUBLISH && isCancellable(job));
  const working = running || !!data?.coach?.preparing || !!data?.assist?.some(isCancellable);
  const workingRef = useRef(false), pollToken = useRef({});
  workingRef.current = working;
  useEffect(() => { pollToken.current = {}; return () => { pollToken.current = {}; }; }, [binding.root]);
  const poll = useMemo(() => createSnapshotPoll({ refresh: () => refs.refreshRef.current(), readData: () => refs.dataRef.current, readToken: () => pollToken.current,
    setSyncIssue, same: sameExceptFingerprint, isWorking: () => workingRef.current }), [refs, setSyncIssue]);
  const { refresh: refreshPoller } = usePolling(poll.run, { intervalMs: POLL_FAST_MS, enabled: !!binding.root, backoff: true });
  const lastFocusCheckRef = useRef(0);
  const subscribeLibraryEvents = host.subscribeLibraryEvents;
  useEffect(() => {
    if (!binding.root) return undefined;
    return attachWake(poll, {
      onFocus() {
        const now = Date.now();
        if (now - lastFocusCheckRef.current < 350) return;
        lastFocusCheckRef.current = now;
        void refreshPoller();
      },
    });
  }, [binding.root, poll, refreshPoller]);
  useEffect(() => {
    if (!binding.root || typeof subscribeLibraryEvents !== 'function') return undefined;
    return subscribeLibraryEvents((event) => {
      if (!shouldHandleLibraryEvent(event, {
        currentRoot: bindingRef.current?.root,
        currentRevision: refs.dataRef.current?.revision,
      })) return;
      poll.wake();
      void refreshPoller();
    });
  }, [binding.root, subscribeLibraryEvents, poll, refreshPoller, refs]);

  /* The folder and model the library runs on. Moving the folder is a library switch: everything of the old one is dropped. */
  const customBinding = (patch) => ({
    root: binding.rootSource === 'custom' ? binding.root : '',
    provider: binding.modelSource === 'custom' ? binding.provider : '',
    model: binding.modelSource === 'custom' ? binding.model : '',
    reasoningEffort: binding.reasoningEffort || '',
    ...patch,
  });
  async function updateBinding(patch) {
    if (bindingUpdatingRef.current) return false;
    bindingUpdatingRef.current = true;
    try {
      return await performBindingUpdate({
        patch,
        bindingRef,
        refs,
        host,
        language,
        call,
        refresh,
        resetLibraryState,
        setBinding,
        setData,
        setLoading,
        setBusy,
        setError,
        notify,
        customBinding,
      });
    } finally {
      bindingUpdatingRef.current = false;
    }
  }
  return { data, loaded: !!data, binding, setBinding, loading, connecting, syncIssue, syncTransient, refresh, running, publishing, updateBinding };
}
