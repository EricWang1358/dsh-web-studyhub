/* npm run qa:honest-states [-- --scenario flag|refuse|restart|manual --lang zh|en --theme dark|light --width 1280|420 --accent cinnabar|jade --out <dir>]
   The honest states of a coverage run (the student-side evaluation of 2026-10-06; docs/coverage.md "Honest states") in the browser preview, on a seeded temporary library with the fake model:
   the merged five-recording transcript with a planner that follows its assignment, and one thing that goes wrong on purpose.
     flag     the review flags the first question of every batch for good: the run stops with sections left and 174 of ~251 questions. The home banner, the 待发布 row, the 任务 console and the
              draft page must tell ONE story: the same questions (已出 N/M 题), the same sections (还有 K 个小节没有题), the same next round, no 100%, a badge that is not 「已复审，待发布」,
              and the same ONE action (为没覆盖的部分补题) on the banner and the row.
     refuse   the key is refused after 14 planning calls: ONE plain sentence (never the provider's English), 去配置模型 on the banner, the row and in the console (which also offers 接着做); once
              the key works, 接着做 continues the run and the draft keeps what it had.
     restart  the host stopped under a paused run: the banner and the row offer the one action 接着做 (not 打开草稿), the title is the deck's, not an internal label.
     paused   a live run paused between rounds: the banner and the row offer the one action 继续, the console says 暂停于第 N 轮之后, and nothing says 100%.
   practise the line under a practice answer follows the mastery level (D-6): one correct answer is 「答对了 · 下次复习 …」, never 「✓ 已掌握」, and the library agrees (学习中).
   manual   精简 waits for the learner: the form's line and the draft page say 「精简：先出第 1 轮，覆盖 N%；点「自动补到完整」继续」, and the one button is 为没覆盖的部分补题.
   Every claim is read off the page and compared with the same fact from the snapshot. Fake model, Chromium, every key/token/base-url variable removed; one screenshot per step. */
/* global document, window, getComputedStyle */
import assert from "node:assert/strict";
import { Store } from "../../lib/store.js";
import { StudyService } from "../../lib/service.js";
import { previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";
import { mergedTranscript, RECORDING_NAMES } from "../../tests/helpers/merged-transcript.mjs";
import { sectionedModel } from "../../tests/helpers/coverage-fixture.mjs";
import { importExample } from "../../ui/json-prompts.js";
import { reportUsage } from "../../lib/usage-scope.js";
import { dshSystemTokens, dshUserTokens } from "../../lib/token-estimate.js";

const world = mergedTranscript();
const iso = (ms) => new Date(ms).toISOString();
const PLAN = /^Plan a source-grounded/, REVIEW = /^Act as a strict assessment editor/;
const refusal = () => Object.assign(new Error("401 Unauthorized: Invalid API key"), { status: 401 });

async function seed(root) {
  const store = new Store(root), batchId = "qa-honest", ids = world.sources.map((_, index) => (index ? `audio-batch-${batchId}-p${index + 1}` : `audio-batch-${batchId}`));
  const batch = { id: batchId, title: `${RECORDING_NAMES[0]} + 4`, members: RECORDING_NAMES.map((filename, index) => ({ order: index + 1, filename, hash: String(index).padStart(64, "0") })), volumes: world.sources.length };
  await store.update((state) => {
    world.sources.forEach((source, index) => state.sources.push({ id: ids[index], createdAt: iso(Date.now() - 60000), text: source.text, courses: ["软件架构"], title: `${batch.title} · 全量中英对照逐字稿 (${index + 1}/${world.sources.length})`,
      audio: { course: "", batch: { ...batch, volume: index + 1 }, sourceIds: ids, importedAt: iso(Date.now() - 60000) } }));
  });
  return ids;
}

/** The fake model of a scenario: the planner follows its assignment; `scenario` says what goes wrong. `state.revoked` is flipped by the run to fix the key. */
function modelFor(scenario, state = { plans: 0, revoked: true }) {
  const fake = createFakeModel({ latencyMs: 0, usage: false }), sectioned = sectionedModel().complete;
  const inner = async (system, prompt, context = {}) => (/^(Plan a source-grounded|Prepare supported|You author|Act as a strict assessment)/.test(system) ? sectioned(system, prompt, context) : fake(system, prompt, context));
  const complete = async (system, prompt, context = {}) => {
    if (scenario === "refuse" && PLAN.test(system) && state.revoked && ++state.plans > 14) throw refusal();
    let reply = await inner(system, prompt, context);
    if (scenario === "flag" && REVIEW.test(system)) {
      const verdict = JSON.parse(reply), card = JSON.parse(prompt).candidate.cards[0];
      verdict.issues = [`${card.id}: answerLeak failed - the stem gives the answer away`];
      verdict.checks = verdict.checks.map((check) => (check.cardId === card.id ? { ...check, answerLeak: "fail", explanation: "The stem leaks the answer." } : check));
      reply = JSON.stringify(verdict);
    }
    reportUsage({ uncachedInputTokens: dshSystemTokens(system) + dshUserTokens(prompt), cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: Math.max(1, dshUserTokens(reply) - 8) }, { calls: 1 });
    return reply;
  };
  return Object.assign(complete, { state });
}

const waitFor = async (what, check, { timeoutMs = 240000, every = 250 } = {}) => { const end = Date.now() + timeoutMs; for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(every); } };
const flat = (value) => String(value).replace(/\s+/g, " ").trim();

export function parseArgs(argv) {
  const base = parseQaArgs(argv, "honest-states", { accent: "cinnabar", scenario: "flag" });
  const out = argv.includes("--out") ? base.out : base.out.replace(/honest-states[\\/]/, `honest-states${"/"}${base.scenario}-`);
  return { ...base, out, width: Number(base.width) === 1440 && !argv.includes("--width") ? 1280 : base.width };
}

export async function runHonestQa(options) {
  const scenario = options.scenario, model = modelFor(scenario), narrow = options.width < 700;
  return runQa({ name: "honest-states", options, model, latencyMs: 0, localStorageSeed: { "study-interface": JSON.stringify({ accent: options.accent }) },
    seed: async (root) => {
      options.ids = await seed(root);
      if (scenario === "practise") {
        const service = new StudyService(root, {});
        try {
          const draft = await service.call("draft.import", { text: importExample("quiz") });
          await service.call("draft.publish.quick", { id: draft.id, draftVersion: draft.draftVersion });
        } finally { service.dispose(); }
        return;
      }
      if (scenario !== "restart") return;
      // The host stopped under a paused run: a service over this library runs round 1, pauses, and is let go; the preview opens the same folder as a new process would.
      const service = new StudyService(root, {});
      service.complete = modelFor("none");
      service.light = async (system, prompt) => JSON.stringify({ sections: JSON.parse(prompt.split("\n\n")[0]).sections.map((item) => ({ id: item.id, importance: 3, kind: "definition", reason: "r" })) });
      const started = await service.call("generate", { sourceIds: options.ids, coverageLevel: "standard", kind: "quiz" });
      await waitFor("round 1", async () => (await service.call("export")).drafts[0]?.editorial?.coverageSpec?.rounds?.[0]?.status === "done", { timeoutMs: 120000 });
      await service.call("job.control", { jobId: started.jobId, action: "pause" });
      await waitFor("the pause", async () => (await service.call("export")).drafts[0]?.editorial?.coverageRun?.state === "paused", { timeoutMs: 120000 });
      service.dispose();
    },
    async run({ page, server, step, check, summary, t }) {
      const call = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: options.lang });
      const facts = {};
      summary.facts = facts;
      const goto = async (nav) => { const entry = page.locator(`[data-tour="nav-${nav}"]`).first(); await entry.waitFor({ state: "attached" }); await entry.dispatchEvent("click"); await sleep(900); };
      const idle = () => waitFor("the run to end", async () => !(await call("snapshot", {})).jobs.some((job) => ["queued", "running", "cancelling"].includes(job.status)));
      const noOverflow = async (label) => { const probe = await page.evaluate(overflowProbe); assert.ok(probe.scrollWidth <= probe.clientWidth + 1, `horizontal overflow on ${label}: ${JSON.stringify(probe)}`); };
      const draftOf = async () => (await call("snapshot", {})).drafts[0];
      const raw = (text) => !/Unauthorized|Invalid API key|\b401\b|Part \d+:/.test(text);
      const labels = async (scope) => (await scope.locator("button").evaluateAll((els) => els.filter((el) => el.offsetParent !== null).map((el) => el.innerText.trim()).filter(Boolean))).map((label) => flat(label).replace(/\s*→$/, ""));
      const consoleOf = async () => {
        await goto("tasks");
        await page.locator(".tc-row").first().waitFor({ timeout: 30000 });
        await page.locator(".tc-row").first().dispatchEvent("click");
        await waitFor("the console to show the run as ended", async () => (await page.locator(".tc-detail[data-status='running']").count()) === 0, { timeoutMs: 60000 });
        await sleep(1500);
        return { text: flat(await page.locator(".tc-detail").first().innerText()), buttons: await labels(page.locator(".tc-detail").first()) };
      };
      const homeOf = async ({ buttonOnBanner } = {}) => {
        await goto("library");
        await page.locator(".draft-row").first().waitFor({ timeout: 30000 });
        // The page polls the library: wait until it has caught up with a run that has ended (no stop control on the banner, the row not busy).
        await waitFor("the home to show the run as ended", async () => (await page.locator(".cjc").count()) === 0 || (await page.locator(".cjc[data-state='run']").count()) === 0, { timeoutMs: 60000 });
        if (buttonOnBanner) await waitFor(`the banner to offer ${buttonOnBanner}`, async () => (await page.locator(".cjc").first().locator("button", { hasText: new RegExp(`^${buttonOnBanner}`) }).count()) > 0, { timeoutMs: 60000 });
        await sleep(1200);
        const banner = page.locator(".cjc").first(), row = page.locator(".draft-row").first();
        return { banner: (await banner.count()) ? flat(await banner.innerText()) : "", bannerButtons: (await banner.count()) ? await labels(banner) : [], row: flat(await row.innerText()), rowButtons: await labels(row), rowBadge: flat(await row.locator("[data-draft-status]").innerText().catch(() => "")) };
      };
      const draftPageOf = async () => {
        await page.locator(".draft-open").first().click();
        await page.locator("[data-coverage-summary]").waitFor({ timeout: 30000 });
        await sleep(800);
        return { text: flat(await page.locator("main").first().innerText()), run: flat(await page.locator("[data-coverage-run]").first().innerText().catch(() => "")), buttons: await labels(page.locator("[data-coverage-summary]")) };
      };

      const ids = options.ids;
      if (scenario === "flag" || scenario === "refuse") {
        await call("generate", { sourceIds: ids, coverageLevel: "standard", kind: "quiz" });
        await idle();
      }
      if (scenario === "manual") {
        await step("form-lean-manual-line", async () => {
          await goto("generate");
          await page.locator('[data-tour="generate-sources"]').waitFor({ timeout: 30000 });
          await page.getByRole("button", { name: /选择当前范围|Select this scope/ }).first().click();
          await page.locator("[data-coverage-strength]").scrollIntoViewIfNeeded();
          await page.locator(".cov-strength__levels .sh-seg__item", { hasText: t("精简", "Lean") }).first().click();
          await page.locator("[data-coverage-auto-note]").waitFor({ timeout: 30000 });
          await sleep(900);
          const note = flat(await page.locator("[data-coverage-auto-note]").innerText()), level = flat(await page.locator("[data-coverage-level-note]").innerText());
          facts.formAutoNote = note; facts.formLevelNote = level;
          assert.match(note, new RegExp(t("^精简：先出第 1 轮，覆盖约 \\d+%；点「自动补到完整」继续", "^Lean: round 1 is made first, covering about \\d+%\\. Tick")), note);
          assert.match(level, new RegExp(t("覆盖的小节不多是设计如此", "few sections are covered by design")), level);
          await noOverflow("the creation form");
        });
        await call("generate", { sourceIds: ids, coverageLevel: "lean", kind: "quiz" });
        await idle();
      }

      if (scenario === "practise") {
        await step("practise-home", async () => { await goto("library"); await sleep(1200); });
        await step("practise-answer-correct", async () => {
          const start = page.getByRole("button", { name: /继续课程|开始学|开始做|接着学|继续学习|Continue course|Start|Keep studying|Continue/ }).first();
          await start.click(); await sleep(1500);
          const options = page.locator('[role="radio"], .choice, .option, [data-option]');
          await options.first().waitFor({ timeout: 20000 });
          // Pick the option the card marks correct: the fake import's first option is right ("Option A")
          const deck = (await call("export", {})).decks[0], right = deck.cards[0].options.find((option) => option.correct)?.text;
          await page.getByText(right, { exact: false }).first().click(); await sleep(250);
          const submit = page.getByRole("button", { name: /^(提交|确认|Submit|Check)/ }).first();
          if (await submit.count()) await submit.click();
          await page.locator(".next-due").waitFor({ timeout: 20000 });
          const line = flat(await page.locator(".next-due").first().innerText());
          facts.feedbackLine = line;
          assert.ok(!/已掌握|Mastered/.test(line), `one correct answer is not 「已掌握」: ${line}`);
          assert.match(line, new RegExp(t("^答对了 · 下次复习", "^Correct · next review")), line);
          const snapshot = await call("snapshot", {}), level = snapshot.progress?.[deck.id]?.counts;
          facts.libraryCounts = level;
          assert.ok(level && level.learning >= 1 && !level.mastered, `the library calls the same question 学习中: ${JSON.stringify(level)}`);
          await page.locator(".next-due").first().scrollIntoViewIfNeeded();
        });
        return;
      }

      if (scenario === "paused") {
        const started = await call("generate", { sourceIds: ids, coverageLevel: "standard", kind: "quiz" });
        await waitFor("round 1", async () => (await draftOf())?.editorial?.coverageSpec?.rounds?.[0]?.status === "done", { timeoutMs: 120000 });
        await call("job.control", { jobId: started.jobId, action: "pause" });
        await waitFor("the pause", async () => (await draftOf())?.editorial?.coverageRun?.state === "paused", { timeoutMs: 120000 });
        await sleep(2500);
      }

      let home, consoleView, draft;
      await step("home", async () => { home = await homeOf(scenario === "paused" ? { buttonOnBanner: t("继续", "Continue") } : scenario === "restart" ? { buttonOnBanner: t("接着做", "Continue") } : {}); facts.home = home; });
      await step("console", async () => { consoleView = await consoleOf(); facts.console = consoleView; });
      if (scenario !== "restart") await step("console-log", async () => { await page.locator(".tc-tab", { hasText: t("日志", "Log") }).first().click(); await sleep(900); facts.log = flat(await page.locator(".tc-detail").first().innerText()); });
      await step("draft-top", async () => { await goto("library"); draft = await draftPageOf(); facts.draft = draft; await noOverflow("the draft page"); });
      await step("draft-run", async () => { await page.locator("[data-coverage-run]").first().scrollIntoViewIfNeeded(); await sleep(400); });
      const snap = await draftOf();
      const spec = snap.editorial.coverageSpec, kept = snap.cards.length, goal = spec.goal;
      facts.snapshot = { kept, goal, state: snap.editorial.coverageRun?.state, stop: snap.editorial.coverageRun?.stop };

      if (scenario === "flag") {
        await check("one story: the same questions, sections and next round on every screen; no 100%", async () => {
          const view = await call("coverage.get", { draftId: snap.id }), left = view.coverage.leaves - view.coverage.covered;
          assert.ok(left > 0 && kept < goal, `the scenario must leave the draft short (${kept}/${goal}, ${left} sections)`);
          const said = `${t("已出", "Made")} ${kept}/${goal}`;
          for (const [where, text] of [["home banner+row", `${home.banner} | ${home.row}`], ["console", consoleView.text], ["draft page", draft.text]]) {
            assert.ok(text.includes(said), `${where} says ${said}: ${text.slice(0, 400)}`);
            assert.ok(!/\b100%/.test(text.replace(/(覆盖现在|Coverage now) .*?(题|questions)/g, "").replace(/覆盖 ?\d+%|Covered \d+%/g, "")) || false, `${where} must not say 100% for a short draft: ${(/.{30}\b100%.{30}/.exec(text) || [""])[0]}`);
          }
          const sections = new RegExp(t(`还有 ${left} 个小节没有题`, `${left} sections? still without a question`));
          for (const [where, text] of [["home banner+row", `${home.banner} | ${home.row}`], ["console", consoleView.text], ["draft page", draft.text]]) assert.match(text, sections, where);
          const next = view.round.sections, after = view.round.left;
          const nextText = after > 0 ? t(`下一轮补 ${next} 个小节，还剩 ${after} 个`, `The next round covers ${next} sections; ${after} left after it`) : t(`下一轮补 ${next} 个小节`, `The next round covers ${next} sections`);
          for (const [where, text] of [["home row", home.row], ["console", consoleView.text]]) assert.ok(text.includes(nextText), `${where} says "${nextText}": ${text.slice(0, 500)}`);
          assert.ok(!/已复审，待发布|Re-reviewed; ready to publish/.test(home.row), "a short draft is not 「已复审，待发布」");
          assert.ok(home.rowBadge, "the row has a badge");
          const action = t("为没覆盖的部分补题", "Add questions for the uncovered parts");
          assert.deepEqual(home.bannerButtons.filter((label) => label.startsWith(action)), [action], "the banner's one primary action");
          assert.deepEqual(home.rowButtons.filter((label) => label.startsWith(action)), [action], "the row's one primary action");
          return { kept, goal, left, next, after };
        });
        await step("draft-short-list", async () => { await page.locator("[data-coverage-list] summary").first().click().catch(() => {}); await sleep(500); });
        await step("draft-scroll-sticky", async () => {
          // The draft page's action bar is sticky (D-14): while the page scrolls under it, it must be OPAQUE (no coverage text showing through its buttons) and, on a narrow screen, ONE row
          // (a two-row bar covers a seventh of the screen); at rest (scrolled to the top) it overlaps nothing.
          const verdicts = [];
          for (const top of [0, 300, 700, 1100]) {
            await page.evaluate((y) => { for (const el of [document.scrollingElement, ...document.querySelectorAll("main, .study-app, .page, .study-main")]) if (el) el.scrollTop = y; window.scrollTo(0, y); }, top);
            await sleep(300);
            verdicts.push(await page.evaluate((y) => {
              const bar = document.querySelector(".sticky-actions"); if (!bar) return null;
              const box = bar.getBoundingClientRect(), style = getComputedStyle(bar), alpha = (/rgba?\(([^)]*)\)/.exec(style.backgroundColor)?.[1] || "").split(",").map(Number);
              const hits = [];
              for (const el of document.querySelectorAll(".cov-summary__line, .cov-summary__plan, .cov-run__counts, .cov-run__line, .cov-summary__kicker")) {
                const rect = el.getBoundingClientRect();
                if (rect.bottom > box.top + 1 && rect.top < box.bottom - 1 && rect.height > 0) hits.push(el.className);
              }
              return { scroll: y, barTop: Math.round(box.top), height: Math.round(box.height), alpha: alpha.length === 4 ? alpha[3] : 1, sticky: style.position, overlapping: hits };
            }, top));
          }
          facts.stickyVerdicts = verdicts;
          for (const verdict of verdicts.filter(Boolean)) {
            assert.equal(verdict.alpha, 1, `the sticky bar is opaque: ${JSON.stringify(verdict)}`);
            if (narrow) assert.ok(verdict.height <= 70, `the sticky bar is one row on a narrow screen: ${JSON.stringify(verdict)}`);
          }
          assert.deepEqual(verdicts[0].overlapping, [], `at rest nothing is under the bar: ${JSON.stringify(verdicts[0])}`);
          await sleep(300);
        });
      }

      if (scenario === "refuse") {
        await check("the refusal is one plain sentence on every screen, never the provider's English", async () => {
          for (const [where, text] of [["home", `${home.banner} | ${home.row}`], ["console", consoleView.text], ["draft page", draft.text]]) assert.ok(raw(text), `${where} prints the provider's English: ${(/.{40}(?:Unauthorized|Invalid API key|Part \d+:).{40}/.exec(text) || [""])[0]}`);
          const sentence = t("模型服务拒绝了请求（密钥无效或没有权限）", "The model service refused the request (the key is invalid or lacks permission)");
          assert.ok(consoleView.text.includes(sentence) || draft.text.includes(sentence), `the plain sentence is on the console or the draft page`);
          assert.equal((consoleView.text.match(new RegExp(sentence.replace(/[()]/g, "\\$&"), "g")) || []).length <= 2, true, "said once (the strip), not once per part");
          const setup = t("去配置模型", "Set up a model");
          assert.ok(home.bannerButtons.includes(setup), `the banner's action is ${setup}: ${home.bannerButtons}`);
          assert.ok(home.rowButtons.includes(setup), `the row's action is ${setup}: ${home.rowButtons}`);
          assert.ok(consoleView.buttons.includes(setup), `the console header has ${setup}: ${consoleView.buttons}`);
          assert.ok(consoleView.buttons.some((label) => label === t("接着做", "Continue")), `the console offers 接着做 once the key works: ${consoleView.buttons}`);
        });
        await step("console-after-fix-key", async () => {
          model.state.revoked = false;
          await goto("tasks");
          await page.locator(".tc-row").first().dispatchEvent("click");
          await sleep(800);
          const button = page.locator(".tc-head__actions button", { hasText: new RegExp(`^${t("接着做", "Continue")}$`) }).first();
          await button.click();
          await idle();
          const after = await draftOf();
          assert.ok(after.cards.length > kept, `the run continued from its next round: ${kept} -> ${after.cards.length}`);
          facts.afterFix = { kept: after.cards.length, state: after.editorial.coverageRun?.state, stop: after.editorial.coverageRun?.stop };
          await sleep(1500);
        });
      }

      if (scenario === "restart") {
        await check("the banner and the row offer the one action 接着做; the title is the deck's", async () => {
          const again = t("接着做", "Continue");
          assert.ok(home.bannerButtons.includes(again), `the banner's action: ${home.bannerButtons}`);
          assert.ok(home.rowButtons.includes(again), `the row's action: ${home.rowButtons}`);
          assert.ok(!home.bannerButtons.some((label) => /打开草稿|Open draft/.test(label)), `the banner has ONE primary action: ${home.bannerButtons}`);
          assert.ok(!/正在补齐|Adding questions to/.test(home.banner), `an interrupted run is not "being filled": ${home.banner}`);
          assert.ok(home.banner.includes(snap.title), `the title is the deck's own: ${home.banner}`);
          assert.ok(home.row.includes(t("已中断", "Interrupted")), home.row);
        });
        await step("press-continue", async () => {
          await goto("library");
          await page.locator(".draft-row").first().waitFor({ timeout: 30000 });
          await page.locator(".draft-row").first().getByRole("button", { name: new RegExp(`^${t("接着做", "Continue")}$`) }).click();
          await sleep(1500);
          facts.afterPress = flat(await page.locator(".cjc").first().innerText().catch(() => ""));
          await idle();
          await goto("library");
          await sleep(1000);
        });
      }

      if (scenario === "paused") {
        await check("the banner and the row offer the one action 继续; the console says where it paused; no 100%", async () => {
          const again = t("继续", "Continue");
          assert.ok(home.bannerButtons.includes(again), `the banner's action: ${home.bannerButtons}`);
          assert.ok(home.rowButtons.includes(again), `the row's action: ${home.rowButtons}`);
          assert.ok(!home.bannerButtons.some((label) => /打开草稿|Open draft/.test(label)), `the banner has ONE primary action: ${home.bannerButtons}`);
          assert.match(consoleView.text, new RegExp(t("暂停于第 \\d+ 轮之后", "Paused after round \\d+")), consoleView.text.slice(0, 400));
          for (const text of [`${home.banner} ${home.row}`, consoleView.text, draft.text]) assert.ok(!/100%/.test(text.replace(/(覆盖现在|Coverage now) .*?(题|questions)/g, "").replace(/覆盖 ?\d+%|Covered \d+%/g, "")), "a paused run is not 100%");
        });
        await step("press-continue", async () => {
          await goto("library");
          await page.locator(".draft-row").first().getByRole("button", { name: new RegExp(`^${t("继续", "Continue")}$`) }).click();
          await sleep(2500);
          facts.afterPress = flat(await page.locator(".cjc").first().innerText().catch(() => ""));
          await idle();
        });
      }

      if (scenario === "manual") {
        await check("精简 waits for the learner: the draft page says it plainly and offers the one button; the toggle is one click away", async () => {
          assert.equal(snap.editorial.coverageRun.autoComplete, false);
          const line = new RegExp(t("精简：先出第 1 轮，覆盖 \\d+%；点「自动补到完整」继续", "Lean: round 1 is made, \\d+% covered; tick \"Finish automatically\" to go on"));
          assert.match(draft.text, line, draft.text.slice(0, 600));
          assert.ok(draft.run.includes(t("自动补到完整", "Finish automatically")), "the toggle is on the page");
          assert.ok(draft.buttons.includes(t("为没覆盖的部分补题", "Add questions for the uncovered parts")), `the one button: ${draft.buttons}`);
          assert.ok(!/\b100%/.test(`${home.banner} ${consoleView.text}`.replace(/(覆盖现在|Coverage now) .*?(题|questions)/g, "").replace(/覆盖 ?\d+%|Covered \d+%/g, "")), "a manual run waiting after round 1 is not 100%");
        });
      }
      await check("no horizontal overflow on the home", async () => { await goto("library"); await sleep(500); await noOverflow("the home"); });
      facts.narrow = narrow;
    } });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("honest-states.mjs")) {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runHonestQa(options);
  finishCli("honest-states", options, summary);
}
