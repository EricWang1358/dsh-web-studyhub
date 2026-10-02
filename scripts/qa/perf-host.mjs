/* The measured host: scripts/qa/perf-baseline.mjs forks this file so the study host (the real preview server and
   lib/host.js handler, fake model, no network) runs alone in its own process and its memory and event loop are
   not mixed with the measuring client. Messages in: start, mark, stats, memory, heap, stop. */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createPreviewServer } from "../preview-server.mjs";
import { Store } from "../../lib/store.js";
import { scrubProcessEnv } from "./env.mjs";
import { Probe, heapSummary, settledMemory } from "./perf-probe.mjs";

scrubProcessEnv();
const probe = new Probe().install();
const loadOriginal = Store.prototype.load;
Store.prototype.load = function () { probe.bump("storeLoads"); return loadOriginal.call(this); };
const histogram = monitorEventLoopDelay({ resolution: 5 });
let preview = null, mark = null, sampler = null;
const MB = 1024 * 1024;

async function handle(message) {
  if (message.cmd === "start") {
    preview = await createPreviewServer({ libraryRoot: message.libraryRoot, home: message.home, port: 0, model: "fake", fakeLatencyMs: 0 });
    return { url: preview.url, token: preview.token };
  }
  if (message.cmd === "mark") {
    clearInterval(sampler);
    histogram.reset(); histogram.enable();
    mark = { counts: probe.read(), peakRss: process.memoryUsage.rss(), peakHeap: process.memoryUsage().heapUsed };
    sampler = setInterval(() => {
      const usage = process.memoryUsage();
      mark.peakRss = Math.max(mark.peakRss, usage.rss); mark.peakHeap = Math.max(mark.peakHeap, usage.heapUsed);
    }, 15);
    return {};
  }
  if (message.cmd === "stats") {
    clearInterval(sampler); histogram.disable();
    const after = probe.read(), usage = process.memoryUsage();
    return { counts: Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - (mark?.counts[key] || 0)])),
      blockMaxMs: histogram.max / 1e6, blockP99Ms: histogram.percentile(99) / 1e6,
      peakRssMb: Math.max(mark?.peakRss || 0, usage.rss) / MB, peakHeapMb: Math.max(mark?.peakHeap || 0, usage.heapUsed) / MB };
  }
  if (message.cmd === "shape") {
    const state = await new Store(message.libraryRoot).read();
    return { sources: state.sources.length, sourceChars: state.sources.reduce((sum, item) => sum + (item.text?.length || 0), 0), decks: state.decks.length,
      cards: state.decks.reduce((sum, deck) => sum + deck.cards.length, 0), runs: state.runs.length, openRuns: state.runs.filter((run) => !run.closedAt).length,
      attempts: state.attempts.length, courses: state.courses.length };
  }
  if (message.cmd === "memory") return settledMemory();
  if (message.cmd === "heap") return heapSummary();
  if (message.cmd === "stop") { await preview?.close(); setImmediate(() => process.exit(0)); return {}; }
  throw new Error(`Unknown command ${message.cmd}`);
}

process.on("message", async (message) => {
  try { process.send({ id: message.id, ok: true, value: await handle(message) }); }
  catch (error) { process.send({ id: message.id, ok: false, error: error.message }); }
});
process.send({ ready: true });
