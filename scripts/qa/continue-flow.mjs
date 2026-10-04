/* npm-less QA: node scripts/qa/continue-flow.mjs [--lang zh|en --theme dark|light --width 1280|420 --out <dir>]
   Browser check of where 继续学习 goes after a round (#175, #177), on a seeded temporary library with the fake model:
     A  one chosen question → answer → results page → the coach card does not start the same 1/1 question again
        (without a plan: back to the learning path; with an accepted plan: its next action)
     B  question 2 of a round → 前置题 → finish the prerequisite round → the only primary action is 回到原题, and it lands on
        question 2 again, unanswered. */
/* global document, window, localStorage -- page.evaluate callbacks run in the browser */
import { join } from "node:path";
import assert from "node:assert/strict";
import { previewCall } from "../preview-server.mjs";
import { Store } from "../../lib/store.js";
import { seedLibrary } from "./perf-seed.mjs";
import { parseQaArgs, runQa, finishCli } from "./harness.mjs";

const options = parseQaArgs(process.argv.slice(2), "continue-flow", {});
const deck = "deck-0";
const summary = await runQa({ name: "continue-flow", options,
  seed: async (root) => {
    await seedLibrary(root, { sources: 6, decks: 2, cardsPerDeck: 8, runs: 0, attempts: 0, courses: 1, largeSources: 0 });
    // card d0-c6 (a quiz) needs d0-c0 (a flashcard) first
    await new Store(root).update((library) => { library.decks[0].cards.find((card) => card.id === "d0-c6").requires = [{ deckId: deck, cardId: "d0-c0" }]; });
  },
  async run({ page, server, t, step, check, sleep }) {
    const call = (action, args) => previewCall(server, action, args);
    const resume = async () => {
      await page.reload();
      await page.waitForSelector("button.nav", { timeout: 20000 });
      await sleep(600);
      await page.locator('[data-usage="nav.resume"]').click();
      await page.locator(".review-page").waitFor({ timeout: 15000 });
    };
    const header = () => page.locator(".question-meta > span").first().innerText();
    // flashcards are flipped and graded 4; a quiz is answered through the API (its options are shuffled on screen, the ids are not)
    const answerOpen = async () => {
      if (await page.locator(".next-due").count()) return;
      if (await page.locator("button.option").count()) await page.locator("button.option").first().click();
      else { await page.keyboard.press("Space"); await page.locator(".grade.high").first().click(); }
      await page.locator('[data-usage="review.next"]:not([disabled])').waitFor({ timeout: 10000 });
    };
    const finishRound = async () => {
      for (let guard = 0; guard < 12; guard += 1) {
        if (await page.locator(".result-page").count()) return;
        await answerOpen();
        await page.locator('[data-usage="review.next"]').click();
        await sleep(500);
      }
      await page.locator(".result-page").waitFor({ timeout: 5000 });
    };
    const startScope = async (cardIds) => call("review.start", { mode: "path", fresh: true, scope: cardIds.map((cardId) => ({ deckId: deck, cardId })) });

    // ── A: one chosen question, no plan ──
    const one = await startScope(["d0-c1"]);
    await call("review.answer", { runId: one.id, cardId: "d0-c1", queueVersion: 0, selected: ["b"] });
    await resume();
    await step("a-question", async () => { assert.match(await header(), /1 \/ 1/); });
    await finishRound();
    const first = await page.locator(".question-meta").count();
    await step("a-results", async () => {
      const coach = page.locator(".coach-debrief");
      await coach.waitFor({ timeout: 15000 });
      const label = (await coach.locator("button.sh-btn--primary").first().innerText()).trim();
      assert.ok(!/^继续学习|^Continue studying/.test(label) || label.length > 0);
      assert.match(label, t(/回到学习路径|继续学习/, /Back to the learning path|Continue studying/), `the card names where it goes: ${label}`);
      return label;
    });
    await step("a-continue", async () => {
      await page.locator(".coach-debrief button.sh-btn--primary").first().click();
      await page.locator(".review-page .question-meta").waitFor({ timeout: 15000 });
      const text = await header();
      assert.doesNotMatch(text, /^1 \/ 1$/, `a new path round, not the same 1/1 question: ${text}`);
      return text;
    });
    void one; void first;

    // ── A2: the same, with today's plan accepted ──
    const date = new Date().toISOString().slice(0, 10);
    const suggested = await call("daily.plan.suggest", { date, minutes: 60 });
    if (suggested.proposal) await call("daily.plan.accept", { date, proposalId: suggested.proposal.id });
    const again = await startScope(["d0-c1"]);
    await call("review.answer", { runId: again.id, cardId: "d0-c1", queueVersion: 0, selected: ["b"] });
    await resume();
    await finishRound();
    await step("a2-plan-results", async () => {
      const coach = page.locator(".coach-debrief");
      await coach.waitFor({ timeout: 15000 });
      const label = (await coach.locator("button.sh-btn--primary").first().innerText()).trim();
      return label;
    });
    await step("a2-plan-next", async () => {
      await page.locator(".coach-debrief button.sh-btn--primary").first().click();
      await page.locator(".review-page .question-meta").waitFor({ timeout: 15000 });
      const text = await header();
      assert.doesNotMatch(text, /^1 \/ 1$/, `the plan's next action, not the same question: ${text}`);
      return text;
    });
    void again;

    // ── B: question 2, prerequisites, and the way back ──
    await page.evaluate(() => localStorage.removeItem("study-daily-plan:open"));
    const original = await startScope(["d0-c1", "d0-c6", "d0-c5"]);
    // the round puts a question's prerequisite before it: walk to the first question that has one
    let at = 0, view = original;
    while (!view.prerequisites?.length && at < 6) { at += 1; view = await call("review.move", { runId: original.id, index: at }); }
    assert.ok(view.prerequisites?.length, "a question with prerequisites exists in the round");
    await resume();
    const before = await header();
    await step("b-original-question", async () => { assert.match(before, new RegExp(`^${at + 1} / ${view.total}$`)); return before; });
    await page.locator(".prereq-strip summary button").first().click();
    await page.locator(".review-page .question-meta").waitFor();
    await step("b-prerequisite-round", async () => { assert.match(await header(), /1 \/ 1/); });
    await finishRound();
    await step("b-results", async () => {
      const coach = page.locator(".coach-debrief");
      await coach.waitFor({ timeout: 15000 });
      const primaries = page.locator(".result-page button.sh-btn--primary");
      const names = (await primaries.allInnerTexts()).map((text) => text.trim());
      assert.equal(names.filter((name) => /继续学习|Continue studying/.test(name)).length, 0, `no competing 继续学习: ${names.join(" | ")}`);
      assert.equal(names.filter((name) => /回到原题|original question/i.test(name)).length, 1, `one way back: ${names.join(" | ")}`);
      return names;
    });
    await step("b-back-to-original", async () => {
      await page.locator(".result-page button.sh-btn--primary", { hasText: t("回到原题", "original question") }).click();
      await page.locator(".review-page .question-meta").waitFor({ timeout: 15000 });
      const text = await header();
      assert.equal(text, before, `back on the question it came from: ${text}`);
      assert.equal(await page.locator(".option.correct, .option.incorrect, .next-due").count(), 0, "the question is still unanswered");
      return text;
    });
    await check("no console or page errors in the flow", async () => undefined);
  } });
finishCli("continue-flow", options, summary);
void join;
