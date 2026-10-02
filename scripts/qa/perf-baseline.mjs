/* node scripts/qa/perf-baseline.mjs --library <dir> [--work <dir>] [--in-place] [--polls 100] [--actions 200]
                                     [--minutes 0] [--heap] [--json <file>]
   Prints the host-side performance baseline of one study library as tables (docs/performance.md explains them).
   <dir> is the folder that holds study-workspace.json (usually "<workspace>/.dsh-study"). The library is COPIED to
   --work (default output/perf-work) and measured there; the original is only read. --in-place measures <dir> itself.

   The real preview host (scripts/preview-server.mjs, lib/host.js, fake model, no network, every *_API_KEY /
   *_TOKEN / *BASE_URL variable removed) runs in a forked process (scripts/qa/perf-host.mjs); this process is the
   panel: it sends the same requests and measures. Sections:
     payload   snapshot response bytes, split per key, and what the source texts contribute
     snapshot  wall time, event-loop block, peak memory and the work the host's Probe counted (parses, clones, loads)
     mutation  review.reveal/answer/move, card.flag and source.add, then the snapshot the panel polls next
     memory    rss / heap / external / arrayBuffers after a collection: idle, 100 polls, N review actions, every page
     growth    a poll+click loop (--minutes real minutes; 0 = a compressed 60-cycle loop) and its MB/hour slope
     heap      (--heap) a V8 heap snapshot of the host summarised by constructor
   Timings depend on the machine and on what else it is doing: compare medians and the counts, not single runs. */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fork } from "node:child_process";
import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubSecrets } from "./env.mjs";
import { keyBytes, median, slope } from "./perf-probe.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const round = (value, digits = 1) => Number(Number(value).toFixed(digits));

function option(name, fallback) {
  const hit = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) return process.argv[index + 1];
  return fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

function directoryBytes(path) {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? directoryBytes(child) : statSync(child).size;
  }
  return total;
}
const countFiles = (path) => readdirSync(path, { withFileTypes: true }).reduce((n, entry) => n + (entry.isDirectory() ? countFiles(join(path, entry.name)) : 1), 0);

/** The forked host plus a panel-like client. */
async function startHost(libraryRoot, home) {
  const child = fork(fileURLToPath(new URL("./perf-host.mjs", import.meta.url)), [], {
    env: scrubSecrets(process.env), execArgv: ["--expose-gc"], stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const waiting = new Map();
  let nextId = 1;
  await new Promise((done, fail) => {
    child.once("error", fail);
    child.on("message", (message) => {
      if (message.ready) return done();
      const entry = waiting.get(message.id);
      if (!entry) return;
      waiting.delete(message.id);
      if (message.ok) entry.done(message.value); else entry.fail(new Error(message.error));
    });
    child.once("exit", (code) => fail(new Error(`host exited early (${code})`)));
  });
  const send = (cmd, extra = {}) => new Promise((done, fail) => { const id = nextId++; waiting.set(id, { done, fail }); child.send({ id, cmd, ...extra }); });
  const preview = await send("start", { libraryRoot, home });
  async function call(action, args = {}) {
    await send("mark");
    const started = performance.now();
    const res = await fetch(`${preview.url}/api/call`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Study-Token": preview.token }, body: JSON.stringify({ action, args }),
    });
    const text = await res.text();
    const hostMs = performance.now() - started;
    const stats = await send("stats");
    const parseStarted = performance.now();
    const body = JSON.parse(text);
    const parseMs = performance.now() - parseStarted;
    if (!body.ok) throw Object.assign(new Error(body.error), { code: body.code });
    return { value: body.value, bytes: Buffer.byteLength(text), hostMs, parseMs, ...stats };
  }
  return { call, memory: () => send("memory"), heap: () => send("heap"), stop: async () => { await send("stop").catch(() => {}); } };
}

const row = (name, x) => ({ name, ms: round(x.hostMs), block: round(x.blockMaxMs), peakRssMb: round(x.peakRssMb), peakHeapMb: round(x.peakHeapMb), counts: x.counts });

export async function runBaseline(options = {}) {
  const source = resolve(options.library);
  if (!existsSync(join(source, "study-workspace.json"))) throw new Error(`No study-workspace.json in ${source}`);
  let root = source;
  if (!options.inPlace) {
    root = resolve(options.work || join(repoRoot, "output/perf-work"));
    if (root === source || root.startsWith(source + "\\") || root.startsWith(source + "/")) throw new Error("--work must be outside the library");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    cpSync(source, root, { recursive: true });
  }
  const home = resolve(options.home || join(repoRoot, "output/perf-home"));
  const polls = options.polls ?? 100, actions = options.actions ?? 200;
  const result = { node: process.version, platform: process.platform };
  const startedAt = performance.now();
  const host = await startHost(root, home);
  try {
    const memory = [];
    const remember = async (stage) => { const m = await host.memory(); memory.push({ stage, rss: round(m.rss), heapUsed: round(m.heapUsed), external: round(m.external), arrayBuffers: round(m.arrayBuffers) }); };
    await remember("host started, no library loaded");
    const shardsBytes = directoryBytes(join(root, "shards"));
    result.library = { shardsMb: round(shardsBytes / MB), backupsMb: existsSync(join(root, "backups")) ? round(directoryBytes(join(root, "backups")) / MB) : 0,
      totalMb: round(directoryBytes(root) / MB), shardFiles: countFiles(join(root, "shards")), shardBytes: shardsBytes };

    // cold start: the first snapshot builds the runtime and loads the library
    const first = await host.call("snapshot");
    result.coldSnapshotMs = round(first.hostMs);
    result.coldPeakRssMb = round(first.peakRssMb);
    const snap = first.value;
    result.library = { ...result.library, sources: snap.sources.length, sourceChars: snap.sources.reduce((n, item) => n + (item.text?.length ?? item.chars ?? 0), 0),
      decks: snap.decks.length, cards: snap.decks.reduce((n, deck) => n + deck.count, 0), runs: snap.runs.length, attempts: snap.attempts.length, courses: snap.courses.length };
    await remember("idle (after first snapshot)");

    // payload
    const sizes = keyBytes(snap);
    result.payload = { bytes: first.bytes, parseMs: round(first.parseMs), keys: sizes.slice(0, 8).map(([key, bytes]) => ({ key, bytes })),
      sourceTextBytes: snap.sources.reduce((n, item) => n + Buffer.byteLength(item.text || ""), 0), sourceFields: Object.keys(snap.sources[0] || {}).join(",") };

    // full and unchanged snapshots
    const fulls = [];
    for (let i = 0; i < 7; i++) fulls.push(await host.call("snapshot"));
    const fingerprint = snap.fingerprint;
    const unchanged = [];
    for (let i = 0; i < 20; i++) unchanged.push(await host.call("snapshot", { since: fingerprint }));
    result.snapshot = { full: row("full snapshot (median of 7)", { ...fulls.at(-1), hostMs: median(fulls.map((x) => x.hostMs)), blockMaxMs: median(fulls.map((x) => x.blockMaxMs)) }),
      unchanged: row("unchanged poll (since=fingerprint)", { ...unchanged.at(-1), hostMs: median(unchanged.map((x) => x.hostMs)), blockMaxMs: median(unchanged.map((x) => x.blockMaxMs)) }),
      unchangedBytes: unchanged[0].bytes, unchangedHonoured: unchanged.every((x) => x.value.unchanged) };

    // mutations
    const deck = [...snap.decks].filter((d) => !d.archived && d.count).sort((a, b) => b.count - a.count)[0];
    let run = (await host.call("review.start", { mode: "flashcard", deckId: deck.id, fresh: true })).value;
    const step = async (kind) => {
      if (run.complete) run = (await host.call("review.start", { mode: "flashcard", deckId: deck.id, fresh: true })).value;
      const queueVersion = run.queueVersion, common = { runId: run.id, cardId: run.card.id, queueVersion };
      let x;
      if (kind === "reveal") x = await host.call("review.reveal", common);
      else if (kind === "answer") {
        if (!run.revealed) run = (await host.call("review.reveal", common)).value;
        x = await host.call("review.answer", { ...common, grade: 4 });
      } else {
        if (!run.feedback) { if (!run.revealed) run = (await host.call("review.reveal", common)).value; run = (await host.call("review.answer", { ...common, grade: 4 })).value; }
        x = await host.call("review.move", { runId: run.id, direction: 1 });
      }
      run = x.value;
      return x;
    };
    const timed = async (label, doStep, repeat = 5) => {
      const calls = [], nexts = [];
      for (let i = 0; i < repeat; i++) { calls.push(await doStep(i)); nexts.push(await host.call("snapshot", { since: "stale" })); }
      const med = (xs, key) => median(xs.map((x) => x[key]));
      return { label, call: row(label, { ...calls.at(-1), hostMs: med(calls, "hostMs"), blockMaxMs: med(calls, "blockMaxMs") }),
        next: row(`${label}: next snapshot`, { ...nexts.at(-1), hostMs: med(nexts, "hostMs"), blockMaxMs: med(nexts, "blockMaxMs") }) };
    };
    const mutations = [];
    mutations.push(await timed("review.reveal", async () => {
      if (run.revealed && !run.feedback) { await step("answer"); }
      if (run.feedback) await step("move");
      const x = await step("reveal"); return x;
    }));
    mutations.push(await timed("review.answer", async () => {
      if (run.feedback) await step("move");
      if (!run.revealed) await step("reveal");
      return step("answer");
    }));
    mutations.push(await timed("review.move", async () => {
      if (!run.feedback) await step("answer");
      return host.call("review.move", { runId: run.id, direction: 1 }).then((x) => { run = x.value; return x; });
    }));
    const probeDeck = (await host.call("deck.get", { deckId: deck.id, id: deck.id })).value;
    const cardRef = { deckId: deck.id, cardId: probeDeck?.cards?.[0]?.id };
    mutations.push(await timed("card.flag", (i) => host.call("card.flag", { ...cardRef, reason: i % 2 ? "" : "perf" }), 4));
    const added = [];
    mutations.push(await timed("source.add (2 KB)", async (i) => {
      const x = await host.call("source.add", { title: `perf ${i}`, text: "perf ".repeat(400), courses: [] });
      added.push(x.value?.id);
      return x;
    }, 3));
    for (const id of added.filter(Boolean)) await host.call("source.remove", { id }).catch(() => {});
    result.mutations = mutations;

    // memory after polls, actions and every page
    let latest = (await host.call("snapshot")).value.fingerprint;
    const poll = async () => { const x = await host.call("snapshot", { since: latest }); latest = x.value.fingerprint ?? latest; return x; };
    for (let i = 0; i < polls; i++) await poll();
    await remember(`after ${polls} polls`);
    const actionStarted = performance.now();
    for (let i = 0; i < actions; i++) { await step(["reveal", "answer", "move"][i % 3]); await poll(); }
    result.reviewActionsPerSecond = round(actions / ((performance.now() - actionStarted) / 1000));
    await remember(`after ${actions} review actions (each followed by a poll)`);
    const pages = ["wrongbook", "stats", "graph", "skeleton.list", "workflow.list", "coach.status", "audio.usage", "retrieval.status", "materials.links.list", "notebook.list", "library.usage", "usage.summary", "source.list", "inbox"];
    result.pages = [];
    for (const name of pages) {
      const x = await host.call(name, name === "source.list" ? { limit: 50 } : {}).catch(() => null);
      if (x) result.pages.push({ name, ms: round(x.hostMs), bytes: x.bytes, parsedMb: round(x.counts.jsonParseChars / MB, 2) });
    }
    for (const d of (await host.call("snapshot")).value.decks) await host.call("deck.get", { deckId: d.id, id: d.id }).catch(() => {});
    await remember("after every page and every deck");
    result.memory = memory;

    // growth: the panel's poll every 2.5 s with a click every fourth poll
    const minutes = options.minutes ?? 0, compressed = minutes <= 0, samples = [];
    const loopStart = performance.now();
    for (let cycle = 0; compressed ? cycle < 60 : performance.now() - loopStart < minutes * 60_000; cycle++) {
      await poll();
      if (cycle % 4 === 3) { await step(["reveal", "answer", "move"][(cycle >> 2) % 3]); await poll(); }
      if (!compressed) await sleep(2500);
      if (compressed ? cycle % 10 === 9 : cycle % 12 === 11) samples.push([(performance.now() - loopStart) / 3_600_000, await host.memory()]);
    }
    if (samples.length >= 2) result.growth = { minutes: compressed ? null : minutes, samples: samples.length,
      heapUsedMbPerHour: round(slope(samples.map(([t, m]) => [t, m.heapUsed]))), rssMbPerHour: round(slope(samples.map(([t, m]) => [t, m.rss]))),
      externalMbPerHour: round(slope(samples.map(([t, m]) => [t, m.external + m.arrayBuffers]))),
      heapFirst: round(samples[0][1].heapUsed), heapLast: round(samples.at(-1)[1].heapUsed), rssFirst: round(samples[0][1].rss), rssLast: round(samples.at(-1)[1].rss) };
    if (options.heap) result.heap = await host.heap();
    result.totalSeconds = round((performance.now() - startedAt) / 1000);
  } finally {
    await host.stop();
  }
  return result;
}

function table(title, rows, columns) {
  const widths = columns.map(([name, pick]) => Math.max(name.length, ...rows.map((entry) => String(pick(entry)).length)));
  const line = (cells) => `| ${cells.map((cell, index) => String(cell).padEnd(widths[index])).join(" | ")} |`;
  return [`### ${title}`, line(columns.map(([name]) => name)), line(widths.map((width) => "-".repeat(width))),
    ...rows.map((entry) => line(columns.map(([, pick]) => pick(entry)))), ""].join("\n");
}

export function printTables(result) {
  const lines = [`# StudyHub performance baseline (node ${result.node}, ${result.platform})`, ""];
  const l = result.library;
  lines.push(table("Library", [l], [["sources", (x) => x.sources], ["source chars", (x) => x.sourceChars], ["decks", (x) => x.decks], ["cards", (x) => x.cards],
    ["runs", (x) => x.runs], ["attempts", (x) => x.attempts], ["shard files", (x) => x.shardFiles], ["shards MB", (x) => x.shardsMb], ["backups MB", (x) => x.backupsMb]]));
  const p = result.payload;
  lines.push(table(`Snapshot payload: ${round(p.bytes / MB, 2)} MB, client JSON.parse ${p.parseMs} ms, source text inside it ${round(p.sourceTextBytes / MB, 2)} MB (source fields: ${p.sourceFields})`,
    p.keys, [["key", (x) => x.key], ["bytes", (x) => x.bytes], ["share", (x) => `${round((x.bytes / p.bytes) * 100)}%`]]));
  const costRow = (x) => ({ name: x.name, ms: x.ms, block: x.block, peakRss: x.peakRssMb, peakHeap: x.peakHeapMb, parseMb: round(x.counts.jsonParseChars / MB, 2), parseX: round(x.counts.jsonParseChars / l.shardBytes, 2),
    stringifyMb: round(x.counts.jsonStringifyChars / MB, 2), clones: x.counts.structuredCloneCalls, loads: x.counts.storeLoads, shardReads: x.counts.shardReads, shardWrites: x.counts.shardWrites, writtenKb: round(x.counts.shardWriteBytes / 1024) });
  const cost = [costRow(result.snapshot.full), costRow(result.snapshot.unchanged), ...result.mutations.flatMap((m) => [costRow(m.call), costRow(m.next)])];
  lines.push(table(`Host work per request (cold first snapshot ${result.coldSnapshotMs} ms, peak rss ${result.coldPeakRssMb} MB; parseX = JSON parsed / library shard bytes)`, cost, [
    ["request", (x) => x.name], ["ms", (x) => x.ms], ["loop block ms", (x) => x.block], ["peak rss MB", (x) => x.peakRss], ["peak heap MB", (x) => x.peakHeap],
    ["parsed MB", (x) => x.parseMb], ["parseX", (x) => x.parseX], ["stringified MB", (x) => x.stringifyMb], ["clones", (x) => x.clones],
    ["store loads", (x) => x.loads], ["shard reads", (x) => x.shardReads], ["shard writes", (x) => x.shardWrites], ["written KB", (x) => x.writtenKb]]));
  lines.push(table("Host memory (MB, after a forced collection)", result.memory, [["stage", (x) => x.stage], ["rss", (x) => x.rss], ["heapUsed", (x) => x.heapUsed], ["external", (x) => x.external], ["arrayBuffers", (x) => x.arrayBuffers]]));
  if (result.growth) {
    const g = result.growth;
    lines.push(table(`Growth over ${g.minutes ? `${g.minutes} min of poll (2.5 s) + click` : "a compressed 60-cycle poll + click loop"}`, [g],
      [["samples", (x) => x.samples], ["heap first", (x) => x.heapFirst], ["heap last", (x) => x.heapLast], ["rss first", (x) => x.rssFirst], ["rss last", (x) => x.rssLast],
        ["heap MB/h", (x) => x.heapUsedMbPerHour], ["rss MB/h", (x) => x.rssMbPerHour], ["external MB/h", (x) => x.externalMbPerHour]]));
  }
  lines.push(`Review actions with a poll each: ${result.reviewActionsPerSecond} per second\n`);
  lines.push(table("Page actions (host side)", result.pages, [["action", (x) => x.name], ["ms", (x) => x.ms], ["bytes", (x) => x.bytes], ["parsed MB", (x) => x.parsedMb]]));
  if (result.heap) {
    lines.push(table(`Heap snapshot (${round(result.heap.snapshotFileMb)} MB file, ${result.heap.totalMb} MB self size): largest constructors`, result.heap.constructors,
      [["constructor", (x) => x.name], ["count", (x) => x.count], ["MB", (x) => x.mb]]));
    lines.push(table("Heap snapshot: node kinds", result.heap.kinds, [["kind", (x) => x.name], ["count", (x) => x.count], ["MB", (x) => x.mb]]));
    lines.push(`Strings over 100 KB: ${result.heap.largeStrings.count} holding ${result.heap.largeStrings.mb} MB (largest ${result.heap.largeStrings.largestMb.join(", ")} MB)\n`);
  }
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const library = option("library");
  if (!library) { console.error("usage: node scripts/qa/perf-baseline.mjs --library <dir with study-workspace.json> [--work dir] [--in-place] [--polls 100] [--actions 200] [--minutes 0] [--heap] [--json file]"); process.exit(2); }
  const result = await runBaseline({ library, work: option("work"), inPlace: flag("in-place"), polls: Number(option("polls", 100)), actions: Number(option("actions", 200)),
    minutes: Number(option("minutes", 0)), heap: flag("heap") });
  const json = option("json");
  if (json) writeFileSync(json, JSON.stringify(result, null, 2));
  console.log(printTables(result));
  process.exit(0);
}
