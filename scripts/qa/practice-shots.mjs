/* node scripts/qa/practice-shots.mjs [--out=<dir>] [--theme=light|dark] [--width=1440|420] [--lang=zh|en]
   The practice page in a real browser, on a throw-away library (fake model, no network, every key variable removed), for the UI batch of #660 #661 #671 #672 #673.
   A deck is made from three materials (two texts and a three-page PDF, so the round cites four source ids: #661), a round is started, the first question is
   answered wrongly, the rest rightly, up to the re-ask. It writes, to <out>/<width>-<lang>-<theme>-<step>.png and prints the numbers the pictures should show:
     01-start      the first question: the counter, the header's 「查看 N 份资料」, the rail of ticks
     02-wrong      right after the wrong answer: the counter and the feedback (in the card since #672)
     03-next       the second question: the counter did not grow
     04-toolbar    the toolbar under the card
     05-more       the 更多 menu open
     06-retry      the re-ask at the end of the round
   Default output: output/practice-shots/after. Run it from an older checkout to get the "before" pictures: it only uses what that checkout has. */
/* global document, getComputedStyle, innerHeight -- page.evaluate callbacks run in the browser */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewCall } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { samplePdfHtml } from "./fixtures.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, value = "1"] = arg.replace(/^--/, "").split("="); return [key, value]; }));
const lang = args.lang || "zh", theme = args.theme || "light", width = Number(args.width || 1440);
const out = resolve(repoRoot, args.out || "output/practice-shots/after");
const SOURCES = [
  { id: "t1", title: lang === "en" ? "Spaced repetition" : "间隔重复与遗忘曲线", text: "Spaced repetition schedules each review just before the memory fades, so every review lasts longer than the one before." },
  { id: "t2", title: "observer-pattern.md", text: "The observer pattern lets many listeners react to one subject without the subject knowing who they are." },
];

scrubProcessEnv();
const base = await mkdtemp(join(tmpdir(), "study-practice-shots-"));
await mkdir(out, { recursive: true });
const server = await createPreviewServer({ libraryRoot: join(base, "library"), home: join(base, "home"), port: 0, model: createFakeModel({ latencyMs: 50, generationLatencyMs: 300 }) });
const api = (action, input = {}) => previewCall(server, action, { ...input, uiLanguage: lang });
const browser = await launchChromium();
const problems = [], facts = {};
try {
  for (const source of SOURCES) await api("source.add", source);
  // A PDF is one source per page: the three pages are one material (#661).
  const pdf = join(base, "qa-database-indexes.pdf");
  const maker = await browser.newPage();
  await maker.setContent(samplePdfHtml(lang), { waitUntil: "load" });
  await maker.pdf({ path: pdf, format: "A5", printBackground: true });
  await maker.close();
  await api("source.import", { path: pdf });
  const sourceIds = (await api("snapshot")).sources.map((source) => source.id);
  const job = await api("generate", { sourceIds, count: 4, kind: "quiz", title: "QA seed", language: lang === "en" ? "English" : "中文" });
  const done = await api("job.wait", { jobId: job.jobId, timeoutSeconds: 60 });
  if (done.status !== "complete") throw new Error(`generation ended as ${done.status}`);
  const draft = (await api("snapshot")).drafts[0];
  await api("draft.publish", { id: draft.id, draftVersion: draft.draftVersion });
  const deck = (await api("snapshot")).decks.find((item) => !item.systemKind);
  let run = await api("review.start", { deckId: deck.id, mode: "quiz" });
  facts.citedSourceIds = run.sourceIds?.length;

  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === "en" ? "en-US" : "zh-CN", colorScheme: theme });
  await context.addInitScript(([l, t]) => { try { localStorage.setItem("study-ui-language", l); localStorage.setItem("study-theme", t); localStorage.removeItem("study-sidebar"); } catch { /* blocked */ } }, [lang, theme]);
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`page error ${error}`));
  const t = (zh, en) => (lang === "en" ? en : zh);
  const settle = async (ms = 700) => { await page.waitForLoadState("networkidle").catch(() => {}); await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming?.().iterations === Infinity), null, { timeout: 4000 }).catch(() => {}); await sleep(ms); };
  const shot = async (name, target) => { await settle(500); const file = join(out, `${width}-${lang}-${theme}-${name}.png`); if (target) await target.screenshot({ path: file }); else await page.screenshot({ path: file }); };
  /** The page is a scrolling panel: a tall picture of it, so the card, its feedback and the toolbar are all in one frame. */
  const tall = async (name) => {
    await settle(500);
    const height = await page.evaluate(() => { let tallest = innerHeight; for (const el of document.querySelectorAll(".study-app, .study-app *")) { const o = getComputedStyle(el).overflowY; if (/auto|scroll/.test(o) && el.scrollHeight > el.clientHeight + 4 && el.clientHeight > innerHeight / 2) tallest = Math.max(tallest, el.scrollHeight + innerHeight - el.clientHeight); } return tallest; });
    await page.setViewportSize({ width, height: Math.min(Math.max(height, 900), 2400) });
    await settle(300);
    await page.screenshot({ path: join(out, `${width}-${lang}-${theme}-${name}.png`) });
    await page.setViewportSize({ width, height: 900 });
    await sleep(200);
  };
  await page.goto(server.url);
  await page.locator("aside, nav").first().waitFor({ timeout: 60000 });
  await settle(900);
  const resume = page.getByRole("button", { name: t("回到题目", "Back to the question") }).first();
  if (await resume.count()) await resume.click(); else await page.locator('[data-usage="nav.resume"]').first().click();
  await page.locator(".options .option").first().waitFor({ timeout: 20000 });
  const counter = async () => (await page.locator(".question-meta > span").first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const rail = async () => page.locator(".review-tick").count();
  facts.start = { counter: await counter(), ticks: await rail(), materials: (await page.locator(".review-heading-links").first().innerText()).replace(/\s+/g, " ") };
  await tall("01-start");

  const answer = async (right) => {
    const current = await api("review.get", { runId: run.id });
    const live = (await api("deck.get", { id: current.card.deckId || current.deckId })).cards.find((item) => item.id === current.card.id);
    const option = live.options.find((item) => item.correct === right) || live.options[0];
    await page.locator(".options .option", { hasText: option.text }).first().click();
    const submit = page.getByRole("button", { name: t("提交答案", "Submit answer") });
    if (await submit.count() && await submit.first().isEnabled()) await submit.first().click();
    await page.locator(".options .option.correct").first().waitFor({ timeout: 15000 });
  };
  const next = async () => {
    await page.getByRole("button", { name: new RegExp(t("下一题|完成", "Next question|Finish")) }).first().click();
    await page.locator(".options .option:not([disabled])").first().waitFor({ timeout: 15000 });
  };
  await answer(false);
  await settle();
  facts.afterWrong = { counter: await counter(), feedback: (await page.locator(".next-due").first().innerText()).replace(/\s+/g, " "), insideCard: await page.locator(".question-card .next-due").count() > 0 };
  await tall("02-wrong");
  await next();
  facts.second = { counter: await counter(), ticks: await rail() };
  await tall("03-next");
  const toolbar = page.locator(".question-toolbar").first();
  await toolbar.scrollIntoViewIfNeeded();
  facts.toolbar = { buttons: await toolbar.locator("button:visible").count(), labels: (await toolbar.locator("button:visible").allInnerTexts()).map((label) => label.replace(/\s+/g, " ").trim()) };
  await shot("04-toolbar", toolbar);
  const more = page.getByRole("button", { name: t("更多", "More"), exact: true }).first();
  await more.click();
  await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
  facts.more = (await page.locator('[role="menu"] [role^="menuitem"]').allInnerTexts()).map((label) => label.replace(/\s+/g, " ").trim());
  await settle(300);
  await page.screenshot({ path: join(out, `${width}-${lang}-${theme}-05-more.png`) });
  await page.keyboard.press("Escape");
  await answer(true);
  for (let step = 0; step < 12; step++) { await next(); if (/^(再练|Retry)/.test(await counter()) || /本轮重练|Session retry/.test(await page.locator(".review-heading").first().innerText())) break; await answer(true); }
  facts.retry = { counter: await counter(), retry: (await api("review.get", { runId: run.id })).retry };
  facts.sources = (await api("snapshot")).sources.length;
  await tall("06-retry");
  const tick = page.locator(".review-tick").nth(1);
  if (await tick.count() && await tick.isVisible()) { await tick.hover(); await settle(500); await page.screenshot({ path: join(out, `${width}-${lang}-${theme}-07-tick-hover.png`), clip: { x: 0, y: 0, width: Math.min(width, 700), height: 420 } }); }
  console.log(JSON.stringify(facts, null, 2));
} catch (error) {
  problems.push(String(error?.stack || error));
} finally {
  await browser.close().catch(() => {});
  await server.close();
  await rm(base, { recursive: true, force: true });
}
if (problems.length) { console.error(problems.join("\n")); process.exitCode = 1; }
