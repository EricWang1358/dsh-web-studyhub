/* node scripts/qa/ui-motion.mjs [--production --lang zh|en --theme dark|light --width 1440|420 --sources 300 --out <dir>]   (build first: node scripts/build.mjs)
   Smoothness of the interface, measured: frame times (requestAnimationFrame deltas), long tasks and layout/paint-heavy moments while the learner does the
   everyday things on a library shaped like a heavy user's (scripts/qa/perf-seed.mjs): switch pages, go through a review (flip, next), open the reader,
   scroll the 资料 list, open the Aa popover. Reports p50 / p95 / worst frame, the share of frames over 24 ms ("janky") and long-task time, per interaction.
   Headless Chromium has no GPU compositor, so the absolute numbers are pessimistic; the point is to compare before and after on the same machine.
   Writes ui-motion.json next to the screenshots. No network, fake model, seeded temporary library. */
/* global window, PerformanceObserver, requestAnimationFrame */
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { seedLibrary } from "./perf-seed.mjs";
import { finishCli, parseQaArgs, runQa, sleep } from "./harness.mjs";

const api = (page, action, args = {}) => page.evaluate(async ([name, body]) => {
  const response = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json", "x-study-token": window.STUDY_TOKEN }, body: JSON.stringify({ action: name, args: body }) });
  const json = await response.json();
  if (!json.ok) throw new Error(json.error || name);
  return json.value;
}, [action, args]);

/** Installed once per page: records frame deltas and long tasks between start() and stop(). */
const recorder = () => {
  window.__motion = { frames: [], longTasks: [], recording: false, last: 0 };
  const loop = (now) => {
    const state = window.__motion;
    if (state.recording && state.last) state.frames.push(now - state.last);
    state.last = now;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  try {
    new PerformanceObserver((list) => { if (window.__motion.recording) for (const entry of list.getEntries()) window.__motion.longTasks.push(entry.duration); }).observe({ type: "longtask", buffered: false });
  } catch { /* longtask is not offered */ }
};

const percentile = (values, share) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
};
const round = (value) => Math.round(value * 10) / 10;

export async function runMotionQa(options) {
  const results = [];
  // Speed is only meaningful on React's production build (the development one validates every prop and is several times slower): --production rebuilds dist/ that way first. Run `node scripts/build.mjs` afterwards to get the development preview back.
  if (options.production === "true") { const { buildPreview } = await import("../build.mjs"); await buildPreview({ production: true }); console.log("preview rebuilt with React's production build"); }
  const summary = await runQa({
    name: "ui-motion", options,
    seed: (root) => seedLibrary(root, { sources: Number(options.sources), decks: 14, cardsPerDeck: 30, runs: 24, attempts: 1200, courses: 8, largeSources: 4, largeSourceChars: 30000 }),
    async run({ page, step, check }) {
      await page.evaluate(recorder);
      const measure = async (label, action) => {
        await page.evaluate(() => { window.__motion.frames = []; window.__motion.longTasks = []; window.__motion.last = 0; window.__motion.recording = true; });
        const started = Date.now();
        await action();
        await sleep(450); // let the last transition settle inside the window
        const data = await page.evaluate(() => { window.__motion.recording = false; return { frames: window.__motion.frames, longTasks: window.__motion.longTasks }; });
        const row = { interaction: label, ms: Date.now() - started, frames: data.frames.length, p50: round(percentile(data.frames, 0.5)), p95: round(percentile(data.frames, 0.95)),
          worst: round(Math.max(0, ...data.frames)), janky: data.frames.length ? Math.round((data.frames.filter((delta) => delta > 24).length / data.frames.length) * 100) : 0,
          longTaskMs: Math.round(data.longTasks.reduce((sum, value) => sum + value, 0)), longTasks: data.longTasks.length };
        results.push(row);
        console.log(`     ${label.padEnd(26)} frames ${String(row.frames).padStart(4)}  p50 ${String(row.p50).padStart(5)}  p95 ${String(row.p95).padStart(6)}  worst ${String(row.worst).padStart(6)}  >24ms ${String(row.janky).padStart(3)}%  long tasks ${row.longTasks} (${row.longTaskMs} ms)`);
        return row;
      };
      const nav = (id) => page.locator(`[data-nav-id="${id}"]`).first().click();

      await step("switch-pages", async () => {
        // Each page on its own (three visits from the previous page), so the slow one is named.
        for (const id of ["sources", "generate", "wrongbook", "dashboard", "library"]) {
          await measure(`to ${id} x3`, async () => {
            for (let round = 0; round < 3; round += 1) { await nav(id === "library" ? "wrongbook" : "library"); await sleep(300); await nav(id); await sleep(450); }
          });
        }
      });
      await step("review-flip-next", async () => {
        const run = await api(page, "review.start", { mode: "flashcard", deckId: (await api(page, "snapshot", {})).decks[0].id });
        await page.reload(); await sleep(900); await page.evaluate(recorder);
        await measure("review flip + next x8", async () => {
          for (let i = 0; i < 8; i += 1) {
            await page.keyboard.press("Space"); await sleep(200);
            await page.keyboard.press("3"); await sleep(250);
            await page.keyboard.press("Enter"); await sleep(250);
          }
        });
        return run?.id ? "review started" : undefined;
      });
      await step("open-reader", async () => {
        await nav("sources"); await page.locator(".source-doc").first().waitFor({ timeout: 20000 });
        await page.evaluate(recorder);
        await measure("open reader + close", async () => {
          await page.locator(".source-doc").first().locator(".source-doc__main, .source-title").first().click();
          await page.locator(".study-document-viewer").waitFor({ timeout: 20000 });
          await sleep(300);
          await page.keyboard.press("Escape");
        });
      });
      await step("scroll-sources", async () => {
        await nav("sources"); await sleep(600);
        await measure("scroll the 资料 list", async () => {
          for (let i = 0; i < 12; i += 1) { await page.mouse.wheel(0, 700); await sleep(60); }
          for (let i = 0; i < 12; i += 1) { await page.mouse.wheel(0, -700); await sleep(60); }
        });
      });
      await check("totals", async () => {
        const total = results.reduce((sum, row) => sum + row.frames, 0);
        return { frames: total, worstP95: Math.max(...results.map((row) => row.p95)), janky: Math.round(results.reduce((sum, row) => sum + row.janky * row.frames, 0) / Math.max(1, total)) };
      });
    },
  });
  await writeFile(join(options.out, "ui-motion.json"), JSON.stringify({ options: { lang: options.lang, theme: options.theme, width: options.width, sources: options.sources }, results }, null, 2) + "\n");
  return { summary, results };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("ui-motion.mjs")) {
  const options = parseQaArgs(process.argv.slice(2), "ui-motion", { sources: "300", production: "false" });
  const { summary } = await runMotionQa(options);
  finishCli("UI motion", options, summary);
}
