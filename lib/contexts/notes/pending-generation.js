/** What a note's work table remembers of its running generation: a request that arrived meanwhile (`next`) and its `controller`, whose `abort` is the one way
 * every caller stops it (a supersede, a cancel, a deleted note, an unloaded plugin). `bind` replaces what stopping does (a generation that runs as a Job is
 * stopped through the Job); a stop asked before that is not lost. */
export function pendingGeneration(abortion) {
  const pending = { next: null, stopped: null, cancel: reason => abortion.abort(reason),
    controller: { signal: abortion.signal, abort(reason) { pending.stopped ??= reason; pending.cancel(reason); } },
    bind(cancel) { pending.cancel = cancel; if (pending.stopped) cancel(pending.stopped); } };
  return pending;
}
