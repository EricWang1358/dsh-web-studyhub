/* global document, window, localStorage, getComputedStyle */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { buildPreview } from "../scripts/build.mjs";
import { createPreviewServer } from "../scripts/preview-server.mjs";
import { createFakeModel } from "../scripts/fake-model.mjs";
import { launchChromium } from "../scripts/qa/browser.mjs";
import { scrubProcessEnv } from "../scripts/qa/env.mjs";
import { openPage, settleAnimations } from "../scripts/qa/layout-late.mjs";

const SHOTS = process.env.CHAPTER_FINISH_SHOTS || "";

const makeCard = (prefix, index, topic) => ({
  id: `${prefix}${index}`,
  kind: "quiz",
  topic,
  objective: `Understand ${topic} (${index})`,
  prompt: `${prefix.toUpperCase()} question ${index}: which statement holds?`,
  answer: "Option A holds",
  hint: "Check the core definition.",
  explanation: "Option A matches the definition.",
  misconception: "Option B confuses the rule.",
  citations: [],
  options: [
    { id: "a", text: "Option A holds", correct: true, explanation: "Correct." },
    { id: "b", text: "Option B fails", correct: false, explanation: "Incorrect." },
  ],
});

async function seedLibrary(root, { lang, chapters = 5, finishWithWeak = true }) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call("snapshot");
  const tomorrow = new Date(Date.now() + 86400_000).toISOString();
  const now = new Date().toISOString();
  const titles = lang === "en"
    ? ["01 Overview", "02 Migration", "03 Containers", "04 Mesh", "05 Observability"]
    : ["01 概览", "02 迁移", "03 容器", "04 网格", "05 观测"];

  await service.store.update((s) => {
    const course = lang === "en" ? "Cloud Native" : "云原生架构";
    // Chapter 1: 2 learned (mastered, tomorrow) + 2 new = 4 cards total
    s.decks.push({
      id: "ch1",
      title: titles[0],
      course,
      cards: [1, 2, 3, 4].map((n) => ({
        ...makeCard("a", n, "Overview"),
        ...(n <= 2 ? { review: { repetitions: 2, interval_days: 6, ease_factor: 2.5, due_at: tomorrow } } : {}),
      })),
    });
    for (let n = 1; n <= 2; n++) {
      s.attempts.push({ deckId: "ch1", quiz_id: `a${n}`, grade: 5, timestamp: now, at: now });
    }

    // Chapter 2: 12 new cards (so batch of 10 takes 2 from ch1 + 8 from ch2 -> ch2 becomes "started")
    s.decks.push({
      id: "ch2",
      title: titles[1],
      course,
      cards: Array.from({ length: 12 }, (_, i) => makeCard("b", i + 1, "Migration")),
    });

    for (let idx = 2; idx < chapters; idx++) {
      const title = titles[idx] || (lang === "en" ? `${String(idx + 1).padStart(2, "0")} Topic ${idx + 1}` : `${String(idx + 1).padStart(2, "0")} 章节`);
      s.decks.push({
        id: `ch${idx + 1}`,
        title,
        course,
        cards: Array.from({ length: 4 }, (_, i) => makeCard(`c${idx}`, i + 1, title)),
      });
    }
    s.focus = { mode: "class", course, role: "", jd: "", targetTopics: [] };
  });
  service.dispose?.();
  return { finishWithWeak };
}

async function startServer(distDir, opts) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), "study-chapter-finish-browser-"));
  const root = join(base, "library");
  await seedLibrary(root, opts);
  const server = await createPreviewServer({
    libraryRoot: root,
    home: join(base, "home"),
    port: 0,
    model: createFakeModel({ latencyMs: 20 }),
    distDir,
  });
  return {
    server,
    close: async () => {
      await server.close();
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    },
  };
}

test("summary-course renders newly finished chapter highlight and 3-state segment bar without overflow (zh & en, 1280 & 420 px)", { timeout: 300000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium available: ${String(error.message).split("\n")[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), "study-chapter-finish-dist-"));
  await buildPreview({ outdir: dist });
  const servers = [];
  t.after(async () => {
    await browser.close().catch(() => {});
    for (const s of servers) await s.close().catch(() => {});
    await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  });

  for (const [lang, width, finishWithWeak] of [
    ["zh", 1280, true],
    ["zh", 420, true],
    ["en", 1280, true],
    ["en", 420, false],
  ]) {
    const running = await startServer(dist, { lang, chapters: 5, finishWithWeak });
    servers.push(running);
    const { context, page, errors } = await openPage(browser, running, { lang, theme: "dark", width, height: 900 });
    await page.addInitScript(() => {
      try { localStorage.setItem("study-autopilot", "off"); } catch { /* a page without storage keeps the default */ }
    });
    await page.goto(running.server.url);

    const otherStartsLabel = lang === "en" ? "Other ways to start" : "其他开始方式";
    const otherStarts = page.locator("details.desk-more > summary", { hasText: otherStartsLabel });
    await otherStarts.waitFor({ timeout: 30000 });
    await otherStarts.click();

    const batchBtn = page.locator(".desk-more .desk-also button", {
      hasText: lang === "en" ? /Next course batch/ : /课程下一批/,
    });
    await batchBtn.waitFor({ timeout: 15000 });
    await batchBtn.click();
    await page.locator(".options .option").first().waitFor({ timeout: 30000 });

    // Answer the batch: make the first ch1 card wrong when finishWithWeak=true, rest right
    let madeWrong = false;
    // After 下一题 the answered card stays on screen (its options disabled) until the next card or the result page replaces it.
    // Wait for one of those two before deciding, instead of guessing how long the transition takes.
    const nextStep = page.locator(".result-page .summary-course, .options .option:not([disabled])").first();
    while (true) {
      await nextStep.waitFor({ timeout: 30000 });
      if (await page.locator(".result-page .summary-course").isVisible()) break;
      const option = finishWithWeak && !madeWrong
        ? page.locator(".options .option", { hasText: "Option B fails" })
        : page.locator(".options .option", { hasText: "Option A holds" });
      if (finishWithWeak && !madeWrong) madeWrong = true;
      await option.click();
      await page.locator('[data-usage="review.next"]').waitFor({ timeout: 15000 });
      await page.locator('[data-usage="review.next"]').click();
    }

    await page.locator(".result-page .summary-course__bar").waitFor({ state: "visible", timeout: 15000 });
    await settleAnimations(page);

    const info = await page.evaluate(() => {
      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const container = document.querySelector(".result-page .summary-course");
      const textEl = document.querySelector(".summary-course__text");
      const bar = document.querySelector(".summary-course__bar");
      const segs = [...document.querySelectorAll(".summary-course__seg")];
      return {
        text: textEl?.textContent || "",
        buttonCount: container?.querySelectorAll("button").length ?? 0,
        ariaHidden: bar?.getAttribute("aria-hidden"),
        segClasses: segs.map((el) => [...el.classList]),
        segColors: segs.map((el) => getComputedStyle(el).backgroundColor),
        barRect: box(bar),
        containerRect: box(container),
        viewportWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });

    assert.deepEqual(errors, [], `${lang} ${width}px: zero page/console errors`);
    assert.equal(info.buttonCount, 0, `${lang} ${width}px: no buttons inside .summary-course`);
    assert.equal(info.ariaHidden, "true");
    assert.equal(info.segClasses.length, 5);
    assert.deepEqual(
      info.segClasses.map((cls) => cls.find((c) => c.startsWith("is-"))),
      ["is-done", "is-started", "is-upcoming", "is-upcoming", "is-upcoming"],
    );
    assert.notEqual(info.segColors[0], info.segColors[1], "done and started have distinct colors");
    assert.notEqual(info.segColors[1], info.segColors[2], "started and upcoming have distinct colors");
    assert.ok(info.barRect.height >= 4, "bar has visible thickness");
    assert.ok(info.scrollWidth <= info.viewportWidth, `${lang} ${width}px: no horizontal overflow (${info.scrollWidth} > ${info.viewportWidth})`);
    assert.ok(info.containerRect.right <= info.viewportWidth, `${lang} ${width}px: summary-course stays inside viewport`);

    if (lang === "zh") {
      assert.match(info.text, /「01 概览」做完一遍，1 题还不稳 · 全课 5 章，已过 1 章/);
    } else if (finishWithWeak) {
      assert.match(info.text, /“01 Overview” finished once, 1 question still shaky · 1 of 5 chapters done/);
    } else {
      assert.match(info.text, /“01 Overview” finished once, all answered right · 1 of 5 chapters done/);
    }

    if (SHOTS) {
      await mkdir(SHOTS, { recursive: true });
      await page.locator(".result-page .summary-course").scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
      await page.screenshot({ path: join(SHOTS, `summary-chapter-finish-${lang}-${width}.png`) });
    }
    await context.close();
  }
});
