/* node scripts/qa/wp-b-overlays.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]
   (build first: node -e "import('./scripts/build.mjs').then(m=>m.buildPreview())")
   UI wave 1, WP-B in the browser preview: the board's ⋯ menu, its delete ConfirmDialog (opened from the menu and from the editor), the
   undo toast, a Popover (reader display settings are covered by the reading journeys; here the board filter and a course's rename
   InlineConfirm), and the shortcut sheet. A seeded temporary library, the fake model, no network. */
/* global document -- page.evaluate callbacks run in the browser */
import { join } from "node:path";
import { createStudyRuntime } from "../../lib/runtime/builtins.js";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";
import { chooseMore } from "./reader-more.mjs";

async function seed(root) {
  const runtime = createStudyRuntime(root);
  const md = "# Operating systems\n\nA process is the unit of resource allocation in an operating system.\n";
  await runtime.call("materials.document.import", { filename: "os-notes.md", dataBase64: Buffer.from(md).toString("base64"), courses: ["Platform Engineering"] });
  runtime.dispose();
}

export async function runOverlayQa(options) {
  return runQa({ name: "wp-b-overlays", options, seed, async run({ page, t, step, check }) {
    const dialog = page.locator("dialog[open]");
    // A library with no question yet opens on the first-run page (no sidebar): 以后再说 puts it away (3.6), then the sidebar is there.
    const later = page.locator('.first-run [data-first-run="later"]');
    await later.first().waitFor({ timeout: 15000 }).catch(() => {});
    if (await later.count()) await later.first().click();
    // 待办看板 sits under the sidebar's 更多 until the learner opens it.
    const board = page.locator('[data-usage="nav.board"]').first();
    if (!(await board.isVisible())) await page.locator('[data-tour="nav-more"]').first().click();
    await board.click();
    await page.locator(".board-page").waitFor();
    await sleep(500);
    await step("board-add-first", async () => {
      await page.getByRole("button", { name: t("添加第一张卡片", "Add the first card") }).first().click();
      const title = page.locator(".board-composer textarea").first();
      await title.fill(t("读论文 第 3 章", "Read paper chapter 3"));
      await title.press("Enter");
      await page.locator(".board-card").first().waitFor();
    });
    await step("board-menu", async () => {
      await page.locator(".board-card").first().getByRole("button", { name: /更多操作|More actions/ }).click();
      await page.getByRole("menu").waitFor();
      const open = await page.evaluate(() => ({ focus: document.activeElement?.getAttribute("role"), box: document.querySelector(".sh-menu")?.getBoundingClientRect().toJSON() }));
      if (open.focus !== "menuitem") throw new Error(`focus not in the menu: ${open.focus}`);
      return open.box;
    });
    await step("delete-confirm", async () => {
      await page.getByRole("menuitem", { name: t("删除", "Delete") }).click();
      await dialog.waitFor();
      const focused = await page.evaluate(() => document.activeElement?.textContent);
      if (focused !== t("保留", "Keep")) throw new Error(`focus should start on the cancel button, got ${focused}`);
    });
    await step("delete-undo-toast", async () => {
      await dialog.getByRole("button", { name: t("确认删除", "Confirm deletion") }).click();
      await page.locator("dialog[open]").waitFor({ state: "detached" });
      await page.getByRole("button", { name: t("撤销", "Undo") }).waitFor();
      await page.getByRole("button", { name: t("撤销", "Undo") }).hover();
      await sleep(600);
    });
    await step("undo-restores", async () => {
      await page.getByRole("button", { name: t("撤销", "Undo") }).click();
      await page.locator(".board-card").first().waitFor();
    });
    await step("editor-delete-same-dialog", async () => {
      await page.locator(".board-card").first().getByRole("button", { name: /读论文|Read paper/ }).first().click().catch(() => page.locator(".board-card").first().click());
      await dialog.waitFor();
      await dialog.getByRole("button", { name: t("删除", "Delete") }).click();
      await page.locator("dialog[open]").nth(1).waitFor();
      const titles = await page.locator("dialog[open] .sh-dialog__title").allInnerTexts();
      if (!titles.some((text) => text.includes(t("删除这张卡片？", "Delete this card?")))) throw new Error(`not the shared dialog: ${titles}`);
    });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await check("no horizontal overflow on the board", async () => { const probe = await page.evaluate(overflowProbe); if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(JSON.stringify(probe)); });

    // 显示设置… is an item of the reader's 更多 now and opens a dialog over the reader: focus moves into it, its 关闭 button leaves the
    // reader open and hands focus back to 更多.
    await page.locator('[data-usage="nav.sources"]').first().click();
    await sleep(600);
    await page.getByRole("button", { name: /^(全部展开|Expand all)$/ }).click().catch(() => {});
    await page.locator(".source-doc .source-main").first().click();
    await page.locator(".study-document-viewer").waitFor();
    const more = page.locator(".study-document-viewer .reader-more__button").first();
    const displayDialog = () => page.getByRole("dialog", { name: t("显示设置", "Display settings") });
    await step("reader-display-dialog", async () => {
      await chooseMore(page, t("显示设置", "Display settings"));
      await displayDialog().waitFor();
      const state = await page.evaluate(() => ({ inDialog: !!document.activeElement?.closest(".sh-dialog"), expanded: document.querySelector(".reader-more__button")?.getAttribute("aria-expanded") }));
      if (!state.inDialog) throw new Error("focus did not move into the dialog");
      if (state.expanded === "true") throw new Error("更多 still says its menu is open");
      return state;
    });
    await check("closing the dialog returns focus to 更多 and leaves the reader open", async () => {
      await displayDialog().getByRole("button", { name: t("关闭", "Close") }).click();
      await displayDialog().waitFor({ state: "detached" });
      if (!(await page.locator(".study-document-viewer").count())) throw new Error("the reader closed too");
      if (!(await more.evaluate((element) => element === document.activeElement))) throw new Error("focus did not return to 更多");
    });
    await page.keyboard.press("Escape");
    await sleep(300);

    // Course settings: the rename InlineConfirm.
    await page.locator('[data-usage="nav.settings"]').first().click();
    await sleep(600);
    await step("settings", async () => { await page.locator("main, .page").first().waitFor(); });
    await page.getByRole("button", { name: t("课程", "Courses"), exact: true }).first().click({ timeout: 3000 }).catch(() => {});
    await sleep(400);
    const opened = await page.locator("main").getByRole("button", { name: t("设置", "Settings"), exact: true }).first().click({ timeout: 5000 }).then(() => true, () => false);
    if (opened) {
      await dialog.waitFor();
      await step("rename-inline-confirm", async () => {
        // The name field is inside the dialog's 更多设置 fold.
        if (!(await dialog.locator(".course-settings__rename").first().isVisible())) await dialog.getByText(t("更多设置", "More settings"), { exact: true }).first().click();
        const input = dialog.locator(".course-settings__rename input").first();
        await input.fill(t("平台工程", "Platform Engineering 2"));
        await dialog.getByRole("button", { name: t("改名", "Rename"), exact: true }).click();
        await dialog.locator(".sh-confirm").waitFor();
        const focused = await page.evaluate(() => document.activeElement?.textContent);
        if (focused !== t("取消", "Cancel")) throw new Error(`focus should be on cancel, got ${focused}`);
      });
      await page.keyboard.press("Escape");
      await sleep(200);
      await check("Escape closed only the inline confirmation", async () => { if (!(await dialog.count())) throw new Error("the whole dialog closed"); });
    } else console.log("skip rename-inline-confirm: no course settings entry on this page");
    return join(options.out, "summary.json");
  } });
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("wp-b-overlays.mjs")) {
  const options = parseQaArgs(process.argv.slice(2), "wp-b-overlays");
  finishCli("WP-B overlays", options, await runOverlayQa(options));
}
