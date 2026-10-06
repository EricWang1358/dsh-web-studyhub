/** The one queue of a library: generate, supplement, selection fill, repair and publish all wait in it, one at a time, in the order they
 * were accepted. It is `work.queues` itself (one promise chain per library root); this module is the only code that grows the chain for
 * the entries of this family, so a submission through the runtime and a legacy one can never be in two different queues. */
export function libraryQueue({ queues, settled }) {
  const extend = (root, next) => {
    const done = next(queues.get(root) || Promise.resolve());
    queues.set(root, done);
    void done.finally(() => { if (queues.get(root) === done) queues.delete(root); });
    return done;
  };

  return Object.freeze({
    /** A job that runs its own executor: `task` starts when everything accepted before it has finished. `settled` is what `job.wait` waits on. */
    run(root, jobId, task) {
      const done = extend(root, previous => previous.then(task));
      settled.set(jobId, done);
      void done.finally(() => settled.delete(jobId));
      return done;
    },

    /** A job the runtime executes: `admitted` resolves at its turn and rejects with the stop reason when it is stopped while it still waits,
     * so a cancelled job never starts. `leave()` gives the library to the next one; it is safe to call more than once. */
    enter(root, signal) {
      const turn = Promise.withResolvers(), held = Promise.withResolvers();
      extend(root, previous => previous.then(() => { turn.resolve(); return held.promise; }));
      const admitted = new Promise((resolve, reject) => {
        const stop = () => { held.resolve(); reject(signal.reason); };
        if (signal.aborted) return stop();
        signal.addEventListener('abort', stop, { once: true });
        void turn.promise.then(() => { signal.removeEventListener('abort', stop); resolve(); });
      });
      return { admitted, leave: () => held.resolve() };
    },
  });
}
