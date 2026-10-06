// A fake search extension for the index build: a Map keyed by source key, so re-ingesting a key replaces it (the extension's documented behaviour).
import { INDEX_TOOLS } from '../../lib/retrieval-index.js';

/** `onIngest(args, n)` may wait or throw; `failDelete` makes every delete fail; `present: false` leaves the extension without tools. */
export function fakeIndexPort({ onIngest, failDelete = false, present = true } = {}) {
  const index = new Map(), calls = [];
  const port = {
    tools: () => present ? Object.values(INDEX_TOOLS).map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })) : [],
    async call(name, args, options = {}) {
      calls.push({ name, args, options });
      options.signal?.throwIfAborted();
      if (name === INDEX_TOOLS.ingest) {
        await onIngest?.(args, calls.filter(call => call.name === name).length, options);
        options.signal?.throwIfAborted();
        index.set(args.metadata.source, args.content);
      } else if (name === INDEX_TOOLS.delete) {
        if (failDelete) throw new Error('index busy');
        index.delete(args.source);
      }
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    },
  };
  const ingested = () => calls.filter(call => call.name === INDEX_TOOLS.ingest).map(call => call.args.metadata.source);
  const deleted = () => calls.filter(call => call.name === INDEX_TOOLS.delete).map(call => call.args.source);
  return { port, index, calls, ingested, deleted };
}

/** Block an ingest until its signal aborts, as a stuck extension call would. */
export const untilAborted = (_args, _n, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
