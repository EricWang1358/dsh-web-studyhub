import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* The S2-7 rollback drill runner: `node tests/fixtures/runtime-s27/run-drill.mjs [rollbackTag]`. It extracts the fixed older version (default v2.7.1, a git tag) next to the work
   folder, then for every scenario: the current code (all audio switches on) prepares artifacts or unfinished work and ends hard; the older tree opens a copy of that library and
   DSH home and goes on with the work; the current code opens another copy and does the same; the current code reads what the older one left. Everything is fake: no network, no key,
   and DSH_HOME is a folder under the work folder. The evidence goes to docs/plans/unified-job-runtime/s2-7-evidence.json. */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tag = process.argv[2] || 'v2.7.1', scratch = join(repo, '.local', 'drill-s27'), older = join(repo, '.local', `old-${tag.replace(/^v/, '')}`);
const script = join(dirname(fileURLToPath(import.meta.url)), 'rollback.mjs');
const SCENARIOS = ['settled', 'single', 'batch', 'batchAnswered', 'text'];
for (const key of Object.keys(process.env)) if (/_API_KEY$|_TOKEN$|BASE_URL$/.test(key)) delete process.env[key];
process.env.SSH_TTY ||= 'audit';

const sha = execFileSync('git', ['rev-parse', tag], { cwd: repo, encoding: 'utf8' }).trim();
if (!existsSync(join(older, 'lib', 'service.js'))) {
  await mkdir(older, { recursive: true });
  const archive = execFileSync('git', ['archive', tag], { cwd: repo, maxBuffer: 512 * 1024 * 1024 });
  if (spawnSync('tar', ['-x'], { cwd: older, input: archive }).status !== 0) throw new Error(`could not extract ${tag}`);
}
/** One step. A process that ends hard because a preload says so (the batch whose answers were all saved) writes its own report line instead of RESULT. */
const run = (args, { crashes = false } = {}) => {
  const out = spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8', timeout: 600_000, env: { ...process.env, DSH_HOME: '' } });
  const lines = `${out.stdout}`.split('\n'), line = lines.find(text => text.startsWith('RESULT ')) ?? (crashes ? lines.find(text => text.startsWith('{')) : undefined);
  if (out.status !== 0 || !line) throw new Error(`${args.join(' ')} failed (${out.status}): ${`${out.stderr}`.slice(-1500)}${`${out.stdout}`.slice(-500)}`);
  return JSON.parse(line.startsWith('RESULT ') ? line.slice('RESULT '.length) : line);
};
await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
const evidence = { schema: 1, rollbackTag: tag, rollbackSha: sha, scenarios: {} };
/* The library keeps its own path across the rollback, so the drill works in ONE folder per scenario and puts a snapshot back between the runs. */
for (const scenario of SCENARIOS) {
  const live = join(scratch, scenario, 'live'), snapshot = join(scratch, scenario, 'snapshot');
  run(['prepare', scenario, live, repo, 'on', 'look'], { crashes: true });
  await new Promise(resolveWait => setTimeout(resolveWait, 1500));
  await cp(live, snapshot, { recursive: true });
  const rolledBack = run(['read', scenario, live, older, 'off', 'act']);
  const rolledForward = run(['read', scenario, live, repo, 'on', 'look']);
  await rm(live, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); await cp(snapshot, live, { recursive: true });
  const sameCode = run(['read', scenario, live, repo, 'on', 'act']);
  evidence.scenarios[scenario] = { rolledBack, rolledForward, sameCode };
}
/* The same work made by the OLDER version alone: the kinds of file it leaves are the baseline of "no new persistent format". */
const baseline = join(scratch, 'older-settled');
run(['prepare', 'settled', baseline, older, 'off', 'look']);
evidence.olderFileKinds = run(['read', 'settled', baseline, older, 'off', 'look']).fileKinds;
await writeFile(join(repo, 'docs', 'plans', 'unified-job-runtime', 's2-7-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`wrote the evidence for ${tag} (${sha})`);
