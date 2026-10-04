/* node scripts/qa/reader-formulas.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]   (build dist/ first: npm run build)
   Formulas in the reader (阅读), for a text source (TXT) and a Markdown one, in Chromium on a temporary library with the fake model
   and every key/token/base-url variable removed. For each: the formulas are drawn; selecting a paragraph with formulas quotes the
   stored text and the learning panel verifies it (no 「无法在已保存的资料中核实」, asking enabled) and draws the quote; a selection
   that starts / ends inside a drawn formula quotes the whole formula and widens the live selection; a click on a formula captures
   exactly that formula; find highlights over the drawn formula; a copy gives the TeX source without stray newlines (and stays native
   when no formula is touched); no scrollbar under \ce formulas. One screenshot per step and <out>/summary.json. */
/* global document, getSelection, MouseEvent, ClipboardEvent, DataTransfer, CSS -- page.evaluate callbacks run in the browser */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StudyService } from "../../lib/service.js";
import { finishCli, parseQaArgs, runQa } from "./harness.mjs";

const FORWARD = String.raw`全连接层前向：$z = Wx + b$，损失 $L = \frac{1}{2}(a - y)^2$。`;
const DELTA = String.raw`$$\delta = (a - y) \odot \sigma'(z)$$`;
const BALANCE = String.raw`$$\ce{4Fe + 3O2 -> 2Fe2O3}$$`;
const PRICE = "价格是 $5 and $10，这不是公式。";
const STORED = ["# 反向传播与配平", FORWARD, DELTA, String.raw`未配平：$\ce{Fe + O2 -> Fe2O3}$，配平后：`, BALANCE, PRICE].join("\n\n") + "\n";
const MATERIALS = [{ filename: "backprop.txt", title: "Backprop text", kind: "text" }, { filename: "backprop.md", title: "Backprop markdown", kind: "markdown" }];

async function seed(root) {
  const service = new StudyService(root);
  for (const { filename, title } of MATERIALS)
    await service.call("materials.document.import", { filename, title, dataBase64: Buffer.from(STORED).toString("base64") });
}

export async function runReaderFormulasQa(options) {
  return runQa({ name: "reader-formulas", options, seed, async run({ page, server, t, step, check, summary, sleep: wait }) {
    const resolved = [];
    page.on("request", (request) => {
      if (!request.url().endsWith("/api/call")) return;
      try { const body = JSON.parse(request.postData() || "{}"); if (body.action === "materials.selection.resolve") resolved.push(body.args.quote); } catch { /* not JSON */ }
    });
    const lastQuote = async (expected) => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) { if (resolved.length && resolved.at(-1) === expected) return; await wait(100); }
      throw new Error(`quote ${JSON.stringify(resolved.at(-1))} is not ${JSON.stringify(expected)}`);
    };
    const open = async (title) => {
      await page.goto(server.url);
      await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
      await page.locator("nav").getByRole("button", { name: new RegExp(`^\\s*${t("资料", "Sources")}`) }).first().click();
      await page.locator(".source-main", { hasText: title }).first().click();
      await page.locator(".study-document-viewer").waitFor({ timeout: 20000 });
      await page.locator(".study-document-body .reader-math").first().waitFor({ timeout: 20000 });
      await wait(600);
    };
    /** Selects through the page the way a pointer would: a range (a whole paragraph, or from inside its first formula to inside its last), then mouseup. */
    const select = (text, { inside = false } = {}) => page.evaluate(([needle, across]) => {
      const body = document.querySelector(".study-document-body");
      const paragraph = [...body.querySelectorAll("p, h4, h1, h2")].find((node) => node.textContent.includes(needle));
      const texts = (node) => { const walker = document.createTreeWalker(node, 4), found = []; let next; while ((next = walker.nextNode())) found.push(next); return found; };
      const range = document.createRange();
      if (!across) range.selectNodeContents(paragraph);
      else {
        const [first, last] = paragraph.querySelectorAll(".reader-math__view math"), end = texts(last).at(-1);
        range.setStart(texts(first)[0], 0); range.setEnd(end, end.length);
      }
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }, [text, inside]);
    const learning = page.locator(".study-document-learning");
    const showPanel = async () => { if (!(await page.locator('[data-tour="source-tools"]').isVisible())) { await page.locator('[data-tour="source-tools-toggle"]').click(); await wait(400); } };
    const copyOf = () => page.evaluate(() => {
      const body = document.querySelector(".study-document-body"), data = new DataTransfer();
      const event = new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true });
      body.dispatchEvent(event);
      return { prevented: event.defaultPrevented, text: data.getData("text/plain") };
    });
    const closePanel = async () => { if (await page.locator(".reader-scrim").count()) { await page.locator(".reader-scrim").click({ position: { x: 4, y: 300 }, timeout: 5000 }); await wait(300); } }; // narrow panes slide the panel over the text
    const clickFormula = async (index) => {
      await closePanel();
      const box = await page.locator(".study-document-body .reader-math__view").nth(index).boundingBox();
      if (!box) throw new Error(`formula ${index} has no box`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };

    for (const { title, kind } of MATERIALS) {
      const label = (text) => `${kind} - ${text}`;
      await open(title);

      await check(label("every formula is drawn, the currency stays text"), async () => {
        const drawn = await page.evaluate(() => ({ units: document.querySelectorAll(".study-document-body .reader-math").length,
          views: document.querySelectorAll(".study-document-body .reader-math__view math").length, display: document.querySelectorAll(".study-document-body .reader-math--display").length,
          text: document.querySelector(".study-document-body").textContent.includes("$5 and $10") }));
        if (drawn.units !== 5 || drawn.views !== 5 || drawn.display !== 2 || !drawn.text) throw new Error(JSON.stringify(drawn));
        return drawn;
      });

      await step(label("selecting a paragraph with formulas quotes it and the panel verifies it"), async () => {
        await select("Wx + b");
        await lastQuote(FORWARD);
        await showPanel();
        await learning.locator("form textarea").first().waitFor({ timeout: 15000 });
        if (await learning.locator(".warning").count()) throw new Error(`the panel warns: ${await learning.locator(".warning").first().innerText()}`);
        await learning.locator("form textarea").first().fill(t("z 是什么？", "What is z?"));
        if (!(await learning.locator("form button[type=submit]").first().isEnabled())) throw new Error("asking is not enabled");
        await learning.locator("blockquote .md-math math").first().waitFor({ timeout: 10000 });
        const drawn = await learning.locator("blockquote .md-math math").count();
        if (drawn !== 2) throw new Error(`${drawn} formulas drawn in the quote, expected 2`);
      });

      await check(label("a selection that starts and ends inside drawn formulas quotes them whole and widens the live selection"), async () => {
        await select("Wx + b", { inside: true });
        await lastQuote(String.raw`$z = Wx + b$，损失 $L = \frac{1}{2}(a - y)^2$`);
        const outside = await page.evaluate(() => { const selection = getSelection();
          return !selection.anchorNode.parentElement.closest(".reader-math") && !selection.focusNode.parentElement.closest(".reader-math"); });
        if (!outside) throw new Error("the live selection still ends inside a formula");
      });

      await step(label("a click on a formula captures exactly that formula"), async () => {
        await clickFormula(1);
        await lastQuote(String.raw`$L = \frac{1}{2}(a - y)^2$`);
        const painted = await page.evaluate(() => getSelection().toString().length > 0 && !getSelection().isCollapsed);
        if (!painted) throw new Error("nothing is selected after the click");
        await clickFormula(2);
        await lastQuote(DELTA);
        await showPanel();
      });

      await check(label("a copy gives the TeX source without stray newlines, and stays native away from formulas"), async () => {
        await select("Wx + b");
        const whole = await copyOf();
        if (!whole.prevented || whole.text !== FORWARD) throw new Error(`paragraph copy: ${JSON.stringify(whole)}`);
        await clickFormula(0);
        const single = await copyOf();
        if (single.text !== "$z = Wx + b$") throw new Error(`formula copy: ${JSON.stringify(single)}`);
        await select("这不是公式");
        const plain = await copyOf();
        if (plain.prevented) throw new Error("a copy without a formula was taken over");
      });

      await step(label("find highlights over the drawn formula"), async () => {
        await closePanel();
        await page.evaluate(() => getSelection().removeAllRanges()); // the find bar would start from the selected text
        await page.locator(".reader-scroll").focus();
        await page.keyboard.press("Control+f");
        await page.locator(".reader-find__input").fill("sigma");
        await page.waitForFunction(() => { const [range] = [...(CSS.highlights.get("study-find-current") || [])]; return !!range && range.toString().includes("sigma"); }, null, { timeout: 8000 });
        // The highlight paints the glyphs of the drawn formula: its text boxes lie inside the formula's own box.
        const found = await page.evaluate(() => {
          const [range] = [...CSS.highlights.get("study-find-current")], boxes = [...range.getClientRects()].map((box) => ({ left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width }));
          const views = [...document.querySelectorAll(".study-document-body .reader-math__view")].map((view) => view.getBoundingClientRect().toJSON());
          const inside = (view) => boxes.filter((box) => box.width > 2 && box.left >= view.left - 2 && box.right <= view.right + 2 && box.top >= view.top - 2 && box.bottom <= view.bottom + 2).length;
          return { painted: Math.max(0, ...views.map(inside)), boxes: boxes.length, views: views.length };
        });
        if (found.painted < 3) throw new Error(`the highlight is not over the drawn formula: ${JSON.stringify(found)}`);
      });
      await page.keyboard.press("Escape");

      await check(label("no scrollbar under the \\ce formulas, and the page does not scroll sideways"), async () => {
        const wide = await page.evaluate(() => [...document.querySelectorAll(".study-document-body .reader-math--display, .study-document-body .reader-math__view")]
          .filter((node) => node.scrollWidth > node.clientWidth + 1).map((node) => node.className)
          .concat(document.querySelector(".reader-scroll").scrollWidth > document.querySelector(".reader-scroll").clientWidth + 1 ? ["reader-scroll"] : []));
        if (wide.length) throw new Error(`overflow: ${wide.join(", ")}`);
      });
    }
    summary.stored = STORED;
  } });
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseQaArgs(process.argv.slice(2), "reader-formulas");
    finishCli("Reader formulas", options, await runReaderFormulasQa(options));
  } catch (error) { console.error(error?.message || error); process.exitCode = 2; }
}
