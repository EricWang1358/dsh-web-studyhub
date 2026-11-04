/* node scripts/qa/generate-shots.mjs [--out output/generate-shots/after] [--label before|after] [--dist dist]
   创建题组 on a seeded library in the browser preview with the fake model: whole-page screenshots (the shell scrolls inside its viewport, so the viewport is made tall for the shot)
   at 1440 light and 420 dark, 更多选项 closed and open, and the case of a typed number of questions (#664). Prints the height of the page (the form's section) and where the
   generate button ends, so the length of the main path is a number and not an impression. */
/* global document */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StudyService } from "../../lib/service.js";
import { createPreviewServer } from "../preview-server.mjs";
import { createFakeModel } from "../fake-model.mjs";
import { buildPreview } from "../build.mjs";
import { launchChromium } from "./browser.mjs";
import { scrubProcessEnv } from "./env.mjs";
import { frames, openPage, settleAnimations, until } from "./layout-late.mjs";

const arg = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : fallback; };
const out = resolve(arg("out", "output/generate-shots/after")), label = arg("label", "after");
const STAMP = "2026-10-01T08:00:00.000Z";
const body = (n) => `## 第 ${n} 节\n\n${`数据库索引加快查找，事务保证一致性，范式减少冗余。第 ${n} 节的内容。`.repeat(60)}`;
const note = (id, title, courses, n) => ({ id, title, text: body(n), createdAt: STAMP, courses, chars: body(n).length, excerpt: body(n).slice(0, 160) });

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call("snapshot");
  await service.store.update((state) => {
    state.sources.push(note("n1", "索引与查询.md", ["数据库"], 1), note("n2", "事务与并发.md", ["数据库"], 2), note("n3", "范式.md", ["数据库"], 3), note("n4", "路由.md", ["网络"], 4));
    state.focus = { ...(state.focus || {}), course: "数据库", mode: "class" };
  });
  service.dispose?.();
}

async function measure(page, name) {
  const size = page.viewportSize();
  await page.setViewportSize({ width: size.width, height: 3600 });
  await frames(page, 4);
  await settleAnimations(page);
  const numbers = await page.evaluate(() => {
    const section = document.querySelector(".generate-page"), top = section.getBoundingClientRect().top;
    const button = document.querySelector('[data-tour="generate-submit"]');
    return { pageHeight: Math.round(section.getBoundingClientRect().height), buttonBottom: button ? Math.round(button.getBoundingClientRect().bottom - top) : null };
  });
  await page.screenshot({ path: join(out, `${name}.png`) });
  await page.setViewportSize(size);
  await frames(page, 2);
  console.log(JSON.stringify({ shot: name, ...numbers }));
}

const base = await mkdtemp(join(tmpdir(), "study-generate-shots-"));
const dist = arg("dist") ? resolve(arg("dist")) : await mkdtemp(join(tmpdir(), "study-generate-shots-dist-"));
if (!arg("dist")) await buildPreview({ outdir: dist });
scrubProcessEnv();
await mkdir(out, { recursive: true });
const root = join(base, "library");
await seed(root);
const server = await createPreviewServer({ libraryRoot: root, home: join(base, "home"), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
const browser = await launchChromium();
try {
  for (const [width, theme] of [[1440, "light"], [420, "dark"]]) {
    const { page, context } = await openPage(browser, { server }, { lang: "zh", theme, width, height: 900 });
    await page.goto(server.url);
    await page.locator("aside, nav").first().waitFor({ timeout: 30000 });
    await page.locator('[data-tour="nav-generate"]').first().dispatchEvent("click");
    await page.locator(".generate-page form").waitFor({ timeout: 30000 });
    await settleAnimations(page);
    await until(async () => (await page.locator("[data-generate-estimate] [data-token-estimate][data-status=\"ready\"]").count()) > 0, "the estimate", { timeoutMs: 60000 });
    const tag = `${width}-${theme}`;
    await measure(page, `closed-${tag}`);
    await page.locator(".generate-more > summary").click();
    await page.locator("#generate-focus").waitFor({ state: "visible", timeout: 10000 });
    await measure(page, `open-${tag}`);
    // a typed number of questions: before, under 自定义题数 in the fold; after, the fourth choice of 覆盖强度
    const custom = page.locator(".cov-strength__levels .sh-seg__item", { hasText: "自定义" });
    if (await custom.count()) await custom.click();
    else if (!await page.locator("#generate-count").isVisible()) await page.locator(".cov-strength__custom summary").first().click();
    await page.locator("#generate-count").fill("4");
    await page.locator("#generate-count").blur();
    await until(async () => (await page.locator("[data-generate-estimate] [data-token-estimate][data-status=\"ready\"]").count()) > 0, "the estimate for 4", { timeoutMs: 60000 });
    await measure(page, `custom-count-${tag}`);
    await context.close();
  }
  console.log(JSON.stringify({ label, out }));
} finally { await browser.close(); await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); }
