import { parseStoredJson } from "./util.js";
import { copyFile, mkdir, readdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, isAbsolute, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteFile } from "./atomic-json.js";
import { canonicalPathKey, withStoreLock } from "./store-lock.js";
import { noteCommit } from "./runtime/commit-log.js";
import { defaults, LEGACY_KEYS } from "./domain.js";
import { normalizeGenerationSettings } from "./generation-settings.js";
import { normalizeExamPrepSettings } from "./exam-prep-settings.js";
import { normalizePracticeSettings } from "./practice-settings.js";
import { normalizeBookSettings } from "./book-settings.js";
import { normalizeDailyRecapSettings } from "./daily-recap-settings.js";
import { preserveUnknownKeys } from "./preserve-unknown-keys.js";
import { normalizeLearner } from "./learner.js";
import { COURSE_CARRIERS, materializeCourses, migrateInterviewFocus, syncCourseReferences } from "./courses.js";
import { listRestorePoints, localDayKey, protectedRestorePointShards, readRestorePointManifest, recordDailyRestorePoint } from "./contexts/library/restore-points.js";

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
 * of reaching the cache). Once a shard is parsed its text is dropped from
 * memory (`files` keeps the name with null): a library is held once, as
 * parsed values, not twice, and a transaction that copies a shard reads its
 * text from disk again. Scoped updates decode only declared fields from
 * committed text, privately, except the fields they only read and the items
 * a `changed` hint leaves alone. Unscoped updates rebuild the full state.
 * Neither uses objects a reader may have touched. STUDY_STORE_PRIVATE=1 turns
 * the sharing off (every update parses private copies). Version 1 libraries (one monolithic file) still open; the
 * first update keeps a copy in `backups/` and writes the sharded form.
 *
 * Course references are kept referentially consistent at commit time
 * (lib/courses.js): whichever transaction writes a source, deck or draft also
 * commits the matching course ids and any new course record. */

export const LATEST_VERSION = 5;
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
  settings: { ...defaults, generation: normalizeGenerationSettings(), dailyRecap: normalizeDailyRecapSettings() },
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
  // 5: global interview focus migrated idempotently into a course record (#779).
  4: (s) => ({ ...migrateInterviewFocus(s), version: 5 }),
};

const DENIED_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

async function writeStoreFile(target, text, { beforeReplace } = {}) {
  // Durable atomic write (wx temp + fsync + Windows retry + temp cleanup).
  // Never replay the transaction or unlink the destination (readers must always see a complete committed state).
  try {
    await atomicWriteFile(target, text, { encoding: "utf8", sync: true, beforeReplace });
  } catch (error) {
    if (DENIED_CODES.has(error?.code)) {
      error.message = `学习库保存失败：文件持续被占用或没有替换权限。请关闭占用该文件的程序，并检查文件是否只读，然后重试。原学习库未被覆盖。\n${error.message}`;
    }
    throw error;
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
  const rawSettings = s.settings && typeof s.settings === "object" && !Array.isArray(s.settings) ? s.settings : {};
  const baseSettings = {
    ...defaults,
    ...(Object.hasOwn(rawSettings, "request_retention") && rawSettings.request_retention !== undefined ? { request_retention: rawSettings.request_retention } : {}),
    ...(Object.hasOwn(rawSettings, "maximum_interval") && rawSettings.maximum_interval !== undefined ? { maximum_interval: rawSettings.maximum_interval } : {}),
    generation: normalizeGenerationSettings(rawSettings.generation),
    dailyRecap: normalizeDailyRecapSettings(rawSettings.dailyRecap),
    // 备考补习 defaults are saved on demand: no key until the learner saves one.
    ...(rawSettings.examPrep !== undefined ? { examPrep: normalizeExamPrepSettings(rawSettings.examPrep) } : {}),
    // 练习 defaults: the same, saved on demand.
    ...(rawSettings.practice !== undefined ? { practice: normalizePracticeSettings(rawSettings.practice) } : {}),
    // 复习全书 settings: the same, saved on demand.
    ...(rawSettings.book !== undefined ? { book: normalizeBookSettings(rawSettings.book) } : {}),
  };
  const out = {
    ...s,
    version,
    // Unknown top-level keys survive for rollback compatibility (#1629); legacy SM-2 keys stay dropped.
    settings: preserveUnknownKeys(rawSettings, baseSettings, LEGACY_KEYS),
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

function validateRestoredRecords(state) {
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

/** A downloaded full export, never a sharded manifest or an arbitrary deck JSON. */
function restoreState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.format ||
      !Number.isInteger(raw.version) ||
      !["sources", "decks", "drafts", "attempts", "runs"].every((key) => Array.isArray(raw[key])))
    throw new Error("请选择由「导出学习库」生成的完整 JSON 备份");
  return validateRestoredRecords(normalizeState(raw));
}

const hash = (text) => createHash("sha1").update(text).digest("hex").slice(0, 20);
const safeName = (id) => String(id ?? "item").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48) || "item";
const isManifest = (value) => value?.format === SHARD_FORMAT && value.shards && typeof value.shards === "object";

/** Split a state into shard texts and the manifest that lists them. */
function serialize(state, previous, changed, registered, fields = null, committedDay = null) {
  const files = new Map(),
    shards = {};
  const add = (dir, stem, value) => {
    const text = JSON.stringify(value ?? null);
    const name = `${dir}/${stem}.${hash(text)}.json`;
    // The same name is the same content: a shard that was already there keeps what the cache holds of it (nothing, once parsed).
    files.set(name, previous?.files.has(name) ? previous.files.get(name) : text);
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
    if (descriptor.mode === "item") shards[field] = values.map((item) => {
      // Reuse an existing shard in O(1) only when `item` is the exact deep-frozen shared reference
      // loaded from that shard: immune to reordering, insertions/deletions, and missing `changed` hints.
      const frozenName = previous?.itemRefs?.[field]?.get(item);
      if (frozenName && reuse(frozenName)) return frozenName;
      return add(field, safeName(item?.id), item);
    });
    else if (descriptor.mode === "chunk") {
      shards[field] = [];
      const size = descriptor.chunkSize || ATTEMPT_CHUNK;
      const hint = changed?.[field];
      const prevLen = previous?.lengths?.[field] || 0;
      const cleanBefore = hint && typeof hint === "object"
        ? (hint.appendOnly === true ? prevLen : Number.isInteger(hint.from) ? Math.min(hint.from, prevLen) : 0)
        : 0;
      const canSkipPrefix = cleanBefore > 0 && values.length >= prevLen;
      for (let at = 0; at < values.length; at += size) {
        const oldName = previous?.manifest?.shards[field]?.[at / size];
        const untouched = changed && (!hint || (canSkipPrefix && at + size <= cleanBefore));
        if (untouched && oldName && reuse(oldName)) shards[field].push(oldName);
        else shards[field].push(add(field, String(at / size), values.slice(at, at + size)));
      }
    } else {
      const oldName = previous?.manifest?.shards[field];
      const unchangedFrozen = oldName && previous?.wholeRefs?.[field] === values && Object.isFrozen(values);
      shards[field] = unchangedFrozen && reuse(oldName)
        ? oldName : add("misc", field, values);
    }
  }
  const scalars = Object.fromEntries(Object.entries(state).filter(([key]) => !definitions.has(key) && key !== "shards" && key !== "format" && key !== "collections"));
  return { files, manifest: { format: SHARD_FORMAT, ...scalars,
    collections: { format: 'study-collections/v1', definitions: Object.fromEntries(definitions),
      ...(committedDay ? { committedDay } : {}),
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
  const chunkHints = new Map(Object.entries(changed || {})
    .filter(([, hint]) => hint && typeof hint === "object" && !(hint instanceof Set) && (hint.appendOnly === true || (Number.isInteger(hint.from) && hint.from > 0))));
  return (field, name, mode, index, chunkSize) => {
    if (!writable.has(field)) return false;
    // No name: does the field's whole array have to be a private, mutable one? (Always, when the transaction writes it.)
    if (name === undefined) return true;
    if (mode === "chunk") {
      const hint = chunkHints.get(field);
      if (hint?.appendOnly === true) return false;
      if (hint && Number.isInteger(index) && Number.isInteger(chunkSize) && (index + 1) * chunkSize <= hint.from) return false;
    }
    const touched = stems.get(field);
    return !(touched && mode === "item") || touched.has(stemOf(name));
  };
}

/** Rebuild the in-memory state from a manifest and its shard texts.
 *  `share` (parsedFor(path), plus an optional `private(field, name, mode)` rule) serves frozen shared values; without it every shard is parsed afresh. */
function assemble(manifest, files, issues = null, fields = null, share = null, readText = null) {
  const unreadable = Symbol('unreadable shard');
  const parse = (name, shared) => {
    if (shared && share.values.has(name)) {
      if (typeof files.get(name) === "string") files.set(name, null);
      return share.values.get(name);
    }
    // A private copy of a shard that is held parsed is a copy of that value: reading the file again took 100-500 ms for a
    // collection of a thousand shards (blocking), copying the parsed value 25-120 ms.
    if (!shared && share?.values.has(name)) return structuredClone(share.values.get(name));
    let text = files.get(name);
    try {
      // The text of a shard that was parsed and shared is dropped (null); a private copy of it reads the file again.
      if (text === null && readText) text = readText(name);
      if (text === undefined || text === null) throw Object.assign(new Error(`Missing library shard ${name}`), { code: "ENOENT" });
      const value = parseStoredJson(text);
      if (shared) { share.values.set(name, freezeTree(value)); files.set(name, null); }
      return value;
    }
    catch (error) {
      if (!issues || !(error instanceof SyntaxError || error.code === "ENOENT" || error.code === "EINVAL")) throw error;
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
    const chunkSize = descriptor.chunkSize || ATTEMPT_CHUNK;
    const shareable = (name, index) => !!share && !share.private?.(field, name, descriptor.mode, index, chunkSize);
    const readable = (name, index) => { const value = parse(name, shareable(name, index)); return value === unreadable ? [] : [value]; };
    if (descriptor.mode === "whole") {
      const values = typeof shards[field] === "string" ? readable(shards[field], 0) : [];
      state[field] = values.length ? values[0] : [];
    } else {
      const names = list(shards[field]), key = names.join("\n");
      const everyShared = !!share && !share.private?.(field, undefined, descriptor.mode) && names.every((name, index) => shareable(name, index)), cached = everyShared ? share.lists.get(field) : null;
      if (cached?.key === key) state[field] = cached.value;
      else {
        const before = issues?.length ?? 0;
        const values = names.flatMap((name, index) => readable(name, index));
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
function deferredState(manifest, files, share = null, readText = null) {
  const state = normalizeState(assemble(manifest, files, null, new Set(), share, readText));
  for (const field of collectionDefinitions(state, manifest).keys()) {
    let value, loaded = false;
    Object.defineProperty(state, field, { enumerable: true, configurable: true,
      get() {
        if (!loaded) {
          value = assemble(manifest, files, null, new Set([field]), share, readText)[field] ?? [];
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
const validShardName = (name) =>
  typeof name === "string" &&
  /^[A-Za-z][A-Za-z0-9_.-]{0,95}\/[A-Za-z0-9_.-]+\.json$/.test(name) &&
  !name.includes("..");
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
// Active runtime/session owners pin their library path; unpinned idle libraries stay bounded by LRU eviction.
export const MAX_IDLE_STORE_CACHES = 8;
const cache = new Map();
const activeLeases = new Map();
const evictPathCache = (path) => {
  cache.delete(path);
  parsedByPath.delete(path);
};
const touchCacheEntry = (path, entry) => {
  cache.delete(path);
  cache.set(path, entry);
};
const evictIdleStoreCaches = (limit = MAX_IDLE_STORE_CACHES) => {
  const max = Number.isInteger(limit) && limit >= 0 ? limit : MAX_IDLE_STORE_CACHES;
  const unpinned = [...cache.keys()].filter(path => !activeLeases.get(path)?.size);
  const overflow = unpinned.length - max;
  for (let i = 0; i < overflow; i++) evictPathCache(unpinned[i]);
  for (const path of [...parsedByPath.keys()]) {
    if (!cache.has(path) && !activeLeases.get(path)?.size) parsedByPath.delete(path);
  }
};

export class Store {
  constructor(root, { lockRetry, onCommitStage } = {}) {
    if (!root || !isAbsolute(root))
      throw new Error("Choose an absolute study library path first");
    this.root = root;
    // How long this store waits for another process's lock (STORE_LOCK in lib/store-lock.js unless a test shortens it).
    this.lockRetry = lockRetry;
    this.onCommitStage = typeof onCommitStage === "function" ? onCommitStage : null;
    this.path = join(root, "study-workspace.json");
    this.cacheKey = canonicalPathKey(this.path);
    this.shardRoot = join(root, SHARD_DIR);
    this.collections = new Map(BASE_COLLECTIONS);
    this.now = typeof arguments[1]?.now === "function" ? arguments[1].now : Date.now;
  }
  /** Validate and resolve a shard path strictly inside `this.shardRoot` so tampered manifests cannot traverse outside `shards/`. */
  #shardPath(name) {
    if (!validShardName(name)) {
      throw Object.assign(new Error(`Invalid library shard path ${name}`), { code: "EINVAL" });
    }
    const base = resolve(this.shardRoot);
    const target = resolve(base, name);
    if (!target.startsWith(`${base}${sep}`)) {
      throw Object.assign(new Error(`Invalid library shard path ${name}`), { code: "EINVAL" });
    }
    return target;
  }
  /** A shard's text again, for a private copy of a shard whose text was dropped after it was parsed and shared. */
  #shardText = (name) => readFileSync(this.#shardPath(name), "utf8");
  /** Publish a fresh shard via fsynced temp-file + rename so truncated or tampered orphan shards can never be adopted. */
  async #writeShard(name, text) {
    const target = this.#shardPath(name);
    const existing = await readFile(target, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing === text) return;
    await writeStoreFile(target, text, {
      beforeReplace: (temp) => this.onCommitStage?.("during-shard-write", { name, targetPath: target, tempPath: temp }),
    });
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
      const hit = cache.get(this.cacheKey);
      if (hit && hit.stamp === stamp && !hit.storageIssues?.length) {
        touchCacheEntry(this.cacheKey, hit);
        return hit;
      }
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
        let missing = false;
        await Promise.all(shardNames(parsed).map(async (name) => {
          const damaged = hit?.storageIssues?.some(issue => issue.file === `${SHARD_DIR}/${name}`);
          const known = damaged ? undefined : hit?.files.get(name);
          // null: the shard is held parsed (see assemble); its text is not read again.
          try {
            files.set(name, known !== undefined ? known : await readFile(this.#shardPath(name), "utf8"));
          } catch (error) {
            if (error.code === "EINVAL") {
              files.set(name, undefined);
              return;
            }
            if (error.code !== "ENOENT") throw error;
            missing = true;
            files.set(name, undefined);
          }
        }));
        // A concurrent commit may have collected this manifest's shards. Retry
        // first; a persistently missing shard is isolated like malformed JSON.
        if (missing && attempt < 4) continue;
        const storageIssues = [];
        // Older versions are migrated in place on read, so only the current format shares frozen values.
        const state = normalizeState(assemble(parsed, files, storageIssues, null, parsed.version === LATEST_VERSION && sharing() ? parsedFor(this.cacheKey) : null, this.#shardText));
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
    touchCacheEntry(this.cacheKey, entry);
    if (entry.manifest?.version === LATEST_VERSION && sharing())
      // A collection a reader gets is frozen already; its plain fields are shared the same way.
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(entry.state)))
        if ("value" in descriptor && key !== "storageIssues") freezeTree(descriptor.value);
    if (entry.manifest) {
      // Parsed values live exactly as long as the manifest lists their shard.
      const live = new Set(shardNames(entry.manifest)), parsed = parsedFor(this.cacheKey);
      for (const name of parsed.values.keys()) if (!live.has(name)) parsed.values.delete(name);
      for (const [field, { key }] of parsed.lists) if (!key.split("\n").every((name) => !name || live.has(name))) parsed.lists.delete(field);
    }
    evictIdleStoreCaches();
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
    return withStoreLock(this.root, async () => {
      const current = await this.load();
      this.assertWritable(current);
      // Old formats still need a complete migration and backup on their first write.
      const projection = current.manifest?.version === LATEST_VERSION ? selected : null;
      // A private working copy from committed text: a failed mutation, or a
      // reader that touched the cached view, can never leak into the commit.
      // Fields the transaction only reads, and items its hint leaves alone, are the shared frozen values instead.
      const share = projection && sharing() ? { ...parsedFor(this.cacheKey), private: copyRule(writable, changed) } : null;
      const runtimeIssues = [];
      const working = current.manifest
        ? normalizeState(assemble(current.manifest, current.files, runtimeIssues, projection, share, this.#shardText))
        : current.raw !== null
          ? normalizeState(parseStoredJson(current.raw))
          : emptyState();
      if (runtimeIssues.length) {
        cache.delete(this.cacheKey);
        this.assertWritable({ storageIssues: runtimeIssues });
      }
      const itemRefs = {}, wholeRefs = {}, lengths = {};
      if (current.manifest) for (const [field, descriptor] of collectionDefinitions(working, current.manifest, this.collections)) {
        if (descriptor.mode === 'item') {
          const items = working[field] || [];
          const names = Array.isArray(current.manifest.shards?.[field]) ? current.manifest.shards[field] : [];
          const refs = new Map();
          for (let index = 0; index < items.length && index < names.length; index++) {
            const item = items[index], name = names[index];
            if (name && item && typeof item === 'object' && Object.isFrozen(item)) refs.set(item, name);
          }
          if (refs.size) itemRefs[field] = refs;
        } else if (descriptor.mode === 'chunk' && changed) {
          lengths[field] = (working[field] || []).length;
        } else if (descriptor.mode === 'whole' && Object.isFrozen(working[field])) {
          wholeRefs[field] = working[field];
        }
      }
      const value = await fn(working);
      const synced = syncCourseReferences(working, projection ? writable : null);
      if (changed) changed = withCourseChanges(changed, synced);
      working.revision++;
      await this.commit(working, { ...current, itemRefs, wholeRefs, lengths }, changed, projection ? writable : null);
      return value;
    }, { retry: this.lockRetry });
  }
  /** Replace the current library with a validated full export under the store lock. */
  async restore(backup) {
    const restored = restoreState(backup);
    return withStoreLock(this.root, async () => {
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
    }, { retry: this.lockRetry });
  }
  async listRestorePoints() {
    const current = await this.load();
    return listRestorePoints(this.root, { liveManifest: current.manifest });
  }
  /** Restore a sharded manifest snapshot from `restore-points/`, saving current state to `backups/` first. */
  async restoreFromPoint(id) {
    return withStoreLock(this.root, async () => {
      const current = await this.load();
      this.assertWritable(current);
      const point = await readRestorePointManifest(this.root, id);
      if (!isManifest(point.manifest)) {
        throw Object.assign(new Error("恢复点格式无效，当前学习库保持不变"), { code: "restore-point-corrupt" });
      }
      const names = shardNames(point.manifest);
      const pointFiles = new Map();
      await Promise.all(names.map(async (name) => {
        if (!validShardName(name)) {
          throw Object.assign(new Error(`恢复点分片路径无效（${name}），当前学习库保持不变`), { code: "restore-point-corrupt" });
        }
        let text;
        try {
          text = await readFile(this.#shardPath(name), "utf8");
        } catch (error) {
          if (error.code === "ENOENT") {
            throw Object.assign(new Error(`恢复点缺少分片文件（${name}），当前学习库保持不变`), { code: "restore-point-corrupt" });
          }
          throw error;
        }
        pointFiles.set(name, text);
      }));
      const issues = [];
      const assembled = assemble(point.manifest, pointFiles, issues, null, null, this.#shardText);
      if (issues.length > 0) {
        throw Object.assign(new Error(`恢复点分片已损坏（${issues[0].file}），当前学习库保持不变`), { code: "restore-point-corrupt" });
      }
      const restored = validateRestoredRecords(normalizeState(assembled));
      // Degrade restored document versions whose retained original file was already pruned from disk (#1367-2).
      let missingAttachments = 0;
      for (const doc of restored.documents || []) {
        for (const version of doc?.versions || []) {
          const rel = version?.attachment?.path;
          if (!rel) continue;
          const onDisk = await stat(join(this.root, rel)).catch((err) => (err?.code === "ENOENT" ? null : err));
          if (onDisk === null) {
            version.attachment = null;
            delete version.originalCheck;
            missingAttachments += 1;
          }
        }
      }
      const backupDir = join(this.root, "backups");
      await mkdir(backupDir, { recursive: true });
      const backupPath = join(backupDir, `study-workspace-before-restore-${this.now()}-${randomUUID()}.json`);
      await writeFile(backupPath, JSON.stringify(current.state, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
      restored.revision = current.state.revision + 1;
      syncCourseReferences(restored);
      cache.delete(this.cacheKey);
      parsedByPath.delete(this.cacheKey);
      await this.commit(restored, current);
      return {
        id: point.id,
        date: point.date,
        backupPath,
        revision: restored.revision,
        courses: restored.courses.length,
        sources: restored.sources.length,
        decks: restored.decks.length,
        attempts: restored.attempts.length,
        ...(missingAttachments ? { missingAttachments } : {}),
      };
    }, { retry: this.lockRetry });
  }
  async commit(state, previous, changed = null, fields = null) {
    const nowMs = this.now();
    const today = localDayKey(nowMs);
    let previousDay = typeof previous.manifest?.collections?.committedDay === "string"
      ? previous.manifest.collections.committedDay
      : null;
    if (!previousDay && previous.manifest) {
      const info = await stat(this.path).catch(() => null);
      if (info) previousDay = localDayKey(info.mtimeMs);
    }
    // Keep a complete pre-upgrade export, including old shards before GC.
    if (previous.manifest && previous.manifest.version < state.version) {
      const dir = join(this.root, "backups");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `study-workspace-v${previous.manifest.version}-${Date.now()}-${randomUUID()}.json`),
        JSON.stringify(assemble(previous.manifest, previous.files, null, null, null, this.#shardText)), { encoding: "utf8", flag: "wx" });
    }
    const { files, manifest } = serialize(state, previous, previous.manifest && previous.manifest.version === state.version ? changed : null, this.collections, fields, today);
    const fresh = [...files].filter(([name]) => !previous.files.has(name));
    await Promise.all([...new Set(fresh.map(([name]) => dirname(this.#shardPath(name))))].map((dir) => mkdir(dir, { recursive: true })));
    await Promise.all(fresh.map(([name, text]) => this.#writeShard(name, text)));
    if (previous.raw !== null) {
      // First sharded commit of a version 1 library: keep the original file.
      await mkdir(join(this.root, "backups"), { recursive: true });
      await copyFile(this.path, join(this.root, "backups", `study-workspace-v1-${Date.now()}.json`));
    }
    await this.onCommitStage?.("before-manifest-write");
    await writeStoreFile(this.path, JSON.stringify(manifest, null, 2) + "\n", {
      beforeReplace: (temp) => this.onCommitStage?.("before-manifest-replace", { tempPath: temp }),
    });
    await this.onCommitStage?.("after-manifest-replace");
    // With shared parsing the committed state is built now (unchanged shards are cache hits, so only the shards this commit
    // wrote are parsed): a view handed out earlier must stay complete after the shard texts and files of its commit are gone.
    // Without it the state decodes its collections lazily from the texts it keeps.
    const share = sharing() ? parsedFor(this.cacheKey) : null;
    const stamp = await this.stamp();
    noteCommit({ from: previous.stamp, to: stamp, revision: state.revision });
    this.remember({ stamp, manifest, files, raw: null,
      state: share ? normalizeState(assemble(manifest, files, null, null, share, this.#shardText)) : deferredState(manifest, files, null, this.#shardText) });
    if (previous.manifest && previousDay && today && previousDay < today) {
      await recordDailyRestorePoint(this.root, { day: previousDay, manifest: previous.manifest, state: previous.state, now: nowMs }).catch(() => {});
    }
    await this.collect(files, previous);
  }
  /** Remove shards no longer referenced; failures only leave garbage behind. */
  async collect(files, previous, { sweep = !previous.manifest || Math.random() < 0.05 } = {}) {
    const { protectedShards, releasedShards } = await protectedRestorePointShards(this.root);
    if (protectedShards.size) files = new Set([...files.keys(), ...protectedShards]);
    if (releasedShards.size) previous = { ...previous, files: new Map([...[...releasedShards].map((name) => [name, null]), ...previous.files]) };
    const stale = [...previous.files.keys()].filter((name) => !files.has(name));
    // Occasionally sweep for leftovers of interrupted commits too (including dynamically registered collections).
    if (sweep) {
      const dirs = new Set(["misc"]);
      for (const [name, descriptor] of this.collections) {
        if (descriptor.mode === "item" || descriptor.mode === "chunk") dirs.add(name);
      }
      for (const name of files.keys ? files.keys() : files) {
        const slash = name.indexOf("/");
        if (slash > 0) dirs.add(name.slice(0, slash));
      }
      for (const entry of await readdir(this.shardRoot, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && validCollectionName(entry.name)) dirs.add(entry.name);
      }
      for (const dir of dirs)
        for (const entry of await readdir(join(this.shardRoot, dir)).catch(() => []))
          if (!files.has(`${dir}/${entry}`)) stale.push(`${dir}/${entry}`);
    }
    await Promise.all([...new Set(stale)].filter(validShardName).map((name) => rm(this.#shardPath(name), { force: true }).catch(() => {})));
  }
  /** Pin this library's in-memory shard cache for an active runtime or session owner. */
  retainCache(owner = Symbol("store-owner")) {
    let owners = activeLeases.get(this.cacheKey);
    if (!owners) activeLeases.set(this.cacheKey, owners = new Set());
    owners.add(owner);
    return () => this.releaseCache(owner);
  }
  /** Release one owner's pin; evicts in-memory shard copies only when no other owner still holds this library. */
  releaseCache(owner) {
    const owners = activeLeases.get(this.cacheKey);
    if (!owners) return false;
    owners.delete(owner);
    if (owners.size > 0) return false;
    activeLeases.delete(this.cacheKey);
    evictPathCache(this.cacheKey);
    return true;
  }
  /** Release cached manifest and parsed shard copies for this library without touching disk state. */
  releaseMemory({ force = false } = {}) {
    const retainedOwners = activeLeases.get(this.cacheKey)?.size || 0;
    if (retainedOwners > 0 && !force) return { released: false, retainedOwners };
    if (force) activeLeases.delete(this.cacheKey);
    const hadCache = cache.has(this.cacheKey) || parsedByPath.has(this.cacheKey);
    evictPathCache(this.cacheKey);
    return { released: hadCache, retainedOwners: activeLeases.get(this.cacheKey)?.size || 0 };
  }
  /** Redacted per-library cache summary (no paths, source text, or credentials). */
  cacheStats() {
    const parsed = parsedByPath.get(this.cacheKey);
    return {
      cached: cache.has(this.cacheKey),
      retainedOwners: activeLeases.get(this.cacheKey)?.size || 0,
      parsedShards: parsed?.values.size || 0,
      cachedLists: parsed?.lists.size || 0,
    };
  }
  /** Redacted process-wide Store cache diagnostics (counts only, never paths or library prose). */
  static cacheDiagnostics() {
    let totalParsedShards = 0, totalCachedLists = 0, pinnedLibraries = 0;
    for (const owners of activeLeases.values()) if (owners.size > 0) pinnedLibraries++;
    for (const parsed of parsedByPath.values()) {
      totalParsedShards += parsed.values.size;
      totalCachedLists += parsed.lists.size;
    }
    return {
      cachedLibraries: cache.size,
      parsedLibraries: parsedByPath.size,
      pinnedLibraries,
      idleCachedLibraries: [...cache.keys()].filter(path => !activeLeases.get(path)?.size).length,
      totalParsedShards,
      totalCachedLists,
      maxIdleLibraries: MAX_IDLE_STORE_CACHES,
    };
  }
  /** Trim unpinned idle library caches down to `limit`. */
  static evictIdleCaches(limit = MAX_IDLE_STORE_CACHES) {
    evictIdleStoreCaches(limit);
    return Store.cacheDiagnostics();
  }
}
