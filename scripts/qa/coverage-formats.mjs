/* npm run qa:coverage-formats [-- --lang zh|en --theme dark|light --width 1280|420 --out <dir>]
   Coverage in the reader's outline for the formats whose outline is NOT the transcript's own sections (lib/sections.js ids): a Markdown document (the outline is the headings of what is
   drawn, matched to the sections by title) and a PDF book (every page is a source, matched by its page). A draft cites two headings of the manual and two pages of the book; the 资料 rows
   show 覆盖 x%, the reader's outline marks exactly those sections and says 覆盖 2/4 · 覆盖 2/6. Fake model, Chromium, every key/token/base-url variable removed. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Store } from "../../lib/store.js";
import { createStudyRuntime } from "../../lib/runtime/builtins.js";
import { makeTextPdf } from "../../tests/helpers/text-pdf.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const BOOK = "primer";
const heading = (title) => `Heading ${title} body sentence number one is distinct and long enough to quote. `.repeat(8);
const MANUAL = ["# Manual", "", ...["Install", "Configure", "Run", "Debug"].flatMap((title, index) => [`## ${index + 1} ${title}`, "", heading(title), ""])].join("\n");
const pageLine = (n) => `Consensus page ${n} states a distinct rule about quorums and leaders for replicas`;
const card = (id, sourceId, quote) => ({ id, kind: "flashcard", topic: "T", objective: `Objective ${id}`, prompt: `Question ${id}?`, answer: `Answer ${id}`, hint: "Think.", explanation: "Because.", misconception: "A mistake.",
  citations: [{ sourceId, quote }] });

export async function runCoverageFormatsQa(options) {
  return runQa({ name: "coverage-formats", options,
    seed: async (root) => {
      // The book is a real (generated) PDF imported the way a learner imports one: a document record, six page sources, the original kept.
      const runtime = createStudyRuntime(root);
      const pdf = await makeTextPdf(Array.from({ length: 6 }, (_, index) => [pageLine(index + 1), "A second line of the page keeps its text long enough to be extracted as a source."]));
      const imported = await runtime.call("materials.document.import", { filename: `${BOOK}.pdf`, courses: ["QA"], dataBase64: pdf.toString("base64") });
      runtime.dispose();
      const pages = imported.sourceIds;
      const store = new Store(root);
      await store.update((state) => {
        state.sources.push({ id: "manual", title: "Manual.md", text: MANUAL, createdAt: new Date().toISOString(), courses: ["QA"], format: "md" });
        const draft = (id, title, sourceIds, cards) => ({ id, title, course: "QA", draftVersion: 1, cards, editorial: { requested: cards.length, generated: cards.length, parts: 1, completedParts: 1, failures: [], reviewedAt: new Date().toISOString(),
          generation: { sourceIds, kind: "flashcard", language: "English", difficulty: "mixed", course: "QA" } } });
        state.drafts.push(draft("d-manual", "Manual questions", ["manual"], [card("m1", "manual", "Heading Configure body sentence number one is distinct and long enough to quote."), card("m2", "manual", "Heading Debug body sentence number one is distinct and long enough to quote.")]));
        state.drafts.push(draft("d-book", "Book questions", pages, [card("b1", pages[0], pageLine(1)), card("b2", pages[1], pageLine(2))]));
      });
    },
    async run({ page: view, server, t, step, check, summary }) {
      const facts = {};
      summary.facts = facts;
      const viewer = view.locator(".study-document-viewer");
      const goto = async (nav) => { const entry = view.locator(`[data-tour="nav-${nav}"]`).first(); await entry.waitFor({ state: "attached" }); await entry.dispatchEvent("click"); await sleep(900); };
      const openOutline = async () => { if (!(await viewer.locator(".reader-outline").count())) await viewer.getByRole("button", { name: t("目录", "Contents"), exact: true }).click(); await viewer.locator(".reader-outline").waitFor(); };
      const closeReader = async () => { await view.keyboard.press("Escape"); await sleep(300); if (await viewer.count()) await view.locator("dialog[open]").getByRole("button", { name: t("关闭", "Close") }).first().click().catch(() => {}); await sleep(400); };
      const marks = async (state) => viewer.locator(`.reader-outline [data-coverage-mark="${state}"]`).count();
      void server;
      await step("sources-rows", async () => {
        await goto("sources");
        const rows = await view.locator(".source-doc").count();
        assert.equal(rows, 2, "the manual and the book");
        const chips = await view.locator("[data-coverage-chip]").allInnerTexts();
        facts.chips = chips.map((text) => text.trim());
        assert.deepEqual(facts.chips.sort(), [t("覆盖 33%", "Covered 33%"), t("覆盖 50%", "Covered 50%")].sort(), "manual: 2 of 4 headings; book: 2 of 6 pages");
        const probe = await view.evaluate(overflowProbe); assert.ok(probe.scrollWidth <= probe.clientWidth + 1);
      });
      await step("markdown-outline-marks", async () => {
        await view.locator(".source-doc", { hasText: "Manual" }).first().locator(".source-main").click();
        await viewer.waitFor();
        await sleep(1200);
        await openOutline();
        const head = await viewer.locator("[data-coverage-head]").innerText();
        assert.ok(head.includes("2/4"), head);
        assert.equal(await marks("covered"), 2, "Configure and Debug");
        assert.equal(await marks("never-planned"), 2, "Install and Run");
        const labelled = await viewer.locator('.reader-outline [data-coverage-mark="covered"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
        facts.markdownCovered = labelled;
        assert.ok(labelled.some((label) => label.includes("Configure")) && labelled.some((label) => label.includes("Debug")), labelled.join(" | "));
        assert.equal(await viewer.locator("[data-coverage-parent]").count(), 1, "the manual's title above its four sections counts them");
      });
      await closeReader();
      await step("pdf-pages-outline-marks", async () => {
        await goto("sources");
        await view.locator(".source-doc", { hasText: BOOK }).first().locator(".source-main").click();
        await viewer.waitFor();
        await sleep(1500);
        await openOutline();
        const head = await viewer.locator("[data-coverage-head]").innerText();
        assert.ok(head.includes("2/6"), head);
        assert.equal(await marks("covered"), 2, "pages 1 and 2");
        assert.equal(await marks("never-planned"), 4, "pages 3 to 6");
        const labelled = await viewer.locator('.reader-outline [data-coverage-mark="covered"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
        facts.pagesCovered = labelled;
        const toolbar = options.width >= 900 ? (await viewer.locator(".reader-toolbar__coverage").innerText()).trim() : "";
        facts.toolbarChip = toolbar;
      });
      await step("pdf-practice-panel-line", async () => {
        if (options.width < 900) { await viewer.locator(".reader-scrim").click({ position: { x: options.width - 8, y: 200 } }).catch(() => {}); await sleep(300); }
        await viewer.getByRole("button", { name: t("做这几页的题", "Practise these pages"), exact: false }).first().click();
        const panel = viewer.locator(".reader-practice__panel");
        await panel.waitFor();
        facts.panel = (await panel.innerText()).split("\n").filter(Boolean).slice(0, 8);
      });
      await view.keyboard.press("Escape");
      await closeReader();
      await check("no console or page errors", async () => undefined);
    } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseQaArgs(process.argv.slice(2), "coverage-formats", {}), summary = await runCoverageFormatsQa(options);
    finishCli("Coverage formats", options, summary);
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 2;
  }
}
