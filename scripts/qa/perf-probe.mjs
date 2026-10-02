/* Measurement helpers shared by scripts/qa/perf-baseline.mjs and tests/perf-budget.test.mjs.
   Everything here is deterministic bookkeeping (counts and bytes), not timing:
   - a Probe counts JSON.parse / JSON.stringify / structuredClone calls and the file reads and writes the
     library store makes, so a budget can say "one snapshot parses at most N MB" without a wall clock;
   - settledMemory() reports process memory after a forced collection;
   - heapSummary() writes a V8 heap snapshot and summarises it by constructor in a child process. */
import { syncBuiltinESMExports } from "node:module";
import { runInNewContext } from "node:vm";
import { setFlagsFromString, writeHeapSnapshot } from "node:v8";
import fsp from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ZERO = () => ({
  jsonParseCalls: 0, jsonParseChars: 0, jsonStringifyCalls: 0, jsonStringifyChars: 0, structuredCloneCalls: 0, structuredCloneChars: 0,
  manifestReads: 0, shardReads: 0, shardReadBytes: 0, shardWrites: 0, shardWriteBytes: 0, manifestWrites: 0, manifestWriteBytes: 0,
});

/** Counters for the work the host does. install() once per process; read() returns the running totals.
 *  `sizeClones` also estimates how many characters of JSON every structuredClone copied (doubles the cost of a clone: tests only). */
export class Probe {
  #counts = ZERO();
  #restore = null;
  #sizeClones;
  constructor({ sizeClones = false } = {}) { this.#sizeClones = sizeClones; }
  get installed() { return !!this.#restore; }
  /** Count a domain event the patched globals cannot see (a library load, a collection pass). */
  bump(name, by = 1) { this.#counts[name] = (this.#counts[name] || 0) + by; }
  install() {
    if (this.#restore) return this;
    const counts = this.#counts;
    const { parse, stringify } = JSON, clone = globalThis.structuredClone;
    const readFile = fsp.readFile, writeFile = fsp.writeFile;
    JSON.parse = function (text, ...rest) {
      counts.jsonParseCalls++;
      if (typeof text === "string") counts.jsonParseChars += text.length;
      return parse.call(this, text, ...rest);
    };
    JSON.stringify = function (...args) {
      const out = stringify.apply(this, args);
      counts.jsonStringifyCalls++;
      if (typeof out === "string") counts.jsonStringifyChars += out.length;
      return out;
    };
    const sizeClones = this.#sizeClones;
    globalThis.structuredClone = (...args) => {
      counts.structuredCloneCalls++;
      if (sizeClones) { try { counts.structuredCloneChars += stringify(args[0])?.length ?? 0; } catch { /* not JSON: counted as a call only */ } }
      return clone(...args);
    };
    const isShard = (path) => /[\\/]shards[\\/]/.test(String(path));
    const isManifest = (path) => /study-workspace\.json(\.[0-9a-f-]+\.tmp)?$/.test(String(path));
    fsp.readFile = async function (path, ...rest) {
      const out = await readFile.call(this, path, ...rest);
      if (isShard(path)) { counts.shardReads++; counts.shardReadBytes += out.length; }
      else if (isManifest(path)) counts.manifestReads++;
      return out;
    };
    fsp.writeFile = async function (path, data, ...rest) {
      if (isShard(path)) { counts.shardWrites++; counts.shardWriteBytes += Buffer.byteLength(data); }
      else if (isManifest(path)) { counts.manifestWrites++; counts.manifestWriteBytes += Buffer.byteLength(data); }
      return writeFile.call(this, path, data, ...rest);
    };
    syncBuiltinESMExports();
    this.#restore = () => {
      JSON.parse = parse; JSON.stringify = stringify; globalThis.structuredClone = clone;
      fsp.readFile = readFile; fsp.writeFile = writeFile;
      syncBuiltinESMExports();
      this.#restore = null;
    };
    return this;
  }
  uninstall() { this.#restore?.(); }
  read() { return { ...this.#counts }; }
  /** Counts made while `fn` runs (the probe keeps its running totals). */
  async measure(fn) {
    const before = this.read();
    const value = await fn();
    const after = this.read();
    return { value, counts: Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - (before[key] || 0)])) };
  }
}

let collect = null;
/** Force a full collection; false when this process cannot (never throws). */
export function collectGarbage() {
  try {
    if (!collect) {
      if (typeof globalThis.gc !== "function") setFlagsFromString("--expose-gc");
      collect = typeof globalThis.gc === "function" ? globalThis.gc : runInNewContext("gc");
    }
    collect(); collect();
    return true;
  } catch { return false; }
}

const MB = 1024 * 1024;
/** Process memory in MB after a forced collection. */
export function settledMemory() {
  collectGarbage();
  const m = process.memoryUsage();
  return { rss: m.rss / MB, heapUsed: m.heapUsed / MB, external: m.external / MB, arrayBuffers: m.arrayBuffers / MB };
}

/** Least-squares slope of y over x. */
export function slope(points) {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, [x]) => s + x, 0) / n, my = points.reduce((s, [, y]) => s + y, 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of points) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den ? num / den : 0;
}

/** Median of a list of numbers. */
export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
};

/** Per top-level key JSON bytes of a value, largest first. */
export function keyBytes(value) {
  return Object.entries(value || {}).map(([key, item]) => [key, Buffer.byteLength(JSON.stringify(item) ?? "")]).sort((a, b) => b[1] - a[1]);
}

/** Heap snapshot summary by constructor / node kind. Content is never printed, only names and sizes. */
export function heapSummary({ top = 14, keep = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "study-heap-"));
  try {
    collectGarbage();
    const file = writeHeapSnapshot(join(dir, "host.heapsnapshot"));
    const fileMb = statSync(file).size / MB;
    const out = execFileSync(process.execPath, ["--max-old-space-size=6144", fileURLToPath(import.meta.url), "--summarize", file, String(top)],
      { encoding: "utf8", maxBuffer: 64 * MB });
    return { snapshotFileMb: fileMb, ...JSON.parse(out) };
  } finally {
    if (!keep) rmSync(dir, { recursive: true, force: true });
  }
}

async function summarizeFile(file, top) {
  const { readFile } = fsp;
  const raw = JSON.parse(await readFile(file, "utf8"));
  const { node_fields: fields, node_types: types } = raw.snapshot.meta;
  const stride = fields.length, at = Object.fromEntries(fields.map((name, i) => [name, i]));
  const kinds = types[0], strings = raw.strings, nodes = raw.nodes;
  const byName = new Map(), byKind = new Map(), bigStrings = [];
  let total = 0;
  for (let i = 0; i < nodes.length; i += stride) {
    const kind = kinds[nodes[i + at.type]], size = nodes[i + at.self_size];
    const name = strings[nodes[i + at.name]];
    total += size;
    const kindRow = byKind.get(kind) || { count: 0, bytes: 0 };
    kindRow.count++; kindRow.bytes += size; byKind.set(kind, kindRow);
    if (kind === "string" || kind === "concatenated string" || kind === "sliced string") {
      if (size > 100_000) bigStrings.push(size);
      continue;
    }
    if (kind === "object" || kind === "closure" || kind === "array" || kind === "native") {
      const key = `${kind}:${name}`;
      const row = byName.get(key) || { count: 0, bytes: 0 };
      row.count++; row.bytes += size; byName.set(key, row);
    }
  }
  const rank = (map) => [...map].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, top)
    .map(([name, row]) => ({ name, count: row.count, mb: +(row.bytes / MB).toFixed(2) }));
  bigStrings.sort((a, b) => b - a);
  process.stdout.write(JSON.stringify({ totalMb: +(total / MB).toFixed(1), kinds: rank(byKind), constructors: rank(byName),
    largeStrings: { count: bigStrings.length, mb: +(bigStrings.reduce((s, n) => s + n, 0) / MB).toFixed(1), largestMb: bigStrings.slice(0, 5).map((n) => +(n / MB).toFixed(2)) } }));
}

if (process.argv[2] === "--summarize" && basename(process.argv[1]) === "perf-probe.mjs")
  await summarizeFile(process.argv[3], Number(process.argv[4]) || 14);
