/* npm run qa:deck-part2 [-- --lang zh|en --theme dark|light --width 1280|420 --accent jade --scenario merge|new-deck --out <dir>]
   The top-up of a PUBLISHED deck's material (the owner's decision of 2026-10-06, lib/deck-parts.js) in the browser preview, on a seeded temporary library with the fake model: the merged five-recording
   transcript (80 sections), a first deck of a few questions published at about 9% coverage. The walk is the student's:
     资料 row says 覆盖 9% and offers 为没覆盖的部分补题 → its popover says the part (「作为「Deck」的第二部分」), the round and 「覆盖现在 …→ 本轮后约 …→ 目标 100%，还要 N 轮、约 M 题」 (compared with
     coverage.get) → the run goes round after round (任务 console title 「Deck · 第二部分」) → the draft page says 「这份草稿是「Deck」的第二部分」 and offers where it goes → publish into the deck → the deck
     page says 「第一部分 N 题 · 第二部分 M 题」 and filters by part, the 资料 row's coverage rose, the library row counts the deck total → the button is gone (nothing uncovered).
   Scenario new-deck: the same draft published as a deck of its own (the first deck untouched, no part marker).
   Every number is compared with the snapshot / coverage.get. Fake model, Chromium, every key/token/base-url variable removed. One screenshot per step and <out>/summary.json. */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Store } from "../../lib/store.js";
import { previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { finishCli, overflowProbe, parseQaArgs, repoRoot, runQa, sleep } from "./harness.mjs";
import { mergedTranscript, RECORDING_NAMES } from "../../tests/helpers/merged-transcript.mjs";
import { sectionsOf } from "../../lib/sections.js";

const world = mergedTranscript();
const iso = (ms) => new Date(ms).toISOString();
const COVERAGE = { roundLimit: 30, fillRounds: 2 };
const ZH_PART = ["一", "二", "三"];

/** Scenario `covered`: a published deck with one question in every section (nothing is left to top up). */
function everySection(sources) {
  return sectionsOf(sources).filter((section) => section.leaf).map((section, index) => {
    const text = sources.find((source) => source.id === section.sourceId).text, body = text.slice(section.start, section.end);
    const quote = (/Recording \d+, part \d+, point 1\.1: [^.]{20,90}/.exec(body) || [body.slice(30, 90).trim()])[0];
    return { id: `qa-card-${index + 1}`, kind: "flashcard", topic: section.title || `Section ${index + 1}`, objective: `Objective ${index + 1}`, prompt: `Question ${index + 1}`, answer: `Answer ${index + 1}`,
      citations: [{ sourceId: section.sourceId, quote }] };
  });
}

async function seed(root, { covered = false } = {}) {
  const store = new Store(root), batchId = "qa-part", ids = world.sources.map((_, index) => (index ? `audio-batch-${batchId}-p${index + 1}` : `audio-batch-${batchId}`));
  const batch = { id: batchId, title: `${RECORDING_NAMES[0]} + 4`, members: RECORDING_NAMES.map((filename, index) => ({ order: index + 1, filename, hash: String(index).padStart(64, "0") })), volumes: world.sources.length };
  await store.update((state) => {
    world.sources.forEach((source, index) => state.sources.push({ id: ids[index], createdAt: iso(Date.now() - 60000), text: source.text, courses: ["QA"], title: `${batch.title} · ${index + 1}/${world.sources.length}`,
      audio: { course: "", batch: { ...batch, volume: index + 1 }, sourceIds: ids, importedAt: iso(Date.now() - 60000) } }));
    if (covered) state.decks.push({ id: "qa-covered", title: "全覆盖题组", folder: "", course: "QA", createdAt: iso(Date.now() - 30000), publishedAt: iso(Date.now() - 30000),
      cards: everySection(state.sources), editorial: {} });
  });
  return ids;
}

export function parseArgs(argv) {
  const base = parseQaArgs(argv, "deck-part2", { accent: "jade", scenario: "merge" });
  if (!["merge", "new-deck", "covered"].includes(base.scenario)) throw new Error("--scenario must be merge, new-deck or covered");
  const width = Number(base.width) === 1440 && !argv.includes("--width") ? 1280 : base.width;
  return { ...base, width, height: width < 700 ? 860 : 900, out: argv.includes("--out") ? base.out : join(repoRoot, `output/qa/deck-part2/${base.lang}-${base.theme}-${width}${base.scenario === "merge" ? "" : `-${base.scenario}`}`) };
}

export async function runPartQa(options) {
  return runQa({ name: "deck-part2", options, model: createFakeModel({ latencyMs: 40, usage: true }), latencyMs: 40, coverage: COVERAGE,
    localStorageSeed: { "study-interface": JSON.stringify({ accent: options.accent }) },
    seed: async (root) => { options.ids = await seed(root, { covered: options.scenario === "covered" }); },
    async run({ page, server, step, summary }) {
      const call = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: options.lang });
      const ids = options.ids, facts = {}, zh = options.lang === "zh";
      summary.facts = facts;
      const said = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();
      const noOverflow = async (label) => { const probe = await page.evaluate(overflowProbe); assert.ok(probe.scrollWidth <= probe.clientWidth + 1, `horizontal overflow on ${label}: ${JSON.stringify(probe)}`); };
      const goto = async (nav) => { const entry = page.locator(`[data-tour="nav-${nav}"]`).first(); await entry.waitFor({ state: "attached" }); await entry.dispatchEvent("click"); await sleep(900); };
      const snapshot = () => call("snapshot", {});
      const waitFor = async (what, check, { timeoutMs = 180000, every = 300 } = {}) => { const end = Date.now() + timeoutMs; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(every); } };
      const idle = () => waitFor("the jobs to end", async () => !(await snapshot()).jobs.some((job) => ["queued", "running", "cancelling"].includes(job.status)), { timeoutMs: 300000 });
      const partWord = (n) => (zh ? `第${ZH_PART[n - 1]}部分` : `Part ${n}`);

      const row = () => page.locator(`[data-document-key]`).first();
      if (options.scenario === "covered") {
        // Every section has a question: neither the 资料 row nor the reader offers the top-up.
        const view = await call("coverage.get", { sourceId: ids[0] });
        facts.covered = { covered: view.coverage.covered, leaves: view.coverage.leaves, canTopUp: view.topUp.canTopUp };
        await step("covered-no-button", async () => {
          assert.equal(view.coverage.covered, view.coverage.leaves, "the seeded deck covers every section");
          assert.equal(view.topUp.canTopUp, false);
          await goto("sources");
          await row().waitFor({ timeout: 30000 });
          facts.rowChip = await said(row().locator("[data-coverage-chip]"));
          assert.ok(facts.rowChip.includes("100%"), facts.rowChip);
          assert.equal(await row().locator("[data-document-topup-open]").count(), 0, "nothing uncovered: no button on the row");
          await row().locator(".source-main").click();
          const outline = page.getByRole("button", { name: zh ? "目录" : "Contents" }).first();
          await outline.waitFor({ timeout: 30000 });
          if (await outline.getAttribute("aria-pressed") !== "true") await outline.click();
          await page.locator("[data-coverage-head]").first().waitFor({ timeout: 30000 });
          facts.readerHead = await said(page.locator("[data-coverage-head]").first());
          assert.equal(await page.locator("[data-coverage-head] [data-document-topup-open]").count(), 0, "nor in the reader");
        });
        return;
      }
      // The first deck: a plain run of a few questions over the 80 sections, published as it is (about 9% coverage).
      const first = await call("generate", { sourceIds: ids, kind: "quiz", count: 7, title: zh ? "平台课复习" : "Platform review" });
      await idle();
      let draft = (await snapshot()).drafts.find((item) => item.id === first.draftId) || (await snapshot()).drafts[0];
      const receipt = await call("draft.publish.quick", { id: draft.id, draftVersion: draft.draftVersion });
      const deckId = receipt.deckId, deck = await call("deck.get", { id: deckId });
      const before = await call("coverage.get", { sourceId: ids[0] });
      facts.before = { covered: before.coverage.covered, leaves: before.coverage.leaves, percent: before.coverage.percentLeaves, deckCards: deck.cards.length, rounds: before.topUp.round.rounds, questions: before.topUp.round.allQuestions };
      assert.ok(before.coverage.percentLeaves <= 15, `the first deck covers little: ${before.coverage.percentLeaves}%`);
      await page.reload(); await page.locator("aside, nav").first().waitFor({ timeout: 30000 }); await sleep(800);

      await step("materials-row-offers-topup", async () => {
        await goto("sources");
        await row().waitFor({ timeout: 30000 });
        const chip = await said(row().locator("[data-coverage-chip]"));
        facts.rowChip = chip;
        assert.ok(chip.includes(`${before.coverage.percentLeaves}%`), `the row says the coverage the backend says: ${chip}`);
        assert.equal(await row().locator("[data-document-topup-open]").count(), 1, "the row offers the top-up");
        await row().scrollIntoViewIfNeeded();
        await noOverflow("the 资料 row");
      });
      await step("reader-outline-offers-topup", async () => {
        await row().locator(".source-main").click();
        const outline = page.getByRole("button", { name: zh ? "目录" : "Contents" }).first();
        await outline.waitFor({ timeout: 30000 });
        if (await outline.getAttribute("aria-pressed") !== "true") await outline.click();
        const head = page.locator("[data-coverage-head]").first();
        await head.waitFor({ timeout: 30000 });
        facts.readerHead = await said(head);
        assert.ok(facts.readerHead.includes(`${before.coverage.covered}/${before.coverage.leaves}`), facts.readerHead);
        assert.equal(await head.locator("[data-document-topup-open]").count(), 1, "the reader's outline offers the same top-up");
        await head.locator("[data-document-topup-open]").click();
        await page.locator("[data-document-topup] [data-coverage-path]").waitFor({ timeout: 30000 });
        facts.readerPath = await said(page.locator("[data-document-topup] [data-coverage-path]").first());
        await sleep(600);
        await noOverflow("the reader's outline");
      });
      await step("confirmation-coverage-path", async () => {
        // The reader is a dialog over the 资料 page: Escape closes the popover, the outline (an overlay when narrow), then the reader.
        for (let n = 0; n < 4 && await page.locator(".study-document-viewer").count(); n += 1) { await page.keyboard.press("Escape"); await sleep(400); }
        await page.locator(".study-document-viewer").first().waitFor({ state: "detached", timeout: 15000 });
        await goto("sources");
        await row().waitFor({ timeout: 30000 });
        await row().locator("[data-document-topup-open]").click();
        const panel = page.locator("[data-document-topup]").first();
        await panel.waitFor({ timeout: 30000 });
        await panel.locator("[data-coverage-path]").waitFor({ timeout: 30000 });
        const path = await said(panel.locator("[data-coverage-path]")), part = await said(panel.locator("[data-part-line]")), round = await said(panel.locator("[data-coverage-round]"));
        Object.assign(facts, { path, part, round });
        assert.equal(path, facts.readerPath, "the reader and the 资料 row say the same way to full coverage");
        const c = before.coverage, r = before.topUp.round;
        const want = zh ? `覆盖现在 ${c.covered}/${c.leaves} 个小节（${c.percentLeaves}%）` : `Coverage now ${c.covered}/${c.leaves} sections (${c.percentLeaves}%)`;
        assert.ok(path.includes(want), `now: ${path}`);
        assert.ok(path.includes(zh ? `还要 ${r.rounds} 轮、约 ${r.allQuestions} 题` : `${r.rounds} more rounds, about ${r.allQuestions} questions`), `rounds and questions: ${path}`);
        assert.ok(part.includes(deck.title) && part.includes(partWord(2)), `whose part: ${part}`);
        await panel.locator("[data-token-estimate]").waitFor({ timeout: 30000 });
        await sleep(800);
        await noOverflow("the confirmation");
      });
      let job;
      await step("run-in-rounds-console", async () => {
        await page.locator("[data-document-topup] [data-coverage-start]").click();
        job = await waitFor("the part's job", async () => (await snapshot()).jobs.find((item) => item.part?.deckId === deckId), { timeoutMs: 30000 });
        await goto("tasks");
        await page.locator(".tc-row").first().waitFor({ timeout: 30000 });
        const title = await said(page.locator(".tc-row__title").first());
        facts.consoleTitle = title;
        assert.equal(title, `${deck.title} · ${partWord(2)}`);
        await page.locator(".tc-row").first().dispatchEvent("click");
        await sleep(800);
        await noOverflow("the console");
      });
      await step("run-finished", async () => {
        await idle();
        const done = (await snapshot()).jobs.find((item) => item.id === job.id);
        draft = (await snapshot()).drafts.find((item) => item.id === done.draftId);
        const rounds = draft.editorial.coverageSpec.rounds;
        facts.rounds = rounds.map((item) => ({ round: item.round, status: item.status, questions: item.questions, kept: item.kept }));
        assert.ok(rounds.length >= 2, "rounds, not one big request");
        assert.ok(rounds.every((item) => item.questions <= COVERAGE.roundLimit));
        assert.equal(JSON.stringify(await call("deck.get", { id: deckId })), JSON.stringify(deck), "the published deck is untouched before the learner publishes");
        await sleep(600);
      });
      await step("draft-says-part", async () => {
        await goto("library");
        const draftRow = page.locator(".draft-row", { hasText: partWord(2) }).first();
        await draftRow.waitFor({ timeout: 30000 });
        facts.homeRow = await said(draftRow.locator("strong").first());
        await draftRow.locator(".draft-open").click();
        await page.locator("[data-draft-part]").waitFor({ timeout: 30000 });
        const line = await said(page.locator("[data-draft-part]"));
        facts.draftLine = line;
        assert.ok(line.includes(deck.title) && line.includes(partWord(2)), line);
        assert.ok(await page.locator(`input[data-part-target="${deckId}"]`).isChecked(), "into the deck is the default");
        await noOverflow("the draft page");
      });
      const scenario = options.scenario;
      await step(scenario === "merge" ? "publish-into-deck" : "publish-as-new-deck", async () => {
        if (scenario !== "merge") await page.locator('input[data-part-target="new"]').check();
        await page.locator('[data-tour="draft-publish"] .sh-btn--primary').click();
        await waitFor("the draft to be published", async () => !(await snapshot()).drafts.some((item) => item.id === draft.id), { timeoutMs: 60000 });
        await sleep(1200);
      });
      if (scenario === "merge") {
        await step("deck-page-parts", async () => {
          const after = await call("deck.get", { id: deckId });
          const counts = [after.cards.filter((card) => !card.part).length, after.cards.filter((card) => card.part === 2).length];
          facts.parts = counts;
          assert.equal(counts[0], deck.cards.length);
          assert.equal(counts[1], draft.cards.length);
          await goto("library");
          const deckRow = page.locator(".map-deck", { hasText: deck.title }).first();
          await deckRow.waitFor({ timeout: 30000 });
          facts.libraryRow = await said(deckRow.locator(".map-name small").first());
          assert.ok(facts.libraryRow.includes(String(after.cards.length)), `the library counts the deck total: ${facts.libraryRow}`);
          // (The menu closes on any scroll, and a pointer click scrolls first: the items are pressed where they are.)
          await deckRow.scrollIntoViewIfNeeded();
          const more = deckRow.locator('[aria-haspopup="menu"]').first();
          // (The library is still settling right after the publication: wait for its row to be quiet, then open the menu with the keyboard.)
          await sleep(1000);
          await more.focus();
          await page.keyboard.press("ArrowDown");
          await page.locator('[role="menu"]').first().waitFor({ timeout: 10000 });
          facts.menu = await said(page.locator('[role="menu"]').first());
          await page.keyboard.press("End");
          await page.keyboard.press("Enter");
          await page.locator("[data-deck-parts]").waitFor({ timeout: 30000 });
          await page.locator("[data-deck-parts]").evaluate((node) => node.scrollIntoView({ block: "center" }));
          const line = await said(page.locator("[data-deck-parts]"));
          facts.deckLine = line;
          assert.equal(line, zh ? `第一部分 ${counts[0]} 题 · 第二部分 ${counts[1]} 题` : `Part 1: ${counts[0]} questions · Part 2: ${counts[1]} questions`);
          await noOverflow("the deck page");
        });
        await step("deck-page-filter-part2", async () => {
          await page.locator("[data-part-filter] .sh-seg__item", { hasText: partWord(2) }).first().click();
          await page.locator("[data-part-filter]").scrollIntoViewIfNeeded();
          await sleep(500);
          const shown = await page.locator(".manage-card").count();
          facts.filtered = shown;
          assert.equal(shown, facts.parts[1]);
        });
      } else {
        await step("new-deck-separate", async () => {
          const decks = (await snapshot()).decks.filter((item) => !item.archived);
          facts.decks = decks.map((item) => ({ title: item.title, count: item.count, parts: item.parts ?? null }));
          assert.equal(decks.length, 2);
          assert.equal(JSON.stringify(await call("deck.get", { id: deckId })), JSON.stringify(deck), "the first deck is untouched");
          assert.ok(decks.every((item) => !item.parts));
          await goto("library");
          await sleep(800);
        });
      }
      await step("materials-row-after", async () => {
        const now = await call("coverage.get", { sourceId: ids[0] });
        facts.after = { covered: now.coverage.covered, leaves: now.coverage.leaves, percent: now.coverage.percentLeaves, canTopUp: now.topUp.canTopUp };
        assert.ok(now.coverage.covered > before.coverage.covered, "the coverage rose");
        await goto("sources");
        await row().waitFor({ timeout: 30000 });
        const chip = await said(row().locator("[data-coverage-chip]"));
        facts.rowChipAfter = chip;
        assert.ok(chip.includes(`${now.coverage.percentLeaves}%`), chip);
        assert.equal(await row().locator("[data-document-topup-open]").count(), now.topUp.canTopUp ? 1 : 0, "the button is there only while something is uncovered");
        await noOverflow("the 资料 row after");
      });
    } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2)), summary = await runPartQa(options);
    finishCli("Deck part 2", options, summary);
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 2;
  }
}
