/* node scripts/qa/assist-failure.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]   (build first: node scripts/build.mjs)
   The 帮我想想 button on the 创建题组 page when the model's answer cannot be used (the fake model answers "{}" to a prompt it does not know):
   the line says why, the answer can be looked at, the local suggestions stay (labelled), and 再试一次 asks again. Seeded temporary library, fake model, no network. */
import { StudyService } from "../../lib/service.js";
import { finishCli, overflowProbe, parseQaArgs, runQa } from "./harness.mjs";

export async function runAssistFailureQa(options) {
  return runQa({
    name: "assist-failure", options,
    async seed(root) {
      const service = new StudyService(root);
      await service.call("source.add", { title: "Operating systems notes", courses: ["OS"],
        text: "# Processes and threads\nA process owns an address space.\n## Scheduling policies\nRound robin and priority scheduling.\n## Virtual memory\nPaging and page replacement." });
    },
    async run({ page, t, step, check, sleep }) {
      await step("open-generate-and-select-the-notes", async () => {
        await page.locator(`[data-nav-id="generate"]`).first().click();
        await page.locator(".source-picker__item").first().waitFor({ timeout: 20000 });
        const box = page.locator(".source-picker__item input[type=checkbox]").first();
        if (!(await box.isChecked())) await box.check();
        await page.locator("[data-generate-assist]").waitFor({ timeout: 15000 });
      });
      await step("ask-the-assist", async () => {
        await page.locator("[data-generate-assist]").click();
        await page.locator("[data-ai-helper-note]").waitFor({ timeout: 30000 });
        const note = await page.locator("[data-ai-helper-note]").getAttribute("data-ai-helper-note");
        if (note !== "nothing-usable") throw new Error(`expected the wrong-format line, got ${note}`);
        await page.locator(".generate-assist").scrollIntoViewIfNeeded();
      });
      await step("look-at-the-answer", async () => {
        await page.locator(".ai-helper-note__sample summary").click();
        const sample = await page.locator(".ai-helper-note__sample pre").innerText();
        if (!sample.includes("{}")) throw new Error(`the answer is not shown: ${sample}`);
      });
      await check("local-suggestions-stay-and-no-overflow", async () => {
        const chips = await page.locator(".generate-suggestion").count();
        if (!chips) throw new Error("the local suggestions are gone");
        if (!(await page.locator(".generate-assist__label").innerText()).trim()) throw new Error("the local label is missing");
        const probe = await page.evaluate(overflowProbe);
        if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`horizontal overflow ${JSON.stringify(probe)}`);
      });
      await step("try-again", async () => {
        await page.getByRole("button", { name: t("再试一次", "Try again"), exact: true }).click();
        await page.locator("[data-ai-helper-note]").waitFor({ timeout: 30000 });
        await sleep(300);
      });
    },
  });
}

if (process.argv[1]?.endsWith("assist-failure.mjs")) {
  const options = parseQaArgs(process.argv.slice(2), "assist-failure");
  finishCli("Assist failure", options, await runAssistFailureQa(options));
}
