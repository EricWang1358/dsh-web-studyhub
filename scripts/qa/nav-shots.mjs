/* node scripts/qa/nav-shots.mjs [--out=<dir>] [--dist=<dir with app.js/app.css>]
   The sidebar navigation in pictures (issues #654–#657), on a throw-away library (fake model, no network, every key variable removed):
   1440 light and 420 dark, each with an empty library and with the sample course, then 「更多」 open (wide) and the drawer open (narrow) where the
   build has them. Screenshots go to <out>/<width>-<theme>-<state>.png (default output/nav-shots/after). It asserts nothing: the eye judges. */
/* global document, localStorage -- page.evaluate callbacks run in the browser */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { previewCall } from "../preview-server.mjs";
import { launchChromium } from "./browser.mjs";
import { startNavServer } from "./nav-layout.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function shoot({ browser, running, width, theme, out }) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: "zh-CN", colorScheme: theme });
  await context.addInitScript((t) => { try { localStorage.setItem("study-ui-language", "zh"); localStorage.setItem("study-theme", t); } catch { /* blocked */ } }, theme);
  const page = await context.newPage();
  const open = async () => { await page.goto(running.server.url); await page.locator(".study-app").first().waitFor({ timeout: 120000 }); await page.waitForLoadState("networkidle").catch(() => {}); await sleep(1200); };
  const snap = async (name) => { await page.mouse.move(width - 8, 880); await sleep(500); await page.screenshot({ path: join(out, `${width}-${theme}-${name}.png`) }); };
  const content = async () => page.evaluate(() => Math.round(document.querySelector("main")?.getBoundingClientRect().width || 0));
  await open();
  await snap("1-empty");
  const emptyWidth = await content();
  // Narrow, the sidebar of an empty library is only seen in its drawer.
  const emptyMenu = page.locator('[data-tour="nav-menu"]:visible').first();
  if (await emptyMenu.count()) {
    await emptyMenu.click();
    await snap("1b-empty-drawer");
    await page.keyboard.press("Escape");
    await page.locator(".nav-drawer").waitFor({ state: "detached" });
  }
  await previewCall(running.server, "sample.load", { uiLanguage: "zh" });
  await open();
  await snap("2-sample");
  const more = page.locator('[data-tour="nav-more"]:visible').first();
  if (await more.count()) { await more.click(); await snap("3-more-open"); }
  const menu = page.locator('[data-tour="nav-menu"]:visible').first();
  if (await menu.count()) {
    await menu.click();
    await snap("4-drawer-open");
    const drawerMore = page.locator('.nav-drawer [data-tour="nav-more"]').first();
    if (await drawerMore.count()) { await drawerMore.click(); await snap("5-drawer-more"); }
  }
  console.log(`${width} ${theme}: main content ${emptyWidth}px wide`);
  await context.close();
  await previewCall(running.server, "sample.remove", {}).catch(() => {});
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const out = resolve(flag("out", join(repoRoot, "output/nav-shots/after")));
  const dist = flag("dist", "");
  await mkdir(out, { recursive: true });
  const browser = await launchChromium();
  try {
    for (const [width, theme] of [[1440, "light"], [420, "dark"]]) {
      const running = await startNavServer(dist ? { distDir: resolve(dist) } : {});
      try { await shoot({ browser, running, width, theme, out }); } finally { await running.close(); }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`screenshots: ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
