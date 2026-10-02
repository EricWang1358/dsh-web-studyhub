/* node scripts/qa/rename.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]   (after `node -e "import('./scripts/build.mjs').then(m=>m.buildPreview())"` has built dist/)
   资料重命名 in the browser preview: the row menu entry, the inline editor (menu, F2, double-click on the title), a plain problem
   message, Esc, 恢复原名, the 原名 line, the reader header (重命名 button), and that a rename changes only the name (the page
   titles of a PDF follow, the text and the citations do not move). A seeded temporary library, the fake model, no network. */
/* global document, window -- page.evaluate callbacks run in the browser */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../../lib/store.js";
import { createStudyRuntime } from "../../lib/runtime/builtins.js";
import { makeTextPdf, LECTURE_PAGES } from "../../tests/helpers/text-pdf.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

async function seed(root) {
  const runtime = createStudyRuntime(root);
  const md = "# Operating systems\n\nA process is the unit of resource allocation in an operating system.\n\nVirtual memory gives every process its own address space.\n";
  await runtime.call("materials.document.import", { filename: "os-notes.md", dataBase64: Buffer.from(md).toString("base64"), courses: ["QA"] });
  await runtime.call("materials.document.import", { filename: "lecture5-databases.pdf", dataBase64: (await makeTextPdf(LECTURE_PAGES)).toString("base64"), courses: ["QA"] });
  runtime.dispose();
  const store = new Store(root), at = "2026-10-01T08:00:00.000Z";
  await store.update((state) => {
    for (const n of [1, 2, 3]) state.sources.push({ id: `pe1-${n}`, title: `PE1 · 中英对照逐字稿 (${n}/3)`, text: `Part ${n} of the lecture, with enough words to read.`, createdAt: at, courses: ["QA"],
      audio: { batch: { id: "pe1", title: "PE1", volume: n, volumes: 3, members: [{ order: n, filename: `week${n}.m4a`, hash: String(n) }] }, sourceIds: ["pe1-1", "pe1-2", "pe1-3"] } });
    state.sources.push({ id: "note-1", title: "Pasted notes", text: "A short pasted note about scheduling policies and their trade-offs.", createdAt: at, courses: ["QA"] });
  });
}

export async function runRenameQa(options) {
  return runQa({ name: "rename", options, seed, async run({ page, t, step, check }) {
    const row = (title) => page.locator(".source-doc", { hasText: title });
    const dialog = page.locator("dialog[open]");
    const field = page.locator(".rename-field__input");
    const name = t("资料", "Sources");
    await page.locator('[data-tour="nav-sources"]').first().click().catch(() => page.getByRole("button", { name }).first().click());
    await sleep(800);
    await page.getByRole("button", { name: /^(全部展开|Expand all)$/ }).click().catch(() => {});
    await step("sources-list", async () => { await page.locator(".source-doc").first().waitFor(); });

    await step("menu-entry", async () => { await row("os-notes").locator("summary").click(); await row("os-notes").getByRole("button", { name: t("重命名…", "Rename…") }).waitFor(); });
    await step("editor-open", async () => {
      await row("os-notes").getByRole("button", { name: t("重命名…", "Rename…") }).click();
      await field.waitFor();
      const state = await field.evaluate((input) => ({ focused: document.activeElement === input, selected: input.selectionStart === 0 && input.selectionEnd === input.value.length, value: input.value, placeholder: input.placeholder }));
      if (!state.focused || !state.selected || state.value !== state.placeholder) throw new Error(`editor not ready: ${JSON.stringify(state)}`);
    });
    await step("problem-empty", async () => { await field.fill("   "); await field.press("Enter"); await page.locator(".rename-field__error").waitFor(); });
    await step("problem-dots", async () => { await field.fill("..."); await field.press("Enter"); await page.locator(".rename-field__error", { hasText: t("点号", "dots") }).waitFor(); });
    await step("escape-cancels", async () => {
      await field.press("Escape");
      await field.waitFor({ state: "detached" });
      if (await dialog.count()) throw new Error("Escape closed a dialog");
      if (!(await row("os-notes").count())) throw new Error("the row lost its name");
    });
    await step("rename-saved", async () => {
      await row("os-notes").locator("summary").click();
      await row("os-notes").getByRole("button", { name: t("重命名…", "Rename…") }).click();
      await field.fill("  操作系统   笔记 第 1 周 ");
      await field.press("Enter");
      await row("操作系统 笔记 第 1 周").locator(".source-original").waitFor();
      const note = await row("操作系统 笔记 第 1 周").locator(".source-original").innerText();
      if (!note.includes("os-notes.md")) throw new Error(`original not shown: ${note}`);
    });
    await step("f2-edits-pdf", async () => {
      await row("lecture5").locator(".source-main").focus();
      await page.keyboard.press("F2");
      await field.waitFor();
      await field.fill("数据库 第 5 讲");
      await field.press("Enter");
      await row("数据库 第 5 讲").waitFor();
    });
    await step("pdf-pages-follow", async () => {
      await row("数据库 第 5 讲").getByRole("button", { name: /(查看|Show) \d+/ }).click();
      const pages = await row("数据库 第 5 讲").locator(".source-doc__page-list").innerText();
      if (!/1/.test(pages)) throw new Error("page list missing");
    });
    await step("double-click-edits-recording", async () => {
      await row("PE1").locator(".source-title").dblclick();
      await field.waitFor();
      if (await page.locator(".study-document-viewer").count()) throw new Error("the double-click also opened the reader");
      await field.fill("Programming Exam 1");
      await field.press("Enter");
      await row("Programming Exam 1").waitFor();
    });
    await step("restore", async () => {
      await row("Programming Exam 1").locator("summary").click();
      await row("Programming Exam 1").getByRole("button", { name: t("重命名…", "Rename…") }).click();
      await page.getByRole("button", { name: t("恢复原名", "Restore original name") }).click();
      await row("PE1").waitFor();
      if (await row("PE1").locator(".source-original").count()) throw new Error("a restored document still says it was renamed");
    });
    await check("no-horizontal-overflow-sources", async () => {
      const probe = await page.evaluate(overflowProbe);
      if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`horizontal overflow ${JSON.stringify(probe)}`);
      return probe;
    });
    await step("reader-header", async () => {
      await row("操作系统 笔记 第 1 周").locator(".source-main").click();
      await page.locator(".study-document-viewer").waitFor();
      await dialog.locator(".reader-heading").waitFor();
      const text = await dialog.locator(".sh-dialog__title").innerText();
      if (!text.includes("操作系统 笔记 第 1 周")) throw new Error(`header shows ${text}`);
    });
    await step("reader-header-edit", async () => {
      await dialog.locator(".reader-heading__text").dblclick();
      await field.waitFor();
      if (await dialog.count() === 0) throw new Error("the dialog closed");
      await field.fill("OS notes (week 1)");
    });
    await step("reader-header-escape", async () => {
      await field.press("Escape");
      await field.waitFor({ state: "detached" });
      if (!(await page.locator(".study-document-viewer").count())) throw new Error("Escape closed the reader instead of cancelling the edit");
    });
    await step("reader-header-saved", async () => {
      await dialog.getByRole("button", { name: t("重命名", "Rename") }).click();
      await field.fill("OS notes (week 1)");
      await field.press("Enter");
      await dialog.locator(".reader-heading__text", { hasText: "OS notes (week 1)" }).waitFor();
    });
    await check("reader-focus-restored", async () => {
      const focused = await page.evaluate(() => document.activeElement?.className || "");
      if (!String(focused).includes("reader-heading__text")) throw new Error(`focus is on ${focused}`);
    });
    await page.keyboard.press("Escape");
    await sleep(500);
    await step("sources-after-reader-rename", async () => { await row("OS notes (week 1)").waitFor(); });
    await check("text-and-citations-unchanged", async () => {
      const result = await page.evaluate(async () => {
        const token = window.STUDY_TOKEN;
        const call = async (action, args) => (await (await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json", "x-study-token": token }, body: JSON.stringify({ action, args }) })).json()).value;
        const doc = await call("materials.document.list", { query: "OS notes" });
        return { total: doc.total, title: doc.documents[0]?.title };
      });
      if (result.total !== 1 || result.title !== "OS notes (week 1)") throw new Error(`unexpected ${JSON.stringify(result)}`);
      return result;
    });
  } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseQaArgs(process.argv.slice(2), "rename");
    finishCli("Rename", options, await runRenameQa(options));
  } catch (error) { console.error(error?.message || error); process.exitCode = 2; }
}
