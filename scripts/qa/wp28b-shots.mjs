/* node scripts/qa/wp28b-shots.mjs [--lang zh|en] [--theme dark|light] [--out <dir>]
   The one-click search path (WP28b) at 1440 and 420 px, in the browser preview with
   a stand-in DSH (STUDY_FAKE_RETRIEVAL=extension, scripts/fake-extension.mjs): the
   大教材建议 card's main path for a too-large PDF, Settings › 扩展 before the install,
   the confirmation for build scripts, the installed extension ready to index, the
   index building (model preparation, pages counted) and finished. Each width runs on
   a fresh preview. Every key/token/base-url variable is removed from the environment. */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { startFakeReleaseHost } from "../fake-extension.mjs";
import { launchChromium } from "./browser.mjs";
import { pick } from "./pick.mjs";
import { scrubProcessEnv } from "./env.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const lang = flag("lang", "zh"), theme = flag("theme", "dark"), out = resolve(flag("out", join(repoRoot, "output/qa/wp28b")));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const TOPICS = ["进程与线程", "进程调度", "死锁", "内存管理"];
const book = (pages) => Array.from({ length: pages }, (_, i) => {
  const topic = TOPICS[Math.floor(i / 12) % TOPICS.length];
  return `<!-- page: ${i + 1} -->\n${i === 0 ? "# 操作系统\n" : ""}${i % 12 === 0 ? `# 第 ${i / 12 + 1} 章 ${topic}\n` : ""}${`${topic}是操作系统的核心内容，第 ${i + 1} 节讨论它的机制与取舍。`.repeat(6)}`;
}).join("\n\n");

async function main() {
  scrubProcessEnv();
  await mkdir(out, { recursive: true });
  const release = await startFakeReleaseHost();
  process.env.STUDYHUB_QA_UPDATE_FEED = release.origin;
  const browser = await launchChromium();
  const bigPdf = join(out, "textbook.pdf");
  await writeFile(bigPdf, Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(9 * 1024 * 1024)]));
  const shots = [];
  try {
    for (const [index, width] of [1440, 420].entries()) {
      await rm(join(out, String(width)), { recursive: true, force: true });
      const server = await createPreviewServer({ libraryRoot: join(out, String(width), "library"), home: join(out, String(width), "home"), port: 4436 + index,
        model: createFakeModel({ latencyMs: 100 }), retrieval: "extension" });
      try {
        await previewCall(server, "materials.document.import", { dataBase64: Buffer.from(book(48), "utf8").toString("base64"), filename: "操作系统（转换结果）.md", courses: ["操作系统"], uiLanguage: lang });
        const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
        await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); } catch { /* blocked */ } }, [lang, theme]);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        const settle = async (ms = 500) => { await page.waitForLoadState("networkidle").catch(() => {}); await sleep(ms); };
        const shot = async (label) => { const path = join(out, `${width}-${lang}-${theme}-${label}.png`); await page.screenshot({ path }); shots.push(path); };
        const nav = async (id) => { await page.locator(`[data-tour="nav-${id}"]`).first().click(); await settle(); };
        const press = async (name) => page.getByRole("button", { name }).first().click();
        await page.goto(server.url); await page.locator("aside, nav").first().waitFor({ timeout: 30000 }); await settle(800);

        // 1. The card's main path for a too-large PDF.
        await nav("sources");
        await page.locator('[data-tour="sources-add"]').first().click(); await settle(400);
        await page.locator('dialog[open] input[type="file"]').first().setInputFiles(bigPdf); await settle(900);
        await page.getByText(/需要整本检索时|When you need the whole book/).first().click(); await sleep(300);
        await page.locator("dialog[open] .large-doc").scrollIntoViewIfNeeded().catch(() => {});
        await page.locator("dialog[open] .large-doc__steps").scrollIntoViewIfNeeded().catch(() => {});
        await shot("1-card-main-path");
        await page.keyboard.press("Escape"); await settle(300);

        // 2. Settings › 扩展: the install, its confirmation, then ready to index.
        await nav("settings");
        const section = page.locator('[data-tour="settings-extensions"]');
        // The extensions are the 检索扩展 category of Settings (a list on the left, one category on the right).
        if (!(await section.isVisible().catch(() => false))) await page.locator('[data-category="retrieval"]').click().catch(() => {});
        await section.waitFor({ state: "visible", timeout: 15000 });
        const toSection = () => section.evaluate((element) => element.scrollIntoView({ block: "start" }));
        await toSection(); await settle(400);
        await shot("2-install-available");
        await press(/安装检索扩展|Install the search extension/); await page.locator("dialog[open]").waitFor({ timeout: 20000 }); await settle(400);
        await shot("3-install-approval");
        await press(/允许并继续|Allow and continue/);
        await page.getByRole("button", { name: /为这门课建立检索索引|Build the search index/ }).waitFor({ timeout: 30000 });
        await pick(page, page.locator('.extension-panel__index [role="combobox"]'), "操作系统").catch(() => {});
        await settle(700); await toSection(); await sleep(300);
        await shot("4-installed-ready");

        // 3. Building the index: the model preparation, pages counted, finished.
        await press(/为这门课建立检索索引|Build the search index/);
        await page.locator(".extension-panel__progress").waitFor({ timeout: 15000 });
        await toSection(); await sleep(250);
        await shot("5-index-model");
        await page.getByText(/正在建立索引|Building the index/).waitFor({ timeout: 20000 });
        await sleep(1500);
        await shot("6-index-progress");
        await page.locator(".extension-panel__index .sh-inline--success, .extension-panel__index [class*=success]").first().waitFor({ timeout: 60000 }).catch(() => {});
        await settle(700); await toSection(); await sleep(300);
        await shot("7-index-done");
        // 4. Every material row says where its index stands: the 资料 page and the picker of 创建题组.
        await page.locator('[data-nav-id="sources"]').first().click();
        await page.locator(".source-doc").first().waitFor({ timeout: 20000 });
        await page.locator(".source-doc .index-badge").first().waitFor({ timeout: 20000 });
        const states = await page.locator(".source-doc .index-badge").evaluateAll((items) => items.map((item) => `${item.dataset.state}:${item.textContent}`));
        if (!states.some((value) => value.startsWith("indexed:"))) throw new Error(`no row says its index is built: ${JSON.stringify(states)}`);
        await shot("8-sources-index-badge");
        await page.locator('[data-nav-id="generate"]').first().click();
        await page.locator(".source-picker__item").first().waitFor({ timeout: 20000 });
        await page.locator(".source-picker .index-badge").first().waitFor({ timeout: 20000 });
        await shot("9-picker-index-badge");
        if (errors.length) console.log(`page errors at ${width}px:`, errors);
        await context.close();
      } finally { await server.close(); }
    }
  } finally {
    await browser.close().catch(() => {});
    await release.close();
  }
  console.log(shots.join("\n"));
}
await main();
