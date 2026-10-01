/* node scripts/qa/wp28-shots.mjs [--lang zh|en] [--theme dark|light] [--out <dir>]
   Large-textbook screens (WP28) at 1440 and 420 px, in the browser preview:
   a too-large PDF dropped on the import dialog, a converted book chosen by
   chapter, the Settings "扩展：文档转换与检索" section with a DSH search tool
   detected and with none, and the generate page with a selection over the limit.
   Two preview servers run one after the other (each has its own DSH_HOME, which
   holds the chosen search tool): one plays a DSH that exposes a document-search
   tool (STUDY_FAKE_RETRIEVAL), the other exposes none. Every key/token/base-url
   variable is removed from the environment first. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const lang = flag("lang", "zh"), theme = flag("theme", "dark"), out = resolve(flag("out", join(repoRoot, "output/qa/wp28")));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const TOPICS = ["进程与线程", "进程调度", "死锁", "内存管理", "分页与分段", "虚拟内存", "文件系统", "磁盘调度", "设备管理", "同步与互斥"];
const sentence = (topic, n) => `${topic}是操作系统中的核心内容之一，第 ${n} 节讨论它的定义、基本机制和常见取舍，并结合例子说明在什么情况下应当选择哪一种做法。`;
/** A converted textbook in StudyHub's generic page-marker Markdown. */
function book(title, pages, perChapter, repeat) {
  return Array.from({ length: pages }, (_, i) => {
    const topic = TOPICS[Math.floor(i / perChapter) % TOPICS.length];
    const heading = i % perChapter === 0 ? `# 第 ${Math.floor(i / perChapter) + 1} 章 ${topic}\n` : "";
    return `<!-- page: ${i + 1} -->\n${i === 0 ? `# ${title}\n` : ""}${heading}${sentence(topic, i + 1).repeat(repeat)}`;
  }).join("\n\n");
}

async function start(name, port, retrieval) {
  const libraryRoot = join(out, name, "library"), home = join(out, name, "home");
  await rm(join(out, name), { recursive: true, force: true });
  const server = await createPreviewServer({ libraryRoot, home, port, model: createFakeModel({ latencyMs: 100 }), retrieval });
  const call = (action, input = {}) => previewCall(server, action, { ...input, uiLanguage: lang });
  const put = (filename, text) => call("materials.document.import", { dataBase64: Buffer.from(text, "utf8").toString("base64"), filename, courses: ["操作系统"] });
  await put("操作系统（转换结果）.md", book("操作系统", 48, 12, 8));
  await put("大教材（转换结果）.md", book("大教材 · 计算机系统", 300, 25, 40));
  return { server, call };
}

async function main() {
  scrubProcessEnv();
  await mkdir(out, { recursive: true });
  const browser = await launchChromium();
  const bigPdf = join(out, "textbook.pdf");
  await writeFile(bigPdf, Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(9 * 1024 * 1024)]));
  const shots = [];
  for (const [name, port, retrieval] of [["tool", 4430, "fake"], ["none", 4431, null]]) {
    const running = await start(name, port, retrieval);
    if (retrieval) await running.call("retrieval.set", { provider: "mcp:mcp__books__query_documents" });
    try {
      for (const width of [1440, 420]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
        await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); } catch { /* blocked */ } }, [lang, theme]);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        const settle = async (ms = 600) => { await page.waitForLoadState("networkidle").catch(() => {}); await sleep(ms); };
        const shot = async (label, locator) => {
          const path = join(out, `${width}-${lang}-${theme}-${label}.png`);
          await (locator ? locator.screenshot({ path }) : page.screenshot({ path }));
          shots.push(path);
        };
        const open = async () => { await page.goto(running.server.url); await page.locator("aside, nav").first().waitFor({ timeout: 30000 }); await settle(800); };
        const nav = async (id) => { await page.locator(`[data-tour="nav-${id}"]`).first().click(); await settle(); };
        if (name === "none") {
          // 1. A PDF over 8 MB, dropped on the import dialog (no tool detected).
          await open(); await nav("sources");
          await page.locator('[data-tour="sources-add"]').first().click(); await settle(400);
          await page.locator('dialog[open] input[type="file"]').first().setInputFiles(bigPdf); await settle(900);
          await page.locator("dialog[open] .large-doc").scrollIntoViewIfNeeded().catch(() => {});
          await shot("1-too-large-pdf");
        } else {
          // 2. A converted book, chosen by chapter.
          await open(); await nav("generate"); await sleep(300);
          await page.getByRole("button", { name: /选择章节|Choose chapters/ }).first().click(); await settle(400);
          await page.locator(".source-picker__chapter-list input").nth(1).check().catch(() => {});
          await page.locator(".source-picker__chapter-list input").nth(2).check().catch(() => {});
          await page.locator(".source-picker").first().scrollIntoViewIfNeeded();
          await shot("2-chapters");
        }
        // 3. Settings: a DSH search tool detected, or none.
        await open(); await nav("settings");
        const section = page.locator('[data-tour="settings-extensions"]');
        await section.waitFor({ timeout: 15000 });
        await section.evaluate((element) => element.scrollIntoView({ block: "start" })); await settle(400);
        await shot(`3-settings-${name}`);
        // 4. The generate page with a selection over the limit: topic asked for with a tool, the card without one.
        await open(); await nav("generate"); await sleep(300);
        await page.locator(".source-picker__doc input").nth(1).check().catch(() => {});
        if (name === "tool") await page.locator("#generate-focus").fill(lang === "en" ? "deadlock" : "死锁的四个必要条件");
        await settle(500);
        const panel = page.locator(name === "tool" ? ".retrieval-panel" : ".large-doc").first();
        await panel.waitFor({ timeout: 15000 }).catch(() => {});
        if (name === "tool") { await page.getByRole("button", { name: /预览会用到的页面|Preview the pages/ }).first().click().catch(() => {}); await settle(900); }
        await panel.scrollIntoViewIfNeeded().catch(() => {});
        await shot(`4-generate-${name}`);
        if (errors.length) console.log(`page errors at ${width}px (${name}):`, errors);
        await context.close();
      }
    } finally { await running.server.close(); }
  }
  await browser.close().catch(() => {});
  console.log(shots.join("\n"));
}
await main();
