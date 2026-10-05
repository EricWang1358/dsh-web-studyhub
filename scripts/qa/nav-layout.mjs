/* node scripts/qa/nav-layout.mjs [--lang=zh|en|both] [--theme=dark|light|both] [--widths=1440,1194,768,420]
                                  [--modes=expanded,collapsed] [--out=<dir>] [--dist=<dir with app.js/app.css>] [--shots] [--json=<file>]
   The sidebar navigation measured in the browser preview (UI consistency).

   Runs the real preview server on a throw-away library (os temp dir, fake model, no network, every key/token/base-url
   variable removed) and, for each UI language, theme, window width and sidebar mode, walks the learner through the
   states the sidebar must survive: an empty library, a library with data and no run, a run open (on the study page,
   the library page and the mistakes page), a detour opened from a letter, Settings, a finished run, and a busy
   library (board badge, 为你定制 ready, a paused tour). In each state it reads getBoundingClientRect() of every row
   of the sidebar and compares the states.

   The contract it asserts (exit code 1 when broken):
     1. no row of the sidebar moves or changes height from one state to the next, so nothing below the resume row
        jumps when a run starts or ends or the learner changes page (the busy state may insert the 为你定制 row, so
        it is only compared by height; the bottom group is compared by its distance to the bottom of the rail);
     2. rows of one kind share one height (study rows, upkeep rows, bottom rows);
     3. exactly one row is marked aria-current, it is never disabled;
     4. the gliding highlight sits on the active row of the rail.
   Screenshots (--shots) go to <out>/<width>-<lang>-<theme>-<mode>-<state>.png. */
/* global document, getComputedStyle, localStorage -- page.evaluate callbacks run in the browser */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const quote = "Bridge separates an abstraction from its implementation so the two can vary independently.";
const card = (id, prompt) => ({
  id, kind: "flashcard", topic: "Bridge", objective: `Explain ${id}`, prompt, answer: "Two dimensions vary independently.",
  hint: "Two reasons to change.", explanation: "Composition over inheritance.", misconception: "It adapts interfaces.",
  citations: [{ sourceId: "s1", quote }],
});

/** Everything the sidebar draws, in page order, with the numbers the contract is about. */
export async function measureSidebar(page) {
  return page.evaluate(() => {
    const side = document.querySelector(".sidebar");
    if (!side) return null;
    const origin = side.getBoundingClientRect();
    const r1 = (n) => Math.round(n * 10) / 10;
    const keyOf = (el) => el.dataset.navId || el.dataset.tour || [...el.classList].find((c) => /-nav$|^theme-cycle$|^update-chip$|study-language/.test(c)) || el.className;
    const rows = [...side.querySelectorAll("button.nav, .study-language-switch, .update-chip")]
      .filter((el) => el.getBoundingClientRect().height > 0)
      .map((el) => {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        const label = el.querySelector(".nav-label");
        const svg = el.querySelector("svg");
        const sb = svg && svg.getBoundingClientRect();
        return {
          key: keyOf(el), text: el.textContent.trim().replace(/\s+/g, " ").slice(0, 60),
          top: r1(r.top - origin.top), bottom: r1(origin.bottom - r.bottom), height: r1(r.height), left: r1(r.left - origin.left), width: r1(r.width),
          zone: el.closest(".sidebar-bottom") ? "bottom" : /nav-upkeep/.test(el.className) ? "upkeep" : "study",
          weight: cs.fontWeight, opacity: cs.opacity, cursor: cs.cursor,
          truncated: !!label && label.scrollWidth > label.clientWidth + 1,
          disabled: !!el.disabled, ariaDisabled: el.getAttribute("aria-disabled"), ariaCurrent: el.getAttribute("aria-current"),
          active: el.matches('[aria-current="page"]'),
          icon: sb ? { w: r1(sb.width), h: r1(sb.height), x: r1(sb.left - r.left) } : null,
          hint: (el.querySelector(".nav-count, .nav-badge") || {}).textContent || "",
        };
      });
    const mark = side.querySelector(".nav-mark");
    const m = mark && mark.getBoundingClientRect();
    // The white bar on the active row's outer edge: where it is on screen and whether it is drawn at all.
    const activeEl = side.querySelector("button.nav[aria-current=\"page\"]");
    const barHost = activeEl && (activeEl.closest(".sidebar-bottom") ? activeEl : mark);
    let bar = null;
    if (barHost) {
      const before = getComputedStyle(barHost, "::before"), hr = barHost.getBoundingClientRect();
      bar = { x: r1(hr.left + parseFloat(before.left)), w: parseFloat(before.width) || 0, shown: before.content !== "none" && before.content !== "normal" };
    }
    return {
      bar,
      sidebarWidth: Math.round(origin.width), sidebarHeight: Math.round(origin.height), narrow: side.classList.contains("is-narrow"),
      mark: m ? { top: r1(m.top - origin.top), height: r1(m.height) } : null,
      rows,
    };
  });
}

/** Rows present in both states: how far each moved (from the top for the study and upkeep rows, from the bottom
 *  for the bottom group, which the rail anchors there) and how much taller or shorter it became. */
export function compareStates(before, after) {
  const index = new Map(after.rows.map((row) => [row.key, row]));
  return before.rows.filter((row) => index.has(row.key)).map((row) => {
    const next = index.get(row.key);
    const dy = row.zone === "bottom" ? row.bottom - next.bottom : next.top - row.top;
    return { key: row.key, dTop: Math.round(dy * 10) / 10, dHeight: Math.round((next.height - row.height) * 10) / 10 };
  });
}

/** The contract as a list of violations. `states` is { name: measurement } for one viewport; a state named in
 *  `insertsRows` may add rows above others, so only heights are compared there. */
export function checkContract(states, label, { insertsRows = [] } = {}) {
  const problems = [];
  const names = Object.keys(states);
  const base = states[names[0]];
  for (const name of names) {
    const s = states[name], at = `${label} ${name}`;
    for (const kind of ["study", "upkeep", "bottom"]) {
      const heights = [...new Set(s.rows.filter((r) => r.zone === kind && r.key !== "update-chip").map((r) => r.height))];
      if (heights.length > 1) problems.push(`${at}: ${kind} rows differ in height: ${heights.join(", ")}`);
    }
    const current = s.rows.filter((r) => r.ariaCurrent);
    if (current.length > 1) problems.push(`${at}: ${current.length} rows carry aria-current (${current.map((r) => r.key).join(", ")})`);
    for (const row of current) if (row.disabled) problems.push(`${at}: ${row.key} is disabled yet aria-current`);
    const active = s.rows.filter((r) => r.active);
    if (active.map((r) => r.key).join() !== current.map((r) => r.key).join())
      problems.push(`${at}: active row(s) [${active.map((r) => r.key)}] differ from aria-current [${current.map((r) => r.key)}]`);
    if (active.length === 1 && (!s.bar || !s.bar.shown || s.bar.w < 2 || s.bar.x < -0.5))
      problems.push(`${at}: the active bar of ${active[0].key} is ${s.bar ? `cut off or missing (x ${s.bar.x}, width ${s.bar.w})` : "missing"}`);
    if (active.length === 1 && active[0].zone !== "bottom") {
      if (!s.mark) problems.push(`${at}: ${active[0].key} is active but the highlight is missing`);
      else if (Math.abs(s.mark.top - active[0].top) > 1 || Math.abs(s.mark.height - active[0].height) > 1)
        problems.push(`${at}: highlight ${s.mark.top}+${s.mark.height} is not on ${active[0].key} ${active[0].top}+${active[0].height}`);
    }
    if (s !== base)
      for (const d of compareStates(base, s)) {
        const moved = !insertsRows.includes(name) && Math.abs(d.dTop) > 0.5;
        if (moved || Math.abs(d.dHeight) > 0.5)
          problems.push(`${at}: ${d.key} moved ${d.dTop}px, height ${d.dHeight >= 0 ? "+" : ""}${d.dHeight}px against ${names[0]}`);
      }
  }
  return problems;
}

/** Start the preview on an empty temporary library (`distDir`: another build of app.js/app.css than ./dist). */
export async function startNavServer({ distDir, retrieval = null } = {}) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), "study-nav-"));
  const server = await createPreviewServer({ libraryRoot: join(base, "library"), home: join(base, "home"), port: 0, model: createFakeModel({ latencyMs: 50 }), ...(retrieval ? { retrieval } : {}), ...(distDir ? { distDir } : {}) });
  return { base, server, close: async () => { await server.close(); await rm(base, { recursive: true, force: true }); } };
}

/** All states for one language, theme, width and sidebar mode. Returns { label, states, errors, insertsRows }. */
export async function collectStates({ browser, running, lang, theme, width, mode, shots = false, out = "", full = true }) {
  const { server, base } = running;
  const api = (action, input = {}) => previewCall(server, action, input);
  const label = `${width}px ${lang} ${theme} ${mode}`;
  for (const dir of ["library", "home"]) await rm(join(base, dir), { recursive: true, force: true });
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
  await context.addInitScript(([l, t, m]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); localStorage.setItem("study-sidebar", m === "collapsed" ? "collapsed" : "open"); } catch { /* blocked */ } }, [lang, theme, mode]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const patch = { coach: 0 };
  await page.route("**/api/call", async (route) => { // 为你定制 only exists when prepared questions are ready; fake it in the snapshot
    let action = "";
    try { action = JSON.parse(route.request().postData() || "{}").action; } catch { /* not json */ }
    if (action !== "snapshot" || !patch.coach) return route.continue();
    try {
      const response = await route.fetch();
      const body = await response.json();
      if (body?.ok && body.value && !body.value.unchanged) body.value.coach = { ...(body.value.coach || {}), ready: patch.coach };
      return await route.fulfill({ response, body: JSON.stringify(body) });
    } catch { return route.abort().catch(() => {}); } // the page navigated away while the snapshot was in flight: the answer is no longer wanted
  });
  const settle = async (ms = 700) => { await page.waitForLoadState("networkidle").catch(() => {}); await sleep(ms); };
  const open = async () => { await page.goto(server.url); await page.locator(".sidebar").first().waitFor({ timeout: 120000 }); await settle(900); };
  const states = {};
  const record = async (name) => {
    await sleep(700); // let the sliding highlight and any transition finish
    states[name] = await measureSidebar(page);
    if (shots) await page.screenshot({ path: join(out, `${width}-${lang}-${theme}-${mode}-${name}.png`) });
  };
  const nav = async (id) => { await page.locator(`[data-tour="nav-${id}"]`).first().click(); await settle(900); };
  await open();
  await record("1-empty");
  await api("source.add", { id: "s1", title: "Bridge", text: quote });
  await api("draft.save", { deck: { id: "d1", title: "Patterns", cards: [card("c1", "Why use Bridge for reports and renderers?"), card("c2", "What does Bridge separate?"), card("c3", "When is Bridge overkill?")] } });
  await api("draft.publish", { id: "d1" });
  await open();
  await record("2-data-no-run");
  await page.locator(".resume-nav").click(); await settle(900);
  await record("3-run-open");
  await nav("library");
  await record("4-run-open-library");
  await nav("wrongbook");
  await record("5-run-open-wrongbook");
  if (full) {
    const run = (await api("snapshot")).lastRun;
    await api("card.update", { cardId: "c3", patch: { hint: "Count the reasons to change." }, reason: "补充提示" });
    await open();
    await page.locator(".resume-nav").click(); await settle(900);
    await page.locator(".mailbox__toggle").click(); await settle(400);
    await page.locator(".mailbox__item").first().click().catch(() => {}); await settle(900);
    await record("6-detour");
    await nav("settings");
    await record("7-settings");
    if (run) await api("review.end", { runId: run.id });
    await open();
    await record("8-run-ended");
    // A busy library: board badge with an overdue card, 为你定制 ready, a paused tour.
    const board = await api("board.get");
    await api("board.card.add", { revision: board.revision, title: "Hand in the report", due: "2020-01-01" });
    patch.coach = 4;
    const root = (await api("snapshot")).root;
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [`study-tour:${root}`, JSON.stringify({ stepId: "home", done: false })]);
    await open();
    await record("9-busy");
  }
  await context.close();
  return { label, states, errors, insertsRows: ["9-busy"] };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const langs = flag("lang", "both") === "both" ? ["zh", "en"] : [flag("lang")];
  const themes = flag("theme", "both") === "both" ? ["dark", "light"] : [flag("theme")];
  const widths = flag("widths", "1440,1194,768,420").split(",").map(Number);
  const modes = flag("modes", "expanded,collapsed").split(",");
  const out = resolve(flag("out", join(repoRoot, "output/qa/nav")));
  const shots = args.includes("--shots");
  await mkdir(out, { recursive: true });
  const dist = flag("dist", "");
  const running = await startNavServer(dist ? { distDir: resolve(dist) } : {});
  const browser = await launchChromium();
  const report = [], problems = [];
  try {
    for (const lang of langs) for (const theme of themes) for (const width of widths) for (const mode of modes) {
      const result = await collectStates({ browser, running, lang, theme, width, mode, shots, out });
      report.push(result);
      problems.push(...checkContract(result.states, result.label, { insertsRows: result.insertsRows }));
      if (result.errors.length) problems.push(`${result.label}: page errors ${result.errors.join(" | ")}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await running.close();
  }
  const file = flag("json", join(out, "nav-layout.json"));
  await writeFile(file, JSON.stringify(report, null, 1));
  console.log(problems.length ? problems.join("\n") : "nav layout: contract holds");
  console.log(`${problems.length} violation(s) in ${report.length} combination(s); report: ${file}`);
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
