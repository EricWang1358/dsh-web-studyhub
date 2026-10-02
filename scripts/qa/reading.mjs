/* node scripts/qa/reading.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]   (build dist/ first: node -e "import('./scripts/build.mjs').then(m=>m.buildPreview())")
   学习内容的阅读设置 in the browser preview: a review page whose explanation ("理解这道题"), a table, the citations and a Q&A are
   long-form reading. The Aa button in the review toolbar changes the explanation text, the table, the Q&A and (shared setting) the
   source reader's text, and NOT a single button; another open page follows through the storage event; 恢复默认 resets all; no
   horizontal overflow and the popover stays on screen. Seeded temporary library, fake model, no network. */
/* global document, window, getComputedStyle, localStorage -- page.evaluate callbacks run in the browser */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StudyService } from "../../lib/service.js";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const SOURCE = { id: "qa-reading-notes", title: "Operating systems notes", courses: ["QA"],
  text: "A process is the unit of resource allocation in an operating system, and a thread is the unit of scheduling inside a process. Virtual memory gives every process its own address space, which the memory manager maps onto physical frames on demand. Page replacement decides which resident page leaves memory when a new page must be brought in." };
const QUOTE = "A process is the unit of resource allocation in an operating system";
const EXPLANATION = `A **process** owns resources (an address space, open files); a **thread** only owns what it needs to run. Because threads of one process share the address space, switching between them is cheaper than switching between processes.

| Unit | Owns resources | Scheduled by the kernel |
| --- | --- | --- |
| Process | yes | yes |
| Thread | no, it shares them | yes |

- Creating a thread is cheaper than creating a process.
- A crash in one thread can take the whole process down, because the memory is shared.

Remember it as: resources belong to the process, running belongs to the thread.`;

async function seed(root) {
  const service = new StudyService(root);
  await service.call("source.add", SOURCE);
  const card = id => ({ id, kind: "flashcard", topic: "Processes", objective: "Tell a process from a thread", prompt: `What does a process own that a thread does not? (${id})`,
    answer: "The resources: the address space and open files.", hint: "Think about what is shared.", explanation: EXPLANATION,
    misconception: "Believing a thread is just a smaller process with its own memory.", citations: [{ sourceId: SOURCE.id, quote: QUOTE }] });
  await service.call("draft.save", { deck: { id: "qa-reading", title: "Processes and threads", cards: [card("c1"), card("c2")] } });
  await service.call("draft.publish", { id: "qa-reading" });
  await service.call("card.followup.add", { deckId: "qa-reading", cardId: "c1", question: "Why is a thread switch cheaper?",
    answer: "Because the threads of one process share the same address space, the kernel does not have to switch page tables or flush the TLB, so the switch only saves and restores registers and the stack pointer." });
}

const api = (page, action, args = {}) => page.evaluate(async ([name, body]) => {
  const response = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json", "x-study-token": window.STUDY_TOKEN }, body: JSON.stringify({ action: name, args: body }) });
  const json = await response.json();
  if (!json.ok) throw new Error(json.error || name);
  return json.value;
}, [action, args]);

export async function runReadingQa(options) {
  return runQa({ name: "reading", options, seed, localStorageSeed: { "study-reader-settings": null }, async run({ page, browserContext, t, step, check }) {
    const size = selector => page.locator(selector).first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
    const family = selector => page.locator(selector).first().evaluate(element => getComputedStyle(element).fontFamily);
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("study-reader-settings") || "null"));
    const popover = page.locator(".question-tools .reader-popover");
    const openPopover = async () => { if (!(await popover.locator(".reader-popover__panel").count())) await popover.getByRole("button", { name: t("显示设置", "Display settings") }).click(); await popover.locator(".reader-popover__panel").waitFor(); };
    const panelButton = name => popover.locator(".reader-popover__panel").getByRole("button", { name, exact: true });

    // A run with its explanation showing: start, reveal and answer through the host, then resume it from the side navigation.
    const run = await api(page, "review.start", { deckId: "qa-reading", mode: "flashcard" });
    await api(page, "review.reveal", { runId: run.id, cardId: run.card.id }).catch(() => {});
    await api(page, "review.answer", { runId: run.id, cardId: run.card.id, grade: 1 }).catch(() => {});
    await page.reload();
    await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await sleep(800);
    await page.getByRole("button", { name: new RegExp(`${t("回到题目", "Return to question")}`) }).first().click();
    await page.locator(".explanation").first().waitFor({ timeout: 20000 });
    await sleep(500);

    await step("review-explanation-default", async () => { await page.locator(".explanation").first().scrollIntoViewIfNeeded(); });
    const before = {};
    await check("default-sizes", async () => {
      before.p = await size(".explanation.study-reading .md p");
      before.td = await size(".explanation.study-reading td");
      before.button = await size(".question-toolbar .tool-action");
      before.followup = await size(".explanation-followup .md p, .explanation-followup .md");
      before.face = await size(".question-card .flash-prompt, .question-card .question, .question-card .md");
      if (before.p !== 16 || before.td !== 16) throw new Error(`defaults are not the reader's: ${JSON.stringify(before)}`);
      return before;
    });
    await step("popover-open", async () => {
      await popover.scrollIntoViewIfNeeded();
      await openPopover();
      if (await popover.locator(".reader-setting--inline").count()) throw new Error("the underline row is shown outside the reader");
      const box = await popover.locator(".reader-popover__panel").boundingBox(), view = page.viewportSize();
      if (!box || box.x < 0 || box.x + box.width > view.width + 0.5) throw new Error(`popover off screen ${JSON.stringify(box)}`);
    });
    await step("size-up", async () => {
      for (let i = 0; i < 3; i += 1) await panelButton(t("增大字号", "Larger text")).click();
      await sleep(200);
      const after = { p: await size(".explanation.study-reading .md p"), td: await size(".explanation.study-reading td"), button: await size(".question-toolbar .tool-action"),
        followup: await size(".explanation-followup .md p, .explanation-followup .md"), li: await size(".explanation.study-reading li") };
      if (after.p !== 20 || after.td !== 20 || after.li !== 20) throw new Error(`explanation did not follow: ${JSON.stringify(after)}`);
      if (after.button !== before.button) throw new Error(`a button changed size: ${before.button} -> ${after.button}`);
      if ((await stored()).size !== 20) throw new Error("the choice is not stored under the reader key");
      return after;
    });
    await check("controls-untouched", async () => {
      const sizes = await page.evaluate(() => [...document.querySelectorAll(".question-toolbar button, .explanation button, .explanation summary, .explanation textarea, .explanation input")]
        .map(element => parseFloat(getComputedStyle(element).fontSize)));
      if (sizes.some(value => value > 17)) throw new Error(`a control grew: ${sizes.join(",")}`);
      return sizes.length;
    });
    await step("serif-and-paper", async () => {
      await panelButton(t("衬线", "Serif")).click();
      await panelButton(t("纸张", "Paper")).click();
      await sleep(200);
      const face = await family(".explanation.study-reading .md p");
      if (!/serif/i.test(face) && !/Source Serif|Noto Serif|Songti|SimSun/i.test(face)) throw new Error(`typeface did not change: ${face}`);
      const tone = await page.locator(".explanation.study-reading").first().evaluate(element => element.getAttribute("data-tone"));
      if (tone !== "paper") throw new Error(`tone ${tone}`);
    });
    await check("no-horizontal-overflow-review", async () => {
      const probe = await page.evaluate(overflowProbe);
      if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`overflow ${JSON.stringify(probe)}`);
      return probe;
    });
    await check("card-face-unchanged", async () => {
      const face = await size(".question-card .flash-prompt, .question-card .question, .question-card .md");
      if (face !== before.face) throw new Error(`the card face followed the reading size: ${before.face} -> ${face}`);
      return face;
    });

    // The same setting in another open page of the same browser (the storage event).
    const other = await browserContext.newPage();
    await other.goto(page.url());
    await other.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await other.evaluate(() => { const value = JSON.parse(localStorage.getItem("study-reader-settings")); localStorage.setItem("study-reader-settings", JSON.stringify({ ...value, size: 24 })); });
    await other.close();
    await check("other-page-follows", async () => {
      await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector(".explanation.study-reading .md p")).fontSize) === 24, null, { timeout: 5000 });
    });

    // The source reader shows the same setting.
    await step("reader-same-setting", async () => {
      await page.getByRole("button", { name: /^(查看 \d+ 份资料|View \d+ sources?)/ }).first().click();
      await page.locator("dialog[open] button.source-row").first().click();
      await page.locator(".study-document-viewer").waitFor();
      await sleep(600);
      const reading = await size(".study-document-viewer .study-document-body");
      if (reading !== 24) throw new Error(`the reader shows ${reading}px, not the shared 24`);
      return reading;
    });
    await page.keyboard.press("Escape");
    await sleep(500);
    await page.getByRole("button", { name: new RegExp(`${t("回到题目", "Return to question")}`) }).first().click();
    await page.locator(".explanation").first().waitFor();
    await step("reset-everywhere", async () => {
      await popover.scrollIntoViewIfNeeded();
      await openPopover();
      await panelButton(t("恢复默认", "Reset")).click();
      await sleep(200);
      const value = await stored();
      if (value.size !== 16 || value.face !== "sans" || value.tone !== "auto" || value.width !== "standard") throw new Error(`not reset: ${JSON.stringify(value)}`);
      if (await size(".explanation.study-reading .md p") !== 16) throw new Error("the explanation did not reset");
    });
    await step("notes-page", async () => {
      await page.getByRole("button", { name: t("学习笔记", "Study notes") }).first().click();
      await page.locator(".blog-notes-page .reader-popover").waitFor();
    });
  } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseQaArgs(process.argv.slice(2), "reading");
    finishCli("Reading settings", options, await runReadingQa(options));
  } catch (error) { console.error(error?.message || error); process.exitCode = 2; }
}
