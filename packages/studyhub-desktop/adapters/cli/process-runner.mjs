import { spawn } from 'node:child_process';
import { createOutputCollector } from './output-collector.mjs';
import { unwrapExecutable } from './unwrap-executable.mjs';
import { terminateWindowsTree } from './windows-process-tree.mjs';

export { unwrapExecutable };

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 1500;

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

function createBrokenShimResult(reason, durationMs) {
  return {
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    aborted: false,
    truncated: false,
    silentTurn: true,
    errorCode: 'BROKEN_SHIM',
    errorMessage: reason,
    durationMs,
  };
}

/** The one kill of a started process, whoever asks for it (its time limit, its abort signal, terminate): the tree goes, and the result settles even when 'close' never comes. */
function createKillSwitch({ child, state, finalize }) {
  return () => {
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
}

/** Start a process with its output collected. What it is asked (stdin), its time limit and its abort signal come with `beginTurn`: at once for a run, later for a held process. */
function spawnCollected({ command, finalArgs, maxBytes, lineSink, request }) {
  const stdoutCol = createOutputCollector(maxBytes, lineSink);
  const stderrCol = createOutputCollector(maxBytes, null);
  const state = { settled: false, timedOut: false, aborted: false, asked: false, heard: false, spawnError: null, timeoutTimer: null, forceCloseTimer: null, started: Date.now(), detachSignal: null };
  const child = spawn(command, finalArgs, {
    cwd: request.cwd,
    env: request.env,
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let settle;
  const result = new Promise((resolve) => { settle = resolve; });

  const finalize = async (code, sig) => {
    if (state.settled) return;
    state.settled = true;
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    if (state.forceCloseTimer) clearTimeout(state.forceCloseTimer);
    state.detachSignal?.();
    state.spawnError = await state.termination || state.spawnError;
    const out = stdoutCol.finish();
    const err = stderrCol.finish();
    settle({
      code,
      signal: sig,
      stdout: out.text,
      stderr: err.text,
      timedOut: state.timedOut,
      aborted: state.aborted,
      truncated: out.truncated || err.truncated,
      silentTurn: !state.heard,
      errorCode: state.spawnError?.code || null,
      errorMessage: state.spawnError?.message || null,
      durationMs: Date.now() - state.started,
    });
  };

  const collectInto = (collector) => (chunk) => {
    state.heard ||= state.asked;
    collector.push(chunk);
  };
  child.stdout?.on('data', collectInto(stdoutCol));
  child.stderr?.on('data', collectInto(stderrCol));
  child.stdin?.on('error', () => {});
  child.on('error', (error) => { state.spawnError = error; finalize(null, null); });
  child.on('close', (code, sig) => finalize(code, sig));
  return { child, state, result, kill: createKillSwitch({ child, state, finalize }) };
}

/** Kill the process when `signal` aborts (or already has), and stop listening once the result is in. */
function watchAbort({ state, kill }, signal) {
  if (!signal) return;
  const onAbort = () => {
    state.aborted = true;
    kill();
  };
  if (signal.aborted) {
    onAbort();
    return;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  state.detachSignal = () => signal.removeEventListener('abort', onAbort);
}

/** Give a started process its turn: the abort signal and the time limit count from here, then stdin is written and closed. A process that has already ended answers with how it ended. */
function beginTurn(proc, request, started) {
  const { child, state, kill } = proc;
  if (state.settled) return proc.result;
  state.started = started;
  // From here on, anything the process says counts as an answer to this turn (`silentTurn` in the result).
  state.asked = true;
  watchAbort(proc, request.signal);
  if (Number.isFinite(request.timeoutMs) && request.timeoutMs > 0) {
    state.timeoutTimer = setTimeout(() => {
      state.timedOut = true;
      kill();
    }, request.timeoutMs);
    state.timeoutTimer.unref?.();
  }
  const payload = request.stdinText === undefined || request.stdinText === null ? '' : String(request.stdinText);
  if (payload) child.stdin?.end(payload, 'utf8');
  else child.stdin?.end();
  return proc.result;
}

async function spawnForRequest(request, lineSink) {
  const resolved = await unwrapExecutable(request.command);
  if (!resolved.ok) return { proc: null, reason: resolved.reason };
  const finalArgs = [...resolved.prefixArgs, ...(request.args || [])];
  const maxBytes = Number.isInteger(request.maxOutputBytes) && request.maxOutputBytes > 0
    ? request.maxOutputBytes
    : DEFAULT_MAX_OUTPUT_BYTES;
  return { proc: spawnCollected({ command: resolved.command, finalArgs, maxBytes, lineSink, request }), reason: '' };
}

/**
 * Execute a subprocess strictly with `shell: false` and `windowsHide: true`.
 * Supports stdin streaming + EOF, output cap, AbortSignal, timeout, and full process-tree kill.
 */
export async function runProcess(request) {
  const started = Date.now();
  const spawned = await spawnForRequest(request, request.onStdoutLine ? { onLine: request.onStdoutLine } : null);
  if (!spawned.proc) return createBrokenShimResult(spawned.reason, Date.now() - started);
  return beginTurn(spawned.proc, request, started);
}

/**
 * Start a process now and ask it later: the same spawn, collection, limits and kill as `runProcess`, split in two.
 * `run(turn)` takes what a run takes for its turn (`stdinText`, `timeoutMs`, `signal`, `onStdoutLine`) and resolves to the
 * same result; it is for one turn (a second call gets the first one's result). Until then the process waits with stdin
 * open and no time limit, and output it wrote while waiting is in `stdout` but is not handed to `onStdoutLine`.
 * `terminate()` ends it, asked or not, and resolves when it has gone.
 */
export async function holdProcess(request) {
  const lineSink = { onLine: null };
  const spawned = await spawnForRequest(request, lineSink);
  if (!spawned.proc) {
    const broken = createBrokenShimResult(spawned.reason, 0);
    return Object.freeze({ pid: null, exited: Promise.resolve(), run: async () => broken, terminate: async () => {} });
  }
  const { proc } = spawned;
  let asked = false;
  return Object.freeze({
    pid: proc.child.pid ?? null,
    exited: proc.result.then(() => {}),
    run(turn) {
      if (asked) return proc.result;
      asked = true;
      lineSink.onLine = turn.onStdoutLine || null;
      return beginTurn(proc, turn, Date.now());
    },
    async terminate() {
      if (!proc.state.settled) {
        try { proc.child.stdin?.end(); } catch { /* stdin may already be closed */ }
        proc.kill();
      }
      await proc.result;
    },
  });
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
    hold: holdProcess,
    spawnDetached,
    spawnPipeProcess,
    spawnPersistent,
  });
}
