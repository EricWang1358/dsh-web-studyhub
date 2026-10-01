/* npm run qa:journey [-- --lang zh|en --theme dark|light --width 1440|420
                          --steps a,b,c --out <dir> --keep]
   A new learner's core loop in the browser preview, one screenshot set per
   step: empty library → add material → import files → sources → generate →
   job progress → draft → publish → practice → mistakes → settings.

   Runs the real preview server (scripts/preview-server.mjs) with the fake
   model on a fresh temporary library, in Chromium, with every key/token/
   base-url variable removed from the environment. Writes <out>/summary.json
   (steps, console errors, page errors, failed API calls) and exits non-zero
   when a step fails or the page throws.

   Add a step: append one { name, needs?, run } entry to JOURNEY_STEPS.
   `needs` lists state the step requires (material, draft, deck, answers);
   when a step runs without the earlier steps, that state is created through
   the API first. Find elements by data-tour anchors first (plan §4 C7), then
   by their Chinese UI text through j.t(), which follows the UI language. */
/* global document, getComputedStyle, innerHeight -- page.evaluate callbacks run in the browser */
import { mkdir, rm, writeFile, readFile, readdir, access } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { sampleMaterial, sampleMarkdown, samplePdfHtml } from "./fixtures.mjs";
import { FAKE_SILICONFLOW_KEY, fakeSiliconflow, longM4a, toneWav } from "./audio-fixtures.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/* ---------- steps ---------- */

export const JOURNEY_STEPS = [
  { name: "empty-home", run: async (j) => {
    await j.nav("library");
    await j.shot();
  } },
  { name: "add-material", run: async (j) => {
    await j.openAddSource();
    await j.shot("dialog");
    // The add-material dialog (ImportHub) opens on files; pasting is its second tab.
    await j.clickIfPresent(j.dialog().getByRole("button", { name: j.t("粘贴文本"), exact: true }));
    const material = sampleMaterial(j.lang);
    await j.dialog().getByLabel(j.t("资料名称")).first().fill(material.title);
    await j.dialog().getByLabel(j.t("原文")).first().fill(material.text);
    await j.shot("filled");
    await j.dialog().getByRole("button", { name: j.t("保存资料") }).click();
    await j.until(async () => (await j.snapshot()).sources.some((source) => source.title === material.title), "the pasted source is saved");
    await j.settle();
    await j.shot("saved");
  } },
  { name: "import-files", run: async (j) => {
    await j.openAddSource();
    // One drop zone takes several files at once; the dialog closes when all are in.
    const files = [j.fixtures.markdown, j.fixtures.pdf];
    const input = j.dialog().locator('[data-tour="import-drop"] input[type="file"], input[type="file"][accept*=".pdf"]').first();
    await input.setInputFiles(files);
    const stems = files.map((file) => basename(file).replace(/\.[^.]+$/, ""));
    await j.until(async () => {
      const sources = (await j.snapshot()).sources;
      return stems.every((stem) => sources.some((source) => source.title.includes(stem)));
    }, `${files.map((file) => basename(file)).join(" and ")} are imported`);
    await j.until(async () => !(await j.page.locator("dialog[open]").count()), "the dialog closes after the import");
    await j.settle();
    await j.shot("imported");
  } },
  { name: "sources", needs: ["material"], run: async (j) => {
    await j.nav("sources");
    // Show the newest group's rows (groups start collapsed).
    if (!await j.clickIfPresent(j.page.getByRole("button", { name: j.t("全部展开") })))
      await j.clickIfPresent(j.page.locator('.source-group-head[aria-expanded="false"]'));
    await j.settle();
    await j.shot();
    await j.shot("full", { fullPage: true });
  } },
  { name: "generate", needs: ["material"], run: async (j) => {
    await j.nav("generate");
    await j.clickIfPresent(j.anchor("generate-from-sources").or(j.page.getByRole("tab", { name: j.t("从资料补题") })));
    await j.clickIfPresent(j.page.getByRole("button", { name: j.t("选择当前范围") }));
    await j.page.getByRole("button", { name: j.t("单选测验"), exact: true }).click();
    await j.page.getByLabel(j.t("题数")).fill("4");
    await j.page.getByLabel(j.t("题组名称（可选）")).fill(j.lang === "en" ? "QA journey deck" : "QA 旅程题组");
    await j.shot("form", { fullPage: true });
    const before = (await j.snapshot()).jobs.length;
    await j.anchor("generate-submit").or(j.page.getByRole("button", { name: new RegExp(`^(${escapeRe(j.t("生成并检查题组 →"))}|${escapeRe(j.t("加入生成队列 →"))})`) })).first().click();
    await j.until(async () => (await j.snapshot()).jobs.length > before, "a generation job starts");
    j.state.jobId = (await j.snapshot()).jobs.at(-1).id;
  } },
  { name: "job-progress", needs: ["job"], run: async (j) => {
    const job = j.page.locator(".generation-jobs .job").first();
    await job.waitFor({ timeout: 15000 });
    await j.settle(200);
    await job.scrollIntoViewIfNeeded();
    await j.shot("running");
    const done = await j.api("job.wait", { jobId: j.state.jobId, timeoutSeconds: 60 });
    if (done.status !== "complete") throw new Error(`generation ended as ${done.status}: ${done.stage}`);
    j.state.draftId = done.draft?.id;
    // WP4: the finished job card at the top of the home offers 打开草稿.
    await j.page.locator(".generation-jobs .job").getByRole("button", { name: j.t("打开草稿"), exact: true }).first().waitFor({ timeout: 15000 });
    await j.page.locator(".generation-jobs .job").first().scrollIntoViewIfNeeded();
    await j.settle();
    await j.shot("done");
  } },
  { name: "draft", needs: ["draft"], run: async (j) => {
    const open = j.page.locator(".draft-row .draft-open").first();
    if (!await open.count()) await j.nav("library");
    await j.page.locator(".draft-row .draft-open").first().click();
    await j.page.getByRole("button", { name: j.t("保存并发布 →") }).first().waitFor({ timeout: 15000 });
    await j.settle();
    await j.shot();
    await j.shot("full", { fullPage: true });
  } },
  { name: "publish", needs: ["draft"], run: async (j) => {
    if (!await j.page.getByRole("button", { name: j.t("保存并发布 →") }).count()) {
      await j.nav("library");
      await j.page.locator(".draft-row .draft-open").first().click();
    }
    const before = (await j.snapshot()).decks.length;
    await j.page.getByRole("button", { name: j.t("保存并发布 →") }).first().click();
    await j.until(async () => (await j.snapshot()).decks.length > before, "the deck is published");
    await j.settle(1500);
    await j.shot();
  } },
  { name: "practice", needs: ["deck"], run: async (j) => {
    if (!await j.page.locator(".options .option").count()) {
      await j.page.getByRole("button", { name: j.t("回到题目") }).first().click();
      await j.page.locator(".options .option").first().waitFor({ timeout: 15000 });
    }
    // The first answer is wrong (it feeds the mistakes page), the second right.
    for (const [index, wantCorrect] of [[1, false], [2, true]]) {
      const run = (await j.snapshot()).runs.at(-1);
      const { card } = await j.api("review.get", { runId: run.id });
      const live = (await j.api("deck.get", { id: card.deckId || run.deckId })).cards.find((item) => item.id === card.id);
      const option = live.options.find((item) => item.correct === wantCorrect) || live.options[0];
      await j.page.locator(".options .option", { hasText: option.text }).first().click();
      const submit = j.page.getByRole("button", { name: j.t("提交答案") });
      if (await submit.count() && await submit.first().isEnabled()) await submit.first().click();
      await j.page.locator(".options .option.correct").first().waitFor({ timeout: 15000 });
      await j.settle();
      await j.shot(`answer-${index}`);
      if (index < 2) {
        await j.page.getByRole("button", { name: new RegExp(escapeRe(j.t("下一题"))) }).first().click();
        await j.page.locator(".options .option:not([disabled])").first().waitFor({ timeout: 15000 });
      }
    }
  } },
  { name: "wrongbook", needs: ["answers"], run: async (j) => {
    await j.nav("wrongbook");
    await j.settle();
    await j.shot();
  } },
  { name: "settings", run: async (j) => {
    await j.nav("settings");
    await j.settle();
    await j.shot();
    await j.shot("full", { fullPage: true });
  } },
  // Audio (WP6): with no key the audio tab is a setup card, never a drop zone; then a SiliconFlow key (answered
  // locally) lets a recording through pre-flight and transcription, and a 76-minute M4A offers a lossless split.
  { name: "audio-gate", run: async (j) => {
    await j.nav("audio");
    await j.page.getByText(j.t("转写服务还没配置 · 约 2 分钟")).first().waitFor({ timeout: 15000 });
    if (await j.page.locator(".audio-drop-zone").count()) throw new Error("the audio drop zone is offered before a provider is configured");
    await j.settle();
    await j.shot();
    await j.shot("full", { fullPage: true });
  } },
  { name: "audio-settings", run: async (j) => {
    await j.nav("settings");
    const section = j.anchor("settings-audio");
    await section.waitFor({ timeout: 15000 });
    await section.scrollIntoViewIfNeeded();
    await j.settle();
    await j.shot();
  } },
  { name: "audio-import", needs: ["siliconflow"], run: async (j) => {
    await j.nav("audio");
    const input = j.page.locator('.audio-drop-zone input[type="file"]');
    await input.waitFor({ state: "attached", timeout: 15000 });
    await input.setInputFiles(j.fixtures.wav);
    await j.page.locator(".audio-check--ok").first().waitFor({ timeout: 30000 });
    await j.settle();
    await j.shot("checked");
    const done = () => j.snapshot().then((snapshot) => snapshot.jobs.filter((job) => job.type === "audio-import" && job.status === "complete").length);
    const before = await done();
    await j.page.getByRole("button", { name: j.t("开始导入"), exact: true }).click();
    await j.until(async () => (await done()) > before, "the recording is transcribed and saved", 120000);
    await j.settle(1500);
    await j.page.locator(".audio-jobs .job").first().scrollIntoViewIfNeeded();
    await j.shot("done");
  } },
  { name: "audio-long", needs: ["siliconflow"], run: async (j) => {
    await j.nav("audio");
    const input = j.page.locator('.audio-drop-zone input[type="file"]');
    await input.waitFor({ state: "attached", timeout: 15000 });
    await input.setInputFiles(j.fixtures.longM4a);
    await j.page.locator(".audio-check--split").first().waitFor({ timeout: 30000 });
    await j.settle();
    await j.page.locator(".audio-check--split").first().scrollIntoViewIfNeeded();
    await j.shot("split");
    const finished = () => j.snapshot().then((snapshot) => snapshot.jobs.filter((job) => job.type === "audio-import" && job.status === "complete"));
    const before = (await finished()).length;
    await j.page.getByRole("button", { name: j.t("分段并继续") }).first().click();
    await j.until(async () => (await finished()).length > before, "the long recording is transcribed in parts", 180000);
    const job = (await finished()).find((item) => /76|long/i.test(item.filename) || item.usage?.siliconflow?.requests === 2);
    if (job?.usage?.siliconflow?.requests !== 2) throw new Error(`expected 2 SiliconFlow requests for the 76-minute recording, got ${job?.usage?.siliconflow?.requests}`);
    await j.settle(1500);
    await j.shot("done");
  } },
  { name: "live-gate", run: async (j) => {
    await j.nav("live");
    await j.page.getByText(j.t("课堂实录需要 Gemini 密钥")).first().waitFor({ timeout: 15000 });
    await j.settle();
    await j.shot();
  } },
  // Course records (WP13): the course switcher opens the course panel; an exam profile saved there
  // shows its countdown in the library heading, and Settings lists every course.
  { name: "course-panel", needs: ["deck"], run: async (j) => {
    const name = j.lang === "en" ? "Software Architecture" : "软件架构";
    const deck = (await j.snapshot()).decks.find((item) => !item.systemKind);
    if (deck.course !== name) {
      await j.api("deck.course", { id: deck.id, course: name });
      await j.api("focus.set", { course: name });
      // A second course, so the panel offers a merge.
      await j.api("source.add", { title: j.lang === "en" ? "Database reading" : "数据库阅读材料", text: sampleMaterial(j.lang).text,
        courses: [j.lang === "en" ? "Database Systems" : "数据库系统"] });
      await j.reload();
    }
    await j.nav("library");
    await j.page.locator(".course-heading select").selectOption("@course-settings");
    await j.dialog().waitFor({ timeout: 10000 });
    await j.settle();
    await j.shot("panel");
    await j.dialog().getByRole("button", { name: j.t("开卷案例"), exact: true }).click();
    await j.dialog().getByLabel(j.t("总分"), { exact: true }).fill("40");
    const date = new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10);
    await j.dialog().getByLabel(j.t("考试日期")).fill(date);
    await j.dialog().getByRole("button", { name: j.t("添加考试部分") }).click();
    await j.dialog().getByLabel(j.t("标题"), { exact: true }).first().fill(j.lang === "en" ? "Part A · Architecture styles" : "第一部分 · 架构风格");
    await j.dialog().getByLabel(j.t("分值"), { exact: true }).first().fill("20");
    await j.dialog().getByLabel(j.t("考查知识点")).first().fill(j.lang === "en" ? "Microservices; Strangler fig" : "微服务；绞杀者模式");
    await j.shot("filled", { fullPage: true });
    await j.dialog().locator(".course-settings__disclosure summary").last().click();
    await j.dialog().locator(".course-settings__merge input[type=checkbox]").first().check();
    await j.dialog().getByRole("button", { name: j.t("合并所选课程") }).click();
    await j.dialog().getByRole("button", { name: j.t("确认合并") }).scrollIntoViewIfNeeded();
    await j.settle();
    await j.shot("merge-confirm");
    await j.dialog().getByRole("button", { name: j.t("取消"), exact: true }).first().click();
    await j.dialog().getByRole("button", { name: j.t("保存课程信息") }).click();
    await j.until(async () => (await j.snapshot()).courses?.some((course) => course.name === name && course.exam?.date === date), "the exam profile is saved");
    await j.until(async () => !(await j.page.locator("dialog[open]").count()), "the panel closes after saving");
    await j.page.locator(".course-heading-exam").first().waitFor({ timeout: 15000 });
    await j.settle();
    await j.shot("heading");
    // Course pickers list existing courses first.
    await j.openAddSource();
    await j.dialog().locator(".course-field__picks").first().waitFor({ timeout: 10000 });
    await j.settle();
    await j.shot("import-course-picks");
    await j.page.keyboard.press("Escape");
    await j.until(async () => !(await j.page.locator("dialog[open]").count()), "the add-material dialog closes");
    await j.nav("settings");
    await j.page.locator(".course-list").scrollIntoViewIfNeeded();
    await j.settle();
    await j.shot("settings");
  } },
];

/* The onboarding set (WP5), run with `--steps tour`: the welcome page of an
   empty library, one click to load the sample course and start the feature
   tour, a screenshot of every tour step, then the home banner, the settings
   section and removing the sample again. */
export const TOUR_STEPS = [
  { name: "tour-welcome", run: async (j) => {
    await j.nav("library");
    await j.page.locator(".welcome").waitFor({ timeout: 15000 });
    await j.settle();
    await j.shot();
  } },
  { name: "tour-walk", run: async (j) => {
    await j.page.getByRole("button", { name: j.t("载入示例并开始导览") }).click();
    for (let guard = 0; guard < 40; guard++) {
      const card = j.page.locator(".tour-layer:not(.is-measuring) .tour-pop");
      await card.waitFor({ timeout: 30000 });
      await j.settle(900);
      const [at] = (await j.page.locator(".tour-pop__count").first().textContent()).split("/").map((part) => part.trim());
      await j.shot(`step-${at.padStart(2, "0")}`);
      const finish = j.page.getByRole("button", { name: j.t("完成导览"), exact: true });
      if (await finish.count()) {
        await finish.click();
        break;
      }
      await j.page.locator(".tour-pop").getByRole("button", { name: j.t("下一步"), exact: true }).click();
      await j.until(async () => (await j.page.locator(".tour-pop__count").first().textContent().catch(() => "")).split("/")[0].trim() !== at,
        `the tour leaves step ${at}`);
    }
    await j.page.locator(".tour-layer").waitFor({ state: "detached", timeout: 15000 });
  } },
  { name: "tour-after", run: async (j) => {
    await j.nav("library");
    await j.page.locator(".sample-banner").waitFor({ timeout: 15000 });
    await j.settle();
    await j.shot("home-banner");
    await j.nav("settings");
    await j.anchor("settings-sample").scrollIntoViewIfNeeded();
    await j.settle();
    await j.shot("settings");
    await j.anchor("settings-sample").getByRole("button", { name: j.t("移除示例数据") }).click();
    await j.dialog().waitFor({ timeout: 10000 });
    await j.settle(400);
    await j.shot("remove-confirm");
    await j.dialog().getByRole("button", { name: j.t("移除示例数据") }).click();
    await j.until(async () => !(await j.snapshot()).sample?.loaded, "the sample is removed");
    await j.nav("library");
    await j.settle();
    await j.shot("removed");
  } },
];

/* Case practice (WP12), run with `--steps case`: write a case paper from the
   materials, check its draft, publish, answer one question with a highlight and
   grade it, sit the timed case paper (reading → writing → report) and turn the
   weak criteria into drills. */
export const CASE_STEPS = [
  { name: "case-create", needs: ["material"], run: async (j) => {
    await j.nav("generate");
    await j.anchor("generate-case").first().click();
    await j.settle();
    const form = j.anchor("case-create");
    await form.getByRole("button", { name: j.t("选择当前范围") }).first().click();
    await form.getByLabel(j.t("题组名称（可选）")).fill(j.lang === "en" ? "QA case paper" : "QA 案例分析卷");
    await form.getByLabel(j.t("语言")).selectOption(j.lang === "en" ? "English" : "中文");
    await j.shot("form", { fullPage: true });
    const before = (await j.snapshot()).jobs.length;
    await j.anchor("generate-submit").first().click();
    await j.until(async () => (await j.snapshot()).jobs.length > before, "a case generation job starts");
    j.state.caseJobId = (await j.snapshot()).jobs.at(-1).id;
    await j.page.locator(".generation-jobs .job").first().waitFor({ timeout: 15000 });
    await j.settle(300);
    await j.shot("running");
    const done = await j.api("job.wait", { jobId: j.state.caseJobId, timeoutSeconds: 60 });
    if (done.status !== "complete") throw new Error(`case generation ended as ${done.status}: ${done.stage}`);
    j.state.caseDraftId = done.draftId;
    await j.settle(1200);
    await j.shot("done");
  } },
  { name: "case-draft", needs: ["caseDraft"], run: async (j) => {
    await j.nav("library");
    await j.page.locator(".draft-row .draft-open").first().click();
    await j.page.locator(".case-draft").waitFor({ timeout: 15000 });
    await j.settle();
    await j.shot();
    await j.shot("full", { fullPage: true });
  } },
  { name: "case-practice", needs: ["caseDraft"], run: async (j) => {
    if (!await j.page.getByRole("button", { name: j.t("保存并发布 →") }).count()) {
      await j.nav("library");
      await j.page.locator(".draft-row .draft-open").first().click();
    }
    await j.page.getByRole("button", { name: j.t("保存并发布 →") }).first().click();
    await j.page.locator(".rubric-answer textarea").first().waitFor({ timeout: 20000 });
    // Highlight the cue sentence of paragraph 4 with the highlighter (select, mouse up).
    const paragraph = j.page.locator(".case-review-scenario .case-para__text").nth(3);
    await paragraph.click({ clickCount: 3 });
    await j.settle(300);
    const answer = j.lang === "en"
      ? "I recommend an event-driven architecture, migrated step by step with the strangler fig pattern.\nThe failed logins and altered release notes in the case call for an audit trail and monitoring of every document change.\nThe case does not give a budget, so I assume a small first phase; therefore I would not rewrite everything at once.\nI would also use serverless functions everywhere."
      : "我建议采用事件驱动架构，并用绞杀者模式逐步迁移。\n案例里的失败登录和被改动的放行单，说明需要审计追踪和对每次单证改动的监控。\n案例没有给出预算，所以我假设第一阶段规模较小，因此不会一次性全部重写。\n我还会把所有功能都改成无服务器函数。";
    await j.page.locator(".rubric-answer textarea").first().fill(answer);
    await j.settle();
    await j.shot("answer");
    await j.page.getByRole("button", { name: j.t("提交批改") }).first().click();
    await j.page.locator(".rubric-result").first().waitFor({ timeout: 45000 });
    await j.settle(800);
    await j.page.locator(".rubric-result").first().scrollIntoViewIfNeeded();
    await j.shot("graded");
    await j.shot("graded-full", { fullPage: true });
  } },
  { name: "case-paper", needs: ["caseDeck"], run: async (j) => {
    await j.nav("exam");
    await j.anchor("exam-case").first().getByRole("button", { name: j.t("案例分析卷") }).click();
    await j.page.getByRole("button", { name: j.t("开始考试") }).waitFor({ timeout: 15000 });
    await j.page.getByLabel(j.t("阅读时间（分钟）")).fill("2");
    await j.settle();
    await j.shot("setup");
    await j.page.getByRole("button", { name: j.t("开始考试") }).click();
    await j.page.locator(".case-paper__bar").waitFor({ timeout: 15000 });
    if (await j.page.locator(".case-paper__switch").isVisible()) await j.page.locator(".case-paper__switch").getByRole("button", { name: j.t("案例") }).click();
    await j.page.locator(".case-paper .case-para__text").nth(5).click({ clickCount: 3 });
    await j.page.locator(".case-paper .case-swatch.hl-green").first().click();
    await j.settle();
    await j.shot("reading");
    await j.page.getByRole("button", { name: j.t("提前开始作答") }).click();
    if (await j.page.locator(".case-paper__switch").isVisible()) await j.page.locator(".case-paper__switch").getByRole("button", { name: j.t("题目") }).click();
    const boxes = j.page.locator(".case-paper .case-question textarea");
    await boxes.first().fill(j.lang === "en" ? "Apply cloud persistence per workload: a relational store for bookings and billing.\nThe harvest peak in the case calls for elastic capacity.\nThe case does not say how long records are kept, so I assume seven years." : "按工作负载选择持久化：订舱和计费用关系数据库。\n案例中的收获季高峰说明需要弹性容量。\n案例没有说明记录保存多久，所以我假设七年。");
    await j.settle(1500);
    await j.shot("writing");
    await j.page.getByRole("button", { name: j.t("交卷批改") }).click();
    await j.page.locator("dialog[open]").waitFor({ timeout: 10000 });
    await j.settle(300);
    await j.shot("blank-warning");
    await j.page.locator("dialog[open]").getByRole("button", { name: j.t("仍然交卷") }).click();
    await j.page.locator(".case-report").waitFor({ timeout: 30000 });
    await j.until(async () => !(await j.page.locator(".case-report__pending").count()), "every answered question is graded", 60000);
    await j.settle(800);
    await j.shot("report");
    await j.shot("report-full", { fullPage: true });
  } },
  { name: "case-drills", needs: ["caseDeck"], run: async (j) => {
    const button = j.page.getByRole("button", { name: j.t("把薄弱项变成练习") });
    if (!await button.count()) throw new Error("run case-paper first: the report offers the drills");
    const before = (await j.snapshot()).jobs.length;
    await button.first().click();
    await j.until(async () => (await j.snapshot()).jobs.length > before, "a drills job starts");
    await j.settle(600);
    await j.shot("started");
    const job = (await j.snapshot()).jobs.at(-1);
    const done = await j.api("job.wait", { jobId: job.id, timeoutSeconds: 60 });
    if (done.status !== "complete") throw new Error(`drills ended as ${done.status}: ${done.stage}`);
    await j.nav("library");
    await j.settle(800);
    await j.anchor("home-catalog").scrollIntoViewIfNeeded();
    await j.shot("library");
    await j.nav("wrongbook");
    await j.settle();
    await j.shot("wrongbook");
  } },
];

/* ---------- state a step can require, created through the API ---------- */

const SEED = {
  async material(j) {
    if ((await j.snapshot()).sources.length) return;
    await j.api("source.add", sampleMaterial(j.lang));
  },
  async job(j) {
    if (j.state.jobId) return;
    await SEED.material(j);
    const sourceIds = (await j.snapshot()).sources.map((source) => source.id);
    j.state.jobId = (await j.api("generate", { sourceIds, count: 4, kind: "quiz", title: "QA seed", language: j.lang === "en" ? "English" : "中文" })).jobId;
    await j.nav("library");
  },
  async draft(j) {
    if ((await j.snapshot()).drafts.length) return;
    await SEED.job(j);
    await j.api("job.wait", { jobId: j.state.jobId, timeoutSeconds: 60 });
    await j.reload();
  },
  async deck(j) {
    if ((await j.snapshot()).decks.some((deck) => !deck.systemKind)) return;
    await SEED.draft(j);
    const draft = (await j.snapshot()).drafts[0];
    await j.api("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
    await j.reload();
  },
  async answers(j) {
    if ((await j.snapshot()).attempts.length) return;
    await SEED.deck(j);
    const deck = (await j.snapshot()).decks.find((item) => !item.systemKind);
    const run = await j.api("review.start", { deckId: deck.id, mode: "quiz" });
    const live = (await j.api("deck.get", { id: deck.id })).cards.find((item) => item.id === run.card.id);
    const wrong = live.options?.find((option) => !option.correct);
    await j.api("review.answer", { runId: run.id, cardId: run.card.id, ...(wrong ? { selected: [wrong.id] } : { grade: 1 }) });
    await j.reload();
  },
  async caseDraft(j) {
    if ((await j.snapshot()).drafts.some((draft) => draft.format === "case-study")) return;
    await SEED.material(j);
    const sourceIds = (await j.snapshot()).sources.map((source) => source.id);
    const started = await j.api("generate", { kind: "case", sourceIds, questions: 2, totalMarks: 20, title: j.lang === "en" ? "QA case paper" : "QA 案例分析卷",
      language: j.lang === "en" ? "English" : "中文" });
    await j.api("job.wait", { jobId: started.jobId, timeoutSeconds: 60 });
    await j.reload();
  },
  async caseDeck(j) {
    if ((await j.snapshot()).decks.some((deck) => deck.format === "case-study")) return;
    await SEED.caseDraft(j);
    const draft = (await j.snapshot()).drafts.find((item) => item.format === "case-study");
    await j.api("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
    await j.reload();
  },
  /** A SiliconFlow key, with SiliconFlow answered in this process (the preview shares it). */
  async siliconflow(j) {
    if (!j.state.restoreFetch) { j.state.restoreFetch = fakeSiliconflow(j.lang); j.cleanups.push(j.state.restoreFetch); }
    if ((await j.api("audio.settings.get")).siliconflowKey?.set) return;
    await j.api("audio.settings.set", { siliconflowKey: FAKE_SILICONFLOW_KEY });
    await j.reload();
  },
};

/* ---------- options ---------- */

export function parseJourneyArgs(argv = []) {
  const names = JOURNEY_STEPS.map((step) => step.name), tour = TOUR_STEPS.map((step) => step.name), cases = CASE_STEPS.map((step) => step.name);
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) throw new Error(`Unexpected argument ${argv[i]}`);
    const [, key, inline] = match;
    if (key === "keep") { values.keep = true; continue; }
    values[key] = inline ?? argv[++i];
  }
  const lang = values.lang ?? "zh", theme = values.theme ?? "dark", width = Number(values.width ?? 1440);
  if (!["zh", "en"].includes(lang)) throw new Error("--lang must be zh or en");
  if (!["dark", "light"].includes(theme)) throw new Error("--theme must be dark or light");
  if (!Number.isInteger(width) || width < 320 || width > 3840) throw new Error("--width must be a pixel width such as 1440 or 420");
  // `tour` expands to the onboarding set; its steps can also be named one by one.
  const steps = values.steps ? values.steps.split(",").map((name) => name.trim()).filter(Boolean)
    .flatMap((name) => name === "tour" ? tour : name === "case" ? cases : [name]) : names;
  for (const name of steps) if (!names.includes(name) && !tour.includes(name) && !cases.includes(name))
    throw new Error(`Unknown step "${name}". Steps: ${names.join(", ")}; onboarding: tour (${tour.join(", ")}); case practice: case (${cases.join(", ")})`);
  const port = Number(values.port ?? 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a port number (0 picks a free one)");
  return { lang, theme, width, height: Number(values.height ?? 900), steps,
    out: values.out ? resolve(values.out) : resolve(repoRoot, `output/qa/journey/${lang}-${theme}-${width}`), keep: !!values.keep, port };
}

/** English UI strings, keyed by their Chinese source (ui/locales/en.json and en.*.json fragments). */
async function englishStrings() {
  const dir = resolve(repoRoot, "ui/locales");
  const files = (await readdir(dir)).filter((name) => /^en(\..+)?\.json$/.test(name)).sort();
  return Object.assign({}, ...await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8")))));
}

async function writeFixtures(browser, lang, dir) {
  await mkdir(dir, { recursive: true });
  const markdown = sampleMarkdown(lang);
  const files = { markdown: join(dir, markdown.name), pdf: join(dir, lang === "en" ? "qa-database-indexes.pdf" : "qa-数据库索引.pdf"),
    wav: join(dir, lang === "en" ? "lecture-indexes.wav" : "数据库索引-第3讲.wav"), longM4a: join(dir, lang === "en" ? "PE1-long-lecture.m4a" : "PE1-长录音.m4a") };
  await writeFile(files.markdown, markdown.text, "utf8");
  await writeFile(files.wav, toneWav(20));
  await writeFile(files.longM4a, longM4a(76));
  const page = await browser.newPage();
  await page.setContent(samplePdfHtml(lang), { waitUntil: "load" });
  await page.pdf({ path: files.pdf, format: "A5", printBackground: true });
  await page.close();
  return files;
}

/* ---------- runner ---------- */

export async function runJourney(options) {
  const removed = scrubProcessEnv();
  await access(resolve(repoRoot, "dist/app.js")).catch(() => { throw new Error("dist/app.js is missing: run `npm run build` first"); });
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  const english = options.lang === "en" ? await englishStrings() : {};
  const server = await createPreviewServer({ libraryRoot: join(options.out, "work", "library"), home: join(options.out, "work", "home"),
    port: options.port ?? 0, model: createFakeModel({ latencyMs: 250, generationLatencyMs: 2500 }) });
  // Native controls (file pickers) follow the browser's own language, not the page's.
  const browser = await launchChromium({ args: [`--lang=${options.lang === "en" ? "en-US" : "zh-CN"}`] });
  const summary = { startedAt: new Date().toISOString(), options: { ...options }, url: server.url, scrubbedEnv: removed,
    steps: [], consoleErrors: [], pageErrors: [], apiErrors: [] };
  const cleanups = [];
  try {
    const fixtures = await writeFixtures(browser, options.lang, join(repoRoot, "output/qa/fixtures", options.lang));
    const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1,
      locale: options.lang === "en" ? "en-US" : "zh-CN", colorScheme: options.theme });
    await context.addInitScript(([lang, theme]) => {
      try { localStorage.setItem("study-ui-language", lang); localStorage.setItem("study-theme", theme); } catch { /* storage blocked */ }
    }, [options.lang, options.theme]);
    const page = await context.newPage();
    let current = "boot";
    page.on("console", (message) => { if (message.type() === "error") summary.consoleErrors.push({ step: current, text: message.text() }); });
    page.on("pageerror", (error) => summary.pageErrors.push({ step: current, text: String(error?.stack || error) }));
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/call") || response.ok()) return;
      let action = "";
      try { action = JSON.parse(response.request().postData() || "{}").action; } catch { /* not JSON */ }
      const body = await response.json().catch(() => ({}));
      summary.apiErrors.push({ step: current, action, status: response.status(), error: body.error || "" });
    });
    const j = journeyContext({ page, server, options, english, fixtures, step: () => current });
    j.cleanups = cleanups;
    await page.goto(server.url);
    await j.ready();
    for (const step of [...JOURNEY_STEPS, ...TOUR_STEPS, ...CASE_STEPS].filter((item) => options.steps.includes(item.name))) {
      current = step.name;
      const started = Date.now(), record = { name: step.name, status: "ok", shots: [] };
      j.record = record;
      try {
        for (const need of step.needs || []) await SEED[need](j);
        await step.run(j);
      } catch (error) {
        record.status = "failed";
        record.error = String(error?.message || error).split("\n")[0];
        await j.shot("failed").catch(() => {});
      }
      record.ms = Date.now() - started;
      summary.steps.push(record);
      console.log(`${record.status === "ok" ? "ok  " : "FAIL"} ${step.name}${record.error ? ` — ${record.error}` : ""}`);
    }
    if (options.keep) {
      console.log(`Preview kept running at ${server.url} (library ${server.libraryRoot}); press Ctrl+C to stop.`);
      await new Promise((done) => process.once("SIGINT", done));
    }
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.ok = !summary.pageErrors.length && summary.steps.every((step) => step.status === "ok");
    for (const cleanup of cleanups.reverse()) { try { cleanup(); } catch { /* best effort */ } }
    await writeFile(join(options.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    await browser.close().catch(() => {});
    await server.close();
  }
  return summary;
}

function journeyContext({ page, server, options, english, fixtures, step }) {
  const index = () => String([...JOURNEY_STEPS, ...TOUR_STEPS, ...CASE_STEPS].findIndex((item) => item.name === step()) + 1).padStart(2, "0");
  const t = (zh) => options.lang === "en" && Object.hasOwn(english, zh) ? english[zh] : zh;
  const NAV = { library: "学习库", sources: "资料", generate: "创建题组", wrongbook: "错题与待巩固", exam: "模拟考试",
    dashboard: "统计", skeleton: "知识骨架", workflows: "学习流", settings: "设置", audio: "音频转录", live: "课堂实录" };
  const j = {
    page, server, fixtures, lang: options.lang, state: {}, record: null, t,
    api: (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: options.lang }),
    snapshot: () => previewCall(server, "snapshot", { uiLanguage: options.lang }),
    anchor: (id) => page.locator(`[data-tour="${id}"]`),
    dialog: () => page.locator("dialog[open], [role=dialog], .modal").last(),
    async ready() {
      await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
      await j.settle(800);
    },
    async reload() { await page.reload(); await j.ready(); },
    /** Let requests, renders and page transitions finish before a screenshot. */
    async settle(ms = 600) {
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" ||
        animation.effect?.getTiming?.().iterations === Infinity), null, { timeout: 4000 }).catch(() => {});
      await sleep(ms);
    },
    async until(check, label, timeout = 30000) {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (await check()) return;
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await sleep(250);
      }
    },
    async clickIfPresent(locator) {
      if (await locator.count() && await locator.first().isVisible()) { await locator.first().click(); await j.settle(300); return true; }
      return false;
    },
    async nav(id) {
      const anchor = j.anchor(`nav-${id}`);
      if (await anchor.count()) await anchor.first().click();
      else if (id === "settings") await page.getByRole("button", { name: t(NAV.settings), exact: true }).first().click();
      else await page.locator("nav").getByRole("button", { name: new RegExp(`^\\s*${escapeRe(t(NAV[id]))}`) }).first().click();
      await j.settle();
    },
    async openAddSource() {
      await j.nav("sources");
      const add = j.anchor("sources-add").or(page.getByRole("button", { name: t("＋ 添加资料") }));
      if (await add.count() && await add.first().isVisible()) await add.first().click();
      await j.settle(400);
    },
    async closeDialog() {
      if (!await page.locator("dialog[open], [role=dialog], .modal").count()) return;
      await page.keyboard.press("Escape");
      await sleep(300);
      await j.clickIfPresent(page.getByRole("button", { name: t("关闭"), exact: true }));
    },
    /** Viewport screenshot; fullPage grows the viewport to the scrolling panel's full length first. */
    async shot(suffix = "", { fullPage = false } = {}) {
      const name = `${index()}-${step()}${suffix ? `-${suffix}` : ""}.png`;
      const viewport = page.viewportSize();
      if (fullPage) {
        // The app scrolls inside a 100%-high panel, so Playwright's fullPage sees one screen.
        const height = await page.evaluate(() => {
          let tallest = document.documentElement.scrollHeight;
          for (const element of document.querySelectorAll("main, main *, .study-app, [class*=scroll]")) {
            const overflow = getComputedStyle(element).overflowY;
            if (/auto|scroll/.test(overflow) && element.scrollHeight > element.clientHeight + 4 && element.clientHeight > innerHeight / 2)
              tallest = Math.max(tallest, element.scrollHeight + innerHeight - element.clientHeight);
          }
          return tallest;
        });
        await page.setViewportSize({ width: viewport.width, height: Math.min(Math.max(height, viewport.height), 9000) });
        await j.settle(400);
      }
      try { await page.screenshot({ path: join(options.out, name) }); }
      finally { if (fullPage) { await page.setViewportSize(viewport); await sleep(200); } }
      j.record?.shots.push(name);
      return name;
    },
  };
  return j;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseJourneyArgs(process.argv.slice(2));
    const summary = await runJourney(options);
    console.log(`${summary.ok ? "Journey passed" : "Journey FAILED"}: ${options.out} (page errors ${summary.pageErrors.length}, console errors ${summary.consoleErrors.length}, API errors ${summary.apiErrors.length})`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 2;
  }
}
