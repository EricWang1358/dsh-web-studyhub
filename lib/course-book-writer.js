/* The writer queue of the 复习全书 (docs/plans/review-book.md I1), shared by every context that writes the book (the library's ops, and the materials action
   the 弄懂 task writes through): one per library folder, joined at the call, before any read, so the book's writes are served first-come-first-served in
   this process, each one store transaction. The tail of each queue; a settled one is dropped, so nothing outlives the writes it orders. */
const queues = Object.create(null);

/** Runs `task` after the book writes of the library at `root` that came before it. */
export function bookQueue(root, task) {
  // The key is known at once (no read before joining): the order of the calls is the order of the writes.
  const key = String(root ?? ''), next = (queues[key] || Promise.resolve()).then(task, task);
  const tail = next.catch(() => {});
  queues[key] = tail;
  tail.then(() => { if (queues[key] === tail) delete queues[key]; });
  return next;
}
