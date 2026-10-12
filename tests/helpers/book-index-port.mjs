/* A stand-in for StudyHub's search extension (packages/studyhub-retrieval) as the host port shows it: ingest_data, delete_file and query_documents of
   mcp__studyhub__. What is ingested is kept in memory under its source key; a query scores the kept pages by shared words (or by `rank`, a test's own
   order) and answers the way the extension does: a JSON list of chunks naming their source. No network, no model. */
import { INDEX_TOOLS } from '../../lib/retrieval-index.js';

const terms = text => {
  const value = String(text ?? '').toLowerCase(), found = new Set(value.match(/[a-z0-9]{3,}/g) || []);
  for (const run of value.match(/[㐀-鿿]+/g) || []) for (let i = 0; i + 2 <= run.length; i++) found.add(run.slice(i, i + 2));
  return [...found];
};

/**
 * { tools, call, calls, kept, ingested() } — `delay` (ms per ingest, so a build can be seen running), `rank(query, keys)` -> [key] best first (else word
 * overlap), `query: false` leaves the query tool out (an extension that cannot search), `gate` (a promise every ingest waits for).
 */
export function indexPort({ delay = 0, rank = null, query = true, gate = null } = {}) {
  const calls = [], kept = new Map();
  const schema = name => ({ name, description: name, parameters: { type: 'object', properties: name === INDEX_TOOLS.query ? { query: { type: 'string' }, limit: { type: 'integer' } } : {} } });
  const tools = () => Object.values(INDEX_TOOLS).filter(name => query || name !== INDEX_TOOLS.query).map(schema);
  const call = async (name, args, options = {}) => {
    calls.push({ name, args });
    if (name === INDEX_TOOLS.ingest) {
      if (gate) await gate;
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      options.signal?.throwIfAborted?.();
      kept.set(args.metadata.source, args.content);
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    }
    if (name === INDEX_TOOLS.delete) { kept.delete(args.source); return { content: [{ type: 'text', text: '{"ok":true}' }] }; }
    if (name === INDEX_TOOLS.query) {
      const keys = [...kept.keys()], limit = Number(args.limit) || 10;
      let order;
      if (rank) order = rank(args.query, keys).map((key, at) => ({ key, score: 1 - at / 100 }));
      else {
        const wanted = terms(args.query);
        order = keys.map(key => { const text = kept.get(key).toLowerCase(); return { key, score: wanted.length ? wanted.filter(term => text.includes(term)).length / wanted.length : 0 }; })
          .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score);
      }
      const hits = order.slice(0, limit).map(entry => ({ text: String(kept.get(entry.key) ?? '').slice(0, 200), source: entry.key, score: entry.score }));
      return { content: [{ type: 'text', text: JSON.stringify(hits) }] };
    }
    throw new Error(`unknown tool ${name}`);
  };
  return { tools, call, calls, kept, ingested: () => calls.filter(item => item.name === INDEX_TOOLS.ingest).map(item => item.args.metadata.source) };
}
