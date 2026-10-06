import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('../fixtures/audio-batch-process.mjs', import.meta.url));

/**
 * Run one mode of the batch process fixture against a library and read its JSON report. `preload` is the source of a module run first in that
 * process (to end it at a chosen point); the report is whatever the process (or the preload) wrote to stdout before it ended.
 */
export function runBatchChild({ directory, root, mode, preload, env = {} }) {
  return new Promise((resolve, reject) => {
    const args = [...(preload ? ['--import', `data:text/javascript,${encodeURIComponent(preload)}`] : []), fixture, root, mode];
    const child = spawn(process.execPath, args, { env: { ...process.env, DSH_HOME: join(directory, 'home'), STUDY_RUNTIME_SWITCH: 'runtime', ...env }, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.on('error', reject);
    child.on('close', code => code ? reject(new Error(err || out)) : resolve(JSON.parse(out.trim())));
  });
}

/** A preload that ends the process right after the result file of member `index` was written: the commit of that member is still pending and nothing is in flight. */
export const endAfterMemberResult = index => `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
  const rename = fs.promises.rename;
  fs.promises.rename = async (from, to) => {
    await rename(from, to);
    const hit = /audio-batches[\\\\/]([\\w-]+)[\\\\/]result-${index}\\.json$/.exec(String(to));
    if (!hit) return;
    setImmediate(() => { process.stdout.write(JSON.stringify({ batchId: hit[1] })); process.exit(0); });
    await new Promise(() => {});
  }; syncBuiltinESMExports();`;
