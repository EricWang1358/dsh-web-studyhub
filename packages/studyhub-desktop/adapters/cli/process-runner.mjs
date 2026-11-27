import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { parseCmdShimTarget } from '../../domain/shim-parser.js';
import { terminateWindowsTree } from './windows-process-tree.mjs';

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 1500;
const WINDOWS_SHIM_EXTS = new Set(['.cmd', '.bat']);
const NODE_SCRIPT_EXTS = new Set(['.js', '.mjs', '.cjs']);

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Safely unwrap Windows `.cmd`/`.bat` shims and `.js` scripts without ever using `shell: true`.
 */
export async function unwrapExecutable(commandPath, { exists = fileExists, readText = (p) => readFile(p, 'utf8') } = {}) {
  const ext = extname(commandPath).toLowerCase();
  if (NODE_SCRIPT_EXTS.has(ext)) {
    return { ok: true, command: process.execPath, prefixArgs: [commandPath] };
  }
  if (!WINDOWS_SHIM_EXTS.has(ext)) {
    return { ok: true, command: commandPath, prefixArgs: [] };
  }

  let content;
  try {
    content = await readText(commandPath);
  } catch (error) {
    return { ok: false, errorCode: 'BROKEN_SHIM', reason: `无法读取启动脚本：${error?.message || commandPath}` };
  }

  const parsed = parseCmdShimTarget(content, dirname(commandPath));
  if (!parsed) {
    return { ok: false, errorCode: 'BROKEN_SHIM', reason: `无法解析 .cmd 启动脚本目标：${commandPath}` };
  }
  if (!(await exists(parsed.targetPath))) {
    return { ok: false, errorCode: 'BROKEN_SHIM', reason: `启动脚本指向的目标文件不存在：${parsed.targetPath}` };
  }
  if (parsed.kind === 'node-script') {
    return { ok: true, command: process.execPath, prefixArgs: [parsed.targetPath] };
  }
  return { ok: true, command: parsed.targetPath, prefixArgs: [] };
}

/**
 * Terminate a child process and its entire descendant tree without using a shell.
 */
export function killProcessTree(pid, platform = process.platform, fallbackKill = null) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === 'win32') return terminateWindowsTree(spawn, pid, fallbackKill);
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ }
  }
  const timer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
  }, KILL_GRACE_MS);
  timer.unref?.();
  return null;
}

/**
 * Spawn a detached OS utility (e.g. browser opener) with `shell: false` and `windowsHide: true`.
 */
export function spawnDetached(command, args = []) {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref?.();
}

/**
 * Start a detached program with one prepared, verbatim argument line (`windowsVerbatimArguments`), still with `shell: false`.
 * The line is built and checked by `domain/terminal-command.js`; the only caller is `adapters/os/open-terminal.mjs`.
 * Resolves once the program has started and rejects when it could not be started.
 */
export function spawnVerbatimDetached(command, argumentLine, { cwd } = {}) {
  return new Promise((resolveStarted, rejectStarted) => {
    const child = spawn(command, [argumentLine], {
      cwd,
      detached: true,
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.once('error', rejectStarted);
    child.once('spawn', () => {
      child.unref?.();
      resolveStarted();
    });
  });
}

function createOutputCollector(maxBytes, onLine) {
  const chunks = [];
  const decoder = onLine ? new StringDecoder('utf8') : null;
  let collected = 0;
  let truncated = false;
  let lineBuffer = '';

  function push(buffer) {
    const chunk = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (onLine && decoder) {
      lineBuffer += decoder.write(chunk);
      const parts = lineBuffer.split(/\r?\n/);
      lineBuffer = parts.pop() || '';
      for (const line of parts) onLine(line);
    }
    if (collected >= maxBytes) {
      truncated = true;
      return;
    }
    const remaining = maxBytes - collected;
    if (chunk.length > remaining) {
      chunks.push(chunk.subarray(0, remaining));
      collected += remaining;
      truncated = true;
    } else {
      chunks.push(chunk);
      collected += chunk.length;
    }
  }

  function finish() {
    if (onLine && decoder) {
      lineBuffer += decoder.end();
      if (lineBuffer) {
        onLine(lineBuffer);
        lineBuffer = '';
      }
    }
    return { text: Buffer.concat(chunks).toString('utf8'), truncated };
  }

  return { push, finish };
}

function createBrokenShimResult(reason, durationMs) {
  return {
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false,
    truncated: false,
    errorCode: 'BROKEN_SHIM',
    errorMessage: reason,
    durationMs,
  };
}

function attachTerminationControls({ child, request, state, finalize }) {
  const triggerKill = () => {
    if (state.termination || state.forceCloseTimer) return;
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    if (child.pid) state.termination = killProcessTree(child.pid, process.platform, () => child.kill());
    else try { child.kill(); } catch { /* already exited */ }
    // Windows taskkill walks the tree asynchronously: a failed walk settles at once, and finalize waits for its outcome.
    state.termination?.then(error => {
      if (error) finalize(null, null);
    });
    // On every system: a process outside the killed tree can keep stdout open, so 'close' may never come.
    state.forceCloseTimer = setTimeout(() => finalize(null, 'SIGKILL'), KILL_GRACE_MS + 500);
    state.forceCloseTimer.unref?.();
  };
  const onAbort = () => {
    state.aborted = true;
    triggerKill();
  };
  if (request.signal) {
    if (request.signal.aborted) onAbort();
    else request.signal.addEventListener('abort', onAbort, { once: true });
  }
  if (Number.isFinite(request.timeoutMs) && request.timeoutMs > 0) {
    state.timeoutTimer = setTimeout(() => {
      state.timedOut = true;
      triggerKill();
    }, request.timeoutMs);
    state.timeoutTimer.unref?.();
  }
  return onAbort;
}

function executeSpawnedProcess({ command, finalArgs, maxBytes, request, started }) {
  return new Promise((resolve) => {
    const stdoutCol = createOutputCollector(maxBytes, request.onStdoutLine);
    const stderrCol = createOutputCollector(maxBytes, null);
    const state = { settled: false, timedOut: false, aborted: false, spawnError: null, timeoutTimer: null, forceCloseTimer: null };
    let onAbort = null;

    const child = spawn(command, finalArgs, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finalize = async (code, sig) => {
      if (state.settled) return;
      state.settled = true;
      if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
      if (state.forceCloseTimer) clearTimeout(state.forceCloseTimer);
      if (onAbort) request.signal?.removeEventListener('abort', onAbort);
      state.spawnError = await state.termination || state.spawnError;
      const out = stdoutCol.finish();
      const err = stderrCol.finish();
      resolve({
        code,
        signal: sig,
        stdout: out.text,
        stderr: err.text,
        timedOut: state.timedOut,
        aborted: state.aborted,
        truncated: out.truncated || err.truncated,
        errorCode: state.spawnError?.code || null,
        errorMessage: state.spawnError?.message || null,
        durationMs: Date.now() - started,
      });
    };

    onAbort = attachTerminationControls({ child, request, state, finalize });
    child.stdout?.on('data', (chunk) => stdoutCol.push(chunk));
    child.stderr?.on('data', (chunk) => stderrCol.push(chunk));
    child.stdin?.on('error', () => {});
    child.on('error', (error) => { state.spawnError = error; finalize(null, null); });
    child.on('close', (code, sig) => finalize(code, sig));

    const payload = request.stdinText === undefined || request.stdinText === null ? '' : String(request.stdinText);
    if (payload) child.stdin?.end(payload, 'utf8');
    else child.stdin?.end();
  });
}

/**
 * Execute a subprocess strictly with `shell: false` and `windowsHide: true`.
 * Supports stdin streaming + EOF, output cap, AbortSignal, timeout, and full process-tree kill.
 */
export async function runProcess(request) {
  const started = Date.now();
  const resolved = await unwrapExecutable(request.command);
  if (!resolved.ok) {
    return createBrokenShimResult(resolved.reason, Date.now() - started);
  }
  const finalArgs = [...resolved.prefixArgs, ...(request.args || [])];
  const maxBytes = Number.isInteger(request.maxOutputBytes) && request.maxOutputBytes > 0
    ? request.maxOutputBytes
    : DEFAULT_MAX_OUTPUT_BYTES;
  return executeSpawnedProcess({ command: resolved.command, finalArgs, maxBytes, request, started });
}

/**
 * Spawn a piped child process strictly with `shell: false` and `windowsHide: true`,
 * keeping `stdin` open until the caller calls `stdin.end()`.
 */
export function spawnPipeProcess({ command, args = [], cwd, env }) {
  const child = spawn(command, args, {
    cwd,
    env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin?.on('error', () => {});
  const exited = new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.once('error', (error) => finish({ code: null, signal: null, error }));
    child.once('close', (code, signal) => finish({ code, signal, error: null }));
  });
  return Object.freeze({
    pid: child.pid ?? null,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => {
      if (child.pid) return killProcessTree(child.pid, process.platform, () => child.kill());
      child.kill();
      return null;
    },
    exited,
  });
}

/**
 * Spawn a persistent stdio child process (`shell: false`, `windowsHide: true`)
 * with graceful + tree-kill `terminate()` that waits for process exit.
 */
export function spawnPersistent({ command, args = [], cwd, env }) {
  const proc = spawnPipeProcess({ command, args, cwd, env });
  let exited = false;
  proc.exited.then(() => { exited = true; });

  async function terminate(graceMs = KILL_GRACE_MS) {
    if (exited) return proc.exited;
    try { proc.stdin?.end(); } catch { /* stdin may already be closed */ }
    const windowsTermination = proc.kill();
    const waitMs = Math.max(200, Number(graceMs) || KILL_GRACE_MS) + 1500;
    let timer = null;
    // A process outside the killed tree can keep stdout open, so 'close' may never come: the deadline holds on every system.
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ code: null, signal: 'SIGKILL', error: null }), waitMs);
      timer.unref?.();
    });
    try {
      const error = await windowsTermination;
      if (error) throw error;
      return await Promise.race([proc.exited, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return Object.freeze({ ...proc, terminate });
}

export function createProcessRunner() {
  return Object.freeze({
    run: runProcess,
    spawnDetached,
    spawnPipeProcess,
    spawnPersistent,
  });
}
