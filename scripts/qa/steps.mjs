/* node scripts/qa/steps.mjs [--dist=<dir with app.js/app.css>] [--lang=zh|en] [--label=after] [--json=<file>]
   Steps to a first useful action, counted in the browser preview (docs/feature-tiers.md): every click is counted as it is made
   (typing is counted apart), so the number is what a learner does, not what a document says.

   Journeys, each on a throw-away library (os temp dir, fake model, no network, every key/token/base-url variable removed):
     first-question   a brand-new library to a first generation job: welcome page → import the first material (pasted text) →
                      save → make questions from it → generate
     new-course       a second course starting in a library in use → the generation form with that course's material → generate
     daily-continue   a course in daily use → the first practice question
   Run it against two builds (--dist) to compare before and after; it writes <label>-steps.json and prints a table. */
import { rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { previewCall } from "../preview-server.mjs";
import { launchChromium } from "./browser.mjs";
import { startNavServer } from "./nav-layout.mjs";
import { SEEDS } from "./tiers.mjs";
import { sampleMaterial } from "./fixtures.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const TEXT = {
  zh: { importFirst: "添加资料", paste: "粘贴文本", title: "资料名称", body: "原文", save: "保存资料", makeFirst: "从这份资料出题", makeCourse: "用这门课的资料出题" },
  en: { importFirst: "Add source", paste: "Paste text", title: "Source name", body: "Original text", save: "Save source", makeFirst: "Generate from this source", makeCourse: "Make questions from this course's materials" },
};

export async function runJourney({ browser, running, name, lang, width = 1440 }) {
  const { server, base } = running;
  const api = (action, input = {}) => previewCall(server, action, { ...input, uiLanguage: lang });
  for (const dir of ["library", "home"]) await rm(join(base, dir), { recursive: true, force: true });
  const seed = { "first-question": "empty", "new-course": "newcourse", "daily-continue": "daily" }[name];
  await SEEDS[seed](api);
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: lang === "en" ? "en-US" : "zh-CN" });
  await context.addInitScript(([l]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", "dark"); } catch { /* blocked */ } }, [lang]);
  const page = await context.newPage();
  const t = TEXT[lang], tally = { clicks: 0, fills: 0, trail: [] };
  const click = async (locator, label) => {
    try { await locator.first().waitFor({ timeout: 20000 }); } catch (error) {
      await page.screenshot({ path: join(process.env.STEPS_FAIL_DIR || tmpdir(), `steps-failed-${name}-${lang}.png`) }).catch(() => {});
      throw new Error(`${name}: could not find the button for "${label}" (${String(error.message).split(/\r?\n/)[0]})`);
    }
    await locator.first().click(); tally.clicks++; tally.trail.push(label); await sleep(500);
  };
  const fill = async (locator, value) => { await locator.first().fill(value); tally.fills++; };
  await page.goto(server.url);
  await page.locator(".sidebar").first().waitFor({ timeout: 30000 });
  await sleep(1200);
  const jobs = async () => (await api("snapshot")).jobs.length;
  const before = await jobs();
  const dialog = page.locator("dialog[open]");
  if (name === "first-question") {
    const material = sampleMaterial(lang);
    await click(page.getByRole("button", { name: t.importFirst }), "welcome: import my first material");
    await click(dialog.getByRole("button", { name: t.paste, exact: true }), "dialog: paste text");
    await fill(dialog.getByLabel(t.title), material.title);
    await fill(dialog.getByLabel(t.body), material.text);
    await click(dialog.getByRole("button", { name: t.save }), "dialog: save material");
    await page.locator("dialog[open]").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
    // The import lands on the materials page with the new row highlighted; its button makes questions from it.
    await click(page.getByRole("button", { name: t.makeFirst }), "materials: make questions from this material");
    await click(page.locator('[data-tour="generate-submit"]'), "generate: submit");
  } else if (name === "new-course") {
    // After: the checklist's own button; before: the sidebar's 创建题组. Either way the form must come up with the course's material.
    const checklist = page.getByRole("button", { name: t.makeCourse });
    if (await checklist.count()) await click(checklist, "home checklist: make questions from this course's materials");
    else await click(page.locator('[data-tour="nav-generate"]'), "sidebar: create questions");
    await click(page.locator('[data-tour="generate-submit"]'), "generate: submit");
  } else {
    await click(page.locator(".today-go"), "home: continue");
    await page.locator('[data-tour="review-question"]').first().waitFor({ timeout: 20000 });
  }
  let started = false;
  if (name !== "daily-continue") for (let i = 0; i < 40 && !started; i++) { started = (await jobs()) > before; if (!started) await sleep(250); }
  const url = await page.url();
  await context.close();
  return { journey: name, lang, clicks: tally.clicks, typed: tally.fills, reached: name === "daily-continue" ? "a practice question" : started ? "a generation job" : "NOT REACHED", trail: tally.trail, url };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n, d) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
  const lang = flag("lang", "zh"), label = flag("label", "after"), dist = flag("dist", "");
  const out = resolve(flag("out", join(repoRoot, "output/qa/tiers")));
  await mkdir(out, { recursive: true });
  const running = await startNavServer({ ...(dist ? { distDir: resolve(dist) } : {}) });
  const browser = await launchChromium();
  const rows = [];
  try {
    for (const name of ["first-question", "new-course", "daily-continue"]) rows.push(await runJourney({ browser, running, name, lang }));
  } finally {
    await browser.close().catch(() => {});
    await running.close();
  }
  await writeFile(flag("json", join(out, `${label}-steps.json`)), JSON.stringify(rows, null, 1));
  for (const row of rows) console.log(`${row.journey.padEnd(16)} ${row.clicks} clicks, ${row.typed} fields typed → ${row.reached}\n    ${row.trail.join(" → ")}`);
  process.exit(rows.some((row) => row.reached === "NOT REACHED") ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
