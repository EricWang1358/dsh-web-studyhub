/* node scripts/qa/index-shortcut.mjs [--lang zh|en] [--theme dark|light] [--out <dir>]
   The way from a material's index badge to where the index is built, at 1280 and 420 px, in the browser preview with a stand-in DSH
   (retrieval: "extension"): the 资料 page and the picker of 创建题组 show 「建立索引」 on a partly built material and one line above the list; before the
   extension is installed the action says 安装检索扩展 and lands on the install step; with it installed a click opens 设置 › 检索扩展 with the course
   of THAT material chosen, and starts nothing. The coverage answer is held at the network edge (partly built book, built slides) so the states are
   exact. The same function drives tests/index-shortcut-browser.test.mjs. Every key/token/base-url variable is removed from the environment. */
/* global document, window */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { startFakeReleaseHost } from "../fake-extension.mjs";
import { buildPreview } from "../build.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { pick } from "./pick.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const BOOK_COURSE = "操作系统", OTHER_COURSE = "数据库";
const book = (pages) => Array.from({ length: pages }, (_, i) => `<!-- page: ${i + 1} -->\n${i === 0 ? "# 操作系统\n" : ""}第 ${i + 1} 页：进程、线程与调度。`).join("\n\n");

/** A library with a 2-page book in 操作系统 (partly indexed) and a note in 数据库 (the course Settings would open on without the shortcut). */
export async function seedIndexLibrary(server, lang) {
  await previewCall(server, "materials.document.import", { dataBase64: Buffer.from("# 关系模型\n\n关系、元组与范式。", "utf8").toString("base64"), filename: "数据库笔记.md", courses: [OTHER_COURSE], uiLanguage: lang });
  await previewCall(server, "materials.document.import", { dataBase64: Buffer.from(book(6), "utf8").toString("base64"), filename: "操作系统（转换结果）.md", courses: [BOOK_COURSE], uiLanguage: lang });
  return previewCall(server, "snapshot", { uiLanguage: lang });
}

/** Run the scenario at one width. Returns { errors, facts, shots }; throws on the first thing that is not as it should be. */
export async function indexShortcutScenario({ browser, dist, width, lang = "zh", theme = "dark", out = null }) {
  const base = await mkdtemp(join(tmpdir(), "study-index-shortcut-"));
  const release = await startFakeReleaseHost();
  const previous = process.env.STUDYHUB_QA_UPDATE_FEED;
  process.env.STUDYHUB_QA_UPDATE_FEED = release.origin;
  const server = await createPreviewServer({ libraryRoot: join(base, "library"), home: join(base, "home"), port: 0, model: createFakeModel({ latencyMs: 20 }), retrieval: "extension", ...(dist ? { distDir: dist } : {}) });
  const shots = [], facts = {}, errors = [];
  try {
    const snapshot = await seedIndexLibrary(server, lang);
    const ids = snapshot.sources.map((source) => source.id);
    const bookIds = snapshot.sources.filter((source) => (source.courses || []).includes(BOOK_COURSE)).map((source) => source.id);
    if (bookIds.length < 2) throw new Error(`the book should be several pages: ${JSON.stringify(snapshot.sources.map((s) => [s.id, s.courses]))}`);
    if (snapshot.focus?.course === BOOK_COURSE) throw new Error("the current course is the book's course: the preselection would prove nothing");
    facts.focusCourse = snapshot.focus?.course ?? "";
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
    await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); } catch { /* blocked */ } }, [lang, theme]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    // The coverage: the book has its first page indexed only, the note is not part of it; whether the extension can build is switched by the scenario.
    const answer = { canIndex: false };
    const cover = (canIndex) => ({ indexed: [bookIds[0], ...ids.filter((id) => !bookIds.includes(id))], stale: [], missing: bookIds.slice(1), hasIndex: true, canIndex, building: null });
    await page.route("**/api/call", async (route) => {
      let action = "";
      try { action = JSON.parse(route.request().postData() || "{}").action; } catch { /* not JSON */ }
      if (action !== "retrieval.index.coverage") return route.continue();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, value: cover(answer.canIndex) }) });
    });
    const shot = async (label) => { if (!out) return; const path = join(out, `${width}-${lang}-${theme}-${label}.png`); await page.screenshot({ path }); shots.push(path); };
    const settle = async (ms = 400) => { await page.waitForLoadState("networkidle").catch(() => {}); await sleep(ms); };
    const noOverflow = async (what) => {
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (wide > 1) throw new Error(`${width}px: ${what} scrolls sideways by ${wide}px`);
    };
    const open = async (id) => { await page.locator(`[data-nav-id="${id}"]`).first().click(); await settle(300); };
    // A page follows the current course (数据库) at first; the book is in another one, so the page shows all courses.
    const allCourses = async (scope) => { await pick(page, scope.locator('.page-scope [role="combobox"]').first(), /全部课程|All courses/); await settle(300); };
    try {
    await page.goto(server.url);
    await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await settle(600);

    /* 1. The extension is not installed: the 资料 page says so, and the action goes to its install step. */
    await open("sources");
    await allCourses(page.locator(".sources-page"));
    const row = page.locator(".source-doc", { hasText: "操作系统" }).first();
    await row.locator(".index-badge").waitFor({ timeout: 20000 });
    const install = row.locator("[data-index-action]");
    await install.waitFor({ timeout: 5000 });
    facts.installLabel = (await install.innerText()).trim();
    if (!/^(安装扩展|Install extension)$/.test(facts.installLabel)) throw new Error(`not installed: the action says "${facts.installLabel}"`);
    const gapLine = page.locator(".sources-page .index-gap");
    await gapLine.waitFor({ timeout: 5000 });
    facts.pageGapNotInstalled = (await gapLine.innerText()).replace(/\s+/g, " ").trim();
    if (!/去安装检索扩展|Go and install the search extension/.test(facts.pageGapNotInstalled)) throw new Error(`not installed: the line says "${facts.pageGapNotInstalled}"`);
    await noOverflow("the 资料 page");
    await shot("1-sources-not-installed");
    await install.click();
    await page.locator('[data-tour="settings-extensions"]').waitFor({ state: "visible", timeout: 15000 });
    await page.locator('.extension-panel[data-state="available"]').waitFor({ timeout: 15000 });
    if (await page.locator("dialog[open]").count()) throw new Error("the click on the badge also opened the reader");
    await page.locator('[data-tour="settings-extensions"]').evaluate((element) => element.scrollIntoView({ block: "start" }));
    await settle(300);
    await shot("2-settings-install-step");
    // Install it the way a learner does; nothing was built by the click.
    await page.getByRole("button", { name: /^(安装检索扩展|Install the search extension)$/ }).first().click();
    await page.locator("dialog[open]").waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: /允许并继续|Allow and continue/ }).click();
    await page.getByRole("button", { name: /为这门课建立检索索引|Build the search index/ }).waitFor({ timeout: 40000 });
    answer.canIndex = true;

    /* 2. Installed: 建立索引 on the partly built book opens 设置 › 检索扩展 with ITS course chosen (not the current one), and builds nothing. */
    await open("sources");
    await allCourses(page.locator(".sources-page"));
    const partly = page.locator(".source-doc", { hasText: "操作系统" }).first();
    await partly.locator(".index-badge").waitFor({ timeout: 20000 });
    const action = partly.locator("[data-index-action]");
    await action.waitFor({ timeout: 5000 });
    facts.actionLabel = (await action.innerText()).trim();
    if (!/^(建立索引|Build index)$/.test(facts.actionLabel)) throw new Error(`the action says "${facts.actionLabel}"`);
    facts.pageGap = (await gapLine.innerText()).replace(/\s+/g, " ").trim();
    if (!/有 1 份资料的索引还没建完|The index of 1 material\(s\) is not finished/.test(facts.pageGap)) throw new Error(`the line says "${facts.pageGap}"`);
    // Built slides (the note) show no action: one badge of this page has it.
    facts.actions = await page.locator(".sources-page [data-index-action]").count();
    if (facts.actions !== 1) throw new Error(`${facts.actions} actions on the page, 1 expected`);
    await noOverflow("the 资料 page");
    await shot("3-sources-installed");
    // Keyboard first: Tab to the action, Enter. (At 420 px it is the way a keyboard user gets there; the mouse is used at the other width.)
    if (width < 700) { await action.focus(); await page.keyboard.press("Enter"); } else await action.click();
    await page.locator('[data-tour="settings-extensions"]').waitFor({ state: "visible", timeout: 15000 });
    await page.locator(".extension-panel__course").waitFor({ timeout: 20000 });
    await settle(300);
    facts.chosenCourse = (await page.locator(".extension-panel__course").innerText()).replace(/\s+/g, " ").trim();
    if (!facts.chosenCourse.includes(BOOK_COURSE) || facts.chosenCourse.includes(OTHER_COURSE)) throw new Error(`the course chosen in Settings is "${facts.chosenCourse}", expected ${BOOK_COURSE}`);
    if (await page.locator(".extension-panel__progress").count()) throw new Error("the click started a build");
    if (await page.locator("dialog[open]").count()) throw new Error("the click on the badge also opened the reader");
    await page.locator('[data-tour="settings-extensions"]').evaluate((element) => element.scrollIntoView({ block: "start" }));
    await settle(300);
    await shot("4-settings-course-chosen");
    // The request was taken: a later visit to Settings starts on the current course again.
    await open("sources");
    await page.locator('[data-tour="nav-settings"]').first().click();
    await page.locator('[data-tour="settings-extensions"]').waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    if (await page.locator('[data-category="retrieval"]').count()) await page.locator('[data-category="retrieval"]').click();
    await page.locator(".extension-panel__course").waitFor({ timeout: 20000 });
    facts.laterCourse = (await page.locator(".extension-panel__course").innerText()).replace(/\s+/g, " ").trim();
    if (!facts.laterCourse.includes(facts.focusCourse)) throw new Error(`a later visit to Settings should start on the current course "${facts.focusCourse}", not "${facts.laterCourse}"`);

    /* 3. The picker of 创建题组: the same action on the row and the line above the list; clicking it ticks nothing. */
    await open("generate");
    const fromSources = page.locator('[data-tour="generate-from-sources"]').or(page.getByRole("tab", { name: lang === "en" ? "From materials" : "从资料补题" }));
    await fromSources.first().click().catch(() => {});
    const picker = page.locator('[data-tour="generate-sources"]');
    await picker.locator(".source-picker__item").first().waitFor({ timeout: 30000 });
    await allCourses(picker);
    await picker.locator(".index-badge").first().waitFor({ timeout: 20000 });
    const pickerAction = picker.locator("[data-index-action]");
    await pickerAction.first().waitFor({ timeout: 5000 });
    facts.pickerActions = await pickerAction.count();
    facts.pickerGap = (await picker.locator(".index-gap").innerText()).replace(/\s+/g, " ").trim();
    if (facts.pickerActions !== 1 || !/有 1 份资料的索引还没建完|The index of 1 material\(s\) is not finished/.test(facts.pickerGap)) throw new Error(`picker: ${facts.pickerActions} actions, line "${facts.pickerGap}"`);
    await noOverflow("the picker");
    await picker.scrollIntoViewIfNeeded();
    await shot("5-picker");
    const count = async () => (await picker.locator(".source-picker__count").innerText()).replace(/\s+/g, " ").trim();
    const before = await count();
    await pickerAction.first().click();
    await page.locator('[data-tour="settings-extensions"]').waitFor({ state: "visible", timeout: 15000 });
    await page.locator(".extension-panel__course").waitFor({ timeout: 20000 });
    facts.pickerChosenCourse = (await page.locator(".extension-panel__course").innerText()).replace(/\s+/g, " ").trim();
    if (!facts.pickerChosenCourse.includes(BOOK_COURSE)) throw new Error(`picker: the course chosen in Settings is "${facts.pickerChosenCourse}"`);
    await open("generate");
    await picker.locator(".source-picker__item").first().waitFor({ timeout: 30000 });
    if ((await count()) !== before) throw new Error(`the click on the badge ticked a row: "${before}" → "${await count()}"`);

    /* 4. Everything built, or nothing known: no line, no action. */
    answer.canIndex = true;
    await page.unroute("**/api/call");
    await page.route("**/api/call", async (route) => {
      let action2 = "";
      try { action2 = JSON.parse(route.request().postData() || "{}").action; } catch { /* not JSON */ }
      if (action2 !== "retrieval.index.coverage") return route.continue();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, value: { indexed: ids, stale: [], missing: [], hasIndex: true, canIndex: true, building: null } }) });
    });
    await open("sources");
    await allCourses(page.locator(".sources-page"));
    await page.locator(".source-doc .index-badge").first().waitFor({ timeout: 20000 });
    await settle(300);
    if (await page.locator(".sources-page .index-gap, .sources-page [data-index-action]").count()) throw new Error("everything is indexed and the page still points to the index");
    } catch (error) {
      if (out) await page.screenshot({ path: join(out, `failed-${width}.png`) }).catch(() => {});
      throw error;
    }
    await context.close();
    return { errors, facts, shots };
  } finally {
    await server.close();
    await release.close();
    if (previous === undefined) delete process.env.STUDYHUB_QA_UPDATE_FEED; else process.env.STUDYHUB_QA_UPDATE_FEED = previous;
    await rm(base, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const lang = flag("lang", "zh"), theme = flag("theme", "dark"), out = resolve(flag("out", join(repoRoot, "output/qa/index-shortcut")));
  scrubProcessEnv();
  await mkdir(out, { recursive: true });
  const dist = await mkdtemp(join(tmpdir(), "study-index-shortcut-dist-"));
  await buildPreview({ outdir: dist });
  const browser = await launchChromium();
  try {
    for (const width of [1280, 420]) {
      const result = await indexShortcutScenario({ browser, dist, width, lang, theme, out });
      console.log(JSON.stringify({ width, facts: result.facts, errors: result.errors }));
      console.log(result.shots.join("\n"));
    }
  } finally { await browser.close(); await rm(dist, { recursive: true, force: true }); }
}
