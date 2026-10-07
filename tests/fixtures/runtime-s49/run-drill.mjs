import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/* The S4-9 rollback drill runner: `node tests/fixtures/runtime-s49/run-drill.mjs [rollbackTag]`. For every model family (recap, note draft, translation, learning workflow, assistant) and for both a
   FINISHED run and one that is still going when the process ends hard: the current code (the family's switch on) leaves its records; the fixed older version (default v2.7.1, `git archive` of the
   tag, unpacked under .local) opens a copy of that library and DSH home, reports what it shows and starts the work again; the current code opens the library after that; and a second copy is
   put back for the current code to do the same itself (the comparison). Everything is a fake: no network, no key, DSH_HOME is a folder under .local. The evidence goes to
   docs/plans/unified-job-runtime/s4-9-rollback-evidence.json. */

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tag = process.argv[2] || 'v2.7.1', scratch = join(repo, '.local', 'drill49'), older = join(repo, '.local', `old-${tag.replace(/^v/, '')}`);
const script = join(dirname(fileURLToPath(import.meta.url)), 'rollback.mjs');
const FAMILIES = ['recap', 'note', 'translation', 'workflow', 'assist'], PHASES = ['settled', 'crash'];
for (const key of Object.keys(process.env)) if (/_API_KEY$|_TOKEN$|BASE_URL$/.test(key)) delete process.env[key];
process.env.SSH_TTY ||= 'audit';

const sha = execFileSync('git', ['rev-parse', tag], { cwd: repo, encoding: 'utf8' }).trim();
if (!existsSync(join(older, 'lib', 'service.js'))) {
  await mkdir(older, { recursive: true });
  const archive = execFileSync('git', ['archive', tag], { cwd: repo, maxBuffer: 512 * 1024 * 1024 });
  if (spawnSync('tar', ['-x', '-C', older], { input: archive }).status !== 0) throw new Error(`could not extract ${tag}`);
}
const run = args => {
  const out = spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8', timeout: 600_000, env: { ...process.env, DSH_HOME: '' } });
  const line = `${out.stdout}`.split('\n').find(text => text.startsWith('RESULT '));
  if (out.status !== 0 || !line) throw new Error(`${args.join(' ')} failed (${out.status}): ${`${out.stderr}`.slice(-1500)}${`${out.stdout}`.slice(-500)}`);
  return JSON.parse(line.slice('RESULT '.length));
};
/* Every kind of file the current code leaves behind (ids and hashes folded): "no new persistent format" is a fact in the evidence, not a claim. */
const kindsUnder = async (folder, prefix = '') => {
  const kinds = new Set();
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`.replace(/[0-9a-f]{8,}(-[0-9a-f-]+)?/g, '<id>');
    if (entry.isDirectory()) for (const kind of await kindsUnder(join(folder, entry.name), `${name}/`)) kinds.add(kind); else kinds.add(name);
  }
  return kinds;
};

await rm(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
const evidence = { schema: 1, rollbackTag: tag, rollbackSha: sha, families: {} };
const kinds = new Set();
/* The library keeps its own path across the rollback (some folders are keyed by it), so the drill works in ONE folder and puts a snapshot back between the runs. */
for (const family of FAMILIES) for (const phase of PHASES) {
  const live = join(scratch, `${family}-${phase}`, 'live'), snapshot = join(scratch, `${family}-${phase}`, 'snapshot');
  run(['prepare', family, phase, live, repo, 'on', 'look']);
  await new Promise(resolveWait => setTimeout(resolveWait, 500));
  await cp(live, snapshot, { recursive: true });
  const rolledBack = run(['read', family, phase, live, older, 'off', 'act']);
  const rolledForward = run(['read', family, phase, live, repo, 'on', 'look']);
  await rm(live, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); await cp(snapshot, live, { recursive: true });
  const sameCode = run(['read', family, phase, live, repo, 'on', 'act']);
  if (phase === 'settled') for (const kind of await kindsUnder(snapshot)) kinds.add(kind);
  (evidence.families[family] ??= {})[phase] = { rolledBack, rolledForward, sameCode };
}
evidence.fileKinds = [...kinds].sort();
await writeFile(join(repo, 'docs', 'plans', 'unified-job-runtime', 's4-9-rollback-evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`wrote the evidence for ${tag} (${sha})`);
