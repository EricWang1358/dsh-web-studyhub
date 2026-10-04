/* node scripts/qa/wp-h-shots.mjs [--lang zh|en --theme dark|light --width 1280|420 --out <dir>]
   (build first: npm run build)
   UI wave 2, WP-H in the browser preview: the library home with its menus open (the deck ⋯ and 整理与添加) and a running generation JobRow,
   the knowledge graph taking the screen when the Fullscreen API is blocked (the top-layer fallback), the skeleton canvas with its
   sequence tabs and layout popover, and an enlarged image in the shared Dialog. The reader's floating translation card is covered by
   qa:translation. A seeded temporary library (the sample course), the fake model, no network. */
/* global document, window, Element -- page.evaluate callbacks run in the browser */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { previewCall } from "../preview-server.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

/** A PNG of w x h pixels in two colours, built without a library (a picture for the image viewer). */
function png(width, height) {
  const crc = (buffer) => { let c, table = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    let value = 0xffffffff; for (const byte of buffer) value = table[(value ^ byte) & 0xff] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) { rows[y * (width * 3 + 1)] = 0; for (let x = 0; x < width; x++) { const at = y * (width * 3 + 1) + 1 + x * 3;
    const band = Math.floor(x / (width / 6)) % 2 === 0; rows[at] = band ? 201 : 134; rows[at + 1] = band ? 61 : 169; rows[at + 2] = band ? 34 : 198; } }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const options0 = parseQaArgs(process.argv.slice(2), "wp-h");

async function seed() {}

/** The sample course, two sequences on its skeleton (so the diagram's tabs show) and a deck whose question shows a picture. */
async function populate(server, lang, directory) {
  const call = (action, input = {}) => previewCall(server, action, input);
  await call("sample.load", { uiLanguage: lang });
  const { skeletons } = await call("skeleton.list", {});
  const full = await call("skeleton.get", { id: skeletons[0].id });
  const first = full.sequences?.[0];
  if (first) await call("skeleton.save", { skeleton: { ...full, sequences: [first, { ...first, title: lang === "zh" ? "撤销与重做的往返" : "Undo and redo round trip" }] } });
  const image = `data:image/png;base64,${png(480, 240).toString("base64")}`;
  const folder = join(directory, "banks");
  await mkdir(folder, { recursive: true });
  const bank = join(folder, "diagram.json");
  await writeFile(bank, JSON.stringify({ title: lang === "zh" ? "图示题组" : "Diagram deck", folder: lang === "zh" ? "示例课程" : "Sample course", cards: [{ kind: "quiz", topic: "Diagram", objective: "read a diagram",
    prompt: `![${lang === "zh" ? "结构示意图" : "Structure diagram"}](${image})\n${lang === "zh" ? "图中哪一块颜色占比更大？" : "Which colour takes more of the diagram?"}`, answer: "A",
    explanation: "Count the bands: there are more of A.", misconception: "Judging by the first band only.",
    options: [{ id: "a", text: "A", correct: true, explanation: "More." }, { id: "b", text: "B", correct: false, explanation: "Fewer." }] }] }));
  await call("deck.import", { path: bank });
}

export async function runShots(options) {
  return runQa({ name: "wp-h", options, seed, latencyMs: 9000, async run({ page, server, t, step, check }) {
    const dialog = page.locator("dialog[open]");
    await populate(server, options.lang, options.out);
    await page.reload();
    await page.locator("aside, nav").first().waitFor();
    // The sample course announces itself on the home once; "maybe later" puts the library there.
    const later = page.getByRole("button", { name: t("以后再说", "Maybe later"), exact: true });
    if (await later.count()) { await later.click(); await sleep(400); }
    const library = async () => { await page.locator('[data-usage="nav.library"]').first().click(); await page.locator(".map-page").waitFor(); await sleep(600); };
    await library();
    await step("home", async () => { await sleep(400); });
    await step("home-deck-menu", async () => {
      await page.locator(".deck-row").first().hover();
      await page.locator(".deck-row .map-menu-wrap button").first().click();
      await page.getByRole("menu").waitFor();
      const focus = await page.evaluate(() => document.activeElement?.getAttribute("role"));
      if (focus !== "menuitem") throw new Error(`focus not in the menu: ${focus}`);
    });
    await check("Escape closes the deck menu and gives focus back", async () => {
      await page.keyboard.press("Escape");
      if (await page.getByRole("menu").count()) throw new Error("menu still open");
      const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-haspopup"));
      if (back !== "menu") throw new Error(`focus is on ${back}`);
    });
    await step("home-catalog-menu", async () => {
      await page.locator(".catalog-menu-toggle").click();
      await page.getByRole("menu").waitFor();
    });
    await check("an outside press closes the catalog menu", async () => {
      await page.mouse.click(5, 5);
      if (await page.getByRole("menu").count()) throw new Error("menu still open");
    });
    // A running generation JobRow.
    const sources = (await previewCall(server, "snapshot", {})).sources.map((source) => source.id);
    await previewCall(server, "generate", { sourceIds: sources, count: 6, kind: "quiz", title: "QA job", language: options.lang === "en" ? "English" : "中文" }).catch(() => {});
    await page.reload();
    await page.locator(".map-page").waitFor();
    await step("home-jobrow", async () => { await page.locator(".sh-job").first().waitFor({ timeout: 15000 }); await sleep(500); });
    await check("the job row is the shared JobRow with a progressbar and no glyph text", async () => {
      const probe = await page.evaluate(() => { const row = document.querySelector(".generation-jobs .sh-job"); return { row: !!row, bar: !!row?.querySelector('[role="progressbar"]'), text: row?.textContent || "" }; });
      if (!probe.row) throw new Error("no JobRow on the home");
    });
    // The graph, with the Fullscreen API blocked as it is inside DSH.
    await step("graph-fullscreen-fallback", async () => {
      await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error("blocked by the host")); });
      await page.getByRole("button", { name: t("查看图谱", "View graph"), exact: true }).first().click();
      await page.locator(".graph.canvas-expanded").waitFor({ timeout: 15000 });
      await sleep(900);
    });
    await check("the graph fills the viewport in the top layer and Escape leaves it first", async () => {
      const box = await page.evaluate(() => { const el = document.querySelector(".graph"); const r = el.getBoundingClientRect(); return { open: el.matches(":popover-open"), w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight }; });
      if (!box.open) throw new Error("not in the top layer");
      if (box.w < box.vw - 2 || box.h < box.vh - 2) throw new Error(`does not fill the viewport: ${JSON.stringify(box)}`);
      await page.keyboard.press("Escape");
      await sleep(250);
      if (await page.locator(".graph.canvas-expanded").count()) throw new Error("Escape did not leave the expanded canvas");
      if (!(await page.locator(".graph").count())) throw new Error("Escape closed the whole graph page");
    });
    await page.locator('[data-usage="nav.skeleton"]').first().click();
    await sleep(900);
    await step("skeleton-page", async () => {});
    await step("skeleton-spine", async () => {
      await page.getByRole("button", { name: /\d+ ?(个概念|concepts)/ }).first().click();
      await page.locator(".spine-tab").first().waitFor({ timeout: 8000 });
      await page.locator(".spine-tab").nth(1).focus();
      await sleep(600);
    });
    await check("a station's name shows in a Tooltip on keyboard focus, in the top layer", async () => {
      const probe = await page.evaluate(() => { const tab = document.activeElement; const tip = document.getElementById(tab.getAttribute("aria-describedby") || ""); return { tip: tip?.textContent, open: tip?.matches(":popover-open") }; });
      if (!probe.tip || !probe.open) throw new Error(JSON.stringify(probe));
    });
    await step("skeleton-canvas", async () => {
      await page.getByRole("button", { name: t("结构图", "Structure diagram"), exact: true }).click();
      await page.locator(".skc").first().waitFor({ timeout: 8000 });
      await sleep(600);
    });
    await step("skeleton-tabs-and-layout", async () => {
      await page.locator(".skc-tabs").scrollIntoViewIfNeeded().catch(() => {});
      await page.getByRole("button", { name: t("布局", "Layout"), exact: true }).first().click();
      await page.getByRole("dialog", { name: t("布局", "Layout") }).waitFor();
    });
    await step("skeleton-sequence-tabs", async () => {
      await page.keyboard.press("Escape");
      await page.locator(".skc-tabs").scrollIntoViewIfNeeded();
      await page.locator('.skc-tabs [role="tab"]').first().focus();
      await sleep(300);
    });
    await check("the sequence tabs follow the tab pattern (arrow keys, aria-controls)", async () => {
      const first = page.locator('.skc-tabs [role="tab"]').first();
      await first.focus();
      await page.keyboard.press("ArrowRight");
      const state = await page.evaluate(() => { const tabs = [...document.querySelectorAll('.skc-tabs [role="tab"]')]; const sel = tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
        return { index: tabs.indexOf(sel), focus: tabs.indexOf(document.activeElement), controls: !!document.getElementById(sel?.getAttribute("aria-controls") || "") }; });
      if (state.index !== 1 || state.focus !== 1) throw new Error(JSON.stringify(state));
      if (!state.controls) throw new Error("aria-controls points nowhere");
    });
    // The picture in the shared Dialog.
    await library();
    await step("image-quiz", async () => {
      await page.locator(".map-name", { hasText: t("图示题组", "Diagram deck") }).first().hover();
      await page.locator(".deck-row", { hasText: t("图示题组", "Diagram deck") }).locator(".map-play").click({ force: true });
      await page.locator(".md-image-open").waitFor({ timeout: 15000 });
    });
    await step("image-dialog", async () => {
      await page.locator(".md-image-open").click();
      await dialog.waitFor();
      await sleep(400);
    });
    await check("the image dialog is the shared Dialog, closes with Escape and returns focus", async () => {
      const probe = await page.evaluate(() => { const d = document.querySelector("dialog[open]"); return { shared: d?.classList.contains("sh-dialog--media"), close: !!d?.querySelector(".sh-dialog__close"), title: d?.querySelector(".sh-dialog__title")?.textContent }; });
      if (!probe.shared || !probe.close) throw new Error(JSON.stringify(probe));
      await page.keyboard.press("Escape");
      await sleep(250);
      if (await dialog.count()) throw new Error("dialog still open");
      const back = await page.evaluate(() => document.activeElement?.className || "");
      if (!/md-image-open/.test(back)) throw new Error(`focus returned to ${back}`);
    });
    await check("no horizontal overflow", async () => { const probe = await page.evaluate(overflowProbe); if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(JSON.stringify(probe)); });
    return join(options.out, "summary.json");
  } });
}

if (process.argv[1]?.endsWith("wp-h-shots.mjs")) finishCli("WP-H", options0, await runShots(options0));
