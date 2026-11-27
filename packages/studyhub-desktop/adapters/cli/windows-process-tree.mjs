import { win32 } from 'node:path';

/** Resolve after Windows finishes walking the descendant tree, including when taskkill itself fails. */
export function terminateWindowsTree(spawn, pid, fallbackKill) {
  const system = process.env.SystemRoot || process.env.windir;
  const command = system ? win32.join(system, 'System32', 'taskkill.exe') : 'taskkill';
  return new Promise(resolve => {
    const killer = spawn(command, ['/PID', String(pid), '/T', '/F'], {
      shell: false, windowsHide: true, stdio: 'ignore', timeout: 30_000,
    });
    let spawnError;
    killer.once('error', error => { spawnError = error; });
    killer.once('close', code => {
      if (code === 0) { resolve(null); return; }
      // The child can exit on its own between closing stdin and starting taskkill.
      try { process.kill(pid, 0); }
      catch (error) { if (error.code === 'ESRCH') { resolve(null); return; } }
      try { if (fallbackKill) fallbackKill(); else process.kill(pid); } catch { /* target raced with termination */ }
      resolve(spawnError || Object.assign(new Error(`Windows process-tree termination failed (taskkill exit ${code})`),
        { code: 'PROCESS_TREE_TERMINATION_FAILED' }));
    });
  });
}
