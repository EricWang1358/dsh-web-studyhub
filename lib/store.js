import { copyFile, mkdir, readdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { defaults } from "./domain.js";
import { normalizeLearner } from "./learner.js";

/* Library storage.
 *
 * `study-workspace.json` is a small manifest: scalar fields (settings, learner
 * profile, recording state) plus the ordered list of shard files under
 * `shards/`. Every source, deck, draft and practice run is its own shard,
 * attempts are chunked, and the small coach logs are one shard each. Shard
 * names carry a content hash, so a commit only writes the shards whose content
 * changed and then atomically replaces the manifest; until that rename the
 * previous library is untouched. Unreferenced shards are removed afterwards.
 *
 * Reads are served from an in-process cache validated by the manifest's stat,
 * so polling an unchanged library costs one stat. Updates always rebuild their
 * working state from the committed shard text, never from an object a reader
 * may have touched. Version 1 libraries (one monolithic file) still open; the
 * first update keeps a copy in `backups/` and writes the sharded form. */

export const LATEST_VERSION = 2;
export const SHARD_FORMAT = "study-sharded";
/** Fields every reader may rely on; older libraries are missing newer ones. */
const FIELDS = ["sources", "decks", "drafts", "attempts", "runs", "teaching", "coach", "feedback", "prepared"];
const PER_ITEM = ["sources", "decks", "drafts", "runs"];
const WHOLE = ["teaching", "coach", "feedback", "prepared"];
const ATTEMPT_CHUNK = 1000;
const SHARD_DIR = "shards";

export const emptyState = () => ({
  version: LATEST_VERSION,
  revision: 0,
  settings: { ...defaults },
  ...Object.fromEntries(FIELDS.map((f) => [f, []])),
});
/* Stepwise upgrades: MIGRATIONS[from] upgrades state to from + 1. Migration
   runs in memory on read and persists on the next update. */
const MIGRATIONS = {
  // 2: storage became sharded; the in-memory shape is unchanged.
  1: (s) => ({ ...s, version: 2 }),
};

async function replaceStateFile(temp, target) {
  // Windows readers/scanners can briefly deny replacement. Keep the store lock
  // and retry the same completed file, never replay the transaction or unlink
  // the destination (readers must always see a complete committed state).
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temp, target);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
      if (attempt >= 7) {
        error.message = `学习库保存失败：文件持续被占用或没有替换权限。请关闭占用该文件的程序，并检查文件是否只读，然后重试。原学习库未被覆盖。\n${error.message}`;
        throw error;
      }
      await delay(Math.min(25 * 2 ** attempt, 500));
    }
  }
}

/** Apply pending migrations and restore fields this build expects. */
export function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid library: expected an object");
  let s = raw;
  if (
    s.version !== undefined &&
    (!Number.isInteger(s.version) || s.version < 1)
  )
    throw new Error("Invalid library version");
  if (
    s.revision !== undefined &&
    (!Number.isSafeInteger(s.revision) || s.revision < 0)
  )
    throw new Error("Invalid library revision");
  if (
    s.settings !== undefined &&
    (!s.settings || typeof s.settings !== "object" || Array.isArray(s.settings))
  )
    throw new Error("Invalid library settings");
  let version = s.version ?? 1;
  if (version > LATEST_VERSION)
    throw new Error(
      `Library version ${version} is newer than this build supports (up to ${LATEST_VERSION}); update the plugin`,
    );
  while (version < LATEST_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) throw new Error(`Unsupported library version ${version}`);
    s = migrate(s);
    version++;
  }
  const out = {
    ...s,
    version,
    settings: { ...defaults, ...(s.settings || {}) },
  };
  for (const f of FIELDS) {
    if (out[f] === undefined) out[f] = [];
    else if (!Array.isArray(out[f]))
      throw new Error(`Invalid library ${f}: expected an array`);
  }
  if (out.revision == null) out.revision = 0;
  out.learner = normalizeLearner(out.learner);
  return out;
}

const hash = (text) => createHash("sha1").update(text).digest("hex").slice(0, 20);
const safeName = (id) => String(id ?? "item").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "item";
const isManifest = (value) => value?.format === SHARD_FORMAT && value.shards && typeof value.shards === "object";

/** Split a state into shard texts and the manifest that lists them. */
function serialize(state) {
  const files = new Map(),
    shards = {};
  const add = (dir, stem, value) => {
    const text = JSON.stringify(value ?? null);
    const name = `${dir}/${stem}.${hash(text)}.json`;
    files.set(name, text);
    return name;
  };
  for (const field of PER_ITEM) shards[field] = state[field].map((item) => add(field, safeName(item?.id), item));
  shards.attempts = [];
  for (let at = 0; at < state.attempts.length; at += ATTEMPT_CHUNK)
    shards.attempts.push(add("attempts", String(at / ATTEMPT_CHUNK), state.attempts.slice(at, at + ATTEMPT_CHUNK)));
  for (const field of WHOLE) shards[field] = add("misc", field, state[field]);
  const scalars = Object.fromEntries(Object.entries(state).filter(([key]) => !FIELDS.includes(key) && key !== "shards" && key !== "format"));
  return { files, manifest: { format: SHARD_FORMAT, ...scalars, shards } };
}
/** Rebuild the in-memory state from a manifest and its shard texts. */
function assemble(manifest, files) {
  const parse = (name) => {
    const text = files.get(name);
    if (text === undefined) throw Object.assign(new Error(`Missing library shard ${name}`), { code: "ENOENT" });
    return JSON.parse(text);
  };
  const { shards, format, ...scalars } = manifest;
  const list = (value) => (Array.isArray(value) ? value : []);
  // Scalars like `ingest` are nested objects too; never share them with the cached manifest.
  const state = structuredClone(scalars);
  for (const field of PER_ITEM) state[field] = list(shards[field]).map(parse);
  state.attempts = list(shards.attempts).flatMap(parse);
  for (const field of WHOLE) state[field] = typeof shards[field] === "string" ? parse(shards[field]) : [];
  return state;
}
const shardNames = (manifest) =>
  Object.values(manifest.shards).flatMap((value) => (Array.isArray(value) ? value : [value])).filter((x) => typeof x === "string");
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Parsed libraries shared by every Store instance in this process, keyed by manifest path.
const cache = new Map();

export class Store {
  constructor(root) {
    if (!root || !isAbsolute(root))
      throw new Error("Choose an absolute study library path first");
    this.root = root;
    this.path = join(root, "study-workspace.json");
    this.shardRoot = join(root, SHARD_DIR);
  }
  /**
   * Cheap change token for the library. Every commit replaces the manifest
   * atomically, so a changed library always changes its stat.
   */
  async stamp() {
    try {
      const info = await stat(this.path, { bigint: true });
      return `${info.mtimeNs}:${info.size}:${info.ino}`;
    } catch (e) {
      if (e.code === "ENOENT") return "missing";
      throw e;
    }
  }
  /** The committed library as {stamp, manifest, files, raw, state}; cached per stat. */
  async load() {
    for (let attempt = 0; ; attempt++) {
      const stamp = await this.stamp();
      const hit = cache.get(this.path);
      if (hit && hit.stamp === stamp) return hit;
      if (stamp === "missing") return { stamp, manifest: null, files: new Map(), raw: null, state: emptyState() };
      let raw;
      try {
        raw = await readFile(this.path, "utf8");
      } catch (e) {
        if (e.code === "ENOENT" && attempt < 4) continue;
        throw e;
      }
      const parsed = JSON.parse(raw);
      if (!isManifest(parsed)) return this.remember({ stamp, manifest: null, files: new Map(), raw, state: normalizeState(parsed) });
      try {
        const files = new Map();
        await Promise.all(shardNames(parsed).map(async (name) => {
          const known = hit?.files.get(name);
          files.set(name, known ?? await readFile(join(this.shardRoot, name), "utf8"));
        }));
        return this.remember({ stamp, manifest: parsed, files, raw: null, state: normalizeState(assemble(parsed, files)) });
      } catch (e) {
        // A writer in another process replaced the manifest and collected the
        // shards this one listed; read the newer manifest instead.
        if (e.code !== "ENOENT" || attempt >= 4) throw e;
      }
    }
  }
  remember(entry) {
    if (process.env.STUDY_STORE_FREEZE) deepFreeze(entry.state);
    cache.set(this.path, entry);
    return entry;
  }
  /** Shared, read-only view of the committed library. Do not mutate it. */
  async read() {
    return (await this.load()).state;
  }
  async update(fn) {
    await mkdir(this.root, { recursive: true });
    const release = await lockfile.lock(this.root, {
      realpath: true,
      retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
      stale: 30000,
    });
    try {
      const current = await this.load();
      // A private working copy from committed text: a failed mutation, or a
      // reader that touched the cached view, can never leak into the commit.
      const working = current.manifest
        ? normalizeState(assemble(current.manifest, current.files))
        : current.raw !== null
          ? normalizeState(JSON.parse(current.raw))
          : emptyState();
      const value = await fn(working);
      working.revision++;
      await this.commit(working, current);
      return value;
    } finally {
      await release();
    }
  }
  async commit(state, previous) {
    const { files, manifest } = serialize(state);
    const fresh = [...files].filter(([name]) => !previous.files.has(name));
    await Promise.all([...new Set(fresh.map(([name]) => dirname(join(this.shardRoot, name))))].map((dir) => mkdir(dir, { recursive: true })));
    await Promise.all(fresh.map(([name, text]) =>
      writeFile(join(this.shardRoot, name), text, { encoding: "utf8", flag: "wx" }).catch((e) => {
        // Same name means same content: an earlier interrupted commit already wrote it.
        if (e.code !== "EEXIST") throw e;
      })));
    if (previous.raw !== null) {
      // First sharded commit of a version 1 library: keep the original file.
      await mkdir(join(this.root, "backups"), { recursive: true });
      await copyFile(this.path, join(this.root, "backups", `study-workspace-v1-${Date.now()}.json`));
    }
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      await replaceStateFile(temp, this.path);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
    this.remember({ stamp: await this.stamp(), manifest, files, raw: null, state });
    await this.collect(files, previous);
  }
  /** Remove shards no longer referenced; failures only leave garbage behind. */
  async collect(files, previous) {
    const stale = [...previous.files.keys()].filter((name) => !files.has(name));
    // Occasionally sweep for leftovers of interrupted commits too.
    if (!previous.manifest || Math.random() < 0.05)
      for (const dir of ["sources", "decks", "drafts", "runs", "attempts", "misc"])
        for (const entry of await readdir(join(this.shardRoot, dir)).catch(() => []))
          if (!files.has(`${dir}/${entry}`)) stale.push(`${dir}/${entry}`);
    await Promise.all([...new Set(stale)].map((name) => rm(join(this.shardRoot, name), { force: true }).catch(() => {})));
  }
}
