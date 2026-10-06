/* node scripts/qa/select-shots.mjs [--lang=zh|en|both] [--theme=dark|light|both] [--widths=1280,420] [--scale=100] [--out=<dir>] [--dist=<dir>]
   Select and Combobox (WP-4) in the real app: the course heading's switcher open and filtered, the deck picker with its 新建题组 footer action,
   a settings Select open. Runs the real preview server on a throw-away library (the course-active.mjs seed: a course tree, parked courses,
   decks), fake model, no network, every key/token/base-url variable removed. Writes <out>/<width>-<lang>-<theme>-<step>.png and
   <out>/summary.json (what each step showed, page errors); exits non-zero when a step's expectation fails or the page throws. */
/* global localStorage */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { openPopup } from "./pick.mjs";
import { seedLibrary } from "./course-active.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function runCombo({ browser, lang, theme, width, scale, out, dist }) {
  const base = await mkdtemp(join(tmpdir(), "study-select-qa-"));
  const root = join(base, "library");
  await seedLibrary(root);
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, "home"), port: 0, model: createFakeModel({ latencyMs: 50 }), ...(dist ? { distDir: dist } : {}) });
  const label = `${width}-${lang}-${theme}${scale === "100" ? "" : `-z${scale}`}`;
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 860 : 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
  await context.addInitScript(([l, t, s]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); if (s !== "100") localStorage.setItem("study-interface", JSON.stringify({ scale: Number(s) })); } catch { /* blocked */ } }, [lang, theme, scale]);
  const page = await context.newPage();
  const errors = [], seen = {}, failures = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const settle = async (ms = 500) => { await page.waitForLoadState("networkidle").catch(() => {}); await sleep(ms); };
  const t = (zh, en) => (lang === "en" ? en : zh);
  const shot = async (name) => { await sleep(350); await page.screenshot({ path: join(out, `${label}-${name}.png`) }); };
  const expect = (ok, message) => { if (!ok) failures.push(`${label}: ${message}`); };
  const nav = async (id) => { await page.locator(`[data-tour="nav-${id}"]`).first().click({ force: true }); await settle(900); };

  await page.goto(server.url);
  await page.locator(".sidebar").first().waitFor({ timeout: 30000 });
  await settle(1200);

  // 1. The course heading is the switcher: open, then filtered to a chapter.
  const heading = page.locator('.course-heading [role="combobox"]').first();
  await heading.waitFor({ timeout: 20000 });
  await heading.click();
  await openPopup(page).waitFor();
  await shot("01-course-open");
  seen.courseOptions = (await openPopup(page).getByRole("option").allTextContents()).map((text) => text.replace(/\s+/g, " ").trim());
  expect(seen.courseOptions.length >= 5, `the course list has the courses (${seen.courseOptions.length})`);
  await page.keyboard.type("Kubern");
  await sleep(300);
  seen.filtered = (await openPopup(page).getByRole("option").allTextContents()).map((text) => text.replace(/\s+/g, " ").trim());
  expect(seen.filtered.length === 1 && /Kubernetes/.test(seen.filtered[0]), `typing narrows to the chapter (${seen.filtered})`);
  seen.footer = await openPopup(page).locator(".sh-combobox__action").allTextContents();
  await shot("02-course-filtered");
  await page.keyboard.press("Escape");
  await openPopup(page).waitFor({ state: "hidden" });

  // 2. The deck picker with a create action (record from the conversation).
  await nav("generate");
  const chatTab = page.getByRole("tab", { name: t("在对话里录题", "Record from the conversation") });
  if (await chatTab.count()) {
    await chatTab.click();
    await settle(600);
    const deck = page.locator(".ingest-setup [role=\"combobox\"]").first();
    await deck.click();
    await openPopup(page).waitFor();
    await shot("03-deck-open");
    await page.keyboard.type(t("新建的错题", "New mistakes"));
    await sleep(300);
    seen.createAction = await openPopup(page).locator(".sh-combobox__action").allTextContents();
    expect(seen.createAction.some((text) => text.includes(t("新建的错题", "New mistakes"))), `the footer action carries the typed name (${seen.createAction})`);
    await shot("04-deck-create");
    await openPopup(page).locator(".sh-combobox__action").first().click();
    await openPopup(page).waitFor({ state: "hidden" });
    seen.titleAfterCreate = await page.locator('.ingest-setup input[required]').first().inputValue().catch(() => "");
    expect(seen.titleAfterCreate === t("新建的错题", "New mistakes"), `the new deck's name field holds what was typed (${seen.titleAfterCreate})`);
    await shot("05-deck-created");
  } else seen.chatTab = "not offered in this preview";

  // 3. A Select in settings (出题偏好).
  await nav("settings");
  await page.getByRole("button", { name: t("出题偏好", "Generation preferences") }).first().click().catch(() => {});
  await settle(800);
  const select = page.locator('main [role="combobox"]:visible, .settings [role="combobox"]:visible').first();
  if (await select.count()) {
    await select.click();
    await openPopup(page).waitFor();
    await shot("06-settings-select-open");
    await page.keyboard.press("Escape");
  } else seen.settingsSelect = "no select on this page";

  await context.close();
  await server.close();
  await rm(base, { recursive: true, force: true });
  return { label, seen, errors, failures };
}

async function main() {
  scrubProcessEnv();
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const langs = flag("lang", "zh") === "both" ? ["zh", "en"] : [flag("lang", "zh")];
  const themes = flag("theme", "dark") === "both" ? ["dark", "light"] : [flag("theme", "dark")];
  const widths = flag("widths", "1280,420").split(",").map(Number);
  const scale = flag("scale", "100");
  const out = resolve(flag("out", join(repoRoot, "output", "wp4-shots")));
  const dist = flag("dist", "");
  await mkdir(out, { recursive: true });
  const browser = await launchChromium();
  const results = [];
  try {
    for (const width of widths) for (const lang of langs) for (const theme of themes) {
      const result = await runCombo({ browser, lang, theme, width, scale, out, dist: dist ? resolve(dist) : "" });
      results.push(result);
      console.log(`${result.label}: ${result.failures.length ? `FAILED ${result.failures.join("; ")}` : "ok"}${result.errors.length ? ` · ${result.errors.length} page errors: ${result.errors.slice(0, 2).join(" | ")}` : ""}`);
    }
  } finally { await browser.close(); }
  await writeFile(join(out, "summary.json"), JSON.stringify(results, null, 2));
  if (results.some((result) => result.failures.length || result.errors.length)) process.exitCode = 1;
}

if (process.argv[1]?.endsWith("select-shots.mjs")) await main();
