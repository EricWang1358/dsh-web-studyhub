/* node scripts/qa/fsrs-shots.mjs [--lang zh|en --theme dark|light --width 1280|420 --out <dir>]   (build first: node scripts/build.mjs)
   The FSRS-6 scheduler in the browser preview: the 0–5 answer buttons with the gap each grade gives (a question whose review state was written
   by the SM-2 builds, so its gaps come from the migration), the hover explanation of those gaps, and 设置 › 导入、计划与备份 › 间隔复习 with its
   two fields and a field's hover explanation. Each step checks that the page does not scroll sideways. Seeded temporary library, fake model,
   no network. */
/* global window -- page.evaluate callbacks run in the browser */
import { StudyService } from "../../lib/service.js";
import { Store } from "../../lib/store.js";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const options = parseQaArgs(process.argv.slice(2), "fsrs-shots", {});
const SOURCE = { id: "qa-fsrs-notes", title: "Operating systems notes", courses: ["QA"],
  text: "A process is the unit of resource allocation in an operating system, and a thread is the unit of scheduling inside a process." };
const QUOTE = "A process is the unit of resource allocation in an operating system";

async function seed(root) {
  const service = new StudyService(root);
  await service.call("source.add", SOURCE);
  const card = (id) => ({ id, kind: "flashcard", topic: "Processes", objective: "Tell a process from a thread", prompt: `What does a process own that a thread does not? (${id})`,
    answer: "The resources: the address space and open files.", hint: "Think about what is shared.", explanation: "A process owns resources; a thread only owns what it needs to run.",
    misconception: "Believing a thread is just a smaller process.", citations: [{ sourceId: SOURCE.id, quote: QUOTE }] });
  await service.call("draft.save", { deck: { id: "qa-fsrs", title: "Processes and threads", cards: [card("c1"), card("c2")] } });
  await service.call("draft.publish", { id: "qa-fsrs" });
  service.dispose?.();
  // c1 as an SM-2 build left it: answered right twice, a 6-day interval, due now.
  await new Store(root).update((s) => {
    const due = new Date(Date.now() - 3600e3).toISOString();
    s.decks.find((deck) => deck.id === "qa-fsrs").cards.find((item) => item.id === "c1").review = { repetitions: 2, interval_days: 6, ease_factor: 2.5, due_at: due };
  });
}

const api = (page, action, args = {}) => page.evaluate(async ([name, body]) => {
  const response = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json", "x-study-token": window.STUDY_TOKEN }, body: JSON.stringify({ action: name, args: body }) });
  const json = await response.json();
  if (!json.ok) throw new Error(json.error || name);
  return json.value;
}, [action, args]);

const noSideways = async (page, where) => {
  const probe = await page.evaluate(overflowProbe);
  if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`${where}: horizontal overflow ${JSON.stringify(probe)}`);
};

const summary = await runQa({ name: "fsrs-shots", options, seed, async run({ page, t, step }) {
  const nav = async (usage) => { await page.locator(`[data-usage="nav.${usage}"]`).first().click(); await sleep(700); };
  const run = await api(page, "review.start", { deckId: "qa-fsrs", mode: "flashcard", scope: [{ deckId: "qa-fsrs", cardId: "c1" }] });
  const revealed = await api(page, "review.reveal", { runId: run.id, cardId: run.card.id });
  await step("answer-buttons", async () => {
    await page.reload(); await page.locator("aside, nav").first().waitFor({ timeout: 30000 }); await sleep(700);
    await page.getByRole("button", { name: new RegExp(t("回到题目", "Return to question")) }).first().click();
    await page.locator(".grade-scale").waitFor({ timeout: 20000 });
    await page.locator(".grade-scale").scrollIntoViewIfNeeded(); await page.mouse.move(options.width - 5, options.height - 5); await sleep(500);
    const gaps = await page.locator(".grade .grade-gap").allInnerTexts();
    if (gaps.length !== 6) throw new Error(`gaps under the buttons: ${gaps.length}`);
    await noSideways(page, "answer buttons");
    return { card: run.card.id, intervals: revealed.intervals, shown: gaps };
  });
  await step("answer-buttons-tip", async () => {
    await page.locator(".grade-gaps-tip").hover(); await sleep(600);
    await noSideways(page, "answer buttons tip");
  });
  await step("settings-schedule", async () => {
    await page.mouse.move(0, 0);
    await nav("settings");
    await page.locator('[data-category="data"]').first().click(); await sleep(500);
    const section = page.locator(".sm2-settings");
    await section.waitFor({ timeout: 20000 });
    await section.evaluate((element) => element.scrollIntoView({ block: "center" })); await sleep(400);
    if (await page.locator(".sm2-settings input[type=number]").count() !== 2) throw new Error("expected two number fields");
    await noSideways(page, "settings");
  });
  await step("settings-schedule-tip", async () => {
    await page.locator(".sm2-field-tip").first().hover(); await sleep(600);
    await noSideways(page, "settings tip");
  });
} });
finishCli("fsrs-shots", options, summary);
