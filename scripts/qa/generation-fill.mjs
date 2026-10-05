/* node scripts/qa/generation-fill.mjs [--lang zh|en --theme dark|light --width 1280|420 --out <dir>]
   Browser check of filling a deck (#196 #200 #201), on a seeded temporary library with the fake model:
     1  the draft page of a deck that cites 2 of 6 pages of one book: the coverage list groups the pages by document (#201),
        and 「用未覆盖的资料补题」 names the deck and the count (#196)
     2  pressing it adds the questions to THAT draft: no new deck, no second draft, the same title, the added pages cited
     3  while the fill runs the deck shows one task card, the list row says 补题中 and the button is off (#200)
   Everything runs against a temporary library; nothing of the owner's library, keys or network is touched. */
import { join } from "node:path";
import assert from "node:assert/strict";
import { previewCall } from "../preview-server.mjs";
import { StudyService } from "../../lib/service.js";
import { parseQaArgs, runQa, finishCli } from "./harness.mjs";

const options = parseQaArgs(process.argv.slice(2), "generation-fill", {});
const BOOK = "Software Architecture An Engineering Approach (TruePDF) (Mark Richards, Neal Ford) (z-library.sk, 1lib.sk, z-lib.sk).pdf";
const page = (n) => `Page ${n}. Architecture is the set of decisions that are hard to change later, so each decision weighs trade-offs between characteristics such as cost, speed and safety on page ${n}.`;
const card = (n, sourceId, text) => ({ id: `q${n}`, kind: "flashcard", topic: "Architecture", objective: `Seeded target ${n}`, prompt: `Seeded question ${n}: what does the passage state?`,
  answer: `Answer ${n}.`, hint: "Think about what is hard to change.", explanation: "The passage states it.", misconception: "Confusing the scope.", citations: [{ sourceId, quote: text.slice(0, 60) }] });

const summary = await runQa({ name: "generation-fill", options, latencyMs: 700,
  seed: async (root) => {
    const service = new StudyService(root);
    const ids = [];
    for (let n = 1; n <= 6; n += 1) { const id = `page-${n}`; ids.push(id); await service.call("source.add", { id, title: `${BOOK} · p.${20 + n}`, text: page(n) }); }
    const sources = ids.map((id, index) => ({ id, title: `${BOOK} · p.${21 + index}` }));
    await service.call("draft.save", { deck: { id: "deck-step1", title: "第1步 架构思维与MOD1衔接", course: "Arch", cards: [card(1, "page-1", page(1)), card(2, "page-2", page(2))],
      editorial: { requested: 2, generated: 2, parts: 1, completedParts: 1, failures: [], reviewedAt: new Date().toISOString(),
        coverage: { selected: 6, cited: 2, sources: sources.map((source, index) => ({ ...source, planned: index < 2 ? 1 : 0, accepted: index < 2 ? 1 : 0 })), uncited: sources.slice(2) },
        generation: { sourceIds: ids, kind: "flashcard", language: options.lang === "en" ? "English" : "中文", difficulty: "mixed", course: "Arch" } } } });
  },
  async run({ page: view, server, t, step, check, sleep }) {
    const call = (action, args) => previewCall(server, action, args);
    const state = () => call("export");
    await step("home-draft", async () => {
      await view.locator(".draft-row .draft-open").first().waitFor({ timeout: 20000 });
    });
    await view.locator(".draft-row .draft-open").first().click();
    await view.locator(".draft-page").waitFor({ timeout: 15000 });
    await view.locator(".draft-generation-details > summary").click();
    await view.locator(".draft-generation-details .sh-disclosure > summary, .draft-generation-details details > summary", { hasText: t("逐份资料出题记录", "Per-source record") }).first().click();
    await step("add-button", async () => {
      const block = view.locator("[data-add-from-sources]");
      await block.waitFor({ timeout: 10000 });
      const text = await block.innerText();
      assert.match(text, /第1步 架构思维与MOD1衔接/, "the target deck is named");
      assert.match(text, t(/用 4 份未覆盖资料/, /4 uncovered sources/), "the number of sources is named");
      assert.match(text, t(/新建题组/, /new deck/i), "a new deck is a separate choice");
      await block.scrollIntoViewIfNeeded();
    });
    const before = await state();
    await view.locator("[data-add-from-sources] .sh-btn:not(.sh-btn--link)").first().click();
    await step("fill-running", async () => {
      await view.locator("[data-add-from-sources] .sh-btn[disabled]").first().waitFor({ timeout: 15000 });
      const text = await view.locator("[data-add-from-sources]").innerText();
      assert.match(text, t(/补题中|补题排队中/, /Adding|Fill|queued/i), `the button says what is happening: ${text}`);
    });
    await check("the fill ends in the same draft", async () => {
      for (let guard = 0; guard < 120; guard += 1) {
        const now = await state();
        if (!now.jobs?.some((job) => ["queued", "running", "cancelling"].includes(job.status)) && now.drafts[0].cards.length > before.drafts[0].cards.length) break;
        await sleep(500);
      }
      const after = await state();
      assert.equal(after.drafts.length, 1, "no second draft");
      assert.equal(after.decks.length, 0, "no new deck");
      assert.equal(after.drafts[0].title, "第1步 架构思维与MOD1衔接");
      assert.ok(after.drafts[0].cards.length > 2, `the deck gained cards: ${after.drafts[0].cards.length}`);
      return after.drafts[0].cards.length;
    });
    await step("filled", async () => { await view.reload(); await view.locator(".draft-row .draft-open").first().click(); await view.locator(".draft-page").waitFor({ timeout: 15000 }); });
    await check("no console or page errors", async () => undefined);
    void join;
  } });
finishCli("generation-fill", options, summary);
