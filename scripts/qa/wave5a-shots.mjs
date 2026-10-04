/* node scripts/qa/wave5a-shots.mjs [--surface sources|<more> --lang zh|en --theme dark|light --width 1280|420 --out <dir>]
   (build first: npm run build)
   UI wave 5 part A in the browser preview, on a seeded temporary library with the fake model and no network: the surfaces
   the clean-up touched. sources = the page list and the chapter list of a converted book on the 资料 page. */
/* global document, getComputedStyle -- page.evaluate callbacks run in the browser */
import { join } from "node:path";
import { Store } from "../../lib/store.js";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const options0 = parseQaArgs(process.argv.slice(2), "wave5a", { surface: "sources" });
const at = "2026-10-05T08:00:00.000Z";
const HASH = "a".repeat(64);

async function seed(library) {
  const pages = Array.from({ length: 9 }, (_, index) => ({ id: `bk-${index + 1}`, title: `Operating systems textbook · p.${index + 1}`, text: `Page ${index + 1} of the textbook. `.repeat(40 + index * 7), createdAt: at, courses: ["QA"],
    document: { id: HASH, materialId: `document-${HASH}-pdf`, format: "pdf", page: index + 1, totalPages: 9, bookTitle: "Operating systems textbook", filename: "os.pdf", extractionVersion: 2,
      origin: "converted", converter: "mineru", chapter: { index: Math.floor(index / 3), title: ["Processes and threads with a rather long chapter title that has to ellipsise", "Memory", "File systems"][Math.floor(index / 3)], level: 1 } } }));
  const plain = Array.from({ length: 4 }, (_, index) => ({ id: `pl-${index + 1}`, title: `Lecture slides · p.${index + 1}`, text: `Slide ${index + 1}. `.repeat(30), createdAt: at, courses: ["QA"],
    document: { id: "b".repeat(64), materialId: `document-${"b".repeat(64)}-pdf`, format: "pdf", page: index + 1, totalPages: 4, filename: "slides.pdf", extractionVersion: 2 } }));
  await new Store(library).update((state) => { state.sources.push(...pages, ...plain); });
}

export async function runShots(options) {
  return runQa({ name: "wave5a", options, seed, async run({ page, t, step, check }) {
    const go = async (usage) => { await page.locator(`[data-usage="${usage}"]`).first().click(); await sleep(700); };
    const later = page.getByRole("button", { name: t("以后再说", "Maybe later"), exact: true });
    if (await later.count()) { await later.click(); await sleep(400); }
    const narrowMenu = async () => {
      const toggle = page.locator(".collapse-toggle, .nav-toggle, [data-usage='nav.toggle']").first();
      if (options.width < 700 && await toggle.count() && !(await page.locator(`[data-usage="nav.sources"]`).first().isVisible())) await toggle.click().catch(() => {});
    };
    if (options.surface === "sources") {
      await narrowMenu();
      await go("nav.sources");
      await step("sources-collapsed", async () => {});
      const toggles = page.locator(".source-doc__pages-toggle");
      for (let index = 0; index < await toggles.count(); index += 1) await toggles.nth(index).click();
      await sleep(500);
      await step("sources-lists-open", async () => { await page.locator(".source-doc__page-list").first().scrollIntoViewIfNeeded(); });
      await check("each list row is one full-width line with an ellipsis", async () => {
        const probe = await page.evaluate(() => {
          const rows = [...document.querySelectorAll(".source-doc__page-list > li > .sh-btn:first-child")];
          return rows.map((button) => {
            const li = button.parentElement.getBoundingClientRect(), box = button.getBoundingClientRect(), style = getComputedStyle(button), label = button.querySelector("span");
            return { text: label?.textContent?.slice(0, 20), width: Math.round(box.width), li: Math.round(li.width), height: Math.round(box.height), align: style.justifyContent, border: style.borderTopWidth, ellipsis: label ? getComputedStyle(label).textOverflow : "", nowrap: label ? getComputedStyle(label).whiteSpace : "" };
          });
        });
        console.log(JSON.stringify(probe));
        if (!probe.length) throw new Error("no rows");
      });
      await check("no horizontal overflow", async () => { const probe = await page.evaluate(overflowProbe); if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(JSON.stringify(probe)); });
    }
    return join(options.out, "summary.json");
  } });
}

if (process.argv[1]?.endsWith("wave5a-shots.mjs")) finishCli("wave5a", options0, await runShots(options0));
