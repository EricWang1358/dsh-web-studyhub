/* node scripts/qa/course-active.mjs [--lang=zh|en|both] [--theme=dark|light|both] [--widths=1440,420] [--out=<dir>] [--dist=<dir>]
   有效课程 in the browser preview: an old term's courses pile up a review backlog; the learner parks them in Settings › 课程,
   watches the Dashboard forecast, the home and the pickers change, browses a parked course from the picker and activates it again.

   Runs the real preview server on a throw-away library (os temp dir, fake model, no network, every key/token/base-url variable
   removed). Writes <out>/<width>-<lang>-<theme>-<step>.png and <out>/summary.json (the numbers each step showed, console
   errors); exits non-zero when a step's expectation fails or the page throws. */
/* global localStorage -- addInitScript callbacks run in the browser */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StudyService } from "../../lib/service.js";
import { createPreviewServer } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const day = (n) => new Date(Date.now() + n * 86400000).toISOString();

const PARENT = "Cloud Native Solution Design";
const K8S = `${PARENT} / 05 Kubernetes`;
const MICRO = `${PARENT} / 07 Microservices`;
const OS = "Operating Systems";
const DB = "Databases";

const card = (id, topic, extra = {}) => ({ id, kind: "quiz", topic, objective: `Explain ${id}`, prompt: `Question ${id}?`, answer: "a", hint: "h", explanation: "e", misconception: "m", citations: [],
  options: [{ id: "a", text: "Right", correct: true }, { id: "b", text: "Wrong", correct: false }], ...extra });
const review = (due, repetitions = 2) => ({ repetitions, interval_days: 6, ease_factor: 2.5, due_at: due });

/** The learner's library: two old courses with a large backlog next to the course being studied now. */
export async function seedLibrary(root) {
  const service = new StudyService(root);
  await service.store.update((state) => {
    const attempts = [];
    const add = (id, title, course, count, make) => {
      const cards = Array.from({ length: count }, (_, i) => make(i));
      state.decks.push({ id, title, course, createdAt: "2026-02-01T00:00:00Z", cards });
      cards.forEach((c, i) => { if (c.review?.repetitions > 0) attempts.push({ id: `${id}-${c.id}`, deckId: id, quiz_id: c.id, grade: c.weak ? 1 : 4, assessment: "graded", timestamp: day(-1 - (i % 20)) }); });
    };
    add("os1", "OS part 1", OS, 150, (i) => card(`os1-${i}`, `os-topic-${i % 6}`, { review: review(day(-30 - (i % 40))) }));
    add("os2", "OS part 2", OS, 110, (i) => card(`os2-${i}`, `os-topic-${i % 5}`, { review: review(day(-12 - (i % 20))) }));
    add("k8s", "Kubernetes objects", K8S, 120, (i) => card(`k8s-${i}`, `k8s-topic-${i % 8}`, { review: review(day(-20 - (i % 30))) }));
    add("micro", "Microservice boundaries", MICRO, 80, (i) => card(`micro-${i}`, `micro-topic-${i % 5}`, { review: review(day(i < 40 ? -6 : 3 + (i % 9))) }));
    add("db1", "Transactions", DB, 40, (i) => card(`db1-${i}`, `tx-topic-${i % 4}`, i < 14 ? { review: review(day(i < 8 ? -2 : 0.2)) } : i < 22 ? { review: review(day(2 + (i % 8))), weak: i % 2 === 0 } : i < 30 ? { review: review(day(1 + (i % 10))) }
      : { review: { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null } }));
    for (const entry of attempts) { const { weak: _weak, ...rest } = entry; state.attempts.push(rest); }
    state.attempts.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    state.focus = { mode: "class", course: DB, role: "", jd: "", targetTopics: [] };
  });
  await service.dispose?.();
}

const numbers = (text) => (text.match(/\d+/g) || []).map(Number);

async function runCombo({ browser, lang, theme, width, out, dist }) {
  const base = await mkdtemp(join(tmpdir(), "study-active-qa-"));
  const root = join(base, "library");
  await seedLibrary(root);
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, "home"), port: 0, model: createFakeModel({ latencyMs: 50 }), ...(dist ? { distDir: dist } : {}) });
  const label = `${width}-${lang}-${theme}`;
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 860 : 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
  await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); } catch { /* blocked */ } }, [lang, theme]);
  const page = await context.newPage();
  const errors = [], seen = {}, failures = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const settle = async (ms = 600) => { await page.waitForLoadState("networkidle").catch(() => {}); await sleep(ms); };
  const t = (zh, en) => (lang === "en" ? en : zh);
  const shot = async (name, selector) => {
    if (selector) await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(350);
    await page.screenshot({ path: join(out, `${label}-${name}.png`) });
  };
  const expect = (ok, message) => { if (!ok) failures.push(`${label}: ${message}`); };
  const nav = async (id) => {
    // Narrow windows keep the rail collapsed; its buttons stay in the page.
    await page.locator(`[data-tour="nav-${id}"]`).first().click({ force: true });
    await settle(900);
  };
  const text = async (selector) => (await page.locator(selector).first().innerText().catch(() => "")).replace(/\s+/g, " ");

  await page.goto(server.url);
  await page.locator(".sidebar").first().waitFor({ timeout: 30000 });
  await settle(1200);
  await shot("01-home-before");
  const homeBefore = await text(".today-card");
  seen.homeBefore = homeBefore;

  await nav("dashboard");
  await page.locator(".dash-forecast-panel").first().waitFor({ timeout: 20000 });
  // The page opens on the current course; the learner's screenshot was "全部课程".
  await page.locator(".page-scope select").first().selectOption("*");
  await settle(1200);
  const before = await text(".dash-forecast-panel .dash-chart-summary");
  seen.forecastBefore = before;
  expect(numbers(before)[0] >= 400, `forecast today before parking is the whole backlog (${before})`);
  await shot("02-dashboard-before", ".dash-forecast-panel");

  await nav("settings");
  await page.locator(".course-list").first().waitFor({ timeout: 20000 });
  await page.locator(".course-list").first().scrollIntoViewIfNeeded().catch(() => {});
  await settle(400);
  await shot("03-settings-courses", ".course-list");
  const osSwitch = page.locator(`button[role="switch"][aria-label*="${OS}"]`).first();
  await osSwitch.click();
  await page.locator(".course-active__result").first().waitFor({ timeout: 20000 });
  await settle(500);
  seen.parkedOs = await text(".course-active__result");
  expect(/260/.test(seen.parkedOs), `parking says how many due cards leave (${seen.parkedOs})`);
  await shot("04-settings-parked-os", ".course-active__result");

  // The parent: asked about its chapters, keeps the choice.
  const group = page.locator(".course-list__group-head", { hasText: PARENT }).first();
  await group.locator(`button[role="switch"]`).click();
  await page.locator(".course-active__confirm").first().waitFor({ timeout: 20000 });
  seen.confirm = await text(".course-active__confirm");
  await shot("05-parent-confirm", ".course-active__confirm");
  await page.locator(".course-active__confirm button", { hasText: t("连同子课程一起", "Include sub-courses") }).click();
  await page.locator(".course-active__result").first().waitFor({ timeout: 20000 });
  await settle(700);
  seen.parkedParent = await text(".course-active__result");
  await shot("06-settings-parent-parked", ".course-list");

  await nav("dashboard");
  await page.locator(".dash-forecast-panel").first().waitFor({ timeout: 20000 });
  await page.locator(".page-scope select").first().selectOption("*");
  await settle(1200);
  const after = await text(".dash-forecast-panel .dash-chart-summary");
  seen.forecastAfter = after;
  seen.forecastNote = await text(".dash-scope-note");
  expect(numbers(after)[0] < 40, `forecast today after parking counts the active course only (${after})`);
  expect(/200|\d/.test(seen.forecastNote), "the card says what sits in parked courses");
  await shot("07-dashboard-after", ".dash-forecast-panel");
  seen.scopeLine = await text(".page-scope + .page-scope__note, .page-scope__note");
  // "显示": the same page, parked courses included for this view only.
  await page.locator(".page-scope__note .link-btn").first().click();
  await settle(1200);
  seen.forecastShown = await text(".dash-forecast-panel .dash-chart-summary");
  seen.scopeShown = await text(".page-scope__note");
  expect(numbers(seen.forecastShown)[0] >= 400, `showing parked courses brings their due cards back into the view (${seen.forecastShown})`);
  await shot("07b-dashboard-shown", ".dash-forecast-panel");
  await page.locator(".page-scope__note .link-btn").first().click();
  await settle(900);

  await nav("library");
  await settle(900);
  seen.homeAfter = await text(".today-card");
  await shot("08-home-after");
  await page.locator(".parked-toggle").first().scrollIntoViewIfNeeded().catch(() => {});
  seen.parkedFold = await text(".parked-toggle");
  await shot("09-home-parked-fold", ".parked-toggle");
  await page.locator(".parked-toggle").first().click();
  await settle(500);
  await shot("09b-home-parked-open", ".parked-toggle");
  // The current course may be parked on purpose: the home says so, with the way back.
  const switcher = page.locator(`select[aria-label="${t("切换当前课程", "Switch current course")}"]`).first();
  await switcher.selectOption(OS);
  await settle(1500);
  seen.currentParked = await text(".course-parked-line");
  expect(/未激活|Inactive/.test(seen.currentParked), `the home marks a parked current course (${seen.currentParked})`);
  await shot("09c-home-current-parked", ".course-parked-line");
  await switcher.selectOption(DB);
  await settle(1000);

  // Browse a parked course from the picker; nothing is silently empty.
  await nav("dashboard");
  await page.locator(".page-scope select").first().selectOption(OS);
  await settle(1200);
  const own = await text(".dash-hero");
  seen.parkedPick = await text(".page-scope__note");
  expect(/260/.test(own) || numbers(own).includes(260), `the parked course reads on its own (${own})`);
  await shot("10-dashboard-parked-pick", ".page-scope");
  await page.locator(".page-scope__note .link-btn").first().click();
  await settle(1500);
  seen.afterActivate = await page.locator(".toast, .sh-toast").first().innerText().catch(() => "");
  await shot("11-activated");

  await nav("wrongbook");
  await page.locator(".page-scope select").first().selectOption("*");
  await settle(1200);
  seen.wrongBookLine = await text(".page-scope__note");
  expect(/不含 2 门|Not including 2/.test(seen.wrongBookLine), `the wrong book says what it leaves out (${seen.wrongBookLine})`);
  await shot("12-wrongbook");

  await context.close();
  await server.close();
  await rm(base, { recursive: true, force: true });
  return { label, seen, errors, failures };
}

async function main() {
  scrubProcessEnv();
  const args = process.argv.slice(2);
  const flag = (name, fallback) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const langs = flag("lang", "both") === "both" ? ["zh", "en"] : [flag("lang")];
  const themes = flag("theme", "both") === "both" ? ["dark", "light"] : [flag("theme")];
  const widths = flag("widths", "1440,420").split(",").map(Number);
  const out = resolve(flag("out", join(repoRoot, "output", "qa-course-active")));
  const dist = flag("dist", "");
  await mkdir(out, { recursive: true });
  const browser = await launchChromium();
  const results = [];
  try {
    for (const width of widths) for (const lang of langs) for (const theme of themes) {
      const result = await runCombo({ browser, lang, theme, width, out, dist: dist ? resolve(dist) : "" });
      results.push(result);
      console.log(`${result.label}: ${result.failures.length ? `FAILED ${result.failures.join("; ")}` : "ok"}${result.errors.length ? ` · ${result.errors.length} page errors` : ""}`);
    }
  } finally { await browser.close(); }
  await writeFile(join(out, "summary.json"), JSON.stringify(results, null, 2));
  if (results.some((result) => result.failures.length || result.errors.length)) process.exitCode = 1;
}

if (import.meta.url === new URL(process.argv[1], "file://").href || process.argv[1]?.endsWith("course-active.mjs")) await main();
