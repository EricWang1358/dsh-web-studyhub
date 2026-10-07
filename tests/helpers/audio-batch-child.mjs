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

/**
 * A preload that ends the process right after the result file of member `index` was written: the commit of that member is still pending and nothing is in
 * flight. The files of a batch are made side by side, so the process is only ended once the manifest ON DISK also records what a crash at this point leaves:
 * the earlier members committed and this one's commit pending (observed from the manifest files as they are put in place, not guessed from timing).
 */
export const endAfterMemberResult = index => `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
  const rename = fs.promises.rename;
  let saved = [];
  const recorded = () => Array.from({ length: ${index} + 1 }, (_, member) => saved.find(commit => commit.stepKey === 'member:' + member))
    .every((commit, member) => commit && (member === ${index} || commit.status === 'complete'));
  fs.promises.rename = async (from, to) => {
    const manifest = /audio-batches[\\\\/][\\w-]+[\\\\/]manifest\\.json$/.test(String(to)) ? JSON.parse(await fs.promises.readFile(from, 'utf8')) : null;
    await rename(from, to);
    if (manifest) saved = manifest.runtimeJob?.commits ?? [];
    const hit = /audio-batches[\\\\/]([\\w-]+)[\\\\/]result-${index}\\.json$/.exec(String(to));
    if (!hit) return;
    for (const deadline = Date.now() + 30000; !recorded() && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 10));
    setImmediate(() => { process.stdout.write(JSON.stringify({ batchId: hit[1] })); process.exit(0); });
    await new Promise(() => {});
  }; syncBuiltinESMExports();`;
