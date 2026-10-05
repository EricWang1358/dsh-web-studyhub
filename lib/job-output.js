/* The live output of a running model call (the 任务 console's 实时输出).

   An in-memory ring buffer per running call: the last OUTPUT_LIMIT characters of what the model has written so far, plus a count of
   everything it wrote, so a reader can ask for "what is new since position N" and get only that. It is never persisted and it is dropped the
   moment the call ends (the full conversation is the DSH session's, which the console links to when the host can open it). The number
   of buffers is bounded too, so a call that never closes cannot grow memory. Reasoning is only counted: it is not the answer.

   The text arrives from two places, both on the model path of this plugin: the direct streamed call (lib/index.js reads each text delta of
   `ctx.llm.stream`), and a DSH sub-agent, whose process-local `agent/assistant-stream` frames `tapChildStream` follows. A call through
   anything that does not offer its text on the way (a Gemini request) has no buffer, and the console says so. */

export const OUTPUT_LIMIT = 8192;
const MAX_CALLS = 24;

export function createOutputStore({ limit = OUTPUT_LIMIT, maxCalls = MAX_CALLS } = {}) {
  const buffers = new Map(), ended = new Set();
  const key = (jobId, callId) => `${jobId}\0${callId}`;
  return {
    /** A call is about to run and will offer its text. Opening again keeps what is there. */
    open(jobId, callId) {
      const name = key(jobId, callId);
      if (buffers.has(name)) return;
      buffers.set(name, { total: 0, text: '', reasoning: 0 });
      ended.delete(name);
      while (buffers.size > maxCalls) buffers.delete(buffers.keys().next().value);
    },
    append(jobId, callId, text) {
      const buffer = buffers.get(key(jobId, callId));
      if (!buffer || typeof text !== 'string' || !text) return;
      buffer.total += text.length;
      buffer.text = (buffer.text + text).slice(-limit);
    },
    reasoning(jobId, callId, count) {
      const buffer = buffers.get(key(jobId, callId));
      if (buffer && Number.isFinite(count) && count > 0) buffer.reasoning += count;
    },
    /** The call ended: its text goes, and a late delta is dropped rather than resurrecting it. */
    close(jobId, callId) {
      const name = key(jobId, callId);
      buffers.delete(name);
      ended.add(name);
      while (ended.size > maxCalls * 4) ended.delete(ended.values().next().value);
    },
    dropJob(jobId) {
      for (const name of [...buffers.keys()]) if (name.startsWith(`${jobId}\0`)) buffers.delete(name);
    },
    /**
     * What is new since `since` (a position returned earlier as `next`): { text, next, total, reset, reasoning }, or null when there is no buffer.
     * `reset` says the reader's position is no longer in the buffer (older than what is kept, or from another buffer): it gets the whole tail
     * and should replace what it shows.
     */
    read(jobId, callId, since = 0) {
      const buffer = buffers.get(key(jobId, callId));
      if (!buffer) return null;
      const from = Number.isFinite(since) && since > 0 ? Math.floor(since) : 0, kept = buffer.total - buffer.text.length;
      const stale = from < kept && from !== 0 ? true : from === 0 && kept > 0, future = from > buffer.total;
      if (stale || future) return { text: buffer.text, next: buffer.total, total: buffer.total, reset: true, reasoning: buffer.reasoning };
      return { text: buffer.text.slice(from - kept), next: buffer.total, total: buffer.total, reset: false, reasoning: buffer.reasoning };
    },
    wasOpened: (jobId, callId) => buffers.has(key(jobId, callId)) || ended.has(key(jobId, callId)),
    size: (jobId, callId) => buffers.get(key(jobId, callId))?.text.length ?? 0,
    count: () => buffers.size,
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
