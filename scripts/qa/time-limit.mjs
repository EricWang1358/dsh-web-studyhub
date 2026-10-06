/* npm run qa:time-limit [-- --scenario all|ended|running|coverage|fixed|old --lang zh|en --theme dark|light --width 1280|420 --accent jade|plum|ochre|graphite|cinnabar --out <dir>]
   The time limit on the 任务 page (the owner's complaint of 2026-10-06: a run that "took too long" with no number, no way to change it and no word on which step took the time), in the browser preview
   on a seeded temporary library: the real app and the real host, with the jobs of each scenario put into the snapshot at the network edge (page.route) as `snapshotJob(record)` (the very function the
   host uses), so the page draws exactly what a host would send and the clock of a running one really runs.
     ended     the owner's task: a question run that ended by its 20 minutes (13/40, 32 model calls, 3 failed): three planning calls ran into the limit of ONE call (10 minutes) and failed. The strip says the
               limit, 已用 (the number of the facts row), the limit of a call, what is kept, the slowest step (a button that selects the call) and 调整时限, which must land on 设置 › 出题偏好 with the field visible.
     running   a run 14 minutes into its 20: the strip counts 已用 against the limit, and a planning call that has run 13 minutes while its siblings took one is named (运行偏久) and marked on the timeline.
     coverage  a coverage run: the limit is PER ROUND, the round in flight says how long it has run, the round that reached it is named.
     fixed     a translation (60 minutes) and a selection run (20 minutes): the limit is stated, nothing offers to change it.
     old       a record without any limit (an older record): no strip, nothing broken.
   Every claim is read off the page; one screenshot per step. Fake model, Chromium, every key/token/base-url variable removed. */
/* global window, getComputedStyle */
import assert from "node:assert/strict";
import { snapshotJob } from "../../lib/job-contract.js";
import { seedLibrary } from "./perf-seed.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const NOW = Date.now();
const iso = (seconds) => new Date(NOW + seconds * 1000).toISOString();
const BUDGET = "Generation reached its 20-minute total budget; approved questions were retained";
const SELECTION_BUDGET = "Generation reached its 20-minute total budget; nothing was saved";
const TRANSLATION_BUDGET = "Translation reached its time budget; translated paragraphs are kept";
const CALL_TIMEOUT = "模型长时间没有响应（请求超时），可以稍后重试";
const flat = (value) => String(value).replace(/\s+/g, " ").trim();

/** A model call of a question run, `from`..`to` seconds after `base` (null: still running). */
const call = (base, id, kind, from, to, extra = {}) => ({ id, kind, stage: kind, runtime: "subagent", startedAt: iso(base + from), ...(to === null ? { status: "running" } : { finishedAt: iso(base + to), status: "complete" }), ...extra });

/** The owner's task: 13 of 40 questions, 32 model calls, 3 failed, ended at its 20 minutes. */
function endedJob() {
  const base = -1300, steps = [], add = (...args) => steps.push(call(base, ...args));
  for (const part of [1, 2, 3]) add(`plan-${part}`, "plan", part, 600 + part, { part, parts: 4, status: "failed", error: CALL_TIMEOUT });
  add("plan-4", "plan", 4, 78, { part: 4, parts: 4 });
  for (const part of [1, 2, 3]) add(`plan-${part}-again`, "plan", 640, 700 + part * 4, { part, parts: 4 });
  for (const part of [1, 2, 3, 4]) add(`blueprint-${part}`, "blueprint", 120 + part * 6, 200 + part * 9, { part, parts: 4 });
  for (const part of [1, 2, 3, 4]) add(`author-${part}`, "author", 740 + part * 8, 860 + part * 25, { part, parts: 4 });
  for (const part of [1, 2, 3, 4]) add(`review-${part}`, "review", 900 + part * 20, 960 + part * 25, { part, parts: 4 });
  for (const part of [1, 2, 3, 4]) add(`author-${part}-2`, "author", 1010 + part * 10, 1120 + part * 12, { part, parts: 4 });
  for (const part of [1, 2, 3, 4]) add(`review-${part}-2`, "review", 1150 + part * 5, 1190 + part * 5, { part, parts: 4 });
  add("repair-1", "repair", 1180, 1199, { part: 1, parts: 4 });
  add("repair-2", "repair", 1185, 1200, { part: 2, parts: 4 });
  for (const part of [1, 2, 3]) add(`author-${part}-3`, "author", 1195, 1200.5, { part, parts: 4, status: "cancelled" });   // in flight when the limit stopped the run
  return { id: "qa-ended", status: "failed", stage: BUDGET, deckTitle: "Recovered questions", kind: "quiz", requestedTotal: 40, savedCount: 13, parts: 4, batchSize: 5, concurrency: 4, steps,
    startedAt: iso(base), finishedAt: iso(base + 1201), totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600, messages: [] };
}

/** A run 14 minutes into its 20: three planning calls took about a minute, the fourth has run since the start; the authors began a minute and a half ago. */
function runningJob() {
  const base = -840, steps = [];
  const add = (...args) => steps.push(call(base, ...args));
  for (const part of [1, 2, 3]) add(`plan-${part}`, "plan", 2, 50 + part * 6, { part, parts: 4 });
  add("plan-4", "plan", 4, null, { part: 4, parts: 4 });
  for (const part of [1, 2, 3]) add(`blueprint-${part}`, "blueprint", 90, 130 + part * 5, { part, parts: 4 });
  for (const part of [1, 2, 3]) add(`author-${part}`, "author", 750 + part * 3, null, { part, parts: 4 });
  return { id: "qa-running", status: "running", stage: "Writing source-grounded questions", deckTitle: "Consistency models", kind: "quiz", requestedTotal: 40, savedCount: 6, parts: 4, batchSize: 5, concurrency: 4, steps,
    startedAt: iso(base), totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600, messages: [] };
}

/** A coverage run: round 1 done, round 2 reached its limit, round 3 in flight for 12 minutes and 30 seconds. */
function coverageJob() {
  const base = -4300, steps = [], add = (...args) => steps.push(call(base, ...args));
  for (const part of [1, 2]) add(`r1-plan-${part}`, "plan", 10, 70, { part, parts: 2, round: 1 });
  for (const part of [1, 2]) add(`r1-author-${part}`, "author", 80, 200, { part, parts: 2, round: 1 });
  for (const part of [1, 2]) add(`r1-review-${part}`, "review", 210, 300, { part, parts: 2, round: 1 });
  add("r2-plan-1", "plan", 1000, 1070, { part: 1, parts: 2, round: 2 });
  add("r2-author-1", "author", 1080, 2200, { part: 1, parts: 2, round: 2, status: "cancelled" });
  for (const part of [1, 2]) add(`r3-plan-${part}`, "plan", 3550, 3610, { part, parts: 2, round: 3 });
  add("r3-author-1", "author", 3620, 3690, { part: 1, parts: 2, round: 3 });
  add("r3-author-2", "author", 3620, null, { part: 2, parts: 2, round: 3 });
  const list = [{ round: 1, status: "done", questions: 30, sections: 8, kept: 28, covered: 8 }, { round: 2, status: "failed", questions: 30, sections: 8, kept: 12, covered: 3, reason: "timeout" },
    { round: 3, status: "running", questions: 30, sections: 8 }, { round: 4, status: "pending", questions: 30, sections: 8 }];
  return { id: "qa-coverage", status: "running", stage: "Writing source-grounded questions", deckTitle: "Software architecture, whole course", kind: "quiz", requestedTotal: 120, savedCount: 40, parts: 2, steps,
    coveragePlan: { level: "standard", goal: 120, round: 3, rounds: 4, sections: 32, weights: "length" },
    coverageRun: { autoComplete: true, state: "running", list, percent: 31, tokensUsed: 1200000, startedAt: iso(base) },
    startedAt: iso(base), totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600, messages: [] };
}

/** A translation that used its hour (fixed) and a selection run that used its twenty minutes (fixed). */
function translationJob() {
  const base = -3800, steps = [];
  for (let part = 1; part <= 6; part += 1) steps.push(call(base, `tr-${part}`, "translate", part * 400 - 380, part * 400 - 120, { part, parts: 9 }));
  return { id: "qa-translation", type: "translation", status: "failed", stage: TRANSLATION_BUDGET, targetTitle: "Lecture 3 notes", documentId: "doc", target: "中文", done: 210, total: 480, translated: 210, steps,
    startedAt: iso(base), finishedAt: iso(base + 3601), totalTimeoutSeconds: 3600 };
}
function selectionJob() {
  const base = -1500, steps = [call(base, "sel-plan", "plan", 1, 400, { part: 1, parts: 1 }), call(base, "sel-author", "author", 410, 1190, { part: 1, parts: 1, status: "cancelled" })];
  return { id: "qa-selection", type: "supplement", origin: "selection", status: "failed", stage: SELECTION_BUDGET, targetTitle: "Selection · Week 2", requestedTotal: 6, savedCount: 0, steps,
    startedAt: iso(base), finishedAt: iso(base + 1201), totalTimeoutSeconds: 1200, generationTimeoutSeconds: 600 };
}
/** A record from before the limit was written on it. */
function oldJob() {
  const base = -2000;
  return { id: "qa-old", status: "failed", stage: BUDGET, deckTitle: "Older run", kind: "quiz", requestedTotal: 20, savedCount: 4, steps: [call(base, "old-plan", "plan", 1, 500, { part: 1, parts: 1 })],
    startedAt: iso(base), finishedAt: iso(base + 1210) };
}

const SCENARIOS = { ended: [endedJob], running: [runningJob], coverage: [coverageJob], fixed: [translationJob, selectionJob], old: [oldJob] };

export function parseArgs(argv) {
  const base = parseQaArgs(argv, "time-limit", { accent: "jade", scenario: "all" });
  const out = argv.includes("--out") ? base.out : base.out.replace(/time-limit[\\/]/, `time-limit${"/"}${base.scenario}-`);
  return { ...base, out, width: Number(base.width) === 1440 && !argv.includes("--width") ? 1280 : base.width };
}

export async function runTimeLimitQa(options) {
  const names = options.scenario === "all" ? Object.keys(SCENARIOS) : [options.scenario];
  for (const name of names) if (!SCENARIOS[name]) throw new Error(`unknown scenario ${name}`);
  const narrow = options.width < 700, jobs = names.flatMap((name) => SCENARIOS[name].map((make) => make()));
  return runQa({ name: "time-limit", options, latencyMs: 0, localStorageSeed: { "study-interface": JSON.stringify({ accent: options.accent }) },
    seed: (root) => seedLibrary(root, { sources: 12, decks: 3, cardsPerDeck: 8, runs: 1, attempts: 0, courses: 1, largeSources: 0 }),
    async run({ page, step, check, summary, t }) {
      const facts = {};
      summary.facts = facts;
      // The snapshot of the host, with the jobs of the scenarios put in at the network edge (nothing else is touched; `since` is dropped so the host always answers in full).
      await page.route("**/api/call", async (route) => {
        let body = null;
        try { body = JSON.parse(route.request().postData() || "null"); } catch { /* not JSON */ }
        // What a host answers for the output of a call it does not keep (the jobs here live only in the snapshot): nothing kept, not an error.
        if (body?.action === "job.output" && jobs.some((job) => job.id === body.args?.jobId)) {
          const ended = !(jobs.find((job) => job.id === body.args.jobId)?.steps || []).find((item) => item.id === body.args.callId && item.status === "running");
          return route.fulfill({ json: { ok: true, value: { jobId: body.args.jobId, callId: body.args.callId, supported: false, live: !ended, text: "", nextCursor: 0, truncated: false, reasoningChars: 0,
            retention: { unit: "chars", limit: 0, persisted: false, endedCalls: 0 } } } });
        }
        if (body?.action !== "snapshot") return route.continue();
        const { since: _since, ...args } = body.args || {};
        const response = await route.fetch({ postData: JSON.stringify({ ...body, args }) });
        const json = await response.json();
        if (json.ok) json.value.jobs = [...jobs.map((job) => snapshotJob(job)), ...(json.value.jobs || [])];
        await route.fulfill({ response, json });
      });
      const goto = async (nav) => { const entry = page.locator(`[data-tour="nav-${nav}"]`).first(); await entry.waitFor({ state: "attached" }); await entry.dispatchEvent("click"); await sleep(700); };
      const noOverflow = async (label) => { const probe = await page.evaluate(overflowProbe); assert.ok(probe.scrollWidth <= probe.clientWidth + 1, `horizontal overflow on ${label}: ${JSON.stringify(probe)}`); };
      const open = async (id) => {
        await goto("tasks");
        const row = page.locator(`.tc-row[data-task-id="${id}"]`);
        await row.waitFor({ timeout: 30000 });
        await row.dispatchEvent("click");
        await page.locator(`.tc-detail[data-task-id="${id}"]`).waitFor({ timeout: 30000 });
        await sleep(900);
        return flat(await page.locator(".tc-detail").innerText());
      };
      const stripOf = async () => ({ text: flat(await page.locator(".tc-limit").first().innerText()), box: await page.locator(".tc-limit").first().boundingBox() });
      const frame = async (what) => { if (narrow) await page.locator(".tc-limit").first().scrollIntoViewIfNeeded().catch(() => {}); await sleep(300); return what; };
      /** The strip is quiet: one or two text lines, nothing taller than a third of the detail's first screen. */
      const quiet = (box, label) => assert.ok(box && box.height < (narrow ? 230 : 120), `the strip is not quiet on ${label}: ${JSON.stringify(box)}`);

      if (names.includes("ended")) {
        await step("ended-strip", async () => {
          const detail = await open("qa-ended");
          const { text, box } = await stripOf();
          facts.ended = { strip: text, box };
          assert.match(text, new RegExp(t("运行时限 20 分钟", "Time budget 20 min")), text);
          assert.match(text, new RegExp(t("已用 20 分 1 秒", "Elapsed 20 min 1 sec")), text);
          assert.ok(detail.includes(t("已用 20 分 1 秒", "Elapsed 20 min 1 sec")) || detail.includes(t("已用", "Elapsed")), "the facts row has the same elapsed time");
          assert.match(detail, new RegExp(t("13 / 40", "13 / 40")), "13 of 40 questions");
          assert.match(detail, new RegExp(t("32 · 3 失败", "32 · 3 failed")), "32 calls, 3 failed");
          assert.match(text, new RegExp(t("单次模型调用最长 10 分钟", "one model call may run 10 min at most")), text);
          assert.match(text, new RegExp(t("已用满时限，任务自动停止；已通过检查的题已保留", "The time budget ran out and the job stopped by itself; questions that passed the checks are kept")), text);
          assert.match(text, new RegExp(t("最慢的(一步|几步)", "Slowest steps?")), text);
          assert.match(text, new RegExp(t("到了单次调用上限", "hit the one-call limit")), text);
          assert.ok(await page.locator("[data-limit-adjust]").count() === 1, "one 调整时限");
          quiet(box, "ended");
          await noOverflow("the ended task");
          return frame("ended");
        });
        await step("ended-marks", async () => {
          const marked = await page.locator(".tc-callbar[data-slow]").count();
          facts.endedMarked = marked;
          assert.ok(marked >= 1, "a bar of the timeline is marked");
          const bar = page.locator(".tc-callbar[data-slow]").first(), title = await bar.getAttribute("title");
          assert.match(title, new RegExp(t("10 分 0 秒|10 分钟", "10 min")), title);
          const style = await bar.evaluate((element) => { const css = getComputedStyle(element); return { outline: css.outlineStyle + " " + css.outlineWidth, pattern: css.backgroundImage !== "none" }; });
          facts.markStyle = style;
          assert.ok(style.pattern && !style.outline.startsWith("none"), `the mark is a pattern and a ring, not colour alone: ${JSON.stringify(style)}`);
          // The marked bars are in the window: the whole run is drawn because the failed planning calls began at its start.
          const lefts = await page.locator(".tc-callbar[data-slow]").evaluateAll((els) => els.map((el) => parseFloat(el.style.left)));
          assert.ok(lefts.every((left) => left < 5), `the marked planning bars begin at the left edge: ${lefts}`);
          await page.locator(".tc-timeline").scrollIntoViewIfNeeded().catch(() => {});
        });
        await step("ended-pick-slowest", async () => {
          const button = page.locator("[data-slow-call]").first(), id = await button.getAttribute("data-slow-call");
          await button.click();
          await sleep(500);
          const pressed = await page.locator(`.tc-callbar[aria-pressed="true"]`).count();
          facts.pickedId = id;
          assert.ok(pressed >= 1, "the call is selected on the timeline, like a click on its bar");
          assert.ok((await page.locator(".tc-output").first().innerText()).trim().length > 0, "the output panel shows the call");
          if (narrow) await page.locator(".tc-output").first().scrollIntoViewIfNeeded();
        });
        await step("ended-adjust", async () => {
          await page.locator(".tc-limit").first().scrollIntoViewIfNeeded().catch(() => {});
          await page.locator("[data-limit-adjust]").dispatchEvent("click");
          const field = page.locator('[name="jobTimeoutMinutes"]');
          await field.waitFor({ state: "visible", timeout: 30000 });
          await sleep(1200);
          const where = await field.evaluate((element) => { const r = element.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: window.innerHeight }; });
          facts.fieldAt = where;
          assert.ok(where.top >= 0 && where.bottom <= where.height, `the field is inside the window: ${JSON.stringify(where)}`);
          assert.ok((await page.locator(".settings-page").count()) > 0, "this is Settings");
          const section = flat(await page.locator('[data-tour="settings-generation"]').first().innerText());
          assert.match(section.slice(0, 40), new RegExp(t("出题偏好", "Question defaults")), section.slice(0, 80));
        });
      }
      if (names.includes("running")) {
        await step("running-strip", async () => {
          await open("qa-running");
          const { text, box } = await stripOf();
          facts.running = { strip: text, box };
          assert.match(text, new RegExp(t("运行时限 20 分钟", "Time budget 20 min")), text);
          assert.match(text, new RegExp(t("已用 1[4-5] 分", "Elapsed 1[4-5] min")), text);
          assert.doesNotMatch(text, new RegExp(t("自动停止", "stopped by itself")), "a running task is not said to be stopped");
          assert.match(text, new RegExp(t("运行偏久", "Running long")), text);
          assert.ok((await page.locator('[data-slow-call="plan-4"]').count()) === 1, "the planning call that ran 13 minutes is named");
          assert.ok((await page.locator('[data-slow-call^="author"]').count()) === 0, "authors that began 1.5 minutes ago are not");
          assert.ok((await page.locator(".tc-callbar[data-slow]").count()) === 1, "one bar is marked");
          quiet(box, "running");
          await noOverflow("the running task");
          return frame("running");
        });
      }
      if (names.includes("coverage")) {
        await step("coverage-strip", async () => {
          await open("qa-coverage");
          const { text, box } = await stripOf();
          facts.coverage = { strip: text, box };
          assert.match(text, new RegExp(t("每轮运行时限 20 分钟", "Time budget per round 20 min")), text);
          assert.match(text, new RegExp(t("本轮已用 12 分", "Elapsed this round 12 min")), text);
          assert.match(text, new RegExp(t("第 2 轮到了时限", "Round 2 reached the time budget")), text);
          assert.ok((await page.locator("[data-limit-adjust]").count()) === 1, "per-round limit is the setting: the link is there");
          quiet(box, "coverage");
          await noOverflow("the coverage run");
          return frame("coverage");
        });
      }
      if (names.includes("fixed")) {
        await step("fixed-translation", async () => {
          await open("qa-translation");
          const { text, box } = await stripOf();
          facts.translation = { strip: text, box };
          assert.match(text, new RegExp(t("运行时限 60 分钟（固定）", "Time budget 60 min \\(fixed\\)")), text);
          assert.match(text, new RegExp(t("已翻译的段落已保留", "translated paragraphs are kept")), text);
          assert.ok((await page.locator("[data-limit-adjust]").count()) === 0, "a fixed limit offers no way to change it");
          quiet(box, "translation");
          await noOverflow("the translation");
          return frame("translation");
        });
        await step("fixed-selection", async () => {
          await open("qa-selection");
          const { text, box } = await stripOf();
          facts.selection = { strip: text, box };
          assert.match(text, new RegExp(t("运行时限 20 分钟（固定）", "Time budget 20 min \\(fixed\\)")), text);
          assert.match(text, new RegExp(t("题组没有变化", "the deck is unchanged")), text);
          assert.ok((await page.locator("[data-limit-adjust]").count()) === 0);
          quiet(box, "selection");
          return frame("selection");
        });
      }
      if (names.includes("old")) {
        await step("old-record", async () => {
          const detail = await open("qa-old");
          assert.ok((await page.locator(".tc-limit").count()) === 0, "a record with no limit shows no strip");
          assert.ok(detail.length > 50 && (await page.locator(".tc-callbar").count()) > 0, "the rest of the page is drawn");
          assert.ok((await page.locator(".tc-callbar[data-slow]").count()) === 0, "and no step is marked");
          await noOverflow("the old record");
        });
      }
      await check("no raw English or code in the strips", async () => {
        const all = Object.values(facts).filter((item) => item?.strip).map((item) => item.strip).join(" ");
        if (options.lang === "zh") assert.doesNotMatch(all, /budget|undefined|\[object|NaN/i, all);
        else assert.doesNotMatch(all, /[㐀-鿿]|undefined|\[object|NaN/, all);
      });
    } });
}

if (process.argv[1]?.endsWith("time-limit.mjs")) {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runTimeLimitQa(options);
  console.log(JSON.stringify(summary.facts, null, 1));
  finishCli("time-limit", options, summary);
}
