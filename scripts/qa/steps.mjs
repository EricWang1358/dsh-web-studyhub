/* node scripts/qa/steps.mjs [--dist=<dir with app.js/app.css>] [--lang=zh|en] [--label=after] [--json=<file>] [--journeys=a,b,c]
   Steps to a useful action, counted in the browser preview (docs/feature-tiers.md, docs/qa/click-baseline.md): every click is counted as it is
   made (typing is counted apart), so the number is what a learner does, not what a document says. Waiting for the fake model is not a click.

   Journeys, each on a throw-away library (os temp dir, fake model, no network, every key/token/base-url variable removed):
     first-deck       a brand-new library to its first own deck published and the first practice question on screen: the first-run line →
                      import the first material (pasted text) → save → 出第一组题 → (the run finishes) → publish → practise.
                      Its milestones include the old first-question count (to the first generation job).
     course-practice  a library in daily use; the learner adds a material for a NEW course (typed in the import dialog) and gets to that
                      course's first practice question: import → make questions from it → generate → check the draft → publish → practise.
     daily-continue   a course in daily use with a round left open → the next practice question. Measured on the day the round was left
                      open; the clock is not moved.
     first-question   (older) a brand-new library to a first generation job. It follows the 3.6 first-run line (the first import comes back
                      to the line), so it runs against builds from 3.6 on only.
     new-course       (older) a second course already seeded with a material → a generation job (2 clicks; not the course-practice journey).
   Default: first-deck, course-practice, daily-continue (the guidance baseline, docs/qa/click-baseline.md); before the guidance work the default
   was first-question, new-course, daily-continue. --journeys=a,b picks others. Run it against two builds (--dist) to compare before and after;
   it writes <label>-steps.json and prints a table. Each row carries `milestones`: the click count when each stage was reached. */
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
  zh: { importFirst: "添加资料", paste: "粘贴文本", title: "资料名称", body: "原文", course: "课程归属", save: "保存资料", makeFirst: "从这份资料出题",
    makeCourse: "用这门课的资料出题", checkDraft: "检查草稿", publish: "发布并开始练", change: "更改", newCourse: "Distributed Systems" },
  en: { importFirst: "Add source", paste: "Paste text", title: "Source name", body: "Original text", course: "Course", save: "Save source", makeFirst: "Generate from this source",
    makeCourse: "Make questions from this course's materials", checkDraft: "Check the draft", publish: "Publish and practise", change: "Change", newCourse: "Distributed Systems" },
};
const SEED_OF = { "first-question": "empty", "first-deck": "empty", "new-course": "newcourse", "course-practice": "daily", "daily-continue": "daily" };
export const JOURNEYS = Object.keys(SEED_OF);
const DEFAULT_JOURNEYS = ["first-deck", "course-practice", "daily-continue"];
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export async function runJourney({ browser, running, name, lang, width = 1440 }) {
  const { server, base } = running;
  const api = (action, input = {}) => previewCall(server, action, { ...input, uiLanguage: lang });
  for (const dir of ["library", "home"]) await rm(join(base, dir), { recursive: true, force: true });
  await SEEDS[SEED_OF[name]](api);
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: lang === "en" ? "en-US" : "zh-CN" });
  await context.addInitScript(([l]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", "dark"); } catch { /* blocked */ } }, [lang]);
  const page = await context.newPage();
  const t = TEXT[lang], tally = { clicks: 0, fills: 0, trail: [], milestones: [] };
  const failShot = async () => page.screenshot({ path: join(process.env.STEPS_FAIL_DIR || tmpdir(), `steps-failed-${name}-${lang}.png`) }).catch(() => {});
  const click = async (locator, label) => {
    try { await locator.first().waitFor({ timeout: 20000 }); } catch (error) {
      await failShot();
      throw new Error(`${name}: could not find the button for "${label}" (${String(error.message).split(/\r?\n/)[0]})`);
    }
    await locator.first().click(); tally.clicks++; tally.trail.push(label); await sleep(500);
  };
  const fill = async (locator, value) => {
    try { await locator.first().fill(value, { timeout: 20000 }); } catch (error) { await failShot(); throw error; }
    tally.fills++;
  };
  const reach = (stage) => tally.milestones.push({ stage, clicks: tally.clicks, typed: tally.fills });
  await page.goto(server.url);
  await page.locator(".sidebar").first().waitFor({ timeout: 30000 });
  await sleep(1200);
  const snapshot = () => api("snapshot");
  const jobs = async () => (await snapshot()).jobs.length;
  const before = await jobs();
  const dialog = page.locator("dialog[open]");
  const waitJobStarted = async () => { for (let i = 0; i < 40; i++) { if ((await jobs()) > before) return true; await sleep(250); } return false; };
  /** The newest run ends by itself (the fake model answers in ms): waiting is not a click. */
  const waitJobDone = async () => {
    const job = (await snapshot()).jobs.at(-1);
    const done = await api("job.wait", { jobId: job.id, timeoutSeconds: 90 });
    if (done.status !== "complete") throw new Error(`${name}: the generation ended as ${done.status} (${done.stage})`);
    await sleep(1500);
  };
  const waitQuestion = async () => {
    try { await page.locator('[data-tour="review-question"]').first().waitFor({ timeout: 30000 }); return true; } catch { await failShot(); return false; }
  };
  /** From a finished run to a published deck: the first-run line's own button, else 检查草稿 (a card on the home) and the draft page's publish. */
  const publishDraft = async () => {
    const decks = (await snapshot()).decks.length;
    const linePublish = page.locator('.first-run [data-first-run="publish"]');
    const review = page.locator('.first-run [data-first-run="review"]').or(page.getByRole("button", { name: new RegExp(`^${escapeRe(t.checkDraft)}`) }));
    const publish = page.getByRole("button", { name: new RegExp(`^${escapeRe(t.publish)}`) });
    // The finished run reaches the page with the next poll, and its card settles a poll later (检查草稿 first, then 发布并开始练 once the draft is known
    // to be clean; ui/study-map/JobCard.jsx): wait for a way on, then one more poll, and take the shortest way the screen then offers.
    try { await linePublish.or(review).or(publish).first().waitFor({ timeout: 30000 }); } catch (error) {
      await failShot();
      throw new Error(`${name}: neither a publish button nor 检查草稿 appeared (${String(error.message).split(/\r?\n/)[0]})`);
    }
    await sleep(3000);
    if (await linePublish.first().isVisible()) await click(linePublish, "first-run line: publish and practise");
    else if (await publish.first().isVisible()) await click(publish, "run card: publish and practise");
    else {
      await click(review, "run card: check the draft");
      await click(publish, "draft: publish and practise");
    }
    for (let i = 0; i < 60; i++) { if ((await snapshot()).decks.length > decks) return true; await sleep(250); }
    return false;
  };
  let reached = "NOT REACHED";
  try {
    if (name === "first-question" || name === "first-deck") {
      const material = sampleMaterial(lang);
      await click(page.getByRole("button", { name: t.importFirst }), "first-run line: add my first material");
      await click(dialog.getByRole("button", { name: t.paste, exact: true }), "dialog: paste text");
      await fill(dialog.getByLabel(t.title), material.title);
      await fill(dialog.getByLabel(t.body), material.text);
      await click(dialog.getByRole("button", { name: t.save }), "dialog: save material");
      await page.locator("dialog[open]").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
      // 3.6 D4: the first import comes back to the first-run line, whose step 3 makes the first deck.
      await click(page.locator('.first-run [data-first-run="generate"]'), "first-run line: make the first deck");
      if (await waitJobStarted()) { reach("a generation job"); reached = "a generation job"; }
      if (name === "first-deck" && reached !== "NOT REACHED") {
        await waitJobDone();
        if (await publishDraft()) { reach("deck published"); reached = "deck published"; }
        if (reached === "deck published" && await waitQuestion()) { reach("a practice question"); reached = "a practice question"; }
      }
    } else if (name === "new-course") {
      const checklist = page.getByRole("button", { name: t.makeCourse });
      if (await checklist.count()) await click(checklist, "home checklist: make questions from this course's materials");
      else await click(page.locator('[data-tour="nav-generate"]'), "sidebar: create questions");
      await click(page.locator('[data-tour="generate-submit"]'), "generate: submit");
      if (await waitJobStarted()) { reach("a generation job"); reached = "a generation job"; }
    } else if (name === "course-practice") {
      const material = { title: lang === "en" ? "Week 1 · Consistency" : "第 1 周 · 一致性", text: (lang === "en"
        ? "Replicas converge when every write is applied in the same order. A quorum read sees the latest acknowledged write when read and write quorums overlap. "
        : "当每次写入都按相同顺序应用时，副本会收敛。读写法定人数有交集时，法定人数读能看到最近一次被确认的写入。").repeat(4) };
      await click(page.locator('[data-tour="nav-sources"]'), "sidebar: materials");
      await click(page.getByRole("button", { name: t.importFirst }), "materials: add material");
      await click(dialog.getByRole("button", { name: t.paste, exact: true }), "dialog: paste text");
      await fill(dialog.getByLabel(t.title), material.title);
      await fill(dialog.getByLabel(t.body), material.text);
      // The dialog files the material under the current course; 更改 opens the course field, where a new name is typed.
      await click(dialog.getByRole("button", { name: t.change, exact: true }), "dialog: change the course");
      await fill(dialog.locator(".course-field input"), t.newCourse);
      await click(dialog.getByRole("button", { name: t.save }), "dialog: save material");
      await page.locator("dialog[open]").waitFor({ state: "detached", timeout: 15000 }).catch(() => {});
      const row = page.locator(".source-row, li, article").filter({ hasText: material.title }).getByRole("button", { name: t.makeFirst });
      const make = (await row.count()) ? row : page.getByRole("button", { name: t.makeFirst });
      await click(make, "materials: make questions from this material");
      await click(page.locator('[data-tour="generate-submit"]'), "generate: submit");
      if (await waitJobStarted()) { reach("a generation job"); reached = "a generation job"; }
      if (reached !== "NOT REACHED") {
        await waitJobDone();
        if (await publishDraft()) { reach("deck published"); reached = "deck published"; }
        // The new deck must belong to the new course, or the journey did not do what it says.
        const decks = (await snapshot()).decks;
        tally.deckCourse = decks.at(-1)?.course ?? null;
        if (reached === "deck published" && tally.deckCourse !== t.newCourse) reached = `NOT REACHED (the deck went to ${JSON.stringify(tally.deckCourse)})`;
        if (reached === "deck published" && await waitQuestion()) { reach("a practice question"); reached = "a practice question"; }
      }
    } else {
      await click(page.locator(".today-go"), "home: continue");
      if (await waitQuestion()) { reach("a practice question"); reached = "a practice question"; }
    }
  } finally {
    tally.url = page.url();
    await context.close();
  }
  return { journey: name, lang, clicks: tally.clicks, typed: tally.fills, reached, milestones: tally.milestones, trail: tally.trail, url: tally.url,
    ...(tally.deckCourse !== undefined ? { deckCourse: tally.deckCourse } : {}) };
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n, d) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
  const lang = flag("lang", "zh"), label = flag("label", "after"), dist = flag("dist", "");
  const names = flag("journeys", DEFAULT_JOURNEYS.join(",")).split(",").filter(Boolean);
  const unknown = names.filter((n) => !JOURNEYS.includes(n));
  if (unknown.length) throw new Error(`unknown journey: ${unknown.join(", ")} (known: ${JOURNEYS.join(", ")})`);
  const out = resolve(flag("out", join(repoRoot, "output/qa/tiers")));
  await mkdir(out, { recursive: true });
  const running = await startNavServer({ ...(dist ? { distDir: resolve(dist) } : {}) });
  const browser = await launchChromium();
  const rows = [];
  try {
    for (const name of names) rows.push(await runJourney({ browser, running, name, lang }));
  } finally {
    await browser.close().catch(() => {});
    await running.close();
  }
  await writeFile(flag("json", join(out, `${label}-steps.json`)), JSON.stringify(rows, null, 1));
  for (const row of rows) console.log(`${row.journey.padEnd(16)} ${row.clicks} clicks, ${row.typed} fields typed → ${row.reached}\n    ${row.milestones.map((m) => `${m.stage}: ${m.clicks}`).join(" · ")}\n    ${row.trail.join(" → ")}`);
  process.exit(rows.some((row) => row.reached.startsWith("NOT REACHED")) ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
