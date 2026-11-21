import { useEffect, useRef, useState } from 'react';
import { cellKey, cellRequest, cellsToAsk } from './cost.js';

/* Ask `usage.estimate` for each cell (ui/presets/cost.js cellRequest) once the form settles, one after another, and keep each answer by its request, so a cell the
   learner already priced (a preset and its matrix cell, a fold opened again) is not asked twice. Nothing is asked while `enabled` is off (no materials, or a depth
   that does not apply): then there is no ratio, never a made-up one. Returns key → estimate (null when it could not be made, undefined while it is being asked). */
const KEEP = 60;

export function useCellEstimates(call, base, cells, { enabled = true, delay = 450 } = {}) {
  const asked = enabled ? cellsToAsk(cells).map(cell => [cellKey(cell), JSON.stringify(cellRequest(base, cell))]) : [];
  const signature = JSON.stringify(asked);
  const answers = useRef(new Map()), callRef = useRef(call);
  callRef.current = call;
  const [, setAnswered] = useState(0);
  useEffect(() => {
    if (!enabled || typeof callRef.current !== 'function') return undefined;
    let live = true;
    const timer = setTimeout(async () => {
      for (const [, request] of asked) {
        if (!live) return;
        if (answers.current.has(request)) continue;
        let estimate = null;
        try { estimate = await callRef.current('usage.estimate', JSON.parse(request)); } catch { estimate = null; }
        if (!live) return;
        if (answers.current.size >= KEEP) answers.current.clear();
        answers.current.set(request, estimate?.totalTokens ? estimate : null);
        setAnswered(n => n + 1);
      }
    }, delay);
    return () => { live = false; clearTimeout(timer); };
  }, [signature, enabled, delay]); // eslint-disable-line react-hooks/exhaustive-deps
  return new Map(asked.map(([key, request]) => [key, answers.current.get(request)]));
}
