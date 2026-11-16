/* Smart tiered test selection: Core Guardrails + Reverse-Dependency Affected Tests.
   Keeps routine development and release checks sub-minute O(changed) instead of O(total_repo_history),
   while `npm run test:fast` and `npm test` remain available for full-suite regression sweeps.
   NOTE: Keep this module free of `node:child_process` imports so fast unit tests can import it directly
   without triggering `tests/slow-tests-list.test.mjs` CLI markers. */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { repoRoot } from './test-schedule.mjs';

const CODE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/;
const IMPORT_SPEC_RE = /(?:(?:\bfrom|\bimport)\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
const LITERAL_PATH_RE = /['"`]((?:\.\.?\/|(?:ui|lib|scripts|web-demo|site|skills|docs|locale|presets)\/)[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)['"`]/g;

const GENERIC_STEMS = new Set([
  'index', 'main', 'app', 'operations', 'contracts', 'messages', 'worker', 'start', 'plan',
  'prompts', 'types', 'util', 'utils', 'helpers', 'common', 'shared', 'config', 'constants',
  'state', 'store', 'model', 'view', 'views', 'page', 'schema', 'validate', 'client', 'host',
]);

/** High-signal repo-wide architectural, CSS, i18n, security, core-loop, and release guardrails. */
export const CORE_GUARDRAIL_TESTS = Object.freeze([
  // Architecture, module graph & unified runtime invariants
  'tests/lib-graph.test.mjs',
  'tests/lib-top-level.test.mjs',
  'tests/architecture-boundaries.test.mjs',
  'tests/domain-bundle-isolation.test.mjs',
  'tests/unified-runtime-architecture.test.mjs',
  'tests/unified-runtime-boundaries.test.mjs',
  'tests/unified-runtime-acceptance-doc.test.mjs',
  'tests/instant-model-guard.test.mjs',
  // UI, CSS layer/ownership/token & bilingual localization invariants
  'tests/ui-guardrails.test.mjs',
  'tests/css-layers.test.mjs',
  'tests/css-ownership.test.mjs',
  'tests/css-token-guard.test.mjs',
  'tests/wave5a-tones.test.mjs',
  'tests/wave5b-architecture.test.mjs',
  'tests/locale-keys-used.test.mjs',
  'tests/english-ui.test.mjs',
  'tests/backend-english.test.mjs',
  'tests/wp1-i18n-fragments.test.mjs',
  // Core storage, FSRS-6 scheduling, review loop & interactive companions
  'tests/store.test.mjs',
  'tests/fsrs-scheduler.test.mjs',
  'tests/fsrs-mastery-and-safety.test.mjs',
  'tests/learning-loop.test.mjs',
  'tests/interactive-companions.test.mjs',
  'tests/archify-companion.test.mjs',
  // Release, contracts, skills, static demo, site explorer & runner invariants
  'tests/changelog-fragments.test.mjs',
  'tests/docs-links.test.mjs',
  'tests/main-chat-tools.test.mjs',
  'tests/study-skills.test.mjs',
  'tests/retrieval-extension-build.test.mjs',
  'tests/site-explorer.test.mjs',
  'tests/language-demo.test.mjs',
  'tests/demo-seed.test.mjs',
  'tests/first-run-words.test.mjs',
  'tests/slow-tests-list.test.mjs',
  'tests/test-smart.test.mjs',
]);

const ROOT_DIRS_PREFIX_RE = /^\.\/(?:ui|lib|scripts|web-demo|site|skills|docs|locale|presets|packages)\//;

function walkCodeFiles(root, relDir, out = []) {
  const absDir = join(root, relDir);
  if (!existsSync(absDir)) return out;
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = `${relDir}/${entry.name}`;
    if (rel === 'tests/fixtures') continue;
    if (entry.isDirectory()) walkCodeFiles(root, rel, out);
    else if (entry.isFile() && CODE_FILE_RE.test(entry.name) && !/^lib\/client(?:\.[A-Za-z0-9._-]+)?\.js$/.test(rel)) out.push(rel);
  }
  return out;
}

function normalizeRelPath(p) {
  return String(p || '').replaceAll('\\', '/').replace(/^\.\//, '').trim();
}

/** Extract string-literal relative/repo paths referenced inside test/helper files (e.g. `loadUi('./ui/Foo.jsx')`, `readFile('skills/...')`). */
export function extractLiteralPathRefs(sourceText, fromRelPath) {
  const refs = new Set();
  const fromDir = posix.dirname(normalizeRelPath(fromRelPath));
  for (const match of String(sourceText || '').matchAll(LITERAL_PATH_RE)) {
    const raw = match[1];
    if (ROOT_DIRS_PREFIX_RE.test(raw)) {
      refs.add(posix.normalize(raw.slice(2)));
    } else if (raw.startsWith('.')) {
      const relResolved = posix.normalize(posix.join(fromDir, raw));
      if (!relResolved.startsWith('..')) refs.add(relResolved);
    } else {
      refs.add(posix.normalize(raw));
    }
  }
  return [...refs];
}

function resolveImportTarget(spec, fromDir, knownFiles) {
  if (!spec.startsWith('.')) return '';
  const base = posix.normalize(posix.join(fromDir, spec));
  if (base.startsWith('..')) return '';
  if (knownFiles.has(base)) return base;
  for (const ext of ['.js', '.jsx', '.mjs', '.cjs', '.json']) {
    if (knownFiles.has(`${base}${ext}`)) return `${base}${ext}`;
    if (knownFiles.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  return '';
}

/** Build a mtime-cached reverse dependency map (`targetRelPath -> Set<importerRelPath>`) in ~150ms. */
export async function buildReverseDependencyGraph(root = repoRoot) {
  const dirs = ['lib', 'ui', 'scripts', 'web-demo', 'site', 'packages', 'tests'];
  const codeFiles = dirs.flatMap(dir => walkCodeFiles(root, dir)).sort();
  const knownFiles = new Set(codeFiles);
  const cachePath = join(root, 'node_modules', '.cache', 'studyhub-tests', 'reverse-graph-v1.json');

  let prevFiles = {};
  try {
    prevFiles = JSON.parse(readFileSync(cachePath, 'utf8')).files || {};
  } catch { /* cold cache */ }

  const nextFiles = {};
  let dirty = false;
  for (const rel of codeFiles) {
    const abs = join(root, rel);
    let mtimeMs = 0;
    try { mtimeMs = Math.floor(statSync(abs).mtimeMs); } catch { continue; }
    const cached = prevFiles[rel];
    if (cached && cached.mtimeMs === mtimeMs && Array.isArray(cached.deps)) {
      nextFiles[rel] = cached;
      continue;
    }
    dirty = true;
    let src = '';
    try { src = readFileSync(abs, 'utf8'); } catch { continue; }
    const fromDir = posix.dirname(rel);
    const deps = new Set();
    for (const m of src.matchAll(IMPORT_SPEC_RE)) {
      const spec = m[1] || m[2] || '';
      const resolved = resolveImportTarget(spec, fromDir, knownFiles);
      if (resolved && resolved !== rel) deps.add(resolved);
    }
    if (rel.startsWith('tests/')) {
      for (const ref of extractLiteralPathRefs(src, rel)) {
        if (ref !== rel && (knownFiles.has(ref) || existsSync(join(root, ref)))) deps.add(ref);
      }
    }
    nextFiles[rel] = { mtimeMs, deps: [...deps] };
  }

  if (dirty || Object.keys(prevFiles).length !== Object.keys(nextFiles).length) {
    try {
      mkdirSync(join(root, 'node_modules', '.cache', 'studyhub-tests'), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ files: nextFiles }), 'utf8');
    } catch { /* read-only checkout ignores cache write */ }
  }

  const reverse = new Map();
  for (const [from, entry] of Object.entries(nextFiles)) {
    for (const to of entry.deps) {
      let set = reverse.get(to);
      if (!set) { set = new Set(); reverse.set(to, set); }
      set.add(from);
    }
  }
  return reverse;
}

function stemTokenOf(relPath) {
  const base = posix.basename(relPath).replace(/\.(?:test\.)?[cm]?[jt]sx?$/i, '');
  const kebab = base.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  if (kebab.length < 4 || GENERIC_STEMS.has(kebab)) return '';
  return kebab;
}

/**
 * Deterministically select Core Guardrails + Diff-Affected Tests.
 * - `mode: 'core'` returns only existing core guardrail tests.
 * - `mode: 'smart'` returns core guardrail tests + reverse-dependency & stem-matched affected tests (bounded by `maxAffected`).
 */
export function selectSmartTests({
  mode = 'smart',
  changedPaths = [],
  allTestKeys = [],
  reverseGraph = new Map(),
  slowSet = new Set(),
  includeSlow = false,
  weights = {},
  durations = {},
  maxAffected = 75,
  hubFanInLimit = 45,
} = {}) {
  const availableTests = new Set(allTestKeys);
  const allowedAffected = key => availableTests.has(key) && (includeSlow || !slowSet.has(key));

  // Hand-curated core guardrails (including fast git/store checks) always run when present in availableTests.
  const core = CORE_GUARDRAIL_TESTS.filter(key => availableTests.has(key));
  if (mode === 'core') {
    return { selected: core, coreCount: core.length, affectedCount: 0, reasons: new Map(core.map(k => [k, 'core'])) };
  }

  const normalizedChanges = [...new Set(changedPaths.map(normalizeRelPath).filter(Boolean))];
  const candidates = new Map(); // testKey -> { priority, reason }
  const record = (testKey, priority, reason) => {
    if (!allowedAffected(testKey)) return;
    const prev = candidates.get(testKey);
    if (!prev || priority < prev.priority) candidates.set(testKey, { priority, reason });
  };

  // 1. Directly modified/added test files always get top priority (0)
  for (const path of normalizedChanges) {
    if (/^tests\/[^/]+\.test\.mjs$/.test(path)) record(path, 0, 'changed-test');
    if (path.startsWith('skills/') || path.startsWith('presets/')) {
      record('tests/study-skills.test.mjs', 1, `asset:${path}`);
      record('tests/main-chat-tools.test.mjs', 1, `asset:${path}`);
    }
    if (path.startsWith('ui/locales/')) {
      record('tests/locale-keys-used.test.mjs', 1, `locale:${path}`);
      record('tests/english-ui.test.mjs', 1, `locale:${path}`);
    }
    if (path.startsWith('docs/') || path.startsWith('README')) {
      record('tests/docs-links.test.mjs', 1, `doc:${path}`);
    }
    if (path.startsWith('changes/') || path.startsWith('CHANGELOG')) {
      record('tests/changelog-fragments.test.mjs', 1, `changelog:${path}`);
    }
  }

  // 2. Reverse-import BFS with megahub damping
  const nonTestChanges = normalizedChanges.filter(p => !/^tests\/[^/]+\.test\.mjs$/.test(p));
  const queue = nonTestChanges.map(path => ({ path, depth: 0, root: path }));
  const visitedDepth = new Map(nonTestChanges.map(path => [path, 0]));

  while (queue.length) {
    const { path, depth, root: origin } = queue.shift();
    const importers = reverseGraph.get(path);
    if (!importers || !importers.size) continue;

    // Damp propagation through universal megahubs (e.g. lib/service.js, lib/index.js, ui/i18n.js)
    // when reached transitively (depth >= 1) so leaf edits don't explode into 600 unrelated tests.
    if (depth >= 1 && importers.size > hubFanInLimit) continue;

    for (const importer of importers) {
      if (/^tests\/[^/]+\.test\.mjs$/.test(importer)) {
        // Direct importer of a megahub gets priority 3; direct importer of a specific module gets priority 1; transitive gets 2+
        const isMegaOrigin = depth === 0 && importers.size > hubFanInLimit;
        record(importer, isMegaOrigin ? 3 : Math.min(3, depth + 1), `imports:${origin}`);
        continue;
      }
      const nextDepth = depth + 1;
      if (nextDepth > 5) continue;
      const prevDepth = visitedDepth.get(importer);
      if (prevDepth !== undefined && prevDepth <= nextDepth) continue;
      visitedDepth.set(importer, nextDepth);
      queue.push({ path: importer, depth: nextDepth, root: origin });
    }
  }

  // 3. Stem-affinity matching (catches black-box StudyService tests like `lib/oral-exam.js` -> `tests/oral-exam.test.mjs`)
  const changedStems = new Set(nonTestChanges.map(stemTokenOf).filter(Boolean));
  if (changedStems.size) {
    for (const testKey of allTestKeys) {
      if (!allowedAffected(testKey)) continue;
      const testBase = posix.basename(testKey, '.test.mjs').toLowerCase();
      for (const stem of changedStems) {
        if (testBase === stem || testBase.startsWith(`${stem}-`) || testBase.endsWith(`-${stem}`) || testBase.includes(`-${stem}-`)) {
          record(testKey, 2, `stem:${stem}`);
          break;
        }
      }
    }
  }

  const coreSet = new Set(core);
  const costOf = key => durations[key] ?? weights[key] ?? 2_000;
  const affectedAll = [...candidates.entries()]
    .filter(([key, info]) => !coreSet.has(key) || info.priority === 0)
    .sort(([keyA, a], [keyB, b]) => a.priority - b.priority || costOf(keyA) - costOf(keyB) || (keyA < keyB ? -1 : 1));

  // Always keep priority-0 (directly edited test files), cap remaining auto-discovered affected tests at maxAffected
  const mustKeep = affectedAll.filter(([, info]) => info.priority === 0).map(([key]) => key);
  const extraAffected = [];
  for (const [key, info] of affectedAll) {
    if (info.priority === 0 || coreSet.has(key)) continue;
    if (extraAffected.length >= maxAffected) break;
    extraAffected.push(key);
  }

  const reasons = new Map();
  for (const key of core) reasons.set(key, candidates.get(key)?.reason || 'core');
  for (const key of mustKeep) reasons.set(key, candidates.get(key)?.reason || 'changed-test');
  for (const key of extraAffected) reasons.set(key, candidates.get(key)?.reason || 'affected');

  const selected = [...new Set([...mustKeep, ...core, ...extraAffected])];
  return {
    selected,
    coreCount: core.length,
    affectedCount: extraAffected.length + mustKeep.filter(k => !coreSet.has(k)).length,
    reasons,
  };
}
