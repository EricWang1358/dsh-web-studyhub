import { seedLibrary } from "./perf-seed.mjs";
import { parseQaArgs, runQa, sleep } from "./harness.mjs";
const options = parseQaArgs(process.argv.slice(2), "pages-look", {});
/* A screenshot of every page of the sidebar, in the chosen language, theme and width: what each page looks like is the point of this script (design review). */
await runQa({ name: "pages-look", options, seed: (root) => seedLibrary(root, { sources: 20, decks: 3, cardsPerDeck: 8, runs: 3, attempts: 50, courses: 3, largeSources: 1, largeSourceChars: 6000 }),
  async run({ page, step }) {
    await page.waitForSelector("button.nav", { timeout: 20000 });
    const labels = await page.locator("button.nav").evaluateAll((items) => items.map((item, index) => ({ index, text: (item.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24) })));
    for (const { index, text } of labels) {
      await step(`page-${String(index).padStart(2, "0")}-${text.replace(/[^\p{L}\p{N}]+/gu, "_")}`, async () => {
        const row = page.locator("button.nav").nth(index);
        if (await row.isDisabled().catch(() => true)) return "disabled";
        await row.click().catch(() => {});
        await sleep(500);
        return text;
      });
    }
  } });
