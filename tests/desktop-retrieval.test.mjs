import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateRawSync, crc32 as zlibCrc32 } from 'node:zlib';

import {
  RETRIEVAL_COMPANION_PROVIDER_ID,
  buildDesktopExtensionState,
  compareSemver,
  formatRetrievalError,
  isVersionOutdated,
  parseSemver,
  parseSha256SumsLine,
  retrievalAssetName,
  retrievalChecksumsName,
  retrievalReleaseUrls,
  sanitizeDesktopRetrievalStatus,
  selectRetrievalCandidate,
  validateZipEntryPath,
} from '../packages/studyhub-desktop/domain/retrieval-policy.js';
import { createProcessRunner } from '../packages/studyhub-desktop/adapters/cli/process-runner.mjs';
import { createMcpStdioClient } from '../packages/studyhub-desktop/adapters/retrieval/mcp-stdio-client.mjs';
import {
  discoverRetrieval,
  resolveDesktopRetrievalDir,
  validateRetrievalDir,
} from '../packages/studyhub-desktop/adapters/retrieval/discovery.mjs';
import { extractZipArchive, unixModeOfZipEntry } from '../packages/studyhub-desktop/adapters/retrieval/zip-extract.mjs';
import { EventEmitter } from 'node:events';
import { createRetrievalInstaller } from '../packages/studyhub-desktop/adapters/retrieval/installer.mjs';
import { createIndexLock } from '../packages/studyhub-desktop/adapters/retrieval/index-lock.mjs';
import { createRetrievalRuntimePorts } from '../packages/studyhub-desktop/adapters/retrieval/runtime-ports.mjs';
import { createRetrievalRuntime } from '../packages/studyhub-desktop/application/retrieval-runtime.js';
import { prepareRetrievalForAction } from '../packages/studyhub-desktop/application/retrieval-actions.js';
import { createDesktopHost } from '../packages/studyhub-desktop/application/desktop-host.js';
import { createInProcessJobExecutor } from '../packages/studyhub-desktop/adapters/runtime/job-executor.mjs';
import { createConfigStore } from '../packages/studyhub-desktop/adapters/storage/config-store.mjs';
import { createZipBuffer } from '../packages/studyhub-desktop/scripts/zip-utils.mjs';
import { currentVersion } from '../lib/update-check.js';

function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/** Build a fake MCP stdio server script that speaks JSON-RPC 2.0 NDJSON. */
function fakeMcpServerSource({ tag = 'fake', crashOnCall = false, slowMs = 0 } = {}) {
  return `
process.stderr.write('[fake-mcp] booting ${tag}\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      process.stdout.write('non-json-noise-line\\n');
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'studyhub-fake', version: '1.0.0' } },
      }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'query_documents',
              description: 'Search indexed pages',
              inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
            },
            {
              name: 'ingest_data',
              description: 'Ingest a page',
              inputSchema: { type: 'object', properties: { content: { type: 'string' }, metadata: { type: 'object' } }, required: ['content', 'metadata'] },
            },
            {
              name: 'delete_file',
              description: 'Delete a source',
              inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
            },
          ],
        },
      }) + '\\n');
    } else if (msg.method === 'tools/call') {
      if (${JSON.stringify(crashOnCall)}) {
        process.stderr.write('simulated crash\\n');
        process.exit(42);
      }
      const respond = () => {
        const name = msg.params?.name;
        const args = msg.params?.arguments || {};
        const payload = {
          tag: ${JSON.stringify(tag)},
          tool: name,
          args,
          hfEndpoint: process.env.HF_ENDPOINT || '',
          dbPath: process.env.DB_PATH || '',
          pid: process.pid,
        };
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify([ { text: 'hit:' + (args.query || name), sourceId: 'p1', score: 0.9 } ]) }],
            structuredContent: payload,
          },
        }) + '\\n');
      };
      if (${Number(slowMs)} > 0) setTimeout(respond, ${Number(slowMs)});
      else respond();
    }
  }
});
`;
}

/** Create a valid retrieval directory fixture with package.json, server.mjs, heal.js, and node_modules/mcp-local-rag. */
async function createRetrievalFixtureDir(dir, { version = '4.15.1', tag = 'fixture', includeHeal = true } = {}) {
  await mkdir(join(dir, 'node_modules', 'mcp-local-rag'), { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@ericwang1358/studyhub-retrieval', version, type: 'module' }, null, 2),
    'utf8'
  );
  await writeFile(
    join(dir, 'node_modules', 'mcp-local-rag', 'package.json'),
    JSON.stringify({ name: 'mcp-local-rag', version: '0.20.0', main: './index.js' }),
    'utf8'
  );
  await writeFile(join(dir, 'node_modules', 'mcp-local-rag', 'index.js'), 'module.exports = {};\n', 'utf8');
  await writeFile(join(dir, 'server.mjs'), fakeMcpServerSource({ tag }), 'utf8');
  if (includeHeal) {
    await writeFile(join(dir, 'heal.js'), 'export async function healIndex() { return {}; }\n', 'utf8');
  }
}

/** Build a minimal ZIP64 archive (with ZIP64 EOCD locator + record + extra field). */
function createZip64Buffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data);
    const deflated = deflateRawSync(raw);
    const crc = zlibCrc32(raw) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(45, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(Buffer.concat([local, nameBuf, deflated]));

    const extra = Buffer.alloc(4 + 24);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(raw.length), 4);
    extra.writeBigUInt64LE(BigInt(deflated.length), 12);
    extra.writeBigUInt64LE(BigInt(offset), 20);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(45, 4);
    central.writeUInt16LE(45, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(0xffffffff, 20);
    central.writeUInt32LE(0xffffffff, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt32LE(0xffffffff, 42);
    centralParts.push(Buffer.concat([central, nameBuf, extra]));

    offset += local.length + nameBuf.length + deflated.length;
  }

  const centralBlock = Buffer.concat(centralParts);
  const zip64EocdOffset = offset + centralBlock.length;

  const zip64Eocd = Buffer.alloc(56);
  zip64Eocd.writeUInt32LE(0x06064b50, 0);
  zip64Eocd.writeBigUInt64LE(44n, 4);
  zip64Eocd.writeUInt16LE(45, 12);
  zip64Eocd.writeUInt16LE(45, 14);
  zip64Eocd.writeBigUInt64LE(BigInt(entries.length), 24);
  zip64Eocd.writeBigUInt64LE(BigInt(entries.length), 32);
  zip64Eocd.writeBigUInt64LE(BigInt(centralBlock.length), 40);
  zip64Eocd.writeBigUInt64LE(BigInt(offset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeUInt32LE(0, 4);
  locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
  locator.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0xffff, 8);
  eocd.writeUInt16LE(0xffff, 10);
  eocd.writeUInt32LE(0xffffffff, 12);
  eocd.writeUInt32LE(0xffffffff, 16);

  return Buffer.concat([...localParts, centralBlock, zip64Eocd, locator, eocd]);
}

/** Build a ZIP archive with a Unix symlink entry (0xa000 external attributes). */
function createSymlinkZipBuffer(name, target) {
  const base = createZipBuffer([{ name, data: Buffer.from(target, 'utf8') }]);
  const cdIndex = base.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(cdIndex >= 0);
  base.writeUInt16LE((3 << 8) | 20, cdIndex + 4);
  base.writeUInt32LE((0o120777 << 16) >>> 0, cdIndex + 38);
  return base;
}

/* ============================================================================
 * 1. Pure Domain Policy Tests
 * ============================================================================ */

test('domain/retrieval-policy builds exact release URLs, validates semver & Zip-Slip, and prioritizes B > D > none', () => {
  assert.equal(retrievalAssetName('v4.15.1'), 'StudyHub-Desktop-Retrieval-4.15.1-win-x64.zip');
  assert.equal(retrievalChecksumsName('4.15.1'), 'SHA256SUMS-Desktop-Retrieval-4.15.1.txt');
  assert.deepEqual(
    retrievalReleaseUrls('4.15.1', 'https://github.com/EricWang1358/dsh-web-studyhub/releases/download'),
    {
      version: '4.15.1',
      name: 'StudyHub-Desktop-Retrieval-4.15.1-win-x64.zip',
      checksumsName: 'SHA256SUMS-Desktop-Retrieval-4.15.1.txt',
      assetUrl: 'https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v4.15.1/StudyHub-Desktop-Retrieval-4.15.1-win-x64.zip',
      sha256Url: 'https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v4.15.1/SHA256SUMS-Desktop-Retrieval-4.15.1.txt',
    }
  );
  assert.throws(() => retrievalReleaseUrls('not-a-version', 'https://example.com/'));

  const digest = 'a'.repeat(64);
  assert.equal(
    parseSha256SumsLine(`${digest.toUpperCase()}  StudyHub-Desktop-Retrieval-4.15.1-win-x64.zip\n`, 'StudyHub-Desktop-Retrieval-4.15.1-win-x64.zip'),
    digest
  );
  assert.equal(parseSha256SumsLine(`${digest}  other.zip\n`, 'StudyHub-Desktop-Retrieval-4.15.1-win-x64.zip'), null);

  assert.equal(parseSemver('4.15.1')?.text, '4.15.1');
  assert.equal(compareSemver('4.6.2', '4.15.1'), -1);
  assert.equal(isVersionOutdated('4.6.1', '4.15.1', '4.6.2'), true);
  assert.equal(isVersionOutdated('4.6.2', '4.15.1', '4.6.2'), false);
  assert.equal(isVersionOutdated('4.7.0', '4.15.1', '4.6.2'), false);

  // Zip-Slip path guard
  assert.deepEqual(validateZipEntryPath('node_modules/mcp-local-rag/index.js'), {
    ok: true,
    normalized: 'node_modules/mcp-local-rag/index.js',
    isDir: false,
  });
  for (const bad of ['', '../evil.js', 'a/../../evil.js', '/etc/passwd', 'C:\\evil.js', '\\\\srv\\share\\a', 'foo\0bar', './a']) {
    assert.equal(validateZipEntryPath(bad).ok, false, `expected unsafe path rejected: ${JSON.stringify(bad)}`);
  }

  // B > D > none priority
  assert.equal(selectRetrievalCandidate([
    { valid: true, source: 'dsh', version: '4.15.1' },
    { valid: true, source: 'desktop', version: '4.11.0' },
  ])?.source, 'desktop');
  assert.equal(selectRetrievalCandidate([
    { valid: false, source: 'desktop', version: '4.15.1' },
    { valid: true, source: 'dsh', version: '4.7.0' },
  ])?.source, 'dsh');
  assert.equal(selectRetrievalCandidate([{ valid: false, source: 'dsh' }]), null);
});

test('domain/retrieval-policy shapes desktop extension states and suppresses DSH-leftover missing without mutation', () => {
  const noneExt = buildDesktopExtensionState({ candidate: null, currentVersion: '4.15.1', sinceVersion: '4.6.2' });
  assert.deepEqual(noneExt, {
    canInstall: true,
    installed: false,
    enabled: false,
    desktop: true,
    desktopHost: true,
    source: 'none',
    canUninstall: false,
    canInstallStandalone: true,
    restartRequired: false,
  });

  const dshExt = buildDesktopExtensionState({
    candidate: { valid: true, source: 'dsh', version: '4.7.0' },
    currentVersion: '4.15.1',
    sinceVersion: '4.6.2',
  });
  assert.equal(dshExt.installed, true);
  assert.equal(dshExt.source, 'dsh');
  assert.equal(dshExt.canUninstall, false);
  assert.equal(dshExt.canInstallStandalone, true);
  assert.equal(dshExt.outdated, undefined);

  const desktopExt = buildDesktopExtensionState({
    candidate: { valid: true, source: 'desktop', version: '4.15.1' },
    currentVersion: '4.15.1',
    sinceVersion: '4.6.2',
  });
  assert.equal(desktopExt.canUninstall, true);
  assert.equal(desktopExt.canInstallStandalone, false);

  const outdatedDesktop = buildDesktopExtensionState({
    candidate: { valid: true, source: 'desktop', version: '4.5.0' },
    currentVersion: '4.15.1',
    sinceVersion: '4.6.2',
  });
  assert.equal(outdatedDesktop.outdated, true);
  assert.equal(outdatedDesktop.expected, '4.15.1');
  assert.equal(outdatedDesktop.canInstallStandalone, true);

  // Suppress DSH-leftover missing when !installed
  const raw = {
    selected: RETRIEVAL_COMPANION_PROVIDER_ID,
    effective: 'builtin',
    missing: RETRIEVAL_COMPANION_PROVIDER_ID,
    companion: { id: RETRIEVAL_COMPANION_PROVIDER_ID, running: false },
  };
  const sanitized = sanitizeDesktopRetrievalStatus(raw, noneExt);
  assert.equal(sanitized.missing, undefined);
  assert.equal(sanitized.selected, 'builtin');
  assert.equal(raw.missing, RETRIEVAL_COMPANION_PROVIDER_ID, 'input object is not mutated');

  // Installed & failed start sets companion.notStarted, removes missing, and turns reset.pendingRestart -> restartedAfterRepair
  const rawAfterFailedRepair = {
    ...raw,
    companion: {
      id: RETRIEVAL_COMPANION_PROVIDER_ID,
      running: false,
      reset: { at: '2026-11-20T00:00:00Z', reason: 'repair', pages: 3, pendingRestart: true },
    },
  };
  const failedStatus = sanitizeDesktopRetrievalStatus(rawAfterFailedRepair, dshExt, { notStarted: true });
  assert.equal(failedStatus.missing, undefined);
  assert.equal(failedStatus.companion.notStarted, true);
  assert.equal(failedStatus.companion.reset.pendingRestart, undefined);
  assert.equal(failedStatus.companion.reset.restartedAfterRepair, true);
  assert.equal(rawAfterFailedRepair.companion.reset.pendingRestart, true, 'input reset object is not mutated');
  assert.match(formatRetrievalError('retrieval-index-locked', 'en'), /locked by another process/i);
});

/* ============================================================================
 * 2. MCP Stdio Client Tests
 * ============================================================================ */

test('adapters/retrieval/mcp-stdio-client handshakes, calls tools, handles timeouts/crashes, and terminates child cleanly', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studyhub-mcp-client-'));
  const clients = [];
  const makeClient = options => {
    const client = createMcpStdioClient(options);
    clients.push(client);
    return client;
  };
  t.after(async () => {
    await Promise.all(clients.map(client => client.close()));
    await rm(dir, { recursive: true, force: true });
  });

  const okServer = join(dir, 'ok-server.mjs');
  await writeFile(okServer, fakeMcpServerSource({ tag: 'ok' }), 'utf8');
  const client = makeClient({
    command: process.execPath,
    args: [okServer],
    cwd: dir,
  });
  const tools = await client.start();
  assert.deepEqual(tools.map((tool) => tool.name), ['query_documents', 'ingest_data', 'delete_file']);
  assert.equal(client.isRunning(), true);
  assert.match(client.getStderr(), /booting ok/);

  const res = await client.callTool('query_documents', { query: 'deadlock', limit: 5 });
  assert.equal(res.structuredContent.tag, 'ok');
  assert.equal(res.structuredContent.args.query, 'deadlock');

  const childPid = client.pid;
  await client.close();
  assert.equal(client.isRunning(), false);
  assert.equal(pidExists(childPid), false, 'child process is terminated after close()');

  // Timeout & AbortSignal
  const slowServer = join(dir, 'slow-server.mjs');
  await writeFile(slowServer, fakeMcpServerSource({ tag: 'slow', slowMs: 5000 }), 'utf8');
  const slowClient = makeClient({ command: process.execPath, args: [slowServer], cwd: dir });
  await slowClient.start();
  const slowPid = slowClient.pid;
  await assert.rejects(
    slowClient.callTool('query_documents', { query: 'q' }, { timeoutMs: 80 }),
    (err) => err?.code === 'retrieval-call-timeout'
  );
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('user-cancel')), 40);
  await assert.rejects(slowClient.callTool('query_documents', { query: 'q' }, { signal: ac.signal }), /user-cancel/);
  await slowClient.close();
  assert.equal(pidExists(slowPid), false, 'close waits for the server holding the working directory');

  // Unexpected child crash rejects pending call and invokes onExit
  const crashServer = join(dir, 'crash-server.mjs');
  await writeFile(crashServer, fakeMcpServerSource({ tag: 'crash', crashOnCall: true }), 'utf8');
  let exitEvent = null;
  const crashClient = makeClient({
    command: process.execPath,
    args: [crashServer],
    cwd: dir,
    onExit: (outcome) => { exitEvent = outcome; },
  });
  await crashClient.start();
  await assert.rejects(crashClient.callTool('query_documents', { query: 'boom' }), /exited unexpectedly/);
  assert.equal(exitEvent?.code, 42);
  assert.match(exitEvent?.stderr || '', /simulated crash/);
});

/* ============================================================================
 * 3. Discovery Tests (B > D > none)
 * ============================================================================ */

test('adapters/retrieval/discovery prefers B over D, falls back to D read-only, and validates requirements', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studyhub-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const desktopDir = join(root, 'desktop-tools', 'retrieval');
  const dshHome = join(root, 'dsh-home');
  const dshDesktopDir = join(dshHome, 'profiles', 'desktop', 'node_modules', '@ericwang1358', 'studyhub-retrieval');
  const dshWebDir = join(dshHome, 'profiles', 'web', 'node_modules', '@ericwang1358', 'studyhub-retrieval');

  const env = { DSH_HOME: dshHome, STUDYHUB_DESKTOP_RETRIEVAL_DIR: desktopDir };
  assert.equal(resolveDesktopRetrievalDir({ env }), desktopDir);

  // None installed
  assert.equal((await discoverRetrieval({ env })).selected, null);

  // Only D (web profile) installed, without local heal.js -> uses repo fallback heal.js
  await createRetrievalFixtureDir(dshWebDir, { version: '4.7.0', tag: 'dsh-web', includeHeal: false });
  let found = await discoverRetrieval({ env });
  assert.equal(found.selected?.source, 'dsh');
  assert.equal(found.selected?.profile, 'web');
  assert.ok(found.selected?.healPath?.endsWith('heal.js'));

  // D desktop profile beats D web profile
  await createRetrievalFixtureDir(dshDesktopDir, { version: '4.8.0', tag: 'dsh-desktop' });
  found = await discoverRetrieval({ env });
  assert.equal(found.selected?.source, 'dsh');
  assert.equal(found.selected?.profile, 'desktop');

  // Invalid B dir (missing mcp-local-rag) is skipped in favor of valid D
  await mkdir(desktopDir, { recursive: true });
  await writeFile(join(desktopDir, 'package.json'), JSON.stringify({ version: '4.15.1' }), 'utf8');
  await writeFile(join(desktopDir, 'server.mjs'), '// empty\n', 'utf8');
  const invalidCheck = await validateRetrievalDir(desktopDir, { source: 'desktop' });
  assert.equal(invalidCheck.valid, false);
  assert.equal(invalidCheck.reason, 'missing-mcp-local-rag');
  found = await discoverRetrieval({ env });
  assert.equal(found.selected?.source, 'dsh');

  // Valid B overrides D
  await createRetrievalFixtureDir(desktopDir, { version: '4.15.1', tag: 'desktop-b' });
  found = await discoverRetrieval({ env });
  assert.equal(found.selected?.source, 'desktop');
  assert.equal(found.selected?.version, '4.15.1');

  // Explicit dshHome override takes precedence over env.DSH_HOME
  const altDesktopDir = join(root, 'empty-desktop');
  const foundOverride = await discoverRetrieval({
    env: { DSH_HOME: join(root, 'unrelated-dsh'), STUDYHUB_DESKTOP_RETRIEVAL_DIR: altDesktopDir },
    dshHome,
  });
  assert.equal(foundOverride.selected?.source, 'dsh');
  assert.equal(foundOverride.selected?.profile, 'desktop');
});

/* ============================================================================
 * 4. ZIP64, Zip-Slip, SHA-256 & Atomic Installer Tests
 * ============================================================================ */

test('adapters/retrieval/zip-extract supports ZIP64 and blocks Zip-Slip & symlink attacks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studyhub-zip-extract-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // ZIP64 round-trip
  const zip64 = createZip64Buffer([
    { name: 'package.json', data: '{"version":"4.15.1"}' },
    { name: 'nested/hello.txt', data: 'hello zip64' },
  ]);
  const out64 = join(root, 'out64');
  const stats = await extractZipArchive(zip64, out64);
  assert.equal(stats.fileCount, 2);
  assert.equal(await readFile(join(out64, 'nested', 'hello.txt'), 'utf8'), 'hello zip64');

  // Zip-Slip rejection
  const evilZip = createZipBuffer([{ name: '../escaped.txt', data: Buffer.from('pwned') }]);
  await assert.rejects(
    extractZipArchive(evilZip, join(root, 'safe-target')),
    (err) => err?.code === 'extension-zip-unsafe'
  );
  assert.equal(await pathExists(join(root, 'escaped.txt')), false);

  // Symlink rejection
  const symZip = createSymlinkZipBuffer('link.txt', '/etc/passwd');
  await assert.rejects(
    extractZipArchive(symZip, join(root, 'sym-target')),
    (err) => err?.code === 'extension-zip-unsafe'
  );
});

test('adapters/retrieval/installer verifies SHA-256 before extraction, swaps atomically, and guards uninstall', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studyhub-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const dshHome = join(root, 'dsh');
  const targetDir = join(root, 'local', 'StudyHub', 'tools', 'retrieval');
  const version = '4.15.1';
  const assetName = retrievalAssetName(version);
  const sumsName = retrievalChecksumsName(version);

  const goodZip = createZipBuffer([
    { name: 'package.json', data: Buffer.from(JSON.stringify({ name: '@ericwang1358/studyhub-retrieval', version, type: 'module' })) },
    { name: 'server.mjs', data: Buffer.from(fakeMcpServerSource({ tag: 'installed-b' })) },
    { name: 'heal.js', data: Buffer.from('export async function healIndex() { return {}; }\n') },
    { name: 'node_modules/mcp-local-rag/package.json', data: Buffer.from('{"name":"mcp-local-rag","version":"0.20.0","main":"./index.js"}') },
    { name: 'node_modules/mcp-local-rag/index.js', data: Buffer.from('module.exports = {};\n') },
  ]);
  const goodSha = createHash('sha256').update(goodZip).digest('hex');

  const files = new Map([
    [`/v${version}/${sumsName}`, Buffer.from(`${goodSha}  ${assetName}\n`, 'utf8')],
    [`/v${version}/${assetName}`, goodZip],
  ]);

  const fakeFetch = async (url) => {
    const pathname = new URL(url).pathname;
    const body = files.get(pathname);
    if (!body) return new Response('not found', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  };

  // 1. Bad SHA-256 rejected BEFORE touching disk
  files.set(`/v${version}/${sumsName}`, Buffer.from(`${'0'.repeat(64)}  ${assetName}\n`, 'utf8'));
  const installer = createRetrievalInstaller({
    env: { DSH_HOME: dshHome },
    desktopDir: targetDir,
    dshHome,
    httpFetch: fakeFetch,
    downloadPrefix: 'http://127.0.0.1:9999/',
    attempts: 1,
  });
  await assert.rejects(installer.install({ version }), (err) => err?.code === 'extension-checksum');
  assert.equal(await pathExists(targetDir), false);

  // 2. Valid SHA-256 installs atomically
  files.set(`/v${version}/${sumsName}`, Buffer.from(`${goodSha}  ${assetName}\n`, 'utf8'));
  const installed = await installer.install({ version });
  assert.equal(installed.version, version);
  assert.equal(installed.sha256, goodSha);
  assert.equal(await pathExists(join(targetDir, 'server.mjs')), true);

  // 3. Failed upgrade bundle preserves existing B install intact
  const badZip = createZipBuffer([
    { name: 'package.json', data: Buffer.from(JSON.stringify({ name: '@ericwang1358/studyhub-retrieval', version: '4.16.0' })) },
    { name: 'server.mjs', data: Buffer.from('// missing mcp-local-rag\n') },
  ]);
  const badSha = createHash('sha256').update(badZip).digest('hex');
  files.set(`/v4.16.0/${retrievalChecksumsName('4.16.0')}`, Buffer.from(`${badSha}  ${retrievalAssetName('4.16.0')}\n`, 'utf8'));
  files.set(`/v4.16.0/${retrievalAssetName('4.16.0')}`, badZip);
  await assert.rejects(installer.install({ version: '4.16.0' }), (err) => err?.code === 'extension-install');
  const stillInstalled = JSON.parse(await readFile(join(targetDir, 'package.json'), 'utf8'));
  assert.equal(stillInstalled.version, version, 'existing B installation preserved on failed upgrade');

  // 4. Uninstall refuses non-managed path (e.g. DSH profile dir)
  const dshDir = join(dshHome, 'profiles', 'desktop', 'node_modules', '@ericwang1358', 'studyhub-retrieval');
  await createRetrievalFixtureDir(dshDir, { version: '4.7.0', tag: 'dsh-protected' });
  await assert.rejects(installer.uninstall({ targetPath: dshDir }), (err) => err?.code === 'extension-uninstall-refused');
  assert.equal(await pathExists(join(dshDir, 'server.mjs')), true);

  // 5. Uninstall removes managed B dir cleanly
  await installer.uninstall();
  assert.equal(await pathExists(targetDir), false);
});

/* ============================================================================
 * 5. Cross-Process Index Lock Tests
 * ============================================================================ */

test('adapters/retrieval/index-lock rejects cleanly when another process holds the lock and succeeds after release', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studyhub-index-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const retrievalDir = join(root, 'retrieval');
  await mkdir(retrievalDir, { recursive: true });
  const indexLock = createIndexLock({
    retrievalDir,
    retries: { retries: 1, minTimeout: 20, maxTimeout: 40 },
  });

  // Spawn a real second Node process holding the same proper-lockfile lock
  const runner = createProcessRunner();
  const lockfileModuleUrl = pathToFileURL(createRequire(import.meta.url).resolve('proper-lockfile')).href;
  const holderScript = `
    const mod = await import(${JSON.stringify(lockfileModuleUrl)});
    const lockfile = mod.default || mod;
    const [dir, lockPath] = process.argv.slice(2);
    const release = await lockfile.lock(dir, { lockfilePath: lockPath, realpath: false, stale: 30000 });
    process.stdout.write('LOCKED\\n');
    process.stdin.resume();
    process.stdin.once('end', async () => {
      await release();
      process.exit(0);
    });
  `;
  const holderFile = join(root, 'holder.mjs');
  await writeFile(holderFile, holderScript, 'utf8');
  const holder = runner.spawnPersistent({
    command: process.execPath,
    args: [holderFile, retrievalDir, indexLock.lockfilePath],
    cwd: process.cwd(),
  });
  t.after(() => holder.terminate());

  await new Promise((resolveReady, rejectReady) => {
    let stderr = '';
    holder.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    holder.stdout.on('data', (chunk) => {
      if (chunk.toString('utf8').includes('LOCKED')) resolveReady();
    });
    holder.exited.then((res) => rejectReady(new Error(`holder exited early: ${JSON.stringify(res)} stderr=${stderr}`)));
  });

  await assert.rejects(
    indexLock.withLock(async () => 'should-not-run'),
    (err) => err?.code === 'retrieval-index-locked'
  );

  // Release from second process
  holder.stdin.end();
  await holder.exited;

  const value = await indexLock.withLock(async () => 'acquired-after-release');
  assert.equal(value, 'acquired-after-release');
});

test('application/retrieval-runtime wraps write tools with index lock and surfaces companion.notStarted on start failure without respawn loop', async () => {
  let startCalls = 0;
  let lockCalls = 0;
  let failStart = true;

  const runtime = createRetrievalRuntime({
    canInstallPlatform: true,
    discover: async () => ({
      selected: { valid: true, source: 'desktop', dir: '/fake/b', version: '4.15.1', serverPath: '/fake/b/server.mjs', ragEntry: '/fake/b/rag.js' },
    }),
    readSettings: async () => ({ provider: 'builtin' }),
    ensureRetrievalDirs: async () => {},
    runHeal: async () => ({}),
    withIndexLock: async (work) => {
      lockCalls += 1;
      return work();
    },
    startClient: async () => {
      startCalls += 1;
      if (failStart) throw new Error('broken index');
      return {
        isRunning: () => true,
        listTools: () => [
          { name: 'query_documents', description: 'q', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
          { name: 'ingest_data', description: 'i', inputSchema: { type: 'object', properties: {} } },
          { name: 'delete_file', description: 'd', inputSchema: { type: 'object', properties: {} } },
        ],
        callTool: async (name, args) => ({ content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] }),
        close: async () => {},
      };
    },
    getCurrentVersion: () => '4.15.1',
    getSinceVersion: () => '4.6.2',
  });

  // First boot fails -> companion.notStarted = true; second poll does NOT respawn
  await runtime.ensureReady({ allowStart: true });
  await runtime.ensureReady({ allowStart: true });
  assert.equal(startCalls, 1, 'failed boot is not endlessly respawned on polling');
  const failedStatus = runtime.enrichStatus({ companion: { id: RETRIEVAL_COMPANION_PROVIDER_ID, running: false } });
  assert.equal(failedStatus.companion.notStarted, true);
  assert.equal(failedStatus.extension.error, 'retrieval-start-failed');

  // After repair clears failure and starts cleanly
  failStart = false;
  await runtime.beforeRepair();
  await runtime.afterRepair();
  assert.equal(startCalls, 2);
  assert.equal(runtime.isRunning(), true);

  const tools = runtime.asDshToolsService();
  await tools.execute({ callId: 'q1', name: 'mcp__studyhub__query_documents', arguments: { query: 'x' } });
  assert.equal(lockCalls, 0, 'read-only query does not take write lock');
  await tools.execute({ callId: 'i1', name: 'mcp__studyhub__ingest_data', arguments: { content: 'c', metadata: { source: 's' } } });
  await tools.execute({ callId: 'd1', name: 'mcp__studyhub__delete_file', arguments: { source: 's' } });
  assert.equal(lockCalls, 2, 'ingest_data and delete_file take cross-process index lock');

  await runtime.dispose();
});

/* ============================================================================
 * 6. Full Desktop Host End-to-End Retrieval Lifecycle Tests
 * ============================================================================ */

test('desktop-host integrates B+D hybrid retrieval: lazy boot, D-reuse, B install, endpoint hot-restart, repair, and uninstall', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studyhub-desktop-retrieval-e2e-'));
  const priorDshHome = process.env.DSH_HOME;
  t.after(async () => {
    if (priorDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = priorDshHome;
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const dshHome = join(root, 'dsh-home');
  const libraryDir = join(root, 'library');
  const desktopRetrievalDir = join(root, 'desktop-tools', 'retrieval');
  const dshRetrievalDir = join(dshHome, 'profiles', 'desktop', 'node_modules', '@ericwang1358', 'studyhub-retrieval');

  // Seed DSH-leftover retrieval.json pointing at companion tool BEFORE anything is installed
  const settingsPath = join(dshHome, 'study', 'retrieval.json');
  await mkdir(join(dshHome, 'study'), { recursive: true });
  const initialSettingsText = `${JSON.stringify({ provider: RETRIEVAL_COMPANION_PROVIDER_ID, explicit: true }, null, 2)}\n`;
  await writeFile(settingsPath, initialSettingsText, 'utf8');

  // Serve standalone B release asset over loopback HTTP
  const version = currentVersion();
  const assetName = retrievalAssetName(version);
  const sumsName = retrievalChecksumsName(version);
  const bZip = createZipBuffer([
    { name: 'package.json', data: Buffer.from(JSON.stringify({ name: '@ericwang1358/studyhub-retrieval', version, type: 'module' })) },
    { name: 'server.mjs', data: Buffer.from(fakeMcpServerSource({ tag: 'standalone-b' })) },
    { name: 'heal.js', data: Buffer.from('export async function healIndex() { return {}; }\n') },
    { name: 'node_modules/mcp-local-rag/package.json', data: Buffer.from('{"name":"mcp-local-rag","version":"0.20.0","main":"./index.js"}') },
    { name: 'node_modules/mcp-local-rag/index.js', data: Buffer.from('module.exports = {};\n') },
  ]);
  const bSha = createHash('sha256').update(bZip).digest('hex');

  const releaseServer = http.createServer((req, res) => {
    if (req.url === `/v${version}/${sumsName}`) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${bSha}  ${assetName}\n`);
      return;
    }
    if (req.url === `/v${version}/${assetName}`) {
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': String(bZip.length) });
      res.end(bZip);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolveListen) => releaseServer.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise((done) => releaseServer.close(done)));
  const releasePort = releaseServer.address().port;

  const env = {
    ...process.env,
    DSH_HOME: dshHome,
    STUDYHUB_LIBRARY: libraryDir,
    STUDYHUB_DESKTOP_RETRIEVAL_DIR: desktopRetrievalDir,
  };
  const configStore = createConfigStore({ env, home: root, documentsDir: join(root, 'Documents') });
  const runner = createProcessRunner();
  const jobExecutor = createInProcessJobExecutor();
  const retrievalPorts = createRetrievalRuntimePorts({
    env,
    dshHome,
    runner,
    downloadPrefix: `http://127.0.0.1:${releasePort}/`,
    canInstallPlatform: true,
  });
  const retrievalRuntime = createRetrievalRuntime(retrievalPorts);

  const host = await createDesktopHost({
    configStore,
    providerDiscovery: { scan: async () => [], getCached: () => [], findReadyAgyPath: () => '', findReadyCodexPath: () => '' },
    openaiComplete: () => async () => '',
    agyComplete: () => async () => '',
    jobExecutor,
    openExternal: async () => {},
    ensureDir: (dirPath) => mkdir(dirPath, { recursive: true }),
    retrievalRuntime,
  });
  t.after(() => host.dispose());

  // 1. Cold boot does NOT spawn retrieval child
  assert.equal(retrievalRuntime.isRunning(), false);

  // 2. Uninstalled status suppresses DSH-leftover `missing` WITHOUT clobbering retrieval.json
  const statusNone = await host.call('retrieval.status', {});
  assert.equal(statusNone.ok, true);
  assert.equal(statusNone.value.extension.installed, false);
  assert.equal(statusNone.value.extension.source, 'none');
  assert.equal(statusNone.value.extension.desktopHost, true);
  assert.equal(statusNone.value.missing, undefined);
  assert.equal(statusNone.value.selected, 'builtin');
  assert.equal(await readFile(settingsPath, 'utf8'), initialSettingsText, 'retrieval.json was NOT clobbered');

  // 3. D-reuse: place a read-only DSH retrieval installation -> first retrieval.status lazy-starts it
  await createRetrievalFixtureDir(dshRetrievalDir, { version: '4.7.0', tag: 'dsh-reuse' });
  const statusD = await host.call('retrieval.status', {});
  assert.equal(statusD.ok, true);
  assert.equal(statusD.value.companion.running, true);
  assert.equal(statusD.value.extension.source, 'dsh');
  assert.equal(statusD.value.extension.canUninstall, false);
  assert.equal(statusD.value.extension.canInstallStandalone, true);
  assert.ok(statusD.value.providers.some((p) => p.id === RETRIEVAL_COMPANION_PROVIDER_ID));

  // Uninstalling while on D is refused and DSH directory stays untouched
  const refuseD = await host.call('retrieval.extension.uninstall', { uiLanguage: 'en' });
  assert.equal(refuseD.ok, false);
  assert.equal(refuseD.code, 'extension-uninstall-refused');
  assert.equal(await pathExists(join(dshRetrievalDir, 'server.mjs')), true);

  // 4. Standalone B install overrides D and hot-starts without restart
  const installRes = await host.call('retrieval.extension.install', {});
  assert.equal(installRes.ok, true);
  assert.deepEqual(installRes.value, {
    status: 'installed',
    restartRequired: false,
    application: 'applied',
    version,
    source: 'desktop',
  });
  const statusB = await host.call('retrieval.status', {});
  assert.equal(statusB.ok, true);
  assert.equal(statusB.value.companion.running, true);
  assert.equal(statusB.value.extension.source, 'desktop');
  assert.equal(statusB.value.extension.canUninstall, true);
  assert.equal(statusB.value.extension.canInstallStandalone, false);

  // Verify tool execution hits standalone-b server
  const toolsSvc = retrievalRuntime.asDshToolsService();
  const call1 = await toolsSvc.execute({
    callId: 'c1',
    name: 'mcp__studyhub__query_documents',
    arguments: { query: 'test' },
  });
  assert.equal(call1.isError, false);
  assert.equal(call1.structuredContent.tag, 'standalone-b');
  const pidBeforeEndpoint = call1.structuredContent.pid;

  // 4.5. retrieval.set preserves extension payload (never drops extension for ExtensionPanel)
  const setBuiltin = await host.call('retrieval.set', { provider: 'builtin' });
  assert.equal(setBuiltin.ok, true);
  assert.equal(setBuiltin.value.selected, 'builtin');
  assert.equal(setBuiltin.value.extension?.desktopHost, true);
  assert.equal(setBuiltin.value.extension?.source, 'desktop');
  const setCompanion = await host.call('retrieval.set', { provider: RETRIEVAL_COMPANION_PROVIDER_ID });
  assert.equal(setCompanion.ok, true);
  assert.equal(setCompanion.value.selected, RETRIEVAL_COMPANION_PROVIDER_ID);
  assert.equal(setCompanion.value.extension?.desktopHost, true);
  assert.equal(setCompanion.value.extension?.source, 'desktop');

  // 5. retrieval.endpoint.set hot-restarts server with new HF_ENDPOINT immediately
  const epRes = await host.call('retrieval.endpoint.set', { endpoint: 'https://hf-mirror.com' });
  assert.equal(epRes.ok, true);
  assert.equal(epRes.value.hfEndpoint, 'https://hf-mirror.com');
  assert.equal(epRes.value.companion.running, true);
  const call2 = await toolsSvc.execute({
    callId: 'c2',
    name: 'mcp__studyhub__query_documents',
    arguments: { query: 'after-endpoint' },
  });
  assert.equal(call2.structuredContent.hfEndpoint, 'https://hf-mirror.com');
  assert.notEqual(call2.structuredContent.pid, pidBeforeEndpoint, 'server hot-restarted on endpoint change');

  // 6. retrieval.index.repair stops child, moves chunks.lance aside, and restarts child immediately
  const lanceTable = join(dshHome, 'study', 'retrieval', 'lancedb', 'chunks.lance');
  await mkdir(lanceTable, { recursive: true });
  await writeFile(join(lanceTable, 'marker.bin'), 'broken', 'utf8');
  const repairRes = await host.call('retrieval.index.repair', {});
  assert.equal(repairRes.ok, true);
  assert.equal(repairRes.value.restarted, true);
  assert.equal(repairRes.value.running, true);
  assert.equal(await pathExists(lanceTable), false, 'chunks.lance moved aside');
  const lanceEntries = await readdir(join(dshHome, 'study', 'retrieval', 'lancedb'));
  assert.ok(lanceEntries.some((name) => name.startsWith('chunks.lance.broken-')));

  // 7. Uninstall removes ONLY B dir; DSH dir and index folder stay intact
  const uninstallRes = await host.call('retrieval.extension.uninstall', {});
  assert.equal(uninstallRes.ok, true);
  assert.deepEqual(uninstallRes.value, { status: 'removed', application: 'applied' });
  assert.equal(await pathExists(desktopRetrievalDir), false);
  assert.equal(await pathExists(join(dshRetrievalDir, 'server.mjs')), true);
  assert.equal(await pathExists(join(dshHome, 'study', 'retrieval', 'reset.json')), true);

  // 8. Dispose cleans up child process
  await host.dispose();
  assert.equal(retrievalRuntime.isRunning(), false);
});

test('application/retrieval-runtime keeps running server alive on failed install download and recovers on swap rollback', async () => {
  let closeCalls = 0;
  let startCalls = 0;
  let mode = 'fail-download';

  const runtime = createRetrievalRuntime({
    canInstallPlatform: true,
    discover: async () => ({
      selected: { valid: true, source: 'dsh', dir: '/fake/d', version: '4.7.0', serverPath: '/fake/d/server.mjs', ragEntry: '/fake/d/rag.js' },
    }),
    readSettings: async () => ({ provider: 'builtin' }),
    ensureRetrievalDirs: async () => {},
    runHeal: async () => ({}),
    startClient: async () => {
      startCalls += 1;
      let alive = true;
      return {
        isRunning: () => alive,
        listTools: () => [{ name: 'query_documents', description: 'q', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
        callTool: async () => ({ content: [] }),
        close: async () => { alive = false; closeCalls += 1; },
      };
    },
    installer: {
      async install({ beforeSwap }) {
        if (mode === 'fail-download') {
          throw Object.assign(new Error('checksum mismatch'), { code: 'extension-checksum' });
        }
        await beforeSwap();
        throw Object.assign(new Error('swap EBUSY'), { code: 'extension-install' });
      },
      async uninstall() { return { removed: true }; },
    },
    getCurrentVersion: () => '4.15.1',
    getSinceVersion: () => '4.6.2',
  });

  await runtime.ensureReady({ allowStart: true });
  assert.equal(runtime.isRunning(), true);
  assert.equal(startCalls, 1);

  // Download/checksum failure never stops the active server
  await assert.rejects(runtime.install(), (err) => err?.code === 'extension-checksum');
  assert.equal(closeCalls, 0, 'active server stayed running during failed download');
  assert.equal(runtime.isRunning(), true);

  // Swap failure after beforeSwap restarts the rolled-back server automatically
  mode = 'fail-swap';
  await assert.rejects(runtime.install(), (err) => err?.code === 'extension-install');
  assert.equal(closeCalls, 1, 'server stopped right before swap');
  assert.equal(startCalls, 2, 'server restarted after swap rollback');
  assert.equal(runtime.isRunning(), true);

  await runtime.dispose();
});

test('application/retrieval-actions triggers configured lazy-start for all generation actions', async () => {
  const configuredCalls = [];
  const eagerCalls = [];
  const stub = {
    ensureReady: async () => { eagerCalls.push(1); },
    ensureReadyIfConfigured: async () => { configuredCalls.push(1); },
  };
  for (const action of ['generate', 'generate.preview', 'deck.generate', 'supplement', 'case.drills', 'course.custom.fill', 'course.custom.apply', 'generation.companion.build']) {
    await prepareRetrievalForAction(stub, action);
  }
  assert.equal(configuredCalls.length, 8);
  await prepareRetrievalForAction(stub, 'retrieval.index.plan');
  assert.equal(eagerCalls.length, 1);
  await prepareRetrievalForAction(stub, 'snapshot');
  assert.equal(configuredCalls.length, 8, 'cold snapshot does not trigger retrieval');
});

test('application/retrieval-runtime exposes errorDetail, rejects mismatched concurrent install/uninstall, and supports retrieval.extension.restart', async () => {
  let startCount = 0;
  let releaseInstall;
  const installGate = new Promise((done) => { releaseInstall = done; });

  const runtime = createRetrievalRuntime({
    canInstallPlatform: true,
    discover: async () => ({
      selected: { valid: true, source: 'desktop', dir: '/fake/b', version: '4.15.1', serverPath: '/fake/b/server.mjs', ragEntry: '/fake/b/rag.js' },
    }),
    readSettings: async () => ({ provider: 'builtin' }),
    ensureRetrievalDirs: async () => {},
    runHeal: async () => ({}),
    startClient: async () => {
      startCount += 1;
      if (startCount === 1) throw new Error('boom: native module load failed');
      let alive = true;
      return {
        isRunning: () => alive,
        listTools: () => [{ name: 'query_documents', description: 'q', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
        callTool: async () => ({ content: [] }),
        close: async () => { alive = false; },
      };
    },
    installer: {
      async install() {
        await installGate;
        return { version: '4.15.1', dir: '/fake/b', sha256: 'a'.repeat(64), bytes: 10 };
      },
      async uninstall() { return { removed: true }; },
    },
    getCurrentVersion: () => '4.15.1',
    getSinceVersion: () => '4.6.2',
  });

  // First start fails -> enrichStatus includes errorDetail for Copy Diagnostics
  const first = await runtime.ensureReady({ allowStart: true });
  assert.equal(first.running, false);
  const failedStatus = runtime.enrichStatus({ companion: { id: RETRIEVAL_COMPANION_PROVIDER_ID, running: false } });
  assert.equal(failedStatus.companion.notStarted, true);
  assert.equal(failedStatus.extension.error, 'retrieval-start-failed');
  assert.match(failedStatus.extension.errorDetail, /native module load failed/);

  // Explicit restart recovers without resetting index and clears errorDetail
  const handlers = (await import('../packages/studyhub-desktop/application/retrieval-actions.js')).createRetrievalActionHandlers({
    retrievalRuntime: runtime,
    forward: async () => ({ ok: true, value: { companion: { id: RETRIEVAL_COMPANION_PROVIDER_ID, running: runtime.isRunning() } } }),
  });
  const restarted = await handlers['retrieval.extension.restart']({});
  assert.equal(restarted.companion.running, true);
  assert.equal(restarted.extension.error, undefined);
  assert.equal(restarted.extension.errorDetail, undefined);

  // Concurrent mismatched install vs uninstall rejects with extension-busy instead of returning install's promise
  const installPending = runtime.install();
  const installCoalesced = runtime.install();
  assert.equal(installPending, installCoalesced);
  await assert.rejects(runtime.uninstall(), (err) => err?.code === 'extension-busy');
  releaseInstall();
  await installPending;
  await runtime.dispose();
});

/* ============================================================================
 * 7. Wave 3 MCP Protocol (Cancellation, Negotiation, Backpressure, Graceful Close)
 * ============================================================================ */

function createFakePersistentProc({ onWrite, autoExitOnStdinEnd = true } = {}) {
  const stdout = new EventEmitter();
  stdout.pause = () => {};
  stdout.resume = () => {};
  const stderr = new EventEmitter();
  // Mirror a live child process keeping the event loop referenced until it exits.
  const keepalive = setInterval(() => {}, 10_000);
  let resolveExited;
  const exited = new Promise((done) => {
    resolveExited = (outcome) => {
      clearInterval(keepalive);
      done(outcome);
    };
  });
  let terminated = false;
  let stdinEnded = false;

  const stdin = new EventEmitter();
  stdin.destroyed = false;
  stdin.writable = true;
  stdin.writableLength = 0;
  stdin.write = (data) => (typeof onWrite === 'function' ? onWrite(data, { stdout, stdin, resolveExited }) : true);
  stdin.end = () => {
    stdinEnded = true;
    stdin.writable = false;
    if (autoExitOnStdinEnd) resolveExited({ code: 0, signal: null, error: null });
  };

  return {
    proc: {
      pid: 99999,
      stdin,
      stdout,
      stderr,
      exited,
      terminate: async () => {
        terminated = true;
        resolveExited({ code: null, signal: 'SIGTERM', error: null });
        return exited;
      },
    },
    emitStdout: (chunk) => stdout.emit('data', chunk),
    wasTerminated: () => terminated,
    wasStdinEnded: () => stdinEnded,
    exitNow: (outcome) => resolveExited(outcome),
  };
}

test('adapters/retrieval/mcp-stdio-client propagates notifications/cancelled, negotiates protocol versions, answers ping, and handles pagination', async () => {
  const received = [];
  const sentPings = [];
  let fake;
  const client = createMcpStdioClient({
    command: 'fake',
    closeGraceMs: 100,
    spawnPersistent: () => {
      fake = createFakePersistentProc({
        onWrite: (line, { stdout }) => {
          const msg = JSON.parse(String(line));
          received.push(msg);
          if (msg.method === 'initialize') {
            stdout.emit('data', Buffer.from(`${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } },
            })}\n`));
          } else if (msg.method === 'tools/list') {
            if (!msg.params?.cursor) {
              stdout.emit('data', Buffer.from(`${JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: { tools: [{ name: 'query_documents', description: 'p1', inputSchema: {} }], nextCursor: 'page-2' },
              })}\n`));
            } else {
              // Also test server-initiated ping + unsupported server request + UTF-8 chunk split
              stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' })}\n`));
              stdout.emit('data', Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 'srv-unknown', method: 'sampling/createMessage' })}\n`));
              const page2 = Buffer.from(`${JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: { tools: [{ name: 'ingest_data', description: '中文工具描述', inputSchema: {} }] },
              })}\n`, 'utf8');
              const splitAt = page2.indexOf(Buffer.from('中文', 'utf8')) + 1;
              stdout.emit('data', page2.subarray(0, splitAt));
              stdout.emit('data', page2.subarray(splitAt));
            }
          } else if (msg.id === 'srv-ping' || msg.id === 'srv-unknown') {
            sentPings.push(msg);
          }
          return true;
        },
      });
      return fake.proc;
    },
  });

  const tools = await client.start();
  assert.equal(client.getProtocolVersion(), '2025-03-26');
  assert.deepEqual(tools.map((t) => t.name), ['query_documents', 'ingest_data']);
  assert.equal(tools[1].description, '中文工具描述', 'multi-byte UTF-8 split across chunks decoded cleanly');
  assert.deepEqual(sentPings.find((m) => m.id === 'srv-ping')?.result, {});
  assert.equal(sentPings.find((m) => m.id === 'srv-unknown')?.error?.code, -32601);

  // 1. AbortSignal cancellation emits notifications/cancelled with matching requestId & reason
  const ac = new AbortController();
  const abortedCall = client.callTool('query_documents', { query: 'cancel-me' }, { signal: ac.signal });
  const abortReq = received.find((m) => m.method === 'tools/call' && m.params?.arguments?.query === 'cancel-me');
  assert.ok(abortReq?.id);
  ac.abort(new Error('user-stopped'));
  await assert.rejects(abortedCall, /user-stopped/);
  const cancelNote1 = received.find((m) => m.method === 'notifications/cancelled' && m.params?.requestId === abortReq.id);
  assert.equal(cancelNote1?.params?.reason, 'user-stopped');

  // 2. Timeout cancellation emits notifications/cancelled
  const timedCall = client.callTool('query_documents', { query: 'timeout-me' }, { timeoutMs: 25 });
  const timeoutReq = received.find((m) => m.method === 'tools/call' && m.params?.arguments?.query === 'timeout-me');
  await assert.rejects(timedCall, (err) => err?.code === 'retrieval-call-timeout');
  const cancelNote2 = received.find((m) => m.method === 'notifications/cancelled' && m.params?.requestId === timeoutReq.id);
  assert.match(cancelNote2?.params?.reason || '', /timed out/);

  // 3. Cooperative close() cancels remaining in-flight call and exits on stdin EOF without forced terminate()
  const inflight = client.callTool('query_documents', { query: 'closing-me' }, { timeoutMs: 5000 });
  const closingReq = received.find((m) => m.method === 'tools/call' && m.params?.arguments?.query === 'closing-me');
  const closePromise = client.close();
  await assert.rejects(inflight, (err) => err?.code === 'retrieval-closed');
  await closePromise;
  assert.ok(received.some((m) => m.method === 'notifications/cancelled' && m.params?.requestId === closingReq.id));
  assert.equal(fake.wasStdinEnded(), true);
  assert.equal(fake.wasTerminated(), false, 'cooperative child exited cleanly via stdin EOF without SIGTERM/kill');
});

test('adapters/retrieval/mcp-stdio-client rejects unsupported protocolVersion, never cancels initialize, enforces backpressure/line cap, and escalates hung close', async () => {
  // 1. Unsupported protocolVersion rejected cleanly
  let badProc;
  const badProtoClient = createMcpStdioClient({
    command: 'fake',
    spawnPersistent: () => {
      badProc = createFakePersistentProc({
        onWrite: (line, { stdout }) => {
          const msg = JSON.parse(String(line));
          if (msg.method === 'initialize') {
            stdout.emit('data', Buffer.from(`${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: '2020-01-01', capabilities: {} },
            })}\n`));
          }
          return true;
        },
      });
      return badProc.proc;
    },
  });
  await assert.rejects(badProtoClient.start(), (err) => err?.code === 'retrieval-protocol-unsupported');
  assert.equal(badProtoClient.isRunning(), false);

  // 2. initialize timeout must NOT emit notifications/cancelled (MCP spec)
  const initReceived = [];
  const initTimeoutClient = createMcpStdioClient({
    command: 'fake',
    initTimeoutMs: 30,
    closeGraceMs: 20,
    spawnPersistent: () => createFakePersistentProc({
      autoExitOnStdinEnd: false,
      onWrite: (line) => {
        initReceived.push(JSON.parse(String(line)));
        return true;
      },
    }).proc,
  });
  await assert.rejects(initTimeoutClient.start(), (err) => err?.code === 'retrieval-call-timeout');
  assert.equal(initReceived.some((m) => m.method === 'notifications/cancelled'), false);

  // 3. Stdin write backpressure queueing + drain + overflow rejection + hung close escalation
  const writtenLines = [];
  let allowImmediate = true;
  let bpFake;
  const bpClient = createMcpStdioClient({
    command: 'fake',
    closeGraceMs: 25,
    maxWriteBufferBytes: 256,
    spawnPersistent: () => {
      bpFake = createFakePersistentProc({
        autoExitOnStdinEnd: false,
        onWrite: (line, { stdout }) => {
          const msg = JSON.parse(String(line));
          writtenLines.push(msg);
          if (msg.method === 'initialize') {
            stdout.emit('data', Buffer.from(`${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: '2024-11-05', capabilities: {} },
            })}\n`));
            return true;
          }
          if (msg.method === 'tools/list') {
            stdout.emit('data', Buffer.from(`${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { tools: [{ name: 'query_documents', description: '', inputSchema: {} }] },
            })}\n`));
            return true;
          }
          if (msg.method === 'tools/call') {
            stdout.emit('data', Buffer.from(`${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { content: [{ type: 'text', text: msg.params.arguments.query }] },
            })}\n`));
          }
          return allowImmediate;
        },
      });
      return bpFake.proc;
    },
  });
  await bpClient.start();
  assert.equal(bpClient.getProtocolVersion(), '2024-11-05');

  allowImmediate = false;
  const first = bpClient.callTool('query_documents', { query: 'first' });
  const second = bpClient.callTool('query_documents', { query: 'second' });
  // Second call is queued until drain
  assert.equal(writtenLines.some((m) => m.params?.arguments?.query === 'second'), false);
  // Oversized write while queued exceeds maxWriteBufferBytes -> retrieval-backpressure
  await assert.rejects(
    bpClient.callTool('query_documents', { query: 'x'.repeat(300) }),
    (err) => err?.code === 'retrieval-backpressure'
  );
  allowImmediate = true;
  bpFake.proc.stdin.emit('drain');
  assert.equal((await first).content[0].text, 'first');
  assert.equal((await second).content[0].text, 'second');

  // Unresponsive child escalates to terminate() after closeGraceMs
  await bpClient.close();
  assert.equal(bpFake.wasStdinEnded(), true);
  assert.equal(bpFake.wasTerminated(), true);

  // 4. Oversized stdout line triggers retrieval-protocol-error without OOM
  let overflowFake;
  const overflowClient = createMcpStdioClient({
    command: 'fake',
    maxLineBytes: 128,
    closeGraceMs: 20,
    spawnPersistent: () => {
      overflowFake = createFakePersistentProc({
        onWrite: (line, { stdout }) => {
          const msg = JSON.parse(String(line));
          if (msg.method === 'initialize') {
            stdout.emit('data', Buffer.from(`${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { protocolVersion: '2024-11-05', capabilities: {} },
            })}\n`));
          } else if (msg.method === 'tools/list') {
            stdout.emit('data', Buffer.from(`${JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { tools: [{ name: 'query_documents', description: '', inputSchema: {} }] },
            })}\n`));
          }
          return true;
        },
      });
      return overflowFake.proc;
    },
  });
  await overflowClient.start();
  const pendingOverflow = overflowClient.callTool('query_documents', { query: 'overflow' });
  overflowFake.emitStdout(Buffer.from('A'.repeat(256), 'utf8'));
  await assert.rejects(pendingOverflow, (err) => err?.code === 'retrieval-protocol-error');
  assert.equal(overflowClient.isRunning(), false);
});

/* ============================================================================
 * 8. Wave 3 Streaming zip-extract & installer Boundary Coverage
 * ============================================================================ */

function createCustomZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const method = entry.method ?? 8;
    const payload = entry.rawCompressed ?? (method === 8 ? deflateRawSync(raw) : raw);
    const crc = entry.crc !== undefined ? (entry.crc >>> 0) : (zlibCrc32(raw) >>> 0);
    const uncompressedSize = entry.uncompressedSize ?? raw.length;
    const compressedSize = entry.compressedSize ?? payload.length;
    const versionMadeBy = entry.versionMadeBy ?? 20;
    const externalAttrs = entry.externalAttrs ?? 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(Buffer.concat([local, nameBuf, payload]));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(versionMadeBy, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(externalAttrs >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(Buffer.concat([central, nameBuf]));

    offset += local.length + nameBuf.length + payload.length;
  }

  const centralBlock = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralBlock, eocd]);
}

test('adapters/retrieval/zip-extract handles streaming file-path ZIP64, stored/deflated empty files, Unix +x restoration, symlinks, Zip-Slip, and corrupt cleanup', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studyhub-zip-boundaries-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // 1. Unix mode extraction policy (+x preserved, owner rw guaranteed, non-Unix ignored)
  assert.equal(unixModeOfZipEntry({ versionMadeBy: (3 << 8) | 20, externalAttrs: (0o100755 << 16) >>> 0 }), 0o755);
  assert.equal(unixModeOfZipEntry({ versionMadeBy: (3 << 8) | 20, externalAttrs: (0o100555 << 16) >>> 0 }), 0o755);
  assert.equal(unixModeOfZipEntry({ versionMadeBy: (3 << 8) | 20, externalAttrs: (0o100444 << 16) >>> 0 }), 0o644);
  assert.equal(unixModeOfZipEntry({ versionMadeBy: 20, externalAttrs: 0 }), null);

  // 2. Streaming from disk file path: stored & deflated empty files, nested dir, and Unix +x chmod on linux vs skipped on win32
  const mixedZip = createCustomZipBuffer([
    { name: 'bin/', data: '', method: 0 },
    { name: 'bin/run.sh', data: '#!/bin/sh\necho hi\n', method: 8, versionMadeBy: (3 << 8) | 20, externalAttrs: (0o100755 << 16) >>> 0 },
    { name: 'empty-stored.txt', data: '', method: 0 },
    { name: 'empty-deflated.txt', data: '', method: 8 },
    { name: 'plain.txt', data: 'stored-ok', method: 0 },
  ]);
  const mixedPath = join(root, 'mixed.zip');
  await writeFile(mixedPath, mixedZip);

  const linuxChmods = [];
  const linuxOut = join(root, 'linux-out');
  const linuxRes = await extractZipArchive(mixedPath, linuxOut, {
    platform: 'linux',
    chmodFile: async (filePath, mode) => { linuxChmods.push({ filePath, mode }); },
  });
  assert.equal(linuxRes.fileCount, 4);
  assert.equal(await readFile(join(linuxOut, 'empty-stored.txt'), 'utf8'), '');
  assert.equal(await readFile(join(linuxOut, 'empty-deflated.txt'), 'utf8'), '');
  assert.equal(await readFile(join(linuxOut, 'plain.txt'), 'utf8'), 'stored-ok');
  assert.deepEqual(linuxChmods, [{ filePath: join(linuxOut, 'bin', 'run.sh'), mode: 0o755 }]);

  const winChmods = [];
  await extractZipArchive(mixedPath, join(root, 'win-out'), {
    platform: 'win32',
    chmodFile: async (filePath, mode) => { winChmods.push({ filePath, mode }); },
  });
  assert.deepEqual(winChmods, [], 'chmod is skipped on win32');

  // 3. ZIP64 streamed from file path
  const zip64Path = join(root, 'stream64.zip');
  await writeFile(zip64Path, createZip64Buffer([
    { name: 'empty64.txt', data: '' },
    { name: 'sub/data.txt', data: 'zip64-from-disk' },
  ]));
  const out64 = join(root, 'out64');
  const res64 = await extractZipArchive(zip64Path, out64);
  assert.equal(res64.fileCount, 2);
  assert.equal(await readFile(join(out64, 'empty64.txt'), 'utf8'), '');
  assert.equal(await readFile(join(out64, 'sub', 'data.txt'), 'utf8'), 'zip64-from-disk');

  // 4. Symlink directory and file entries blocked when streaming from disk
  const symDirZip = createCustomZipBuffer([
    { name: 'evil-link/', data: '/etc', method: 0, versionMadeBy: (3 << 8) | 20, externalAttrs: (0o120777 << 16) >>> 0 },
  ]);
  const symDirPath = join(root, 'sym-dir.zip');
  await writeFile(symDirPath, symDirZip);
  await assert.rejects(extractZipArchive(symDirPath, join(root, 'sym-dir-out')), (err) => err?.code === 'extension-zip-unsafe');

  // 5. Zip-Slip variants blocked from file path with zero escape writes
  for (const unsafeName of ['..\\escaped.txt', 'a/../../escaped.txt', '/etc/passwd', 'C:/Windows/evil.txt', 'bad\0name']) {
    const slipPath = join(root, `slip-${Math.random().toString(16).slice(2)}.zip`);
    await writeFile(slipPath, createCustomZipBuffer([{ name: unsafeName, data: 'nope', method: 0 }]));
    await assert.rejects(extractZipArchive(slipPath, join(root, 'slip-out')), (err) => err?.code === 'extension-zip-unsafe');
  }
  assert.equal(await pathExists(join(root, 'escaped.txt')), false);

  // 6. Zip-bomb (maxExtractedBytes), CRC32 mismatch, and 0-compressed-size corrupt entry fail cleanly and remove partial files
  const bombZip = createCustomZipBuffer([{ name: 'bomb.bin', data: Buffer.alloc(4096, 0x41), method: 8 }]);
  const bombOut = join(root, 'bomb-out');
  await assert.rejects(extractZipArchive(bombZip, bombOut, { maxExtractedBytes: 512 }), (err) => err?.code === 'extension-extract');
  assert.equal(await pathExists(join(bombOut, 'bomb.bin')), false, 'partial bomb output cleaned up');

  const badCrcZip = createCustomZipBuffer([{ name: 'badcrc.txt', data: 'hello', method: 8, crc: 0xdeadbeef }]);
  const badCrcOut = join(root, 'badcrc-out');
  await assert.rejects(extractZipArchive(badCrcZip, badCrcOut), (err) => err?.code === 'extension-extract');
  assert.equal(await pathExists(join(badCrcOut, 'badcrc.txt')), false, 'corrupt CRC file removed');

  const zeroCompCorrupt = createCustomZipBuffer([
    { name: 'trunc.txt', data: '', method: 0, rawCompressed: Buffer.alloc(0), compressedSize: 0, uncompressedSize: 10 },
  ]);
  const zeroCompPath = join(root, 'zero-comp.zip');
  await writeFile(zeroCompPath, zeroCompCorrupt);
  await assert.rejects(extractZipArchive(zeroCompPath, join(root, 'zero-comp-out')), (err) => err?.code === 'extension-extract');
});

test('adapters/retrieval/installer resumes 206 partial downloads and cleans up temp zip & stage dirs on interruption/corruption', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studyhub-installer-boundaries-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const dshHome = join(root, 'dsh');
  const tempDir = join(root, 'tmp');
  const parentDir = join(root, 'local', 'StudyHub', 'tools');
  const targetDir = join(parentDir, 'retrieval');
  const version = '5.2.1';
  const assetName = retrievalAssetName(version);
  const sumsName = retrievalChecksumsName(version);

  const validZip = createZipBuffer([
    { name: 'package.json', data: Buffer.from(JSON.stringify({ name: '@ericwang1358/studyhub-retrieval', version, type: 'module' })) },
    { name: 'server.mjs', data: Buffer.from(fakeMcpServerSource({ tag: 'resumed-b' })) },
    { name: 'heal.js', data: Buffer.from('export async function healIndex() { return {}; }\n') },
    { name: 'node_modules/mcp-local-rag/package.json', data: Buffer.from('{"name":"mcp-local-rag","version":"0.20.0","main":"./index.js"}') },
    { name: 'node_modules/mcp-local-rag/index.js', data: Buffer.from('module.exports = {};\n') },
  ]);
  const validSha = createHash('sha256').update(validZip).digest('hex');
  const splitAt = Math.floor(validZip.length / 2);
  const etag = '"studyhub-retrieval-etag-v1"';
  const seenRanges = [];
  let assetCalls = 0;

  const resumeFetch = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === `/v${version}/${sumsName}`) {
      return new Response(`${validSha}  ${assetName}\n`, { status: 200 });
    }
    if (pathname === `/v${version}/${assetName}`) {
      assetCalls += 1;
      const rangeHeader = init.headers?.Range || null;
      const ifRange = init.headers?.['If-Range'] || null;
      seenRanges.push({ rangeHeader, ifRange });
      if (assetCalls === 1) {
        // Emit first half, then throw mid-stream network error
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(validZip.length), etag }),
          body: {
            async *[Symbol.asyncIterator]() {
              yield validZip.subarray(0, splitAt);
              throw new Error('ECONNRESET mid-stream');
            },
            cancel: async () => {},
          },
        };
      }
      assert.equal(rangeHeader, `bytes=${splitAt}-`);
      assert.equal(ifRange, etag);
      const rest = validZip.subarray(splitAt);
      return {
        ok: true,
        status: 206,
        headers: new Headers({
          'content-length': String(rest.length),
          'content-range': `bytes ${splitAt}-${validZip.length - 1}/${validZip.length}`,
          etag,
        }),
        body: {
          async *[Symbol.asyncIterator]() {
            yield rest;
          },
          cancel: async () => {},
        },
      };
    }
    return new Response('not found', { status: 404 });
  };

  const installer = createRetrievalInstaller({
    env: { DSH_HOME: dshHome },
    desktopDir: targetDir,
    dshHome,
    tempDir,
    httpFetch: resumeFetch,
    downloadPrefix: 'http://127.0.0.1:9999/',
    attempts: 3,
    sleep: async () => {},
  });

  // 1. Resumed 206 download completes cleanly and leaves zero temp zip files
  const installed = await installer.install({ version });
  assert.equal(installed.sha256, validSha);
  assert.equal(seenRanges.length, 2);
  assert.deepEqual(await readdir(tempDir), [], 'temp zip cleaned up after successful install');

  // 2. Interrupted download failing all retries cleans up partial temp zip
  const failingInstaller = createRetrievalInstaller({
    env: { DSH_HOME: dshHome },
    desktopDir: targetDir,
    dshHome,
    tempDir,
    attempts: 2,
    sleep: async () => {},
    downloadPrefix: 'http://127.0.0.1:9999/',
    httpFetch: async (url) => {
      if (url.endsWith(sumsName)) return new Response(`${validSha}  ${assetName}\n`, { status: 200 });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(validZip.length) }),
        body: {
          async *[Symbol.asyncIterator]() {
            yield validZip.subarray(0, 32);
            throw new Error('socket hang up');
          },
          cancel: async () => {},
        },
      };
    },
  });
  await assert.rejects(failingInstaller.install({ version }), (err) => err?.code === 'extension-download');
  assert.deepEqual(await readdir(tempDir), [], 'partial temp zip removed after interrupted download');

  // 3. Oversized stream exceeding maxZipBytes aborts and cleans up temp zip
  const tinyLimitInstaller = createRetrievalInstaller({
    env: { DSH_HOME: dshHome },
    desktopDir: targetDir,
    dshHome,
    tempDir,
    maxZipBytes: 64,
    attempts: 1,
    downloadPrefix: 'http://127.0.0.1:9999/',
    httpFetch: async (url) => {
      if (url.endsWith(sumsName)) return new Response(`${validSha}  ${assetName}\n`, { status: 200 });
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          async *[Symbol.asyncIterator]() {
            yield validZip.subarray(0, 40);
            yield validZip.subarray(40, 100);
          },
          cancel: async () => {},
        },
      };
    },
  });
  await assert.rejects(tinyLimitInstaller.install({ version }), (err) => err?.code === 'extension-download');
  assert.deepEqual(await readdir(tempDir), [], 'oversized temp zip removed immediately');

  // 4. Zip-Slip archive fails extraction and cleans up BOTH temp zip AND .retrieval-stage-* dir
  const evilZip = createZipBuffer([{ name: '../escaped.txt', data: Buffer.from('pwned') }]);
  const evilSha = createHash('sha256').update(evilZip).digest('hex');
  const evilInstaller = createRetrievalInstaller({
    env: { DSH_HOME: dshHome },
    desktopDir: targetDir,
    dshHome,
    tempDir,
    attempts: 1,
    downloadPrefix: 'http://127.0.0.1:9999/',
    httpFetch: async (url) => {
      if (url.endsWith(sumsName)) return new Response(`${evilSha}  ${assetName}\n`, { status: 200 });
      return new Response(evilZip, { status: 200, headers: { 'content-length': String(evilZip.length) } });
    },
  });
  await assert.rejects(evilInstaller.install({ version }), (err) => err?.code === 'extension-zip-unsafe');
  assert.deepEqual(await readdir(tempDir), [], 'temp zip removed after unsafe archive extraction failure');
  const parentEntries = await readdir(parentDir);
  assert.equal(parentEntries.some((name) => name.startsWith('.retrieval-stage-')), false, 'stage dir cleaned up');
  assert.equal(await pathExists(join(parentDir, 'escaped.txt')), false);

  // 5. file:// local asset streaming install + oversize rejection
  const localReleaseDir = join(root, 'local-release', `v${version}`);
  await mkdir(localReleaseDir, { recursive: true });
  await writeFile(join(localReleaseDir, sumsName), `${validSha}  ${assetName}\n`, 'utf8');
  await writeFile(join(localReleaseDir, assetName), validZip);
  const localPrefix = pathToFileURL(join(root, 'local-release')).href;
  const localInstaller = createRetrievalInstaller({
    env: { DSH_HOME: dshHome },
    desktopDir: join(root, 'local-target', 'retrieval'),
    dshHome,
    tempDir,
    downloadPrefix: localPrefix,
  });
  const localInstalled = await localInstaller.install({ version });
  assert.equal(localInstalled.sha256, validSha);
  assert.deepEqual(await readdir(tempDir), []);

  const localOversizeInstaller = createRetrievalInstaller({
    env: { DSH_HOME: dshHome },
    desktopDir: join(root, 'local-target-2', 'retrieval'),
    dshHome,
    tempDir,
    maxZipBytes: 16,
    downloadPrefix: localPrefix,
  });
  await assert.rejects(localOversizeInstaller.install({ version }), (err) => err?.code === 'extension-download');
  assert.deepEqual(await readdir(tempDir), []);
});


