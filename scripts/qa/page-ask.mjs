/* node scripts/qa/page-ask.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]   (build dist/ first: node scripts/build.mjs)
   Asking about a page in the 原始 PDF view (issue #456), with a generated PDF and the fake model only (answers take 1.5 s, so a view switch
   can land while one is on its way). The reader is in 批注 mode. Journey: a passage selected in 阅读 is shown in the learning panel; a 没听懂
   asked there and followed at once by a switch to 原始 PDF is still answered and kept as an annotation; in 原始 PDF the old selection is not
   shown and the panel names the page; Escape in the page box does not close the reader; 「问这一页」 opens a closed panel; previous / next
   and a typed page number move both the panel and the frame (#page=, a new frame per page); a typed question is answered from that page; a
   page without saved text says so; back in 阅读 the selection and its answers are still there; a kept annotation opened from the links panel
   in 原始 PDF goes back to 阅读; a page question refused by the server (the document changed) keeps the page wording on 重试. The PDF itself
   is drawn by the browser's own viewer (it does draw in Chromium here); the screenshots show it with our controls and the panel. */
/* global navigator, document, getSelection, NodeFilter, MouseEvent -- page.evaluate callbacks run in the browser */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStudyRuntime } from "../../lib/runtime/builtins.js";
import { Store } from "../../lib/store.js";
import { previewCall } from "../preview-server.mjs";
import { makeTextPdf } from "../../tests/helpers/text-pdf.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";
import { pickNth } from "./pick.mjs";

const PAGE_LINES = (page, word = "explains") => Array.from({ length: 10 }, (_, line) => `Page ${page} line ${line + 1} ${word} part ${page} of the scheduling lecture in plain words.`);
export const PAGES = [1, 2, 3, 4].map((page) => PAGE_LINES(page));
const SEEDED = {};

async function seed(root) {
  const runtime = createStudyRuntime(root);
  const pdf = await runtime.call("materials.document.import", { filename: "scheduling.pdf", dataBase64: (await makeTextPdf(PAGES)).toString("base64"), courses: ["QA"] });
  runtime.dispose();
  SEEDED.documentId = pdf.documentId;
  // Page 4 as a scanned page would be: no saved text (the panel must say so instead of asking). A deck to add questions to (补题).
  await new Store(root).update((state) => {
    state.sources.find((source) => source.id === pdf.sourceIds[3]).text = "";
    state.decks.push({ id: "qa-deck", title: "QA deck", course: "QA", contentVersion: 1, cards: [] });
  });
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
  return runQa({ name: "page-ask", options, seed, latencyMs: 1500, localStorageSeed: { "study-reader-annotation": JSON.stringify({ mode: "annotate" }) },
    async run({ page, browserContext, server, t, step, check }) {
    const viewer = page.locator(".study-document-viewer"), tools = viewer.locator(".reader-tools"), bar = viewer.locator(".reader-pdf-bar");
    const reading = tools.locator('.reader-learning[data-scope="selection"]'), paging = tools.locator('.reader-learning[data-scope="page"]');
    const scopeLine = tools.locator(".study-page-ask__scope"), narrow = options.width < 900;
    const mode = (zh, en) => viewer.locator(".study-document-preview-mode").getByRole("button", { name: t(zh, en), exact: true });
    const openTools = async () => { if (await tools.isHidden()) await viewer.getByRole("button", { name: t("学习工具", "Study tools") }).first().click(); await tools.waitFor(); };
    const closeOverlay = async () => { if (narrow && await viewer.locator(".reader-scrim").count()) await viewer.locator(".reader-scrim").click({ position: { x: 12, y: 40 } }); };
    const pageBox = () => bar.getByRole("spinbutton", { name: t("页码", "Page number") });
    const typePage = async (number) => { await closeOverlay(); await pageBox().fill(String(number)); await pageBox().press("Enter"); await openTools(); };
    const kept = async () => (await previewCall(server, "materials.annotation.list", { documentId: SEEDED.documentId })).items?.length || 0;
    const frameAt = async () => viewer.locator(".reader-original iframe").getAttribute("src");
    const expectPage = async (number) => {
      await page.waitForFunction(([want, zh]) => (document.querySelector(".study-page-ask__scope")?.textContent || "").includes(zh ? `第 ${want} 页` : `page ${want}`), [number, options.lang === "zh"], { timeout: 10000 });
      const src = await frameAt();
      if (!src?.endsWith(`#page=${number}`)) throw new Error(`the frame is not at page ${number}: ${src}`);
      return { scope: await scopeLine.innerText(), frame: src.replace(/^blob:[^#]*/, "blob:…") };
    };

    // The preview has no main chat: 发给主会话 copies the message to the clipboard (the shared unit's fill / keep of DSH's input box is
    // tests/hand-off-browser.test.mjs). The clipboard is what is read back here.
    await browserContext.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.url });
    const copied = async (before) => { await page.waitForFunction((old) => navigator.clipboard.readText().then((text) => text && text !== old), before, { timeout: 10000 });
      return page.evaluate(() => navigator.clipboard.readText()); };
    const clearClipboard = () => page.evaluate(() => navigator.clipboard.writeText(""));
    await page.locator('[data-tour="nav-sources"]').first().click().catch(() => page.getByRole("button", { name: t("资料", "Sources") }).first().click());
    await sleep(800);
    await page.getByRole("button", { name: /^(全部展开|Expand all)$/ }).click().catch(() => {});
    await page.locator(".source-doc", { hasText: "scheduling" }).locator(".source-main").click();
    await viewer.waitFor(); await sleep(900);

    await step("read-view-selection", async () => {
      if (!await selectWords(page, "Page 2 line 3 explains part 2")) throw new Error("the words to select are not in the reading view");
      await openTools();
      await reading.locator(".study-passage__quote").waitFor({ timeout: 10000 });
      return { quote: await reading.locator(".study-passage__quote").innerText() };
    });
    await step("annotated-answer-survives-a-switch-to-pdf", async () => {
      const before = await kept();
      await reading.getByRole("button", { name: t("没听懂", "I did not get it"), exact: true }).click();
      await mode("原始 PDF", "Original PDF").click(); // while the answer is on its way (1.5 s)
      await bar.waitFor();
      const deadline = Date.now() + 20000;
      let after = before;
      while (Date.now() < deadline && (after = await kept()) <= before) await sleep(400);
      if (after !== before + 1) throw new Error(`the answer asked before the switch was not kept as an annotation: ${before} -> ${after}`);
      return { before, after };
    });
    await step("pdf-view-asks-about-page-1", async () => {
      await openTools();
      const at = await expectPage(1);
      if (await tools.locator(".study-passage__quote:visible").count()) throw new Error("the old selection is shown in the PDF view");
      if (await tools.getByRole("button", { name: t("使用当前选区", "Use current selection") }).count()) throw new Error("使用当前选区 is offered in the PDF view");
      if (await tools.getByRole("button", { name: t("围绕这段出案例题", "Write a case around this passage") }).count()) throw new Error("the case button is offered in the PDF view");
      return at;
    });
    await check("escape-in-page-box-keeps-the-reader", async () => {
      await closeOverlay();
      await pageBox().fill("3");
      await pageBox().press("Escape");
      await sleep(300);
      if (!await viewer.isVisible()) throw new Error("Escape in the page box closed the reader");
      const value = await pageBox().inputValue();
      if (value !== "1") throw new Error(`Escape did not put the current page back: ${value}`);
      await openTools();
      return { value };
    });
    if (!narrow) await check("ask-this-page-link-opens-the-panel", async () => {
      await viewer.getByRole("button", { name: t("学习工具", "Study tools") }).first().click();
      await tools.waitFor({ state: "hidden" });
      const link = viewer.locator(".reader-pdf-note").getByRole("button", { name: t("问这一页", "Ask about this page") });
      await link.click();
      await tools.waitFor();
      if (await link.count()) throw new Error("the link stays while the panel is open");
    });
    await step("next-next-is-page-3", async () => {
      await page.evaluate(() => { document.querySelector(".reader-original iframe").dataset.qaOld = "1"; });
      // Narrow: the panel slides over the page controls, so the page is turned from the panel's own buttons.
      const stepper = narrow ? paging.locator(".study-page-ask__step") : bar;
      await stepper.getByRole("button", { name: t("下一页", "Next page") }).click();
      await stepper.getByRole("button", { name: t("下一页", "Next page") }).click();
      const at = await expectPage(3);
      // The PDF viewer ignores a changed #page= on the same frame: a new frame is what makes the shown page follow.
      if (await page.evaluate(() => document.querySelector(".reader-original iframe").dataset.qaOld)) throw new Error("the same frame was kept, so the PDF viewer stays on the old page");
      await sleep(1200);
      return at;
    });
    await step("typed-page-2", async () => {
      await typePage(2);
      const at = await expectPage(2);
      await sleep(1200);
      return at;
    });
    await step("ask-about-page-2", async () => {
      await paging.locator("textarea").first().fill(t("这一页讲了哪些部分？", "Which parts does this page cover?"));
      await paging.getByRole("button", { name: t("依据这一页回答", "Answer from this page") }).click();
      await page.waitForFunction(() => /Page 2 line 1/.test(document.querySelector('.reader-learning[data-scope="page"] [data-ask-node]')?.textContent || ""), null, { timeout: 15000 });
      return { answer: (await paging.locator("[data-ask-node]").first().innerText()).slice(0, 160) };
    });
    await step("page-chip-asks-at-once", async () => {
      const before = await paging.locator("[data-ask-node]").count();
      await paging.getByRole("button", { name: t("翻译这一页", "Translate this page"), exact: true }).click();
      await page.waitForFunction((count) => { const nodes = document.querySelectorAll('.reader-learning[data-scope="page"] [data-ask-node]');
        return nodes.length > count && nodes[nodes.length - 1].dataset.status === "answered"; }, before, { timeout: 15000 });
      const answer = await paging.locator("[data-ask-node]").last().innerText();
      if (!answer.includes(t("翻译这一页", "Translate this page"))) throw new Error(`the chip's name is not the thread's heading: ${answer.slice(0, 120)}`);
      if (!/Page 2 line 1/.test(answer)) throw new Error(`the answer does not quote the page: ${answer.slice(0, 160)}`);
      return { answer: answer.slice(0, 160) };
    });
    await step("page-hand-off-carries-the-page", async () => {
      await paging.locator("textarea").first().fill(t("图 2 说明了什么？", "What does figure 2 show?"));
      await clearClipboard();
      await paging.locator('[data-hand-off="reader.page"]').click();
      const message = await copied("");
      for (const part of [t("第 2 页", "page 2"), "Page 2 line 1", t("图 2 说明了什么？", "What does figure 2 show?"), t("这一页的截图（粘贴在这里）：", "Screenshot of the page (paste it here):")])
        if (!message.includes(part)) throw new Error(`the message lacks ${part}: ${message.slice(0, 200)}`);
      await page.getByText(t("已复制到剪贴板", "Copied to the clipboard")).first().waitFor({ timeout: 5000 });
      return { first: message.split("\n")[0], last: message.split("\n").at(-1) };
    });
    await step("page-4-without-text", async () => {
      await typePage(4);
      await expectPage(4);
      const text = await paging.innerText();
      if (!(options.lang === "zh" ? /第 4 页没有保存的文字/ : /Page 4 has no saved text/).test(text)) throw new Error(`no empty-page message: ${text.slice(0, 200)}`);
      if (await paging.locator("textarea").count()) throw new Error("a question box for a page without text");
      // A page that is only a picture: 发给主会话 is the way forward there (the screenshot is pasted into the chat).
      const forward = paging.locator('.study-page-ask__forward [data-hand-off="reader.page"]');
      if (!await forward.isVisible()) throw new Error("no way forward on a page without text");
      await clearClipboard();
      await forward.click();
      const message = await copied("");
      if (!message.includes(t("没有保存的文字", "no saved text"))) throw new Error(`the message does not say the page has no text: ${message.slice(0, 200)}`);
    });
    await check("no-horizontal-overflow", async () => {
      const probe = await page.evaluate(overflowProbe);
      if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`horizontal overflow ${JSON.stringify(probe)}`);
      return probe;
    });
    await step("back-to-read-keeps-the-selection-and-its-answers", async () => {
      await closeOverlay();
      await mode("阅读", "Read").click();
      await viewer.locator(".reader-pdf-bar").waitFor({ state: "detached" });
      await openTools();
      if (await paging.isVisible()) throw new Error("the page panel stayed in 阅读");
      const quote = await reading.locator(".study-passage__quote").innerText();
      if (!quote.includes("Page 2 line 3")) throw new Error(`the selected passage is gone: ${quote}`);
      const answers = await reading.locator('[data-ask-node][data-status="answered"]').count();
      if (answers < 1) throw new Error("the answered thread of the passage is gone");
      return { quote, answers };
    });
    await step("supplement-job-card-stays-visible-in-pdf", async () => {
      // A 补题 job started from the passage in 阅读 is still on screen (progress, 停止) after switching to 原始 PDF to look at the page.
      await pickNth(page, reading.locator('[role="combobox"]').first(), 0);
      await reading.getByRole("button", { name: t("生成、审核并补充题目", "Generate, review and add questions") }).click();
      await reading.locator(".selection-job").first().waitFor({ timeout: 10000 });
      await closeOverlay();
      await mode("原始 PDF", "Original PDF").click();
      await bar.waitFor();
      await openTools();
      const card = tools.locator(".selection-job").first();
      const state = () => page.evaluate(() => ({ view: document.querySelector(".study-document-viewer")?.dataset.mode,
        panels: [...document.querySelectorAll(".reader-tools .reader-learning")].map((node) => `${node.dataset.scope}:${node.hidden ? "hidden" : "shown"}:${node.querySelectorAll(".selection-job").length}`).join(" "),
        jobs: [...document.querySelectorAll(".reader-tools .selection-job")].map((node) => node.dataset.phase).join(",") }));
      try { await card.waitFor({ state: "visible", timeout: 8000 }); } catch { throw new Error(`no visible job card in 原始 PDF: ${JSON.stringify(await state())}`); }
      const phase = (await state()).jobs;
      if (await tools.locator(".study-passage__quote:visible").count()) throw new Error("the old selection is shown with the job card");
      const order = await page.evaluate(() => { const job = document.querySelector(".reader-tools .selection-job"), scope = document.querySelector(".reader-tools .study-page-ask__scope");
        return job && scope ? !!(job.compareDocumentPosition(scope) & 4) : null; });
      if (!order) throw new Error("the job card is not above the page panel");
      return { phase };
    });
    await step("kept-annotation-opened-from-pdf-goes-to-read", async () => {
      await closeOverlay();
      await mode("原始 PDF", "Original PDF").click();
      await bar.waitFor();
      await openTools();
      // The kept passage is folded in the links list (with the questions the 补题 job added, when it is done): unfold them all.
      const folded = tools.locator(".reader-link-group:not([open]) > summary");
      for (let guard = 0; guard < 6 && await folded.count(); guard += 1) await folded.first().evaluate((node) => node.click()); // a toast may sit over the bottom of a narrow panel
      const open = tools.getByRole("button", { name: t("打开问答", "Open the thread") }).first();
      await open.scrollIntoViewIfNeeded();
      await open.evaluate((node) => node.click());
      await viewer.locator(".reader-pdf-bar").waitFor({ state: "detached", timeout: 10000 });
      await reading.locator(".study-passage__quote").waitFor();
    });
    await step("refused-page-ask-keeps-the-page-on-retry", async () => {
      await closeOverlay();
      await mode("原始 PDF", "Original PDF").click();
      await bar.waitFor();
      await typePage(2);
      await expectPage(2);
      // The document gets a new revision behind the open reader: the page question is refused as stale.
      await previewCall(server, "materials.document.attach", { documentId: SEEDED.documentId, filename: "scheduling.pdf",
        dataBase64: (await makeTextPdf([1, 2, 3, 4].map((n) => PAGE_LINES(n, "describes")))).toString("base64") });
      await paging.locator("textarea").first().fill(t("这一页讲了什么？", "What is on this page?"));
      await paging.getByRole("button", { name: t("依据这一页回答", "Answer from this page") }).click();
      const failed = paging.locator('[data-ask-node][data-status="failed"]').first();
      await failed.waitFor({ timeout: 15000 });
      const pageWords = t("资料已更新，请重新打开这份资料再问这一页", "Open it again to ask about this page"), passageWords = t("这段引用", "this citation");
      const first = await failed.innerText();
      if (!first.includes(pageWords)) throw new Error(`not the page wording: ${first}`);
      await failed.getByRole("button", { name: t("重试", "Retry") }).click();
      await sleep(400);
      await page.waitForFunction(() => [...document.querySelectorAll('.reader-learning[data-scope="page"] [data-ask-node]')].at(-1)?.dataset.status === "failed", null, { timeout: 15000 });
      const second = await paging.locator("[data-ask-node]").last().innerText();
      if (!second.includes(pageWords) || second.includes(passageWords)) throw new Error(`重试 left the page: ${second}`);
      return { first: first.slice(0, 80), second: second.slice(0, 80) };
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
