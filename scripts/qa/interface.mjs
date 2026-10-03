/* node scripts/qa/interface.mjs [--lang zh|en --theme dark|light --width 1440|420 --out <dir>]   (build first: node scripts/build.mjs)
   设置 › 界面: interface size (up to 200%), typeface and animation. Each choice reaches the app root (data-ui-scale / data-ui-font / data-motion), really
   changes the rendering (computed zoom, font family, the page-switch wait), is remembered after a reload and never causes horizontal overflow, in the
   window sizes the other journeys use. Seeded temporary library, fake model, no network. */
/* global document, localStorage, getComputedStyle, requestAnimationFrame */
import { seedLibrary } from "./perf-seed.mjs";
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from "./harness.mjs";

export async function runInterfaceQa(options) {
  return runQa({
    name: "interface", options,
    seed: (root) => seedLibrary(root, { sources: 30, decks: 4, cardsPerDeck: 10, runs: 4, attempts: 100, courses: 3, largeSources: 1, largeSourceChars: 6000 }),
    async run({ page, t, step, check }) {
      const root = (attribute) => page.locator(".study-app").first().getAttribute(attribute);
      const choose = (label) => page.getByRole("button", { name: label, exact: true }).first();
      const open = async () => {
        await page.getByRole("button", { name: t("设置", "Settings"), exact: true }).first().click();
        // Settings is a list of categories and one pane: the interface preferences are the 界面 category.
        await page.waitForSelector(".settings-nav", { timeout: 15000 });
        if (!(await page.locator(".appearance-settings").first().isVisible().catch(() => false))) await page.locator('[data-category="appearance"]').click();
        await page.locator(".appearance-settings").waitFor({ state: "visible", timeout: 15000 });
      };
      await step("settings-interface-section", async () => {
        await open();
        for (const label of ["90%", "100%", "125%", "150%", "175%", "200%", t("系统默认", "System default"), t("无动画", "Off")]) await choose(label).waitFor({ timeout: 5000 });
        return { scale: await root("data-ui-scale"), font: await root("data-ui-font"), motion: await root("data-motion") };
      });
      await step("size-150", async () => {
        await choose("150%").click(); await sleep(400);
        if ((await root("data-ui-scale")) !== "150") throw new Error("the size did not reach the app root");
        const zoom = await page.locator(".study-app").first().evaluate(element => getComputedStyle(element).zoom);
        if (Number(zoom) !== 1.5) throw new Error(`computed zoom ${zoom}`);
        const probe = await page.evaluate(overflowProbe);
        if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`horizontal overflow at 150%: ${JSON.stringify(probe)}`);
        return { zoom };
      });
      await step("size-200", async () => {
        await choose("200%").click(); await sleep(400);
        const probe = await page.evaluate(overflowProbe);
        if (probe.scrollWidth > probe.clientWidth + 1) throw new Error(`horizontal overflow at 200%: ${JSON.stringify(probe)}`);
        const bigger = await page.locator(".appearance-settings legend").first().evaluate(element => element.getBoundingClientRect().height);
        return { legendHeight: bigger };
      });
      await step("typeface-serif", async () => {
        await choose(t("衬线", "Serif")).click(); await sleep(300);
        const family = await page.locator(".appearance-settings legend").first().evaluate(element => getComputedStyle(element).fontFamily);
        if (!/serif|Songti|SimSun|Noto Serif/i.test(family)) throw new Error(`the typeface did not change: ${family}`);
        return family;
      });
      await check("remembered-after-reload", async () => {
        const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("study-interface")));
        if (stored.scale !== 200 || stored.font !== "serif") throw new Error(`stored ${JSON.stringify(stored)}`);
        await page.reload(); await sleep(1200);
        if ((await root("data-ui-scale")) !== "200" || (await root("data-ui-font")) !== "serif") throw new Error("not restored after a reload");
        return stored;
      });
      await step("reset-to-defaults", async () => {
        await open();
        await choose("100%").click(); await choose(t("系统默认", "System default")).click(); await sleep(300);
        if ((await root("data-ui-scale")) !== "100" || (await root("data-ui-font")) !== "system") throw new Error("defaults did not come back");
      });
      await step("animation-off", async () => {
        await choose(t("无动画", "Off")).click(); await sleep(300);
        if ((await root("data-motion")) !== "off") throw new Error("motion did not reach the root");
        // With no animation the page switch does not wait for the leave animation.
        const waited = await page.evaluate(async () => {
          const target = document.querySelector('[data-nav-id="library"]');
          const started = performance.now(); target.click();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return performance.now() - started;
        });
        if (waited > 90) throw new Error(`a page switch waited ${Math.round(waited)} ms with animation off`);
        return Math.round(waited);
      });
      await check("reduced-and-auto", async () => {
        await open(); await choose(t("减弱", "Reduced")).click(); await sleep(200);
        if ((await root("data-motion")) !== "reduced") throw new Error("reduced did not reach the root");
        await choose(t("跟随系统", "System")).first().click(); await sleep(200);
        if (!["full", "reduced"].includes(await root("data-motion"))) throw new Error("auto resolves to full or reduced");
      });
    },
  });
}

if (process.argv[1]?.endsWith("interface.mjs")) {
  const options = parseQaArgs(process.argv.slice(2), "interface");
  finishCli("Interface settings", options, await runInterfaceQa(options));
}
