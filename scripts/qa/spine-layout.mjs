/* The 本次脉络 / 学习脉络 panel in a real browser (scripts/qa/spine-harness.jsx renders it exactly as the learning flow mounts it,
   with the skeleton of the owner's screenshot: 5 stations, 8 points, station 4 holds five of them).
   Everything is measured with getBoundingClientRect, not guessed from CSS:
     node scripts/qa/spine-layout.mjs [--phase before|after] [--out output/qa/spine] [--shots]
   Exports build/measure helpers for tests/spine-layout.test.mjs. Secrets are scrubbed from the environment first. */
/* global document, getComputedStyle, window */
import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Bundle the harness into `dir`; returns the file URL of its page. */
export async function buildSpineHarness(dir) {
  await mkdir(dir, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: ["scripts/qa/spine-harness.jsx"], bundle: true, outfile: join(dir, "harness.js"), format: "iife",
    platform: "browser", loader: { ".css": "text" }, jsx: "transform", logLevel: "warning", define: { "process.env.NODE_ENV": '"development"' } });
  await writeFile(join(dir, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>spine</title></head><body><div id="root"></div><script src="harness.js"></script></body></html>');
  return pathToFileURL(join(dir, "index.html")).href;
}

/** Open the harness in a fresh context. `storage` seeds localStorage before the page runs. */
export async function openSpine(browser, harness, { lang = "zh", theme = "dark", width = 1440, height = 900, mode = "peek", storage = {}, reducedMotion = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  await context.addInitScript(([l, t, extra]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v); } catch { /* blocked */ } }, [lang, theme, storage]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`${harness}?lang=${lang}&theme=${theme}&mode=${mode}`);
  await page.locator("#lesson-marker").waitFor({ state: "attached", timeout: 15000 });
  await sleep(250);
  return { page, errors, close: () => context.close() };
}

/** Geometry of the panel in the page's current state (all numbers are CSS px, tops are document coordinates). */
export function measureSpine(page) {
  return page.evaluate(() => {
    const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round((r.top + window.scrollY) * 10) / 10, left: Math.round(r.left * 10) / 10, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10, bottom: Math.round((r.bottom + window.scrollY) * 10) / 10 }; };
    const spine = document.querySelector(".spine");
    const panel = document.querySelector(".wf-spine-peek") || document.querySelector(".wf-skeleton") || spine;
    const lesson = document.querySelector("#lesson-marker");
    const pane = document.querySelector(".spine-detail") || spine;
    const clipped = [];
    const scrollers = [];
    for (const el of (spine ? spine.querySelectorAll("*") : [])) {
      const cs = getComputedStyle(el);
      const text = (el.textContent || "").trim().slice(0, 40);
      const inPane = pane.contains(el);
      if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1) scrollers.push({ cls: el.className, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth });
      else if ((cs.overflowY === "hidden" || cs.overflowY === "clip") && el.scrollHeight > el.clientHeight + 1) clipped.push({ kind: "height", cls: String(el.className), text, inPane });
      else if ((cs.overflowX === "hidden" || cs.overflowX === "clip") && cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1) clipped.push({ kind: "ellipsis", cls: String(el.className), text, inPane });
      else if (cs.overflowX === "hidden" && el.scrollWidth > el.clientWidth + 1) clipped.push({ kind: "width", cls: String(el.className), text, inPane });
    }
    // Space under a station's last content: the stretch of a grid cell to the tallest sibling.
    const slack = [...document.querySelectorAll(".spine-station")].map((station) => {
      const own = station.getBoundingClientRect();
      const last = Math.max(...[...station.querySelectorAll("*")].map((el) => el.getBoundingClientRect().bottom), own.top);
      return Math.round((own.bottom - last) * 10) / 10;
    });
    const markers = [...document.querySelectorAll(".spine-marker")].map((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top * 10) / 10, centre: Math.round((r.top + r.height / 2) * 10) / 10 }; });
    const overflowRight = [...(spine ? spine.querySelectorAll("*") : [])].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && !el.closest(".spine-strip, .spine-scroll")).length;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      panel: panel ? box(panel) : null,
      spine: spine ? box(spine) : null,
      lessonTop: lesson ? box(lesson).top : null,
      stationHeights: [...document.querySelectorAll(".spine-station")].map((el) => Math.round(el.getBoundingClientRect().height)),
      stationSlack: slack,
      markers,
      clipped,
      scrollers,
      overflowRight,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

/* ── CLI: numbers and screenshots ─────────────────────────────────────── */
async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const phase = flag("--phase", "after");
  const out = resolve(root, flag("--out", "output/qa/spine"), phase);
  scrubProcessEnv();
  await rm(out, { recursive: true, force: true });
  const harness = await buildSpineHarness(join(out, "work"));
  const browser = await launchChromium();
  const results = [];
  try {
    const combos = args.includes("--full")
      ? [["zh", "dark"], ["zh", "light"], ["en", "dark"], ["en", "light"]].flatMap((c) => [1440, 1194, 768, 420].map((w) => [...c, w]))
      : [["zh", "dark", 1440], ["zh", "dark", 1194], ["zh", "dark", 768], ["zh", "dark", 420], ["en", "light", 1440], ["en", "light", 420]];
    for (const [lang, theme, width] of combos) {
      const tag = `${lang}-${theme}-${width}`;
      for (const mode of ["peek", "subject"]) {
        const { page, errors, close } = await openSpine(browser, await harness, { lang, theme, width, mode });
        const states = [];
        const click = (selector) => async () => { await page.locator(selector).first().click(); await sleep(250); };
        if (phase === "before") {
          states.push(["open", mode === "peek" ? click(".wf-spine-peek > summary") : async () => {}]);
        } else {
          // Folded in a lesson, open on the skeleton step; then the longest station (4), the overview, and the fold again.
          states.push([mode === "peek" ? "folded" : "open", async () => {}]);
          if (mode === "peek") states.push(["open-st1", click(".spine-toggle")]);
          states.push(["open-st4", async () => { await page.locator(".spine-tab").nth(3).click(); await sleep(250); }]);
          states.push(["all", click(".spine-all-toggle")]);
          states.push(["all-closed", click(".spine-all-toggle")]);
          if (mode === "subject") states.push(["folded", click(".spine-toggle")]);
        }
        for (const [name, act] of states) {
          await act();
          const m = await measureSpine(page);
          results.push({ tag, mode, state: name, ...m, errors });
          await page.screenshot({ path: join(out, `${tag}-${mode}-${name}.png`), fullPage: true });
        }
        await close();
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  await writeFile(join(out, "measurements.json"), JSON.stringify(results, null, 2));
  console.log("tag | mode | state | panel h | lesson top | station slack | clipped | scrollers | page overflow");
  for (const r of results) {
    console.log([r.tag, r.mode, r.state, r.panel?.height, r.lessonTop, JSON.stringify(r.stationSlack), r.clipped.length, r.scrollers.length, r.pageOverflow].join(" | "));
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
