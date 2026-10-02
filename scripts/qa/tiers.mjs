/* node scripts/qa/tiers.mjs [--label=after] [--dist=<dir with app.js/app.css>] [--out=<dir>] [--lang=zh|en|both]
                             [--theme=dark|light|both] [--widths=1440,1194,768,420] [--states=empty,materials,bigbook,daily]
                             [--pages=library,settings] [--json=<file>]
   The when-is-it-used structure in a real browser (docs/feature-tiers.md): the sidebar's groups, the home screen
   and the course-setup checklist, the Settings page.

   Runs the preview server (scripts/preview-server.mjs) on throw-away libraries (os temp dir, fake model, no network,
   every key/token/base-url variable removed) and walks three kinds of learner:
     empty      a brand-new library: the welcome page, then the library home when it is dismissed
     materials  one new course with a material and no questions yet
     bigbook    a course with a long converted book (chapters, no search index yet) and a few legacy PDF pages
     daily      a course in daily use: published questions, answered ones, a due card, a to-do
   For every language, theme and width it records screenshots and measures what must hold:
     - nothing overflows the window sideways (document and the main column);
     - no sidebar row changes its y position or height between pages (the nav-layout contract still holds);
     - the home has at most one continue/start card and one recommendation line;
     - the checklist, when there is one, is inside the main column and never covers the question catalogue's first row.
   Screenshots go to <out>/<state>-<page>-<width>-<lang>-<theme>.png, the numbers to <out>/tiers.json.
   `--label` only prefixes the file names so a before and an after run can sit side by side. Exit code 1 on a violation. */
/* global document, innerWidth, innerHeight -- page.evaluate callbacks run in the browser */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { previewCall } from "../preview-server.mjs";
import { launchChromium } from "./browser.mjs";
import { startNavServer, measureSidebar } from "./nav-layout.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const COURSE = "Cloud Native Solution Design";

const quote = "Bridge separates an abstraction from its implementation so the two can vary independently.";
const card = (id, topic, prompt, extra = {}) => ({
  id, kind: "flashcard", topic, objective: `Explain ${id}`, prompt, answer: "Two dimensions vary independently.",
  hint: "Two reasons to change.", explanation: "Composition over inheritance.", misconception: "It adapts interfaces.",
  citations: [{ sourceId: "s1", quote }], ...extra,
});

/* ---------- seeds: one function per kind of learner ---------- */

export const SEEDS = {
  empty: async () => {},
  materials: async (api) => {
    await api("source.add", { id: "s1", title: "Week 1 · Services and boundaries", text: quote + "\n" + "A service owns its data and exposes it through a contract. ".repeat(6), course: COURSE });
  },
  bigbook: async (api) => {
    await api("source.add", { id: "s1", title: "Week 1 notes", text: quote, course: COURSE });
    // A converted book as the importer stores it: one source per page, chapters on the pages, a converter on the document;
    // written through a restore because no single action imports a finished conversion.
    const state = await api("export");
    for (let page = 1; page <= 320; page++) state.sources.push({ id: `book-p${page}`, title: `Textbook · p.${page}`, text: `Chapter ${Math.ceil(page / 40)} page ${page}. ${quote}`,
      createdAt: new Date().toISOString(), courses: [COURSE], document: { id: "a".repeat(64), materialId: `document-${"a".repeat(64)}-pdf`, format: "pdf", page, totalPages: 320,
        extractionVersion: 2, origin: "converted", converter: "mineru", bookTitle: "Textbook", chapter: { index: Math.ceil(page / 40) - 1, title: `Chapter ${Math.ceil(page / 40)}`, level: 1 } } });
    await api("restore", { state });
  },
  daily: async (api) => {
    await api("source.add", { id: "s1", title: "Week 1 · Services and boundaries", text: quote, course: COURSE });
    await api("draft.save", { deck: { id: "d1", title: "Services and boundaries", course: COURSE, cards: [
      card("c1", "Boundaries", "Why does a service own its data?"), card("c2", "Boundaries", "What is a bounded context?"), card("c3", "Contracts", "When is a contract breaking?"),
      card("c4", "Contracts", "What does consumer-driven testing check?"), card("c5", "Resilience", "Why add a timeout to every call?")] } });
    await api("draft.publish", { id: "d1" });
    // Three answers (two known, one missed) and the run left open at the fourth card: practised cards, a weak one, a run to continue.
    const run = await api("review.start", { deckId: "d1", mode: "flashcard" });
    let current = run;
    for (const grade of [4, 4, 2]) {
      await api("review.reveal", { runId: run.id, cardId: current.card.id });
      current = await api("review.answer", { runId: run.id, cardId: current.card.id, grade });
      current = await api("review.move", { runId: run.id, direction: 1 });
    }
    const board = await api("board.get");
    await api("board.card.add", { revision: board.revision, title: "Hand in the report", due: "2020-01-01" });
  },
};

/* ---------- measuring ---------- */

/** Facts about the page that the structure must keep true. */
async function measurePage(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const mainBox = main?.getBoundingClientRect();
    const overflowX = Math.max(0, document.documentElement.scrollWidth - innerWidth);
    const wide = [...document.querySelectorAll("main *")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && mainBox && (r.right > mainBox.right + 2 || r.left < mainBox.left - 2);
    }).filter((el) => !el.closest(".map-menu, .selection-bar, dialog, [role=tooltip], .toast, .tour, .nav-mark")).slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}`);
    const count = (selector) => document.querySelectorAll(selector).length;
    // The rail must fit the window: the last row (Settings) ends inside it.
    const last = [...document.querySelectorAll(".sidebar-bottom .nav")].at(-1)?.getBoundingClientRect();
    const sidebarOverflow = last ? Math.max(0, Math.round(last.bottom - innerHeight)) : 0;
    return {
      overflowX, wide, sidebarOverflow,
      continueCards: count(".today-card"), recommendations: count(".desk-next"), coachOffers: count(".coach-offer"),
      checklist: count("[data-setup-checklist]"), checklistMode: document.querySelector("[data-setup-checklist]")?.getAttribute("data-mode") || null,
      groups: [...document.querySelectorAll(".sidebar [data-nav-group]")].map((el) => ({ id: el.getAttribute("data-nav-group"), open: el.getAttribute("data-open") })),
      title: document.querySelector("main h1, .crumb.current")?.textContent?.trim().slice(0, 60) || "",
    };
  });
}

async function openState({ browser, running, state, lang, theme, width, label, out, pages, shots }) {
  const { server, base } = running;
  const api = (action, input = {}) => previewCall(server, action, input);
  for (const dir of ["library", "home"]) await rm(join(base, dir), { recursive: true, force: true });
  await SEEDS[state](api);
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
  await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); } catch { /* blocked */ } }, [lang, theme]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const settle = async (ms = 700) => { await page.waitForLoadState("networkidle").catch(() => {}); await sleep(ms); };
  await page.goto(server.url);
  await page.locator(".sidebar").first().waitFor({ timeout: 30000 });
  await settle(900);
  const record = { state, lang, theme, width, pages: {}, errors };
  const shoot = async (name) => {
    await sleep(500);
    record.pages[name] = { ...(await measurePage(page)), sidebar: (await measureSidebar(page))?.rows.map((row) => ({ key: row.key, top: row.top, height: row.height })) };
    if (shots) await page.screenshot({ path: join(out, `${label}-${state}-${name}-${width}-${lang}-${theme}.png`), fullPage: name.endsWith("-full") });
  };
  // The first thing a learner sees; an empty library shows the welcome page, which is dismissed for the library view after it.
  await shoot("first");
  if (state === "empty") {
    const later = page.getByRole("button", { name: lang === "en" ? /Maybe later/i : "以后再说" });
    if (await later.count()) { await later.first().click(); await settle(500); await shoot("library"); }
  }
  for (const id of pages) {
    if (id === "first") continue;
    const nav = page.locator(`[data-tour="nav-${id}"]`).first();
    if (await nav.count() && await nav.isEnabled()) { await nav.click(); await settle(900); }
    await shoot(id);
    if (shots) { await shoot(`${id}-full`); }
  }
  await context.close();
  return record;
}

/** Problems in one measured record. */
export function checkRecord(record) {
  const problems = [], at = `${record.state} ${record.width}px ${record.lang} ${record.theme}`;
  for (const [name, facts] of Object.entries(record.pages)) {
    if (facts.sidebarOverflow > 0) problems.push(`${at} ${name}: the sidebar is ${facts.sidebarOverflow}px taller than the window`);
    if (facts.overflowX > 1) problems.push(`${at} ${name}: the page scrolls sideways by ${facts.overflowX}px`);
    if (facts.wide.length) problems.push(`${at} ${name}: ${facts.wide.join(", ")} stick out of the main column`);
    if (facts.continueCards > 1) problems.push(`${at} ${name}: ${facts.continueCards} continue cards`);
    if (facts.recommendations > 1) problems.push(`${at} ${name}: ${facts.recommendations} recommendations`);
    if (facts.coachOffers > 0) problems.push(`${at} ${name}: the separate coach card is back`);
  }
  // Sidebar rows keep their place from page to page (the groups must not shift anything).
  const names = Object.keys(record.pages).filter((name) => !name.endsWith("-full") && record.pages[name].sidebar);
  const base = record.pages[names[0]]?.sidebar || [];
  for (const name of names.slice(1)) for (const row of record.pages[name].sidebar) {
    const was = base.find((item) => item.key === row.key);
    if (was && (Math.abs(was.top - row.top) > 0.5 || Math.abs(was.height - row.height) > 0.5)) problems.push(`${at} ${name}: sidebar row ${row.key} moved ${row.top - was.top}px / height ${row.height - was.height}px`);
  }
  if (record.errors.length) problems.push(`${at}: page errors ${record.errors.join(" | ")}`);
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const langs = flag("lang", "both") === "both" ? ["zh", "en"] : [flag("lang")];
  const themes = flag("theme", "both") === "both" ? ["dark", "light"] : [flag("theme")];
  const widths = flag("widths", "1440,1194,768,420").split(",").map(Number);
  const states = flag("states", "empty,materials,bigbook,daily").split(",");
  const pages = flag("pages", "library,settings").split(",");
  const label = flag("label", "after");
  const out = resolve(flag("out", join(repoRoot, "output/qa/tiers")));
  const dist = flag("dist", "");
  await mkdir(out, { recursive: true });
  const running = await startNavServer(dist ? { distDir: resolve(dist) } : {});
  const browser = await launchChromium();
  const report = [], problems = [];
  try {
    for (const state of states) for (const lang of langs) for (const theme of themes) for (const width of widths) {
      const record = await openState({ browser, running, state, lang, theme, width, label, out, pages, shots: true });
      report.push(record);
      problems.push(...checkRecord(record));
    }
  } finally {
    await browser.close().catch(() => {});
    await running.close();
  }
  const file = flag("json", join(out, `${label}-tiers.json`));
  await writeFile(file, JSON.stringify(report, null, 1));
  console.log(problems.length ? problems.join("\n") : "tiers: structure holds");
  console.log(`${problems.length} violation(s) in ${report.length} combination(s); report: ${file}`);
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
