/* node scripts/qa/finder.mjs [--out=<dir>] [--dist=<dir with app.js/app.css>] [--lang=zh|en] [--theme=light|dark] [--widths=1440,420]
   找功能 (#653) in a real browser, on a throw-away library (fake model, no network, every key variable removed).

   For each width it walks the learner through what the finder promises and asserts it (exit code 1 when broken):
     1. the sidebar row 找功能 is there above 帮助, with its label and its shortcut, in the wide sidebar and in the narrow window's drawer (#657);
     2. Ctrl K opens the sheet (from the app root), the field has the focus, the empty query lists the areas as <details>;
     3. a query lists results, ↓ / ↑ move the selected row, Esc closes and the focus goes back to what opened it;
     4. 「带我去」 on a settings target (强调色): the page is Settings and the control has the focus; no ring is drawn (removed 2026-11-05);
     5. on a control folded away on another page (花费上限 inside 更多选项 inside 创建题组): the folds are open, the control has the focus;
     6. on a control the finder cannot open for the learner (翻译 in the reader): the page of the materials and a toast with the path.
   Screenshots go to <out>/<width>-<lang>-<theme>-<step>.png (default output/finder-shots). */
/* global document, getComputedStyle, localStorage, innerHeight -- page.evaluate callbacks run in the browser */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { previewCall } from "../preview-server.mjs";
import { launchChromium } from "./browser.mjs";
import { startNavServer } from "./nav-layout.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const quote = "Bridge separates an abstraction from its implementation so the two can vary independently.";

/** Wait until the control `anchor` (a data-tour id) has the focus; true when it got it. No ring is drawn any more (2026-11-05). */
export async function focusedOn(page, anchor, timeout = 15000) {
  return page.waitForFunction((name) => !!document.activeElement?.closest(`[data-tour="${name}"]`), anchor, { timeout }).then(() => true, () => false);
}

/** Walk one width. Returns { label, problems }. */
export async function walkFinder({ browser, running, lang = "zh", theme = "light", width = 1440, out = "", shots = true }) {
  const { server } = running;
  const api = (action, input = {}) => previewCall(server, action, input);
  const label = `${width}px ${lang} ${theme}`, problems = [];
  const expect = (ok, message) => { if (!ok) problems.push(`${label}: ${message}`); };
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
  await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); localStorage.removeItem("study-nav-place"); } catch { /* blocked */ } }, [lang, theme]);
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`${label}: page error ${error}`));
  // A moment first: the dialog fades in over --dur-slow, and a picture of the middle of that says nothing.
  const shot = async (name) => { if (shots) { await sleep(450); await page.screenshot({ path: join(out, `${width}-${lang}-${theme}-${name}.png`) }); } };
  const settle = async (ms = 600) => { await page.waitForLoadState("networkidle").catch(() => {}); await sleep(ms); };
  const word = (zh, en) => (lang === "en" ? en : zh);
  const narrow = width <= 560;
  // A narrow window has the sidebar in a drawer behind the top bar's menu button (#657); choosing a row closes it.
  const drawer = async () => {
    if (await page.locator(".sidebar").count()) return false;
    await page.locator(".nav-menu-toggle").click();
    await page.locator(".nav-drawer .sidebar").waitFor({ timeout: 10000 });
    await sleep(300);
    return true;
  };
  const openSheet = async (how) => {
    if (how === "click" || narrow) { await drawer(); await page.locator('[data-tour="nav-finder"]').click(); }
    else { await page.locator(".study-app").first().click({ position: { x: 640, y: 420 } }); await page.keyboard.press("Control+K"); }
    await page.locator('dialog[open] [role="combobox"]').waitFor({ timeout: 10000 });
  };
  const options = () => page.locator('dialog[open] [role="option"]');
  const activeText = () => page.evaluate(() => document.querySelector('dialog[open] [role="option"][aria-selected="true"] .finder-row__title')?.textContent || "");
  try {
    await page.goto(server.url);
    await page.locator(".sidebar, .nav-menu-toggle").first().waitFor({ timeout: 120000 });
    await settle(900);
    // One material, so 创建题组 draws its form; the library is shared by the widths, so a second walk finds it there already.
    await api("source.add", { id: "s1", title: "Bridge", text: quote }).catch((error) => { if (!/already exists/.test(String(error?.message))) throw error; });
    await page.reload();
    await page.locator(".sidebar, .nav-menu-toggle").first().waitFor({ timeout: 120000 });
    await settle(900);

    // 1. the row: above 帮助 (功能导览 is inside it since #656), with its label, wide and in the drawer
    const opened = await drawer();
    const rows = await page.evaluate(() => {
      const row = (name) => { const element = document.querySelector(`[data-tour="${name}"]`); const box = element?.getBoundingClientRect(); return element ? { top: box.top, height: box.height, width: box.width, label: element.querySelector(".nav-label")?.textContent || "", hint: element.querySelector(".nav-keys")?.textContent || "", hintShown: !!element.querySelector(".nav-keys") && getComputedStyle(element.querySelector(".nav-keys")).display !== "none" } : null; };
      return { finder: row("nav-finder"), tour: row("nav-help") };
    });
    expect(!!rows.finder && !!rows.tour, "the 找功能 row and the 帮助 row are there");
    if (rows.finder && rows.tour) {
      expect(rows.finder.top < rows.tour.top, "找功能 sits above 帮助");
      expect(Math.abs(rows.finder.height - rows.tour.height) < 0.5, `the row has the height of the others (${rows.finder.height} against ${rows.tour.height})`);
      expect(!!rows.finder.label, "the row has its label: there is no icon rail");
      expect(/Ctrl K|⌘K/.test(rows.finder.hint) && rows.finder.hintShown, `the shortcut is the row's quiet hint (${rows.finder.hint})`);
    }
    await shot("sidebar");
    if (opened) { await page.keyboard.press("Escape"); await page.locator(".nav-drawer").waitFor({ state: "detached" }); }

    // 2. the sheet: from the keyboard, the index
    await openSheet(narrow ? "click" : "key");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role") === "combobox"), "the search field has the focus");
    const groups = await page.locator("dialog[open] details.finder-group").count();
    expect(groups === 8, `the index has eight areas (${groups})`);
    expect(await page.locator("dialog[open] details.finder-group[open]").count() === 1, "one area is open");
    await shot("index");

    // 3. a query, the arrow keys, Esc
    const field = page.locator('dialog[open] [role="combobox"]');
    await field.fill(word("翻译", "translate"));
    await sleep(150);
    expect(await options().count() > 0, "the query finds something");
    const first = await activeText();
    expect(first === word("翻译", "Translate") || /翻译|Transl/i.test(first), `翻译 / translate ranks the translation entry first (${first})`);
    await shot("translate");
    await page.keyboard.press("ArrowDown");
    const second = await activeText();
    expect(second !== first, "↓ moves the selected row");
    await page.keyboard.press("ArrowUp");
    expect(await activeText() === first, "↑ moves it back");
    await page.keyboard.press("Escape");
    await sleep(200);
    expect(await page.locator("dialog[open]").count() === 0, "Esc closes the sheet");
    expect(await page.evaluate(() => !!document.activeElement && document.activeElement !== document.body), "the focus went back to something, not to nowhere");

    // 4. a settings target
    await openSheet("click");
    await page.locator('dialog[open] [role="combobox"]').fill(word("强调色", "accent"));
    await sleep(150);
    await page.keyboard.press("Enter");
    expect(await focusedOn(page, "settings-appearance-accent"), "the accent control has the focus");
    await sleep(900);
    expect(await page.locator(".settings-page").count() === 1, "带我去 opened Settings");
    expect(await page.locator("[data-finder-ring]").count() === 0, "no ring is drawn (removed 2026-11-05)");
    await shot("goto-setting");

    // 4b. a setting folded inside Settings itself (圆角 is in 更多外观选项, below the first screen): the fold opens, the page scrolls to it (#679)
    await openSheet("click");
    await page.locator('dialog[open] [role="combobox"]').fill(word("圆角", "corners"));
    await sleep(150);
    await page.keyboard.press("Enter");
    expect(await focusedOn(page, "settings-appearance-radius"), "圆角 has the focus");
    await sleep(900);
    expect(await page.evaluate(() => document.querySelector('.appearance-more')?.open === true), "the fold 更多外观选项 was opened");
    expect(await page.evaluate(() => { const box = document.querySelector('[data-tour="settings-appearance-radius"]')?.getBoundingClientRect(); return !!box && box.top >= 0 && box.bottom <= innerHeight; }), "圆角 was scrolled into view");
    await shot("goto-folded-setting");
    await page.mouse.move(5, 5);
    await page.mouse.down(); await page.mouse.up();
    await sleep(150);

    // 5. a folded target on another page
    await openSheet("click");
    await page.locator('dialog[open] [role="combobox"]').fill(word("花费上限", "spending limit"));
    await sleep(150);
    const budgetTitle = await activeText();
    expect(/花费上限|limit/i.test(budgetTitle), `the query finds 花费上限 first (${budgetTitle})`);
    await page.keyboard.press("Enter");
    expect(await focusedOn(page, "generate-budget"), "花费上限 has the focus");
    await sleep(1000);
    expect(await page.locator(".generate-page").count() === 1, "带我去 opened 创建题组");
    const state = await page.evaluate(() => ({ more: document.querySelector('[data-tour="generate-more"]')?.open, budget: document.querySelector('[data-tour="generate-budget"]')?.open }));
    expect(state.more === true && state.budget === true, `the folds around 花费上限 were opened (${JSON.stringify(state)})`);
    await shot("goto-folded");

    // 6. a control the finder cannot open for the learner
    await openSheet("click");
    await page.locator('dialog[open] [role="combobox"]').fill(word("翻译", "translate"));
    await sleep(150);
    await page.keyboard.press("Enter");
    await sleep(1500);
    expect(await page.locator(".sources-page").count() === 1, "带我去 landed on the page of the materials");
    const toast = await page.evaluate(() => document.querySelector(".sh-toast, [role='status'].sh-toast, .toast")?.textContent || document.body.innerText);
    expect(toast.includes(word("先在「资料」里打开一份资料", "First open a material")), "a toast says what is left to do");
    await shot("goto-prepare");

    // nothing found
    await openSheet("click");
    await page.locator('dialog[open] [role="combobox"]').fill("zzqx");
    await sleep(150);
    expect(await page.locator("dialog[open] .finder-empty").count() === 1, "nothing found says so and offers the tour");
    await shot("nothing-found");
    await page.keyboard.press("Escape");
    await sleep(250);
    // In the drawer the row went away with the drawer: the focus goes back to the menu button that opened it (#657).
    expect(await page.evaluate((sel) => !!document.activeElement?.closest(sel), narrow ? '[data-tour="nav-menu"]' : '[data-tour="nav-finder"]'), "Esc gives the focus back to what opened the sheet");
  } catch (error) {
    problems.push(`${label}: ${error?.stack || error}`);
    await shot("failure").catch(() => {});
  } finally {
    await context.close();
  }
  return { label, problems };
}

async function main() {
  const arg = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const out = resolve(arg("out", join(repoRoot, "output", "finder-shots"))), dist = arg("dist", "");
  const lang = arg("lang", "zh"), theme = arg("theme", "light"), widths = arg("widths", "1440,420").split(",").map(Number);
  await mkdir(out, { recursive: true });
  const browser = await launchChromium();
  const running = await startNavServer(dist ? { distDir: resolve(dist) } : {});
  const problems = [];
  try {
    for (const width of widths) {
      const result = await walkFinder({ browser, running, lang, theme: width <= 720 && !process.argv.some((item) => item.startsWith("--theme=")) ? "dark" : theme, width, out });
      console.log(`${result.label}: ${result.problems.length ? `${result.problems.length} problem(s)` : "ok"}`);
      problems.push(...result.problems);
    }
  } finally {
    await browser.close();
    await running.close();
  }
  for (const problem of problems) console.error(`  ${problem}`);
  if (problems.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
