/* node scripts/qa/generation-path.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]   (build first: node scripts/build.mjs)
   分步生成路径 on the 创建题组 page: a book too big for one generation is cut into steps; the AI can refine them; "只用这一步" selects one step's pages;
   "按路径逐步出题" queues one generation job per step in order; "和 AI 聊聊怎么学" hands the plan to the conversation. Seeded temporary library with a
   720,000-character converted book, fake model, no network. */
/* global window, document */
import { StudyService } from "../../lib/service.js";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const PAGES = 60;
const book = () => Array.from({ length: PAGES }, (_, i) => `<!-- page: ${i + 1} -->\n${i % 12 === 0 ? `# 第 ${i / 12 + 1} 章 章节标题 ${i / 12 + 1}\n` : ""}${`第 ${i + 1} 页讲的是进程、线程和内存管理的一个方面。`.repeat(300)}`).join("\n\n");

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
        const texts = await page.locator(".gen-path__title small").allInnerTexts();
        const pages = texts.map((value) => Number(/(\d+)\s*(页|pages)/.exec(value)?.[1] || 0)).reduce((sum, value) => sum + value, 0);
        if (pages !== PAGES) throw new Error(`the steps cover ${pages} pages, not ${PAGES}`);
        const probe = await page.evaluate(overflowProbe);
        if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`horizontal overflow ${JSON.stringify(probe)}`);
      });
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
        await page.locator(".gen-path__step").nth(1).getByRole("button", { name: t("只用这一步", "Use only this step"), exact: true }).click();
        await sleep(400);
        const selected = await page.locator(".source-picker__partial, .source-picker__item.is-selected").first().innerText().catch(() => "");
        return selected.slice(0, 80);
      });
      await step("queue-the-path", async () => {
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
