import { spawnSync } from 'node:child_process';
import { cp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractRelease } from '../extract-release.mjs';

/* The S5-7 rollback drill runner: `node tests/fixtures/runtime-s57/run-drill.mjs [rollbackTag]`. It extracts the fixed older version (default v2.7.1, a git tag) next to the work
   folder, then for every scenario: the current code (all non-model switches on) prepares artifacts or unfinished work and ends hard; the older tree opens a copy of that library and
   DSH home and finishes the work; the current code opens another copy and does the same; the current code reads what the older one left. Everything is fake: no network, no key,
   and DSH_HOME is a folder under the work folder. The evidence goes to docs/plans/unified-job-runtime/s5-7-evidence.json. */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tag = process.argv[2] || 'v2.7.1', scratch = join(repo, '.local', 'drill'), older = join(repo, '.local', `old-${tag.replace(/^v/, '')}`);
const script = join(dirname(fileURLToPath(import.meta.url)), 'rollback.mjs');
const SCENARIOS = ['settled', 'pdf', 'install', 'setup', 'index'];
for (const key of Object.keys(process.env)) if (/_API_KEY$|_TOKEN$|BASE_URL$/.test(key)) delete process.env[key];
process.env.SSH_TTY ||= 'audit';

const sha = await extractRelease(repo, tag, older);
const run = (args, cwd = repo) => {
  const out = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 600_000, env: { ...process.env, DSH_HOME: '' } });
  const line = `${out.stdout}`.split('\n').find(text => text.startsWith('RESULT '));
  if (out.status !== 0 || !line) throw new Error(`${args.join(' ')} failed (${out.status}): ${`${out.stderr}`.slice(-1500)}${`${out.stdout}`.slice(-500)}`);
  return JSON.parse(line.slice('RESULT '.length));
};

/* Every kind of file the current code leaves behind (ids and hashes folded), so "no new persistent format" is a fact in the evidence, not a claim. */
const kindsUnder = async (folder, prefix = '') => {
  const kinds = new Set();
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`.replace(/[0-9a-f]{8,}(-[0-9a-f-]+)?/g, '<id>');
    if (entry.isDirectory()) for (const kind of await kindsUnder(join(folder, entry.name), `${name}/`)) kinds.add(kind); else kinds.add(name);
  }
  return kinds;
};
await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
const evidence = { schema: 1, rollbackTag: tag, rollbackSha: sha, scenarios: {} };
/* The library keeps its own path across the rollback (the conversion folders and the search-index manifest are keyed by it), so the drill works in ONE folder and puts a snapshot back between the runs. */
for (const scenario of SCENARIOS) {
  const live = join(scratch, scenario, 'live'), snapshot = join(scratch, scenario, 'snapshot');
  run(['prepare', scenario, live, repo, 'on', 'look']);
  await new Promise(resolveWait => setTimeout(resolveWait, 1500));
  await cp(live, snapshot, { recursive: true });
  const rolledBack = run(['read', scenario, live, older, 'off', 'act']);
  const rolledForward = run(['read', scenario, live, repo, 'on', 'look']);
  await rm(live, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); await cp(snapshot, live, { recursive: true });
  const sameCode = run(['read', scenario, live, repo, 'on', 'act']);
  if (scenario === 'settled') evidence.fileKinds = [...await kindsUnder(snapshot)].filter(kind => !kind.startsWith('mineru') && !kind.startsWith('py') && kind !== 'prepared.json').sort();
  evidence.scenarios[scenario] = { rolledBack, rolledForward, sameCode };
}
await writeFile(join(repo, 'docs', 'plans', 'unified-job-runtime', 's5-7-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`wrote the evidence for ${tag} (${sha})`);
