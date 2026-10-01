/* StudyHub search extension: a DSH bundle with one small plugin.
   Installed through DSH's plugin manager, it mounts DSH's own MCP client for a
   local document-search server (mcp-local-rag, an npm dependency of this bundle).
   The server is started with the Node DSH itself runs on (process.execPath; under
   DSH Desktop that is Electron in Node mode) and its entry file is found next to
   this package, so no config file is edited and no system Node, Python or Docker
   is needed. Its tools appear as mcp__studyhub__<tool>; StudyHub finds them through
   DSH's tool registry. Data lives under <DSH home>/study/retrieval. */
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'studyhub-retrieval';
export const inject = [];
/** mcp-local-rag requires Node 22. */
export const MIN_NODE_MAJOR = 22;
/** Server name: its tools are mcp__studyhub__query_documents, mcp__studyhub__ingest_data, ... */
export const SERVER_NAME = 'studyhub';
/** The first call downloads the embedding model (about 90 MB), so a call may take minutes. */
const TOOL_CALL_TIMEOUT_MS = 15 * 60 * 1000;

const dshHome = () => process.env.DSH_HOME?.trim() || join(homedir(), '.dsh');

/** The one optional setting: an https address to download the embedding model from (HF_ENDPOINT of the server). */
export async function readEndpoint(home = dshHome()) {
  try {
    const value = JSON.parse(await readFile(join(home, 'study', 'retrieval.json'), 'utf8'))?.hfEndpoint;
    return typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value) ? value : undefined;
  } catch { return undefined; }
}

/** The MCP client entry for the server: absolute paths only, no credentials. */
export function serverConfig({ home, entry, execPath = process.execPath, electron = false, hfEndpoint }) {
  const data = join(home, 'study', 'retrieval');
  return {
    serverName: SERVER_NAME,
    transport: 'stdio',
    command: execPath,
    args: [entry],
    env: {
      DB_PATH: join(data, 'lancedb'),
      CACHE_DIR: join(data, 'models'),
      BASE_DIR: join(data, 'documents'),
      ...(electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      ...(hfEndpoint ? { HF_ENDPOINT: hfEndpoint } : {}),
    },
    toolCallTimeoutMs: TOOL_CALL_TIMEOUT_MS,
    failOnStartupError: false,
  };
}

/** Mount the server. Resolves { mounted: true } or { mounted: false, reason: 'node' | 'client' | 'server' }; never throws. */
export async function mount(ctx, {
  home = dshHome(), execPath = process.execPath, node = process.versions.node, electron = !!process.versions.electron,
  resolveEntry = () => createRequire(import.meta.url).resolve('mcp-local-rag'),
  loadClient = () => import('@deepseek-ai/dsh-mcp-client'),
  warn = message => console.warn(`[studyhub-retrieval] ${message}`),
} = {}) {
  if (Number(String(node).split('.')[0]) < MIN_NODE_MAJOR) {
    warn(`DSH runs on Node ${node}; the search server needs Node ${MIN_NODE_MAJOR} or newer, so it was not started.`);
    return { mounted: false, reason: 'node' };
  }
  let client;
  try { client = await loadClient(); }
  catch { warn("DSH's MCP client is not available in this DSH, so the search server was not started."); return { mounted: false, reason: 'client' }; }
  let entry;
  try { entry = resolveEntry(); }
  catch { warn('The search server package (mcp-local-rag) is not installed next to this extension.'); return { mounted: false, reason: 'server' }; }
  await mkdir(join(home, 'study', 'retrieval', 'documents'), { recursive: true }).catch(() => {});
  ctx.plugin(client, serverConfig({ home, entry, execPath, electron, hfEndpoint: await readEndpoint(home) }));
  return { mounted: true };
}

export async function apply(ctx) { await mount(ctx); }
