/* npm run qa:draft-coverage [-- --lang zh|en --theme dark|light --width 1440|420 --level lean --out <dir> --check]
   The draft page and the 任务 console of a draft whose PLAN is met while the material has a section the plan never reached (#662, #663), and the draft page's own layout (#668 #669 #670: the questions
   first, the publish bar at the foot, the danger menu, one row per question), in the browser preview with the fake model on a seeded temporary library: one recording of five headed parts and a
   question run of 精简 that ends on its plan with two sections left. One screenshot per step and <out>/summary.json. `--check` also asserts the layout (the first question on the first screen, the bar
   in view at every scroll position, no 删除 beside the primary action, one row layout, rows within 72px); without it the script only takes the pictures (so it can run on an older build for a "before").
   Fake model, Chromium, every key/token/base-url variable removed. Nothing here touches a real library. */
/* global document, getComputedStyle, innerHeight */
import assert from "node:assert/strict";
import { Store } from "../../lib/store.js";
import { previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";
import { mergedTranscript } from "../../tests/helpers/merged-transcript.mjs";

const world = mergedTranscript({ recordings: 1, parts: 5, paragraphs: 3 });

async function seed(root) {
  const store = new Store(root), iso = new Date(Date.now() - 60000).toISOString();
  await store.update((state) => { world.sources.forEach((source, index) => state.sources.push({ id: source.id, createdAt: iso, text: source.text, courses: ["QA"], title: `${source.title} ${index + 1}` })); });
  return world.sources.map((source) => source.id);
}

export function parseArgs(argv) {
  return parseQaArgs(argv, "draft-coverage", { level: "lean", check: argv.includes("--check") ? "true" : "" });
}

/** The panel the app scrolls inside: the tallest element that scrolls vertically. */
const scrollerProbe = () => {
  let best = null;
  for (const element of document.querySelectorAll("main, main *, .study-app, [class*=scroll]")) {
    const overflow = getComputedStyle(element).overflowY;
    if (/auto|scroll/.test(overflow) && element.scrollHeight > element.clientHeight + 4 && element.clientHeight > innerHeight / 2 && (!best || element.scrollHeight > best.scrollHeight)) best = element;
  }
  if (best) best.setAttribute("data-qa-scroller", "");
  return !!best;
};

export async function runDraftQa(options) {
  return runQa({ name: "draft-coverage", options, model: createFakeModel({ latencyMs: 20, usage: true }), latencyMs: 20,
    localStorageSeed: { "study-interface": JSON.stringify({ accent: "cinnabar" }) },
    seed: async (root) => { options.ids = await seed(root); },
    async run({ page, server, t, step, check, summary }) {
      const call = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: options.lang });
      const facts = {}, narrow = options.width < 700, strict = !!options.check;
      summary.facts = facts;
      const goto = async (nav) => { const entry = page.locator(`[data-tour="nav-${nav}"]`).first(); await entry.waitFor({ state: "attached" }); await entry.dispatchEvent("click"); await sleep(900); };
      const idle = async () => { for (let guard = 0; guard < 600; guard += 1) { if (!(await call("snapshot", {})).jobs.some((job) => ["queued", "running", "cancelling"].includes(job.status))) return; await sleep(250); } throw new Error("the jobs did not finish"); };
      const noOverflow = async (label) => { const probe = await page.evaluate(overflowProbe); assert.ok(probe.scrollWidth <= probe.clientWidth + 1, `horizontal overflow on ${label}: ${JSON.stringify(probe)}`); };
      const settle = async (ms = 600) => {
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getTiming?.().iterations === Infinity), null, { timeout: 4000 }).catch(() => {});
        await sleep(ms);
      };
      const scrollTo = async (where) => {
        await page.evaluate(scrollerProbe);
        // The panel the app scrolls inside; on a narrow screen the page itself may be what scrolls.
        facts.scrolled = await page.evaluate((at) => {
          const element = document.querySelector("[data-qa-scroller]") || document.scrollingElement;
          element.scrollTop = at === "end" ? element.scrollHeight : at;
          return { scrollTop: Math.round(element.scrollTop), of: element.scrollHeight, tag: element.tagName };
        }, where);
        await sleep(500);
      };

      await call("generate", { sourceIds: options.ids, coverageLevel: options.level, kind: "quiz", title: t("覆盖演示", "Coverage demo") });
      await idle();
      let snapshot = await call("snapshot", {});
      // Two of the questions are long (the rows are cut at two lines), one is short: the rows must be alike whatever the question says.
      const long = t("关于「间隔重复与遗忘曲线」，哪一项最准确地概括了这句话：「间隔重复的核心做法是在快要忘记之前安排下一次复习，从而用较少的次数维持长期记忆，这样复习负担不会随着卡片数量增加而失控，而且每次成功回忆之后下一次复习的间隔都会被拉长。」？",
        "About spaced repetition and the forgetting curve, which option best sums up this sentence: 'The core of spaced repetition is to schedule the next review just before you would forget, so that a long-term memory is kept with few reviews and the load does not grow without bound as the cards pile up, and each successful recall stretches the next interval.'?");
      const current = snapshot.drafts.at(-1);
      await call("draft.save", { deck: { ...current, cards: current.cards.map((card, index) => (index === 1 ? { ...card, prompt: t("短题？", "A short one?") } : { ...card, prompt: long })) } });
      snapshot = await call("snapshot", {});
      const draft = snapshot.drafts.at(-1), view = await call("coverage.get", { draftId: draft.id }), coverage = view.coverage;
      facts.draft = { cards: draft.cards.length, run: draft.editorial?.coverageRun?.state, stop: draft.editorial?.coverageRun?.stop?.reason, goal: draft.editorial?.coverageSpec?.goal };
      facts.coverage = { covered: coverage.covered, leaves: coverage.leaves, percent: coverage.percentLeaves };
      assert.ok(coverage.covered < coverage.leaves, "the plan left a section out");
      const figure = `${coverage.covered}/${coverage.leaves}`;

      await step("console", async () => {
        await goto("tasks");
        await page.locator(".tc-detail").first().waitFor({ state: "attached", timeout: 30000 });
        await page.locator(".tc-row").first().dispatchEvent("click");
        await page.locator(".tc-run").first().waitFor({ timeout: 15000 });
        await settle();
        const said = (await page.locator(".tc-detail").first().innerText()).replace(/\s+/g, " ");
        facts.console = said.slice(said.indexOf(t("出题计划", "Plan")), said.indexOf(t("出题计划", "Plan")) + 400);
        if (strict) {
          assert.equal(said.split(figure).length - 1, 1, `the coverage ${figure} is written once in the console: ${facts.console}`);
          assert.doesNotMatch(said, /每个小节都有题|Every section has questions/, "the console does not say every section has a question");
          assert.match(said, t(/不在计划里/, /outside the plan/), "the console names what the plan left out");
        }
        await noOverflow("console");
      });

      await step("draft", async () => {
        await goto("library");
        const fromLine = page.locator('.first-run [data-first-run="look"], .first-run [data-first-run="review"]').first();
        if (await fromLine.count()) await fromLine.click();
        else {
          const fold = page.locator("details.home-drafts").first();
          if (await fold.count() && !await fold.evaluate((element) => element.open)) await fold.locator("summary").first().click();
          await page.locator(".draft-row .draft-open").first().click();
        }
        await page.getByRole("button", { name: t("发布并开始练 →", "Publish and practise →") }).first().waitFor({ timeout: 15000 });
        await settle();
        const said = (await page.locator(".draft-page").first().innerText()).replace(/\s+/g, " ");
        facts.draftPage = said.slice(0, 700);
        const top = await page.evaluate(() => { const card = document.querySelector(".draft-card"); return card ? Math.round(card.getBoundingClientRect().top) : null; });
        facts.firstQuestionTop = top; facts.viewport = options.height;
        if (strict) {
          assert.equal(said.split(figure).length - 1, 1, `the coverage ${figure} is written once on the draft page`);
          assert.doesNotMatch(said, /每个小节都有题|Every section has questions/);
          assert.match(said, t(/不在计划里/, /outside the plan/));
          assert.ok(top !== null && top < options.height - 60, `the first question starts at ${top}px of a ${options.height}px screen`);
        }
        await noOverflow("draft");
      });

      await step("draft-scrolled", async () => {
        await scrollTo(400);
        const bar = await page.evaluate(() => { const bar = document.querySelector("[data-draft-bar]"); if (!bar) return null; const rect = bar.getBoundingClientRect(); return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) }; });
        facts.barMiddle = bar;
        if (strict) assert.ok(bar && bar.bottom <= options.height + 1 && bar.top >= 0, `the publish bar is in view in the middle of the page: ${JSON.stringify(bar)}`);
      });

      await step("draft-end", async () => {
        await scrollTo("end");
        const bar = await page.evaluate(() => { const bar = document.querySelector("[data-draft-bar]"); if (!bar) return null; const rect = bar.getBoundingClientRect(); return { top: Math.round(rect.top), bottom: Math.round(rect.bottom) }; });
        facts.barEnd = bar;
        if (strict) assert.ok(bar && bar.bottom <= options.height + 1 && bar.top >= 0, `the publish bar is in view at the end of the page: ${JSON.stringify(bar)}`);
      });

      await step("draft-rows", async () => {
        await scrollTo(0);
        const rows = await page.evaluate(() => [...document.querySelectorAll(".draft-card")].map((card) => { const rect = card.getBoundingClientRect(); return { height: Math.round(rect.height), summary: card.querySelector("summary")?.children.length }; }));
        facts.rows = rows;
        if (strict) {
          assert.ok(rows.length >= 3, "the draft has several questions");
          assert.ok(rows.every((row) => row.height <= 72 + (narrow ? 44 : 0)), `every closed row is at most 72px${narrow ? " (+44 on a phone: the kind goes under the question, and in English may take two lines)" : ""}: ${JSON.stringify(rows)}`);
          assert.equal(new Set(rows.map((row) => row.summary)).size, 1, "every row has the same structure");
        }
      });

      await step("draft-more", async () => {
        const more = page.locator("[data-draft-more] button").first();
        const present = await more.count();
        facts.more = !!present;
        if (strict) {
          assert.ok(present, "the bar has a 更多 menu");
          assert.equal(await page.locator("[data-draft-bar]").getByRole("button", { name: t("删除草稿", "Delete draft"), exact: true }).count(), 0, "no 删除草稿 button beside the primary action");
        }
        if (present) {
          await more.click();
          const item = page.getByRole("menuitem", { name: t("删除草稿", "Delete draft") });
          await item.waitFor({ timeout: 5000 });
          facts.menuItem = await item.evaluate((element) => ({ danger: element.classList.contains("is-danger"), top: Math.round(element.getBoundingClientRect().top) }));
          if (strict) assert.ok(facts.menuItem.danger, "删除草稿 is in the danger colour");
          await sleep(400);
        }
      });

      // A notice stands above the bar, not behind it (the top-up says that it started).
      await step("draft-notice", async () => {
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: t("为没覆盖的部分补题", "Add questions for the uncovered parts"), exact: true }).click();
        const toast = page.locator(".sh-toast").first();
        await toast.waitFor({ timeout: 8000 });
        await sleep(600);
        const boxes = await page.evaluate(() => { const toast = document.querySelector(".sh-toast"), bar = document.querySelector("[data-draft-bar]"); return toast && bar ? { toastBottom: Math.round(toast.getBoundingClientRect().bottom), barTop: Math.round(bar.getBoundingClientRect().top) } : null; });
        facts.notice = boxes;
        if (strict) assert.ok(boxes && boxes.toastBottom <= boxes.barTop + 1, `the notice is above the bar: ${JSON.stringify(boxes)}`);
      });
    } });
}

if (process.argv[1]?.endsWith("draft-coverage.mjs")) {
  const options = parseArgs(process.argv.slice(2));
  runDraftQa(options).then((summary) => { console.log(JSON.stringify(summary.facts, null, 1)); finishCli("draft-coverage", options, summary); });
}
