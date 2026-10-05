/* node scripts/qa/generation-fill.mjs [--lang zh|en --theme dark|light --width 1280|420 --out <dir>]
   Browser check of filling a deck (#196 #200 #201 #203), on a seeded temporary library with the fake model:
     1  the draft page of a deck that cites 2 of 6 pages of one book: the coverage list names the book once with its pages (#201), and
        the one top-up 「为没覆盖的部分补题」 says how many pages it covers this round (#196)
     2  pressing it adds the questions to THAT draft: no new deck, no second draft, the same title
     3  while a second fill runs, the home shows ONE task card for the deck, the earlier job folded into it, and the list row says 补题中 as a Badge (#200, #203)
   Everything runs against a temporary library; nothing of the owner's library, keys or network is touched. */
import assert from "node:assert/strict";
import { previewCall } from "../preview-server.mjs";
import { StudyService } from "../../lib/service.js";
import { parseQaArgs, runQa, finishCli, overflowProbe } from "./harness.mjs";

const options = parseQaArgs(process.argv.slice(2), "generation-fill", {});
const BOOK = "Software Architecture An Engineering Approach (TruePDF) (Mark Richards, Neal Ford) (z-library.sk, 1lib.sk, z-lib.sk)";
const CLEAN = "Software Architecture An Engineering Approach (Mark Richards, Neal Ford)";
const hash = "c".repeat(64);
const page = (n) => `Page ${n}. Architecture is the set of decisions that are hard to change later, so each decision weighs trade-offs between characteristics such as cost, speed and safety on page ${n}.`;
const card = (n, sourceId, text) => ({ id: `q${n}`, kind: "flashcard", topic: "Architecture", objective: `Seeded target ${n}`, prompt: `Seeded question ${n}: what does the passage state?`,
  answer: `Answer ${n}.`, hint: "Think about what is hard to change.", explanation: "The passage states it.", misconception: "Confusing the scope.", citations: [{ sourceId, quote: text.slice(0, 60) }] });
const TITLE = "第1步 架构思维与MOD1衔接";

const summary = await runQa({ name: "generation-fill", options, latencyMs: 700,
  seed: async (root) => {
    const service = new StudyService(root);
    const ids = [];
    for (let n = 1; n <= 6; n += 1) { const id = `page-${n}`; ids.push(id); await service.call("source.add", { id, title: `${BOOK} · p.${20 + n}`, text: page(n) }); }
    await service.store.update((state) => {
      state.sources.forEach((source, index) => { source.document = { materialId: `document-${hash}-pdf`, id: hash, bookTitle: BOOK, filename: `${BOOK}.pdf`, page: 21 + index, totalPages: 400, format: "pdf", extractionVersion: 2 }; });
    });
    const sources = ids.map((id, index) => ({ id, title: `${BOOK} · p.${21 + index}` }));
    await service.call("draft.save", { deck: { id: "deck-step1", title: TITLE, course: "Arch", cards: [card(1, "page-1", page(1)), card(2, "page-2", page(2))],
      editorial: { requested: 2, generated: 2, parts: 1, completedParts: 1, failures: [], reviewedAt: new Date().toISOString(),
        coverage: { selected: 6, cited: 2, sources: sources.map((source, index) => ({ ...source, planned: index < 2 ? 1 : 0, accepted: index < 2 ? 1 : 0 })), uncited: sources.slice(2) },
        generation: { sourceIds: ids, kind: "flashcard", language: options.lang === "en" ? "English" : "中文", difficulty: "mixed", course: "Arch" } } } });
  },
  async run({ page: view, server, t, step, check, sleep }) {
    const call = (action, args) => previewCall(server, action, args);
    const state = () => call("export");
    const idle = async () => { for (let guard = 0; guard < 240; guard += 1) { if (!(await call("snapshot", {})).jobs?.some((job) => ["queued", "running", "cancelling"].includes(job.status))) return; await sleep(500); } throw new Error("a job did not end"); };
    const home = async () => { await view.reload(); await view.locator("button.nav, nav button").first().waitFor({ timeout: 20000 }); await sleep(600); };
    const openDraft = async () => { await view.locator(".draft-row .draft-open").first().click(); await view.locator(".draft-page").waitFor({ timeout: 15000 }); };
    const noOverflow = async (label) => { const probe = await view.evaluate(overflowProbe); assert.ok(probe.scrollWidth <= probe.clientWidth + 1, `${label}: horizontal overflow ${JSON.stringify(probe)}`); };

    await view.locator(".draft-row .draft-open").first().waitFor({ timeout: 20000 });
    await openDraft();
    await view.locator(".draft-generation-details > summary").click();
    await view.locator(".draft-generation-details summary", { hasText: t("逐份资料出题记录", "Per-source record") }).first().click();
    await view.locator(".draft-generation-details summary", { hasText: t("本次没有合格题", "no accepted questions") }).first().click();
    await step("coverage-list", async () => {
      const list = view.locator(".coverage-documents").last();
      await list.waitFor({ timeout: 10000 });
      const body = await view.locator(".draft-generation-details").innerText();
      assert.equal(body.split(CLEAN).length - 1, 2, "the book is named once among the covered pages and once among the uncovered");
      assert.doesNotMatch(body, /z-library|TruePDF/);
      assert.match(body, t(/已引用 2 \/ 6 页/, /2 of 6 pages cited/));
      assert.match(body, t(/页码：23、24、25、26/, /Pages: 23, 24, 25, 26/));
      await list.scrollIntoViewIfNeeded();
      await noOverflow("coverage list");
    });
    await step("add-button", async () => {
      const block = view.locator("[data-coverage-topup]");
      await block.waitFor({ timeout: 10000 });
      const text = await block.innerText();
      assert.match(text, t(/这一轮补 4 页，约 4 题/, /This round covers 4 pages, about 4 questions/), "the number of pages is named, as pages");
      assert.equal(await view.locator("[data-coverage-start]").count(), 1, "one top-up, not two competing controls");
      assert.equal(await view.locator("[data-add-from-sources]").count(), 0, "the old second control is gone");
      await block.scrollIntoViewIfNeeded();
      await noOverflow("add button");
    });
    const before = await state();
    await view.locator("[data-coverage-start]").click();
    await view.locator("[data-draft-work]").first().waitFor({ timeout: 15000 });
    await check("the first fill ends in the same draft", async () => {
      await idle();
      const after = await state();
      assert.equal(after.drafts.length, 1, "no second draft");
      assert.equal(after.decks.length, 0, "no new deck");
      assert.equal(after.drafts[0].title, TITLE);
      assert.ok(after.drafts[0].cards.length > before.drafts[0].cards.length, `the deck gained cards: ${after.drafts[0].cards.length}`);
      return after.drafts[0].cards.length;
    });

    // A second fill, started while the home is open: one task card for the deck, the first job folded into it.
    const current = (await state()).drafts[0];
    await call("generate", { resumeDraftId: current.id, draftVersion: current.draftVersion, extraSourceIds: ["page-1", "page-2"], count: 4 });
    await home();
    await step("running-one-card", async () => {
      const cards = view.locator(".home-activity .cjc");
      await cards.first().waitFor({ timeout: 20000 });
      assert.equal(await cards.count(), 1, "one task card for the deck, whatever ran before");
      assert.match(await view.locator(".home-activity .home-drafts").innerText(), t(/补题中/, /Adding questions/), "the list row says the deck is being filled");
      assert.doesNotMatch(await view.locator(".home-activity .home-drafts").innerText(), t(/已复审，待发布/, /Reviewed, ready to publish|Ready to publish/));
      assert.ok(await view.locator(".home-activity .home-drafts [data-draft-work].sh-badge").count(), "the status is a Badge");
      assert.equal(await view.locator(".home-activity .home-drafts button:disabled").count(), 0, "no disabled button posing as a status");
      await view.locator(".home-activity").scrollIntoViewIfNeeded();
      await noOverflow("home while filling");
    });
    await idle();
    await home();
    await step("after-fill-one-card", async () => {
      const cards = view.locator(".home-activity .cjc");
      await cards.first().waitFor({ timeout: 20000 });
      assert.equal(await cards.count(), 1, "still one card after the fill ended");
      assert.equal((await call("snapshot", {})).jobs.length, 2, "both fills are listed in the 任务 console; the home shows one card for the deck");
      await noOverflow("home after the fill");
    });
    await check("no console or page errors", async () => undefined);
  } });
finishCli("generation-fill", options, summary);
