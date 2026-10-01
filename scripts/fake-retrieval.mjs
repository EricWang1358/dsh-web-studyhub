/* A stand-in for an MCP search tool in the preview and in tests (STUDY_FAKE_RETRIEVAL=1).
   It has the shape DSH's tool registry gives a plugin (`schemas()`, `execute()`)
   and answers the way a document-search MCP server does: a JSON list of passages
   with the file name and page. It searches the library's own sources by shared
   words, so what it returns can be matched to pages. No network, no model. */
import { Store } from '../lib/store.js';

export const FAKE_RETRIEVAL_TOOL = 'mcp__books__query_documents';
const SCHEMA = { name: FAKE_RETRIEVAL_TOOL, description: 'Semantic search over the converted textbooks (preview stand-in)',
  parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } };

/** Words of a query: Latin words of 3+ letters and overlapping pairs of CJK characters. */
function terms(text) {
  const value = String(text ?? '').toLowerCase();
  const found = new Set(value.match(/[a-z0-9]{3,}/g) || []);
  for (const run of value.match(/[㐀-鿿]+/g) || []) for (let i = 0; i + 2 <= run.length; i++) found.add(run.slice(i, i + 2));
  return [...found];
}

/** { schemas(), execute(call) } over the library at `root`. */
export function createFakeRetrievalTools({ root }) {
  return {
    schemas: () => [SCHEMA],
    execute: async ({ name, arguments: args }) => {
      if (name !== FAKE_RETRIEVAL_TOOL) return { isError: true, error: { message: `Unknown tool ${name}` }, content: [] };
      const wanted = terms(args?.query);
      const { sources = [] } = await new Store(root).read();
      const hits = sources.filter(source => Number.isInteger(source.document?.page)).map(source => {
        const text = String(source.text ?? '');
        const score = wanted.length ? wanted.filter(term => text.toLowerCase().includes(term)).length / wanted.length : 0;
        const at = Math.max(0, text.toLowerCase().indexOf(wanted.find(term => text.toLowerCase().includes(term)) ?? ''));
        return { score, hit: { text: text.slice(Math.max(0, at - 20), at + 100).trim(), page: source.document.page, document: source.document.filename || source.title, score: Math.round(score * 1000) / 1000 } };
      }).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, Number(args?.limit) || 10)));
      return { isError: false, value: { content: [{ type: 'text', text: JSON.stringify(hits.map(entry => entry.hit)) }] }, content: [] };
    },
  };
}
