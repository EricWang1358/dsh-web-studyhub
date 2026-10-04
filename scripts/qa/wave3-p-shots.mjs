/* node scripts/qa/wave3-p-shots.mjs [--lang zh|en --theme dark|light --width 1280|420 --out <dir>]
   Screenshots for the wave-3 page frame: the home's folded and open 今天先做什么, the Board, the Settings model and course panes (they draw their
   own panels), a deck's 维护 page (Panels), a draft, and a sample of every Panel tone beside a PageHeader with a scope. Fake library and model. */
/* global document, window, localStorage -- page.evaluate callbacks run in the browser */
import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { previewCall } from "../preview-server.mjs";
import { seedLibrary } from "./perf-seed.mjs";
import { parseQaArgs, runQa, finishCli, repoRoot } from "./harness.mjs";

const options = parseQaArgs(process.argv.slice(2), "wave3-p-shots", {});

const summary = await runQa({ name: "wave3-p-shots", options,
  seed: (root) => seedLibrary(root, { sources: 8, decks: 3, cardsPerDeck: 8, runs: 0, attempts: 40, courses: 2, largeSources: 0 }),
  async run({ page, browser, server, t, step, sleep }) {
    const call = (action, args) => previewCall(server, action, args);
    const date = new Date().toISOString().slice(0, 10);
    const nav = async (usage) => { await page.locator(`[data-usage="nav.${usage}"]`).click(); await sleep(700); };
    await step("home-plan-folded", async () => { await nav("library"); });
    await step("home-plan-open", async () => { await page.getByRole("button", { name: t("展开 今天先做什么", "Expand What to study next") }).click(); await sleep(400); });
    const suggested = await call("daily.plan.suggest", { date, minutes: 45 }).catch(() => null);
    if (suggested?.proposal) await call("daily.plan.accept", { date, proposalId: suggested.proposal.id });
    await step("home-plan-accepted-open", async () => { await page.reload(); await page.waitForSelector("button.nav"); await sleep(900); await nav("library"); });
    await step("home-plan-adjust-menu", async () => { await page.getByRole("button", { name: t("调整", "Adjust"), exact: true }).click(); await sleep(300); });
    await page.keyboard.press("Escape");
    await step("board-plan", async () => { await nav("board"); });
    await step("settings-model-pane", async () => {
      await nav("settings");
      await page.locator('[data-category="model"]').click(); await sleep(500);
    });
    await step("settings-courses-pane", async () => { await page.locator('[data-category="courses"]').click(); await sleep(500); });
    await step("manage-deck", async () => {
      await nav("library"); await sleep(500);
      const more = page.getByRole("button", { name: t("更多操作", "More actions"), exact: true }).first();
      await more.scrollIntoViewIfNeeded(); await more.click();
      await page.getByRole("menuitem", { name: t("管理题组", "Manage deck") }).click();
      await page.locator(".manage-page").waitFor({ timeout: 10000 }); await page.evaluate(() => { for (const node of document.querySelectorAll("main, .page")) node.scrollTop = 0; window.scrollTo(0, 0); }); await sleep(400);
    });
    await step("dashboard-scope-header", async () => { await nav("dashboard"); });

    // The Panel tones and the PageHeader slots, drawn by the real components.
    const out = join(options.out, "tones"); await mkdir(out, { recursive: true });
    await build({ absWorkingDir: repoRoot, bundle: true, write: true, outfile: join(out, "tones.js"), format: "iife", platform: "browser", loader: { ".css": "text" }, jsx: "transform", logLevel: "silent",
      define: { "process.env.NODE_ENV": '"development"' }, stdin: { resolveDir: repoRoot, loader: "jsx", contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { PageHeader, Panel, Button } from './ui/components/index.js';
        import PageScope from './ui/PageScope.jsx';
        import { setUiLanguage } from './ui/i18n.js';
        import baseCss from './ui/style.css';
        const base = document.createElement('style'); base.textContent = baseCss; document.head.appendChild(base);
        const zh = ${JSON.stringify(options.lang === "zh")};
        setUiLanguage(zh ? 'zh' : 'en');
        const t = (a, b) => (zh ? a : b);
        const tones = ['plain', 'sunken', 'accent', 'dashed', 'paper'];
        createRoot(document.getElementById('root')).render(<div className="study-app" style={{ padding: 24, display: 'grid', gap: 16, maxWidth: 760 }}>
          <PageHeader eyebrow={t('示例页', 'Sample page')} title={t('页面标题', 'Page title')} description={t('一句话说明这一页做什么。', 'One line saying what this page is for.')}
            scope={<PageScope courses={[{ name: 'CS3219' }, { name: 'CS3219 / Week 1' }]} value="*" onChange={() => {}} />}
            actions={<><Button variant="quiet">{t('次要', 'Secondary')}</Button><Button variant="primary">{t('主要动作', 'Primary')}</Button></>} />
          {tones.map(tone => <Panel key={tone} tone={tone} title={tone} description={t('面板的色调', 'Panel tone')} actions={<Button size="sm">{t('操作', 'Action')}</Button>}>{t('内容在这里。', 'Content goes here.')}</Panel>)}
          <Panel density="compact" title="compact">{t('紧凑密度', 'Compact density')}</Panel>
          <PageHeader compact title={t('紧凑页头（练习页）', 'Compact header (practice)')} eyebrow={t('学习流 · 第 2/4 步', 'Flow · step 2/4')} />
        </div>);
      ` } });
    await writeFile(join(out, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0"><div id="root"></div><script src="tones.js"></script></body></html>');
    await step("panel-tones", async () => {
      const sample = await browser.newPage({ viewport: { width: options.width, height: 1500 }, colorScheme: options.theme });
      await sample.addInitScript(([theme]) => { try { localStorage.setItem("study-theme", theme); } catch { /* blocked */ } }, [options.theme]);
      await sample.goto(pathToFileURL(join(out, "index.html")).href);
      await sample.waitForSelector(".sh-panel"); await sleep(500);
      await sample.evaluate((theme) => { document.querySelector(".study-app").dataset.theme = theme; }, options.theme);
      await sample.screenshot({ path: join(options.out, "panel-tones.png"), fullPage: true });
      await sample.close();
    });
  } });
finishCli("wave3-p-shots", options, summary);
