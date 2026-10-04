/* node scripts/qa/appearance-look.mjs [--lang zh|en --width 1440|420 --out <dir>]   (build first: node scripts/build.mjs)
   #66: the extra themes, high contrast, density and corner style in the browser preview. For each look (default dark and light, OLED black, paper,
   high contrast on dark and on light, compact and comfortable density, sharp and soft corners) it stamps the choice in localStorage, reloads, and
   takes a screenshot of the home page, a review page, the source reader and 设置 › 界面, checking that the root carries the attributes and tokens
   the choice promises, that nothing overflows the window sideways, and that nothing inside the page is wider than its box (clipped text).
   Then forced colours are emulated on the settings page. Seeded temporary library, fake model, no network. */
/* global document, window, localStorage, getComputedStyle -- page.evaluate callbacks run in the browser */
import { StudyService } from "../../lib/service.js";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const SOURCE = { id: "qa-look-notes", title: "Operating systems notes", courses: ["QA"],
  text: "A process is the unit of resource allocation in an operating system, and a thread is the unit of scheduling inside a process.\n\nVirtual memory gives every process its own address space, which the memory manager maps onto physical frames on demand. Page replacement decides which resident page leaves memory when a new page must be brought in." };
const QUOTE = "A process is the unit of resource allocation in an operating system";

async function seed(root) {
  const service = new StudyService(root);
  await service.call("source.add", SOURCE);
  const card = id => ({ id, kind: "flashcard", topic: "Processes", objective: "Tell a process from a thread", prompt: `What does a process own that a thread does not? (${id})`,
    answer: "The resources: the address space and open files.", hint: "Think about what is shared.",
    explanation: "A **process** owns resources; a **thread** only owns what it needs to run.\n\n| Unit | Owns resources |\n| --- | --- |\n| Process | yes |\n| Thread | no |",
    misconception: "Believing a thread is just a smaller process.", citations: [{ sourceId: SOURCE.id, quote: QUOTE }] });
  await service.call("draft.save", { deck: { id: "qa-look", title: "Processes and threads", cards: [card("c1"), card("c2")] } });
  await service.call("draft.publish", { id: "qa-look" });
}

const api = (page, action, args = {}) => page.evaluate(async ([name, body]) => {
  const response = await fetch("/api/call", { method: "POST", headers: { "content-type": "application/json", "x-study-token": window.STUDY_TOKEN }, body: JSON.stringify({ action: name, args: body }) });
  const json = await response.json();
  if (!json.ok) throw new Error(json.error || name);
  return json.value;
}, [action, args]);

/** [name, theme, interface patch, tokens the root must resolve to] */
export const LOOKS = [
  ["dark", "dark", {}, {}],
  ["light", "light", {}, {}],
  ["oled", "oled", {}, { "--bg-canvas": "#060505" }],
  ["paper", "paper", {}, { "--bg-canvas": "#f1e8d3" }],
  ["dark-high", "dark", { contrast: "high" }, { "--line": "#847c70" }],
  ["light-high", "light", { contrast: "high" }, { "--line": "#766c5a" }],
  ["compact", "dark", { density: "compact" }, { "--space-4": "12px", "--lh-body": "1.5" }],
  ["comfortable", "dark", { density: "comfortable" }, { "--space-4": "20px", "--lh-body": "1.8" }],
  ["sharp", "dark", { radius: "sharp" }, { "--radius": "4px", "--radius-card": "6px" }],
  ["soft", "dark", { radius: "soft" }, { "--radius": "18px", "--radius-card": "24px" }],
  ["paper-comfortable-soft", "paper", { density: "comfortable", radius: "soft" }, { "--space-4": "20px", "--radius": "18px" }],
];

/** Elements whose content is wider/taller than their box while the box clips it: text cut off. */
const clipped = () => [...document.querySelectorAll(".study-app *")].filter((element) => {
  const style = getComputedStyle(element);
  if (!element.offsetParent || style.visibility === "hidden") return false;
  const clips = ["hidden", "clip"].includes(style.overflowX) && style.textOverflow !== "ellipsis" && !style.webkitLineClamp?.match(/\d/);
  return clips && element.scrollWidth > element.clientWidth + 2 && element.clientWidth > 3 && element.children.length === 0 && !!element.textContent.trim();
}).slice(0, 6).map((element) => `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 40)} ${element.scrollWidth}>${element.clientWidth}: ${element.textContent.trim().slice(0, 30)}`);

export async function runAppearanceLook(options) {
  return runQa({ name: "appearance-look", options, seed, async run({ page, browserContext, t, step, check }) {
    // The harness stamps its own --theme on every load; a theme chosen here rides in sessionStorage and is applied after it.
    await browserContext.addInitScript(() => { try { const value = sessionStorage.getItem("qa-theme"); if (value) localStorage.setItem("study-theme", value); } catch { /* blocked */ } });
    const run = await api(page, "review.start", { deckId: "qa-look", mode: "flashcard" });
    await api(page, "review.reveal", { runId: run.id, cardId: run.card.id }).catch(() => {});
    await api(page, "review.answer", { runId: run.id, cardId: run.card.id, grade: 1 }).catch(() => {});
    const root = () => page.locator(".study-app").first();
    const settle = async () => { await page.locator("aside, nav").first().waitFor({ timeout: 30000 }); await sleep(700); };
    const verify = async (name, tokens) => {
      const probe = await page.evaluate(overflowProbe);
      if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`${name}: horizontal overflow ${JSON.stringify(probe)}`);
      const cut = await page.evaluate(clipped);
      if (cut.length) throw new Error(`${name}: clipped text ${cut.join(" | ")}`);
      const seen = await root().evaluate((element, names) => Object.fromEntries(names.map((token) => [token, getComputedStyle(element).getPropertyValue(token).trim()])), Object.keys(tokens));
      for (const [token, value] of Object.entries(tokens)) if (seen[token] !== value) throw new Error(`${name}: ${token} is ${seen[token]}, expected ${value}`);
    };

    for (const [name, theme, patch, tokens] of LOOKS) {
      await page.evaluate(([themeValue, interfaceValue]) => { sessionStorage.setItem("qa-theme", themeValue); localStorage.setItem("study-interface", JSON.stringify(interfaceValue)); }, [theme, patch]);
      await page.reload(); await settle();
      await step(`${name}-home`, async () => { await verify(`${name} home`, tokens); return await root().evaluate((element) => [element.dataset.theme, element.dataset.palette, element.dataset.contrast, element.dataset.density, element.dataset.radius].join("/")); });
      await step(`${name}-review`, async () => {
        await page.getByRole("button", { name: new RegExp(t("回到题目", "Return to question")) }).first().click();
        await page.locator(".explanation").first().waitFor({ timeout: 20000 }); await sleep(400);
        await verify(`${name} review`, tokens);
      });
      await step(`${name}-reader`, async () => {
        await page.getByRole("button", { name: /^(查看 \d+ 份资料|View \d+ sources?)/ }).first().click();
        await page.locator("dialog[open] button.source-row").first().click();
        await page.locator(".study-document-viewer").waitFor(); await sleep(500);
        await verify(`${name} reader`, tokens);
      });
      await page.keyboard.press("Escape"); await sleep(300);
      await step(`${name}-settings`, async () => {
        await page.getByRole("button", { name: t("设置", "Settings"), exact: true }).first().click();
        await page.waitForSelector(".settings-nav", { timeout: 15000 });
        if (!(await page.locator(".appearance-settings").first().isVisible().catch(() => false))) await page.locator('[data-category="appearance"]').click();
        await page.locator(".appearance-settings").waitFor({ state: "visible", timeout: 15000 });
        await page.locator(".appearance-settings").scrollIntoViewIfNeeded();
        await verify(`${name} settings`, tokens);
      });
    }

    // The choices themselves: click each new control in Settings and see the root follow, then restore.
    const choose = (label) => page.getByRole("button", { name: label, exact: true }).first();
    await check("settings-controls-drive-the-root", async () => {
      await page.evaluate(() => { localStorage.removeItem("study-interface"); sessionStorage.setItem("qa-theme", "dark"); });
      await page.reload(); await settle();
      await page.getByRole("button", { name: t("设置", "Settings"), exact: true }).first().click();
      await page.waitForSelector(".settings-nav", { timeout: 15000 });
      if (!(await page.locator(".appearance-settings").first().isVisible().catch(() => false))) await page.locator('[data-category="appearance"]').click();
      const attr = (name) => root().getAttribute(name);
      await choose(t("纯黑 OLED", "Pure black (OLED)")).click(); await sleep(250);
      if ((await attr("data-palette")) !== "oled" || (await attr("data-theme")) !== "dark") throw new Error("oled did not reach the root");
      await choose(t("护眼纸色", "Paper (eye comfort)")).click(); await sleep(250);
      if ((await attr("data-palette")) !== "paper" || (await attr("data-theme")) !== "light") throw new Error("paper did not reach the root");
      await choose(t("高对比", "High")).click(); await sleep(250);
      if ((await attr("data-contrast")) !== "high") throw new Error("high contrast did not reach the root");
      await choose(t("紧凑", "Compact")).click(); await choose(t("利落", "Sharp")).click(); await sleep(250);
      if ((await attr("data-density")) !== "compact" || (await attr("data-radius")) !== "sharp") throw new Error("density or corners did not reach the root");
      const stored = await page.evaluate(() => [localStorage.getItem("study-theme"), JSON.parse(localStorage.getItem("study-interface"))]);
      if (stored[0] !== "paper" || stored[1].contrast !== "high" || stored[1].density !== "compact" || stored[1].radius !== "sharp") throw new Error(`stored ${JSON.stringify(stored)}`);
      await page.getByRole("button", { name: t("恢复默认外观", "Restore default appearance") }).click(); await sleep(250);
      if ((await attr("data-palette")) !== "standard" || (await attr("data-density")) !== "standard" || (await attr("data-radius")) !== "standard") throw new Error("restore did not bring the defaults back");
      return stored;
    });
    await check("system-contrast-request-is-followed-live", async () => {
      await page.emulateMedia({ contrast: "more" }); await sleep(300);
      if ((await root().getAttribute("data-contrast")) !== "high") throw new Error("prefers-contrast: more did not switch contrast to high");
      await page.emulateMedia({ contrast: "no-preference" }); await sleep(300);
      if ((await root().getAttribute("data-contrast")) !== "standard") throw new Error("it did not come back");
    });
    await step("forced-colors-settings", async () => {
      await page.emulateMedia({ forcedColors: "active" }); await sleep(400);
      await page.locator(".appearance-settings").scrollIntoViewIfNeeded();
      const probe = await page.evaluate(overflowProbe);
      if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`overflow in forced colours ${JSON.stringify(probe)}`);
    });
  } });
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("appearance-look.mjs")) {
  const options = parseQaArgs(process.argv.slice(2), "appearance-look", {});
  finishCli("appearance-look", options, await runAppearanceLook(options));
}
