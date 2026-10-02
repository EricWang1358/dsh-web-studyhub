/* global document, window, getSelection, getComputedStyle, NodeFilter, MouseEvent -- used inside page.evaluate callbacks, which run in the browser */
/* npm run qa:translation [-- --lang zh|en --theme dark|light --width 1440|1194|420 --model fake|none --out <dir>]
   The bilingual reading of the reader (译) in the browser preview: a seeded temporary library (a Markdown document and a plain text,
   in the language the interface does not translate into), a fake model that answers like a careful translator, Chromium, every
   key/token/base-url variable removed. One screenshot per step and a layout audit after each (no horizontal overflow, no overlap,
   translations aligned with their paragraph in 左右分栏, panels inside the reader); <out>/summary.json lists steps, audits, console
   errors, page errors and failed API calls, and the exit code is non-zero when a step fails or the page throws.
   --model none: no model is connected, and the reader says so plainly. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStudyRuntime } from "../../lib/runtime/builtins.js";
import { createPreviewServer } from "../preview-server.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { reportUsage } from "../../lib/usage-scope.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith("--")) values[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  const lang = values.lang ?? "zh", theme = values.theme ?? "dark", width = Number(values.width ?? 1440), model = values.model ?? "fake";
  if (!["fake", "none"].includes(model)) throw new Error("--model must be fake or none");
  return { lang, theme, width, model, height: Number(values.height ?? (width < 700 ? 900 : 940)), out: resolve(values.out ?? join(repoRoot, `output/qa/translation/${lang}-${theme}-${width}`)) };
}

/* ---------- the fixture: what the interface does not translate into, with its translation ---------- */

const PAIRS = [
  ["A platform lets two groups of users find each other and trade. The rules of the platform change what each group does.", "平台让两类用户找到彼此并进行交易。平台的规则会改变每一类用户的行为。"],
  ["Network effects mean that each additional user makes the platform more valuable for everyone else on it.", "网络效应是指每多一位用户，平台对其上其他所有人就更有价值。"],
  ["In 2024 the firm charged 3.5% per transaction and reached 120 million users, mostly through free access for one side of the market.", "2024 年，这家公司每笔交易收取 3.5%，用户达到 1.2 亿，主要靠对市场一侧免费开放。"],
  ["A CQRS design separates the read model from the write model, which lowers latency for readers and keeps writes simple.", "命令查询职责分离的设计把读模型和写模型分开，既降低了读者的延迟，也让写入保持简单。"],
  ["Platforms often subsidise one side of the market because the other side pays more when the subsidised side is large.", "平台常常补贴市场的一侧，因为被补贴的一侧规模越大，另一侧愿意付的钱就越多。"],
  ["Multi-homing lets users join several platforms at once, so lock-in depends on switching costs rather than on exclusivity.", "多平台接入让用户可以同时加入多个平台，所以锁定取决于转换成本，而不是排他性。"],
  ["Regulators ask whether a platform that sets the rules for others can also compete against them.", "监管者会问：一个为他人制定规则的平台，是否也能同他们竞争。"],
  ["Interoperability duties can reduce lock-in, but they also change how much a platform will invest in its own users.", "互操作义务可以减少锁定，但也会改变平台愿意为自己的用户投入多少。"],
];
const KEEP = { CQRS: "命令查询职责分离" };
/** A Chinese term and the English the dictionary renders it as, so a fixed translation from the glossary shows in the answer. */
const RENDERED = { 网络效应: "Network effects" };
const sayEnglish = (zh) => PAIRS.find(([, chinese]) => chinese === zh)?.[0];

/** The two documents, in the language the learner reads in the other language of: English text for a Chinese interface, Chinese text for an English one. */
function content(lang) {
  const english = lang === "zh", text = (index) => PAIRS[index][english ? 0 : 1];
  const heading = (en, zh) => (english ? en : zh);
  const md = [`# ${heading("Platform Economics Notes", "平台经济学笔记")}`, "", text(0), "", text(1), "", `## ${heading("Pricing and subsidies", "定价与补贴")}`, "", text(2), "", text(3), "", text(4), "",
    `## ${heading("Governance", "治理")}`, "", text(5), "", text(6), "", english ? "平台让两类人群找到彼此。" : "Platforms let two groups find each other.", ""].join("\n");
  const txt = [heading("Lecture notes, week 3", "第三周课堂笔记"), "", text(1), "", text(3), "", text(6), "", text(7), ""].join("\n");
  return { english, md, txt, p0: text(0).slice(0, 36), p1: text(1).slice(0, 30), cqrs: english ? "CQRS design" : "命令查询职责分离", sentence: english ? "The rules of the platform change what each group does." : "平台的规则会改变每一类用户的行为。",
    term: english ? "CQRS" : "网络效应", fixed: english ? "" : "the network effect", affected: english ? "A CQRS design" : "网络效应是指" };
}

/** A translator that answers each passage the way the fixture says, adds a mark for the learner's comment and keeps glossary terms. */
function translator({ latencyMs, signalOnly = false }) {
  return async (system, prompt, options = {}) => {
    const data = JSON.parse(prompt), toEnglish = data.target === "English";
    await new Promise((done, fail) => { const timer = setTimeout(done, latencyMs); options.signal?.addEventListener("abort", () => { clearTimeout(timer); fail(options.signal.reason); }, { once: true }); });
    options.signal?.throwIfAborted();
    if (!signalOnly) reportUsage({ uncachedInputTokens: 650, outputTokens: 240, cacheReadTokens: 0, cacheWriteTokens: 0 }, { calls: 1 });
    const translations = data.passages.map((passage) => {
      let text = toEnglish ? sayEnglish(passage.text) : PAIRS.find(([english]) => english === passage.text)?.[1];
      if (!text) text = toEnglish ? `This paragraph says: ${passage.text.length} characters of Chinese text, rendered in English for the reading.` : `这一段（${passage.text.length} 个字符）的中文译文。`;
      for (const entry of data.glossary || []) {
        if (entry.rule.startsWith("keep") && KEEP[entry.term]) text = text.replaceAll(KEEP[entry.term], entry.term);
        if (entry.rule.startsWith("translate as: ") && RENDERED[entry.term]) text = text.replaceAll(RENDERED[entry.term], entry.rule.slice("translate as: ".length));
      }
      if (data.learnerComment) text += toEnglish ? " (adjusted as you asked)" : "（已按你的意见调整）";
      return { id: passage.id, text };
    });
    return JSON.stringify({ translations });
  };
}

async function seed(root, lang) {
  const runtime = createStudyRuntime(root);
  const { md, txt } = content(lang);
  await runtime.call("materials.document.import", { filename: "platform-notes.md", dataBase64: Buffer.from(md).toString("base64"), courses: ["QA"] });
  await runtime.call("materials.document.import", { filename: "lecture-notes.txt", dataBase64: Buffer.from(txt).toString("base64"), courses: ["QA"] });
  runtime.dispose();
}

/* ---------- the layout audit, run in the page ---------- */

/** Everything the audit measures, as problems in words; an empty list is a pass. */
const AUDIT = () => {
  const problems = [], viewer = document.querySelector(".study-document-viewer"), scroller = document.querySelector(".reader-scroll"), page = document.querySelector(".reader-page");
  const box = (element) => element.getBoundingClientRect();
  if (scroller && scroller.scrollWidth - scroller.clientWidth > 1) problems.push(`horizontal overflow of the reading area (${scroller.scrollWidth} > ${scroller.clientWidth})`);
  if (document.documentElement.scrollWidth - window.innerWidth > 1) problems.push("the page scrolls sideways");
  const mode = page?.dataset.trMode || "none", hosts = [...document.querySelectorAll(".tr-host")].filter((host) => getComputedStyle(host).display !== "none");
  const rects = hosts.map((host) => ({ host, rect: box(host) }));
  for (const { host, rect } of rects) {
    if (host.scrollWidth - host.clientWidth > 1) problems.push("a translation block overflows its box");
    const paragraph = host.previousElementSibling && !host.previousElementSibling.classList.contains("tr-host") ? host.previousElementSibling : null;
    if (!paragraph) continue;
    const above = box(paragraph);
    if (mode === "side" && getComputedStyle(host.parentElement).display === "grid") {
      if (Math.abs(above.top - rect.top) > 1.5) problems.push(`side by side: a pair is not aligned (${Math.round(above.top)} vs ${Math.round(rect.top)})`);
      if (rect.left < above.right - 1) problems.push("side by side: the translation is not to the right of its paragraph");
    } else if (rect.top < above.bottom - 1 && getComputedStyle(paragraph).display !== "-webkit-box") problems.push("a translation block overlaps its paragraph");
  }
  for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) {
    const a = rects[i].rect, b = rects[j].rect;
    if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) problems.push("two translation blocks overlap");
  }
  const bounds = viewer ? box(viewer) : null;
  for (const panel of document.querySelectorAll(".reader-popover__panel, .tr-menu__list, .tr-float")) {
    const r = box(panel);
    if (bounds && (r.left < bounds.left - 1 || r.right > bounds.right + 1)) problems.push(`a panel leaves the reader (${panel.className.split(" ")[0]})`);
  }
  for (const mark of document.querySelectorAll(".tr-mark__btn")) {
    const r = box(mark), area = scroller ? box(scroller) : null;
    if (r.width && area && r.right > area.right + 1) { problems.push("a 译 mark sticks out of the reading area"); break; }
  }
  return { mode, hosts: hosts.length, marks: document.querySelectorAll(".tr-mark").length, problems };
};

export async function runTranslationQa(options) {
  const removed = scrubProcessEnv();
  await rm(options.out, { recursive: true, force: true });
  await mkdir(options.out, { recursive: true });
  const library = join(options.out, "work", "library");
  await mkdir(library, { recursive: true });
  await seed(library, options.lang);
  const doc = content(options.lang), model = options.model === "none" ? null : translator({ latencyMs: 650 });
  const server = await createPreviewServer({ libraryRoot: library, home: join(options.out, "work", "home"), port: 0, model });
  const browser = await launchChromium({ args: [`--lang=${options.lang === "en" ? "en-US" : "zh-CN"}`] });
  const summary = { startedAt: new Date().toISOString(), options, url: server.url, scrubbedEnv: removed, steps: [], audits: [], consoleErrors: [], pageErrors: [], apiErrors: [] };
  try {
    const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1, locale: options.lang === "en" ? "en-US" : "zh-CN", colorScheme: options.theme, permissions: ["clipboard-read", "clipboard-write"] });
    await context.addInitScript(([lang, theme]) => { try { localStorage.setItem("study-ui-language", lang); localStorage.setItem("study-theme", theme); localStorage.removeItem("study-reader"); localStorage.removeItem("study-reader-translation"); localStorage.removeItem("study-reader-settings"); } catch { /* blocked */ } }, [options.lang, options.theme]);
    const page = await context.newPage();
    let current = "boot", n = 0;
    page.on("console", (message) => { if (message.type() === "error") summary.consoleErrors.push({ step: current, text: message.text() }); });
    page.on("pageerror", (error) => summary.pageErrors.push({ step: current, text: String(error?.stack || error) }));
    page.on("response", async (response) => {
      if (!response.url().endsWith("/api/call") || response.ok()) return;
      const body = await response.json().catch(() => ({}));
      summary.apiErrors.push({ step: current, status: response.status(), error: body.error || "" });
    });
    const zh = options.lang === "zh", t = (chinese, english) => (zh ? chinese : english);
    const shot = async (name) => { await sleep(350); const file = `${String(++n).padStart(2, "0")}-${name}.png`; await page.screenshot({ path: join(options.out, file) }); return file; };
    const step = async (name, run, { audit = true } = {}) => {
      current = name;
      const record = { name, status: "ok" };
      try {
        await run();
        if (audit) { const result = await page.evaluate(AUDIT); record.audit = result; summary.audits.push({ step: name, ...result }); if (result.problems.length) { record.status = "failed"; record.error = result.problems.join("; "); } }
        record.shot = await shot(name);
      } catch (error) { record.status = "failed"; record.error = String(error?.message || error).split("\n")[0]; await shot(`${name}-failed`).catch(() => {}); }
      summary.steps.push(record);
      console.log(`${record.status === "ok" ? "ok  " : "FAIL"} ${name}${record.error ? ` — ${record.error}` : ""}`);
    };
    const viewer = page.locator(".study-document-viewer");
    const openRow = async (title) => { await page.locator(".source-doc", { hasText: title }).locator(".source-main").click(); await viewer.waitFor(); await sleep(700); };
    const closeReader = async () => { await page.keyboard.press("Escape"); await sleep(400); if (await page.locator("dialog[open]").count()) await page.locator("dialog[open]").getByRole("button", { name: t("关闭", "Close") }).first().click().catch(() => {}); await sleep(400); };
    const paragraph = (text) => viewer.locator(".reader-html > p, .reader-prose > .reader-p, .reader-html li").filter({ hasText: text }).first();
    const mark = (text) => paragraph(text).locator(".tr-mark__btn");
    const blockAfter = (text) => paragraph(text).locator("xpath=following-sibling::*[1][contains(@class,'tr-host')]");
    const openDisplay = async () => { if (!(await viewer.locator(".reader-popover__panel[aria-label]").count())) await viewer.getByRole("button", { name: t("显示设置", "Display settings"), exact: true }).click(); await viewer.locator(".tr-modes").waitFor(); };
    const setMode = async (label) => { await openDisplay(); await viewer.locator(".tr-modes__item", { hasText: label }).click(); await page.keyboard.press("Escape"); await sleep(250); };
    const labels = { pairs: t("逐段对照", "Paragraph pairs"), side: t("左右分栏", "Side by side"), only: t("仅中文", "English only"), hidden: t("隐藏译文", "Hide translations") };
    const toggleTools = async () => { await viewer.getByRole("button", { name: t("学习工具", "Study tools"), exact: true }).click(); await sleep(300); };
    const toggleOutline = async () => { await viewer.getByRole("button", { name: t("目录", "Contents"), exact: true }).click().catch(() => {}); await sleep(300); };
    const select = (phrase) => page.evaluate((words) => {
      const body = document.querySelector(".study-document-body"), walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf(words);
        if (at >= 0 && !node.parentElement.closest("[data-study-marker]")) {
          const range = document.createRange(); range.setStart(node, at); range.setEnd(node, at + words.length);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
          body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); return true;
        }
      }
      return false;
    }, phrase);
    const popover = () => viewer.locator(".tr-panel");
    const openMenu = async () => { if (!(await popover().count())) await viewer.locator(".tr-toolbar-button").click(); await popover().waitFor(); await viewer.locator(".tr-scope[data-status='ready']").first().waitFor({ timeout: 15000 }); };
    // A toast that a job left (6 seconds, held while the pointer rests on it) must not sit on the next dialog's buttons.
    const clearToasts = async () => { await page.mouse.move(2, 2); await page.waitForFunction(() => !document.querySelector(".sh-toast"), null, { timeout: 15000 }).catch(() => {}); };
    const closeMenu = async () => { if (await popover().count()) await viewer.locator(".tr-toolbar-button").click(); await sleep(200); };

    await page.goto(server.url);
    await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await sleep(800);
    await page.locator('[data-tour="nav-sources"]').first().click().catch(() => page.getByRole("button", { name: t("资料", "Sources") }).first().click());
    await sleep(800);
    await step("sources-list", async () => { await page.locator(".source-doc").first().waitFor(); }, { audit: false });
    await step("reader-open", async () => { await openRow("platform-notes"); await viewer.locator(".tr-mark").first().waitFor({ timeout: 15000 }); });
    if (options.width < 900) { /* the panels slide over the text on a narrow reader; nothing to close */ } else await step("close-outline", async () => { await toggleOutline(); });

    if (options.model === "none") {
      await step("no-model-click", async () => { await paragraph(doc.p1).hover(); await mark(doc.p1).click(); await viewer.locator('.tr-block[data-state="error"]').waitFor(); });
      await step("no-model-menu", async () => { await openMenu(); await popover().getByText(t("还没有连接模型", "No model is connected")).waitFor(); });
      return summary;
    }

    await step("marks-hover", async () => { await paragraph(doc.p1).hover(); await sleep(250); });
    await step("translate-paragraph", async () => {
      await mark(doc.p1).click();
      await viewer.locator('.tr-mark[data-tr-state="translating"]').waitFor();
      await blockAfter(doc.p1).locator(".tr-block").waitFor({ timeout: 15000 });
      await blockAfter(doc.p1).locator(".tr-block__text").waitFor();
    });
    await step("collapse-expand", async () => {
      await blockAfter(doc.p1).getByRole("button", { name: t("收起译文", "Collapse translation") }).click();
      await blockAfter(doc.p1).locator(".tr-block__preview").waitFor();
      await shot("collapsed");
      await blockAfter(doc.p1).getByRole("button", { name: t("展开译文", "Expand translation") }).click();
      await blockAfter(doc.p1).locator(".tr-block__text").waitFor();
    });
    await step("selection-chip", async () => {
      await select(doc.sentence);
      await page.locator(".tr-chipbtn").waitFor();
    });
    await step("translate-selection", async () => {
      await page.locator(".tr-chipbtn").click();
      await viewer.locator(".tr-block[data-kind='selection']").waitFor({ timeout: 15000 });
    });
    await step("side-by-side-crowded", async () => { await setMode(labels.side); await sleep(300); });
    if (options.width >= 900) {
      await step("side-by-side", async () => { await toggleTools(); await sleep(400); });
      await step("side-by-side-more", async () => { await mark(doc.cqrs).click(); await blockAfter(doc.cqrs).locator(".tr-block__text").waitFor({ timeout: 15000 }); });
    }
    await step("only-chinese", async () => { await setMode(labels.only); await viewer.locator("[data-tr-clamp='true']").first().waitFor(); });
    await step("only-chinese-unfold", async () => { await viewer.locator("[data-tr-clamp='true']").first().click(); await sleep(300); });
    await step("hidden", async () => { await setMode(labels.hidden); await sleep(300); if (await viewer.locator(".tr-host:visible").count()) throw new Error("a translation shows in 隐藏译文"); });
    await step("hidden-peek", async () => { await mark(doc.p1).click(); await blockAfter(doc.p1).locator(".tr-block__text").waitFor(); });
    await step("pairs-again", async () => { await setMode(labels.pairs); await sleep(300); });
    await step("menu-prices-first", async () => { await openMenu(); await popover().locator("[data-token-estimate]").first().waitFor(); });
    await step("job-running", async () => {
      await popover().locator(".tr-scope").last().getByRole("button", { name: t("开始翻译", "Start translating") }).click();
      await viewer.locator(".tr-job[data-status='running'], .tr-job[data-status='queued']").waitFor({ timeout: 15000 });
      await sleep(500);
    });
    await step("job-reading-stays", async () => { await page.mouse.wheel(0, 300); await sleep(300); });
    await step("job-done", async () => {
      await viewer.locator(".tr-job[data-status='complete']").waitFor({ timeout: 60000 });
      await page.waitForFunction(() => document.querySelectorAll(".tr-mark[data-tr-state='has']").length >= 5, null, { timeout: 15000 });
    });
    await step("job-dismiss", async () => { await viewer.locator(".tr-job").getByRole("button", { name: t("知道了", "Got it") }).click(); await sleep(250); });
    await step("retranslate-ask", async () => {
      await blockAfter(doc.p0).getByRole("button", { name: t("这段译文的更多操作", "More actions for this translation") }).click();
      await page.getByRole("menuitem", { name: t("重新翻译…", "Retranslate…") }).click();
      await blockAfter(doc.p0).locator(".tr-ask__input").fill(t("更口语一点", "more conversational"));
    });
    await step("retranslate-v2", async () => {
      await blockAfter(doc.p0).locator(".tr-ask__input").press("Enter");
      await blockAfter(doc.p0).locator(".tr-chip", { hasText: /v2/ }).waitFor({ timeout: 15000 });
    });
    await step("copy", async () => {
      await blockAfter(doc.p0).getByRole("button", { name: t("这段译文的更多操作", "More actions for this translation") }).click();
      await page.getByRole("menuitem", { name: t("复制译文", "Copy translation") }).click();
      await page.getByRole("menuitem", { name: t("已复制", "Copied") }).waitFor();
      await page.keyboard.press("Escape");
    });
    await step("delete-undo", async () => {
      await blockAfter(doc.p0).getByRole("button", { name: t("这段译文的更多操作", "More actions for this translation") }).click();
      await page.getByRole("menuitem", { name: t("删除这段翻译", "Delete this translation") }).click();
      await viewer.locator(".tr-block[data-state='undo']").waitFor();
      await shot("deleted");
      await viewer.locator(".tr-block[data-state='undo']").getByRole("button", { name: t("撤销", "Undo") }).click();
      await blockAfter(doc.p0).locator(".tr-block__text").waitFor({ timeout: 10000 });
    });
    await step("glossary-open", async () => {
      await clearToasts();
      await blockAfter(doc.p0).getByRole("button", { name: t("这段译文的更多操作", "More actions for this translation") }).click();
      await page.getByRole("menuitem", { name: t("术语表…", "Glossary…") }).click();
      await page.locator("dialog[open] .tr-gloss").waitFor();
      await page.locator("dialog[open] .tr-gloss__term").first().fill(doc.term);
      if (doc.fixed) { await page.locator("dialog[open] .tr-gloss__mode").first().selectOption("fixed"); await page.locator("dialog[open] .tr-gloss__to").first().fill(doc.fixed); }
    }, { audit: false });
    await step("glossary-saved", async () => {
      await clearToasts();
      await page.locator("dialog[open]").getByRole("button", { name: t("保存术语表", "Save glossary") }).click();
      await page.locator("dialog[open] .tr-gloss__result").waitFor({ timeout: 15000 });
    }, { audit: false });
    await step("glossary-retranslate", async () => {
      await clearToasts();
      await page.locator("dialog[open] .tr-gloss__result").getByRole("button", { name: t(/重新翻译这 \d+ 段/, /Retranslate these \d+ paragraphs/) }).click();
      await viewer.locator(".tr-job").waitFor({ timeout: 15000 });
      await viewer.locator(".tr-job[data-status='complete']").waitFor({ timeout: 30000 });
      await blockAfter(doc.affected).locator(".tr-block__text", { hasText: doc.fixed || doc.term }).waitFor({ timeout: 15000 });
    });
    await step("target-switch", async () => {
      await clearToasts();
      await openMenu();
      await popover().getByRole("button", { name: options.lang === "zh" ? "English" : t("简体中文", "Simplified Chinese") }).click();
      await sleep(900);
    });
    await step("target-back", async () => {
      await openMenu();
      await popover().getByRole("button", { name: options.lang === "zh" ? "简体中文" : "English" }).click();
      await sleep(900); await closeMenu();
    });
    await step("original-view", async () => {
      await viewer.getByRole("radio", { name: t("原文", "Original text"), exact: true }).click().catch(() => viewer.getByRole("button", { name: t("原文", "Original text"), exact: true }).click());
      await sleep(600); await select(doc.sentence); await page.locator(".tr-chipbtn").waitFor();
      await page.locator(".tr-chipbtn").click(); await viewer.locator(".tr-float .tr-block__text").waitFor({ timeout: 15000 });
    });
    await closeReader();
    await step("text-source", async () => {
      await openRow("lecture-notes");
      await viewer.locator(".tr-mark").first().waitFor({ timeout: 15000 });
      await paragraph(doc.p1).hover(); await mark(doc.p1).click();
      await blockAfter(doc.p1).locator(".tr-block__text").waitFor({ timeout: 15000 });
    });
    await step("text-source-side", async () => {
      await setMode(labels.side); await sleep(400);
    });
    return summary;
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.ok = !summary.pageErrors.length && summary.steps.every((item) => item.status === "ok");
    await writeFile(join(options.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    await browser.close().catch(() => {});
    await server.close();
  }
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  try {
    const options = parseArgs(process.argv.slice(2)), summary = await runTranslationQa(options);
    console.log(`${summary.ok ? "Translation QA passed" : "Translation QA FAILED"}: ${options.out} (page errors ${summary.pageErrors.length}, console errors ${summary.consoleErrors.length}, API errors ${summary.apiErrors.length})`);
    process.exitCode = summary.ok ? 0 : 1;
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 2;
  }
}
