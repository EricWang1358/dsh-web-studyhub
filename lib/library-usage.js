/* How much disk a study library uses (WP16).
   The walk is asynchronous end to end: bounded concurrency, a yield to the
   event loop after every directory, symbolic links never followed, unreadable
   entries skipped, and a hard entry/time budget that returns what was counted
   with `partial: true`. Categories follow the real store layout
   (lib/store.js shards, lib/contexts/materials/files.js attachments,
   audio-batches / audio-cache / audio-uploads / live, backups). */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const USAGE_PARTS = Object.freeze([
  ['materials', '资料原文与提取文字'], ['audio', '音频与转写'], ['bank', '题库与复习记录'], ['backups', '备份'], ['other', '其他'],
]);
const FOLDERS = { attachments: 'materials', 'audio-batches': 'audio', 'audio-cache': 'audio', 'audio-uploads': 'audio', live: 'audio', backups: 'backups' };
// A library that is the project workspace itself sits beside code and tooling that is not the library.
const PROJECT_MARKERS = new Set(['.git', 'package.json', 'node_modules', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml']);
const DEFAULTS = { maxEntries: 200000, budgetMs: 8000, concurrency: 8 };
const TTL_MS = 60000;
const turn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Count the library at `root` by category.
 * @returns {Promise<{root: string, total: number, parts: {id: string, label: string, bytes: number, files: number}[], computedAt: string, partial?: boolean, paths: {backups: string}}>}
 */
export async function measureLibrary(root, { maxEntries = DEFAULTS.maxEntries, budgetMs = DEFAULTS.budgetMs, concurrency = DEFAULTS.concurrency, now = Date.now } = {}) {
  const totals = new Map(USAGE_PARTS.map(([id]) => [id, { bytes: 0, files: 0 }]));
  const started = now();
  let entries = 0, partial = false;
  const exhausted = () => {
    if (partial) return true;
    if (entries >= maxEntries || now() - started > budgetMs) partial = true;
    return partial;
  };
  const read = (path) => readdir(path, { withFileTypes: true }).catch(() => []);
  const count = async (path, category) => {
    const info = await lstat(path).catch(() => null);
    if (!info || !info.isFile()) return;
    const total = totals.get(category);
    total.bytes += info.size;
    total.files += 1;
  };

  const top = await read(root);
  const project = top.some((entry) => PROJECT_MARKERS.has(entry.name) || entry.name.endsWith('.code-workspace'));
  /** Folders still to read: [absolute path, category | 'shards']. */
  const queue = [];
  const files = [];
  for (const entry of top) {
    if (entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const known = entry.name === 'shards' ? 'shards' : FOLDERS[entry.name];
      if (known) queue.push([path, known]);
      else if (!project) queue.push([path, 'other']);
    } else if (entry.isFile()) {
      if (entry.name.startsWith('study-workspace')) files.push([path, 'bank']);
      else if (!project) files.push([path, 'other']);
    }
  }
  for (const [path, category] of files) {
    if (exhausted()) break;
    entries++;
    await count(path, category);
  }

  let active = 0;
  const worker = async () => {
    // An idle worker waits while another is still reading: that folder's children are about to arrive.
    while (!exhausted()) {
      if (!queue.length) {
        if (!active) break;
        await turn();
        continue;
      }
      const [dir, category] = queue.pop();
      active++;
      try {
        entries++;
        for (const entry of await read(dir)) {
          if (exhausted()) break;
          if (entry.isSymbolicLink()) continue;
          const path = join(dir, entry.name);
          // Source text lives in shards/sources; every other shard belongs to the question bank.
          const own = category === 'shards' ? (entry.name === 'sources' && entry.isDirectory() ? 'materials' : 'bank') : category;
          entries++;
          if (entry.isDirectory()) queue.push([path, own]);
          else if (entry.isFile()) await count(path, own);
        }
      } finally { active--; }
      await turn();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const parts = USAGE_PARTS.map(([id, label]) => ({ id, label, ...totals.get(id) }));
  return {
    root, total: parts.reduce((sum, part) => sum + part.bytes, 0), parts, computedAt: new Date().toISOString(),
    ...(partial ? { partial: true } : {}), paths: { backups: join(root, 'backups') },
  };
}

/**
 * One cache and one in-flight walk per library root. `invalidate` marks the
 * root changed: a walk that began before the change is never cached.
 */
export function createUsageService({ measure = measureLibrary, ttlMs = TTL_MS, now = Date.now } = {}) {
  const entries = new Map();
  const entryFor = (root) => {
    let entry = entries.get(root);
    if (!entry) entries.set(root, entry = { epoch: 0, value: null, at: 0, promise: null });
    return entry;
  };
  return {
    usage(root, { force = false } = {}) {
      const entry = entryFor(root);
      if (!force && entry.value && now() - entry.at < ttlMs) return Promise.resolve(entry.value);
      if (entry.promise) return entry.promise;
      const epoch = entry.epoch;
      const promise = Promise.resolve().then(() => measure(root)).then((value) => {
        if (entry.epoch === epoch) { entry.value = value; entry.at = now(); }
        return value;
      }).finally(() => { if (entry.promise === promise) entry.promise = null; });
      entry.promise = promise;
      return promise;
    },
    invalidate(root) {
      const entry = entries.get(root);
      if (!entry) return;
      entry.epoch++;
      entry.value = null;
      entry.promise = null;
    },
  };
}

export const libraryUsage = createUsageService();

/** Actions that only read; every other action may have changed the library's files. */
const READ_ONLY = /^(snapshot|inbox|export|library\.usage|audio\.files|binding\.(get|set)|panel\.[a-z.]+|board\.[a-z.]+|notebook\.(list|search))$|\.(get|list|context|search|locate|report|status|suggest)$/;
export const changesLibrary = (action) => !READ_ONLY.test(String(action));
