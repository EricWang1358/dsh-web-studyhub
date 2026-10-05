/* node scripts/qa/reader-footnote.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]   (build dist/ first: npm run build)
   A converter's page footnote (`<small><span class="docvortex-page-footnote" ...>…</span></small>`, lib/footnote-html.js) in the reader (阅读),
   for a converted paged book (the text reader, as a converted PDF opens) and a Markdown note (the Markdown reader), in Chromium on a temporary
   library with the fake model and every key/token/base-url variable removed. For each: the footnote is a smaller, muted note element under a
   thin rule and no `<small>` / `<span` text is visible; other HTML stays visible as text; selecting the footnote quotes the stored text and
   the learning panel verifies it (no 「无法在已保存的资料中核实」, asking enabled); a selection from the body into the footnote verifies too.
   One screenshot per step and <out>/summary.json. */
/* global document, getSelection, MouseEvent, getComputedStyle -- page.evaluate callbacks run in the browser */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StudyService } from "../../lib/service.js";
import { finishCli, parseQaArgs, runQa } from "./harness.mjs";

const NOTE = '<small><span class="docvortex-page-footnote" data-block-type="page_footnote" style="color:#6b7280">① pH 是个例外，用正体。</span></small>';
const OTHER = '<small>这个不是脚注，原样显示。</small>';
const BODY = "酸碱度的符号写作 pH，表示氢离子浓度的负对数，书写时 p 与 H 的字体各不相同。";
const PAGE = ["# 溶液与酸碱", BODY, NOTE, NOTE.replace("①", "②").replace("是个例外", "为 $x_i$ 的例子"), OTHER].join("\n\n") + "\n";
const BOOK = `<!-- page: 1 -->\n${PAGE}\n<!-- page: 2 -->\n# 缓冲溶液\n\n缓冲溶液能抵抗少量酸碱的加入而保持 pH 基本不变。\n`;
const MATERIALS = [{ filename: "chem-book.md", title: "Chem book", kind: "book", text: BOOK }, { filename: "chem-note.md", title: "Chem note", kind: "note", text: PAGE }];

async function seed(root) {
  const service = new StudyService(root);
  for (const { filename, title, text } of MATERIALS)
    await service.call("materials.document.import", { filename, title, dataBase64: Buffer.from(text).toString("base64") });
}

export async function runReaderFootnoteQa(options) {
  return runQa({ name: "reader-footnote", options, seed, async run({ page, server, t, step, check, summary, sleep: wait }) {
    const resolved = [];
    page.on("request", (request) => {
      if (!request.url().endsWith("/api/call")) return;
      try { const body = JSON.parse(request.postData() || "{}"); if (body.action === "materials.selection.resolve") resolved.push(body.args.quote); } catch { /* not JSON */ }
    });
    const open = async (title) => {
      await page.goto(server.url);
      await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
      await page.locator("nav").getByRole("button", { name: new RegExp(`^\\s*${t("资料", "Sources")}`) }).first().click();
      await page.locator(".source-main", { hasText: title }).first().click();
      await page.locator(".study-document-viewer").waitFor({ timeout: 20000 });
      await page.locator(".study-document-body .reader-footnote").first().waitFor({ timeout: 20000 });
      await wait(600);
    };
    const select = (mode) => page.evaluate((how) => {
      const body = document.querySelector(".study-document-body"), notes = [...body.querySelectorAll(".reader-footnote")];
      const para = [...body.querySelectorAll("p")].find((node) => node.textContent.includes("书写时"));
      const range = document.createRange();
      if (how === "note") range.selectNodeContents(notes[0]);
      else if (how === "second") range.selectNodeContents(notes[1]);
      else { range.setStartBefore(para.firstChild); range.setEndAfter(notes[0].lastChild); }
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, mode);
    const verified = async (needle) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !(resolved.length && resolved.at(-1).includes(needle))) await wait(100);
      if (!resolved.length || !resolved.at(-1).includes(needle)) throw new Error(`quote: ${JSON.stringify(resolved.at(-1))}`);
      await showPanel();
      await learning.locator("form textarea").first().waitFor({ timeout: 15000 });
      if (await learning.locator(".warning").count()) throw new Error(`the panel warns: ${await learning.locator(".warning").first().innerText()}`);
    };
    const learning = page.locator(".study-document-learning");
    const showPanel = async () => { if (!(await page.locator('[data-tour="source-tools"]').isVisible())) { await page.locator('[data-tour="source-tools-toggle"]').click(); await wait(400); } };

    for (const { title, kind } of MATERIALS) {
      const label = (text) => `${kind} - ${text}`;
      await open(title);

      await step(label("the footnotes are note lines, smaller and muted, under a thin rule; no tags are visible; other HTML stays text"), async () => {
        const facts = await page.evaluate(() => {
          const body = document.querySelector(".study-document-body"), notes = [...body.querySelectorAll(".reader-footnote")];
          const first = notes[0], prose = [...body.querySelectorAll("p")].find((node) => node.textContent.includes("书写时")) || first;
          const visible = body.innerText;
          return { notes: notes.length, role: first.getAttribute("role"), fontRatio: parseFloat(getComputedStyle(first).fontSize) / parseFloat(getComputedStyle(prose).fontSize),
            color: getComputedStyle(first).color !== getComputedStyle(prose).color, rule: getComputedStyle(first).borderTopWidth, secondRule: getComputedStyle(notes[1]).borderTopWidth,
            visibleTags: /<small|<span|docvortex|page_footnote|color:#6b7280/.test(visible.replace("<small>这个不是脚注，原样显示。</small>", "")),
            otherHtmlText: visible.includes("<small>这个不是脚注，原样显示。</small>"), style: first.hasAttribute("style"), math: notes[1].querySelectorAll(".reader-math").length };
        });
        if (facts.notes !== 2 || facts.role !== "note" || !(facts.fontRatio < 0.95) || !facts.color || facts.rule === "0px" || facts.secondRule !== "0px" || facts.visibleTags || !facts.otherHtmlText || facts.style || facts.math !== 1)
          throw new Error(JSON.stringify(facts));
        return facts;
      });

      await step(label("selecting the footnote quotes the stored text and the panel verifies it"), async () => {
        await select("note");
        await verified("pH 是个例外");
        await learning.locator("form textarea").first().fill(t("pH 为什么用正体？", "Why is pH upright?"));
        if (!(await learning.locator("form button[type=submit]").first().isEnabled())) throw new Error("asking is not enabled");
      });

      await check(label("selecting the footnote with a formula in it verifies too"), async () => {
        resolved.length = 0;
        await select("second");
        await verified("pH 为");
      });

      // The Markdown reader keeps whitespace between its blocks, so a quote across them verifies. (The text reader does not: a quote across two
      // paragraphs of a converted page is unverifiable already without any footnote, a separate, older matter.)
      if (kind === "note") await check(label("a selection from the body into the footnote verifies too"), async () => {
        resolved.length = 0;
        await select("across");
        await verified("书写时");
      });
      resolved.length = 0;
    }
    summary.stored = PAGE;
  } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseQaArgs(process.argv.slice(2), "reader-footnote");
    finishCli("Reader footnote", options, await runReaderFootnoteQa(options));
  } catch (error) { console.error(error?.message || error); process.exitCode = 2; }
}
