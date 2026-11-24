#!/usr/bin/env node
/**
 * Tiered test runner for StudyHub TUI:
 * 1. Ensures `dist/` is built once via SHA-256 content-hashed build cache.
 * 2. Splits test files into:
 *    - Unit/static tier: runs with `--test-concurrency = min(nproc, 8)`.
 *    - Heavy PTY/xterm E2E tier: LPT-ordered (slowest first) and runs with `--test-concurrency = 2`
 *      so heavy Ink + @xterm/headless suites do not starve CPU.
 *
 * Flags:
 *   --unit         Run only the fast unit/static tier
 *   --e2e          Run only the PTY/xterm E2E tier
 *   --shard=i/n    Run LPT-balanced shard i of n (1-based)
 *   --list         Print selected test file(s) one per line and exit without running
 *   --force        Force rebuild ignoring dist/.build-hash
 *   --timing       Print per-file wall-clock summary sorted slowest first
 *   [files...]     Run explicit test file(s) with cached build
 */
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBuilt } from './build.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = resolve(pkgRoot, 'tests');

function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const index = Number(match[1]);
  const count = Number(match[2]);
  return count >= 1 && count <= 64 && index >= 1 && index <= count ? { index, count } : null;
}

const argv = process.argv.slice(2);
const forceBuild = argv.includes('--force') || process.env.STUDYHUB_FORCE_BUILD === '1';
const unitOnly = argv.includes('--unit');
const e2eOnly = argv.includes('--e2e');
const showTiming = argv.includes('--timing');
const listOnly = argv.includes('--list');
const passThrough = [];
const explicitFiles = [];
let shardSpec = null;
let shardError = false;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--force' || arg === '--unit' || arg === '--e2e' || arg === '--timing' || arg === '--list') {
    continue;
  }
  if (arg === '--shard') {
    const val = argv[i + 1];
    i += 1;
    shardSpec = parseShard(val);
    if (!shardSpec) shardError = true;
    continue;
  }
  if (arg.startsWith('--shard=')) {
    shardSpec = parseShard(arg.slice('--shard='.length));
    if (!shardSpec) shardError = true;
    continue;
  }
  if (arg.startsWith('-')) {
    passThrough.push(arg);
  } else {
    explicitFiles.push(arg);
  }
}

if (shardError) {
  console.error('--shard needs index/count (1 <= index <= count <= 64)');
  process.exit(2);
}

const E2E_MARKER_RE = /@xterm\/headless|createVirtualTty|new Terminal\b/;
const BENCH_FILES = new Set(['perf-budget.test.mjs', 'scale-nfr.test.mjs']);

// Approximate relative LPT weights so the heaviest E2E suites start first (minimizes tail latency).
const HEAVY_PREFIX_WEIGHTS = [
  ['cli-commands', 100],
  ['host', 80],
  ['p2-quota-audit', 70],
  ['resilience', 65],
  ['packaging-smoke', 100],
  ['xterm-e2e', 95],
  ['responsive-audit', 90],
  ['ascii-full-sweep', 85],
  ['core-views-e2e', 80],
  ['pr1297-', 75],
  ['legacy-rounds-', 70],
  ['domain-library-decks', 68],
  ['domain-tasks-audio', 66],
  ['domain-book', 64],
  ['domain-reader', 62],
  ['domain-notes-board', 60],
  ['domain-examcoach', 58],
  ['domain-sources', 56],
  ['domain-settings', 54],
  ['domain-generate-drafts', 52],
  ['domain-review', 50],
];

function weightForFile(fileName) {
  for (const [prefix, w] of HEAVY_PREFIX_WEIGHTS) {
    if (fileName.startsWith(prefix)) return w;
  }
  return 30;
}

function runNodeTest(files, concurrency) {
  return new Promise((resolvePromise, reject) => {
    const args = ['--test', `--test-concurrency=${concurrency}`, ...passThrough, ...files];
    const child = spawn(process.execPath, args, {
      cwd: pkgRoot,
      stdio: 'inherit',
      env: process.env,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) resolvePromise(128);
      else resolvePromise(code ?? 1);
    });
  });
}

async function runWithTiming(files, concurrency) {
  const results = [];
  let idx = 0;
  let failed = 0;
  const worker = async () => {
    while (idx < files.length) {
      const file = files[idx++];
      const t0 = performance.now();
      const code = await new Promise((res, rej) => {
        const child = spawn(process.execPath, ['--test', ...passThrough, file], {
          cwd: pkgRoot,
          stdio: 'inherit',
          env: process.env,
        });
        child.once('error', rej);
        child.once('close', (c, sig) => res(sig ? 128 : (c ?? 1)));
      });
      const ms = Math.round(performance.now() - t0);
      results.push({ file, ms, code });
      if (code !== 0) failed += 1;
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, files.length)) }, () => worker());
  await Promise.all(workers);
  return { exitCode: failed > 0 ? 1 : 0, results };
}

function shardEntriesLpt(fileNames, { index, count }) {
  const loads = Array.from({ length: count }, () => 0);
  const shards = loads.map(() => []);
  const sorted = [...fileNames].sort(
    (a, b) => weightForFile(b) - weightForFile(a) || (a < b ? -1 : a > b ? 1 : 0),
  );
  for (const name of sorted) {
    const at = loads.indexOf(Math.min(...loads));
    loads[at] += weightForFile(name);
    shards[at].push(name);
  }
  return shards[index - 1];
}

const totalStart = performance.now();
if (!listOnly) {
  await ensureBuilt({ force: forceBuild });
}

const cores = typeof availableParallelism === 'function' ? availableParallelism() : 4;
const unitConcurrency = Math.max(
  1,
  Number(process.env.STUDYHUB_UNIT_CONCURRENCY) || Math.min(cores, 8),
);
const e2eConcurrency = Math.max(
  1,
  Number(process.env.STUDYHUB_E2E_CONCURRENCY) || Math.min(2, cores),
);

if (explicitFiles.length > 0) {
  if (listOnly) {
    for (const f of explicitFiles) console.log(f);
    process.exit(0);
  }
  const code = await runNodeTest(explicitFiles, Math.min(unitConcurrency, explicitFiles.length));
  process.exit(code);
}

const allEntries = (await readdir(testsDir))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();
const entries = shardSpec ? shardEntriesLpt(allEntries, shardSpec) : allEntries;

const unitFiles = [];
const benchFiles = [];
const e2eFiles = [];

for (const name of entries) {
  const full = join(testsDir, name);
  const rel = relative(pkgRoot, full).replace(/\\/g, '/');
  if (BENCH_FILES.has(name)) {
    benchFiles.push({ name, rel });
    continue;
  }
  const content = await readFile(full, 'utf8');
  if (E2E_MARKER_RE.test(content)) {
    e2eFiles.push({ name, rel, weight: weightForFile(name) });
  } else {
    unitFiles.push({ name, rel });
  }
}

// LPT schedule: start longest suites first in both tiers so the last worker finishes smoothly.
unitFiles.sort((a, b) => weightForFile(b.name) - weightForFile(a.name) || a.name.localeCompare(b.name));
e2eFiles.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));

if (listOnly) {
  const selected = [
    ...(!e2eOnly ? unitFiles : []),
    ...(!e2eOnly ? benchFiles : []),
    ...(!unitOnly ? e2eFiles : []),
  ];
  for (const f of selected) {
    console.log(f.rel);
  }
  process.exit(0);
}

const allTimings = [];
const tierResults = [];
let overallExit = 0;

if (!e2eOnly && unitFiles.length > 0) {
  const t0 = performance.now();
  const rels = unitFiles.map((f) => f.rel);
  console.log(`\n[tier:unit] Running ${rels.length} unit/static suites (concurrency=${unitConcurrency})...`);
  let tierCode = 0;
  if (showTiming) {
    const { exitCode, results } = await runWithTiming(rels, unitConcurrency);
    allTimings.push(...results.map((r) => ({ ...r, tier: 'unit' })));
    tierCode = exitCode;
  } else {
    tierCode = await runNodeTest(rels, unitConcurrency);
  }
  if (tierCode !== 0) overallExit = tierCode;
  tierResults.push({ tier: 'unit', count: rels.length, code: tierCode });
  console.log(`[tier:unit] Finished in ${((performance.now() - t0) / 1000).toFixed(2)}s (${tierCode === 0 ? 'PASS' : 'FAIL'})`);
}

// Run CPU-sensitive microbenchmark budget suites isolated (concurrency=1) to prevent parallel CPU jitter.
// Always continue into remaining tiers so failures in earlier tiers never hide later tier results (#1343).
if (!e2eOnly && benchFiles.length > 0) {
  const t0 = performance.now();
  const rels = benchFiles.map((f) => f.rel);
  console.log(`\n[tier:bench] Running ${rels.length} NFR perf/scale budget suites (isolated, concurrency=1)...`);
  let tierCode = 0;
  if (showTiming) {
    const { exitCode, results } = await runWithTiming(rels, 1);
    allTimings.push(...results.map((r) => ({ ...r, tier: 'bench' })));
    tierCode = exitCode;
  } else {
    tierCode = await runNodeTest(rels, 1);
  }
  if (tierCode !== 0) overallExit = tierCode;
  tierResults.push({ tier: 'bench', count: rels.length, code: tierCode });
  console.log(`[tier:bench] Finished in ${((performance.now() - t0) / 1000).toFixed(2)}s (${tierCode === 0 ? 'PASS' : 'FAIL'})`);
}

if (!unitOnly && e2eFiles.length > 0) {
  const t0 = performance.now();
  const rels = e2eFiles.map((f) => f.rel);
  console.log(`\n[tier:e2e] Running ${rels.length} PTY/xterm E2E suites (concurrency=${e2eConcurrency})...`);
  let tierCode = 0;
  if (showTiming) {
    const { exitCode, results } = await runWithTiming(rels, e2eConcurrency);
    allTimings.push(...results.map((r) => ({ ...r, tier: 'e2e' })));
    tierCode = exitCode;
  } else {
    tierCode = await runNodeTest(rels, e2eConcurrency);
  }
  if (tierCode !== 0) overallExit = tierCode;
  tierResults.push({ tier: 'e2e', count: rels.length, code: tierCode });
  console.log(`[tier:e2e] Finished in ${((performance.now() - t0) / 1000).toFixed(2)}s (${tierCode === 0 ? 'PASS' : 'FAIL'})`);
}

const totalSec = ((performance.now() - totalStart) / 1000).toFixed(2);
const tierSummary = tierResults.map((r) => `${r.tier}:${r.code === 0 ? 'PASS' : 'FAIL'}(${r.count})`).join(' | ');
console.log(`\n[studyhub-tui] Total test wall time: ${totalSec}s (${unitFiles.length} unit + ${benchFiles.length} bench + ${e2eFiles.length} e2e = ${entries.length} files) [${tierSummary}]`);

if (showTiming && allTimings.length > 0) {
  allTimings.sort((a, b) => b.ms - a.ms);
  console.log('\n=== Per-File Wall Timings (Top 25) ===');
  for (const r of allTimings.slice(0, 25)) {
    console.log(`${String(r.ms).padStart(7)} ms | ${r.tier.padEnd(4)} | ${r.file}`);
  }
}

process.exit(overallExit);
