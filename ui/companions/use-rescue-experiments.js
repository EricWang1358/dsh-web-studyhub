import { useCallback, useMemo, useRef, useState } from 'react';
import { ui, errorMessage, getUiLanguage } from '../i18n.js';
import { usePolling } from '../use-polling.js';
import { isActiveJob } from '../../lib/job-status.js';

const NOT_FOUND_RE = /not\s*found|unknown\s*job|找不到|不存在/i;

/**
 * Shared non-blocking rescue-companion build & `job.status` poller used across
 * WrongBook (stubborn cards & clinic clusters) and Review Book (`还差：……`).
 */
export function useRescueExperiments({ call, onCompleted, failMessage } = {}) {
  const [jobs, setJobs] = useState({});
  const startingRef = useRef(new Set());
  const defaultFail = failMessage || ui('这次没能生成交互实验，可以重试或展开「其他办法」。');

  const running = useMemo(
    () => Object.entries(jobs).filter(([, entry]) => entry?.status === 'running' && entry.jobId),
    [jobs],
  );

  const poll = useCallback(async () => {
    if (!running.length) return { unchanged: true };
    let changed = false;
    const completedEntries = [];
    const nextPatch = {};
    for (const [key, entry] of running) {
      let job;
      try {
        job = await call('job.status', { jobId: entry.jobId });
      } catch (err) {
        const misses = (entry.pollErrors || 0) + 1;
        const gone = NOT_FOUND_RE.test(String(err?.message || err || ''));
        changed = true;
        nextPatch[key] = gone || misses >= 3
          ? { status: 'failed', jobId: entry.jobId, message: defaultFail }
          : { ...entry, pollErrors: misses };
        continue;
      }
      const status = job?.status ?? job?.contract?.status;
      if (!status) {
        const misses = (entry.pollErrors || 0) + 1;
        changed = true;
        nextPatch[key] = misses >= 3
          ? { status: 'failed', jobId: entry.jobId, message: defaultFail }
          : { ...entry, pollErrors: misses };
        continue;
      }
      const stage = job?.legacy?.companionStage
        || job?.companionStage
        || String(job?.contract?.stage?.code || '').replace(/^companion\./, '')
        || entry.stage;
      if (isActiveJob({ status })) {
        if (stage !== entry.stage || entry.pollErrors) {
          nextPatch[key] = { ...entry, stage, pollErrors: 0 };
          changed = true;
        }
        continue;
      }
      changed = true;
      if (status === 'complete') {
        const companionRef = (job?.contract?.result?.refs || []).find((ref) => ref?.kind === 'companion');
        const companionId = job?.contract?.detail?.companionId || job?.detail?.companionId || companionRef?.id || '';
        if (companionId) {
          const ready = {
            status: 'ready',
            jobId: entry.jobId,
            companionId,
            course: companionRef?.course || entry.course || '',
            title: companionRef?.title || '',
            ...(entry.hid ? { hid: entry.hid } : {}),
          };
          nextPatch[key] = ready;
          completedEntries.push({ key, ...ready });
        } else {
          nextPatch[key] = { status: 'failed', jobId: entry.jobId, message: defaultFail };
        }
      } else {
        const message = job?.error?.message || job?.contract?.error?.message || defaultFail;
        nextPatch[key] = { status: 'failed', jobId: entry.jobId, message: errorMessage(message) };
      }
    }
    if (changed) {
      setJobs((prev) => {
        let updated = null;
        for (const [key, patch] of Object.entries(nextPatch)) {
          if (prev[key]?.jobId !== patch.jobId) continue;
          if (!updated) updated = { ...prev };
          updated[key] = patch;
        }
        return updated || prev;
      });
    }
    if (completedEntries.length) {
      onCompleted?.(completedEntries);
    }
    return changed ? {} : { unchanged: true };
  }, [call, defaultFail, onCompleted, running]);

  usePolling(poll, { intervalMs: 1500, enabled: running.length > 0 });

  const start = useCallback(async (key, { course = '', deckId = '', cardIds = [], hid = '', topic = '', errorReason = '' } = {}) => {
    if (!key || startingRef.current.has(key)) return null;
    startingRef.current.add(key);
    const cleanCourse = String(course || '').trim();
    const cleanDeck = String(deckId || '').trim();
    const cleanHid = String(hid || '').trim();
    const cleanTopic = String(topic || '').trim();
    const cleanReason = String(errorReason || '').trim();
    const cleanCardIds = Array.isArray(cardIds) ? [...new Set(cardIds.filter(Boolean))].slice(0, 4) : [];
    setJobs((prev) => ({
      ...prev,
      [key]: { status: 'starting', stage: 'queued', course: cleanCourse, ...(cleanHid ? { hid: cleanHid } : {}) },
    }));
    try {
      const started = await call('generation.companion.build', {
        mode: 'rescue',
        ...(cleanCourse ? { course: cleanCourse } : {}),
        ...(cleanDeck ? { deckId: cleanDeck } : {}),
        ...(cleanCardIds.length ? { cardIds: cleanCardIds } : {}),
        ...(cleanHid ? { hid: cleanHid } : {}),
        ...(cleanTopic ? { topic: cleanTopic } : {}),
        ...(cleanReason ? { errorReason: cleanReason } : {}),
        language: getUiLanguage(),
      });
      if (!started?.jobId) {
        setJobs((prev) => ({
          ...prev,
          [key]: { status: 'failed', message: ui('这次没能启动交互实验，可以重试或展开「其他办法」。') },
        }));
        return null;
      }
      setJobs((prev) => ({
        ...prev,
        [key]: {
          status: 'running',
          jobId: started.jobId,
          stage: 'queued',
          course: cleanCourse,
          ...(cleanHid ? { hid: cleanHid } : {}),
          pollErrors: 0,
        },
      }));
      return started;
    } catch (failure) {
      setJobs((prev) => ({
        ...prev,
        [key]: { status: 'failed', message: errorMessage(failure) },
      }));
      return null;
    } finally {
      startingRef.current.delete(key);
    }
  }, [call]);

  return { jobs, start };
}
