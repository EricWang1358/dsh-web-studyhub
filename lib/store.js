import { parseStoredJson } from "./util.js";
import { copyFile, mkdir, readdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { defaults } from "./domain.js";
import { normalizeLearner } from "./learner.js";
import { COURSE_CARRIERS, materializeCourses, syncCourseReferences } from "./courses.js";

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
 * so polling an unchanged library costs one stat. Parsed shards are kept too,
 * deep-frozen and keyed by their content hash: a commit or reload parses only
 * the shards whose names are new, and a transaction reads the fields it does
 * not write straight from those shared values (a write to one throws instead
 * of reaching the cache). Scoped updates decode only declared fields from
 * committed text, privately, except the fields they only read and the items
 * a `changed` hint leaves alone. Unscoped updates rebuild the full state.
 * Neither uses objects a reader may have touched. STUDY_STORE_PRIVATE=1 turns
 * the sharing off (every update parses private copies). Version 1 libraries (one monolithic file) still open; the
 * first update keeps a copy in `backups/` and writes the sharded form.
 *
 * Course references are kept referentially consistent at commit time
 * (lib/courses.js): whichever transaction writes a source, deck or draft also
 * commits the matching course ids and any new course record. */

export const LATEST_VERSION = 4;
export const SHARD_FORMAT = "study-sharded";
/** Fields every reader may rely on; older libraries are missing newer ones. */
const FIELDS = ["sources", "decks", "drafts", "attempts", "runs", "oralRuns", "teaching", "coach", "feedback", "prepared", "inbox", "skeletons", "topicGroups", "notes", "workflowTemplates", "workflowSessions", "courses"];
const PER_ITEM = ["sources", "decks", "drafts", "runs", "oralRuns", "workflowTemplates", "workflowSessions", "courses"];
const WHOLE = ["teaching", "coach", "feedback", "prepared", "inbox", "skeletons", "topicGroups", "notes"];
const ATTEMPT_CHUNK = 1000;
const SHARD_DIR = "shards";
const BASE_COLLECTIONS = new Map([
  ...PER_ITEM.map(name => [name, { mode: "item" }]),
  ...WHOLE.map(name => [name, { mode: "whole" }]),
  ["attempts", { mode: "chunk", chunkSize: ATTEMPT_CHUNK }],
]);
const validCollectionName = name => typeof name === "string" &&
  /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/.test(name) &&
  !["__proto__", "prototype", "constructor", "version", "revision", "format", "shards", "collections"].includes(name);
const normalizeCollectionDefinition = (descriptor = {}) => {
  const mode = descriptor.mode || "item";
  if (!["item", "whole", "chunk"].includes(mode)) throw new Error("Invalid collection mode");
  const definition = { mode, ...(mode === "chunk" ? { chunkSize: descriptor.chunkSize ?? ATTEMPT_CHUNK } : {}) };
  if (mode === "chunk" && (!Number.isSafeInteger(definition.chunkSize) || definition.chunkSize < 1))
    throw new Error("Invalid collection chunk size");
  return definition;
};
const collectionDefinitions = (state, previous, registered = BASE_COLLECTIONS) => {
  const definitions = new Map(BASE_COLLECTIONS);
  const persisted = previous?.collections?.format === 'study-collections/v1' ? previous.collections.definitions : {};
  for (const [name, descriptor] of Object.entries(persisted || {}))
    if (validCollectionName(name) && ["item", "whole", "chunk"].includes(descriptor?.mode))
      definitions.set(name, normalizeCollectionDefinition(descriptor));
  for (const [name, descriptor] of registered) definitions.set(name, descriptor);
  // Collections contributed by an absent plugin must survive unrelated writes.
  for (const name of Object.keys(previous?.shards || {}))
    if (!definitions.has(name)) definitions.set(name,
      { mode: Array.isArray(previous.shards[name]) ? "item" : "whole" });
  for (const [name, value] of Object.entries(state))
    if (validCollectionName(name) && Array.isArray(value) && !definitions.has(name))
      definitions.set(name, { mode: "whole" });
  return definitions;
};

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
  2: (s) => ({ ...s, version: 3, workflowTemplates: s.workflowTemplates || [], workflowSessions: s.workflowSessions || [] }),
  // 4: courses became records with stable ids; references gained ids beside their names.
  3: (s) => ({ ...materializeCourses(s), version: 4 }),
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

/** A downloaded full export, never a sharded manifest or an arbitrary deck JSON. */
function restoreState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.format ||
      !Number.isInteger(raw.version) ||
      !["sources", "decks", "drafts", "attempts", "runs"].every((key) => Array.isArray(raw[key])))
    throw new Error("请选择由「导出学习库」生成的完整 JSON 备份");
  const state = normalizeState(raw);
  for (const field of FIELDS)
    if (state[field].some((item) => !item || typeof item !== "object" || Array.isArray(item)))
      throw new Error(`备份中的 ${field} 包含无效记录`);
  const unique = (items, label) => {
    const seen = new Set();
    for (const item of items) {
      if (typeof item.id !== "string" || !item.id || seen.has(item.id))
        throw new Error(`备份中的 ${label} ID 缺失或重复`);
      seen.add(item.id);
    }
  };
  for (const field of PER_ITEM) unique(state[field], field);
  const cards = state.decks.flatMap((deck) => {
    if (!Array.isArray(deck.cards)) throw new Error("备份中有题组缺少题目列表");
    return deck.cards;
  });
  unique(cards, "题目");
  return state;
}

const hash = (text) => createHash("sha1").update(text).digest("hex").slice(0, 20);
const safeName = (id) => String(id ?? "item").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "item";
const isManifest = (value) => value?.format === SHARD_FORMAT && value.shards && typeof value.shards === "object";

/** Split a state into shard texts and the manifest that lists them. */
function serialize(state, previous, changed, registered, fields = null) {
  const files = new Map(),
    shards = {};
  const add = (dir, stem, value) => {
    const text = JSON.stringify(value ?? null);
    const name = `${dir}/${stem}.${hash(text)}.json`;
    files.set(name, text);
    return name;
  };
  const reuse = (name) => {
    const text = previous?.files.get(name);
    if (text === undefined) return false;
    files.set(name, text);
    return true;
  };
  const definitions = collectionDefinitions(state, previous?.manifest, registered);
  for (const [field, descriptor] of definitions) {
    if (fields && !fields.has(field) && Object.hasOwn(previous?.manifest?.shards || {}, field)) {
      const names = previous.manifest.shards[field];
      for (const name of Array.isArray(names) ? names : [names]) reuse(name);
      shards[field] = names;
      continue;
    }
    const values = state[field] ?? [];
    if (descriptor.mode === "item") shards[field] = values.map((item, index) => {
    const oldId = changed ? previous?.itemIds?.[field]?.[index] : undefined;
    const oldName = previous?.manifest?.shards[field]?.[index];
    const touched = changed?.[field];
    if (changed && touched !== "all" && oldId === item?.id &&
        !(touched instanceof Set && touched.has(item.id)) && oldName && reuse(oldName))
      return oldName;
    return add(field, safeName(item?.id), item);
    });
    else if (descriptor.mode === "chunk") {
      shards[field] = [];
      const size = descriptor.chunkSize || ATTEMPT_CHUNK;
      for (let at = 0; at < values.length; at += size) {
        const oldName = previous?.manifest?.shards[field]?.[at / size];
        const appendOnly = changed && field === "attempts" && at + size <= (previous?.lengths?.[field] || 0);
        if (changed && (!changed[field] || appendOnly) && oldName && reuse(oldName)) shards[field].push(oldName);
        else shards[field].push(add(field, String(at / size), values.slice(at, at + size)));
      }
    } else {
      const oldName = previous?.manifest?.shards[field];
      shards[field] = changed && !changed[field] && oldName && reuse(oldName)
        ? oldName : add("misc", field, values);
    }
  }
  const scalars = Object.fromEntries(Object.entries(state).filter(([key]) => !definitions.has(key) && key !== "shards" && key !== "format" && key !== "collections"));
  return { files, manifest: { format: SHARD_FORMAT, ...scalars,
    collections: { format: 'study-collections/v1', definitions: Object.fromEntries(definitions),
      ...(Object.hasOwn(state, 'collections') ? { value: state.collections } : {}) }, shards } };
}
/* Parsed shard values shared by every reader of one library path: { values: shard name -> frozen value,
   lists: field -> { key: its shard names, value: the frozen assembled array } }. Names carry a hash of the
   content, so a value never goes stale; remember() drops what the current manifest no longer lists. */
const parsedByPath = new Map();
const parsedFor = (path) => {
  let parsed = parsedByPath.get(path);
  if (!parsed) parsedByPath.set(path, parsed = { values: new Map(), lists: new Map() });
  return parsed;
};
const sharing = () => !process.env.STUDY_STORE_PRIVATE;
/** Freeze a parsed JSON tree in place: a shared value must never be written through. */
function freezeTree(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  if (Array.isArray(value)) for (const item of value) freezeTree(item);
  else for (const key in value) freezeTree(value[key]);
  return value;
}
/** `<field>/<stem>.<hash>.json` -> stem (the item's safeName). */
const stemOf = (name) => name.slice(name.indexOf("/") + 1).replace(/\.[0-9a-f]{20}\.json$/, "");
/** Which shards a transaction must copy: those of fields it writes, minus items its `changed` hint leaves alone. */
function copyRule(writable, changed) {
  const stems = new Map(Object.entries(changed || {}).filter(([, ids]) => ids instanceof Set).map(([field, ids]) => [field, new Set([...ids].map(safeName))]));
  return (field, name, mode) => {
    if (!writable.has(field)) return false;
    // No name: does the field's whole array have to be a private, mutable one? (Always, when the transaction writes it.)
    if (name === undefined) return true;
    const touched = stems.get(field);
    return !(touched && mode === "item") || touched.has(stemOf(name));
  };
}

/** Rebuild the in-memory state from a manifest and its shard texts.
 *  `share` (parsedFor(path), plus an optional `private(field, name, mode)` rule) serves frozen shared values; without it every shard is parsed afresh. */
function assemble(manifest, files, issues = null, fields = null, share = null) {
  const unreadable = Symbol('unreadable shard');
  const parse = (name, shared) => {
    if (shared && share.values.has(name)) return share.values.get(name);
    const text = files.get(name);
    if (text === undefined) throw Object.assign(new Error(`Missing library shard ${name}`), { code: "ENOENT" });
    try {
      const value = parseStoredJson(text);
      if (shared) share.values.set(name, freezeTree(value));
      return value;
    }
    catch (error) {
      if (!issues || !(error instanceof SyntaxError)) throw error;
      issues.push({ file: `${SHARD_DIR}/${name}`, message: error.message });
      return unreadable;
    }
  };
  const { shards, format, collections, ...scalars } = manifest;
  const list = (value) => (Array.isArray(value) ? value : []);
  // Scalars like `ingest` are nested objects too; never share them with the cached manifest.
  const state = structuredClone(scalars);
  // `collections` was an ordinary additive field in older libraries. Metadata
  // is tagged and carries that original value rather than reserving it silently.
  if (collections?.format === 'study-collections/v1') {
    if (Object.hasOwn(collections, 'value')) state.collections = structuredClone(collections.value);
  } else if (collections !== undefined) state.collections = structuredClone(collections);
  for (const [field, descriptor] of collectionDefinitions(state, { shards, collections })) {
    if (fields && !fields.has(field)) continue;
    // Older v3 writers kept unrecognized arrays in the manifest itself.
    // Discovering them as collections must not replace those values with [].
    if (!Object.hasOwn(shards, field) && Object.hasOwn(state, field)) continue;
    const shareable = (name) => !!share && !share.private?.(field, name, descriptor.mode);
    const readable = (name) => { const value = parse(name, shareable(name)); return value === unreadable ? [] : [value]; };
    if (descriptor.mode === "whole") {
      const values = typeof shards[field] === "string" ? readable(shards[field]) : [];
      state[field] = values.length ? values[0] : [];
    } else {
      const names = list(shards[field]), key = names.join("\n");
      const everyShared = !!share && !share.private?.(field, undefined, descriptor.mode) && names.every(shareable), cached = everyShared ? share.lists.get(field) : null;
      if (cached?.key === key) state[field] = cached.value;
      else {
        const before = issues?.length ?? 0;
        const values = names.flatMap(readable);
        const built = descriptor.mode === "chunk" ? values.flat() : values;
        state[field] = built;
        // An array of shared values is shared too (same identity until a shard of the field changes), unless a shard was unreadable.
        if (everyShared && (issues?.length ?? 0) === before) { Object.freeze(built); share.lists.set(field, { key, value: built }); }
      }
    }
  }
  return state;
}
/** A validated commit can defer decoding untouched collections until requested.
 * Each value still comes from committed text, never the caller's mutable draft. */
function deferredState(manifest, files, share = null) {
  const state = normalizeState(assemble(manifest, files, null, new Set(), share));
  for (const field of collectionDefinitions(state, manifest).keys()) {
    let value, loaded = false;
    Object.defineProperty(state, field, { enumerable: true, configurable: true,
      get() {
        if (!loaded) {
          value = assemble(manifest, files, null, new Set([field]), share)[field] ?? [];
          if (!Array.isArray(value)) throw new Error(`Invalid library ${field}: expected an array`);
          loaded = true;
        }
        return value;
      },
      set(next) { value = next; loaded = true; },
    });
  }
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

/** Shard reuse hints must include the records the course sync touched. */
function withCourseChanges(changed, synced) {
  const next = { ...changed };
  for (const [field, ids] of Object.entries(synced.fields)) {
    const touched = next[field];
    if (touched === "all") continue;
    next[field] = touched instanceof Set ? new Set([...touched, ...ids]) : touched ? "all" : new Set(ids);
  }
  if (synced.courses) next.courses = "all";
  return next;
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
    this.collections = new Map(BASE_COLLECTIONS);
  }
  /** Register persistence structure without adding fields to the core dispatcher. */
  registerCollection(name, descriptor = {}) {
    if (!validCollectionName(name)) throw new Error("Invalid collection name");
    const definition = normalizeCollectionDefinition(descriptor);
    const existing = this.collections.get(name);
    if (existing && JSON.stringify(existing) !== JSON.stringify(definition))
      throw new Error(`Collection ${name} has an incompatible definition`);
    this.collections.set(name, definition);
    return () => { if (!BASE_COLLECTIONS.has(name)) this.collections.delete(name); };
  }
  /** A context can read and replace only its declared fields in an atomic update. */
  scoped(fields) {
    const names = [...new Set(fields)];
    if (!names.every(validCollectionName)) throw new Error("Invalid scoped state field");
    // `wanted` (an array of field names) narrows a read to the fields the caller needs; the others are not copied.
    const project = (state, wanted) => Object.fromEntries(names.filter(name => !Array.isArray(wanted) || wanted.includes(name)).map(name => [name,
      structuredClone(state[name] ?? (this.collections.has(name) ? [] : undefined))]));
    return Object.freeze({
      read: async wanted => {
        const state = await this.read();
        return { revision: state.revision, ...project(state, wanted) };
      },
      update: async fn => structuredClone(await this.update(async state => {
        // The transaction already decoded a private projection from shard text.
        const owned = Object.fromEntries(names.map(name => [name,
          state[name] ?? (this.collections.has(name) ? [] : undefined)]));
        const result = await fn(owned);
        for (const name of names) {
          if (this.collections.has(name) && !Array.isArray(owned[name]))
            throw new Error(`Invalid collection ${name}: expected an array`);
          state[name] = owned[name];
        }
        return result;
      }, null, names)),
    });
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
      if (hit && hit.stamp === stamp && !hit.storageIssues?.length) return hit;
      if (stamp === "missing") return { stamp, manifest: null, files: new Map(), raw: null, state: emptyState() };
      let raw;
      try {
        raw = await readFile(this.path, "utf8");
      } catch (e) {
        if (e.code === "ENOENT" && attempt < 4) continue;
        throw e;
      }
      const parsed = parseStoredJson(raw);
      if (!isManifest(parsed)) return this.remember({ stamp, manifest: null, files: new Map(), raw, state: normalizeState(parsed) });
      try {
        const files = new Map();
        await Promise.all(shardNames(parsed).map(async (name) => {
          const damaged = hit?.storageIssues?.some(issue => issue.file === `${SHARD_DIR}/${name}`);
          const known = damaged ? undefined : hit?.files.get(name);
          files.set(name, known ?? await readFile(join(this.shardRoot, name), "utf8"));
        }));
        const storageIssues = [];
        // Older versions are migrated in place on read, so only the current format shares frozen values.
        const state = normalizeState(assemble(parsed, files, storageIssues, null, parsed.version === LATEST_VERSION && sharing() ? parsedFor(this.path) : null));
        return this.remember({ stamp, manifest: parsed, files, raw: null, state, storageIssues });
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
    if (entry.manifest?.version === LATEST_VERSION && sharing())
      // A collection a reader gets is frozen already; its plain fields are shared the same way.
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry.state)))
        if ("value" in descriptor && key !== "storageIssues") freezeTree(descriptor.value);
    if (entry.manifest) {
      // Parsed values live exactly as long as the manifest lists their shard.
      const live = new Set(shardNames(entry.manifest)), parsed = parsedFor(this.path);
      for (const name of parsed.values.keys()) if (!live.has(name)) parsed.values.delete(name);
      for (const [field, { key }] of parsed.lists) if (!key.split("\n").every((name) => !name || live.has(name))) parsed.lists.delete(field);
    }
    return entry;
  }
  /** Shared, read-only view of the committed library. Do not mutate it. */
  async read() {
    const entry = await this.load();
    return entry.storageIssues?.length ? { ...entry.state, storageIssues: entry.storageIssues } : entry.state;
  }
  assertWritable(entry) {
    if (entry.storageIssues?.length)
      throw new Error(`学习库有损坏文件，其他内容可查看；请修复后再保存，避免覆盖原数据：${entry.storageIssues.map(issue => issue.file).join(", ")}`);
  }
  async update(fn, changed = null, fields = null) {
    const selected = fields ? new Set(fields.reads || fields) : null;
    const writable = fields ? new Set(fields.writes || fields) : null;
    if (selected && (![...selected, ...writable].every(validCollectionName) || [...writable].some(field => !selected.has(field))))
      throw new Error('Invalid transaction state field');
    // A write to a course reference also commits its id and any new course record.
    if (writable && COURSE_CARRIERS.some(field => writable.has(field))) { selected.add("courses"); writable.add("courses"); }
    await mkdir(this.root, { recursive: true });
    const release = await lockfile.lock(this.root, {
      realpath: true,
      retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
      stale: 30000,
    });
    try {
      const current = await this.load();
      this.assertWritable(current);
      // Old formats still need a complete migration and backup on their first write.
      const projection = current.manifest?.version === LATEST_VERSION ? selected : null;
      // A private working copy from committed text: a failed mutation, or a
      // reader that touched the cached view, can never leak into the commit.
      // Fields the transaction only reads, and items its hint leaves alone, are the shared frozen values instead.
      const share = projection && sharing() ? { ...parsedFor(this.path), private: copyRule(writable, changed) } : null;
      const working = current.manifest
        ? normalizeState(assemble(current.manifest, current.files, null, projection, share))
        : current.raw !== null
          ? normalizeState(parseStoredJson(current.raw))
          : emptyState();
      const itemIds = {}, lengths = {};
      if (changed) for (const [field, descriptor] of collectionDefinitions(working, current.manifest, this.collections)) {
        if (descriptor.mode === 'item') itemIds[field] = (working[field] || []).map(item => item?.id);
        if (descriptor.mode === 'chunk') lengths[field] = (working[field] || []).length;
      }
      const value = await fn(working);
      const synced = syncCourseReferences(working, projection ? writable : null);
      if (changed) changed = withCourseChanges(changed, synced);
      working.revision++;
      await this.commit(working, changed ? { ...current, itemIds, lengths } : current, changed, projection ? writable : null);
      return value;
    } finally {
      await release();
    }
  }
  /** Replace the current library with a validated full export under the store lock. */
  async restore(backup) {
    const restored = restoreState(backup);
    await mkdir(this.root, { recursive: true });
    const release = await lockfile.lock(this.root, {
      realpath: true,
      retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
      stale: 30000,
    });
    try {
      const current = await this.load();
      this.assertWritable(current);
      const backupDir = join(this.root, "backups");
      await mkdir(backupDir, { recursive: true });
      const backupPath = join(backupDir, `study-workspace-before-restore-${Date.now()}-${randomUUID()}.json`);
      await writeFile(backupPath, JSON.stringify(current.state, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      restored.revision = current.state.revision + 1;
      syncCourseReferences(restored);
      await this.commit(restored, current);
      return { backupPath, sources: restored.sources.length, decks: restored.decks.length, attempts: restored.attempts.length };
    } finally {
      await release();
    }
  }
  async commit(state, previous, changed = null, fields = null) {
    // Keep a complete pre-upgrade export, including old shards before GC.
    if (previous.manifest && previous.manifest.version < state.version) {
      const dir = join(this.root, "backups");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `study-workspace-v${previous.manifest.version}-${Date.now()}-${randomUUID()}.json`),
        JSON.stringify(assemble(previous.manifest, previous.files)), { encoding: "utf8", flag: "wx" });
    }
    const { files, manifest } = serialize(state, previous, previous.manifest ? changed : null, this.collections, fields);
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
    this.remember({ stamp: await this.stamp(), manifest, files, raw: null,
      state: deferredState(manifest, files, sharing() ? parsedFor(this.path) : null) });
    await this.collect(files, previous);
  }
  /** Remove shards no longer referenced; failures only leave garbage behind. */
  async collect(files, previous) {
    const stale = [...previous.files.keys()].filter((name) => !files.has(name));
    // Occasionally sweep for leftovers of interrupted commits too.
    if (!previous.manifest || Math.random() < 0.05)
      for (const dir of [...PER_ITEM, "attempts", "misc"])
        for (const entry of await readdir(join(this.shardRoot, dir)).catch(() => []))
          if (!files.has(`${dir}/${entry}`)) stale.push(`${dir}/${entry}`);
    await Promise.all([...new Set(stale)].map((name) => rm(join(this.shardRoot, name), { force: true }).catch(() => {})));
  }
}
