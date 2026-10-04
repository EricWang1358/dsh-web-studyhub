import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ui, getUiLanguage } from '../i18n.js';
import { localizedRun } from '../run-titles.js';
import { isTransientStudyError } from '../transport.js';
import { shareUnchanged, sameExceptFingerprint } from '../snapshot-share.js';
import { POLL_FAST_MS } from '../poll-schedule.js';
import { usePolling } from '../use-polling.js';
import { syncScheduleSettings } from '../schedule-settings.js';
import { GENERATION_DEFAULTS, generationFormDefaults, syncGenerationDefaults } from '../generation-status.js';
import { isActiveJob, isCancellable } from '../job-visibility.js';
import { JOB_TYPES } from '../../lib/job-status.js';
import { uiFormat } from '../i18n.js';
import { attachWake, createSnapshotPoll } from './snapshot-poll.js';

/* The connection to the library: the binding (which folder, which model), the snapshot the whole app reads, how it is kept
   fresh (the first handshake, then the shared polling loop) and what happens when the library underneath changes. */

/** The generate form of a library that has not been opened yet: the defaults of its settings plus the content language. */
const CONTENT_LANGUAGE = { en: 'English', zh: '中文' };
export const initialGeneration = (host, language) => ({ ...GENERATION_DEFAULTS, language: host.defaultContentLanguage || CONTENT_LANGUAGE[language] || CONTENT_LANGUAGE.zh });
export const freshGeneration = (settings) => ({ ...generationFormDefaults(settings?.generation), title: '', course: undefined });

export function useLibraryConnection({ core, libApi, resetLibraryState, session, nav, host, language }) {
  const { call, quick, quickStamp, setError, setBusy, notify, refs } = core;
  const [serverData, setData] = useState(null);
  const [binding, setBinding] = useState({ root: '', provider: '', model: '' });
  const [loading, setLoading] = useState(true), [connecting, setConnecting] = useState(''), [syncIssue, setSyncIssue] = useState('');
  /* Light actions (知道了, 全部已读) patch what is on screen at once and run in the background; see ui/quick-actions.js.
     `data` is the server snapshot with those pending patches applied. */
  const data = useMemo(() => quick.view(serverData), [quick, serverData, quickStamp]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { quick.reconcile(serverData); }, [quick, serverData]);
  refs.bindingRoot.current = binding.root;

  const refresh = useCallback(async () => {
    const sequence = ++refs.requestSequence.current;
    const started = refs.epoch.current;
    const since = refs.dataRef.current?.fingerprint;
    const next = await call('snapshot', since ? { since } : {});
    if (started !== refs.epoch.current) return refs.dataRef.current;
    // Nothing visible changed: skip transferring, diffing and re-rendering.
    if (next.unchanged && refs.dataRef.current) return refs.dataRef.current;
    let result = next;
    if (sequence === refs.requestSequence.current && !next.unchanged) {
      // Root, model availability and due counts can change without a store write.
      // Compare the public snapshot key by key before skipping a render; a key that did not change keeps its
      // identity, so memoised views over data.sources, data.decks ... survive a poll that only moved `progress`.
      const cur = refs.dataRef.current;
      const shared = shareUnchanged(cur, next, refs.snapshotKey.current);
      if (shared.changed) {
        if (cur && cur.root !== next.root) {
          resetLibraryState('switch', { gen: freshGeneration(next.settings), settings: next.settings });
          setBinding((b) => ({ ...b, root: next.root }));
        }
        if (!cur || (cur.root === next.root && cur.settings !== shared.value.settings)) {
          const before = cur ? generationFormDefaults(cur.settings?.generation) : initialGeneration(host, getUiLanguage());
          const after = generationFormDefaults(next.settings?.generation);
          libApi.setGen((current) => syncGenerationDefaults(current, before, after));
        }
        refs.dataRef.current = shared.value;
        refs.snapshotKey.current = shared.texts;
        setData(shared.value);
        libApi.setSettings((current) => syncScheduleSettings(current, cur?.settings, next.settings));
        result = shared.value;
      } else result = cur;
    }
    return result;
  }, [call, refs, resetLibraryState, libApi, host.defaultContentLanguage]); // eslint-disable-line react-hooks/exhaustive-deps
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
          if (live) setBinding(b.value);
          if (b.value.root && snapshot.status === 'rejected') throw snapshot.reason;
          break;
        } catch (failure) {
          if (!live) return;
          if (isTransientStudyError(failure) && attempt < 20) {
            setConnecting(uiFormat('正在连接学习插件…（第 {0} 次重试）', [attempt + 1]));
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
    setSyncIssue, same: sameExceptFingerprint, isWorking: () => workingRef.current }), [refs]);
  usePolling(poll.run, { intervalMs: POLL_FAST_MS, enabled: !!binding.root, backoff: true });
  useEffect(() => (binding.root ? attachWake(poll) : undefined), [binding.root, poll]);

  /* The folder and model the library runs on. Moving the folder is a library switch: everything of the old one is dropped. */
  const customBinding = (patch) => ({
    root: binding.rootSource === 'custom' ? binding.root : '',
    provider: binding.modelSource === 'custom' ? binding.provider : '',
    model: binding.modelSource === 'custom' ? binding.model : '',
    reasoningEffort: binding.reasoningEffort || '',
    ...patch,
  });
  async function updateBinding(patch) {
    ++refs.requestSequence.current;
    if (Object.hasOwn(patch, 'root')) {
      refs.epoch.current++;
      refs.navigation.current++;
      clearTimeout(refs.leaveTimer.current);
      nav.setPageTarget(null);
    }
    setBusy(true);
    setError('');
    try {
      const value = await call('binding.set', customBinding(patch));
      const moved = value.root !== binding.root;
      setBinding(value);
      if (moved) {
        resetLibraryState('binding', { gen: freshGeneration(refs.dataRef.current?.settings) });
        setBusy(true);
      }
      await refresh();
      notify(moved ? ui('已切换学习库') : Object.hasOwn(patch, 'reasoningEffort') ? ui('已更新推理程度') : ui('已更新生成模型'));
      return true;
    } catch (failure) {
      setError(failure.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { data, loaded: !!data, binding, setBinding, loading, connecting, syncIssue, refresh, running, publishing, updateBinding };
}
