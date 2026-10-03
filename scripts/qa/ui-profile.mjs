/* node scripts/qa/ui-profile.mjs --page generate [--production --visits 3 --sources 300 --lang zh --theme dark --width 1440]   (build first: node scripts/build.mjs)
   Where the time goes when the learner opens a page: a CPU profile (Chrome DevTools protocol sampling profiler) of N visits to one page of the seeded
   heavy library, printed as the functions with the most self time. The companion of ui-motion.mjs: that one says WHICH interaction janks, this one says WHY. */
import { seedLibrary } from "./perf-seed.mjs";
import { parseQaArgs, runQa, sleep } from "./harness.mjs";

const options = parseQaArgs(process.argv.slice(2), "ui-profile", { page: "generate", visits: "3", sources: "300", production: "false" });
if (options.production === "true") { const { buildPreview } = await import("../build.mjs"); await buildPreview({ production: true }); console.log("preview rebuilt with React's production build"); }
await runQa({
  name: "ui-profile", options,
  seed: (root) => seedLibrary(root, { sources: Number(options.sources), decks: 14, cardsPerDeck: 30, runs: 24, attempts: 1200, courses: 8, largeSources: 4, largeSourceChars: 30000 }),
  async run({ page, browserContext }) {
    const nav = (id) => page.locator(`[data-nav-id="${id}"]`).first().click();
    const session = await browserContext.newCDPSession(page);
    await session.send("Profiler.enable");
    await session.send("Profiler.setSamplingInterval", { interval: 200 });
    await nav("library"); await sleep(600);
    await session.send("Profiler.start");
    for (let i = 0; i < Number(options.visits); i += 1) { await nav(options.page); await sleep(700); await nav("library"); await sleep(500); }
    const { profile } = await session.send("Profiler.stop");
    const self = new Map();
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    profile.samples.forEach((id, index) => {
      const node = byId.get(id), delta = (profile.timeDeltas[index] || 0) / 1000;
      const frame = node.callFrame, name = `${frame.functionName || "(anonymous)"}  ${frame.url.split("/").slice(-1)[0]}:${frame.lineNumber + 1}`;
      self.set(name, (self.get(name) || 0) + delta);
    });
    const total = [...self.values()].reduce((sum, value) => sum + value, 0);
    const idle = (self.get("(idle)  :0") || 0) + (self.get("(program)  :0") || 0);
    console.log(`profile of ${options.visits} visits to ${options.page}: ${Math.round(total - idle)} ms of work (${Math.round(total)} ms sampled, ${Math.round(idle)} ms idle/program)`);
    for (const [name, ms] of [...self].filter(([name]) => !/^\((idle|program|garbage collector)\)/.test(name)).sort((a, b) => b[1] - a[1]).slice(0, 18))
      console.log(`  ${ms.toFixed(1).padStart(7)} ms  ${name}`);
    console.log(`  ${(self.get("(garbage collector)  :0") || 0).toFixed(1).padStart(7)} ms  (garbage collector)`);
  },
});
