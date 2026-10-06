/* npm run qa:failed-continue [-- --scenario plain|coverage --lang zh|en --theme dark|light --width 1280|420 --accent cinnabar|jade --out <dir>]
   After a failure the learner is offered to CONTINUE (the owner's report of 2026-10-06: 「失败后也没有提供重试或者接续」), in the browser preview, on a seeded temporary library with the fake model:
     plain     a plain run asked for 15 questions is stopped by its time limit with some kept (the 20-minute limit struck after 5 seconds: only that timer is shortened). The home banner says why (the one
               sentence of describeFailure) and what 接着做 does (「已出 N/15 题保留，接着补 M 题」) and offers ONE primary action; it is never told about the sections it did not promise. The 待发布 row, the
               任务 console (题数 N / 15) and the draft page say the same; the draft page keeps 为没覆盖的部分补题 beside it and says the way to full coverage before it starts. 接着做 on the banner
               continues the SAME draft (the kept ones stay, only the missing are made); the failed record stays in the console as 接着做过了 with no buttons. Then 为没覆盖的部分补题 on the draft page runs ROUNDS
               one after another until every section has a question, and the strip says the way (覆盖现在 … → 目标 100%).
     coverage  a manual coverage run (精简) is topped up; the round runs out of time (3 s round limit): the banner offers 接着做 (rounds), which goes on from the next round.
   Every claim is read off the page and compared with the same fact from the snapshot. Fake model, Chromium, every key/token/base-url variable removed; one screenshot per step. */
import assert from "node:assert/strict";
import { basename, dirname, join } from "node:path";
import { Store } from "../../lib/store.js";
import { previewCall } from "../preview-server.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";
import { mergedTranscript, RECORDING_NAMES } from "../../tests/helpers/merged-transcript.mjs";
import { sectionedModel } from "../../tests/helpers/coverage-fixture.mjs";
import { reportUsage } from "../../lib/usage-scope.js";
import { dshSystemTokens, dshUserTokens } from "../../lib/token-estimate.js";

const world = mergedTranscript();
const iso = (ms) => new Date(ms).toISOString();
const ASKED = 15;
let KEPT = 0;   // what the first batches kept before the limit struck (read off the draft, never assumed)
const EFFORTS = { effortPlanning: "follow", effortReview: "follow", effortWriting: "low", effortRepair: "low" };
const TOTAL_MS = 20 * 60 * 1000;

async function seed(root) {
  const store = new Store(root), batchId = "qa-continue", ids = world.sources.map((_, index) => (index ? `audio-batch-${batchId}-p${index + 1}` : `audio-batch-${batchId}`));
  const batch = { id: batchId, title: `${RECORDING_NAMES[0]} + 4`, members: RECORDING_NAMES.map((filename, index) => ({ order: index + 1, filename, hash: String(index).padStart(64, "0") })), volumes: world.sources.length };
  await store.update((state) => {
    world.sources.forEach((source, index) => state.sources.push({ id: ids[index], createdAt: iso(Date.now() - 60000), text: source.text, courses: ["软件架构"], title: `${batch.title} · 全量中英对照逐字稿 (${index + 1}/${world.sources.length})`,
      audio: { course: "", batch: { ...batch, volume: index + 1 }, sourceIds: ids, importedAt: iso(Date.now() - 60000) } }));
  });
  return ids;
}

/** The fake model: the section-aware one; `state.hang` makes the last batch of a plain run (or any planning call of a round) wait until it is aborted, `state.slow` slows every call so a run can be seen. */
function modelFor(state) {
  const sectioned = sectionedModel().complete;
  return async (system, prompt, context = {}) => {
    const hangs = state.hang === "last-batch" ? /^Prepare supported/.test(system) && /^Part 3\//.test(context.stage || "") : state.hang === "planning" ? /^Plan a source-grounded/.test(system) : false;
    if (hangs && context.signal) await new Promise((_, reject) => { context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true }); });
    if (state.slow) await sleep(state.slow);
    const reply = await sectioned(system, prompt, context);
    reportUsage({ uncachedInputTokens: dshSystemTokens(system) + dshUserTokens(prompt), cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: Math.max(1, dshUserTokens(reply) - 8) }, { calls: 1 });
    return reply;
  };
}

const waitFor = async (what, check, { timeoutMs = 240000, every = 250 } = {}) => { const end = Date.now() + timeoutMs; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(every); } };
const flat = (value) => String(value).replace(/\s+/g, " ").trim();

export function parseArgs(argv) {
  const base = parseQaArgs(argv, "failed-continue", { accent: "cinnabar", scenario: "plain" });
  const out = argv.includes("--out") ? base.out : join(dirname(base.out), `${base.scenario}-${basename(base.out)}`);
  return { ...base, out, width: Number(base.width) === 1440 && !argv.includes("--width") ? 1280 : base.width };
}

export async function runContinueQa(options) {
  const scenario = options.scenario, state = { hang: "", slow: 0, limit: true }, narrow = options.width < 700;
  // The 20-minute total limit of a plain run strikes after 5 seconds (only that timer; the preview server runs in this process).
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms === TOTAL_MS && state.limit ? 5000 : ms, ...rest);
  try {
    return await runQa({ name: "failed-continue", options, model: modelFor(state), latencyMs: 0, localStorageSeed: { "study-interface": JSON.stringify({ accent: options.accent }) },
      coverage: scenario === "coverage" ? { roundTimeoutMs: 4000 } : null,
      seed: async (root) => { options.ids = await seed(root); },
      async run({ page, server, step, check, summary, t }) {
        const call = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: options.lang });
        const facts = {};
        summary.facts = facts;
        const goto = async (nav) => { const entry = page.locator(`[data-tour="nav-${nav}"]`).first(); await entry.waitFor({ state: "attached" }); await entry.dispatchEvent("click"); await sleep(900); };
        const idle = () => waitFor("the run to end", async () => !(await call("snapshot", {})).jobs.some((job) => ["queued", "running", "cancelling"].includes(job.status)));
        const noOverflow = async (label) => { const probe = await page.evaluate(overflowProbe); assert.ok(probe.scrollWidth <= probe.clientWidth + 1, `horizontal overflow on ${label}: ${JSON.stringify(probe)}`); };
        const labels = async (scope) => (await scope.locator("button").evaluateAll((els) => els.filter((el) => el.offsetParent !== null).map((el) => el.innerText.trim()).filter(Boolean))).map((label) => flat(label).replace(/\s*→$/, ""));
        const snapshot = async () => call("snapshot", {});
        const consoleOf = async (pick) => {
          await goto("tasks");
          await page.locator(".tc-row").first().waitFor({ timeout: 30000 });
          const rows = page.locator(".tc-row");
          await (pick ? rows.nth(pick) : rows.first()).dispatchEvent("click");
          await waitFor("the console to show the run as ended", async () => (await page.locator(".tc-detail[data-status='running']").count()) === 0, { timeoutMs: 60000 });
          await sleep(1200);
          return { text: flat(await page.locator(".tc-detail").first().innerText()), buttons: await labels(page.locator(".tc-head__actions")), rows: await rows.evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim())) };
        };
        const homeOf = async ({ button } = {}) => {
          await goto("library");
          await page.locator(".draft-row").first().waitFor({ timeout: 30000 });
          await waitFor("the home to show the run as ended", async () => (await page.locator(".cjc[data-state='run']").count()) === 0, { timeoutMs: 60000 });
          if (button) await waitFor(`the banner to offer ${button}`, async () => (await page.locator(".cjc").first().locator("button", { hasText: new RegExp(`^${button}`) }).count()) > 0, { timeoutMs: 60000 });
          await sleep(1200);
          const banner = page.locator(".cjc").first(), row = page.locator(".draft-row").first();
          return { banner: (await banner.count()) ? flat(await banner.innerText()) : "", bannerButtons: (await banner.count()) ? await labels(banner) : [], row: flat(await row.innerText()), rowButtons: await labels(row), rowBadge: flat(await row.locator("[data-draft-status]").innerText().catch(() => "")) };
        };
        const draftPageOf = async () => {
          await page.locator(".draft-open").first().click();
          await page.locator("[data-coverage-summary]").waitFor({ timeout: 30000 });
          await sleep(900);
          return { text: flat(await page.locator("main").first().innerText()), buttons: await labels(page.locator("[data-coverage-summary]")), path: flat(await page.locator("[data-coverage-path]").first().innerText().catch(() => "")) };
        };
        const draftOf = async () => (await snapshot()).drafts[0];
        const ids = options.ids;
        const continueWord = t("接着做", "Continue"), topUpWord = t("为没覆盖的部分补题", "Add questions for the uncovered parts");

        if (scenario === "plain") {
          state.hang = "last-batch";
          await call("generate", { sourceIds: ids, kind: "quiz", count: 15, performance: { concurrency: 1, batchSize: 5, jobTimeoutMinutes: 20, fillRounds: 0, ...EFFORTS } });
          await waitFor("the run to stop at its time limit", async () => { const jobs = (await snapshot()).jobs; return jobs.length && jobs.every((job) => !["queued", "running", "cancelling"].includes(job.status)); }, { timeoutMs: 60000 });
          state.hang = "";
          state.limit = false;
          const snap = await draftOf(), failed = (await snapshot()).jobs[0];
          facts.afterFailure = { status: failed.status, stage: failed.stage, kept: snap.cards.length, requested: snap.editorial.requested, jobTotal: failed.contract.progress.total, retry: failed.contract.actions.retry };
          assert.equal(failed.status, "failed");
          KEPT = snap.cards.length;
          assert.ok(KEPT > 0 && KEPT < ASKED, `the batches before the limit are kept (${KEPT} of ${ASKED})`);
          assert.equal(snap.editorial.requested, ASKED);
          let home, consoleView, page2;
          await step("home-after-time-limit", async () => { home = await homeOf({ button: continueWord }); facts.home = home; await noOverflow("the home"); });
          await step("console-failed", async () => { consoleView = await consoleOf(); facts.console = consoleView; });
          await step("draft-page", async () => { await goto("library"); page2 = await draftPageOf(); facts.draft = page2; await noOverflow("the draft page"); });
          await step("draft-page-actions", async () => { await page.locator("[data-continue-line]").first().scrollIntoViewIfNeeded(); await sleep(400); });
          await check("one story after the time limit: why, what 接着做 does, ONE primary action, no sections it never promised, the same N / 15 everywhere", async () => {
            const why = t("生成用时太长，已自动停止", "Generation took too long and stopped"), doing = t(`已出 ${KEPT}/${ASKED} 题保留，接着补 ${ASKED - KEPT} 题`, `${KEPT}/${ASKED} questions made and kept; Continue makes the ${ASKED - KEPT} still missing`);
            assert.ok(home.banner.includes(why), `the banner says why: ${home.banner}`);
            assert.ok(home.banner.includes(doing), `the banner says what ${continueWord} does: ${home.banner}`);
            assert.ok(!/个小节没有题|still without a question/.test(`${home.banner} ${home.row}`), `a plain run promised questions, not sections: ${home.banner} | ${home.row}`);
            assert.deepEqual(home.bannerButtons.filter((label) => [continueWord, topUpWord].includes(label)), [continueWord], `the banner's one primary action: ${home.bannerButtons}`);
            assert.deepEqual(home.rowButtons.filter((label) => [continueWord, topUpWord].includes(label)), [continueWord], `the row's one primary action: ${home.rowButtons}`);
            assert.ok(home.row.includes(t(`已出 ${KEPT}/${ASKED} 题`, `Made ${KEPT}/${ASKED} questions`)), `the row counts ${KEPT}/${ASKED}: ${home.row}`);
            assert.ok(home.rowBadge.includes(t("用时到限", "Time limit")), `the row's badge says why: ${home.rowBadge}`);
            assert.ok(consoleView.text.includes(`${KEPT} / ${ASKED}`), `the console counts ${KEPT} / ${ASKED}: ${consoleView.text.slice(0, 500)}`);
            assert.ok(consoleView.text.includes(doing), `the console's strip says what it does: ${consoleView.text.slice(0, 600)}`);
            assert.ok(consoleView.buttons.includes(continueWord), `the console's header continues: ${consoleView.buttons}`);
            assert.ok(consoleView.buttons.includes(topUpWord), `and keeps the top-up beside it: ${consoleView.buttons}`);
            assert.ok(!new RegExp(`${KEPT} / (?!${ASKED}\b)\d`).test(consoleView.text), "no other goal");
            assert.ok(page2.text.includes(doing), `the draft page says it: ${page2.text.slice(0, 500)}`);
            assert.ok(page2.buttons.includes(continueWord) && page2.buttons.includes(topUpWord), `the draft page offers both: ${page2.buttons}`);
            assert.match(page2.path, new RegExp(t("^覆盖现在 \\d+/\\d+ 个小节（\\d+%）→ 本轮后约 \\d+% → 目标 100%，还要 \\d+ 轮、约 \\d+ 题$", "^Coverage now \\d+/\\d+ sections \\(\\d+%\\) → about \\d+% after this round → target 100%, \\d+ more rounds?, about \\d+ questions$")), page2.path);
            const view = await call("coverage.get", { draftId: snap.id });
            assert.ok(page2.path.includes(`${view.coverage.covered}/`) && page2.path.includes(`${view.round.allQuestions}`), `the path is the backend's: ${page2.path} vs ${JSON.stringify({ covered: view.coverage.covered, all: view.round.allQuestions, rounds: view.round.rounds })}`);
          });
          await step("press-continue-on-the-banner", async () => {
            await goto("library");
            await page.locator(".cjc").first().getByRole("button", { name: new RegExp(`^${continueWord}`) }).click();
            await sleep(1500);
            facts.afterPress = flat(await page.locator(".cjc").first().innerText().catch(() => ""));
            await idle();
          });
          await check("接着做 continued the SAME draft: the kept ones stay, only the missing were made, still one draft", async () => {
            const state2 = await snapshot(), after = state2.drafts[0];
            assert.equal(state2.drafts.length, 1);
            assert.equal(after.id, snap.id);
            assert.deepEqual(after.cards.slice(0, KEPT).map((card) => card.id), snap.cards.map((card) => card.id));
            assert.ok(after.cards.length > KEPT && after.cards.length <= ASKED, `${after.cards.length} questions`);
            facts.afterContinue = { kept: after.cards.length, jobs: state2.jobs.map((job) => [job.status, job.continuedBy || null]) };
          });
          let after;
          await step("console-after-continue", async () => {
            after = await consoleOf();
            facts.consoleAfter = after;
            const old = after.rows.find((row) => row.includes(t("接着做过了", "Continued")));
            assert.ok(old, `the failed record stays in the list as 接着做过了: ${after.rows}`);
            await page.locator(".tc-row", { hasText: t("接着做过了", "Continued") }).first().dispatchEvent("click");
            await sleep(900);
            const record = flat(await page.locator(".tc-detail").first().innerText()), buttons = await labels(page.locator(".tc-head__actions"));
            assert.ok(!buttons.includes(continueWord), `no continue button on a continued record: ${buttons}`);
            assert.ok(record.includes(`${KEPT} / ${ASKED}`), `its numbers stay as they were: ${record.slice(0, 400)}`);
            facts.continuedRecord = { buttons, text: record.slice(0, 500) };
          });
          await step("home-after-continue", async () => { facts.homeAfter = await homeOf(); await noOverflow("the home after continuing"); });

          // 为没覆盖的部分补题: rounds of at most 30 questions, one after another, until every section has a question.
          state.slow = 250;
          await step("draft-page-before-top-up", async () => { await goto("library"); await page.locator(".draft-open").first().click(); await page.locator("[data-coverage-summary]").waitFor({ timeout: 30000 }); await sleep(900); facts.topUpPage = flat(await page.locator("[data-coverage-summary]").innerText()); await page.locator("[data-coverage-start]").first().scrollIntoViewIfNeeded(); await sleep(400); });
          const before = await call("coverage.get", { draftId: (await draftOf()).id });
          await step("press-top-up", async () => {
            const topUp = page.locator("[data-coverage-summary]").getByRole("button", { name: new RegExp(`^${topUpWord}`) }).first();
            assert.equal(await topUp.count(), 1, "the draft page offers the top-up");
            await topUp.click();
            await sleep(2500);
          });
          await step("console-top-up-running", async () => {
            await goto("tasks");
            await page.locator(".tc-row").first().waitFor({ timeout: 30000 });
            await page.locator(".tc-row", { hasText: /%/ }).first().dispatchEvent("click").catch(() => {});
            await page.locator(".tc-run").first().waitFor({ timeout: 30000 });
            await sleep(1200);
            facts.topUpStrip = flat(await page.locator(".tc-run").first().innerText());
            const header = flat(await page.locator(".tc-detail").first().innerText());
            facts.topUpHeader = header.slice(0, 500);
          });
          state.slow = 0;
          await idle();
          await check("the top-up ran ROUNDS on its own until every section has a question (all but the one the fake model cannot quote)", async () => {
            const done = await draftOf(), view = await call("coverage.get", { draftId: done.id }), spec = done.editorial.coverageSpec;
            assert.equal(spec.topup, true, "the draft keeps the plan of the top-up");
            assert.ok(spec.rounds.length >= 2, `${spec.rounds.length} rounds`);
            assert.ok(spec.rounds.every((round) => round.questions <= 30), "no round over the 30-question limit");
            // (The fixture's 81st section is the continuation of a recording that starts mid-sentence: the fake model cannot quote it, so the run ends with that ONE section left, honestly, after its fill round.)
            assert.ok(spec.rounds.slice(0, -1).every((round) => round.status === "done"), JSON.stringify(spec.rounds.map((round) => round.status)));
            assert.ok(view.coverage.covered >= view.coverage.leaves - 1, `the coverage is full but for the section the fake cannot quote: ${view.coverage.covered}/${view.coverage.leaves}`);
            assert.equal(done.editorial.requested, ASKED, "what the draft was asked for does not move");
            facts.topUp = { rounds: spec.rounds.length, before: { covered: before.coverage.covered, leaves: before.coverage.leaves, rounds: before.round.rounds, all: before.round.allQuestions }, after: { kept: done.cards.length, covered: view.coverage.covered } };
          });
          await step("console-top-up-done", async () => { const done = await consoleOf(); facts.topUpDone = done.text.slice(0, 700); });
          await step("home-top-up-done", async () => { facts.homeEnd = await homeOf(); await noOverflow("the home at the end"); });
        }

        if (scenario === "coverage") {
          // a manual (精简) run, then a top-up whose round runs out of time
          await call("generate", { sourceIds: ids, coverageLevel: "lean", kind: "quiz" });
          await idle();
          const first = await draftOf();
          assert.equal(first.editorial.coverageRun.autoComplete, false);
          state.hang = "planning";
          const view = await call("coverage.get", { draftId: first.id });
          await call("generate", { resumeDraftId: first.id, draftVersion: first.draftVersion, coverage: { sectionIds: view.round.picks.map((pick) => pick.key), autoComplete: false } });
          await waitFor("the round to run out of time", async () => (await snapshot()).jobs.some((job) => job.status === "failed"), { timeoutMs: 60000 });
          state.hang = "";
          let home, consoleView;
          await step("home-after-round-limit", async () => { home = await homeOf({ button: continueWord }); facts.home = home; await noOverflow("the home"); });
          await step("console-round-failed", async () => { consoleView = await consoleOf(); facts.console = consoleView; });
          await check("a coverage run whose round ran out of time offers 接着做 as its one primary action (rounds, not sections)", async () => {
            assert.ok(home.bannerButtons.includes(continueWord), `the banner continues: ${home.bannerButtons}`);
            assert.ok(!home.bannerButtons.includes(topUpWord), `and the top-up does not compete: ${home.bannerButtons}`);
            assert.ok(home.banner.includes(t("接着做从第", "Continue picks up at round")), home.banner);
            assert.ok(consoleView.buttons.includes(continueWord), `the console's header continues: ${consoleView.buttons}`);
          });
          await step("press-continue", async () => {
            await goto("library");
            await page.locator(".cjc").first().getByRole("button", { name: new RegExp(`^${continueWord}`) }).click();
            await sleep(1500);
            await idle();
            await goto("library");
            await sleep(1000);
          });
          await check("the run went on from its next round and the draft kept what it had", async () => {
            const after = await draftOf();
            assert.ok(after.cards.length >= first.cards.length, `${first.cards.length} -> ${after.cards.length}`);
            facts.afterContinue = { before: first.cards.length, after: after.cards.length, state: after.editorial.coverageRun?.state };
          });
        }
        await check("no horizontal overflow on the home", async () => { await goto("library"); await sleep(500); await noOverflow("the home"); });
        facts.narrow = narrow;
      } });
  } finally { globalThis.setTimeout = realSetTimeout; }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("failed-continue.mjs")) {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runContinueQa(options);
  finishCli("failed-continue", options, summary);
}
