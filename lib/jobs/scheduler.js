/** S1-3: shared internal resource entry points. This owns no resource instances.
 * The host still owns its gate; each recording/batch still owns its text pool.
 * Callers must use a distinct active token and check their signal before I/O.
 * Queued abort deliberately invokes work(release) for legacy domain cleanup.
 * No provider quota, shared cooldown or extra retry layer is introduced here.
 */
export { createPool } from '../audio-pool.js';

export function pumpSlots(gate) {
  while (gate.waiting.length && gate.active.size < gate.limit) {
    const next = gate.waiting.shift();
    gate.active.add(next.id);
    next.start();
  }
}

/** How many are ahead of a job that asks for a slot now: 0 when one is free, otherwise everyone waiting plus itself. */
export const queuedAhead = gate => (gate.active.size >= gate.limit ? gate.waiting.length + 1 : 0);

/** Run `work(release)` when the gate has a free transcription slot. `release()` frees the slot early (once the audio is
 *  transcribed, so the next recording can start while this one is proofread); it is also called when `work` ends. */
export function admitSlot(gate, taskId, signal, work) {
  let onAbort, released = false;
  const release = () => { if (released) return; released = true; gate.active.delete(taskId); pumpSlots(gate); };
  const turn = new Promise(resolve => {
    gate.waiting.push({ id: taskId, start: resolve });
    onAbort = () => { const at = gate.waiting.findIndex(entry => entry.id === taskId); if (at >= 0) { gate.waiting.splice(at, 1); resolve(); } };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  pumpSlots(gate);
  return turn.then(() => work(release)).finally(() => { signal.removeEventListener('abort', onAbort); release(); });
}

