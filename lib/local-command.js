import { spawn } from 'node:child_process';

export class CommandError extends Error {
  constructor(code, message) { super(message); this.name = 'CommandError'; this.code = code; }
}
const LINE_BREAK = /\r?\n|\r/;

function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  } catch { try { child.kill(); } catch { /* already gone */ } }
}

/**
 * Run the command line: no shell, UTF-8 forced, the whole process tree killed on abort or timeout.
 * Resolves { code, stdout, stderr }; rejects with the abort reason, or a CommandError (not-installed, timeout).
 */
export function runLocalCommand(cli, args, { signal, timeoutMs = 20_000, cwd, onLine } = {}) {
  return new Promise((resolve, reject) => {
    if (!cli) return reject(new CommandError('not-installed', 'Command not found'));
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    let child;
    try {
      child = spawn(cli.file, [...(cli.prefix || []), ...args], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
        env: { ...process.env, ...(cli.env || {}), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    } catch (error) { return reject(error?.code === 'ENOENT' ? new CommandError('not-installed', 'Command not found') : error); }
    let stdout = '', stderr = '', settled = false, timer;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); settle(value);
    };
    const onAbort = () => { killTree(child); finish(reject, signal.reason ?? new Error('aborted')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => { killTree(child); finish(reject, new CommandError('timeout', 'Command timed out')); }, timeoutMs);
    const take = (current, part) => current.length >= 1_000_000 ? current : current + part.slice(0, 1_000_000 - current.length);
    const lines = part => { if (onLine) for (const line of part.split(LINE_BREAK)) if (line.trim()) onLine(line.trim()); };
    child.stdout.on('data', part => { const text = part.toString('utf8'); stdout = take(stdout, text); lines(text); });
    child.stderr.on('data', part => { const text = part.toString('utf8'); stderr = take(stderr, text); lines(text); });
    child.on('error', error => finish(reject, error?.code === 'ENOENT' ? new CommandError('not-installed', 'Command not found') : error));
    child.on('close', code => finish(resolve, { code, stdout, stderr }));
  });
}
