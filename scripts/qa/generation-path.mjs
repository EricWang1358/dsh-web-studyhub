/* node scripts/qa/generation-path.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]   (build first: node scripts/build.mjs)
   One block for a selection too big for one generation: the choice of how to go on (steps / pages by topic), the steps with the optional ones folded, ONE submit button
   ("按路径逐步出题 · N 步依次排队") and no coverage strength in step mode; with a (mocked) search tool the other mode shows the topic panel and the ordinary form.
   分步生成路径 on the 创建题组 page: a book too big for one generation is cut into steps; the AI can refine them; "只出这一步" selects one step's pages;
   "按路径逐步出题" queues one generation job per step in order; "和 AI 聊聊怎么学" hands the plan to the conversation. Seeded temporary library with a
   720,000-character converted book, fake model, no network. */
/* global window, document */
import { StudyService } from "../../lib/service.js";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const PAGES = 60;
const book = () => Array.from({ length: PAGES }, (_, i) => `<!-- page: ${i + 1} -->\n${i % 12 === 0 ? `# 第 ${i / 12 + 1} 章 章节标题 ${i / 12 + 1}\n` : i === 54 ? "# 索引\n" : ""}${`第 ${i + 1} 页讲的是进程、线程和内存管理的一个方面。`.repeat(500)}`).join("\n\n");

const api = (page, action, args = {}) => page.evaluate(async ([name, body]) => {
  const response = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json", "x-study-token": window.STUDY_TOKEN }, body: JSON.stringify({ action: name, args: body }) });
  const json = await response.json();
  if (!json.ok) throw new Error(json.error || name);
  return json.value;
}, [action, args]);

export async function runPathQa(options) {
  return runQa({
    name: "generation-path", options,
    async seed(root) {
      const service = new StudyService(root);
      await service.call("materials.document.import", { dataBase64: Buffer.from(book(), "utf8").toString("base64"), filename: "os-book.md", courses: ["操作系统"] });
    },
    async run({ page, t, step, check }) {
      const nav = (id) => page.locator(`[data-nav-id="${id}"]`).first().click();
      await step("open-generate-and-select-the-book", async () => {
        await nav("generate");
        await page.locator(".source-picker__item").first().waitFor({ timeout: 20000 });
        const box = page.locator(".source-picker__item input[type=checkbox]").first();
        if (!(await box.isChecked())) await box.check();
        await page.locator(".gen-path").waitFor({ timeout: 15000 });
        const steps = await page.locator(".gen-path__step").count();
        if (steps < 3) throw new Error(`expected a plan of several steps, got ${steps}`);
        return { steps };
      });
      await check("plan-covers-every-page-once-and-no-overflow", async () => {
        // The optional steps are one folded line: open it to read them too.
        await page.locator(".gen-path__optional > summary").click();
        const texts = await page.locator(".gen-path__title small").allInnerTexts();
        const pages = texts.map((value) => Number(/(\d+)\s*(页|pages)/.exec(value)?.[1] || 0)).reduce((sum, value) => sum + value, 0);
        if (pages !== PAGES) throw new Error(`the steps cover ${pages} pages, not ${PAGES}`);
        const probe = await page.evaluate(overflowProbe);
        if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`horizontal overflow ${JSON.stringify(probe)}`);
      });
      await step("back-matter-is-an-optional-step", async () => {
        // The index at the end of the book is a step of its own: labelled in words, off by default, and the checkbox includes it.
        const optional = page.locator(".gen-path__step[data-optional='true']");
        if ((await optional.count()) !== 1) throw new Error(`expected one optional step, found ${await optional.count()}`);
        const label = await optional.first().innerText();
        if (!label.includes(t("可选 · 默认跳过", "Optional · skipped by default"))) throw new Error("the optional step does not say so in words");
        if (await optional.first().locator("input[type=checkbox]").isChecked()) throw new Error("the optional step is on by default");
        await optional.first().scrollIntoViewIfNeeded();
        return label.split("\n").slice(0, 3).join(" | ");
      });
      await check("one-block-one-button-no-coverage-strength", async () => {
        const block = await page.locator(".too-big").count();
        const queue = await page.locator("[data-usage='generate.path-queue']").count();
        const primary = await page.locator("form .sh-btn--primary:visible").count();
        const strength = await page.locator(".generate-row__label", { hasText: t("覆盖强度", "Coverage strength") }).count();
        if (block !== 1 || queue !== 1 || primary !== 1 || strength !== 0) throw new Error(`block ${block}, queue buttons ${queue}, visible primary ${primary}, coverage rows ${strength}`);
        return { summary: (await page.locator(".generate-summary").innerText()).trim() };
      });
      await step("path-mode-submit-area", async () => { await page.locator("[data-usage='generate.path-queue']").scrollIntoViewIfNeeded(); });
      await step("ai-refine", async () => {
        await page.getByRole("button", { name: t("让 AI 优化路径", "Let the AI refine the path"), exact: true }).click();
        // The fake model may answer with something usable or not: either way the plan stays valid and says what happened.
        await page.waitForFunction(() => !document.querySelector(".gen-path__actions .sh-spinner, .gen-path__actions [aria-busy='true']"), null, { timeout: 60000 });
        await sleep(300);
        const steps = await page.locator(".gen-path__step").count();
        if (steps < 3) throw new Error("the plan lost steps after the refinement");
        return { steps, note: (await page.locator(".gen-path").innerText()).includes(t("AI 给了每一步", "The AI named each step")) ? "applied" : "kept" };
      });
      await step("use-only-one-step", async () => {
        await page.locator(".gen-path__step").nth(1).getByRole("button", { name: t("只出这一步", "Only this step"), exact: true }).click();
        await sleep(400);
        const selected = await page.locator(".source-picker__partial, .source-picker__item.is-selected").first().innerText().catch(() => "");
        return selected.slice(0, 80);
      });
      await step("retrieval-mode-with-a-search-tool", async () => {
        // A search tool that is ready (mocked answer of retrieval.status): the choice appears, the topic panel replaces the steps and the ordinary form comes back.
        await page.route("**/api/call", async (route) => {
          const body = route.request().postDataJSON?.() || {};
          if (body.action !== "retrieval.status") return route.fallback();
          const value = { selected: "mcp:mcp__rag__q", effective: "mcp:mcp__rag__q", hostCanSearch: true, otherTools: [], providers: [{ id: "mcp:mcp__rag__q", kind: "mcp", label: "query_documents", server: "rag", tool: "mcp__rag__q" }] };
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, value }) });
        });
        await page.reload();
        await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
        await nav("generate");
        await page.locator(".too-big").waitFor({ timeout: 15000 });
        const modes = await page.locator(".too-big .sh-seg__item").allInnerTexts();
        if (modes.length !== 2) throw new Error(`expected two ways on, got ${JSON.stringify(modes)}`);
        await page.locator(".too-big .sh-seg__item", { hasText: t("按主题挑页面", "Pick pages by topic") }).click();
        await page.locator(".retrieval-panel").waitFor();
        if (await page.locator(".gen-path__steps").count()) throw new Error("the steps are still drawn in the topic mode");
        const asks = await page.getByText(t("先在「这次想练什么？」写下主题", "Write a topic under")).count();
        if (asks !== 1) throw new Error(`the topic is asked for ${asks} times`);
        if (!(await page.locator("[data-usage='generate.submit']").isDisabled())) throw new Error("the ordinary button should be off until a topic is written");
        return { modes };
      });
      await step("queue-the-path", async () => {
        await page.locator(".too-big .sh-seg__item", { hasText: t("分步出题", "Step by step") }).click().catch(() => {});
        // Back to the whole book, then queue every step.
        await page.locator(".source-picker__item input[type=checkbox]").first().check().catch(() => {});
        await page.locator(".gen-path").waitFor();
        await page.getByRole("button", { name: new RegExp(t("按路径逐步出题", "Generate step by step")) }).click();
        await page.waitForFunction(() => !!document.querySelector("[data-nav-id='library'][aria-current], .page"), null, { timeout: 30000 });
        await sleep(1500);
        const jobs = await api(page, "snapshot", {}).then((snapshot) => (snapshot.jobs || []).length);
        if (jobs < 3) throw new Error(`expected several queued jobs, found ${jobs}`);
        return { jobs };
      });
    },
  });
}

if (process.argv[1]?.endsWith("generation-path.mjs")) {
  const options = parseQaArgs(process.argv.slice(2), "generation-path");
  finishCli("Generation path", options, await runPathQa(options));
}
