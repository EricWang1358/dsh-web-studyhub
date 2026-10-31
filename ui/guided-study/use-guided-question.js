import { useCallback, useEffect, useRef, useState } from 'react';
import { usePolling } from '../use-polling.js';
import { backoffDelay } from '../poll-schedule.js';

/* The guided workbench follows its session while it is on screen (#547). The main chat starts a new question with study.question.prepare; the panel
   only learns of it by reading the session again, so it reads it every few seconds: while the session waits for a question it asks
   study.question.result, and once the reviewed question is published its round of one question opens here (`onReady(result)`). A question the review
   did not pass is shown as failed with its reason; nothing else changes. Reads only, apart from that one result call, which settles the wait.
   The reads go through usePolling (#564): none while the page is hidden, slower while the session reads the same (backoffDelay), the quick
   rhythm while a question is being prepared, and none at all once the session is paused or ended (resuming hands the panel the session again). */

export const POLL_MS = 3000;

/** Whether the workbench keeps reading this session: not once it is paused or ended. */
export function guidedSessionPolls(session) {
  return !!session?.id && session.status !== 'paused' && session.status !== 'ended';
}

const fingerprint = (value) => { try { return JSON.stringify(value ?? null); } catch { return ''; } };

/**
 * One read of the session (and of the question being prepared). `seen` is a { current } ref holding the last session's fingerprint;
 * a session that reads the same is not set again. Answers usePolling's { unchanged, running }: unchanged when the session reads the same
 * as last time, running while a question is being prepared (the quick rhythm stays).
 */
export async function readGuidedSession({ call, sessionId, seen, setSession, setPrepState, onReady }) {
  if (!sessionId || typeof call !== 'function') return { unchanged: true, running: false };
  const keep = (current) => {
    const print = fingerprint(current);
    const same = print !== '' && print === seen.current;
    seen.current = print;
    if (!same) setSession(current);
    return same;
  };
  const current = await call('study.session.get', { sessionId });
  const same = keep(current);
  if (current?.focus?.kind !== 'preparing-card') return { unchanged: same, running: false };
  const result = await call('study.question.result', { sessionId });
  if (result?.status === 'running') { setPrepState({ status: 'running', stage: result.stage || '' }); return { unchanged: false, running: true }; }
  if (result?.status === 'failed') setPrepState({ status: 'failed', reason: result.reason || '', fallback: result.fallback });
  else setPrepState(null);
  if (result?.status === 'ready') onReady?.(result);
  keep(await call('study.session.get', { sessionId }));
  return { unchanged: false, running: false };
}

/** { session, prepState, refresh } for the workbench: the latest session, what its question preparation is doing ({ status: running | failed, ... } or null),
    and `refresh()` to read the session now (after the workbench changed it, so a slowed wait does not leave it showing the old state). */
export function useGuidedQuestion({ session, call, onReady, intervalMs = POLL_MS }) {
  const [live, setLive] = useState(session || null);
  const [prepState, setPrepState] = useState(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  const seen = useRef('');
  const sessionId = session?.id || null;
  useEffect(() => { setLive(session || null); seen.current = ''; }, [session]);
  const enabled = typeof call === 'function' && guidedSessionPolls(live?.id === sessionId ? live : session);
  const { refresh } = usePolling(
    () => readGuidedSession({ call, sessionId, seen, setSession: setLive, setPrepState, onReady: (result) => ready.current?.(result) }),
    { intervalMs, enabled, immediate: true, backoff: backoffDelay },
  );
  // Another session in the same workbench: read it now instead of after the current (possibly slowed) wait. A read in flight is not doubled.
  const shownId = useRef(sessionId);
  useEffect(() => {
    if (shownId.current === sessionId) return;
    shownId.current = sessionId;
    if (enabled) void refresh();
  }, [sessionId, enabled, refresh]);
  const clearFailure = useCallback(() => setPrepState(null), []);
  return { session: live, prepState, clearFailure, refresh };
}
