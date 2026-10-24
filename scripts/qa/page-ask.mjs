/* node scripts/qa/page-ask.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]   (build dist/ first: node scripts/build.mjs)
   Asking about a page in the 原始 PDF view (issue #456), with a generated PDF and the fake model only: a passage selected in 阅读 is shown in
   the learning panel; in 原始 PDF that old selection is gone and the panel names the page instead; previous / next and a typed page number
   move both the panel and the frame (#page=); a typed question is answered from that page; a page without saved text says so. The PDF
   frame itself is drawn by the browser's own PDF viewer, which a headless Chromium may leave blank: the screenshots show our controls
   and the panel, not necessarily the page image. */
/* global document, getSelection, NodeFilter, MouseEvent -- page.evaluate callbacks run in the browser */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStudyRuntime } from "../../lib/runtime/builtins.js";
import { Store } from "../../lib/store.js";
import { makeTextPdf } from "../../tests/helpers/text-pdf.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const PAGE_LINES = (page) => Array.from({ length: 10 }, (_, line) => `Page ${page} line ${line + 1} explains part ${page} of the scheduling lecture in plain words.`);
export const PAGES = [1, 2, 3, 4].map(PAGE_LINES);

async function seed(root) {
  const runtime = createStudyRuntime(root);
  const pdf = await runtime.call("materials.document.import", { filename: "scheduling.pdf", dataBase64: (await makeTextPdf(PAGES)).toString("base64"), courses: ["QA"] });
  runtime.dispose();
  // Page 4 as a scanned page would be: no saved text (the panel must say so instead of asking).
  await new Store(root).update((state) => { state.sources.find((source) => source.id === pdf.sourceIds[3]).text = ""; });
}

/** Select `words` in the reading view's own text, as a drag would, and tell the reader. */
const selectWords = (page, words) => page.evaluate((phrase) => {
  const body = document.querySelector(".study-document-body"), walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.data.indexOf(phrase);
    if (at < 0) continue;
    const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + phrase.length);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    return true;
  }
  return false;
}, words);

export async function runPageAskQa(options) {
  return runQa({ name: "page-ask", options, seed, async run({ page, t, step, check }) {
    const viewer = page.locator(".study-document-viewer"), tools = viewer.locator(".reader-tools"), bar = viewer.locator(".reader-pdf-bar");
    const scopeLine = tools.locator(".study-page-ask__scope"), narrow = options.width < 900;
    const openTools = async () => { if (await tools.isHidden()) await viewer.getByRole("button", { name: t("学习工具", "Study tools") }).first().click(); await tools.waitFor(); };
    const frameAt = async () => viewer.locator(".reader-original iframe").getAttribute("src");
    const expectPage = async (number) => {
      await page.waitForFunction(([want, zh]) => (document.querySelector(".study-page-ask__scope")?.textContent || "").includes(zh ? `第 ${want} 页` : `page ${want}`), [number, options.lang === "zh"], { timeout: 10000 });
      const src = await frameAt();
      if (!src?.endsWith(`#page=${number}`)) throw new Error(`the frame is not at page ${number}: ${src}`);
      return { scope: await scopeLine.innerText(), frame: src.replace(/^blob:[^#]*/, "blob:…") };
    };

    await page.locator('[data-tour="nav-sources"]').first().click().catch(() => page.getByRole("button", { name: t("资料", "Sources") }).first().click());
    await sleep(800);
    await page.getByRole("button", { name: /^(全部展开|Expand all)$/ }).click().catch(() => {});
    await page.locator(".source-doc", { hasText: "scheduling" }).locator(".source-main").click();
    await viewer.waitFor(); await sleep(900);

    await step("read-view-selection", async () => {
      if (!await selectWords(page, "Page 2 line 3 explains part 2")) throw new Error("the words to select are not in the reading view");
      await openTools();
      await tools.locator(".study-passage__quote").waitFor({ timeout: 10000 });
      return { quote: await tools.locator(".study-passage__quote").innerText() };
    });
    await step("pdf-view-asks-about-page-1", async () => {
      await viewer.locator(".study-document-preview-mode").getByRole("button", { name: t("原始 PDF", "Original PDF"), exact: true }).click();
      await bar.waitFor();
      await openTools();
      const at = await expectPage(1);
      if (await tools.locator(".study-passage__quote").count()) throw new Error("the old selection is still shown");
      if (await tools.getByRole("button", { name: t("使用当前选区", "Use current selection") }).count()) throw new Error("使用当前选区 is offered in the PDF view");
      return at;
    });
    await step("next-next-is-page-3", async () => {
      await page.evaluate(() => { document.querySelector(".reader-original iframe").dataset.qaOld = "1"; });
      // Narrow: the panel slides over the page controls, so the page is turned from the panel's own buttons.
      const stepper = narrow ? tools.locator(".study-page-ask__step") : bar;
      await stepper.getByRole("button", { name: t("下一页", "Next page") }).click();
      await stepper.getByRole("button", { name: t("下一页", "Next page") }).click();
      const at = await expectPage(3);
      // The PDF viewer ignores a changed #page= on the same frame: a new frame is what makes the shown page follow.
      if (await page.evaluate(() => document.querySelector(".reader-original iframe").dataset.qaOld)) throw new Error("the same frame was kept, so the PDF viewer stays on the old page");
      await sleep(1200);
      return at;
    });
    await step("typed-page-2", async () => {
      if (narrow) await viewer.locator(".reader-scrim").click({ position: { x: 12, y: 40 } }); // close the panel to reach the page number
      const input = bar.getByRole("spinbutton", { name: t("页码", "Page number") });
      await input.fill("2"); await input.press("Enter");
      await openTools();
      const at = await expectPage(2);
      await sleep(1200);
      return at;
    });
    await step("ask-about-page-2", async () => {
      await tools.locator("textarea").first().fill(t("这一页讲了哪些部分？", "Which parts does this page cover?"));
      await tools.getByRole("button", { name: t("依据这一页回答", "Answer from this page") }).click();
      const answer = tools.locator("[data-ask-node]").first();
      await answer.waitFor({ timeout: 15000 });
      await page.waitForFunction(() => /Page 2 line 1/.test(document.querySelector(".reader-tools [data-ask-node]")?.textContent || ""), null, { timeout: 15000 });
      return { answer: (await answer.innerText()).slice(0, 160) };
    });
    await step("page-4-without-text", async () => {
      if (narrow) await viewer.locator(".reader-scrim").click({ position: { x: 12, y: 40 } });
      const input = bar.getByRole("spinbutton", { name: t("页码", "Page number") });
      await input.fill("4"); await input.press("Enter");
      await openTools();
      await expectPage(4);
      const text = await tools.innerText();
      if (!(options.lang === "zh" ? /第 4 页没有保存的文字/ : /Page 4 has no saved text/).test(text)) throw new Error(`no empty-page message: ${text.slice(0, 200)}`);
      if (await tools.locator("textarea").count()) throw new Error("a question box for a page without text");
    });
    await check("no-horizontal-overflow", async () => {
      const probe = await page.evaluate(overflowProbe);
      if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`horizontal overflow ${JSON.stringify(probe)}`);
      return probe;
    });
    await step("back-to-read-keeps-reading", async () => {
      await viewer.locator(".study-document-preview-mode").getByRole("button", { name: t("阅读", "Read"), exact: true }).click();
      await viewer.locator(".reader-pdf-bar").waitFor({ state: "detached" });
      if (await tools.locator(".study-page-ask").count()) throw new Error("the page panel stayed in 阅读");
    });
  } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseQaArgs(process.argv.slice(2), "page-ask");
    finishCli("Page ask", options, await runPageAskQa(options));
  } catch (error) { console.error(error?.message || error); process.exitCode = 2; }
}
