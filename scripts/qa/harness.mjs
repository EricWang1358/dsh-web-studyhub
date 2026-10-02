/* The common frame of the browser QA journeys (rename, reading settings, page peek): a seeded temporary library, the fake
   model, Chromium, every key/token/base-url variable removed, one screenshot per step and <out>/summary.json (steps, console
   errors, page errors, failed API calls). Nothing here touches a real library, real files or the network. */
/* global document, window, localStorage -- page.evaluate callbacks run in the browser */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** --lang zh|en --theme dark|light --width 1440|420 --out <dir>, plus any extra flags in `extra` ({ name: default }). */
export function parseQaArgs(argv, name, extra = {}) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) values[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  const lang = values.lang ?? "zh", theme = values.theme ?? "dark", width = Number(values.width ?? 1440);
  if (!["zh", "en"].includes(lang)) throw new Error("--lang must be zh or en");
  if (!["dark", "light"].includes(theme)) throw new Error("--theme must be dark or light");
  return { lang, theme, width, height: Number(values.height ?? (width < 700 ? 860 : 900)),
    out: resolve(values.out ?? join(repoRoot, `output/qa/${name}/${lang}-${theme}-${width}`)),
    ...Object.fromEntries(Object.entries(extra).map(([key, fallback]) => [key, values[key] ?? fallback])) };
}

/**
 * Run a journey. seed(libraryRoot) fills the temporary library; run(context) does the steps. Returns the summary.
 * context: { page, browser, browserContext, server, options, summary, t(zh, en), step(name, fn), shot(name), sleep, library }
 */
export async function runQa({ name, options, seed, run, model = "fake", localStorageSeed = {} }) {
  const removed = scrubProcessEnv();
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  const library = join(options.out, "work", "library");
  await mkdir(library, { recursive: true });
  await seed(library);
  const server = await createPreviewServer({ libraryRoot: library, home: join(options.out, "work", "home"), port: 0,
    model: model === "none" ? null : createFakeModel({ latencyMs: 300, usage: true }) });
  const browser = await launchChromium({ args: [`--lang=${options.lang === "en" ? "en-US" : "zh-CN"}`, "--enable-precise-memory-info", "--js-flags=--expose-gc"] });
  const summary = { name, startedAt: new Date().toISOString(), options, url: server.url, scrubbedEnv: removed, steps: [], consoleErrors: [], pageErrors: [], apiErrors: [] };
  try {
    const browserContext = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1,
      locale: options.lang === "en" ? "en-US" : "zh-CN", colorScheme: options.theme });
    await browserContext.addInitScript(([lang, theme, extra]) => {
      try { localStorage.setItem("study-ui-language", lang); localStorage.setItem("study-theme", theme);
        for (const [key, value] of Object.entries(extra)) if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* blocked */ }
    }, [options.lang, options.theme, localStorageSeed]);
    const page = await browserContext.newPage();
    let current = "boot", n = 0;
    page.on("console", (message) => { if (message.type() === "error") summary.consoleErrors.push({ step: current, text: message.text() }); });
    page.on("pageerror", (error) => summary.pageErrors.push({ step: current, text: String(error?.stack || error) }));
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/call") || response.ok()) return;
      const body = await response.json().catch(() => ({}));
      summary.apiErrors.push({ step: current, status: response.status(), error: body.error || "" });
    });
    const zh = options.lang === "zh", t = (chinese, english) => (zh ? chinese : english);
    const shot = async (label) => { await sleep(350); const file = `${String(++n).padStart(2, "0")}-${label}.png`; await page.screenshot({ path: join(options.out, file) }); return file; };
    const step = async (label, fn) => {
      current = label;
      const record = { name: label, status: "ok" };
      try { const value = await fn(); if (value !== undefined) record.value = value; record.shot = await shot(label); }
      catch (error) { record.status = "failed"; record.error = String(error?.message || error).split("\n")[0]; await shot(`${label}-failed`).catch(() => {}); }
      summary.steps.push(record);
      console.log(`${record.status === "ok" ? "ok  " : "FAIL"} ${label}${record.error ? ` — ${record.error}` : ""}`);
      return record;
    };
    /** A check that is not a screenshot: records pass/fail (and the measured value) as a step without a picture. */
    const check = async (label, fn) => {
      current = label;
      const record = { name: label, status: "ok" };
      try { const value = await fn(); if (value !== undefined) record.value = value; }
      catch (error) { record.status = "failed"; record.error = String(error?.message || error).split("\n")[0]; }
      summary.steps.push(record);
      console.log(`${record.status === "ok" ? "ok  " : "FAIL"} ${label}${record.error ? ` — ${record.error}` : ""}`);
      return record;
    };
    await page.goto(server.url);
    await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await sleep(800);
    await run({ page, browser, browserContext, server, options, summary, t, step, check, shot, sleep, library });
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.ok = !summary.pageErrors.length && !summary.consoleErrors.length && summary.steps.every((item) => item.status === "ok");
    await writeFile(join(options.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    await browser.close().catch(() => {});
    await server.close();
  }
  return summary;
}

/** Print the verdict and set the exit code the way the other journeys do. */
export function finishCli(label, options, summary) {
  console.log(`${summary.ok ? `${label} QA passed` : `${label} QA FAILED`}: ${options.out} (page errors ${summary.pageErrors.length}, console errors ${summary.consoleErrors.length}, API errors ${summary.apiErrors.length})`);
  process.exitCode = summary.ok ? 0 : 1;
}

/** No horizontal page scroll and nothing sticking out of the viewport on the right (the checks behind "no overflow"). */
export const overflowProbe = () => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
  bodyScrollWidth: document.body.scrollWidth, innerWidth: window.innerWidth });
