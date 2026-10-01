/* A stand-in for the search extension and for DSH's plugin manager, for the preview
   and tests (STUDY_FAKE_RETRIEVAL=extension). `pluginManager` installs nothing real:
   the first install is held back for build-script approval like pnpm does, an
   approved one "installs" the bundle, after which `tools` exposes the tools the real
   extension's server has (mcp__studyhub__ingest_data, query_documents, delete_file),
   backed by an in-memory index. `startFakeReleaseHost` serves the release asset and
   its SHA256SUMS on a loopback port (point STUDYHUB_QA_UPDATE_FEED at its origin), so
   the download and checksum path of the real install runs. No network, no model. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { INDEX_TOOLS } from '../lib/retrieval-index.js';
import { EXTENSION } from '../lib/large-documents.js';

const sleep = ms => new Promise(done => setTimeout(done, ms));
const SCHEMAS = [
  { name: INDEX_TOOLS.query, description: 'Search ingested documents with hybrid keyword + semantic matching.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: INDEX_TOOLS.ingest, description: 'Ingest in-memory content as a string.',
    parameters: { type: 'object', properties: { content: { type: 'string' }, metadata: { type: 'object' } }, required: ['content', 'metadata'] } },
  { name: INDEX_TOOLS.delete, description: 'Delete a previously ingested file or data.', parameters: { type: 'object', properties: { source: { type: 'string' } } } },
];
function terms(text) {
  const value = String(text ?? '').toLowerCase();
  const found = new Set(value.match(/[a-z0-9]{3,}/g) || []);
  for (const run of value.match(/[㐀-鿿]+/g) || []) for (let i = 0; i + 2 <= run.length; i++) found.add(run.slice(i, i + 2));
  return [...found];
}
const ok = value => ({ isError: false, value: { content: [{ type: 'text', text: JSON.stringify(value) }] }, content: [] });

/** { tools, pluginManager, state }: `delayMs` is the pace of one ingested page, the first one also "downloads the model". */
export function createFakeExtension({ delayMs = 120 } = {}) {
  const state = { installed: false, documents: new Map(), modelReady: false };
  const tools = {
    schemas: () => (state.installed ? SCHEMAS : []),
    execute: async ({ name, arguments: args, signal }) => {
      if (!state.installed) return { isError: true, error: { message: `Unknown tool ${name}` }, content: [] };
      if (name === INDEX_TOOLS.ingest) {
        if (!state.modelReady) { await sleep(delayMs * 6); state.modelReady = true; }
        await sleep(delayMs);
        signal?.throwIfAborted();
        state.documents.set(args.metadata.source, String(args.content));
        return ok({ ok: true });
      }
      if (name === INDEX_TOOLS.delete) { state.documents.delete(args.source); return ok({ ok: true }); }
      if (name === INDEX_TOOLS.query) {
        const wanted = terms(args.query);
        const hits = [...state.documents].map(([source, text]) => ({ source, text, score: wanted.length ? wanted.filter(term => text.toLowerCase().includes(term)).length / wanted.length : 0 }))
          .filter(entry => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(100, Number(args.limit) || 10)))
          .map((entry, index) => ({ text: entry.text.slice(0, 160), filePath: entry.source, title: entry.source, chunkIndex: 0, score: Math.round(entry.score * 1000) / 1000, rank: index }));
        return ok(hits);
      }
      return { isError: true, error: { message: `Unknown tool ${name}` }, content: [] };
    },
  };
  const pluginManager = {
    installBundle: async (_path, options = {}) => {
      if (!options.approvedBuilds?.length) return { changed: false, application: 'failed', stage: 'install', target: EXTENSION.package, pendingBuilds: ['onnxruntime-node', 'sharp'], packageResult: { kind: 'build-blocked', exitCode: 1, output: '' } };
      await sleep(delayMs * 8);
      state.installed = true;
      return { changed: true, application: 'applied', stage: 'enable', target: EXTENSION.package, bundle: EXTENSION.package, approvedBuilds: options.approvedBuilds };
    },
    removeBundle: async name => { state.installed = false; state.documents.clear(); return { changed: true, application: 'applied', stage: 'remove', target: name }; },
    listBundles: async () => (state.installed ? [{ name: EXTENSION.package, version: '0.0.0-fake', enabled: true, installed: true, optional: false, removable: true }] : []),
  };
  return { tools, pluginManager, state };
}

/** A loopback host standing in for the project's GitHub release downloads: any version's extension archive and its checksum list. */
export async function startFakeReleaseHost() {
  const bytes = Buffer.from('studyhub-retrieval fake release asset');
  const sums = version => `${createHash('sha256').update(bytes).digest('hex')}  ericwang1358-studyhub-retrieval-${version}.tgz\n`;
  const server = createServer((req, res) => {
    const match = /\/releases\/download\/v([^/]+)\/(.+)$/.exec(req.url || '');
    if (!match) { res.writeHead(404).end(); return; }
    const [, version, file] = match;
    if (file === `SHA256SUMS-${version}.txt`) res.writeHead(200).end(sums(version));
    else if (file === `ericwang1358-studyhub-retrieval-${version}.tgz`) res.writeHead(200).end(bytes);
    else res.writeHead(404).end();
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)) };
}
