/* node scripts/qa/layout-late.mjs --scenario picker|wrongbook|titles [--dist dist] [--lang zh|en] [--theme dark|light] [--width 1280|420]
                                   [--out output/layout-stability/<scenario>] [--label before|after]
   WP-LS (#205 #206 #207): late data on a seeded temporary library, measured in the browser preview. The preview serves the real app with the fake
   model, a library written under the OS temp dir and every key/token/base-url variable removed. The late answer (index coverage, recommendations)
   is held at the network edge (page.route) until the scenario releases it, so "late" is deterministic: the page is drawn and measured, the answer
   is let through, and the same elements are measured again. Prints one JSON line per scenario with positions, CLS and the longest long task, and
   writes <out>/<label>-<width>-<lang>-<theme>-{before-arrival,after-arrival}.png.
   The same functions drive tests/layout-late-*.test.mjs. */
/* global document, requestAnimationFrame */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { StudyService } from "../../lib/service.js";
import { Store } from "../../lib/store.js";
import { seedLibrary } from "./perf-seed.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { drainLayoutStability, installLayoutObserver, judgeLayoutStability } from "./layout-stability.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Poll until `check` is truthy: the one waiting primitive of this file (no fixed delays). */
export async function until(check, what, { timeoutMs = 90000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

export const frames = (page, count = 3) => page.evaluate((n) => new Promise((done) => {
  let left = n;
  const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), count);

/* ---------- a throw-away library and server ---------- */

const hash = (n) => n.toString(16).padStart(8, "0").repeat(8);

/** `documents` materials the way a real library has them: every fourth is a PDF of several pages, the rest are single notes. */
export async function seedPickerLibrary(root, { documents = 132, lang = "zh" } = {}) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call("snapshot");
  const at = (n) => new Date(Date.UTC(2026, 8, 1) + n * 60_000).toISOString();
  const ids = [];
  await service.store.update((state) => {
    for (let n = 0; n < documents; n++) {
      if (n % 4 === 0) {
        const pages = 3 + (n % 5), filename = lang === "en" ? `Lecture ${String(n).padStart(3, "0")} Distributed Systems.pdf` : `第 ${String(n).padStart(3, "0")} 讲 分布式系统.pdf`;
        for (let page = 1; page <= pages; page++) {
          const id = `pdf-${n}-p${page}`;
          ids.push(id);
          state.sources.push({ id, title: `${filename} · ${page}`, text: `Page ${page} of ${filename}: replication, consensus and the CAP trade-off.`, createdAt: at(n),
            courses: [], document: { id: hash(n), filename, page, totalPages: pages, extractionVersion: 2, format: "pdf" } });
        }
      } else {
        const id = `note-${n}`;
        ids.push(id);
        state.sources.push({ id, title: lang === "en" ? `Reading note ${String(n).padStart(3, "0")} · consistency models` : `阅读笔记 ${String(n).padStart(3, "0")} · 一致性模型`,
          text: `Note ${n}: linearizability, sequential consistency and eventual consistency compared.`, createdAt: at(n), courses: [] });
      }
    }
  });
  return { ids, documents };
}

/** A library whose mistakes page has `wrong` mistakes and a bank of other questions to recommend: 6 decks of 24 cards, the first `wrong` cards answered badly. */
export async function seedWrongBookLibrary(root, { wrong = 72 } = {}) {
  await seedLibrary(root, { sources: 12, decks: 6, cardsPerDeck: 24, runs: 6, attempts: 0, courses: 2, largeSources: 0 });
  const store = new Store(root);
  await store.update((library) => {
    const cards = library.decks.flatMap((deck) => deck.cards.map((card) => ({ deck, card })));
    library.attempts = cards.slice(0, wrong).map(({ deck, card }, index) => ({ id: `wrong-${index}`, runId: library.runs[0].id, quiz_id: card.id, deckId: deck.id, topic: card.topic,
      timestamp: new Date(Date.UTC(2026, 8, 3) + index * 60_000).toISOString(), grade: 1, elapsed_ms: 3000,
      before: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null }, after: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null } }));
  });
  return { wrong };
}

/** The evidence of #207: one lecture PDF, its text version stored under the host's attachment path, and its diagram-normalized text; stored as old libraries have them. */
export const HOST_PATH_TITLE = "C:\\Users\\Eric1\\.dsh\\attachments\\v1\\files\\15\\15dd8b13a5318c2f6e1d\\01. Introduction to Solution Architecture v2.1.pdf";
export async function seedTitlesLibrary(root) {
  const service = new StudyService(root);
  await service.call("snapshot");
  const name = "01. Introduction to Solution Architecture v2.1.pdf", at = new Date().toISOString();
  await service.store.update((state) => {
    state.sources.push({ id: "path-text", title: HOST_PATH_TITLE, text: "Solution architecture views: context, container, component.", createdAt: at, courses: [] });
    state.sources.push({ id: "norm-text", title: `${name.replace(/\.pdf$/, "")} (diagram-normalized text)`, text: "Context diagram: users, system, partners; container diagram: web, api, database.", createdAt: at, courses: [] });
    for (let page = 1; page <= 3; page++)
      state.sources.push({ id: `pdf-p${page}`, title: `${name} · p.${page}`, text: `Page ${page} of the introduction to solution architecture lecture.`, createdAt: at, courses: [],
        document: { id: "d".repeat(64), filename: name, page, totalPages: 3, extractionVersion: 2, format: "pdf" } });
    state.sources.push({ id: "other", title: "Week 3 notes · replication", text: "Leaders, followers and quorum reads compared.", createdAt: at, courses: [] });
  });
  return { name };
}

/** The preview on a fresh library under the OS temp dir. `seed(root)` writes the library before the server starts. */
export async function startLateServer({ distDir, seed, lang = "zh" } = {}) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), "study-late-"));
  const root = join(base, "library");
  const seeded = seed ? await seed(root) : null;
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, "home"), port: 0, model: createFakeModel({ latencyMs: 20 }), ...(distDir ? { distDir } : {}) });
  return { base, server, seeded, lang, api: (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: lang }),
    close: async () => { await server.close(); await rm(base, { recursive: true, force: true }); } };
}

export async function openPage(browser, running, { lang = "zh", theme = "dark", width = 1280, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
  await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); } catch { /* blocked */ } }, [lang, theme]);
  await context.addInitScript(installLayoutObserver);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  return { context, page, errors };
}

/** Hold the answers to `actions` at the network edge. `gate(action)` → { release(value?) } lets a held call through (with `value` as its answer, else the real one). */
export async function holdActions(page, actions) {
  const waiting = new Map(actions.map((action) => [action, { open: null, released: false, value: undefined, seen: false, count: 0 }]));
  for (const entry of waiting.values()) entry.opened = new Promise((done) => { entry.open = done; });
  await page.route("**/api/call", async (route) => {
    let action = "";
    try { action = JSON.parse(route.request().postData() || "{}").action; } catch { /* not JSON */ }
    const entry = waiting.get(action);
    if (!entry) return route.continue();
    entry.seen = true;
    entry.count++;
    await entry.opened;
    if (entry.value === undefined) return route.continue();
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, value: entry.value }) });
  });
  return {
    seen: (action) => waiting.get(action).seen,
    count: (action) => waiting.get(action).count,
    release: (action, value) => { const entry = waiting.get(action); entry.value = value; entry.open(); },
  };
}

/** y of each element matching `selector`, relative to the viewport (rounded to 0.1 px), first `count`. */
export const positions = (page, selector, count = 8) => page.evaluate(([sel, n]) => [...document.querySelectorAll(sel)].slice(0, n).map((element) => {
  const box = element.getBoundingClientRect();
  return { y: Math.round(box.top * 10) / 10, height: Math.round(box.height * 10) / 10 };
}), [selector, count]);

export function longestTask(log) { return log.longTasks.reduce((most, task) => Math.max(most, task.duration), 0); }

/* ---------- scenario: 创建题组 › 选择资料 with late index coverage (#205) ---------- */

export async function pickerScenario({ browser, running, lang = "zh", theme = "dark", width = 1280, shots = null, polls = 2 }) {
  const { page, errors, context } = await openPage(browser, running, { lang, theme, width });
  const hold = await holdActions(page, ["retrieval.index.coverage"]);
  await page.goto(running.server.url);
  await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
  const nav = page.locator('[data-tour="nav-generate"]').first();
  await nav.waitFor({ state: "visible" });
  await nav.dispatchEvent("click");
  const fromSources = page.locator('[data-tour="generate-from-sources"]').or(page.getByRole("tab", { name: lang === "en" ? "From materials" : "从资料补题" }));
  // Dispatched, not real input: Chromium drops layout shifts within 500 ms of real input (hadRecentInput), and this is about data that arrives on its own.
  await fromSources.first().dispatchEvent("click");
  const rows = '[data-tour="generate-sources"] .source-picker__item';
  await page.locator(rows).first().waitFor({ timeout: 30000 });
  await until(() => hold.seen("retrieval.index.coverage"), "the page to ask for index coverage");
  await frames(page, 4);
  const before = await positions(page, rows, 8);
  const documents = await page.locator(rows).count();
  await drainLayoutStability(page);
  if (shots) await page.screenshot({ path: join(shots, "before-arrival.png") });
  // Every document is indexed but the first PDF is partly built: the shapes of the issue's evidence.
  const snapshot = await running.api("snapshot");
  const ids = snapshot.sources.map((source) => source.id);
  const partial = new Set(ids.filter((id) => id.startsWith("pdf-0-p")).slice(0, 2));
  hold.release("retrieval.index.coverage", { indexed: ids.filter((id) => !partial.has(id)), stale: [], missing: [...partial], hasIndex: true, canIndex: true,
    building: polls ? { course: "*", stage: "embedding", done: 12, total: 40 } : null });
  await until(() => page.locator('[data-tour="generate-sources"] .index-badge').count(), "the index badges to appear");
  await frames(page, 4);
  const after = await positions(page, rows, 8);
  const log = await drainLayoutStability(page);
  if (shots) await page.screenshot({ path: join(shots, "after-arrival.png") });
  const badges = await page.locator('[data-tour="generate-sources"] .index-badge').count();
  // A build is running: the page asks again every few seconds and gets an answer of the same content (a new object each time).
  let pollLog = { longTasks: [], resizes: [] };
  if (polls) {
    const asked = hold.count("retrieval.index.coverage");
    await until(() => hold.count("retrieval.index.coverage") >= asked + polls, `${polls} more coverage answers`, { timeoutMs: 30000 });
    await frames(page, 6);
    pollLog = await drainLayoutStability(page);
  }
  const verdict = judgeLayoutStability(log);
  await context.close();
  return { scenario: "picker", documents, before, after, badges, cls: verdict.cls, shifts: verdict.shifts, rowResizes: verdict.rowResizes, resizes: verdict.resizes.slice(0, 3), longestTaskMs: longestTask(log), longTasks: log.longTasks, pollLongestTaskMs: longestTask(pollLog), pollLongTasks: pollLog.longTasks.length, pollRowResizes: pollLog.resizes.length, errors };
}

/* ---------- scenario: 错题与待巩固 with late recommendations (#206) ---------- */

/** What the retrain bar and the list show right now: positions and the words that must not change under the learner. */
const readWrongBook = (page) => page.evaluate(() => {
  const box = (element) => { if (!element) return null; const r = element.getBoundingClientRect(); return { x: Math.round(r.left * 10) / 10, y: Math.round(r.top * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 }; };
  const retrain = document.querySelector(".wb-retrain");
  const pressed = retrain?.querySelector('[aria-pressed="true"]');
  const options = [...(retrain?.querySelectorAll(".sh-seg button, .sh-seg__item") ?? [])].map((element) => element.textContent.trim());
  const start = retrain?.querySelector(".sh-btn--primary");
  return {
    retrain: box(retrain), start: box(start), startText: start?.textContent.trim() ?? "", selected: pressed?.textContent.trim() ?? "", options: [...new Set(options)],
    note: retrain?.querySelector(".wb-retrain-copy small")?.textContent.trim() ?? "", recs: box(document.querySelector(".wb-recs")),
    group: box(document.querySelector(".wb-group")), firstRow: box(document.querySelector(".wb-row")),
  };
});

export async function wrongBookScenario({ browser, running, lang = "zh", theme = "dark", width = 1280, shots = null }) {
  const { page, errors, context } = await openPage(browser, running, { lang, theme, width });
  const hold = await holdActions(page, ["wrongbook.recommend"]);
  await page.goto(running.server.url);
  await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
  const nav = page.locator('[data-tour="nav-wrongbook"]').first();
  await nav.waitFor({ state: "visible" });
  await nav.dispatchEvent("click");
  await page.locator(".wb-retrain").waitFor({ timeout: 30000 });
  await page.locator(".wb-group .wb-row").first().waitFor({ timeout: 30000 });
  await until(() => hold.seen("wrongbook.recommend"), "the page to ask for recommendations");
  await frames(page, 4);
  const before = await readWrongBook(page);
  await drainLayoutStability(page);
  if (shots) await page.screenshot({ path: join(shots, "before-arrival.png") });
  hold.release("wrongbook.recommend");
  await until(() => page.evaluate(() => !!document.querySelector(".wb-recs .sh-btn")), "the recommendations to arrive");
  await frames(page, 4);
  const after = await readWrongBook(page);
  const log = await drainLayoutStability(page);
  if (shots) await page.screenshot({ path: join(shots, "after-arrival.png") });
  const verdict = judgeLayoutStability(log);
  await context.close();
  return { scenario: "wrongbook", before, after, cls: verdict.cls, shifts: verdict.shifts, rowResizes: verdict.rowResizes, longestTaskMs: longestTask(log), errors };
}

/* ---------- scenario: material names in the picker (#207) ---------- */

export async function titlesScenario({ browser, running, lang = "zh", theme = "dark", width = 1280, shots = null }) {
  const { page, errors, context } = await openPage(browser, running, { lang, theme, width });
  await page.goto(running.server.url);
  await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
  const nav = page.locator('[data-tour="nav-generate"]').first();
  await nav.waitFor({ state: "visible" });
  await nav.dispatchEvent("click");
  await page.locator('[data-tour="generate-from-sources"]').or(page.getByRole("tab", { name: lang === "en" ? "From materials" : "从资料补题" })).first().dispatchEvent("click");
  const rows = '[data-tour="generate-sources"] .source-picker__item';
  await page.locator(rows).first().waitFor({ timeout: 30000 });
  await frames(page, 4);
  const entries = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((row) => ({ title: row.querySelector("strong")?.textContent ?? "", meta: row.querySelector("small")?.textContent ?? "" })), rows);
  if (shots) await page.locator('[data-tour="generate-sources"]').first().screenshot({ path: join(shots, "picker.png") });
  await context.close();
  return { scenario: "titles", entries, errors };
}

/* ---------- CLI ---------- */

function parse(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) throw new Error(`Unexpected argument ${argv[i]}`);
    values[match[1]] = match[2] ?? argv[++i];
  }
  return { scenario: values.scenario ?? "picker", lang: values.lang ?? "zh", theme: values.theme ?? "dark", width: Number(values.width ?? 1280),
    dist: values.dist ? resolve(values.dist) : resolve(repoRoot, "dist"), label: values.label ?? "run", out: values.out ? resolve(values.out) : resolve(repoRoot, "output/layout-stability") };
}

const SCENARIOS = { picker: [pickerScenario, (root, lang) => seedPickerLibrary(root, { lang })], wrongbook: [wrongBookScenario, (root) => seedWrongBookLibrary(root)], titles: [titlesScenario, (root) => seedTitlesLibrary(root)] };

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const options = parse(process.argv.slice(2));
  const [run, seed] = SCENARIOS[options.scenario] ?? [];
  if (!run) throw new Error(`Unknown scenario ${options.scenario}: ${Object.keys(SCENARIOS).join(", ")}`);
  const browser = await launchChromium();
  const running = await startLateServer({ distDir: options.dist, lang: options.lang, seed: (root) => seed(root, options.lang) });
  try {
    const shots = join(options.out, options.scenario, `${options.label}-${options.width}-${options.lang}-${options.theme}`);
    await mkdir(shots, { recursive: true });
    const result = await run({ browser, running, lang: options.lang, theme: options.theme, width: options.width, shots });
    console.log(JSON.stringify({ label: options.label, width: options.width, lang: options.lang, theme: options.theme, ...result }));
  } finally { await browser.close(); await running.close(); }
}
