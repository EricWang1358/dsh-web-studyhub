import { useRef, useState } from 'react';
import { useLiveEffect } from '../use-async.js';
import { cellKey, cellRequest, cellsToAsk } from './cost.js';

/* Ask `usage.estimate` for each cell (ui/presets/cost.js cellRequest) once the form settles, one after another. Like the form's own estimate (ui/TokenUsage.jsx
   useUsageEstimate) every cell is asked again whenever what is asked changes, and nothing is kept from one pass to the next but what is on screen: an estimate
   that failed, or one made for materials since edited, is never served again, and a cell never says another cost than the form's estimate line for the same
   request. Nothing is asked while `enabled` is off (ui/presets/cost.js pricesCells): then there is no ratio, never a made-up one. Returns key → estimate (null
   when it could not be made, undefined while it is being asked). */

/** One pass over the cells: ask each request (JSON text) in turn and `answer(request, estimate or null)`; stop as soon as the pass is no longer live. */
export async function askCells(call, requests, { isLive, answer }) {
  for (const request of requests) {
    if (!isLive()) return;
    let estimate = null;
    try { estimate = await call('usage.estimate', JSON.parse(request)); } catch { estimate = null; }
    if (!isLive()) return;
    answer(request, estimate?.totalTokens?.high > 0 ? estimate : null);
  }
}

export function useCellEstimates(call, base, cells, { enabled = true, delay = 450 } = {}) {
  const asked = enabled ? cellsToAsk(cells).map(cell => [cellKey(cell), JSON.stringify(cellRequest(base, cell))]) : [];
  const signature = JSON.stringify(asked);
  const answers = useRef(new Map()), callRef = useRef(call);
  callRef.current = call;
  const [, setAnswered] = useState(0);
  // The effect reads the cells from `signature` (the same list, as text), so its one dependency that changes is that text.
  useLiveEffect((isLive) => {
    if (!enabled || typeof callRef.current !== 'function') return undefined;
    const requests = JSON.parse(signature).map(([, request]) => request), wanted = new Set(requests);
    // What is on screen stays until its new answer arrives; a failure does not (it is asked again, and waits as 正在估算), nor a request this pass does not ask.
    for (const [request, estimate] of answers.current) if (!wanted.has(request) || estimate === null) answers.current.delete(request);
    const timer = setTimeout(() => askCells(callRef.current, requests, { isLive, answer: (request, estimate) => {
      answers.current.set(request, estimate);
      setAnswered(n => n + 1);
    } }), delay);
    return () => clearTimeout(timer);
  }, [signature, enabled, delay]);
  return new Map(asked.map(([key, request]) => [key, answers.current.get(request)]));
}
