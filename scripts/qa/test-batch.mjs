/* Packs side-effect-free test files into shared batch entrypoints so `run()` from node:test does not pay a cold Node + esbuild
   startup for every small file. Files that touch process.env, globals, root hooks, mocks, timers, process listeners, or the slow
   list stay in their own isolated processes. */
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from './test-schedule.mjs';

const HEAVY_FILE_MS = 10_000;
const DEFAULT_BATCH_SIZE = 14;
const WRAPPER_SUFFIX_RE = /\.(?:runtime|parallel|restart)\.test\.mjs$/;
const RELATIVE_IMPORT_RE = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
const CODE_FILE_RE = /\.[cm]?jsx?$/;

const SIDE_EFFECT_PATTERNS = [
  /process\.env(?:\.[A-Za-z0-9_$]+|\[[^\]]+\])\s*(?:\?\?=|\|\|=|&&=|=(?!=))|delete\s+process\.env\b|Object\.(?:assign|defineProperty)\(\s*process\.env\b/,
  /(?<![.\w$])(?:beforeEach|afterEach|before|after)\s*\(|test\.(?:beforeEach|afterEach|before|after)\s*\(/,
  /(?<![.\w$])(?:globalThis|global|window|document|localStorage|sessionStorage|navigator)(?:\.[A-Za-z0-9_$]+|\[[^\]]+\])?\s*(?:\?\?=|\|\|=|&&=|=(?!=))|delete\s+(?:globalThis|global|window|document|localStorage|sessionStorage|navigator)\b|Object\.(?:assign|defineProperty)\(\s*(?:globalThis|global|process|window|navigator|document)\b|Date\.now\s*=(?!=)|Math\.random\s*=(?!=)/,
  /^(?:const|let|var)\s+[^\n]*\b(?:Date\.now\s*\(|new\s+Date\s*\(\s*\))/m,
  /\bmock\.(?:timers|method)\b/,
  /\bprocess\.(?:chdir|exit|on|once|prependListener)\s*\(|\bsetInterval\s*\(|await\s+import\(\s*['"]\.\/[^'"]+\.test\.mjs['"]\s*\)/,
  /['"]\.\.?\/(?:\.\.\/)*lib\/(?:service|host|runtime\/builtins)\.js['"]/,
  /['"]node:(?:http|https|net|tls|dgram|worker_threads|child_process|cluster)['"]/,
];

/** Whether a test file (or any relative test helper it imports) mutates process/global state that requires its own process. */
export function hasGlobalSideEffects(absFile, { suiteRoot, cache = new Map(), seen = new Set() } = {}) {
  const file = resolve(absFile);
  if (seen.has(file)) return false;
  seen.add(file);
  if (cache.has(file)) return cache.get(file);
  let src = '';
  try { src = readFileSync(file, 'utf8'); } catch { cache.set(file, true); return true; }
  if (SIDE_EFFECT_PATTERNS.some(pattern => pattern.test(src))) {
    cache.set(file, true);
    return true;
  }
  const testsPrefix = join(repoRoot, 'tests') + sep;
  const suitePrefix = suiteRoot ? resolve(suiteRoot) + sep : '';
  const dir = dirname(file);
  for (const match of src.matchAll(RELATIVE_IMPORT_RE)) {
    const target = resolve(dir, match[1]);
    if (!CODE_FILE_RE.test(target) || !existsSync(target)) continue;
    if ((target.startsWith(testsPrefix) || (suitePrefix && target.startsWith(suitePrefix)))
      && hasGlobalSideEffects(target, { suiteRoot, cache, seen })) {
      cache.set(file, true);
      return true;
    }
  }
  cache.set(file, false);
  return false;
}

function renderBatchSource(bucket) {
  const lines = [
    "import test from 'node:test';",
    'const __keepGlobals = new Set(Object.getOwnPropertyNames(globalThis));',
    'const __cleanGlobals = () => {',
    '  for (const name of Object.getOwnPropertyNames(globalThis)) {',
    '    if (!__keepGlobals.has(name)) { try { delete globalThis[name]; } catch {} }',
    '  }',
    '};',
  ];
  for (const { abs, key } of bucket) {
    const href = pathToFileURL(abs).href;
    lines.push(
      `try { __cleanGlobals(); globalThis.__studyCurrentTestFile = ${JSON.stringify(abs)}; await import(${JSON.stringify(href)}); }`
      + ` catch (error) { test(${JSON.stringify(key)}, () => { throw error; }); }`
      + ' finally { delete globalThis.__studyCurrentTestFile; __cleanGlobals(); }',
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Groups clean test files into balanced temporary batch files while keeping heavy/side-effectful files isolated. */
export async function planBatches(files, { keyOf, timings = {}, weights = {}, slow = new Set(), suiteRoot, concurrency } = {}) {
  const mode = process.env.STUDY_TEST_BATCH;
  const empty = () => ({ runFiles: files, batchMembers: new Map(), memberBatch: new Map(), cleanup: async () => {} });
  if (mode === '0' || files.length < 2) return empty();

  const cache = new Map(), clean = [], isolated = [];
  for (const [order, rawFile] of files.entries()) {
    const abs = resolve(rawFile), key = keyOf(abs);
    const untimed = !Number.isFinite(timings[key]);
    const ms = untimed ? 0 : timings[key];
    const heavy = (Number.isFinite(weights[key]) && weights[key] >= HEAVY_FILE_MS) || (!untimed && ms >= HEAVY_FILE_MS);
    const batchable = !slow.has(key) && !heavy && !WRAPPER_SUFFIX_RE.test(key) && !hasGlobalSideEffects(abs, { suiteRoot, cache });
    (batchable ? clean : isolated).push({ abs, key, untimed, ms, order });
  }

  const minClean = mode === '1' ? 2 : Math.max(8, (concurrency || 2) * 2);
  if (clean.length < minClean) return empty();

  const customSize = Number(process.env.STUDY_TEST_BATCH_SIZE);
  const targetSize = customSize >= 2 ? Math.floor(customSize) : DEFAULT_BATCH_SIZE;
  const batchCount = customSize >= 2
    ? Math.max(1, Math.ceil(clean.length / targetSize))
    : Math.min(clean.length, Math.max(Math.ceil(clean.length / targetSize), (concurrency || 2) * 2));

  const timedCosts = clean.filter(item => !item.untimed).map(item => item.ms).sort((a, b) => a - b);
  const fallbackCost = timedCosts.length ? timedCosts[Math.floor(timedCosts.length / 2)] : 500;
  const loads = Array.from({ length: batchCount }, () => 0);
  const buckets = Array.from({ length: batchCount }, () => []);
  for (const item of clean) {
    const at = batchCount === 1 ? 0 : loads.indexOf(Math.min(...loads));
    loads[at] += item.untimed ? fallbackCost : item.ms;
    buckets[at].push(item);
  }

  const dir = await mkdtemp(join(tmpdir(), 'study-batch-'));
  try {
    const batchMembers = new Map(), memberBatch = new Map(), scheduled = [];
    for (const item of isolated) scheduled.push({ file: item.abs, untimed: item.untimed, ms: item.ms, order: item.order });
    for (const [i, bucket] of buckets.entries()) {
      if (!bucket.length) continue;
      const batchFile = resolve(dir, `batch-${i + 1}.test.mjs`);
      await writeFile(batchFile, renderBatchSource(bucket), 'utf8');
      const members = bucket.map(item => item.abs);
      batchMembers.set(batchFile, members);
      for (const member of members) memberBatch.set(member, batchFile);
      scheduled.push({ file: batchFile, untimed: bucket.some(item => item.untimed), ms: loads[i], order: bucket[0].order });
    }
    scheduled.sort((a, b) => Number(b.untimed) - Number(a.untimed) || b.ms - a.ms || a.order - b.order);
    return {
      runFiles: scheduled.map(entry => entry.file),
      batchMembers,
      memberBatch,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
