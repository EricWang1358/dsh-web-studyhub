import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from '../../atomic-json.js';
import { canonicalPathKey } from '../../store-lock.js';
import { parseStoredJson } from '../../util.js';

export const DAILY_RESTORE_POINTS = 7;
export const WEEKLY_RESTORE_POINTS = 4;
export const RESTORE_POINT_RETENTION = Object.freeze({
  daily: DAILY_RESTORE_POINTS,
  weekly: WEEKLY_RESTORE_POINTS,
});
export const RESTORE_POINTS_DIR = 'restore-points';
export const RESTORE_POINT_FORMAT = 'study-restore-point/v1';

const EMPTY_SET = Object.freeze(new Set());
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

const lastProtectedByRoot = new Map();
const pendingReleasedByRoot = new Map();

export function localDayKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return null;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function dayIndex(day) {
  if (typeof day !== 'string') return null;
  const match = DAY_RE.exec(day);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const utc = Date.UTC(year, month - 1, date);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  return Math.floor(utc / 86_400_000);
}

export const validRestorePointId = (id) => dayIndex(id) !== null;

/** Monday-anchored calendar week index (1970-01-01 was Thursday = offset +3). */
const weekBucket = (day) => {
  const idx = dayIndex(day);
  return idx === null ? null : Math.floor((idx + 3) / 7);
};

/**
 * Partition `YYYY-MM-DD` restore point dates into up to `daily` newest daily points
 * plus up to `weekly` older weekly points (newest point per calendar week), returning
 * `{ kept: [{ id, date, tier }], pruned: string[] }`.
 */
export function selectRetainedRestorePoints(days, retention = RESTORE_POINT_RETENTION) {
  const dailyCap = Number.isInteger(retention?.daily) && retention.daily >= 0 ? retention.daily : DAILY_RESTORE_POINTS;
  const weeklyCap = Number.isInteger(retention?.weekly) && retention.weekly >= 0 ? retention.weekly : WEEKLY_RESTORE_POINTS;
  const unique = [...new Set((days || []).filter(validRestorePointId))].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const daily = unique.slice(0, dailyCap).map((id) => ({ id, date: id, tier: 'daily' }));
  const older = unique.slice(dailyCap);
  const weekly = [];
  const pruned = [];
  const seenWeeks = new Set();
  for (const id of older) {
    const bucket = weekBucket(id);
    if (bucket !== null && !seenWeeks.has(bucket) && seenWeeks.size < weeklyCap) {
      seenWeeks.add(bucket);
      weekly.push({ id, date: id, tier: 'weekly' });
    } else {
      pruned.push(id);
    }
  }
  return { kept: [...daily, ...weekly], pruned };
}

export function shardNamesOfManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest.shards || typeof manifest.shards !== 'object') return [];
  return Object.values(manifest.shards)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((entry) => typeof entry === 'string' && entry.length > 0);
}

export function summarizeRestoreState(state, manifest = null) {
  const decks = Array.isArray(state?.decks) ? state.decks : null;
  const shardCount = (field) => (Array.isArray(manifest?.shards?.[field]) ? manifest.shards[field].length : 0);
  return {
    revision: Number.isSafeInteger(state?.revision) ? state.revision : (Number.isSafeInteger(manifest?.revision) ? manifest.revision : 0),
    courses: Array.isArray(state?.courses) ? state.courses.length : shardCount('courses'),
    sources: Array.isArray(state?.sources) ? state.sources.length : shardCount('sources'),
    decks: decks ? decks.length : shardCount('decks'),
    cards: decks ? decks.reduce((sum, deck) => sum + (Array.isArray(deck?.cards) ? deck.cards.length : 0), 0) : 0,
    attempts: Array.isArray(state?.attempts) ? state.attempts.length : 0,
  };
}

async function readPointFile(dir, fileName) {
  const match = FILE_RE.exec(fileName);
  if (!match) return null;
  const id = match[1];
  if (!validRestorePointId(id)) return null;
  const fullPath = join(dir, fileName);
  try {
    const [raw, info] = await Promise.all([readFile(fullPath, 'utf8'), stat(fullPath)]);
    const parsed = parseStoredJson(raw);
    if (parsed?.format !== RESTORE_POINT_FORMAT || parsed?.manifest?.format !== 'study-sharded' || !parsed.manifest.shards) return null;
    return {
      id,
      date: id,
      fileBytes: info.size,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      rawSummary: parsed.summary && typeof parsed.summary === 'object' ? parsed.summary : null,
      manifest: parsed.manifest,
    };
  } catch {
    return null;
  }
}

function normalizeStoredSummary(stored, manifest) {
  const fallback = summarizeRestoreState(null, manifest);
  if (!stored || typeof stored !== 'object') return fallback;
  const int = (val, alt) => (Number.isSafeInteger(val) && val >= 0 ? val : alt);
  return {
    revision: int(stored.revision, fallback.revision),
    courses: int(stored.courses, fallback.courses),
    sources: int(stored.sources, fallback.sources),
    decks: int(stored.decks, fallback.decks),
    cards: int(stored.cards, fallback.cards),
    attempts: int(stored.attempts, fallback.attempts),
  };
}

async function loadAllPoints(root) {
  const dir = join(root, RESTORE_POINTS_DIR);
  const names = await readdir(dir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!names) return null;
  const loaded = await Promise.all(names.map((name) => readPointFile(dir, name)));
  return loaded.filter(Boolean).map((point) => ({
    ...point,
    summary: normalizeStoredSummary(point.rawSummary, point.manifest),
  }));
}

/**
 * Record or refresh a daily sharded-manifest restore point for `day` (`YYYY-MM-DD`)
 * inside `<root>/restore-points/` and prune automatic restore points to `7 daily + 4 weekly`.
 * Must be called while holding `withStoreLock(root, ...)`, BEFORE `Store.collect` runs.
 */
export async function recordDailyRestorePoint(root, { day, manifest, state = null, now = Date.now, retention = RESTORE_POINT_RETENTION } = {}) {
  if (!root || !validRestorePointId(day) || manifest?.format !== 'study-sharded' || !manifest.shards) {
    return { written: false, pruned: [] };
  }
  const dir = join(root, RESTORE_POINTS_DIR);
  await mkdir(dir, { recursive: true });
  const existingPoints = (await loadAllPoints(root)) || [];
  const byId = new Map(existingPoints.map((point) => [point.id, point]));
  const current = byId.get(day);
  const nextRevision = Number.isSafeInteger(manifest.revision) ? manifest.revision : 0;
  const nowIso = new Date(typeof now === 'function' ? now() : now).toISOString();

  let written = false;
  if (!current || nextRevision > (current.summary?.revision ?? -1)) {
    const payload = {
      format: RESTORE_POINT_FORMAT,
      id: day,
      date: day,
      createdAt: current?.createdAt || nowIso,
      updatedAt: nowIso,
      summary: summarizeRestoreState(state, manifest),
      manifest,
    };
    const target = join(dir, `${day}.json`);
    await atomicJson(target, payload, { space: 2, trailingNewline: true, sync: true });
    written = true;
    byId.set(day, {
      id: day,
      date: day,
      fileBytes: 0,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
      summary: payload.summary,
      manifest,
    });
  }

  const rootKey = canonicalPathKey(root);
  const { kept, pruned } = selectRetainedRestorePoints([...byId.keys()], retention);
  if (pruned.length) {
    let released = pendingReleasedByRoot.get(rootKey);
    if (!released) pendingReleasedByRoot.set(rootKey, (released = new Set()));
    for (const id of pruned) {
      const point = byId.get(id);
      if (point) for (const shard of shardNamesOfManifest(point.manifest)) released.add(shard);
    }
    await Promise.all(pruned.map((id) => rm(join(dir, `${id}.json`), { force: true }).catch(() => {})));
  }
  return { written, kept: kept.map((item) => item.id), pruned };
}

/**
 * Read active restore points under `<root>/restore-points/` (inside `withStoreLock`)
 * and return `{ protectedShards, releasedShards }` for `Store.collect`.
 */
export async function protectedRestorePointShards(root) {
  const rootKey = canonicalPathKey(root);
  const points = await loadAllPoints(root).catch(() => null);
  const pending = pendingReleasedByRoot.get(rootKey);
  pendingReleasedByRoot.delete(rootKey);
  const previous = lastProtectedByRoot.get(rootKey);

  if (!points || points.length === 0) {
    lastProtectedByRoot.delete(rootKey);
    if (!pending?.size && !previous?.size) return { protectedShards: EMPTY_SET, releasedShards: EMPTY_SET };
    return { protectedShards: EMPTY_SET, releasedShards: new Set([...(pending || []), ...(previous || [])]) };
  }

  const protectedShards = new Set();
  for (const point of points) {
    for (const shard of shardNamesOfManifest(point.manifest)) protectedShards.add(shard);
  }
  const releasedShards = new Set();
  if (pending) {
    for (const shard of pending) if (!protectedShards.has(shard)) releasedShards.add(shard);
  }
  if (previous) {
    for (const shard of previous) if (!protectedShards.has(shard)) releasedShards.add(shard);
  }
  lastProtectedByRoot.set(rootKey, protectedShards);
  return { protectedShards, releasedShards };
}

export async function readRestorePointManifest(root, id) {
  if (!validRestorePointId(id)) {
    throw Object.assign(new Error('无效的恢复点日期'), { code: 'invalid-restore-point' });
  }
  const fullPath = join(root, RESTORE_POINTS_DIR, `${id}.json`);
  let raw;
  try {
    raw = await readFile(fullPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw Object.assign(new Error('这个恢复点已经不在了，请刷新后重新选择'), { code: 'restore-point-missing' });
    }
    throw error;
  }
  let parsed;
  try {
    parsed = parseStoredJson(raw);
  } catch {
    throw Object.assign(new Error('恢复点文件已损坏，当前学习库保持不变'), { code: 'restore-point-corrupt' });
  }
  if (parsed?.format !== RESTORE_POINT_FORMAT || parsed?.manifest?.format !== 'study-sharded' || !parsed.manifest.shards) {
    throw Object.assign(new Error('恢复点格式无效，当前学习库保持不变'), { code: 'restore-point-corrupt' });
  }
  return {
    id,
    date: id,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    summary: normalizeStoredSummary(parsed.summary, parsed.manifest),
    manifest: parsed.manifest,
  };
}

export async function listRestorePoints(root, { liveManifest = null, retention = RESTORE_POINT_RETENTION } = {}) {
  if (!root) return { retention, totalExtraBytes: 0, points: [] };
  const loaded = await loadAllPoints(root).catch(() => null);
  if (!loaded || loaded.length === 0) return { retention, totalExtraBytes: 0, points: [] };

  let currentManifest = liveManifest;
  if (!currentManifest) {
    try {
      const parsed = parseStoredJson(await readFile(join(root, 'study-workspace.json'), 'utf8'));
      if (parsed?.format === 'study-sharded' && parsed.shards) currentManifest = parsed;
    } catch {
      currentManifest = null;
    }
  }
  const liveShards = new Set(shardNamesOfManifest(currentManifest));
  const byId = new Map(loaded.map((point) => [point.id, point]));
  const { kept } = selectRetainedRestorePoints([...byId.keys()], retention);

  const shardRoot = join(root, 'shards');
  const uniqueExtraShards = new Set();
  const pointExtraShards = new Map();
  for (const { id } of kept) {
    const point = byId.get(id);
    if (!point) continue;
    const extra = new Set();
    for (const shard of shardNamesOfManifest(point.manifest)) {
      if (!liveShards.has(shard)) {
        extra.add(shard);
        uniqueExtraShards.add(shard);
      }
    }
    pointExtraShards.set(id, extra);
  }

  const shardSizes = new Map();
  await Promise.all([...uniqueExtraShards].map(async (shard) => {
    const info = await stat(join(shardRoot, shard)).catch(() => null);
    shardSizes.set(shard, info?.isFile() ? info.size : 0);
  }));

  let manifestBytesTotal = 0;
  const points = kept.flatMap(({ id, tier }) => {
    const point = byId.get(id);
    if (!point) return [];
    const extra = pointExtraShards.get(id) || EMPTY_SET;
    let shardBytes = 0;
    for (const shard of extra) shardBytes += shardSizes.get(shard) || 0;
    manifestBytesTotal += point.fileBytes || 0;
    return [{
      id: point.id,
      date: point.date,
      tier,
      createdAt: point.createdAt,
      updatedAt: point.updatedAt,
      summary: point.summary,
      extraBytes: (point.fileBytes || 0) + shardBytes,
    }];
  });

  let uniqueExtraShardBytes = 0;
  for (const bytes of shardSizes.values()) uniqueExtraShardBytes += bytes;

  return {
    retention,
    totalExtraBytes: manifestBytesTotal + uniqueExtraShardBytes,
    points,
  };
}
