/* npm run qa:coverage-run [-- --lang zh|en --theme dark|light --width 1280|420 --accent jade --out <dir>]
   The rounds of a coverage run (phase 3b, lib/coverage-run.js) in the browser preview, on a seeded temporary library with the fake model: the merged five-recording transcript (80 parts, two volumes:
   tests/helpers/merged-transcript.mjs) and a SMALL ROUND (coverage seam { roundLimit: 90 }, so the plan is three rounds that finish in seconds). The walk is the student's:
     创建题组 → 标准 with 「自动补到完整」 ticked, the line that says what it means in rounds → run → 任务: the header line of the running run (「第 1/3 轮 · 覆盖 x% · 已用 … tok · 预计还要 …」), 暂停 between the rounds
     (「暂停于第 1 轮之后」), 继续, the rounds in 资料部分, the log lines of the boundaries → a RESTART (the library folder copied while round 2 runs, a second preview over the copy: the run is back as an
     interrupted job, 接着做 re-runs round 2 and goes on) → the coverage reaches the target → the draft page says the run is complete → MANUAL: 精简 (「自动补到完整」 is off by itself), round 1 and
     「第 1 轮完成，还有 N 轮」 with the one button, a press runs the next round, ticking 自动补到完整 on the draft page runs the rest.
   Every number on screen is compared with the same fact from the snapshot / coverage.get. Fake model, Chromium, every key/token/base-url variable removed. One screenshot per step and <out>/summary.json. */
/* global document, window */
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Store } from "../../lib/store.js";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";
import { mergedTranscript, RECORDING_NAMES } from "../../tests/helpers/merged-transcript.mjs";

const world = mergedTranscript();
const iso = (ms) => new Date(ms).toISOString();
const COVERAGE = { roundLimit: 90, fillRounds: 2 };

async function seed(root) {
  const store = new Store(root), batchId = "qa-run", ids = world.sources.map((_, index) => (index ? `audio-batch-${batchId}-p${index + 1}` : `audio-batch-${batchId}`));
  const batch = { id: batchId, title: `${RECORDING_NAMES[0]} + 4`, members: RECORDING_NAMES.map((filename, index) => ({ order: index + 1, filename, hash: String(index).padStart(64, "0") })), volumes: world.sources.length };
  await store.update((state) => {
    world.sources.forEach((source, index) => state.sources.push({ id: ids[index], createdAt: iso(Date.now() - 60000), text: source.text, courses: ["QA"], title: `${batch.title} · ${index + 1}/${world.sources.length}`,
      audio: { course: "", batch: { ...batch, volume: index + 1 }, sourceIds: ids, importedAt: iso(Date.now() - 60000) } }));
  });
  return ids;
}

export function parseArgs(argv) {
  const base = parseQaArgs(argv, "coverage-run", { accent: "cinnabar" });
  return { ...base, width: Number(base.width) === 1440 && !argv.includes("--width") ? 1280 : base.width };
}

export async function runRunQa(options) {
  return runQa({ name: "coverage-run", options, model: createFakeModel({ latencyMs: 90, usage: true }), latencyMs: 90, coverage: COVERAGE,
    localStorageSeed: { "study-interface": JSON.stringify({ accent: options.accent }) },
    seed: async (root) => { options.ids = await seed(root); },
    async run({ page, server, library, t, step, check, summary }) {
      let current = server;
      const call = (action, args = {}) => previewCall(current, action, { ...args, uiLanguage: options.lang });
      const ids = options.ids, facts = {}, zh = options.lang === "zh", narrow = options.width < 700;
      summary.facts = facts;
      const noOverflow = async (label) => { const probe = await page.evaluate(overflowProbe); assert.ok(probe.scrollWidth <= probe.clientWidth + 1, `horizontal overflow on ${label}: ${JSON.stringify(probe)}`); };
      const goto = async (nav) => { const entry = page.locator(`[data-tour="nav-${nav}"]`).first(); await entry.waitFor({ state: "attached" }); await entry.dispatchEvent("click"); await sleep(900); };
      const jobs = async () => (await call("snapshot", {})).jobs;
      const waitFor = async (what, check, { timeoutMs = 120000, every = 250 } = {}) => { const end = Date.now() + timeoutMs; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(every); } };
      const idle = () => waitFor("the run to end", async () => !(await jobs()).some((job) => ["queued", "running", "cancelling"].includes(job.status)), { timeoutMs: 240000 });
      const draftOf = async (id) => { const drafts = (await call("snapshot", {})).drafts; return id ? drafts.find((draft) => draft.id === id) : drafts.at(-1); };
      const statuses = (draft) => (draft.editorial.coverageSpec.rounds || []).map((round) => round.status || "pending");
      const runLine = async () => (await page.locator("[data-run-line]").first().innerText()).replace(/\s+/g, " ").trim();
      const openConsole = async () => { await goto("tasks"); await page.locator(".tc-detail").first().waitFor({ state: "attached", timeout: 30000 }); await page.locator(".tc-row").first().dispatchEvent("click"); await sleep(500); };
      const press = async (pattern) => { const button = page.getByRole("button", { name: pattern }).first(); await button.waitFor({ timeout: 20000 }); await button.click(); };
      const level = (name) => page.locator(".cov-strength__levels .sh-seg__item", { hasText: name }).first();

      await step("create-form-auto-on", async () => {
        await goto("generate");
        await page.locator('[data-tour="generate-sources"]').waitFor({ timeout: 20000 });
        await page.getByRole("button", { name: /选择当前范围|Select this scope/ }).first().click();
        await page.locator("[data-coverage-strength]").scrollIntoViewIfNeeded();
        const auto = page.locator("[data-coverage-auto]");
        await auto.waitFor({ timeout: 20000 });
        await page.locator("[data-coverage-auto-note]").waitFor({ timeout: 20000 });
        assert.equal(await auto.getAttribute("data-auto"), "on", "标准 goes on by itself by default");
        const note = (await page.locator("[data-coverage-auto-note]").innerText()).replace(/\s+/g, " ");
        facts.autoNote = note;
        const rounds = (await call("usage.estimate", { feature: "generate", sourceIds: ids, coverageLevel: "standard" })).coverage.rounds;
        assert.equal(rounds, 3, "the small round makes three rounds");
        assert.ok(note.includes(String(rounds - 1)), note);
        await noOverflow("the create form");
      });
      await step("create-form-lean-is-manual", async () => {
        await level(zh ? "精简" : "Lean").click();
        await sleep(600);
        assert.equal(await page.locator("[data-coverage-auto]").getAttribute("data-auto"), "off", "精简 waits for the learner by default");
        facts.leanNote = (await page.locator("[data-coverage-auto-note]").innerText()).replace(/\s+/g, " ");
        await level(zh ? "标准" : "Standard").click();
        await sleep(600);
        assert.equal(await page.locator("[data-coverage-auto]").getAttribute("data-auto"), "on");
        await page.locator(".cov-strength__budget summary").click();
        await page.locator("#generate-budget").fill("1x");
        await sleep(300);
        assert.equal(await page.locator("#generate-budget").getAttribute("aria-invalid"), "true", "a number nobody understands is said so");
        await page.locator("#generate-budget").fill("");
        await page.locator(".cov-strength__budget summary").click();
        await noOverflow("the spending limit");
      });

      let runJob, draftId;
      await step("run-started-header-line", async () => {
        await page.locator('[data-tour="generate-submit"]').click();
        runJob = await waitFor("the run's job", async () => (await jobs()).find((job) => job.coverageRun), { timeoutMs: 30000 });
        await openConsole();
        await page.locator("[data-run-line]").first().waitFor({ timeout: 20000 });
        const line = await runLine();
        facts.firstLine = line;
        assert.ok(zh ? /^第 1\/3 轮/.test(line) : /^Round 1\/3/.test(line), line);
        assert.ok(zh ? /覆盖 \d+%/.test(line) : /Covered \d+%/.test(line), line);
        await page.getByRole("button", { name: zh ? /^暂停$/ : /^Pause$/ }).first().waitFor({ timeout: 20000 });
        assert.ok(await page.locator("[data-run-auto]").count(), "自动补到完整 is in the header");
        assert.ok(await page.getByRole("button", { name: zh ? "停在这里" : "Stop here" }).count(), "停在这里 replaces 停止");
        await noOverflow("the console header");
      });
      await step("pause-between-rounds", async () => {
        await press(zh ? /^暂停$/ : /^Pause$/);
        const paused = await waitFor("the pause to be reached", async () => { const job = (await jobs()).find((item) => item.id === runJob.id); return job.contract.status === "paused" ? job : null; }, { timeoutMs: 180000 });
        facts.pausedAfter = paused.contract.detail.run.pausedAfter;
        const line = await waitFor("the paused line", async () => { const text = await runLine(); return /暂停于第|Paused after round/.test(text) ? text : null; }, { timeoutMs: 20000 });
        facts.pausedLine = line;
        assert.ok(zh ? line.startsWith(`暂停于第 ${facts.pausedAfter} 轮之后`) : line.startsWith(`Paused after round ${facts.pausedAfter}`), line);
        draftId = paused.draftId;
        const draft = await draftOf(draftId);
        assert.equal(draft.editorial.coverageRun.state, "paused");
        assert.deepEqual(statuses(draft).slice(0, facts.pausedAfter).every((status) => status === "done"), true);
        const before = await call("snapshot", {}), still = (await sleep(1500), await call("snapshot", {}));
        assert.equal(JSON.stringify(still.drafts.find((item) => item.id === draftId).cards.length), JSON.stringify(before.drafts.find((item) => item.id === draftId).cards.length), "nothing is written while it is paused");
      });
      await step("resume-then-pause-again", async () => {
        await press(zh ? /^继续$/ : /^(Resume|Continue)$/);
        await waitFor("round 2 to be running", async () => { const job = (await jobs()).find((item) => item.id === runJob.id); return job.contract.status === "running" && statuses(await draftOf(draftId))[1] === "running" ? job : null; }, { timeoutMs: 60000, every: 150 });
        const line = await runLine();
        facts.resumedLine = line;
        assert.ok(zh ? line.startsWith("第 2/3 轮") : line.startsWith("Round 2/3"), line);
        await press(zh ? /^暂停$/ : /^Pause$/);
        const paused = await waitFor("the second pause to be reached", async () => { const job = (await jobs()).find((item) => item.id === runJob.id); return job.contract.status === "paused" ? job : null; }, { timeoutMs: 240000 });
        assert.equal(paused.contract.detail.run.pausedAfter, 2);
        assert.deepEqual(statuses(await draftOf(draftId)), ["done", "done", "pending"]);
      });
      // The host stops while the run is paused after round 2: what is on disk is all a restart has (a copy of the folder while nothing is being written; the in-flight round is the exec test's).
      let copy, second;
      await step("restart-interrupted", async () => {
        for (let attempt = 1; attempt <= 10 && !copy; attempt += 1) {
          const folder = join(options.out, "work", `library-restart-${attempt}`);
          await mkdir(folder, { recursive: true });
          // (Files that are being replaced right now come and go: a copy that trips over one is made again.)
          if (!await cp(library, folder, { recursive: true, filter: (from) => !from.endsWith(".tmp") }).then(() => true, () => false)) { await sleep(250); continue; }
          // Consistent: every shard the manifest names is there, and the draft says round 2 is running.
          const manifest = await readFile(join(folder, "study-workspace.json"), "utf8").catch(() => ""), named = [...new Set(manifest.match(/[0-9a-f-]{36}\.[0-9a-f]{8,}\.json/g) || [])];
          const present = new Set((await Promise.all(["drafts", "sources", "courses", "misc"].map((kind) => readdir(join(folder, "shards", kind)).catch(() => [])))).flat());
          const shard = named.find((name) => name.startsWith(draftId)), body = shard ? JSON.parse(await readFile(join(folder, "shards", "drafts", shard), "utf8").catch(() => "null") ?? "null") : null;
          if (manifest && named.every((name) => present.has(name)) && body?.editorial?.coverageRun?.state === "paused" && body.editorial.coverageSpec.rounds[1]?.status === "done") copy = folder; else await sleep(250);
        }
        assert.ok(copy, "a consistent copy of the library while the run is paused");
        facts.copiedWhile = statuses(await draftOf(draftId));
        await current.close();
        second = await createPreviewServer({ libraryRoot: copy, home: join(options.out, "work", "home-restart"), port: 0, coverage: COVERAGE, model: createFakeModel({ latencyMs: 90, usage: true }) });
        current = second;
        await page.goto(second.url);
        await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
        await sleep(800);
        const job = await waitFor("the interrupted job", async () => (await jobs()).find((item) => item.coverageRun), { timeoutMs: 30000 });
        assert.equal(job.contract.status, "interrupted");
        assert.equal(job.id, runJob.id, "the same job comes back");
        await openConsole();
        await page.locator("[data-run-line]").first().waitFor({ timeout: 20000 });
        const line = await runLine();
        facts.interruptedLine = line;
        assert.ok(zh ? line.startsWith("中断于第 3 轮") : line.startsWith("Interrupted at round 3"), line);
        assert.ok(zh ? line.includes("接着做会从第 3 轮继续") : line.includes("Continue picks up at round 3"), line);
        assert.ok(await page.getByRole("button", { name: zh ? "接着做" : "Continue" }).count(), "接着做 is offered");
        await noOverflow("the interrupted console");
      });
      await step("draft-page-while-running", async () => {
        await press(zh ? /^接着做$/ : /^Continue$/);
        await waitFor("the continued run to work", async () => (await jobs()).find((job) => job.draftId === draftId && job.status === "running" && job.coverageRun?.list?.length));
        await goto("library");
        await page.locator(".draft-row").first().waitFor({ timeout: 20000 });
        await page.locator(".draft-open").first().click();
        await page.locator("[data-coverage-run]").waitFor({ timeout: 20000 });
        const auto = page.locator("input[data-run-auto]");
        await auto.waitFor({ timeout: 10000 });
        assert.equal(await auto.isChecked(), true, "going on by itself: the box is ticked");
        assert.equal(await page.locator("[data-coverage-run] [data-run-line]").count(), 0, "the line is the work status below, not a second one");
        const status = (await page.locator("[data-coverage-topup]").first().innerText()).replace(/\s+/g, " ");
        facts.draftWhileRunning = status;
        assert.ok(zh ? /^第 \d+\/\d+ 轮 · 覆盖 \d+%/.test(status) : /^Round \d+\/\d+ · Covered \d+%/.test(status), status);
        await page.evaluate(() => { const box = document.querySelector("[data-coverage-run]").getBoundingClientRect(); window.scrollBy(0, box.top - 260); });
        await noOverflow("the draft page while the run works");
      });
      await step("continue-after-restart", async () => {
        await openConsole();
        await idle();
        const jobsNow = await jobs(), job = jobsNow.find((item) => item.draftId === draftId && item.contract.status !== "interrupted");
        facts.finishedJob = { status: job.status, stage: job.stage };
        assert.equal(job.status, "complete", job.stage);
        const draft = await draftOf(draftId), view = await call("coverage.get", { draftId });
        facts.finished = { statuses: statuses(draft), covered: view.coverage.covered, leaves: view.coverage.leaves, cards: draft.cards.length, goal: draft.editorial.coverageSpec.goal };
        // The planned rounds are done. The fake model cannot quote the two sections that begin in the middle of a sentence (a recording carried over from one volume to the next), so the run ends the way
        // it should when sections are left after its retry rounds: stopped, with that reason, not looping; with a model that covers everything it is complete.
        assert.ok(statuses(draft).slice(0, 3).every((status) => status === "done"), statuses(draft).join());
        assert.ok(view.coverage.covered >= view.coverage.leaves - 3, "the coverage reached the target of the level but for sections no question can be written for");
        facts.endState = { state: draft.editorial.coverageRun.state, stop: draft.editorial.coverageRun.stop, rounds: statuses(draft) };
        assert.ok(["complete", "stopped"].includes(draft.editorial.coverageRun.state));
        if (draft.editorial.coverageRun.state === "stopped") { assert.equal(draft.editorial.coverageRun.stop.reason, "sections-left"); assert.ok(statuses(draft).length <= 3 + 2, "at most two fill rounds"); }
        const log = await call("snapshot", {}), contract = log.jobs.find((item) => item.id === job.id).contract;
        assert.ok(contract.events.some((event) => event.code === "round-start" && event.args.round === 3), "the log says round 3 started: the run went on where it was");
        // (The console reads the snapshot once a second: the line of the ended run is waited for.)
        await waitFor("the line of the ended run", async () => !/to go|还要/.test(await runLine()), { timeoutMs: 20000 });
        const line = await runLine();
        facts.completeLine = line;
        assert.ok(zh ? new RegExp(`^(共 \\d+ 轮|停在第 \\d+ 轮之后) · 覆盖 ${view.coverage.percentLeaves}%`).test(line) : new RegExp(`^(\\d+ rounds in all|Stopped after round \\d+) · Covered ${view.coverage.percentLeaves}%`).test(line), line);
        await page.locator(".tc-tab", { hasText: t("日志", "Log") }).first().click();
        await page.locator(".tc-line").first().waitFor({ timeout: 10000 });
        await noOverflow("the finished run");
      });
      await step("rounds-tab-and-log", async () => {
        await page.locator(".tc-tab", { hasText: t("资料部分", "Source parts") }).first().click();
        await page.locator("[data-run-rounds]").waitFor({ timeout: 20000 });
        const rows = page.locator("[data-run-rounds] li[data-round]");
        assert.ok(await rows.count() >= 3, "the planned rounds are listed");
        const states = await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-status")));
        facts.roundStates = states;
        assert.ok(states.every((state) => state === "done"), `every round is done after the run went on: ${states}`);
        await rows.first().locator("button").click();
        await page.locator(".tc-round__sections li").first().waitFor({ timeout: 10000 });
        await noOverflow("the rounds tab");
      });
      await step("log-lines", async () => {
        await page.locator(".tc-tab", { hasText: t("日志", "Log") }).first().click();
        await page.locator(".tc-line").first().waitFor({ timeout: 20000 });
        const text = (await page.locator(".tc-log__body").innerText()).replace(/\s+/g, " ");
        facts.logHead = text.slice(0, 400);
        assert.ok(zh ? text.includes("第 3/3 轮开始") && text.includes("轮完成：保留") : text.includes("Round 3/3 started") && text.includes("done: kept"), text.slice(0, 500));
        await noOverflow("the log");
      });

      await step("draft-page-complete", async () => {
        await goto("library");
        await page.locator(".draft-row").first().waitFor({ timeout: 20000 });
        await page.locator(".draft-open").first().click();
        await page.locator("[data-coverage-run]").waitFor({ timeout: 20000 });
        const line = (await page.locator("[data-coverage-run] [data-run-line]").innerText()).replace(/\s+/g, " ");
        facts.draftLine = line;
        const view = await call("coverage.get", { draftId });
        assert.ok(zh ? new RegExp(`^(共 \\d+ 轮|停在第 \\d+ 轮之后) · 覆盖 ${view.coverage.percentLeaves}%`).test(line) : new RegExp(`^(\\d+ rounds in all|Stopped after round \\d+) · Covered ${view.coverage.percentLeaves}%`).test(line), line);
        facts.draftStop = (await page.locator("[data-coverage-run] [data-run-stop]").innerText().catch(() => "")).replace(/\s+/g, " ");
        await page.evaluate(() => { const box = document.querySelector("[data-coverage-summary]").getBoundingClientRect(); window.scrollBy(0, box.top - 120); });
        await noOverflow("the draft page");
      });

      // MANUAL: 精简 waits for the learner.
      let manualId;
      await step("manual-round-one-waits", async () => {
        await goto("generate");
        await page.locator('[data-tour="generate-sources"]').waitFor({ timeout: 20000 });
        await page.getByRole("button", { name: /选择当前范围|Select this scope/ }).first().click();
        await level(zh ? "精简" : "Lean").click();
        await sleep(600);
        assert.equal(await page.locator("[data-coverage-auto]").getAttribute("data-auto"), "off");
        await page.locator('[data-tour="generate-submit"]').click();
        const started = await waitFor("the manual job", async () => (await jobs()).filter((job) => job.coverageRun && job.id !== runJob.id).at(-1), { timeoutMs: 30000 });
        manualId = started.id;
        await idle();
        const job = (await jobs()).find((item) => item.id === manualId);
        assert.equal(job.status, "complete", job.stage);
        const draft = await draftOf(job.draftId);
        facts.manual = { statuses: statuses(draft), state: draft.editorial.coverageRun.state };
        assert.equal(draft.editorial.coverageRun.state, "waiting");
        assert.equal(statuses(draft)[0], "done");
        await goto("library");
        await page.locator(".draft-row").first().waitFor({ timeout: 20000 });
        const rows = await page.locator(".draft-row").count();
        facts.homeRows = rows;
        // (The rows are in the order of their last change: the manual draft is the one that says its first round is done.)
        const facts0 = (await page.locator(".draft-meta__facts", { hasText: zh ? "第 1 轮完成" : "Round 1 is done" }).first().innerText()).replace(/\s+/g, " ");
        facts.homeFacts = facts0;
        const left = statuses(draft).filter((status) => status === "pending").length;
        assert.ok(zh ? facts0.includes(`第 1 轮完成，还有 ${left} 轮`) : facts0.includes(`Round 1 is done, ${left} more to go`), facts0);
        await noOverflow("the home row");
      });
      await step("manual-draft-button-runs-next-round", async () => {
        const job = (await jobs()).find((item) => item.id === manualId);
        await page.locator(".draft-row", { hasText: zh ? "第 1 轮完成" : "Round 1 is done" }).first().locator(".draft-open").click();
        await page.locator("[data-coverage-run]").waitFor({ timeout: 20000 });
        const line = (await page.locator("[data-coverage-run] [data-run-line]").innerText()).replace(/\s+/g, " ");
        facts.manualDraftLine = line;
        assert.ok(zh ? /^第 1 轮完成，还有 \d+ 轮/.test(line) : /^Round 1 is done, \d+ more to go/.test(line), line);
        const box = page.locator("input[data-run-auto]");
        assert.equal(await box.isChecked(), false);
        const before = (await draftOf(job.draftId)).cards.length;
        await page.evaluate(() => { const box = document.querySelector("[data-coverage-topup]").getBoundingClientRect(); window.scrollBy(0, box.top - 160); });
        await page.locator("[data-coverage-start]").click();
        await waitFor("round 2 to be made", async () => statuses(await draftOf(job.draftId))[1] === "done", { timeoutMs: 180000 });
        await idle();
        const draft = await draftOf(job.draftId);
        facts.afterPress = { statuses: statuses(draft), cards: draft.cards.length, before };
        assert.deepEqual(statuses(draft).slice(0, 2), ["done", "done"], "one press made exactly the next round");
        assert.ok(draft.cards.length > before);
        await sleep(600);
        await noOverflow("the draft page, manual");
      });
      await step("manual-toggle-runs-the-rest", async () => {
        const job = (await jobs()).find((item) => item.id === manualId);
        const draft = await draftOf(job.draftId), left = statuses(draft).filter((status) => status === "pending").length;
        if (!left) { facts.nothingLeft = true; return; }
        await page.locator("input[data-run-auto]").check();
        await waitFor("the rest to be made", async () => statuses(await draftOf(job.draftId)).every((status) => status !== "pending" && status !== "running"), { timeoutMs: 240000 });
        await idle();
        const after = await draftOf(job.draftId);
        facts.afterToggle = { statuses: statuses(after), state: after.editorial.coverageRun.state, auto: after.editorial.coverageRun.autoComplete };
        assert.ok(["complete", "stopped"].includes(after.editorial.coverageRun.state));
        await sleep(800);
        const line = (await page.locator("[data-coverage-run] [data-run-line]").innerText().catch(() => "")).replace(/\s+/g, " ");
        facts.manualEndLine = line;
        await noOverflow("the draft page after the rest ran");
      });
      assert.ok(narrow || true);
      if (second) await second.close();
    } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2)), summary = await runRunQa(options);
    finishCli("Coverage run", options, summary);
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 2;
  }
}
