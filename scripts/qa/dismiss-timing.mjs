/* npm run qa:dismiss [-- --out <dir> --dist <dir> --sources 180 --lang zh --theme dark --latency 150 --frames]
   WP19: how long does 知道了 take to make a finished card disappear, and does anything get disabled on the way?

   Seeds a realistic library (about 180 sources with text, several decks, finished generation jobs and finished audio
   import batches that own a 25 MB input copy), runs the real preview server with the fake model in Chromium, then
   clicks 知道了 and measures with performance.now() and a requestAnimationFrame sampler:
     goneMs        click -> the card is no longer visible (removed, display:none, visibility:hidden or opacity 0)
     removedMs     click -> the card is gone from the DOM (the animation has been cleaned up by a snapshot)
     disabledMs    how long any control on the page was disabled after the click
     maxDisabled   the most controls disabled at the same time
   Writes <out>/timings.json (and, with --frames, a short screenshot sequence). Every key/token/base-url variable is
   removed from the environment first. */
/* global document, performance, requestAnimationFrame, getComputedStyle, localStorage */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StudyService } from "../../lib/service.js";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const arg = (name, fallback) => { const hit = process.argv.find((a) => a.startsWith(`--${name}=`)); const at = process.argv.indexOf(`--${name}`);
  return hit ? hit.slice(name.length + 3) : at >= 0 && process.argv[at + 1] && !process.argv[at + 1].startsWith("--") ? process.argv[at + 1] : fallback; };
const flag = (name) => process.argv.includes(`--${name}`);
const out = resolve(arg("out", join(repoRoot, "output/qa/wp19")));
const dist = resolve(arg("dist", join(repoRoot, "dist")));
const SOURCES = Number(arg("sources", 180)), LANG = arg("lang", "zh"), THEME = arg("theme", "dark"), WIDTH = Number(arg("width", 1280));
const label = arg("label", "run"), LATENCY = Number(arg("latency", 0));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
scrubProcessEnv();

const paragraph = (i, n) => `第 ${i} 份资料第 ${n} 段：容器编排把应用的部署、扩缩容和故障恢复交给调度器统一处理，运维人员只需声明期望状态。`
  + "间隔重复在遗忘之前安排复习，用更少的次数维持长期记忆；提取练习本身会加强记忆痕迹。".repeat(2);

async function seed(root) {
  const service = new StudyService(root);
  for (let i = 1; i <= SOURCES; i++)
    await service.call("source.add", { id: `src-${i}`, title: `Lecture ${Math.ceil(i / 6)} notes · part ${i}`, course: `CS${3200 + (i % 4)}`,
      text: Array.from({ length: 28 }, (_, n) => paragraph(i, n)).join("\n") });
  await service.store.update((s) => {
    for (let d = 1; d <= 8; d++)
      s.decks.push({ id: `deck-${d}`, title: `Deck ${d}`, folder: "CS3219", course: "CS3219", topics: ["t"], createdAt: new Date().toISOString(),
        cards: Array.from({ length: 24 }, (_, c) => ({ id: `d${d}c${c}`, kind: "flashcard", topic: "t", prompt: `Q ${d}.${c} ${"问".repeat(30)}`,
          answer: `A ${"答".repeat(60)}`, citations: [{ sourceId: `src-${d}`, quote: "容器编排把应用的部署、扩缩容和故障恢复交给调度器统一处理" }] })) });
  });
  // Finished audio imports; each batch owns a copy of its recording, which is what makes cleanup slow.
  for (let i = 1; i <= 4; i++) {
    const id = `audio-batch-${i}000000`, dir = join(root, "audio-batches", id);
    await mkdir(join(dir, "inputs"), { recursive: true });
    await writeFile(join(dir, "inputs", `lecture-${i}.mp3`), Buffer.alloc(25 * 1024 * 1024, i));
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ id, kind: "batch", createdAt: new Date().toISOString(),
      job: { id: `audio-job-${i}`, type: "audio-import", batchId: id, filename: `lecture-${i}.mp3`, status: i === 4 ? "failed" : "complete", phase: "done",
        stage: i === 4 ? "上游服务暂时不可用" : "完成", total: 1, done: 1, sourceIds: [`src-${i}`], corrected: 2, retryable: i === 4, warnings: [],
        startedAt: new Date(Date.now() - 600000).toISOString(), finishedAt: new Date(Date.now() - 300000).toISOString() } }));
  }
}

/* Runs in the page: sample every frame after the click until the card is gone and all controls are enabled. */
const MEASURE = async ({ selector, index }) => {
  const cards = [...document.querySelectorAll(selector)];
  const card = cards[index], t0 = performance.now();
  const visible = (el) => { if (!el || !el.isConnected) return false; const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.02 && r.height > 1; };
  const dismiss = card.querySelector(".job-dismiss, .sh-job__dismiss") || card;
  const disabledNow = () => document.querySelectorAll(".study-app button:disabled, .study-app input:disabled, .study-app select:disabled").length;
  const before = disabledNow();
  let goneMs = null, removedMs = null, disabledUntil = 0, maxDisabled = 0, frames = 0;
  const loop = () => new Promise((resolve) => {
    const tick = () => {
      frames++;
      const t = performance.now() - t0, disabled = disabledNow() - before;
      maxDisabled = Math.max(maxDisabled, disabled);
      if (disabled > 0) disabledUntil = t;
      if (goneMs === null && !visible(card)) goneMs = t;
      if (removedMs === null && !card.isConnected) removedMs = t;
      if (t > 8000 || (goneMs !== null && removedMs !== null && t - disabledUntil > 600)) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  dismiss.click();
  await loop();
  return { goneMs: goneMs === null ? null : Math.round(goneMs), removedMs: removedMs === null ? null : Math.round(removedMs),
    disabledMs: Math.round(disabledUntil), maxDisabled, frames };
};

const server = await (async () => {
  const root = join(out, `library-${label}-${LANG}-${THEME}-lat${LATENCY}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  await seed(root);
  return createPreviewServer({ libraryRoot: root, home: join(out, `home-${label}`), port: Number(arg("port", 4341)),
    model: createFakeModel({ latencyMs: 10 }), distDir: dist });
})();
const browser = await launchChromium();
const results = { label, latency: LATENCY, dist, sources: SOURCES, lang: LANG, theme: THEME, width: WIDTH, scenarios: {}, errors: [] };
try {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: 900 }, colorScheme: THEME });
  await context.addInitScript(([lang, theme]) => { try { localStorage.setItem("study-ui-language", lang); localStorage.setItem("study-theme", theme); } catch { /* storage blocked */ } }, [LANG, THEME]);
  // --latency=N adds N ms to every API call, standing in for DSH's host transport (IPC + serialising a ~2 MB snapshot).
  if (LATENCY) await context.route("**/api/call", async (route) => { await sleep(LATENCY); await route.continue(); });
  const page = await context.newPage();
  page.on("pageerror", (error) => results.errors.push(String(error)));
  page.on("console", (m) => { if (m.type() === "error") results.errors.push(m.text()); });
  results.api = [];
  page.on("requestfinished", async (request) => {
    if (!request.url().endsWith("/api/call")) return;
    let action = "?"; try { action = JSON.parse(request.postData() || "{}").action; } catch { /* not JSON */ }
    if (["job.archive", "snapshot", "inbox.read"].includes(action)) results.api.push({ action, ms: Math.round(request.timing().responseEnd), kb: Math.round(((await (await request.response())?.body())?.length || 0) / 1024) });
  });
  page.on("response", (r) => { if (r.status() >= 400) results.errors.push(`${r.status()} ${r.request().method()} ${r.url()} ${(r.request().postData() || "").slice(0, 120)}`); });
  const wait = (job) => previewCall(server, "job.wait", { jobId: job, timeoutSeconds: 30 });
  // Generation jobs: three finished cards on the home page.
  for (let i = 0; i < 3; i++) {
    const job = await previewCall(server, "generate", { sourceIds: [`src-${i + 1}`], count: 3, kind: "flashcard", title: `Generated ${i + 1}` });
    await wait(job.jobId);
  }
  await page.goto(server.url);
  await page.waitForSelector(".study-app .nav", { timeout: 20000 });
  await page.evaluate(([key]) => { try { for (const k of Object.keys(localStorage)) if (k.startsWith("study-welcome:") || k.startsWith("study-tour:")) localStorage.removeItem(k);
    localStorage.setItem(key, "x"); } catch { /* storage blocked */ } }, ["probe"]);
  const frames = flag("frames");
  const shot = async (name) => page.screenshot({ path: join(out, `${label}-${LANG}-${THEME}-lat${LATENCY}-${name}.png`) });
  const measure = async (name, selector, index = 0) => {
    await sleep(400);
    if (frames) await shot(`${name}-0-before`);
    const run = page.evaluate(MEASURE, { selector, index });
    if (frames) { for (const [n, ms] of [[1, 40], [2, 90], [3, 160]]) { await sleep(n === 1 ? ms : ms - [0, 40, 90][n - 1]); await shot(`${name}-${n}-t${ms}`); } }
    results.scenarios[name] = await run;
    if (frames) await shot(`${name}-4-after`);
  };
  if (flag("fail")) {
    // A failing server: the cards must come back with a short error beside them.
    await context.route("**/api/call", async (route) => {
      if ((route.request().postData() || "").includes('"job.archive"')) await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Disk is busy, try again" }) });
      else await route.continue();
    });
    await page.click('[data-tour="nav-audio"]');
    await page.waitForSelector(".audio-jobs .sh-job__dismiss");
    await page.click(".audio-jobs .sh-job__dismiss");
    await sleep(700);
    await shot("fail-audio");
    results.failureShown = { audio: await page.locator(".audio-jobs .sh-job .sh-inline--error").allTextContents() };
    await page.click('[data-tour="nav-library"]');
    await page.waitForSelector(".generation-jobs .sh-job__dismiss");
    await page.click(".generation-jobs .jobs-dismiss-all");
    await sleep(700);
    await shot("fail-home-all");
    await page.click(".generation-jobs .sh-job__dismiss");
    await sleep(700);
    await shot("fail-home-single");
    results.failureShown.home = await page.locator(".generation-jobs .sh-job .sh-inline, .jobs-actions .sh-inline").allTextContents();
    await writeFile(join(out, `timings-${label}-${LANG}-${THEME}-lat${LATENCY}-fail.json`), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results.failureShown, null, 2));
    await browser.close(); await server.close();
    process.exit(results.errors.filter((e) => !/status of 400|400 POST/.test(e)).length ? 1 : 0);
  }
  // Audio page.
  await page.click('[data-tour="nav-audio"]');
  await page.waitForSelector(".audio-jobs .sh-job__dismiss", { timeout: 20000 });
  await measure("audio-single", ".audio-jobs .sh-job", 0);
  await page.click('[data-tour="nav-library"]');
  // Home: single card, then dismiss-all.
  await page.waitForSelector(".generation-jobs .sh-job__dismiss", { timeout: 20000 });
  await measure("home-single", ".generation-jobs .sh-job", 0);
  await page.waitForSelector(".generation-jobs .jobs-dismiss-all", { timeout: 20000 }).catch(() => {});
  if (await page.$(".generation-jobs .jobs-dismiss-all")) {
    results.scenarios["home-all"] = await page.evaluate(async () => {
      const cards = [...document.querySelectorAll(".generation-jobs .sh-job:not(.sh-job--running)")];
      const t0 = performance.now();
      const visible = (el) => { if (!el.isConnected) return false; const s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.02 && el.getBoundingClientRect().height > 1; };
      const disabledNow = () => document.querySelectorAll(".study-app button:disabled").length, before = disabledNow();
      let goneMs = null, disabledUntil = 0, maxDisabled = 0;
      document.querySelector(".generation-jobs .jobs-dismiss-all").click();
      await new Promise((resolve) => { const tick = () => { const t = performance.now() - t0, d = disabledNow() - before; maxDisabled = Math.max(maxDisabled, d); if (d > 0) disabledUntil = t;
        if (goneMs === null && cards.every((c) => !visible(c))) goneMs = t; if (t > 8000 || (goneMs !== null && t - disabledUntil > 600)) resolve(); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
      return { goneMs: Math.round(goneMs ?? -1), disabledMs: Math.round(disabledUntil), maxDisabled, cards: cards.length };
    });
  }
  // The seeded batch folder of a dismissed card must be gone (or retired) shortly after.
  await sleep(1500);
  await page.screenshot({ path: join(out, `${label}-${LANG}-${THEME}-lat${LATENCY}-final.png`) });
  const snapshot = await previewCall(server, "snapshot", {});
  results.jobsLeft = snapshot.jobs.map((j) => `${j.type}:${j.status}`);
  const { readdir } = await import("node:fs/promises");
  results.batchFolders = await readdir(join(server.libraryRoot, "audio-batches")).catch(() => []);
} finally {
  await browser.close();
  await server.close();
}
await mkdir(out, { recursive: true });
await writeFile(join(out, `timings-${label}-${LANG}-${THEME}-lat${LATENCY}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
process.exit(results.errors.length ? 1 : 0);
