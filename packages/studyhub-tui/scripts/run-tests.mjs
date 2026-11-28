#!/usr/bin/env node
/**
 * Tiered test runner for StudyHub TUI:
 * 1. Ensures `dist/` is built once via SHA-256 content-hashed build cache.
 * 2. Splits test files into:
 *    - Unit/static tier: runs with `--test-concurrency = min(nproc, 8)`.
 *    - Bench tier: runs CPU-sensitive NFR suites isolated (`concurrency = 1`).
 *    - Heavy PTY/xterm E2E tier: LPT-ordered (slowest first) and runs with `--test-concurrency = 2`
 *      so heavy Ink + @xterm/headless suites do not starve CPU.
 *    - Quarantine tier: suites explicitly marked in their leading file header with
 *      `// @quarantine: <reason>` (or alias `// @flaky: <reason>`). Quarantined suites are isolated
 *      out of default runs and reported explicitly; malformed bare markers fail fast with exit 2.
 *      In GitHub Actions (`GITHUB_ACTIONS=true`) each quarantined suite also prints a `::warning::`
 *      annotation so the quarantine is visible on the PR, not only in the job log.
 *
 * Flags:
 *   --unit                 Run only the fast unit/static (+ bench) tier
 *   --e2e                  Run only the PTY/xterm E2E tier
 *   --quarantine           Run ONLY quarantined suites (isolated, concurrency=1)
 *   --include-quarantined  Run normal selected tiers PLUS quarantined suites
 *   --shard=i/n            Run LPT-balanced shard i of n (1-based)
 *   --list                 Print selected test file(s) one per line and exit without running
 *   --force                Force rebuild ignoring dist/.build-hash
 *   --timing               Print per-file wall-clock summary sorted slowest first
 *   [files...]             Run explicit test file(s) with cached build
 */
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBuilt } from './build.mjs';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const E2E_MARKER_RE = /@xterm\/headless|createVirtualTty|new Terminal\b/;
export const BENCH_FILES = new Set(['perf-budget.test.mjs', 'scale-nfr.test.mjs']);
const QUARANTINE_DIRECTIVE_RE = /^\/\/\s*@(quarantine|flaky)(?=$|[\s:])(.*)$/i;

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

export function weightForFile(fileName) {
  for (const [prefix, w] of HEAVY_PREFIX_WEIGHTS) {
    if (fileName.startsWith(prefix)) return w;
  }
  return 30;
}

export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const index = Number(match[1]);
  const count = Number(match[2]);
  return count >= 1 && count <= 64 && index >= 1 && index <= count ? { index, count } : null;
}

/**
 * Parse a leading header quarantine marker (`// @quarantine: <reason>` or `// @flaky: <reason>`).
 * Only contiguous leading `//` comments (after optional shebang / blank lines) are scanned, so
 * occurrences inside code or test fixtures never trigger false positives.
 * A bare marker without a non-empty reason is rejected as `malformed: true`.
 */
export function parseQuarantineMarker(content) {
  const lines = String(content ?? '').split(/\r?\n/);
  let validMatch = null;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (i === 0 && trimmed.startsWith('#!')) continue;
    if (trimmed === '') continue;
    if (!trimmed.startsWith('//')) break;
    const match = QUARANTINE_DIRECTIVE_RE.exec(trimmed);
    if (!match) continue;
    const tag = match[1].toLowerCase();
    const tail = match[2] ?? '';
    const reason = tail.replace(/^\s*:\s*/, '').trim();
    if (!reason) {
      return {
        quarantined: false,
        malformed: true,
        tag,
        reason: null,
        line: i + 1,
        error: `Malformed @${tag} marker on line ${i + 1}: must provide a non-empty reason (e.g. // @${tag}: <reason>)`,
      };
    }
    if (!validMatch) {
      validMatch = {
        quarantined: true,
        malformed: false,
        tag,
        reason,
        line: i + 1,
        error: null,
      };
    }
  }
  return validMatch ?? {
    quarantined: false,
    malformed: false,
    tag: null,
    reason: null,
    line: null,
    error: null,
  };
}

export function parseRunnerArgs(argv, env = process.env) {
  const forceBuild = argv.includes('--force') || env.STUDYHUB_FORCE_BUILD === '1';
  const unitOnly = argv.includes('--unit');
  const e2eOnly = argv.includes('--e2e');
  const quarantineOnly = argv.includes('--quarantine');
  const includeQuarantined = argv.includes('--include-quarantined');
  const showTiming = argv.includes('--timing');
  const listOnly = argv.includes('--list');
  const passThrough = [];
  const explicitFiles = [];
  let shardSpec = null;
  let shardError = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (
      arg === '--force' ||
      arg === '--unit' ||
      arg === '--e2e' ||
      arg === '--quarantine' ||
      arg === '--include-quarantined' ||
      arg === '--timing' ||
      arg === '--list'
    ) {
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

  let error = null;
  if (shardError) {
    error = '--shard needs index/count (1 <= index <= count <= 64)';
  } else if (unitOnly && e2eOnly) {
    error = '--unit and --e2e cannot be combined';
  } else if (quarantineOnly && includeQuarantined) {
    error = '--quarantine and --include-quarantined cannot be combined';
  }

  return {
    forceBuild,
    unitOnly,
    e2eOnly,
    quarantineOnly,
    includeQuarantined,
    showTiming,
    listOnly,
    passThrough,
    explicitFiles,
    shardSpec,
    error,
  };
}

export function shardEntriesLpt(items, { index, count }) {
  const loads = Array.from({ length: count }, () => 0);
  const shards = loads.map(() => []);
  const nameOf = (item) => (typeof item === 'string' ? item : item.name);
  const sorted = [...items].sort(
    (a, b) =>
      weightForFile(nameOf(b)) - weightForFile(nameOf(a)) ||
      (nameOf(a) < nameOf(b) ? -1 : nameOf(a) > nameOf(b) ? 1 : 0),
  );
  for (const item of sorted) {
    const at = loads.indexOf(Math.min(...loads));
    loads[at] += weightForFile(nameOf(item));
    shards[at].push(item);
  }
  return shards[index - 1];
}

function formatTestPath(baseRoot, fullPath) {
  const rel = relative(baseRoot, fullPath).replace(/\\/g, '/');
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return fullPath;
  }
  return rel;
}

export async function classifyTestFiles(dir, { baseRoot = pkgRoot } = {}) {
  const allEntries = (await readdir(dir))
    .filter((name) => name.endsWith('.test.mjs'))
    .sort();

  const activeFiles = [];
  const quarantinedFiles = [];
  const malformedMarkers = [];

  for (const name of allEntries) {
    const full = join(dir, name);
    const rel = formatTestPath(baseRoot, full);
    const content = await readFile(full, 'utf8');
    const marker = parseQuarantineMarker(content);
    if (marker.malformed) {
      malformedMarkers.push({ name, rel, ...marker });
      continue;
    }
    const baseTier = BENCH_FILES.has(name)
      ? 'bench'
      : E2E_MARKER_RE.test(content)
        ? 'e2e'
        : 'unit';
    const record = {
      name,
      rel,
      baseTier,
      weight: weightForFile(name),
      quarantine: marker.quarantined ? marker : null,
    };
    if (marker.quarantined) {
      quarantinedFiles.push(record);
    } else {
      activeFiles.push(record);
    }
  }

  return { totalDiscovered: allEntries.length, activeFiles, quarantinedFiles, malformedMarkers };
}

/** Escape a GitHub Actions workflow-command message (`::warning ...::<message>`). */
function escapeWorkflowData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * One GitHub Actions `::warning::` annotation per quarantined suite, so a quarantine shows up on the PR
 * (the Checks summary and the changed-files view) instead of only inside the job log.
 * Returns `[]` outside GitHub Actions (`GITHUB_ACTIONS !== 'true'`) or when nothing is quarantined,
 * so local runs and `--list` output stay unchanged.
 */
export function quarantineWarningAnnotations(quarantinedFiles, env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') return [];
  return quarantinedFiles.map((f) => {
    const message = escapeWorkflowData(
      `${f.rel} is quarantined (@${f.quarantine.tag}: ${f.quarantine.reason}). Fix it and remove the marker (see docs/flaky-tests.md).`,
    );
    return `::warning title=Quarantined TUI test suite::${message}`;
  });
}

function matchesTierFilter(record, { unitOnly, e2eOnly }) {
  if (unitOnly) return record.baseTier !== 'e2e';
  if (e2eOnly) return record.baseTier === 'e2e';
  return true;
}

export function selectTestPlan(classified, options) {
  const { unitOnly, e2eOnly, quarantineOnly, includeQuarantined, shardSpec } = options;

  const sortByLpt = (list) =>
    [...list].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name));

  if (quarantineOnly) {
    const eligible = classified.quarantinedFiles.filter((f) => matchesTierFilter(f, { unitOnly, e2eOnly }));
    const sharded = shardSpec ? shardEntriesLpt(eligible, shardSpec) : eligible;
    return {
      unitFiles: [],
      benchFiles: [],
      e2eFiles: [],
      quarantineFiles: sortByLpt(sharded),
      skippedQuarantined: [],
      selectedTotal: sharded.length,
    };
  }

  const pool = includeQuarantined
    ? [...classified.activeFiles, ...classified.quarantinedFiles]
    : [...classified.activeFiles];
  const shardedPool = shardSpec ? shardEntriesLpt(pool, shardSpec) : pool;

  const unitFiles = [];
  const benchFiles = [];
  const e2eFiles = [];
  const quarantineFiles = [];

  for (const record of shardedPool) {
    if (!matchesTierFilter(record, { unitOnly, e2eOnly })) continue;
    if (record.quarantine) {
      quarantineFiles.push(record);
    } else if (record.baseTier === 'bench') {
      benchFiles.push(record);
    } else if (record.baseTier === 'e2e') {
      e2eFiles.push(record);
    } else {
      unitFiles.push(record);
    }
  }

  const skippedQuarantined = includeQuarantined
    ? []
    : classified.quarantinedFiles.filter((f) => matchesTierFilter(f, { unitOnly, e2eOnly }));

  return {
    unitFiles: sortByLpt(unitFiles),
    benchFiles: benchFiles.sort((a, b) => a.name.localeCompare(b.name)),
    e2eFiles: sortByLpt(e2eFiles),
    quarantineFiles: sortByLpt(quarantineFiles),
    skippedQuarantined,
    selectedTotal: unitFiles.length + benchFiles.length + e2eFiles.length + quarantineFiles.length,
  };
}

function runNodeTest(files, concurrency, passThrough) {
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

async function runWithTiming(files, concurrency, passThrough) {
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

async function main() {
  const options = parseRunnerArgs(process.argv.slice(2), process.env);
  if (options.error) {
    console.error(options.error);
    process.exit(2);
  }

  const testsDir = process.env.STUDYHUB_TESTS_DIR
    ? resolve(process.env.STUDYHUB_TESTS_DIR)
    : resolve(pkgRoot, 'tests');

  const totalStart = performance.now();
  if (!options.listOnly) {
    await ensureBuilt({ force: options.forceBuild });
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

  if (options.explicitFiles.length > 0) {
    if (options.listOnly) {
      for (const f of options.explicitFiles) console.log(f);
      process.exit(0);
    }
    const code = await runNodeTest(
      options.explicitFiles,
      Math.min(unitConcurrency, options.explicitFiles.length),
      options.passThrough,
    );
    process.exit(code);
  }

  const classified = await classifyTestFiles(testsDir, { baseRoot: pkgRoot });
  if (classified.malformedMarkers.length > 0) {
    for (const bad of classified.malformedMarkers) {
      console.error(`[tier:quarantine] ${bad.rel}:${bad.line} — ${bad.error}`);
    }
    process.exit(2);
  }

  const plan = selectTestPlan(classified, options);

  if (options.listOnly) {
    const selected = [
      ...plan.unitFiles,
      ...plan.benchFiles,
      ...plan.e2eFiles,
      ...plan.quarantineFiles,
    ];
    for (const f of selected) {
      console.log(f.rel);
    }
    process.exit(0);
  }

  // Quarantined suites (isolated or run) must be visible on the PR in GitHub Actions, not only in the job log.
  for (const line of quarantineWarningAnnotations(
    [...plan.quarantineFiles, ...plan.skippedQuarantined],
    process.env,
  )) {
    console.log(line);
  }

  const allTimings = [];
  const tierResults = [];
  let overallExit = 0;

  if (plan.unitFiles.length > 0) {
    const t0 = performance.now();
    const rels = plan.unitFiles.map((f) => f.rel);
    console.log(`\n[tier:unit] Running ${rels.length} unit/static suites (concurrency=${unitConcurrency})...`);
    let tierCode = 0;
    if (options.showTiming) {
      const { exitCode, results } = await runWithTiming(rels, unitConcurrency, options.passThrough);
      allTimings.push(...results.map((r) => ({ ...r, tier: 'unit' })));
      tierCode = exitCode;
    } else {
      tierCode = await runNodeTest(rels, unitConcurrency, options.passThrough);
    }
    if (tierCode !== 0) overallExit = tierCode;
    tierResults.push({ tier: 'unit', count: rels.length, code: tierCode });
    console.log(`[tier:unit] Finished in ${((performance.now() - t0) / 1000).toFixed(2)}s (${tierCode === 0 ? 'PASS' : 'FAIL'})`);
  }

  // Run CPU-sensitive microbenchmark budget suites isolated (concurrency=1) to prevent parallel CPU jitter.
  // Always continue into remaining tiers so failures in earlier tiers never hide later tier results (#1343).
  if (plan.benchFiles.length > 0) {
    const t0 = performance.now();
    const rels = plan.benchFiles.map((f) => f.rel);
    console.log(`\n[tier:bench] Running ${rels.length} NFR perf/scale budget suites (isolated, concurrency=1)...`);
    let tierCode = 0;
    if (options.showTiming) {
      const { exitCode, results } = await runWithTiming(rels, 1, options.passThrough);
      allTimings.push(...results.map((r) => ({ ...r, tier: 'bench' })));
      tierCode = exitCode;
    } else {
      tierCode = await runNodeTest(rels, 1, options.passThrough);
    }
    if (tierCode !== 0) overallExit = tierCode;
    tierResults.push({ tier: 'bench', count: rels.length, code: tierCode });
    console.log(`[tier:bench] Finished in ${((performance.now() - t0) / 1000).toFixed(2)}s (${tierCode === 0 ? 'PASS' : 'FAIL'})`);
  }

  if (plan.e2eFiles.length > 0) {
    const t0 = performance.now();
    const rels = plan.e2eFiles.map((f) => f.rel);
    console.log(`\n[tier:e2e] Running ${rels.length} PTY/xterm E2E suites (concurrency=${e2eConcurrency})...`);
    let tierCode = 0;
    if (options.showTiming) {
      const { exitCode, results } = await runWithTiming(rels, e2eConcurrency, options.passThrough);
      allTimings.push(...results.map((r) => ({ ...r, tier: 'e2e' })));
      tierCode = exitCode;
    } else {
      tierCode = await runNodeTest(rels, e2eConcurrency, options.passThrough);
    }
    if (tierCode !== 0) overallExit = tierCode;
    tierResults.push({ tier: 'e2e', count: rels.length, code: tierCode });
    console.log(`[tier:e2e] Finished in ${((performance.now() - t0) / 1000).toFixed(2)}s (${tierCode === 0 ? 'PASS' : 'FAIL'})`);
  }

  if (plan.quarantineFiles.length > 0) {
    const t0 = performance.now();
    const rels = plan.quarantineFiles.map((f) => f.rel);
    console.log(`\n[tier:quarantine] Running ${rels.length} quarantined suite(s) (isolated, concurrency=1)...`);
    for (const f of plan.quarantineFiles) {
      console.log(`  - ${f.rel} (@${f.quarantine.tag}: ${f.quarantine.reason})`);
    }
    let tierCode = 0;
    if (options.showTiming) {
      const { exitCode, results } = await runWithTiming(rels, 1, options.passThrough);
      allTimings.push(...results.map((r) => ({ ...r, tier: 'quarantine' })));
      tierCode = exitCode;
    } else {
      tierCode = await runNodeTest(rels, 1, options.passThrough);
    }
    if (tierCode !== 0) overallExit = tierCode;
    tierResults.push({ tier: 'quarantine', count: rels.length, code: tierCode });
    console.log(`[tier:quarantine] Finished in ${((performance.now() - t0) / 1000).toFixed(2)}s (${tierCode === 0 ? 'PASS' : 'FAIL'})`);
  } else if (options.quarantineOnly) {
    console.log('\n[tier:quarantine] No quarantined suites matched.');
  }

  if (plan.skippedQuarantined.length > 0) {
    console.log(
      `\n[tier:quarantine] Isolated ${plan.skippedQuarantined.length} quarantined suite(s) (pass --quarantine or --include-quarantined to run):`,
    );
    for (const f of plan.skippedQuarantined) {
      console.log(`  - ${f.rel} (@${f.quarantine.tag}: ${f.quarantine.reason})`);
    }
  }

  const totalSec = ((performance.now() - totalStart) / 1000).toFixed(2);
  const tierSummary = tierResults.map((r) => `${r.tier}:${r.code === 0 ? 'PASS' : 'FAIL'}(${r.count})`).join(' | ');
  const quarantineSummary = plan.quarantineFiles.length > 0
    ? ` + ${plan.quarantineFiles.length} quarantine`
    : plan.skippedQuarantined.length > 0
      ? ` (${plan.skippedQuarantined.length} quarantined isolated)`
      : '';
  console.log(
    `\n[studyhub-tui] Total test wall time: ${totalSec}s (${plan.unitFiles.length} unit + ${plan.benchFiles.length} bench + ${plan.e2eFiles.length} e2e${quarantineSummary} = ${plan.selectedTotal} files) [${tierSummary}]`,
  );

  if (options.showTiming && allTimings.length > 0) {
    allTimings.sort((a, b) => b.ms - a.ms);
    console.log('\n=== Per-File Wall Timings (Top 25) ===');
    for (const r of allTimings.slice(0, 25)) {
      console.log(`${String(r.ms).padStart(7)} ms | ${r.tier.padEnd(10)} | ${r.file}`);
    }
  }

  process.exit(overallExit);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
