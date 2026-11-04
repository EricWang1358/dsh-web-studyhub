/* node scripts/qa/page-switch-perf.mjs [--widths 1440,1050] [--rounds 3] [--production true] [--sources 300] [--trace true] [--out <dir>]   (build first: node scripts/build.mjs)
   How smooth switching pages is, measured on a library shaped like a heavy user's (scripts/qa/perf-seed.mjs), fake model, no network.
   For every sidebar page (学习库, 资料, 创建题组, 错题与待巩固, 模拟考试, 统计, and 任务 and 复习全书 under 「更多」) and for opening and closing 「更多」:
   frame times from requestAnimationFrame (p50 / p95 / worst, the share over 24 ms), long tasks (> 50 ms), and from the DevTools protocol the
   layout, style-recalc and script time and counts. With --trace a Chrome performance trace of the whole run is read for forced (synchronous)
   layouts and style recalcs, grouped by the script frame that asked for them, so the code that causes them is named.
   Headless Chromium has no GPU compositor, so absolute numbers are pessimistic; compare before and after on the same machine.
   Writes page-switch-perf.json (and trace-summary.json) under --out/<width>. */
/* global window, document, performance, PerformanceObserver, requestAnimationFrame */
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { seedLibrary } from "./perf-seed.mjs";
import { finishCli, parseQaArgs, runQa, sleep } from "./harness.mjs";

/** The pages switched between; `more`: the row sits in 「更多」, which is opened first. */
export const SWITCH_PAGES = [
  { id: "library" }, { id: "sources" }, { id: "generate" }, { id: "wrongbook" }, { id: "exam" }, { id: "dashboard" },
  { id: "tasks", more: true }, { id: "book", more: true },
];
const SETTLE_MS = 700; // the leave delay (90 ms) plus the enter motion and the highlight's glide (420 ms), with room to spare

/** Installed once per page: frame deltas and long tasks between start and stop. */
const recorder = () => {
  if (window.__switch) return;
  window.__switch = { frames: [], longTasks: [], presses: [], recording: false, last: 0 };
  // Press to next frame: how long after the click the screen can show anything (the click's own work runs before that frame).
  window.addEventListener("click", () => {
    if (!window.__switch.recording) return;
    const pressed = performance.now();
    requestAnimationFrame(() => window.__switch.presses.push(performance.now() - pressed));
  }, true);
  const loop = (now) => {
    const state = window.__switch;
    if (state.recording && state.last) state.frames.push(now - state.last);
    state.last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  try {
    new PerformanceObserver((list) => { if (window.__switch.recording) for (const entry of list.getEntries()) window.__switch.longTasks.push(entry.duration); }).observe({ type: "longtask", buffered: false });
  } catch { /* longtask is not offered */ }
};

const percentile = (values, share) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
};
const round = (value) => Math.round(value * 10) / 10;
const metrics = async (cdp) => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((item) => [item.name, item.value]));

/** One row of numbers for one interaction: frames from the page, layout/style/script from the DevTools protocol. */
function rowOf(label, data, before, after, repeats) {
  const delta = (name) => after[name] - before[name];
  return { interaction: label, repeats, frames: data.frames.length, p50: round(percentile(data.frames, 0.5)), p95: round(percentile(data.frames, 0.95)),
    worst: round(Math.max(0, ...data.frames)), janky: data.frames.length ? Math.round((data.frames.filter((ms) => ms > 24).length / data.frames.length) * 100) : 0,
    longTasks: data.longTasks.length, longTaskMs: Math.round(data.longTasks.reduce((sum, ms) => sum + ms, 0)),
    pressP50: round(percentile(data.presses, 0.5)), pressWorst: round(Math.max(0, ...data.presses)),
    layouts: delta("LayoutCount"), layoutMs: Math.round(delta("LayoutDuration") * 1000), styleRecalcs: delta("RecalcStyleCount"), styleMs: Math.round(delta("RecalcStyleDuration") * 1000),
    scriptMs: Math.round(delta("ScriptDuration") * 1000), taskMs: Math.round(delta("TaskDuration") * 1000) };
}

/** Forced layouts and style recalcs in a trace, grouped by the script frame that asked for them (the first frame of the stack Chrome records).
    Only the page's main thread counts (the one that recalculates style). `styledElements` (how many elements were restyled in all) and
    `bigRestyles` (recalcs of more than 1 000 elements) do not depend on how fast the machine is, so they compare runs on a busy machine too. */
export function summarizeTrace(all) {
  const threads = new Map();
  for (const event of all) if (event.name === "UpdateLayoutTree") threads.set(`${event.pid}:${event.tid}`, (threads.get(`${event.pid}:${event.tid}`) || 0) + 1);
  const main = [...threads.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const events = all.filter((event) => `${event.pid}:${event.tid}` === main);
  const forced = new Map(), totals = { layoutMs: 0, layouts: 0, styleMs: 0, styles: 0, styledElements: 0, bigRestyles: 0, forcedLayoutMs: 0, forcedLayouts: 0, forcedStyleMs: 0, forcedStyles: 0, longTasks: 0, longTaskMs: 0 };
  for (const event of events) {
    const ms = (event.dur || 0) / 1000;
    if (event.name === "RunTask" && ms > 50) { totals.longTasks += 1; totals.longTaskMs += ms; }
    const kind = event.name === "Layout" ? "layout" : event.name === "UpdateLayoutTree" ? "style" : null;
    if (!kind || event.ph !== "X") continue;
    totals[kind === "layout" ? "layoutMs" : "styleMs"] += ms; totals[kind === "layout" ? "layouts" : "styles"] += 1;
    if (kind === "style") { totals.styledElements += event.args?.elementCount || 0; if (event.args?.elementCount > 1000) totals.bigRestyles += 1; }
    const stack = event.args?.beginData?.stackTrace || event.args?.data?.stackTrace;
    if (!stack?.length) continue;
    totals[kind === "layout" ? "forcedLayoutMs" : "forcedStyleMs"] += ms; totals[kind === "layout" ? "forcedLayouts" : "forcedStyles"] += 1;
    const top = stack.slice(0, 3).map((frame) => `${frame.functionName || "(anonymous)"} ${String(frame.url || "").split("/").pop()}:${frame.lineNumber}`).join(" < ");
    const key = `${kind}: ${top}`;
    const entry = forced.get(key) || { kind, at: top, count: 0, ms: 0 };
    entry.count += 1; entry.ms += ms;
    forced.set(key, entry);
  }
  const callers = [...forced.values()].sort((a, b) => b.ms - a.ms).slice(0, 15).map((entry) => ({ ...entry, ms: round(entry.ms) }));
  return { totals: Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round(value)])), callers };
}

async function readTrace(cdp) {
  const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.end");
  const { stream } = await done;
  let text = "";
  for (;;) {
    const chunk = await cdp.send("IO.read", { handle: stream });
    text += chunk.base64Encoded ? Buffer.from(chunk.data, "base64").toString("utf8") : chunk.data;
    if (chunk.eof) break;
  }
  await cdp.send("IO.close", { handle: stream });
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : parsed.traceEvents || [];
}

export async function runPageSwitch(options) {
  const results = [];
  let trace = null;
  const summary = await runQa({
    name: "page-switch-perf", options,
    seed: (root) => seedLibrary(root, { sources: Number(options.sources), decks: 14, cardsPerDeck: 30, runs: 24, attempts: 1200, courses: 8, largeSources: 4, largeSourceChars: 30000 }),
    async run({ page, browserContext, check }) {
      const cdp = await browserContext.newCDPSession(page);
      await cdp.send("Performance.enable");
      await page.evaluate(recorder);
      const row = (id) => page.locator(`[data-tour="nav-${id}"]`).first();
      // An older build without 「更多」 (to compare against) lists every row: there is nothing to open.
      const hasMore = async () => (await page.locator('[data-nav-fold="more"]').count()) > 0;
      const moreOpen = () => page.locator('[data-nav-fold="more"]').getAttribute("data-open").then((value) => value === "true");
      const setMore = async (open) => { if (await hasMore() && (await moreOpen()) !== open) { await page.locator('[data-tour="nav-more"]').first().click(); await sleep(SETTLE_MS); } };
      const go = async (target) => {
        if (target.more) await setMore(true);
        // Arrived: the page that was on screen is gone and main is not leaving (复习全书 may open the 总纲 page, whose row is another one).
        await page.evaluate(() => { window.__switch.old = document.querySelector("main > :is(.page, .review-page, .board-page):not([hidden])"); });
        await row(target.id).click();
        await page.waitForFunction(() => !window.__switch.old?.isConnected && !document.querySelector("main.is-leaving"), null, { timeout: 20000 }).catch(() => {});
      };
      const measure = async (label, repeats, action) => {
        const before = await metrics(cdp);
        await page.evaluate(() => { Object.assign(window.__switch, { frames: [], longTasks: [], presses: [], last: 0, recording: true }); });
        await action();
        const data = await page.evaluate(() => { window.__switch.recording = false; const { frames, longTasks, presses } = window.__switch; return { frames, longTasks, presses }; });
        const result = rowOf(label, data, before, await metrics(cdp), repeats);
        results.push(result);
        console.log(`     ${label.padEnd(22)} press→frame ${String(result.pressP50).padStart(5)}/${String(result.pressWorst).padStart(5)} ms  frames ${String(result.frames).padStart(4)}  p95 ${String(result.p95).padStart(6)}  worst ${String(result.worst).padStart(6)}  >24ms ${String(result.janky).padStart(3)}%  ` +
          `long ${result.longTasks} (${result.longTaskMs} ms)  layout ${result.layouts}/${result.layoutMs} ms  style ${result.styleRecalcs}/${result.styleMs} ms  script ${result.scriptMs} ms`);
        return result;
      };
      // Warm every page once, so first-visit code loading is not counted as switching.
      for (const target of SWITCH_PAGES) { await go(target); await sleep(SETTLE_MS); }
      await setMore(false);
      await go(SWITCH_PAGES[0]); await sleep(SETTLE_MS);
      if (options.trace === "true") await cdp.send("Tracing.start", { transferMode: "ReturnAsStream",
        traceConfig: { includedCategories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.stack", "blink.user_timing",
          ...(options.invalidations === "true" ? ["disabled-by-default-devtools.timeline.invalidationTracking"] : []),
          ...(options.selectors === "true" ? ["disabled-by-default-blink.debug"] : [])] } });
      const rounds = Number(options.rounds);
      for (const target of SWITCH_PAGES.slice(1)) {
        await measure(`to ${target.id}`, rounds, async () => {
          for (let i = 0; i < rounds; i += 1) {
            await go(target); await sleep(SETTLE_MS);
            await go(SWITCH_PAGES[0]); await sleep(SETTLE_MS);
          }
        });
      }
      await go(SWITCH_PAGES[0]); await sleep(SETTLE_MS);
      // Nothing happening: what the page costs per frame while the learner only looks at it.
      await measure("idle 3 s on 学习库", 1, () => sleep(3000));
      await measure("open+close 更多", rounds, async () => {
        for (let i = 0; i < rounds; i += 1) { await setMore(true); await setMore(false); }
      });
      if (options.trace === "true") {
        const events = await readTrace(cdp);
        trace = summarizeTrace(events);
        if (options["trace-file"]) await writeFile(options["trace-file"], JSON.stringify(events));
      }
      const totals = await check("totals", async () => {
        const switches = results.filter((item) => item.interaction.startsWith("to "));
        const frames = switches.reduce((sum, item) => sum + item.frames, 0);
        return { frames, janky: Math.round(switches.reduce((sum, item) => sum + item.janky * item.frames, 0) / Math.max(1, frames)),
          longTasks: switches.reduce((sum, item) => sum + item.longTasks, 0), longTaskMs: switches.reduce((sum, item) => sum + item.longTaskMs, 0),
          layoutMs: switches.reduce((sum, item) => sum + item.layoutMs, 0), styleMs: switches.reduce((sum, item) => sum + item.styleMs, 0),
          scriptMs: switches.reduce((sum, item) => sum + item.scriptMs, 0), pressP50: percentile(switches.map((item) => item.pressP50), 0.5),
          pressWorst: Math.max(0, ...switches.map((item) => item.pressWorst)) };
      });
      console.log(`     switches in all: ${JSON.stringify(totals.value)}`);
    },
  });
  await writeFile(join(options.out, "page-switch-perf.json"), JSON.stringify({ options: { lang: options.lang, theme: options.theme, width: options.width, sources: options.sources, rounds: options.rounds }, results }, null, 2) + "\n");
  if (trace) {
    await writeFile(join(options.out, "trace-summary.json"), JSON.stringify(trace, null, 2) + "\n");
    console.log(`     trace: ${JSON.stringify(trace.totals)}`);
    for (const caller of trace.callers.slice(0, 8)) console.log(`       forced ${caller.kind} x${caller.count} ${caller.ms} ms  ${caller.at}`);
  }
  return { summary, results, trace };
}

if (process.argv[1]?.endsWith("page-switch-perf.mjs")) {
  const base = parseQaArgs(process.argv.slice(2), "page-switch-perf", { sources: "300", rounds: "3", production: "false", trace: "true", widths: "1440,1050", "trace-file": "", invalidations: "false", selectors: "false" });
  if (base.production === "true") { const { buildPreview } = await import("../build.mjs"); await buildPreview({ production: true }); console.log("preview rebuilt with React's production build (run node scripts/build.mjs to get the development one back)"); }
  let ok = true;
  for (const width of String(base.widths).split(",").map(Number)) {
    const options = { ...base, width, out: join(base.out, String(width)), "trace-file": base["trace-file"] && base["trace-file"].replace(/(\.json)?$/, `-${width}.json`) };
    console.log(`page switching at ${width} px`);
    const { summary } = await runPageSwitch(options);
    finishCli(`Page switch ${width}`, options, summary);
    ok &&= summary.ok;
  }
  process.exitCode = ok ? 0 : 1;
}
