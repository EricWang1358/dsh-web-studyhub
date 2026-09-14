/** Keep answer writes ordered; a failed last write blocks navigation/submit
 * until a subsequent selection has been saved successfully. */
export function createWriteQueue() {
  let tail = Promise.resolve();
  return {
    enqueue(write) {
      tail = tail.catch(() => {}).then(write);
      return tail;
    },
    flush() {
      return tail;
    },
  };
}
