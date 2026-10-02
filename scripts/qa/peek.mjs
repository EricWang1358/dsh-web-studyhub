/* node scripts/qa/peek.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]   (build dist/ first: node -e "import('./scripts/build.mjs').then(m=>m.buildPreview())")
   看原页 in the browser preview, with generated PDFs only: open a peek from a page header and from a figure placeholder, zoom (capped at
   2000 px), next page, Esc and focus back, the cache hit on a page seen again, a reference-mode original that was moved, a document with
   no original (补全原文件 opens), a text whose page count differs from the file, and the memory of 30 peeks and of a 120-page book
   (JS heap after a forced GC, bitmaps kept and their bytes; native memory outside the JS heap is not measured here). */
/* global document, performance, gc -- page.evaluate callbacks run in the browser */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { createStudyRuntime } from "../../lib/runtime/builtins.js";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

/** A PDF whose pages say what they are (big "PAGE n") and, on `figures`, carry a drawn figure and the line [Figure]. */
async function makePdf(pages, { figures = [], title = "Book" } = {}) {
  const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n += 1) {
    const page = doc.addPage([612, 792]);
    page.drawText(`${title} PAGE ${n}`, { x: 50, y: 720, size: 28, font });
    page.drawText(`Page ${n} explains one idea of the course in a few plain sentences that can be read.`, { x: 50, y: 680, size: 12, font });
    page.drawText(`The second line of page ${n} adds a little more text so that the page counts as real text.`, { x: 50, y: 660, size: 12, font });
    if (figures.includes(n)) {
      page.drawText("[Figure]", { x: 50, y: 620, size: 12, font });
      page.drawRectangle({ x: 80, y: 300, width: 440, height: 300, color: rgb(0.2, 0.45, 0.8) });
      page.drawCircle({ x: 300, y: 450, size: 90, color: rgb(0.95, 0.75, 0.2) });
    }
  }
  return Buffer.from(await doc.save());
}

const SEEDED = {};
async function seed(root) {
  const runtime = createStudyRuntime(root);
  const files = join(root, "..", "files");
  await mkdir(files, { recursive: true });
  const bytes = pdf => pdf.toString("base64");
  const book = await runtime.call("materials.document.import", { filename: "os-book.pdf", dataBase64: bytes(await makePdf(12, { figures: [3, 7], title: "OS" })), courses: ["QA"] });
  SEEDED.book = book.documentId;
  // 120 pages for the memory measurement.
  const big = await runtime.call("materials.document.import", { filename: "big-book.pdf", dataBase64: bytes(await makePdf(120, { figures: [10, 60], title: "BIG" })), courses: ["QA"] });
  SEEDED.big = big.documentId;
  // An original attached by reference, then moved away.
  const moved = await runtime.call("materials.document.import", { filename: "moved-notes.pdf", dataBase64: bytes(await makePdf(4, { title: "MOVED" })), courses: ["QA"] });
  await runtime.call("materials.original.detach", { documentId: moved.documentId });
  const referenced = join(files, "moved-notes.pdf");
  await writeFile(referenced, await makePdf(4, { title: "MOVED" }));
  await runtime.call("materials.original.attach", { documentId: moved.documentId, mode: "reference", path: referenced, confirm: true });
  await rename(referenced, join(files, "moved-notes-elsewhere.pdf"));
  // No original at all.
  const none = await runtime.call("materials.document.import", { filename: "text-only.pdf", dataBase64: bytes(await makePdf(4, { title: "NONE" })), courses: ["QA"] });
  await runtime.call("materials.original.detach", { documentId: none.documentId });
  // A text of 5 pages whose attached file has 7.
  const odd = await runtime.call("materials.document.import", { filename: "mismatch.pdf", dataBase64: bytes(await makePdf(5, { title: "ODD" })), courses: ["QA"] });
  await runtime.call("materials.original.attach", { documentId: odd.documentId, mode: "copy", dataBase64: bytes(await makePdf(7, { title: "ODD" })), filename: "mismatch.pdf", confirm: true });
  runtime.dispose();
}

export async function runPeekQa(options) {
  return runQa({ name: "peek", options, seed, async run({ page, t, step, check }) {
    const viewer = page.locator(".study-document-viewer"), panel = page.locator(".page-peek"), canvas = page.locator(".page-peek canvas");
    const tool = (zh, en) => panel.getByRole("button", { name: t(zh, en), exact: true });
    const dialog = page.locator("dialog[open]");
    const openRow = async (title) => { await page.locator(".source-doc", { hasText: title }).locator(".source-main").click(); await viewer.waitFor(); await sleep(700); };
    const closeReader = async () => { await page.keyboard.press("Escape"); await sleep(300); if (await viewer.count()) { await dialog.getByRole("button", { name: t("关闭", "Close") }).first().click().catch(() => {}); } await sleep(400); };
    const drawn = async () => { await panel.waitFor(); await page.waitForFunction(() => { const c = document.querySelector(".page-peek canvas"); return !!c && c.width > 0 && !document.querySelector(".page-peek__busy"); }, null, { timeout: 30000 }); };
    const heap = async () => page.evaluate(() => { try { gc(); } catch { /* not exposed */ } return performance.memory ? performance.memory.usedJSHeapSize : 0; });
    const mb = (bytes) => Math.round(bytes / 1048576 * 10) / 10;

    await page.locator('[data-tour="nav-sources"]').first().click().catch(() => page.getByRole("button", { name: t("资料", "Sources") }).first().click());
    await sleep(800);
    await page.getByRole("button", { name: /^(全部展开|Expand all)$/ }).click().catch(() => {});
    await step("sources-list", async () => { await page.locator(".source-doc").first().waitFor(); });

    await step("reader-page-buttons", async () => {
      await openRow("os-book");
      await viewer.locator('.reader-peek[data-peek-page="3"]').first().waitFor();
      const figures = await viewer.locator('.reader-peek[data-peek-figure="true"]').count();
      if (figures < 1) throw new Error("no figure placeholder got a button");
      return { pageButtons: await viewer.locator(".reader-peek:not([data-peek-figure])").count(), figureButtons: figures };
    });
    await step("peek-open-from-page-header", async () => {
      await viewer.locator('.reader-section[data-study-page="2"] .reader-peek').first().click();
      await drawn();
      const where = await panel.locator(".page-peek__where").innerText();
      if (!/2\s*\/\s*12/.test(where)) throw new Error(`wrong page: ${where}`);
      const ink = await canvas.evaluate((element) => { const data = element.getContext("2d").getImageData(0, 0, element.width, Math.min(element.height, 200)).data; let dark = 0; for (let i = 0; i < data.length; i += 4) if (data[i] < 128 && data[i + 3] > 0) dark += 1; return dark; });
      if (ink < 50) throw new Error("the canvas is blank");
      if ((await panel.getAttribute("role")) !== "dialog") throw new Error("not a dialog");
      return { where, ink };
    });
    await check("panel-inside-viewport", async () => {
      const box = await panel.boundingBox(), view = page.viewportSize();
      if (!box || box.x < 0 || box.y < 0 || box.x + box.width > view.width + 1 || box.y + box.height > view.height + 1) throw new Error(`panel outside the window ${JSON.stringify(box)}`);
      const probe = await page.evaluate(overflowProbe);
      if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`horizontal overflow ${JSON.stringify(probe)}`);
      return box;
    });
    await step("peek-zoom-in", async () => {
      const before = await canvas.evaluate((element) => element.getBoundingClientRect().width);
      await tool("放大", "Zoom in").click(); await tool("放大", "Zoom in").click(); await drawn();
      const after = await canvas.evaluate((element) => ({ css: element.getBoundingClientRect().width, w: element.width, h: element.height }));
      if (!(after.css > before * 1.9)) throw new Error(`zoom did not enlarge: ${before} -> ${after.css}`);
      if (Math.max(after.w, after.h) > 2000) throw new Error(`bitmap over 2000 px: ${after.w}x${after.h}`);
      return after;
    });
    await step("peek-zoom-max-capped", async () => {
      for (let i = 0; i < 4 && await tool("放大", "Zoom in").isEnabled(); i += 1) { await tool("放大", "Zoom in").click(); await drawn(); }
      if (await tool("放大", "Zoom in").isEnabled()) throw new Error("zoom does not stop at its end");
      const size = await canvas.evaluate((element) => ({ w: element.width, h: element.height }));
      if (Math.max(size.w, size.h) > 2000) throw new Error(`bitmap over 2000 px: ${size.w}x${size.h}`);
      await tool("适合宽度", "Fit width").click(); await drawn();
      return size;
    });
    await step("peek-next-page", async () => {
      await tool("下一页", "Next page").click(); await drawn();
      const where = await panel.locator(".page-peek__where").innerText();
      if (!/3\s*\/\s*12/.test(where)) throw new Error(`still on ${where}`);
    });
    await check("cache-hit-on-return", async () => {
      const before = Number(await panel.getAttribute("data-renders"));
      await tool("上一页", "Previous page").click(); await drawn();
      await tool("下一页", "Next page").click(); await drawn();
      const after = { renders: Number(await panel.getAttribute("data-renders")), hits: Number(await panel.getAttribute("data-cache-hits")), cached: Number(await panel.getAttribute("data-cached")) };
      if (after.hits < 2) throw new Error(`no cache hits: ${JSON.stringify(after)}`);
      if (after.renders !== before) throw new Error(`a cached page was rendered again: ${before} -> ${after.renders}`);
      return after;
    });
    await step("peek-figure-note", async () => {
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
      await viewer.locator('.reader-peek[data-peek-figure="true"]').first().click();
      await drawn();
      const note = await panel.locator(".page-peek__note").innerText();
      if (!/(文字版不含图片|Figures are not kept)/.test(note)) throw new Error(`no figure note: ${note}`);
      const where = await panel.locator(".page-peek__where").innerText();
      if (!/3\s*\/\s*12/.test(where)) throw new Error(`the figure of page 3 opened ${where}`);
    });
    await check("esc-closes-and-restores-focus", async () => {
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
      if (!(await viewer.count())) throw new Error("Escape closed the reader too");
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-peek-figure"));
      if (focused !== "true") throw new Error("focus did not return to the figure button");
    });
    await check("keyboard-operable", async () => {
      await viewer.locator('.reader-section[data-study-page="1"] .reader-peek').first().focus();
      await page.keyboard.press("Enter");
      await drawn();
      await page.keyboard.press("PageDown"); await drawn();
      const where = await panel.locator(".page-peek__where").innerText();
      if (!/2\s*\/\s*12/.test(where)) throw new Error(`PageDown gave ${where}`);
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
    });
    // Thirty peeks: open, move around, close; the JS heap after a forced GC stays bounded.
    await check("thirty-peeks-heap-bounded", async () => {
      const start = await heap();
      for (let i = 0; i < 30; i += 1) {
        const target = 1 + (i * 5) % 12;
        await viewer.locator(`.reader-section[data-study-page="${target}"] .reader-peek`).first().scrollIntoViewIfNeeded();
        await viewer.locator(`.reader-section[data-study-page="${target}"] .reader-peek`).first().click();
        await drawn();
        if (i % 3 === 0) { await tool("下一页", "Next page").click(); await drawn(); }
        await page.keyboard.press("Escape");
        await panel.waitFor({ state: "detached" });
      }
      await sleep(500);
      const end = await heap();
      const growth = end - start;
      if (growth > 40 * 1048576) throw new Error(`heap grew ${mb(growth)} MB over 30 peeks`);
      return { startMB: mb(start), endMB: mb(end), growthMB: mb(growth) };
    });
    await closeReader();

    // A 120-page book: a peek at a page deep inside, zoomed, with pages around it.
    await check("big-book-120-pages", async () => {
      const before = await heap();
      await openRow("big-book");
      await viewer.locator('.reader-section[data-study-page="60"]').first().scrollIntoViewIfNeeded();
      let peak = before, bytes = 0, cached = 0;
      const sample = async () => { peak = Math.max(peak, await page.evaluate(() => performance.memory.usedJSHeapSize)); };
      await viewer.locator('.reader-section[data-study-page="60"] .reader-peek').first().click();
      await drawn(); await sample();
      for (let i = 0; i < 8; i += 1) { await tool("下一页", "Next page").click(); await drawn(); await sample(); }
      for (let i = 0; i < 3; i += 1) { await tool("放大", "Zoom in").click(); await drawn(); await sample(); }
      bytes = Number(await panel.getAttribute("data-cache-bytes")); cached = Number(await panel.getAttribute("data-cached"));
      if (cached > 6) throw new Error(`${cached} bitmaps kept`);
      await page.keyboard.press("Escape");
      await panel.waitFor({ state: "detached" });
      const after = await heap();
      return { heapBeforeMB: mb(before), heapPeakMB: mb(peak), heapAfterCloseMB: mb(after), bitmapsKept: cached, bitmapBytesMB: mb(bytes) };
    });
    await closeReader();

    await step("moved-reference-original", async () => {
      await openRow("moved-notes");
      await viewer.locator(".reader-peek").first().click();
      await panel.locator(".page-peek__state--note").waitFor();
      const message = await panel.locator(".page-peek__state--note").innerText();
      if (!/(找不到原文件|Original file not found|not found)/i.test(message)) throw new Error(`message: ${message}`);
      if (await canvas.count()) throw new Error("an empty frame is shown");
    });
    await step("moved-offers-relink", async () => {
      await tool("关闭", "Close").click().catch(() => {});
      if (await panel.count()) await page.keyboard.press("Escape");
      await viewer.locator(".reader-peek").first().click();
      await panel.getByRole("button", { name: t("重新指定…", "Choose another file…") }).click();
      await page.locator("dialog[open].original-dialog").waitFor();
      if (await panel.count()) throw new Error("the peek stayed open behind the dialog");
    });
    await closeReader(); await closeReader();

    await step("no-original", async () => {
      await openRow("text-only");
      await viewer.locator(".reader-peek").first().click();
      await panel.locator(".page-peek__state--note").waitFor();
      const message = await panel.locator(".page-peek__state--note").innerText();
      if (!/(没有原文件|not the original file|original file)/i.test(message)) throw new Error(`message: ${message}`);
      await panel.getByRole("button", { name: t("补全原文件…", "Add the original file…") }).waitFor();
    });
    await step("no-original-opens-attach", async () => {
      await panel.getByRole("button", { name: t("补全原文件…", "Add the original file…") }).click();
      await page.locator("dialog[open].original-dialog").waitFor();
    });
    await closeReader(); await closeReader();

    await step("page-count-mismatch", async () => {
      await openRow("mismatch");
      await viewer.locator(".reader-peek").first().click();
      await panel.locator(".page-peek__state--note").waitFor({ timeout: 20000 });
      const message = await panel.locator(".page-peek__state--note").innerText();
      if (!/5/.test(message) || !/7/.test(message)) throw new Error(`message: ${message}`);
      if (await canvas.count()) throw new Error("a page is shown although the counts differ");
    });
  } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseQaArgs(process.argv.slice(2), "peek");
    finishCli("Page peek", options, await runPeekQa(options));
  } catch (error) { console.error(error?.message || error); process.exitCode = 2; }
}
