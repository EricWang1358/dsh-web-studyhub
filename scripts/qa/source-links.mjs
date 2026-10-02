/* node scripts/qa/source-links.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]
   The source reader's link underlines (2.3.2) in the browser preview, on a fresh temporary library with the fake
   model and every key/token/base-url variable removed: a long document with questions linked to passages, a
   follow-up on one of them, then in the reader: ask about a passage, save the answer as a flashcard, see the new
   underline, click an underline to open its links, open the card, hide the underlines from the Aa popover.
   One screenshot per step and <out>/summary.json (checks, console errors, page errors, failed API calls); exits
   non-zero when a check fails. Run `npm run build` first. */
/* global document, window, localStorage, performance, PerformanceObserver, requestAnimationFrame, CSS, NodeFilter, MouseEvent, getSelection -- page.evaluate callbacks run in the browser */
import { mkdir, rm, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { Store } from "../../lib/store.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** A long Markdown document: 40 sections, each with its own unique sentences to select. */
export function longDocument(lang) {
  const en = lang === "en";
  const sections = Array.from({ length: 40 }, (_, index) => {
    const n = index + 1;
    return en
      ? `## Section ${n}\n\nThe scheduler in section ${n} lowers the review interval after a failed recall of item ${n}. Retrieval practice number ${n} strengthens the memory trace more than rereading does. A good card in section ${n} tests exactly one gradable point.`
      : `## 第 ${n} 节\n\n第 ${n} 节的调度器在第 ${n} 项回忆失败后会缩短下一次复习的间隔。第 ${n} 号提取练习比反复阅读更能加强记忆痕迹。第 ${n} 节里的好卡片只考查一个可以判分的要点。`;
  });
  return { title: en ? "Spaced repetition handbook" : "间隔重复手册", text: `# ${en ? "Spaced repetition handbook" : "间隔重复手册"}\n\n${sections.join("\n\n")}\n` };
}
const sentence = (lang, n, which) => lang === "en"
  ? [`The scheduler in section ${n} lowers the review interval after a failed recall of item ${n}.`, `Retrieval practice number ${n} strengthens the memory trace more than rereading does.`, `A good card in section ${n} tests exactly one gradable point.`][which]
  : [`第 ${n} 节的调度器在第 ${n} 项回忆失败后会缩短下一次复习的间隔。`, `第 ${n} 号提取练习比反复阅读更能加强记忆痕迹。`, `第 ${n} 节里的好卡片只考查一个可以判分的要点。`][which];

export function parseArguments(argv) {
  const { values } = parseArgs({ args: argv, options: { lang: { type: "string" }, theme: { type: "string" }, width: { type: "string" }, height: { type: "string" }, out: { type: "string" }, stress: { type: "string" }, hide: { type: "boolean" } } });
  const lang = values.lang ?? "zh", theme = values.theme ?? "dark", width = Number(values.width ?? 1440);
  if (!["zh", "en"].includes(lang) || !["dark", "light"].includes(theme)) throw new Error("--lang zh|en and --theme dark|light");
  return { lang, theme, width, height: Number(values.height ?? 900), stress: Number(values.stress || 0), hide: !!values.hide, out: values.out ? resolve(values.out) : resolve(repoRoot, `output/qa/source-links/${lang}-${theme}-${width}`) };
}

/** --stress N: a document of N sections with a question linked to every one, opened once; reports how long the underlines take. */
export async function stress(options) {
  scrubProcessEnv();
  await rm(options.out, { recursive: true, force: true });
  const library = join(options.out, "work", "library");
  await mkdir(library, { recursive: true });
  const n = options.stress, text = Array.from({ length: n }, (_, i) => `## Section ${i + 1}\n\nThe scheduler in section ${i + 1} lowers the review interval after a failed recall of item ${i + 1}. Filler sentence number ${i + 1} gives the paragraph some more length so the page is long.`).join("\n\n");
  const server = await createPreviewServer({ libraryRoot: library, home: join(options.out, "work", "home"), port: 0 });
  const api = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: "en" });
  const browser = await launchChromium({});
  try {
    const imported = await api("materials.document.import", { filename: "long.md", title: "Long handbook", course: "Stress", dataBase64: Buffer.from(text).toString("base64") });
    const quotes = Array.from({ length: n }, (_, i) => `The scheduler in section ${i + 1} lowers the review interval after a failed recall of item ${i + 1}.`);
    const selections = [];
    for (const quote of quotes) selections.push((await api("materials.selection.resolve", { documentId: imported.documentId, revision: imported.revision, quote })).selection);
    await new Store(library).update((state) => { state.decks.push({ id: "stress", title: "Stress", course: "Stress", contentVersion: 1, createdAt: new Date().toISOString(), publishedAt: new Date().toISOString(),
      cards: selections.map((selection, i) => ({ id: `c${i}`, kind: "flashcard", topic: "t", objective: `o${i}`, prompt: `Question ${i}?`, answer: "A", hint: "h", explanation: "e", misconception: "m", citations: [{ sourceId: selection.sourceId, quote: selection.quote }], selections: [selection], review: { repetitions: 0 } })) }); });
    const page = await (await browser.newContext({ viewport: { width: options.width, height: options.height } })).newPage();
    await page.addInitScript((hide) => { window.__long = []; try { new PerformanceObserver((list) => { for (const entry of list.getEntries()) window.__long.push(entry.duration); }).observe({ type: "longtask", buffered: true }); } catch { /* unsupported */ } localStorage.setItem("study-ui-language", "en"); if (hide) localStorage.setItem("study-reader-settings", JSON.stringify({ underline: "hide" })); }, options.hide);
    await page.goto(server.url);
    await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await page.locator("nav").getByRole("button", { name: /^\s*Sources/ }).first().click();
    await page.getByRole("button", { name: "Expand all" }).click().catch(() => {});
    await sleep(500);
    await page.evaluate(() => { window.__long = []; window.__t0 = performance.now(); });
    await page.locator(".source-main").first().click();
    await page.waitForFunction(([count, hidden]) => hidden ? document.querySelectorAll(".study-passage-mark").length === count : (CSS.highlights.get("study-link-question")?.size || 0) === count, [n, options.hide], { timeout: 60000 });
    const ms = await page.evaluate(() => performance.now() - window.__t0), longest = await page.evaluate(() => Math.max(0, ...window.__long));
    const scroll = await page.evaluate(async () => {
      const area = document.querySelector(".reader-scroll"), frames = []; let last = performance.now();
      for (let i = 0; i < 60; i++) { area.scrollTop += 400; await new Promise((resolve) => requestAnimationFrame(resolve)); const now = performance.now(); frames.push(now - last); last = now; }
      return { worst: Math.max(...frames), mean: frames.reduce((a, b) => a + b, 0) / frames.length };
    });
    const result = { links: n, underlines: options.hide ? "hidden (markers only)" : "shown", openToUnderlinedMs: Math.round(ms), longestLongTaskMs: Math.round(longest), scrollWorstFrameMs: Math.round(scroll.worst), scrollMeanFrameMs: Math.round(scroll.mean * 10) / 10 };
    console.log(JSON.stringify(result));
    await mkdir(options.out, { recursive: true });
    await writeFile(join(options.out, "stress.json"), JSON.stringify(result, null, 2) + "\n");
    return result;
  } finally { await browser.close().catch(() => {}); await server.close(); }
}

export async function run(options) {
  const removed = scrubProcessEnv();
  await access(resolve(repoRoot, "dist/app.js")).catch(() => { throw new Error("dist/app.js is missing: run `npm run build` first"); });
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  const { lang } = options, t = (zh, en) => (lang === "en" ? en : zh);
  const library = join(options.out, "work", "library");
  // One empty ordinary deck of the same course as the document, so questions can be added to it.
  const course = lang === "en" ? "Learning science / Reading" : "学习科学 / 阅读";
  await mkdir(library, { recursive: true });
  await new Store(library).update((state) => { state.decks.push({ id: "qa-deck", title: lang === "en" ? "Handbook questions" : "手册练习题", course, contentVersion: 0, cards: [], createdAt: new Date().toISOString(), publishedAt: new Date().toISOString() }); });
  const server = await createPreviewServer({ libraryRoot: library, home: join(options.out, "work", "home"), port: 0, model: createFakeModel({ latencyMs: 60 }) });
  const api = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: lang });
  const browser = await launchChromium({ args: [`--lang=${lang === "en" ? "en-US" : "zh-CN"}`] });
  const summary = { options, scrubbedEnv: removed, checks: [], consoleErrors: [], pageErrors: [], apiErrors: [] };
  const check = (name, ok, detail = "") => { summary.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); };
  let shots = 0;
  try {
    const document_ = longDocument(lang);
    const imported = await api("materials.document.import", { filename: "handbook.md", title: document_.title, course, dataBase64: Buffer.from(document_.text).toString("base64") });
    const resolveSelection = async (quote) => (await api("materials.selection.resolve", { documentId: imported.documentId, revision: imported.revision, quote })).selection;
    // Questions linked to passages through the real pipeline (fake model, independent review, append).
    for (const [n, which] of [[3, 0], [12, 1], [30, 2]]) {
      const selection = await resolveSelection(sentence(lang, n, which));
      const result = await api("generation.selection.supplement", { selection, deckId: "qa-deck", operationId: `seed-${n}`, count: 1, kind: "flashcard", expectedVersion: (await api("bank.deck.get", { id: "qa-deck" })).version });
      if (result.status !== "complete") throw new Error(`seeding passage ${n} failed: ${result.status} ${result.error || ""}`);
      if (n === 3) await api("card.followup.add", { deckId: "qa-deck", cardId: result.receipt.cardIds[0], question: t("这和遗忘曲线有什么关系？", "How does this relate to the forgetting curve?"), answer: t("**关系**：失败后缩短间隔，正是为了在遗忘曲线再次下滑前复习。", "**Relation**: shortening the interval after a failure is how the schedule stays ahead of the forgetting curve.") });
    }
    const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: options.theme });
    await context.addInitScript(([language, theme]) => { try { localStorage.setItem("study-ui-language", language); localStorage.setItem("study-theme", theme); localStorage.removeItem("study-reader-settings"); } catch { /* blocked */ } }, [lang, options.theme]);
    const page = await context.newPage();
    let step = "boot";
    page.on("console", (message) => { if (message.type() === "error") summary.consoleErrors.push({ step, text: message.text() }); });
    page.on("pageerror", (error) => summary.pageErrors.push({ step, text: String(error?.stack || error) }));
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/call") || response.ok()) return;
      const body = await response.json().catch(() => ({}));
      summary.apiErrors.push({ step, status: response.status(), error: body.error || "" });
    });
    const shot = async (name) => { step = name; await sleep(350); await page.screenshot({ path: join(options.out, `${String(++shots).padStart(2, "0")}-${name}.png`) }); };
    const highlightCount = (name) => page.evaluate((key) => { const h = CSS.highlights.get(key); return h ? h.size : 0; }, name);
    const markerCount = () => page.locator(".study-passage-mark").count();

    await page.goto(server.url);
    await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await sleep(800);
    await page.locator("nav").getByRole("button", { name: new RegExp(`^\\s*${t("资料", "Sources")}`) }).first().click();
    await sleep(500);
    await page.getByRole("button", { name: t("全部展开", "Expand all") }).click().catch(() => {});
    await page.locator(".source-main").first().click();
    await page.locator(".study-document-viewer").waitFor({ timeout: 15000 });
    await page.locator(".reader-html, .reader-section").first().waitFor({ timeout: 15000 });
    await sleep(700);
    await shot("reader-with-underlines");
    check("questions are underlined with the question style", await highlightCount("study-link-question") === 3, `count ${await highlightCount("study-link-question")}`);
    check("each linked passage has its [n] marker", await markerCount() === 3, `markers ${await markerCount()}`);

    // Ask about a passage that has no link yet, then save the answer as a flashcard.
    const target = sentence(lang, 20, 1);
    const selectPassage = (text) => page.evaluate((needle) => {
      const body = document.querySelector(".study-document-body"), walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent.indexOf(needle);
        if (at < 0) continue;
        node.parentElement.scrollIntoView({ block: "center" });
        const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + needle.length);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return true;
      }
      return false;
    }, text);
    check("a passage can be selected", await selectPassage(target));
    await sleep(500);
    // Narrow panes: the learning panel slides over the text and is opened from the toolbar.
    const narrow = options.width < 900;
    if (narrow) { await page.locator('[data-tour="source-tools-toggle"]').click(); await sleep(400); }
    await page.locator(".study-document-learning textarea").fill(t("这里为什么用提取练习？", "Why retrieval practice here?"));
    await page.getByRole("button", { name: t("依据原文回答", "Answer using the source") }).click();
    await page.locator(".study-grounded-answer").waitFor({ timeout: 15000 });
    await shot("answer-with-save-button");
    const save = page.getByRole("button", { name: t("存成闪卡", "Save as flashcard") });
    check("the save button appears under the answer", await save.count() === 1);
    await save.dblclick();
    await page.locator(".study-qa-saved").waitFor({ timeout: 15000 });
    await sleep(500);
    await shot("saved-line");
    const deckList = (await api("bank.decks.list")).decks;
    const qaDeck = deckList.find((deck) => deck.title === t("原文问答", "Source Q&A"));
    check("a double click made one deck with one card", deckList.filter((deck) => deck.title === t("原文问答", "Source Q&A")).length === 1 && qaDeck?.cards === 1, JSON.stringify(deckList.map((d) => [d.title, d.cards])));
    check("the saved passage is underlined as a Q&A card", await highlightCount("study-link-qa") === 1, `count ${await highlightCount("study-link-qa")}`);
    check("the result line reads as specified", (await page.locator(".study-qa-saved").innerText()).replace(/\s+/g, " ").includes(`${t("已存为闪卡", "Saved as a flashcard")} · ${t("打开这道题", "Open this question")}`));

    // Another answer, this time into the deck picked in the panel (with its version check).
    check("another passage can be selected", await selectPassage(sentence(lang, 25, 2)));
    await sleep(500);
    await page.locator(".study-document-learning textarea").fill(t("为什么只考查一个要点？", "Why only one point?"));
    await page.getByRole("button", { name: t("依据原文回答", "Answer using the source") }).click();
    await page.locator(".study-grounded-answer").waitFor({ timeout: 15000 });
    await page.locator(".study-document-learning select").first().selectOption("qa-deck");
    await page.getByRole("button", { name: t("存成闪卡", "Save as flashcard") }).click();
    await page.locator(".study-qa-saved").waitFor({ timeout: 15000 });
    await sleep(500);
    check("the answer went into the chosen deck", (await api("bank.decks.list")).decks.find((deck) => deck.id === "qa-deck")?.cards === 4);
    check("both Q&A passages are underlined", await highlightCount("study-link-qa") === 2, `count ${await highlightCount("study-link-qa")}`);

    // Click an underlined passage: its links open in the learning panel, with the follow-up Q&A.
    const clickHighlight = (name, index = 0) => page.evaluate(([key, at]) => {
      const range = [...CSS.highlights.get(key)][at]; range.startContainer.parentElement.scrollIntoView({ block: "center" });
      const rect = range.getClientRects()[0];
      return { x: rect.left + Math.min(rect.width / 2, 40), y: rect.top + rect.height / 2 };
    }, [name, index]);
    await page.evaluate(() => getSelection().removeAllRanges());
    if (narrow) { await page.locator(".reader-scrim").click({ position: { x: 5, y: 300 } }); await sleep(400); }
    const point = await clickHighlight("study-link-question", 0);
    await sleep(200);
    await page.mouse.move(point.x, point.y);
    await sleep(250);
    check("hovering an underline names what is linked", ((await page.locator(".study-document-body").getAttribute("title")) || "").length > 0);
    await page.mouse.click(point.x, point.y);
    await sleep(500);
    check("clicking an underline focuses that passage in the list", await page.locator(".reader-link-group[data-focused]").count() === 1);
    await page.locator(".reader-link-item__qa > summary").first().click();
    await sleep(300);
    check("the extra Q&A of the question is listed", await page.locator(".reader-link-item__followup").count() === 1);
    await shot("underline-opened-with-followup");

    // The jump: open the saved card from the list.
    await page.getByRole("button", { name: t("显示全部引用", "Show all citations") }).click();
    await sleep(300);
    await page.locator(".reader-link-group > summary").nth(2).click().catch(() => {});
    await shot("all-links");
    await page.getByRole("button", { name: t("打开这道题", "Open this question") }).first().click();
    await page.locator(".question-card, .flashcard").first().waitFor({ timeout: 15000 });
    await sleep(500);
    await shot("opened-card");
    check("the jump lands on a card", await page.locator(".question-card").count() >= 1);
    await page.getByRole("button", { name: t("返回资料", "Back to source") }).first().click().catch(() => {});

    // Keyboard: the [n] marker after a passage is a button; Enter opens that passage's links.
    if (await page.locator(".study-document-viewer").count()) {
      if (narrow) await page.locator(".reader-scrim").click({ position: { x: 5, y: 300 } }).catch(() => {});
      await page.getByRole("button", { name: t("显示全部引用", "Show all citations") }).click().catch(() => {});
      await page.locator(".study-passage-mark button").nth(1).focus();
      await page.keyboard.press("Enter");
      await sleep(400);
      check("Tab/Enter on a [n] marker opens that passage's links", await page.locator(".reader-link-group[data-focused]").count() === 1);
    }

    // Display settings: hide the underlines, live.
    if (await page.locator(".study-document-viewer").count()) {
      await page.getByRole("button", { name: t("显示设置", "Display settings") }).click();
      await sleep(200);
      await shot("display-settings");
      check("the popover has the underline row", await page.getByText(t("下划线", "Link underlines"), { exact: true }).count() === 1);
      await page.getByRole("button", { name: t("隐藏", "Hide"), exact: true }).click();
      await sleep(400);
      const hidden = (await highlightCount("study-link-question")) + (await highlightCount("study-link-qa"));
      check("hiding paints nothing, markers stay", hidden === 0 && await markerCount() >= 3, `highlights ${hidden}, markers ${await markerCount()}`);
      await shot("underlines-hidden");
      await page.getByRole("button", { name: t("显示", "Show"), exact: true }).click();
      await sleep(400);
      check("showing paints them again without a reload", await highlightCount("study-link-question") === 3 && await highlightCount("study-link-qa") === 2);
      await page.getByRole("button", { name: t("恢复默认", "Reset") }).click().catch(() => {});
    }

    // The document is revised: links to the old revision are no longer underlined and wait to be selected again.
    await page.keyboard.press("Escape");
    await sleep(400);
    await page.keyboard.press("Escape");
    await sleep(400);
    await api("materials.document.import", { documentId: imported.documentId, filename: "handbook.md", title: document_.title, course,
      dataBase64: Buffer.from(`${t("修订说明", "Revision note")}\n\n${document_.text}`).toString("base64") });
    await page.locator(".source-main").first().click();
    await page.locator(".study-document-viewer").waitFor({ timeout: 15000 });
    await page.locator(".reader-html, .reader-section").first().waitFor({ timeout: 15000 });
    await sleep(900);
    if (narrow) await page.locator('[data-tour="source-tools-toggle"]').click();
    await sleep(300);
    check("after a revision nothing is underlined from the old links", (await highlightCount("study-link-question")) + (await highlightCount("study-link-qa")) === 0);
    check("they are listed as needing a new selection", await page.locator(".reader-links__stale").count() === 1);
    await page.locator(".reader-links__stale > summary").click();
    await sleep(300);
    await shot("stale-links");
  } finally {
    summary.ok = !summary.pageErrors.length && summary.checks.every((item) => item.ok);
    await writeFile(join(options.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    await browser.close().catch(() => {});
    await server.close();
  }
  return summary;
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.stress) { await stress(options); process.exit(0); }
    const summary = await run(options);
    console.log(`${summary.ok ? "Passed" : "FAILED"}: ${options.out} (page errors ${summary.pageErrors.length}, console errors ${summary.consoleErrors.length}, API errors ${summary.apiErrors.length})`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) { console.error(error?.message || error); process.exitCode = 2; }
}
