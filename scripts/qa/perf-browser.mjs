/* node scripts/qa/perf-browser.mjs [--library <dir> | --seed 600] [--lang zh|en] [--theme dark|light] [--width 1440|420]
                                    [--out output/perf/browser] [--idle-seconds 15] [--json <file>]
   Browser-side cost of the study panel against a large library. The panel (dist/app.js, so run `npm run build`
   first) is served by the real preview host (fake model, no network, secrets removed) and driven in Chromium.
   Measured, per page of the sidebar: DOM nodes, JS heap (after a forced collection), long tasks (> 50 ms) and the
   script/layout/style time spent while the page opens; plus the first render (time until the sidebar is enabled),
   the snapshot payload (bytes and JSON.parse time in the page) and the main-thread cost of polling for a while.
   --library copies a real library to --work first (read-only on the original); --seed N writes a synthetic one
   (scripts/qa/perf-seed.mjs, default 600 sources). Screenshots of every page land in --out. */
/* global window, document, performance, PerformanceObserver */
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { seedLibrary } from "./perf-seed.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const round = (value, digits = 1) => Number(Number(value).toFixed(digits));

const PAGES = [
  { id: "library", label: "学习库" }, { id: "sources", label: "资料" }, { id: "generate", label: "创建题组" }, { id: "wrongbook", label: "错题与待巩固" },
  { id: "exam", label: "模拟考试" }, { id: "dashboard", label: "统计" }, { id: "skeleton", label: "知识骨架" }, { id: "workflows", label: "学习流" },
  { id: "settings", label: "设置" },
];

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const [name, inline] = argv[i].slice(2).split("=");
    values[name] = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
  }
  return values;
}

async function metrics(cdp) {
  const { metrics: list } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(list.map((item) => [item.name, item.value]));
}
async function settledHeapMb(cdp) {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  return (await metrics(cdp)).JSHeapUsedSize / 1048576;
}

export async function runBrowserBaseline(options = {}) {
  scrubProcessEnv();
  const lang = options.lang ?? "zh", theme = options.theme ?? "dark", width = Number(options.width ?? 1440);
  const out = resolve(options.out ?? join(repoRoot, "output/perf/browser", `${lang}-${theme}-${width}`));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const root = resolve(options.work ?? join(out, "library"));
  const seeded = options.library ? null : await (async () => { mkdirSync(root, { recursive: true }); return seedLibrary(root, { sources: Number(options.seed ?? 600) }); })();
  if (options.library) { rmSync(root, { recursive: true, force: true }); cpSync(resolve(options.library), root, { recursive: true }); }
  const server = await createPreviewServer({ libraryRoot: root, home: join(out, "home"), port: 0, model: createFakeModel({ latencyMs: 0 }) });
  const browser = await launchChromium({ args: [`--lang=${lang === "en" ? "en-US" : "zh-CN"}`, "--enable-precise-memory-info", "--js-flags=--expose-gc"] });
  const result = { lang, theme, width, library: seeded || { copiedFrom: "real library" }, consoleErrors: [], pageErrors: [] };
  try {
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
    await context.addInitScript(([language, scheme]) => {
      try { localStorage.setItem("study-ui-language", language); localStorage.setItem("study-theme", scheme); } catch { /* storage blocked */ }
      window.__perf = { longTasks: [], snapshots: [] };
      try {
        new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__perf.longTasks.push({ at: entry.startTime, ms: entry.duration }); }).observe({ entryTypes: ["longtask"] });
      } catch { /* longtask unsupported */ }
      const original = window.fetch;
      window.fetch = async (...args) => {
        const response = await original(...args);
        try {
          if (String(args[0]).endsWith("/api/call") && JSON.parse(args[1]?.body || "{}").action === "snapshot") {
            const text = await response.clone().text();
            const started = performance.now();
            const parsed = JSON.parse(text);
            window.__perf.snapshots.push({ bytes: text.length, parseMs: performance.now() - started, unchanged: !!parsed.value?.unchanged });
          }
        } catch { /* measurement only */ }
        return response;
      };
    }, [lang, theme]);
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") result.consoleErrors.push(message.text()); });
    page.on("pageerror", (error) => result.pageErrors.push(String(error?.stack || error)));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");

    // First render: navigation start until the sidebar is enabled (the first snapshot arrived and rendered).
    const navigationStarted = Date.now();
    await page.goto(server.url, { waitUntil: "commit" });
    await page.waitForFunction(() => { const button = document.querySelector('[data-tour="nav-library"]'); return !!button && !button.disabled; }, null, { timeout: 120000 });
    result.firstRenderMs = Date.now() - navigationStarted;
    await sleep(1500);
    result.firstSnapshot = await page.evaluate(() => window.__perf.snapshots.find((item) => !item.unchanged) || null);
    result.afterFirstRender = { heapMb: round(await settledHeapMb(cdp)), domNodes: await page.evaluate(() => document.getElementsByTagName("*").length) };

    // Every page of the sidebar.
    result.pages = [];
    for (const target of PAGES) {
      const before = await metrics(cdp), longBefore = await page.evaluate(() => window.__perf.longTasks.length);
      const started = Date.now();
      const anchor = page.locator(`[data-tour="nav-${target.id}"]`);
      if (await anchor.count()) await anchor.first().click();
      else await page.locator("nav").getByRole("button", { name: new RegExp(`^\\s*${target.label}`) }).first().click();
      await page.waitForLoadState("networkidle").catch(() => {});
      const openMs = Date.now() - started;
      await sleep(900);
      // Pages open on the current course; the worst case is every course at once.
      const scope = page.locator(".page-scope select").first();
      if (await scope.count()) { await scope.selectOption("*").catch(() => {}); await sleep(900); }
      if (target.id === "sources") {
        const expand = page.getByRole("button", { name: lang === "en" ? /Expand all/i : "全部展开" });
        if (await expand.count()) { await expand.first().click().catch(() => {}); await sleep(900); }
      }
      const after = await metrics(cdp);
      const longTasks = await page.evaluate((from) => window.__perf.longTasks.slice(from), longBefore);
      result.pages.push({ page: target.id, openMs, domNodes: await page.evaluate(() => document.getElementsByTagName("*").length),
        heapMb: round(await settledHeapMb(cdp)), longTasks: longTasks.length, longTaskMs: round(longTasks.reduce((sum, task) => sum + task.ms, 0), 0),
        scriptMs: round((after.ScriptDuration - before.ScriptDuration) * 1000, 0), layoutMs: round((after.LayoutDuration - before.LayoutDuration) * 1000, 0),
        styleMs: round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000, 0) });
      await page.screenshot({ path: join(out, `${target.id}.png`) });
    }

    // Polling: the panel asks for a snapshot every 2.5 s. Idle (unchanged) first, then while a review action runs every 4 s.
    await page.locator('[data-tour="nav-library"]').first().click();
    await sleep(800);
    const idleSeconds = Number(options["idle-seconds"] ?? 15);
    let before = await metrics(cdp), polls = await page.evaluate(() => window.__perf.snapshots.length);
    await sleep(idleSeconds * 1000);
    let after = await metrics(cdp);
    result.idlePolling = { seconds: idleSeconds, polls: (await page.evaluate(() => window.__perf.snapshots.length)) - polls,
      taskMsPerPoll: round(((after.TaskDuration - before.TaskDuration) * 1000) / Math.max(1, Math.round(idleSeconds / 2.5)), 1) };
    const snapshot = await previewCall(server, "snapshot");
    const deck = [...snapshot.decks].filter((d) => !d.archived && d.count).sort((a, b) => b.count - a.count)[0];
    let run = await previewCall(server, "review.start", { mode: "flashcard", deckId: deck.id, fresh: true });
    before = await metrics(cdp); polls = await page.evaluate(() => window.__perf.snapshots.length);
    const longBefore = await page.evaluate(() => window.__perf.longTasks.length);
    const busyStarted = Date.now();
    for (let i = 0; i < Math.max(3, Math.round(idleSeconds / 4)); i++) {
      if (run.complete) run = await previewCall(server, "review.start", { mode: "flashcard", deckId: deck.id, fresh: true });
      const common = { runId: run.id, cardId: run.card.id, queueVersion: run.queueVersion };
      run = await previewCall(server, "review.reveal", common);
      run = await previewCall(server, "review.answer", { ...common, grade: 4 });
      run = await previewCall(server, "review.move", { runId: run.id, direction: 1 });
      await sleep(4000);
    }
    after = await metrics(cdp);
    const seconds = (Date.now() - busyStarted) / 1000;
    const changed = (await page.evaluate((from) => window.__perf.snapshots.slice(from), polls)).filter((item) => !item.unchanged);
    result.changingPolling = { seconds: round(seconds), fullSnapshots: changed.length, payloadMb: round((changed.at(-1)?.bytes || 0) / 1048576, 2), parseMs: round(changed.at(-1)?.parseMs || 0),
      taskMsPerFullSnapshot: round(((after.TaskDuration - before.TaskDuration) * 1000) / Math.max(1, changed.length), 0),
      longTasks: (await page.evaluate((from) => window.__perf.longTasks.slice(from), longBefore)).length };
    await page.screenshot({ path: join(out, "after-polling.png") });
    result.finalHeapMb = round(await settledHeapMb(cdp));
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
  return result;
}

function table(title, rows, columns) {
  const widths = columns.map(([name, pick]) => Math.max(name.length, ...rows.map((entry) => String(pick(entry)).length)));
  const line = (cells) => `| ${cells.map((cell, index) => String(cell).padEnd(widths[index])).join(" | ")} |`;
  return [`### ${title}`, line(columns.map(([name]) => name)), line(widths.map((width) => "-".repeat(width))), ...rows.map((entry) => line(columns.map(([, pick]) => pick(entry)))), ""].join("\n");
}

export function printBrowserTables(result) {
  const lines = [`# Browser baseline (${result.lang}, ${result.theme}, ${result.width}px)`, ""];
  lines.push(`First render (navigation to enabled sidebar): ${result.firstRenderMs} ms; first snapshot ${result.firstSnapshot ? `${round(result.firstSnapshot.bytes / 1048576, 2)} MB, JSON.parse ${round(result.firstSnapshot.parseMs)} ms` : "n/a"}; ` +
    `after it ${result.afterFirstRender.domNodes} DOM nodes, ${result.afterFirstRender.heapMb} MB JS heap\n`);
  lines.push(table("Pages", result.pages, [["page", (x) => x.page], ["open ms", (x) => x.openMs], ["DOM nodes", (x) => x.domNodes], ["JS heap MB", (x) => x.heapMb],
    ["long tasks", (x) => x.longTasks], ["long task ms", (x) => x.longTaskMs], ["script ms", (x) => x.scriptMs], ["layout ms", (x) => x.layoutMs], ["style ms", (x) => x.styleMs]]));
  const i = result.idlePolling, c = result.changingPolling;
  lines.push(`Idle polling: ${i.polls} polls in ${i.seconds} s, ${i.taskMsPerPoll} ms main-thread per poll`);
  lines.push(`Polling while a review action runs every 4 s: ${c.fullSnapshots} full snapshots in ${c.seconds} s (${c.payloadMb} MB, page JSON.parse ${c.parseMs} ms), ${c.taskMsPerFullSnapshot} ms main-thread per full snapshot, ${c.longTasks} long tasks`);
  lines.push(`JS heap at the end: ${result.finalHeapMb} MB; console errors ${result.consoleErrors.length}, page errors ${result.pageErrors.length}\n`);
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = parseArgs(process.argv.slice(2));
  const result = await runBrowserBaseline(values);
  if (values.json) await writeFile(String(values.json), JSON.stringify(result, null, 2));
  console.log(printBrowserTables(result));
  if (result.consoleErrors.length || result.pageErrors.length) { console.log(JSON.stringify({ consoleErrors: result.consoleErrors, pageErrors: result.pageErrors }, null, 2)); process.exitCode = 1; }
  process.exit(process.exitCode ?? 0);
}
