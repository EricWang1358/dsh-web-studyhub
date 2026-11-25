#!/usr/bin/env node
/* skill-forge triage: raw export -> index -> train/holdout split -> calibration sample -> compact dossier batches for an LLM. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertIsoDate, buildDossierBlock, buildIndex, compileNoisePatterns, intOption, isMain, need, parseCli, parseRefList, readJsonl, runMain, sampleRefs,
  splitIndex, UsageError, writeJson, writeJsonl,
} from './forge-lib.mjs';

const USAGE = `Usage:
  node triage.mjs index   --workbench <dir>
  node triage.mjs split   --workbench <dir> --holdout-after YYYY-MM-DD
  node triage.mjs sample  --workbench <dir> --n 50 [--seed 1] [--from train.json]
  node triage.mjs dossier --workbench <dir> --refs <file.json | "#1,#2"> [--per-batch 10] [--max-chars 4000] [--name calib]

index    raw/prs.jsonl + raw/issues.jsonl -> index.jsonl (one line per item: dates, dirs, noise flag, friction signals and score).
         Noise patterns: release and dependency chores by default; override with {"noisePatterns": [...]} in <dir>/profile.json.
split    holdout.json = non-noise refs created after the date; train.json = the other non-noise refs.
sample   samples/calib-<n>.json: half the highest-friction items, half stratified random by month and kind (seeded, repeatable).
dossier  batches/<name>-001.md ...: compact per-item blocks (header, title, cleaned body, directory counts, top comments), each capped at --max-chars.`;

const rawItems = async workbench => {
  const prs = join(workbench, 'raw', 'prs.jsonl');
  const issues = join(workbench, 'raw', 'issues.jsonl');
  if (!existsSync(prs) && !existsSync(issues)) throw new Error(`raw data not found: ${prs} (run export-github.mjs first)`);
  return [...(await readJsonl(prs, { optional: true })), ...(await readJsonl(issues, { optional: true }))].sort((a, b) => a.number - b.number);
};

const readIndex = async workbench => {
  const path = join(workbench, 'index.jsonl');
  if (!existsSync(path)) throw new Error(`index not found: ${path} (run "triage.mjs index" first)`);
  return readJsonl(path);
};

async function profileNoise(workbench) {
  const path = join(workbench, 'profile.json');
  if (!existsSync(path)) return compileNoisePatterns();
  let profile;
  try { profile = JSON.parse(await readFile(path, 'utf8')); } catch (err) { throw new Error(`${path}: ${err.message}`); }
  if (profile.noisePatterns === undefined) return compileNoisePatterns();
  if (!Array.isArray(profile.noisePatterns)) throw new Error(`${path}: noisePatterns must be an array of regular expressions`);
  try { return compileNoisePatterns(profile.noisePatterns); } catch (err) { throw new Error(`${path}: ${err.message}`); }
}

async function runIndex(values) {
  const workbench = need(values, 'workbench');
  const index = buildIndex(await rawItems(workbench), { noisePatterns: await profileNoise(workbench) });
  await writeJsonl(join(workbench, 'index.jsonl'), index);
  console.log(`indexed ${index.length} items (${index.filter(e => e.noise).length} noise) -> ${join(workbench, 'index.jsonl')}`);
  return 0;
}

async function runSplit(values) {
  const workbench = need(values, 'workbench');
  const after = need(values, 'holdout-after');
  assertIsoDate(after);
  const { holdout, train } = splitIndex(await readIndex(workbench), after);
  await writeJson(join(workbench, 'holdout.json'), holdout);
  await writeJson(join(workbench, 'train.json'), train);
  console.log(`train ${train.length}, holdout ${holdout.length}`);
  return 0;
}

async function runSample(values) {
  const workbench = need(values, 'workbench');
  const n = intOption(values, 'n', 0);
  if (n < 1) throw new UsageError('--n is required (a positive integer)');
  const fromPath = resolve(workbench, values.from ?? 'train.json');
  if (!existsSync(fromPath)) throw new Error(`candidate list not found: ${fromPath} (run "triage.mjs split" first, or pass --from)`);
  const allowed = new Set(JSON.parse(await readFile(fromPath, 'utf8')));
  const pool = (await readIndex(workbench)).filter(e => allowed.has(e.ref) && !e.noise);
  const refs = sampleRefs(pool, n, intOption(values, 'seed', 1));
  await writeJson(join(workbench, 'samples', `calib-${n}.json`), refs);
  console.log(`sampled ${refs.length} of ${pool.length} -> samples/calib-${n}.json`);
  return 0;
}

async function refsFrom(arg) {
  if (existsSync(arg)) {
    let parsed;
    try { parsed = JSON.parse(await readFile(arg, 'utf8')); } catch (err) { throw new UsageError(`${arg}: ${err.message}`); }
    if (!Array.isArray(parsed)) throw new UsageError(`${arg}: expected a JSON array of refs`);
    return parseRefList(parsed.join(','));
  }
  return parseRefList(arg);
}

async function runDossier(values) {
  const workbench = need(values, 'workbench');
  const refs = await refsFrom(need(values, 'refs'));
  const perBatch = Math.max(1, intOption(values, 'per-batch', 10));
  const maxChars = Math.max(200, intOption(values, 'max-chars', 4000));
  const name = values.name ?? 'calib';
  const items = new Map((await rawItems(workbench)).map(i => [i.ref, i]));
  const entries = new Map((await readIndex(workbench)).map(e => [e.ref, e]));
  const missing = refs.filter(r => !items.has(r) || !entries.has(r));
  if (missing.length) throw new Error(`refs not found in the export/index: ${missing.join(' ')}`);
  await mkdir(join(workbench, 'batches'), { recursive: true });
  const batches = Math.ceil(refs.length / perBatch);
  let largest = 0;
  for (let b = 0; b < batches; b += 1) {
    const slice = refs.slice(b * perBatch, (b + 1) * perBatch);
    const blocks = slice.map(ref => buildDossierBlock(items.get(ref), entries.get(ref), maxChars));
    largest = Math.max(largest, ...blocks.map(x => x.length));
    const file = `${name}-${String(b + 1).padStart(3, '0')}.md`;
    await writeFile(join(workbench, 'batches', file), `# ${name} batch ${b + 1}/${batches} (${slice.length} items)\n\n${blocks.join('\n\n')}\n`);
  }
  console.log(`wrote ${batches} batch file(s) for ${refs.length} items to ${join(workbench, 'batches')} (largest block ${largest} chars)`);
  return 0;
}

const COMMANDS = { index: runIndex, split: runSplit, sample: runSample, dossier: runDossier };

async function main() {
  const { values, positionals } = parseCli(process.argv.slice(2), {
    workbench: { type: 'string' }, 'holdout-after': { type: 'string' }, n: { type: 'string' }, seed: { type: 'string' }, from: { type: 'string' },
    refs: { type: 'string' }, 'per-batch': { type: 'string' }, 'max-chars': { type: 'string' }, name: { type: 'string' },
  });
  const [sub] = positionals;
  if (values.help || !sub) {
    console.log(USAGE);
    return values.help ? 0 : 2;
  }
  if (!COMMANDS[sub]) throw new UsageError(`unknown subcommand "${sub}" (expected ${Object.keys(COMMANDS).join(', ')})`);
  return COMMANDS[sub](values);
}

if (isMain(import.meta.url)) await runMain(main);
