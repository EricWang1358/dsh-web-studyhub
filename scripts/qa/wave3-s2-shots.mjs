/* node scripts/qa/wave3-s2-shots.mjs [--lang zh|en --theme dark|light --width 1280|420 --out <dir>]
   (build first: npm run build)
   UI wave 3, WP-S2 in the browser preview: the surfaces whose buttons moved to Button / IconButton / SegmentedControl — the add-material
   dialog (import hub), the mailbox, the board filters, the Settings panes with buttons (data, updates), and the reader's toolbar.
   A seeded temporary library (the sample course), the fake model, no network. */
/* global document -- page.evaluate callbacks run in the browser */
import { join } from "node:path";
import { previewCall } from "../preview-server.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

const options0 = parseQaArgs(process.argv.slice(2), "wave3-s2");

async function seed() {}

export async function runShots(options) {
  return runQa({ name: "wave3-s2", options, seed, async run({ page, server, t, step, check }) {
    await previewCall(server, "sample.load", { uiLanguage: options.lang });
    await page.reload();
    await page.locator("aside, nav").first().waitFor();
    const later = page.getByRole("button", { name: t("以后再说", "Maybe later"), exact: true });
    if (await later.count()) { await later.click(); await sleep(400); }
    const go = async (usage) => { await page.locator(`[data-usage="${usage}"]`).first().click(); await sleep(700); };
    const narrowMenu = async () => {
      // Narrow widths keep the navigation in a drawer; opening it is the page's own toggle.
      const toggle = page.locator(".collapse-toggle, .nav-toggle, [data-usage='nav.toggle']").first();
      if (options.width < 700 && await toggle.count() && !(await page.locator(`[data-usage="nav.board"]`).first().isVisible())) await toggle.click().catch(() => {});
    };
    await narrowMenu();
    await step("board", async () => { await go("nav.board"); });
    await step("mailbox", async () => { await page.locator(".mailbox__toggle").click(); await page.locator(".mailbox__panel").waitFor(); await sleep(300); });
    await step("mailbox-hover", async () => {
      // The full text of a truncated entry: a card beside it on hover (and on keyboard focus), the open hint as its last line.
      await page.locator(".mailbox__item").nth(1).hover();
      await page.locator('.mailbox-preview:popover-open').waitFor({ timeout: 5000 });
      await sleep(300);
    });
    await check("the hovered entry is described by its card and carries no native title", async () => {
      const probe = await page.evaluate(() => {
        const button = document.querySelectorAll(".mailbox__item")[1], card = document.getElementById(button.getAttribute("aria-describedby") || "");
        return { title: button.getAttribute("title"), open: !!card?.matches(":popover-open"), text: card?.textContent || "", width: card?.getBoundingClientRect().width || 0 };
      });
      if (probe.title !== null || !probe.open || probe.width > 362 || probe.text.length < 20) throw new Error(JSON.stringify(probe));
    });
    // The first Escape hides the entry's card, the second closes the panel.
    await page.mouse.move(2, 2);
    await page.keyboard.press("Escape");
    await sleep(200);
    if (await page.locator(".mailbox__panel").count()) await page.locator(".mailbox__toggle").click();
    await step("add-material", async () => {
      await narrowMenu();
      await go("nav.sources");
      await page.getByRole("button", { name: t("添加资料", "Add source") }).first().click();
      await page.locator("dialog[open]").waitFor();
      await sleep(400);
    });
    await page.keyboard.press("Escape");
    await step("settings-data", async () => {
      await narrowMenu();
      await go("nav.settings");
      await page.getByRole("button", { name: t("导入、计划与备份", "Import, schedule and backup") }).first().click().catch(async () => { await page.getByText(t("导入、计划与备份", "Import")).first().click(); });
      await sleep(600);
    });
    await step("settings-update", async () => {
      await page.getByRole("button", { name: t("关于与更新", "About and updates") }).first().click().catch(async () => { await page.getByText(t("关于与更新", "About")).first().click(); });
      await sleep(600);
    });
    await step("reader", async () => {
      await narrowMenu();
      await go("nav.sources");
      await page.locator(".source-doc .source-main").first().click();
      await page.locator(".study-document-viewer").waitFor({ timeout: 15000 });
      await sleep(900);
    });
    await check("no horizontal overflow", async () => { const probe = await page.evaluate(overflowProbe); if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(JSON.stringify(probe)); });
    return join(options.out, "summary.json");
  } });
}

if (process.argv[1]?.endsWith("wave3-s2-shots.mjs")) finishCli("WP-S2", options0, await runShots(options0));
