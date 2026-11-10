/* node scripts/qa/chunked-lists.mjs [--documents 1000] [--mistakes 1000] [--questions 500] [--rounds 3] [--width 1280] [--dist <dir>]
   #900: the sources page, the wrong book and a long draft draw their rows in growing chunks. This file holds the fixture those lists are measured and
   tested on (one day group of `documents` materials with a 160-page book far below the first chunk, `mistakes` wrong answers in two decks, a draft of
   `questions` questions with two near-duplicates far below the first chunk), and the measures: DOM nodes on the first paint of each page and the time from
   pressing its sidebar row (or the draft's row) to the first rows being on screen. The numbers in docs/performance.md came from this file; tests/chunked-lists-browser.test.mjs
   walks the same fixture. Headless Chromium has no GPU compositor, so absolute times are pessimistic: compare before and after on one machine. */
/* global document, performance, requestAnimationFrame */
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../lib/store.js";
import { seedLibrary } from "./perf-seed.mjs";
import { launchChromium } from "./browser.mjs";
import { frames, openPage, startLateServer } from "./layout-late.mjs";
import { revealNavRow } from "./nav-reveal.mjs";

const hash = (n) => n.toString(16).padStart(64, "0");
const BOOK_PAGES = 160;
export const SHORT_DRAFT = 90;
/** The one course seedLibrary makes (the pages open scoped to it, so the materials belong to it). */
const COURSE = "Course 01 / Chapter 1";
const DAY = Date.UTC(2026, 8, 1, 12);

/** The time zone in which `at` is half past noon (a whole-hour zone, so one of the Etc/GMT zones): a day group of this fixture then holds the notes from 6 hours before `at`
    to 6 hours after it, whatever the real time is, and the test that imports a note "now" gets it into the same group as the fixture's notes. */
export function noonZone(at = Date.now()) {
  let hours = (12 - new Date(at).getUTCHours() + 24) % 24;
  if (hours > 14) hours -= 24;
  return hours === 0 ? "UTC" : `Etc/GMT${hours > 0 ? "-" : "+"}${Math.abs(hours)}`;
}

/** The draft's questions: letters that share no two-letter pairs worth counting (the near-duplicate check compares those), except two near-duplicates at `SIMILAR_AT` and the one after it. */
export const SIMILAR_AT = 100;
const stem = (index) => {
  let state = Math.imul(index + 1, 2654435761) >>> 0, text = "";
  for (let at = 0; at < 90; at++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    text += String.fromCharCode(97 + (state >>> 24) % 26) + (at % 6 === 5 ? " " : "");
  }
  return text.trim();
};
const NEAR = "Explain in your own words why a leader based replication protocol needs a quorum before it acknowledges a write to the client";

/** The library: `documents` notes in one local day, the newest at `newest` (first on the page), a 160-page book older than all of them, two decks with every card answered
    badly, and two drafts. Returns the ids the tests look for. */
export async function seedChunkLibrary(root, { documents = 1000, mistakes = 1000, questions = 500, newest = DAY, similarAt = SIMILAR_AT } = {}) {
  const perDeck = Math.ceil(mistakes / 2);
  await seedLibrary(root, { sources: 4, decks: 2, cardsPerDeck: perDeck, runs: 2, attempts: 0, courses: 1, largeSources: 0 });
  const store = new Store(root);
  await store.update((library) => {
    for (let n = 0; n < documents; n++)
      library.sources.push({ id: `note-${n}`, title: `Reading note ${String(n).padStart(4, "0")} consistency models`, text: `Note ${n}: linearizability and eventual consistency compared.`,
        createdAt: new Date(newest - n * 30_000).toISOString(), courses: [COURSE] });
    const filename = "Distributed Systems Textbook.pdf", old = new Date(newest - (documents + 5) * 30_000).toISOString();
    for (let page = 1; page <= BOOK_PAGES; page++)
      library.sources.push({ id: `book-p${page}`, title: `${filename} · ${page}`, text: `Page ${page} of the textbook: replication, consensus and the CAP trade-off.`, createdAt: old, courses: [COURSE],
        document: { id: hash(1), filename, page, totalPages: BOOK_PAGES, extractionVersion: 2, format: "pdf" } });
    const cards = library.decks.flatMap((deck) => deck.cards.map((card) => ({ deck, card }))).slice(0, mistakes);
    library.attempts = cards.map(({ deck, card }, index) => ({ id: `wrong-${index}`, runId: library.runs[0].id, quiz_id: card.id, deckId: deck.id, topic: card.topic,
      timestamp: new Date(DAY + index * 60_000).toISOString(), grade: 1, elapsed_ms: 3000,
      before: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null }, after: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null } }));
    const draft = (id, title, length, at, extra = {}) => ({ id, title, course: "", draftVersion: 1,
      cards: Array.from({ length }, (_, index) => ({ id: `${id}-q${index}`, kind: "open", topic: `Topic ${index % 9}`, objective: `Objective ${index}`,
        prompt: index === at || index === at + 1 ? `${NEAR}${index === at ? "" : " first"}?` : `${stem(index + at * 1000)}?`, answer: `Answer ${index}`, hint: `Hint ${index}`,
        explanation: `Explanation ${index}`, misconception: `Mistake ${index}`, rubric: `Rubric ${index}`, citations: [] })),
      editorial: { requested: length, generated: length, failures: [], reviewedCards: {}, ...extra } });
    library.drafts.push(draft("chunk-draft", "A long draft", questions, similarAt));
    // Over one chunk (80) and under the 100 questions a draft can be added to; the second question was sent back, so the page offers 查看详情.
    library.drafts.push(draft("short-draft", "A draft of ninety", SHORT_DRAFT, -1, { rejectedIssues: { "short-draft-q2": ["The answer is not in the cited text."] } }));
  });
  return { documents, mistakes, questions, bookKey: `pdf:${hash(1)}`, similarAt };
}

/** In the page: press `press` (a selector; `text`: the one whose draft row holds it), then count the frames until `rows` (a selector) is drawn and two more; returns { ms, nodes, rows }. */
const pressAndMeasure = (page, press, rows, text = "") => page.evaluate(async ([pressSelector, rowSelector, within]) => {
  const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
  const started = performance.now();
  [...document.querySelectorAll(pressSelector)].find((element) => !within || element.closest(".draft-row")?.textContent.includes(within)).click();
  while (!document.querySelector(rowSelector)) await frame();
  await frame(); await frame();
  return { ms: Math.round((performance.now() - started) * 10) / 10, nodes: document.querySelectorAll("*").length, rows: document.querySelectorAll(rowSelector).length };
}, [press, rows, text]);

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Open each of the three lists `rounds` times from the library page; the median time, and the DOM nodes and rows of the first paint. */
export async function measureChunkedLists({ browser, running, width = 1280, rounds = 3 }) {
  const { page, context, errors } = await openPage(browser, running, { lang: "en", theme: "light", width, timezoneId: "UTC" });
  await page.goto(running.server.url);
  await page.locator(".sidebar, .nav-menu-toggle").first().waitFor({ timeout: 30000 });
  for (const id of ["library", "sources", "wrongbook"]) await revealNavRow(page, id);
  const lists = {
    sources: { press: '[data-tour="nav-sources"]', rows: ".sources-page .source-doc" },
    wrongbook: { press: '[data-tour="nav-wrongbook"]', rows: ".wb-row", open: ".wb-group .wb-group-toggle" },
    draft: { press: ".draft-row .draft-open", rows: ".draft-card", text: "A long draft" },
  };
  const result = { errors };
  for (const [name, list] of Object.entries(lists)) {
    const samples = [];
    for (let round = 0; round < rounds; round++) {
      await page.evaluate(() => document.querySelector('[data-tour="nav-library"]').click());
      await frames(page, 8);
      if (name === "draft") {
        const fold = page.locator("details.home-drafts").first();
        await fold.waitFor({ state: "attached", timeout: 30000 });
        if (!await fold.evaluate((element) => element.open)) await fold.locator("summary").first().click();
        await page.locator(list.press).first().waitFor({ state: "visible", timeout: 30000 });
      }
      if (name === "wrongbook") {
        // The groups open folded and remember what was open for the session: start from folded, then press the first group (that press is what is timed).
        await page.evaluate(() => { sessionStorage.clear(); document.querySelector('[data-tour="nav-wrongbook"]').click(); });
        await page.locator(".wb-retrain").waitFor({ timeout: 30000 });
        await frames(page, 4);
        samples.push(await pressAndMeasure(page, list.open, list.rows));
        continue;
      }
      samples.push(await pressAndMeasure(page, list.press, list.rows, list.text));
    }
    result[name] = { ms: median(samples.map((sample) => sample.ms)), nodes: samples[0].nodes, rows: samples[0].rows, samples: samples.map((sample) => sample.ms) };
  }
  await context.close();
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : fallback; };
  const { buildPreview } = await import("../build.mjs");
  const dist = arg("dist", "") || await mkdtemp(join(tmpdir(), "study-chunk-dist-"));
  if (!arg("dist", "")) await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: (root) => seedChunkLibrary(root, { documents: Number(arg("documents", 1000)), mistakes: Number(arg("mistakes", 1000)), questions: Number(arg("questions", 500)) }) });
  const browser = await launchChromium();
  try {
    console.log(JSON.stringify(await measureChunkedLists({ browser, running, width: Number(arg("width", 1280)), rounds: Number(arg("rounds", 3)) }), null, 1));
  } finally { await browser.close(); await running.close(); if (!arg("dist", "")) await rm(dist, { recursive: true, force: true }); }
}
