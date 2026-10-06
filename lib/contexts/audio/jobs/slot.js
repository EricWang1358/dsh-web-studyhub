import { admitSlot } from '../../../jobs/scheduler.js';

/**
 * Wait for the host's transcription slot and hold it for the attempt. `release()` frees it early (a recording that is transcribed lets the next one
 * start while it is proofread); `finish()` frees it for good. A pause or a stop ends the wait.
 */
export async function holdTranscriptionSlot(context, gate) {
  let start, finish, release;
  const admitted = new Promise(resolve => { start = resolve; }), held = new Promise(resolve => { finish = resolve; });
  const signal = AbortSignal.any([context.signal, context.pauseSignal]);
  const drained = admitSlot(gate, context.attemptId, signal, free => { release = free; start(); return held; });
  await admitted;
  return { release: () => release?.(), async finish() { finish(); await drained; } };
}
