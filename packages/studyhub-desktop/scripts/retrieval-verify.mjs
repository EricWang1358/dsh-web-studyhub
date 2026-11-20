import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runProcess, spawnPipeProcess } from '../adapters/cli/process-runner.mjs';
import { extractZipFile } from './zip-extract.mjs';
import { sha256File } from './zip-stream.mjs';

const VERIFY_TIMEOUT_MS = 45_000;

export const REQUIRED_BUNDLE_FILES = Object.freeze([
  'package.json',
  'index.js',
  'server.mjs',
  'batch-server.js',
  'heal.js',
  'check-index.mjs',
]);

export const EXPECTED_MCP_TOOLS = Object.freeze([
  'query_documents',
  'ingest_data',
  'ingest_data_batch',
  'delete_file',
]);

async function pathExists(target) {
  return access(target).then(() => true, () => false);
}

export async function assertBundleComplete(bundleDir, expectedVersion) {
  for (const rel of REQUIRED_BUNDLE_FILES) {
    if (!(await pathExists(join(bundleDir, rel)))) {
      throw new Error(`Retrieval bundle is missing required file: ${rel}`);
    }
  }
  if (!(await pathExists(join(bundleDir, 'node_modules')))) {
    throw new Error('Retrieval bundle is missing node_modules/');
  }
  const pkg = JSON.parse(await readFile(join(bundleDir, 'package.json'), 'utf8'));
  if (expectedVersion && pkg.version !== expectedVersion) {
    throw new Error(`Retrieval package.json version mismatch: expected ${expectedVersion}, got ${pkg.version}`);
  }
}

async function verifyModuleResolution(extractedDir) {
  const probe = [
    "import { createRequire } from 'node:module';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    'const dir = process.argv[1];',
    "const req = createRequire(join(dir, 'package.json'));",
    "const mcpEntry = req.resolve('mcp-local-rag');",
    'const mcpReq = createRequire(mcpEntry);',
    "const lancePath = mcpReq.resolve('@lancedb/lancedb');",
    'const lance = await import(pathToFileURL(lancePath).href);',
    "if (typeof (lance.connect ?? lance.default?.connect) !== 'function') throw new Error('LanceDB connect missing');",
    "const ort = mcpReq('onnxruntime-node');",
    "if (!ort) throw new Error('onnxruntime-node failed to load');",
    "const heal = await import(pathToFileURL(join(dir, 'heal.js')).href);",
    "if (typeof heal.healIndex !== 'function') throw new Error('healIndex missing');",
    "console.log(JSON.stringify({ ok: true, mcpEntry }));",
  ].join('\n');

  const res = await runProcess({
    command: process.execPath,
    args: ['--input-type=module', '-e', probe, extractedDir],
    cwd: extractedDir,
    env: { ...process.env, NODE_PATH: '' },
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    throw new Error(`Isolated retrieval module probe failed: ${res.stderr || res.stdout || res.errorMessage}`);
  }
}

function handleJsonRpcLine(raw, pending) {
  const line = raw.trim();
  if (!line) return;
  try {
    const msg = JSON.parse(line);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    entry.resolve(msg);
  } catch { /* ignore non-JSON stderr/log noise */ }
}

function createJsonRpcReader(proc, stderrChunks) {
  let buffer = '';
  const pending = new Map();
  const rejectAll = (err) => {
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  };
  proc.stdout?.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const raw of lines) handleJsonRpcLine(raw, pending);
  });
  proc.exited.then(({ code, signal }) => {
    const err = Buffer.concat(stderrChunks).toString('utf8').trim();
    rejectAll(new Error(`Retrieval server exited early (code=${code}, signal=${signal}): ${err}`));
  });
  return (id, method, params) => new Promise((res, rej) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const err = Buffer.concat(stderrChunks).toString('utf8').trim();
      rej(new Error(`Timed out waiting for MCP ${method}: ${err}`));
    }, VERIFY_TIMEOUT_MS);
    timer.unref?.();
    pending.set(id, {
      resolve: (msg) => { clearTimeout(timer); res(msg); },
      reject: (e) => { clearTimeout(timer); rej(e); },
    });
    proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, 'utf8');
  });
}

async function verifyMcpServerSmoke(extractedDir, tempRoot) {
  const dataRoot = join(tempRoot, 'mcp-smoke');
  const dbPath = join(dataRoot, 'lancedb');
  const cacheDir = join(dataRoot, 'models');
  const baseDir = join(dataRoot, 'documents');
  await mkdir(baseDir, { recursive: true });
  const stderrChunks = [];
  const proc = spawnPipeProcess({
    command: process.execPath,
    args: [join(extractedDir, 'server.mjs')],
    cwd: extractedDir,
    env: { ...process.env, NODE_PATH: '', DB_PATH: dbPath, CACHE_DIR: cacheDir, BASE_DIR: baseDir },
  });
  proc.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
  try {
    const request = createJsonRpcReader(proc, stderrChunks);
    const init = await request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'studyhub-pack-verify', version: '1.0.0' },
    });
    if (init.error) throw new Error(`MCP initialize error: ${JSON.stringify(init.error)}`);
    proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`, 'utf8');
    const listed = await request(2, 'tools/list', {});
    const names = new Set((listed?.result?.tools || []).map((t) => t.name));
    for (const tool of EXPECTED_MCP_TOOLS) {
      if (!names.has(tool)) throw new Error(`MCP server tools/list missing required tool: ${tool}`);
    }
    return [...names].sort();
  } finally {
    proc.kill();
    await proc.exited.catch(() => {});
  }
}

export async function verifyPackedRetrieval({ zipPath, checksumsPath, expectedVersion, runMcpSmoke = true }) {
  const sumsText = await readFile(checksumsPath, 'utf8');
  const match = /^([0-9a-f]{64})  (.+)$/m.exec(sumsText.trim());
  if (!match) throw new Error(`Invalid checksums file format: ${checksumsPath}`);
  const [, expectedHash, listedName] = match;
  if (listedName !== basename(zipPath)) {
    throw new Error(`Checksums filename mismatch: listed ${listedName}, actual ${basename(zipPath)}`);
  }
  const actualHash = await sha256File(zipPath);
  if (actualHash !== expectedHash) {
    throw new Error(`SHA-256 mismatch for ${zipPath}: expected ${expectedHash}, got ${actualHash}`);
  }

  const tempRoot = await mkdtemp(join(tmpdir(), 'studyhub-retrieval-verify-'));
  const extractedDir = join(tempRoot, 'bundle');
  try {
    await extractZipFile(zipPath, extractedDir);
    await assertBundleComplete(extractedDir, expectedVersion);
    if (!runMcpSmoke) return { ok: true, sha256: actualHash, tools: [] };
    await verifyModuleResolution(extractedDir);
    const tools = await verifyMcpServerSmoke(extractedDir, tempRoot);
    return { ok: true, sha256: actualHash, tools };
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
