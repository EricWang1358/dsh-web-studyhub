
import { seedLibrary } from "./perf-seed.mjs";
import { parseQaArgs, runQa, sleep } from "./harness.mjs";
const options = parseQaArgs(process.argv.slice(2), "settings-look", {});
await runQa({ name: "settings-look", options, seed: (root) => seedLibrary(root, { sources: 20, decks: 3, cardsPerDeck: 8, runs: 3, attempts: 50, courses: 3, largeSources: 1, largeSourceChars: 6000 }),
  async run({ page, step, t }) {
    await step("open-settings", async () => { await page.getByRole("button", { name: t("设置", "Settings"), exact: true }).first().click(); await page.waitForSelector(".settings-page"); });
    // Every category in turn: a screenshot each (what the page looks like is the point of this script).
    const categories = await page.locator(".settings-nav__item").evaluateAll((items) => items.map((item) => item.dataset.category));
    for (const id of categories) {
      await step(`category-${id}`, async () => { await page.locator(`[data-category="${id}"]`).click(); await sleep(400); return await page.locator(".settings-pane").evaluate((pane) => pane.getBoundingClientRect().width); });
    }
  } });
