import { useCallback, useEffect, useRef, useState } from 'react';

/* The guided workbench follows its session while it is on screen (#547). The main chat starts a new question with study.question.prepare; the panel
   only learns of it by reading the session again, so it reads it every few seconds: while the session waits for a question it asks
   study.question.result, and once the reviewed question is published its round of one question opens here (`onReady(result)`). A question the review
   did not pass is shown as failed with its reason; nothing else changes. Reads only, apart from that one result call, which settles the wait. */

export const POLL_MS = 3000;

/** { session, prepState } for the workbench: the latest session and what its question preparation is doing ({ status: running | failed, ... } or null). */
export function useGuidedQuestion({ session, call, onReady, intervalMs = POLL_MS }) {
  const [live, setLive] = useState(session || null);
  const [prepState, setPrepState] = useState(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  const sessionId = session?.id || null;
  useEffect(() => { setLive(session || null); }, [session]);
  const tick = useCallback(async () => {
    if (!sessionId || typeof call !== 'function') return;
    const current = await call('study.session.get', { sessionId });
    setLive(current);
    if (current?.focus?.kind !== 'preparing-card') return;
    const result = await call('study.question.result', { sessionId });
    if (result?.status === 'running') { setPrepState({ status: 'running', stage: result.stage || '' }); return; }
    if (result?.status === 'failed') setPrepState({ status: 'failed', reason: result.reason || '', fallback: result.fallback });
    else setPrepState(null);
    if (result?.status === 'ready') ready.current?.(result);
    setLive(await call('study.session.get', { sessionId }));
  }, [call, sessionId]);
  useEffect(() => {
    if (!sessionId) return undefined;
    let stopped = false, timer = null, running = false;
    const loop = async () => {
      if (stopped || running) return;
      running = true;
      try { await tick(); } catch { /* the next read tries again; the workbench keeps what it shows */ }
      running = false;
      if (!stopped) timer = setTimeout(loop, intervalMs);
    };
    loop();
    return () => { stopped = true; clearTimeout(timer); };
  }, [sessionId, tick, intervalMs]);
  const clearFailure = useCallback(() => setPrepState(null), []);
  return { session: live, prepState, clearFailure };
}
