/* The output of a model call (the 任务 console's 实时输出).

   An in-memory ring buffer per call: the last OUTPUT_LIMIT characters of what the model wrote, plus a count of everything it wrote, so a reader can ask
   for "what is new since position N" and get only that. A running call's buffer is read while it grows. When the call ends its buffer is NOT thrown away
   (2.6.1: "clicking a call that has ended must show what it wrote"): it is marked ended and kept, together with the buffers of the last KEEP_ENDED finished
   calls, oldest finished first out. Every buffer is capped at OUTPUT_LIMIT characters, so the whole store stays under about half a megabyte. It is memory
   only: never written to disk, and gone when the host restarts, which is why the full conversation of a DSH sub-agent can also be read from its session on demand
   (lib/session-reply.js; the jobs context's `job.output`). Reasoning is only counted: it is not the answer.

   The text arrives from two places, both on the model path of this plugin: the direct streamed call (lib/index.js reads each text delta of
   `ctx.llm.stream`), and a DSH sub-agent, whose process-local `agent/assistant-stream` frames `tapChildStream` follows. A call through
   anything that does not offer its text on the way (a Gemini request) has no buffer, and the console says so. */

export const OUTPUT_LIMIT = 8192;
/** Finished calls whose tail stays readable (the oldest finished goes first). */
export const KEEP_ENDED = 60;
const MAX_CALLS = 24;

export function createOutputStore({ limit = OUTPUT_LIMIT, maxCalls = MAX_CALLS, keepEnded = KEEP_ENDED } = {}) {
  // running: calls that are writing now; finished: the last `keepEnded` that ended (both Maps keep insertion order); opened: every call that was ever opened,
  // so a reader can tell "ended, nothing kept" from "never offered text on the way".
  const running = new Map(), finished = new Map(), opened = new Set();
  const key = (jobId, callId) => `${jobId}\0${callId}`;
  const markOpened = (name) => {
    opened.add(name);
    while (opened.size > (maxCalls + keepEnded) * 4) opened.delete(opened.values().next().value);
  };
  const finish = (name) => {
    const buffer = running.get(name);
    if (!buffer) return;
    running.delete(name);
    buffer.ended = true;
    finished.set(name, buffer);
    while (finished.size > keepEnded) finished.delete(finished.keys().next().value);
  };
  return {
    /** A call is about to run and will offer its text. Opening again keeps what is there. */
    open(jobId, callId) {
      const name = key(jobId, callId);
      if (running.has(name) || finished.has(name)) return;
      running.set(name, { total: 0, text: '', reasoning: 0 });
      markOpened(name);
      while (running.size > maxCalls) running.delete(running.keys().next().value);
    },
    append(jobId, callId, text) {
      const buffer = running.get(key(jobId, callId));
      if (!buffer || typeof text !== 'string' || !text) return;
      buffer.total += text.length;
      buffer.text = (buffer.text + text).slice(-limit);
    },
    reasoning(jobId, callId, count) {
      const buffer = running.get(key(jobId, callId));
      if (buffer && Number.isFinite(count) && count > 0) buffer.reasoning += count;
    },
    /** The call ended: its tail stays (marked ended), and a late delta is dropped rather than appended to it. */
    close(jobId, callId) { finish(key(jobId, callId)); },
    /** The job is over: every call of it that is still open ends with it (a call that never closed cannot keep a buffer running forever). */
    endJob(jobId) {
      for (const name of [...running.keys()]) if (name.startsWith(`${jobId}\0`)) finish(name);
    },
    /** Hard removal of everything a job has: running and finished buffers alike. */
    dropJob(jobId) {
      for (const map of [running, finished]) for (const name of [...map.keys()]) if (name.startsWith(`${jobId}\0`)) map.delete(name);
    },
    /**
     * What is new since `since` (a position returned earlier as `next`): { text, next, total, reset, reasoning } (+ `ended: true` once the call has ended),
     * or null when there is no buffer. `reset` says the reader's position is no longer in the buffer (older than what is kept, or from another buffer):
     * it gets the whole tail and should replace what it shows. An ended call is read the same way: from 0 once, then nothing new.
     */
    read(jobId, callId, since = 0) {
      const name = key(jobId, callId), buffer = running.get(name) || finished.get(name);
      if (!buffer) return null;
      const from = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0, kept = buffer.total - buffer.text.length;
      const stale = from < kept && from !== 0 ? true : from === 0 && kept > 0, future = from > buffer.total;
      const mark = buffer.ended ? { ended: true } : {};
      if (stale || future) return { text: buffer.text, next: buffer.total, total: buffer.total, reset: true, reasoning: buffer.reasoning, ...mark };
      return { text: buffer.text.slice(from - kept), next: buffer.total, total: buffer.total, reset: false, reasoning: buffer.reasoning, ...mark };
    },
    wasOpened: (jobId, callId) => opened.has(key(jobId, callId)),
    size: (jobId, callId) => (running.get(key(jobId, callId)) || finished.get(key(jobId, callId)))?.text.length ?? 0,
    /** Buffers of calls that are running now. */
    count: () => running.size,
    /** Buffers of finished calls that are still kept. */
    endedCount: () => finished.size,
  };
}

/**
 * Follow one DSH sub-agent's live reply: `sink.text(delta)` for every text delta and `sink.reasoning(length)` for every reasoning delta. DSH publishes
 * each frame of an agent's model attempt as the process-local event `agent/assistant-stream` ({ agent, frame }); a listener of an unscoped context
 * (the plugin's) receives every agent's, so the agent is picked by its id. Returns the function that stops listening. A host that cannot be
 * listened to is not an error: that call just has no live output.
 */
export function tapChildStream(ctx, childId, sink) {
  if (!childId || typeof ctx?.on !== 'function') return () => {};
  try {
    const off = ctx.on('agent/assistant-stream', (event) => {
      const agent = event?.agent;
      if (agent?.id !== childId && agent?.session?.id !== childId) return;
      const frame = event.frame;
      if (frame?.type !== 'chunk') return;
      const chunk = frame.chunk;
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') sink.text?.(chunk.text);
      else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') sink.reasoning?.(chunk.text.length);
    });
    return typeof off === 'function' ? off : () => {};
  } catch { return () => {}; }
}
