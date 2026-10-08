/* The answers of 阅读 mode live in the panel only, and the panel starts again with every new selection. This holds the ones the learner did not keep, per
   passage, for as long as the reader is open: selecting the passage again brings them back, and an answer that was paid for while the learner had moved to
   another passage is put into the held thread when it arrives instead of being dropped. Nothing is written anywhere: closing the reader still drops them,
   which is what 阅读 says. Plain data, no React. */
export function createThreadMemory() {
  const held = new Map();
  // Worth holding: an answer, or a question still waiting for its answer (it has been paid for). A thread of failed questions only is not.
  const worth = thread => thread.nodes.some(node => node.status === 'answered' || node.status === 'asking');
  return {
    /** Hold the thread of `key` when it is worth it. A thread that is not (the panel between two passages) changes nothing; `forget` is the deletion. */
    remember(key, thread, saved = new Set()) {
      if (key && worth(thread)) held.set(key, { thread, saved: new Set(saved) });
    },
    recall(key) {
      const found = key ? held.get(key) : null;
      return found ? { thread: found.thread, saved: new Set(found.saved) } : null;
    },
    /** Apply the arrival of node `id` (its answer or its failure) to the held thread of `key`; false when that thread no longer has the node. */
    settle(key, id, change) {
      const found = key ? held.get(key) : null;
      if (!found || !found.thread.nodes.some(node => node.id === id)) return false;
      held.set(key, { ...found, thread: change(found.thread) });
      return true;
    },
    forget(key) { held.delete(key); },
  };
}
