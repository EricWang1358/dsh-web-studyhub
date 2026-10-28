/* global document, window -- the page.evaluate callbacks run in the browser */
/* node scripts/qa/index-no-text-shots.mjs [--lang zh|en] [--theme dark|light] [--out <dir>]
   Pages the search server cannot cut into passages (#521) at 1280 and 420 px, in the browser preview with a stand-in
   DSH (STUDY_FAKE_RETRIEVAL=extension, scripts/fake-extension.mjs, which refuses a page without a line of 50
   characters like the real server): a course with a mixed deck (paragraphs and bullet-only slide pages) and a deck of
   slides only, the index built through Settings › 检索扩展, then the course line with the result message, the 资料 row
   badge (and its hover) and the badge in the picker of 创建题组. Each width runs on a fresh preview and library; every
   key/token/base-url variable is removed from the environment. Prints the shots and the facts it read (text, overflow). */
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { startFakeReleaseHost } from "../fake-extension.mjs";
import { launchChromium } from "./browser.mjs";
import { pick } from "./pick.mjs";
import { scrubProcessEnv } from "./env.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const lang = flag("lang", "zh"), theme = flag("theme", "dark"), out = resolve(flag("out", join(repoRoot, "output/qa/index-no-text")));
const COURSE = "操作系统";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const paragraph = (n) => `<!-- page: ${n} -->\n进程是资源分配的基本单位，线程是处理器调度的基本单位，第 ${n} 页把二者的区别和联系讲清楚，并举例说明它们在调度时各自的开销。`;
const slide = (n, title) => `<!-- page: ${n} -->\n${title}\n- 资源分配\n- 处理器调度\n[Figure]`;
// 10 pages: paragraphs on 1, 4, 7, 9; the rest are a title and short bullets.
const mixed = Array.from({ length: 10 }, (_, i) => [1, 4, 7, 9].includes(i + 1) ? paragraph(i + 1) : slide(i + 1, `第 ${i + 1} 讲 进程与线程`)).join("\n\n");
const slidesOnly = Array.from({ length: 4 }, (_, i) => slide(i + 1, `网络分层 ${i + 1}`)).join("\n\n");

async function main() {
  scrubProcessEnv();
  await mkdir(out, { recursive: true });
  const release = await startFakeReleaseHost();
  process.env.STUDYHUB_QA_UPDATE_FEED = release.origin;
  const browser = await launchChromium();
  const shots = [], facts = [];
  try {
    for (const [index, width] of [1280, 420].entries()) {
      await rm(join(out, String(width)), { recursive: true, force: true });
      const server = await createPreviewServer({ libraryRoot: join(out, String(width), "library"), home: join(out, String(width), "home"), port: 4452 + index,
        model: createFakeModel({ latencyMs: 20 }), retrieval: "extension" });
      try {
        for (const [filename, text] of [["操作系统课件（转换结果）.md", mixed], ["计算机网络课件（转换结果）.md", slidesOnly]])
          await previewCall(server, "materials.document.import", { dataBase64: Buffer.from(text, "utf8").toString("base64"), filename, courses: [COURSE], uiLanguage: lang });
        const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
        await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); } catch { /* blocked */ } }, [lang, theme]);
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        const settle = async (ms = 500) => { await page.waitForLoadState("networkidle").catch(() => {}); await sleep(ms); };
        const shot = async (label) => { const path = join(out, `${width}-${lang}-${theme}-${label}.png`); await page.screenshot({ path }); shots.push(path); };
        const overflow = async (label) => facts.push(`${width}px ${label}: overflow=${await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)}`);
        const press = async (name) => page.getByRole("button", { name }).first().click();
        const states = (selector) => page.locator(selector).evaluateAll((items) => items.map((item) => { const visible = [...item.querySelectorAll("span")].find((node) => node.getClientRects().length && node.textContent.trim() && node.scrollWidth > 0) || item; return `${item.dataset.state}: ${visible.textContent.replace(/\s+/g, " ").trim()} [clipped=${item.scrollWidth > item.clientWidth + 1 || visible.scrollWidth > visible.clientWidth + 1}, width=${Math.round(item.getBoundingClientRect().width)}]`; }));
        await page.goto(server.url); await page.locator("aside, nav").first().waitFor({ timeout: 30000 }); await settle(800);

        // Settings › 检索扩展: install (approve the build scripts), pick the course, build.
        await page.locator('[data-tour="nav-settings"]').first().click(); await settle();
        const section = page.locator('[data-tour="settings-extensions"]');
        if (!(await section.isVisible().catch(() => false))) await page.locator('[data-category="retrieval"]').click().catch(() => {});
        await section.waitFor({ state: "visible", timeout: 15000 });
        await press(/安装检索扩展|Install the search extension/); await page.locator("dialog[open]").waitFor({ timeout: 20000 }); await settle(300);
        await press(/允许并继续|Allow and continue/);
        await page.getByRole("button", { name: /为这门课建立检索索引|Build the search index/ }).waitFor({ timeout: 30000 });
        await pick(page, page.locator('.extension-panel__index [role="combobox"]'), COURSE).catch(() => {});
        await settle(700);
        await press(/为这门课建立检索索引|Build the search index/);
        await page.locator(".extension-panel__index .sh-inline--success, .extension-panel__index [class*=success]").first().waitFor({ timeout: 60000 });
        await settle(900);
        // The course line and the result message together, from the course picker down.
        await page.locator(".extension-panel__index").evaluate((element) => element.scrollIntoView({ block: "start" })); await sleep(300);
        facts.push(`${width}px course line: ${JSON.stringify((await page.locator(".extension-panel__plan").first().innerText()).replace(/\s+/g, " ").trim())}`);
        facts.push(`${width}px build result: ${JSON.stringify((await page.locator(".extension-panel__index [class*=success]").first().innerText()).replace(/\s+/g, " ").trim())}`);
        await shot("1-settings-course-line-and-result"); await overflow("settings");

        // 资料 page: one badge per document.
        await page.locator('[data-nav-id="sources"]').first().click();
        await page.locator(".source-doc .index-badge").first().waitFor({ timeout: 20000 });
        await settle(500);
        facts.push(`${width}px 资料 badges: ${JSON.stringify(await states(".source-doc .index-badge"))}`);
        await shot("2-sources-index-badge"); await overflow("sources");
        if (width >= 1000) {
          await page.locator(".source-doc .index-badge", { hasText: "4/10" }).first().hover(); await sleep(900);
          facts.push(`${width}px 资料 tooltip: ${JSON.stringify((await page.locator('[role="tooltip"]').allInnerTexts()).filter((value) => /检索目录|search index/.test(value)))}`);
          await shot("3-sources-badge-hover");
          await page.mouse.move(5, 5); await sleep(300);
        }

        // 创建题组: the picker.
        await page.locator('[data-nav-id="generate"]').first().click();
        await page.locator(".source-picker__item").first().waitFor({ timeout: 20000 });
        await page.locator(".source-picker .index-badge").first().waitFor({ timeout: 20000 });
        await settle(500);
        facts.push(`${width}px picker badges: ${JSON.stringify(await states(".source-picker .index-badge"))}`);
        await shot("4-picker-index-badge"); await overflow("picker");
        facts.push(`${width}px page errors: ${JSON.stringify(errors)}`);
        await context.close();
      } finally { await server.close(); }
    }
  } finally {
    await browser.close().catch(() => {});
    await release.close();
  }
  console.log(shots.join("\n"));
  console.log(facts.join("\n"));
}
await main();
