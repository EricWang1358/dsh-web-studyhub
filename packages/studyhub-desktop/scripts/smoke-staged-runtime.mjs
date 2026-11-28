import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProcess, spawnPipeProcess } from '../adapters/cli/process-runner.mjs';
import { stageRuntime } from './stage-runtime.mjs';

const HANDSHAKE_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 5_000;

function readFirstStdoutLine(proc, stderrChunks, timeoutMs) {
  return new Promise((resolveLine, rejectLine) => {
    let buffer = '';
    let settled = false;
    const finish = (err, line) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stdout?.off('data', onData);
      if (err) rejectLine(err);
      else resolveLine(line);
    };
    const timer = setTimeout(() => {
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      finish(new Error(`Timed out waiting for sidecar handshake (${timeoutMs}ms). stderr: ${stderrText}`));
    }, timeoutMs);
    timer.unref?.();

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl).trim();
      if (line) finish(null, line);
    };
    proc.stdout?.on('data', onData);
    proc.exited.then(({ code, signal }) => {
      const stderrText = Buffer.concat(stderrChunks).toString('utf8').trim();
      finish(new Error(`Staged sidecar exited before handshake (code=${code}, signal=${signal}). stderr: ${stderrText}`));
    });
  });
}

function waitForExit(proc, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => {
      rejectExit(new Error(`Staged sidecar did not exit within ${timeoutMs}ms after stdin EOF`));
    }, timeoutMs);
    timer.unref?.();
    proc.exited.then((result) => {
      clearTimeout(timer);
      resolveExit(result);
    });
  });
}

async function rpcCall(baseUrl, token, action, args = {}) {
  const response = await fetch(`${baseUrl}/api/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Study-Token': token,
    },
    body: JSON.stringify({ action, args }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(`RPC ${action} failed (HTTP ${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload.value;
}

async function verifyUnauthenticatedRejected(baseUrl) {
  const response = await fetch(`${baseUrl}/api/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'snapshot', args: {} }),
  });
  if (response.status !== 403) {
    throw new Error(`Expected HTTP 403 for unauthenticated /api/call, got ${response.status}`);
  }
}

async function verifyStagedStudyCli({ nodeBin, cliPath, libraryDir, tempRoot }) {
  const res = await runProcess({
    command: nodeBin,
    args: [cliPath, 'call', 'snapshot', '--root', libraryDir],
    cwd: tempRoot,
    env: { ...process.env, NODE_PATH: '' },
    timeoutMs: 45_000,
  });
  if (res.code !== 0) {
    throw new Error(`Staged study-cli.mjs failed (code=${res.code}, timedOut=${res.timedOut}): ${res.stderr}`);
  }
  const parsed = JSON.parse(res.stdout);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.decks)) {
    throw new Error(`Unexpected staged study-cli.mjs snapshot output: ${res.stdout.slice(0, 200)}`);
  }
}

const samePath = (a, b) => resolve(String(a || '')).toLowerCase() === resolve(String(b || '')).toLowerCase();

function verifyStagedStudyPaths({ cfg, binding, runtimeDir, stagedNode }) {
  const expectedCliPath = join(runtimeDir, 'scripts', 'study-cli.mjs');
  const reported = [cfg, binding];
  if (reported.some((view) => view?.studyCliPath !== expectedCliPath)) {
    throw new Error(`Expected staged studyCliPath ${expectedCliPath}, got config=${cfg?.studyCliPath} binding=${binding?.studyCliPath}`);
  }
  // the hand-off command runs this node: the portable one the app ships, not a node from PATH
  if (reported.some((view) => !view?.studyNodePath || !samePath(view.studyNodePath, stagedNode))) {
    throw new Error(`Expected staged studyNodePath ${stagedNode}, got config=${cfg?.studyNodePath} binding=${binding?.studyNodePath}`);
  }
  return expectedCliPath;
}

async function verifyStagedSidecarRpc({ baseUrl, token, runtimeDir, stagedNode, libraryDir, tempRoot }) {
  await verifyUnauthenticatedRejected(baseUrl);
  await rpcCall(baseUrl, token, 'snapshot');
  const cfg = await rpcCall(baseUrl, token, 'desktop.config.get', { uiLanguage: 'zh' });
  const binding = await rpcCall(baseUrl, token, 'binding.get');
  const expectedCliPath = verifyStagedStudyPaths({ cfg, binding, runtimeDir, stagedNode });
  await verifyStagedStudyCli({ nodeBin: stagedNode, cliPath: expectedCliPath, libraryDir, tempRoot });
  await rpcCall(baseUrl, token, 'desktop.providers.scan', { uiLanguage: 'en' });
  await rpcCall(baseUrl, token, 'retrieval.status');
}

async function closeAndWaitForExit(proc) {
  const exitStart = Date.now();
  proc.stdin.end();
  const exitResult = await waitForExit(proc, EXIT_TIMEOUT_MS);
  if (exitResult.code !== 0) {
    throw new Error(`Expected staged sidecar clean exit code 0, got code=${exitResult.code} signal=${exitResult.signal}`);
  }
  return Date.now() - exitStart;
}

export async function runStagedRuntimeSmoke() {
  const started = Date.now();
  const tempRoot = await mkdtemp(join(tmpdir(), 'studyhub-staged-smoke-'));
  const runtimeDir = join(tempRoot, 'runtime');
  const homeDir = join(tempRoot, 'home');
  const libraryDir = join(tempRoot, 'library');
  let proc = null;

  try {
    await Promise.all([mkdir(homeDir, { recursive: true }), mkdir(libraryDir, { recursive: true })]);
    const staged = await stageRuntime({ outdir: runtimeDir });
    const stagedNode = join(runtimeDir, staged.node.binaryName);
    const stagedEntry = join(runtimeDir, 'packages', 'studyhub-desktop', 'entry', 'sidecar.mjs');
    const token = randomBytes(32).toString('hex');

    const retrievalDir = join(tempRoot, 'retrieval-tools');
    const localAppData = join(tempRoot, 'localappdata');
    const stderrChunks = [];
    proc = spawnPipeProcess({
      command: stagedNode,
      args: [stagedEntry],
      cwd: tempRoot,
      env: {
        ...process.env,
        NODE_PATH: '',
        DSH_HOME: homeDir,
        STUDYHUB_LIBRARY: libraryDir,
        STUDYHUB_DESKTOP_RETRIEVAL_DIR: retrievalDir,
        LOCALAPPDATA: localAppData,
      },
    });
    proc.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    proc.stdin.on('error', () => {});

    const handshakeLinePromise = readFirstStdoutLine(proc, stderrChunks, HANDSHAKE_TIMEOUT_MS);
    proc.stdin.write(`${JSON.stringify({ token })}\n`, 'utf8');
    const handshakeLine = await handshakeLinePromise;
    const parsed = JSON.parse(handshakeLine);
    if (!Number.isInteger(parsed?.port) || parsed.port <= 0) {
      throw new Error(`Invalid handshake port payload: ${handshakeLine}`);
    }

    const baseUrl = `http://127.0.0.1:${parsed.port}`;
    await verifyStagedSidecarRpc({ baseUrl, token, runtimeDir, stagedNode, libraryDir, tempRoot });
    const eofExitMs = await closeAndWaitForExit(proc);
    proc = null;

    return {
      version: staged.version,
      productionPackages: staged.productionPackages,
      port: parsed.port,
      eofExitMs,
      totalMs: Date.now() - started,
    };
  } finally {
    if (proc) proc.kill();
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runStagedRuntimeSmoke();
  console.log(
    `Staged runtime smoke PASSED (v${result.version}, ${result.productionPackages} prod packages, port ${result.port}, stdin-EOF exit 0 in ${result.eofExitMs}ms, total ${result.totalMs}ms)`
  );
}
