/* node scripts/qa/focus-progress.mjs [--lang=zh|en|both] [--theme=dark|light|both] [--widths=1440,420] [--out=<dir>] [--dist=<dir>]
   重点 × 掌握度 (#690 S1) in the browser preview: the home line under the course progress (focus topic counts, the link that practises the weak
   focus questions, the summary that opens the course settings) and the read-only list of the saved topics in the course settings.

   Runs the real preview server on a throw-away library (os temp dir, fake model, no network, every key/token/base-url variable removed).
   Writes <out>/<width>-<lang>-<theme>-<step>.png and <out>/summary.json (what each step showed, the line's height, console errors); exits
   non-zero when a step's expectation fails or the page throws. */
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
const COURSE = "Operating Systems";
const TOPICS = ["Deadlock", "Semaphore", "Page replacement", "TLB", "Scheduling"];

const card = (id, topic, extra = {}) => ({ id, kind: "quiz", topic, objective: `Explain ${topic}`, prompt: `Question ${id} about ${topic}?`, answer: "a", hint: "h", explanation: "e", misconception: "m",
  citations: [], options: [{ id: "a", text: "Right", correct: true }, { id: "b", text: "Wrong", correct: false }], ...extra });
const fresh = { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null };
const learned = (interval) => ({ repetitions: 3, interval_days: interval, ease_factor: 2.5, due_at: day(interval) });

/** One course with five focus topics in every state: weak (Deadlock, Semaphore), none (Page replacement), mastered (TLB), not started (Scheduling). */
export async function seedLibrary(root) {
  const service = new StudyService(root);
  await service.call("course.save", { name: COURSE, focusTopics: TOPICS });
  await service.store.update((state) => {
    const cards = [
      card("dead-1", "Deadlock conditions", { review: learned(2) }), card("dead-2", "Deadlock prevention", { review: learned(30) }), card("dead-3", "Deadlock detection", { review: learned(30) }),
      card("sem-1", "Semaphore and mutex", { review: learned(3) }), card("sem-2", "Semaphore producer consumer", { review: learned(3) }),
      card("tlb-1", "TLB hit rate", { review: learned(30) }), card("tlb-2", "TLB shootdown", { review: learned(30) }),
      card("sched-1", "Scheduling policies", { review: fresh }), card("sched-2", "Scheduling fairness", { review: fresh }),
      card("misc-1", "File systems", { review: learned(10) }),
    ];
    state.decks.push({ id: "os", title: "OS fundamentals", course: COURSE, createdAt: "2026-09-01T00:00:00Z", cards });
    const answer = (quiz_id, grade, at) => ({ id: `a-${quiz_id}`, deckId: "os", quiz_id, grade, assessment: "graded", timestamp: day(at) });
    state.attempts.push(answer("dead-1", 1, -3), answer("dead-2", 5, -3), answer("dead-3", 5, -2), answer("sem-1", 2, -2), answer("sem-2", 4, -2),
      answer("tlb-1", 5, -4), answer("tlb-2", 5, -4), answer("misc-1", 4, -1));
    state.focus = { mode: "class", course: COURSE, role: "", jd: "", targetTopics: [] };
  });
  await service.dispose?.();
}

async function runCombo({ browser, lang, theme, width, out, dist }) {
  const base = await mkdtemp(join(tmpdir(), "study-focus-progress-qa-"));
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
  const expect = (ok, message) => { if (!ok) failures.push(`${label}: ${message}`); };
  const shot = async (name, selector) => {
    if (selector) await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(350);
    await page.screenshot({ path: join(out, `${label}-${name}.png`) });
  };
  const text = async (selector) => (await page.locator(selector).first().innerText().catch(() => "")).replace(/\s+/g, " ");

  await page.goto(server.url);
  await page.locator(".sidebar").first().waitFor({ timeout: 30000 });
  const line = page.locator(".focus-progress").first();
  await line.waitFor({ timeout: 30000 });
  await settle(1200);
  seen.line = await text(".focus-progress");
  expect(seen.line.includes(t("重点 5 条：已掌握 1 · 还不会 2 · 还没有题 1", "Focus topics 5: Mastered 1 · Not yet 2 · No questions 1")), `the home line counts the five topics (${seen.line})`);
  expect(seen.line.includes(t("练还不会的重点 →", "Practise the focus topics you can't do yet →")), `the practice link is there (${seen.line})`);
  // One line where it fits: a single text line is one line-height tall (the quiet button and the link share it).
  const box = await line.boundingBox();
  seen.lineHeight = box?.height ?? null;
  seen.lineWidth = box?.width ?? null;
  await shot("01-home-line");
  await line.hover({ position: { x: 8, y: 8 } }).catch(() => {});
  await sleep(500);
  await shot("02-home-line-hover");

  // The summary opens the course settings, whose list reads the same numbers.
  await page.locator(".focus-progress__summary").first().click();
  const list = page.locator(".focus-progress-list").first();
  await list.waitFor({ timeout: 20000 });
  await settle(500);
  seen.list = await text(".focus-progress-list");
  expect(new RegExp(`Deadlock.*${t("还不会", "Not yet")}.*Page replacement.*${t("还没有题", "No questions")}`).test(seen.list), `the list is ordered weak, then without questions (${seen.list})`);
  expect(seen.list.includes(t("3 题 · 已掌握 2", "3 questions · Mastered 2")), `Deadlock has 3 questions, 2 mastered (${seen.list})`);
  await shot("03-settings-list", ".focus-progress-list");
  await page.keyboard.press("Escape");
  await settle(500);

  // The link starts a path run over exactly the weak focus questions (Deadlock 1 + Semaphore 1 = 2 distinct ones).
  await page.locator(".focus-progress .sh-btn--link").first().click();
  await settle(1500);
  const exported = await new StudyService(root).call("export");
  const run = exported.runs.at(-1);
  seen.run = run ? { mode: run.mode, total: run.total ?? run.entries?.length ?? null, scope: run.scope?.length ?? null } : null;
  expect(run && run.mode === "path" && (run.scope || []).length === 2, `the link starts a path run over the 2 weak focus questions (${JSON.stringify(seen.run)})`);
  await shot("04-run-started");

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
  const themes = flag("theme", "light") === "both" ? ["dark", "light"] : [flag("theme", "light")];
  const widths = flag("widths", "1440,420").split(",").map(Number);
  const out = resolve(flag("out", join(repoRoot, "output", "focus-progress-690")));
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

if (import.meta.url === new URL(process.argv[1], "file://").href || process.argv[1]?.endsWith("focus-progress.mjs")) await main();
