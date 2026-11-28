/* Browser integration test for in-page unknown-word marking (#1192).
   Registered in tests/slow-tests.json. Pass QUESTION_TERM_MARKS_SHOTS=<dir> to save screenshots. */
/* global document, window, NodeFilter, CSS */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { buildPreview } from "../scripts/build.mjs";
import { createFakeModel } from "../scripts/fake-model.mjs";
import { createPreviewServer, previewCall } from "../scripts/preview-server.mjs";
import { launchChromium } from "../scripts/qa/browser.mjs";
import { scrubProcessEnv } from "../scripts/qa/env.mjs";
import { openPage, settleAnimations, startLateServer } from "../scripts/qa/layout-late.mjs";
import { highlightDrawn } from "./helpers/highlight-drawn.mjs";
import { until } from "./helpers/wait.mjs";
import { confirmStart } from "../scripts/qa/confirm-start.mjs";

const SHOTS = process.env.QUESTION_TERM_MARKS_SHOTS || "";

function cardsFor(lang) {
  if (lang === "en") {
    return [
      {
        id: "c1",
        kind: "flashcard",
        topic: "Distributed Consistency",
        objective: "Understand consistency trade-offs",
        prompt: "Explain how contrapositive reasoning interacts with consistency guarantees.",
        answer:
          "Proofs rely on contrapositive checks while systems balance linearizability, distributed consensus, and idempotency; contrapositive logic keeps every invariant clear.",
        hint: "Think about ordering and retries.",
        explanation: "Linearizability gives a single global order, whereas idempotency makes retries safe.",
        misconception: "Treating consensus and idempotency as identical.",
        citations: [],
      },
      {
        id: "c2",
        kind: "quiz",
        topic: "Concurrency Control",
        objective: "Recall optimistic locking",
        prompt: "Which assumption defines optimistic concurrency control?",
        options: [
          { id: "a", text: "Conflicts remain rare until commit verification", correct: true, explanation: "Versions are checked on commit." },
          { id: "b", text: "Every read acquires a mutex lock first", correct: false, explanation: "That describes pessimistic locking." },
        ],
        hint: "Think about validation time.",
        explanation: "Optimistic control avoids read locks and validates versions at commit.",
        misconception: "Blocking every reader.",
        citations: [],
      },
    ];
  }
  return [
    {
      id: "c1",
      kind: "flashcard",
      topic: "分布式一致性",
      objective: "理解一致性权衡",
      prompt: "请说明分布式系统里常见推理与一致性的权衡。",
      answer:
        "系统常在 线性一致性、充分条件 与 权衡 之间做取舍；其中 线性一致性 决定了并发读写是否表现为单一原子序列。",
      hint: "想一想并发顺序与条件关系。",
      explanation: "线性一致性保证读写呈现全局原子序，充分条件用于推导前提是否足够。",
      misconception: "把线性一致性和最终一致性混为一谈。",
      citations: [],
    },
    {
      id: "c2",
      kind: "quiz",
      topic: "并发控制",
      objective: "识别乐观锁假设",
      prompt: "在并发控制里，下列哪种说法对应乐观锁的核心假设？",
      options: [
        { id: "a", text: "冲突很少发生，只在提交时校验版本号", correct: true, explanation: "乐观锁通过版本对比检查并发冲突。" },
        { id: "b", text: "每次读取都必须先拿到互斥量", correct: false, explanation: "这是悲观锁的做法。" },
      ],
      hint: "想一想什么时候检查冲突。",
      explanation: "乐观锁不在读阶段加锁，而在提交阶段检查版本号是否变化。",
      misconception: "以为乐观锁也会阻塞读操作。",
      citations: [],
    },
  ];
}

async function seedDeck(root, lang) {
  const service = new StudyService(root);
  await service.call("snapshot");
  await service.store.update((state) => {
    state.decks.push({
      id: "d",
      title: lang === "en" ? "Distributed Systems" : "分布式系统",
      course: lang === "en" ? "Systems" : "系统课",
      folder: "",
      publishedAt: "2026-10-01T00:00:00.000Z",
      cards: cardsFor(lang),
    });
  });
}

async function substringSpan(page, rootSelector, substring, occurrence = 0) {
  const span = await page.evaluate(
    ([sel, target, occ]) => {
      const root = document.querySelector(sel);
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node; (node = walker.nextNode()); ) {
        if (node.parentElement?.closest?.('[aria-hidden="true"]')) continue;
        let from = 0;
        while (from <= node.data.length - target.length) {
          const idx = node.data.indexOf(target, from);
          if (idx < 0) break;
          if (seen === occ) {
            node.parentElement?.scrollIntoView?.({ block: "center", inline: "nearest" });
            const startRange = document.createRange();
            startRange.setStart(node, idx);
            startRange.setEnd(node, idx + 1);
            const endRange = document.createRange();
            endRange.setStart(node, idx + target.length - 1);
            endRange.setEnd(node, idx + target.length);
            const fullRange = document.createRange();
            fullRange.setStart(node, idx);
            fullRange.setEnd(node, idx + target.length);
            const sRect = startRange.getClientRects()[0] || startRange.getBoundingClientRect();
            const eRect = endRange.getClientRects()[0] || endRange.getBoundingClientRect();
            const full = fullRange.getBoundingClientRect();
            return {
              x: full.left + full.width / 2,
              y: full.top + full.height / 2,
              startX: sRect.left + 2,
              startY: sRect.top + sRect.height / 2,
              endX: eRect.right - 2,
              endY: eRect.top + eRect.height / 2,
            };
          }
          seen++;
          from = idx + target.length;
        }
      }
      return null;
    },
    [rootSelector, substring, occurrence],
  );
  if (!span) throw new Error(`Missing "${substring}" (occ ${occurrence}) in ${rootSelector}`);
  return span;
}

async function waitForRevealedBack(page, timeout = 15000) {
  await page.locator('.flip-back[aria-hidden="false"]').waitFor({ state: "visible", timeout });
  await page.locator('.flip-back[aria-hidden="false"] .flip-loading').waitFor({ state: "detached", timeout });
}

async function clickWord(page, rootSelector, substring, occurrence = 0) {
  const pt = await substringSpan(page, rootSelector, substring, occurrence);
  await page.mouse.click(pt.x, pt.y);
}

async function dragPhrase(page, rootSelector, phrase, occurrence = 0) {
  const pt = await substringSpan(page, rootSelector, phrase, occurrence);
  await page.mouse.move(pt.startX, pt.startY);
  await page.mouse.down();
  await page.mouse.move(pt.endX, pt.endY, { steps: 6 });
  await page.mouse.up();
}

const chipTexts = (page) =>
  page.locator(".term-strip .sh-chip__label").allTextContents();

const chipStrip = (page) =>
  page.locator(".term-strip:not(.term-strip--mode)");

const modeBar = (page) =>
  page.locator(".term-strip.term-strip--mode[data-term-marking-bar]");

const waitForChipStripGone = (page, timeout = 10000) =>
  page.waitForFunction(() => document.querySelectorAll(".term-strip:not(.term-strip--mode)").length === 0, { timeout });

async function enterMarkingMode(page, termsBtn = page.locator('[data-usage="review.terms"]')) {
  await termsBtn.click();
  await page.locator(".review-body.is-marking").waitFor({ state: "attached", timeout: 10000 });
  await modeBar(page).waitFor({ state: "visible", timeout: 10000 });
}

const highlightCount = (page, name = "study-term-mark") =>
  page.evaluate((hlName) => (typeof CSS !== "undefined" && CSS.highlights ? CSS.highlights.get(hlName)?.size || 0 : -1), name);

const highlightTexts = (page, name) =>
  page.evaluate((hlName) => {
    if (typeof CSS === "undefined" || !CSS.highlights) return null;
    const hl = CSS.highlights.get(hlName);
    return hl ? [...hl].map((range) => range.toString()) : [];
  }, name);

const covers = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/* Grade Card 1 as 4 and wait for Card 2 (a quiz). Grading either advances by itself or leaves 下一题 to press; settle which in one wait,
   so no waiter outlives this step: one left behind pressed 下一题 the moment an answered Card 1 came back on screen (← 上一题) and carried
   the round off to Card 2 again. */
async function gradeCard1AndReachCard2(page) {
  const card2Option = page.locator(".options .option:not([disabled])").first();
  await page.locator(".grade-scale .grade").nth(4).click();
  await card2Option.or(page.locator('[data-usage="review.next"]:not([disabled])')).first().waitFor({ timeout: 15000 });
  if (!(await card2Option.isVisible())) await page.locator('[data-usage="review.next"]:not([disabled])').click();
  await card2Option.waitFor({ timeout: 15000 });
}

async function takeShot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

test("term marking flows cleanly across 1280/420 widths and zh/en languages (#1192)", async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to look with: ${String(error.message).split("\n")[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), "study-term-marks-dist-"));
  await buildPreview({ outdir: dist });
  t.after(async () => {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  for (const lang of ["zh", "en"]) {
    for (const width of [1280, 420]) {
      const tag = `${lang}@${width}`;
      const running = await startLateServer({ distDir: dist, lang, seed: (root) => seedDeck(root, lang) });
      const { context, page, errors } = await openPage(browser, running, { lang, theme: "light", width, height: 900 });
      try {
        await page.goto(running.server.url);
        await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
        await page.locator(".question-toolbar").waitFor({ timeout: 30000 });
        await settleAnimations(page);

        const termsBtn = page.locator('[data-usage="review.terms"]');
        await termsBtn.waitFor({ timeout: 15000 });
        assert.equal(await termsBtn.getAttribute("aria-pressed"), "false", `${tag}: initially not marking`);

        // 1. Not in marking mode: clicking flashcard text flips the card.
        const frontProbe = lang === "en" ? "contrapositive" : "分布式";
        await clickWord(page, '.flip-front[aria-hidden="false"]', frontProbe);
        await waitForRevealedBack(page);
        await settleAnimations(page);
        assert.equal(await page.locator(".term-strip").count(), 0, `${tag}: no chips before marking`);

        // 2. Enter marking mode: click word on back -> chip appears -> click again -> disappears.
        await termsBtn.click();
        assert.equal(await termsBtn.getAttribute("aria-pressed"), "true", `${tag}: button reports aria-pressed=true`);
        assert.equal(await page.locator(".review-body.is-marking").count(), 1, `${tag}: .review-body.is-marking set`);
        assert.equal(await modeBar(page).count(), 1, `${tag}: marking-mode bar appears before any word is marked`);
        assert.equal(await chipStrip(page).count(), 0, `${tag}: no chip strip before any word is marked`);

        const backSel = '.flip-back[aria-hidden="false"] .flash-prompt';
        const toggleWord = lang === "en" ? "contrapositive" : "权衡";
        await clickWord(page, backSel, toggleWord, 0);
        assert.deepEqual(await chipTexts(page), [toggleWord], `${tag}: clicked word appears in chip bar`);
        const expectedHl = lang === "en" ? 2 : 1;
        const hl = await highlightCount(page);
        if (hl >= 0) assert.ok(hl >= expectedHl, `${tag}: highlight spans all occurrences (${hl})`);
        if (hl >= 0) assert.equal(await highlightDrawn(page, "study-term-mark"), true, `${tag}: and it is drawn on the question, not only registered`);

        // Click again (on 2nd occurrence in EN, same word in ZH) -> toggles off (chip strip clears back to marking-mode bar).
        await clickWord(page, backSel, toggleWord, lang === "en" ? 1 : 0);
        assert.equal(await chipStrip(page).count(), 0, `${tag}: clicking marked word cancels it`);
        assert.equal(await modeBar(page).count(), 1, `${tag}: marking-mode bar returns while still in marking mode`);

        // 3. Adjacent merge in ZH (`线性` + `一致性` -> `线性一致性`); in EN add first chip `linearizability`.
        if (lang === "zh") {
          await clickWord(page, backSel, "线性", 0);
          assert.deepEqual(await chipTexts(page), ["线性"]);
          await clickWord(page, backSel, "一致性", 0);
          assert.deepEqual(await chipTexts(page), ["线性一致性"], `${tag}: adjacent segments merged into one term`);
        } else {
          await clickWord(page, backSel, "linearizability", 0);
          assert.deepEqual(await chipTexts(page), ["linearizability"]);
        }

        // 4. Drag selection adds a phrase and clears browser selection.
        const dragTarget = lang === "en" ? "distributed consensus" : "充分条件";
        await dragPhrase(page, backSel, dragTarget, 0);
        const leftoverSelection = await page.evaluate(() => window.getSelection()?.toString() || "");
        assert.equal(leftoverSelection, "", `${tag}: selection cleared after drag`);
        assert.ok((await chipTexts(page)).includes(dragTarget), `${tag}: dragged phrase added`);

        // Mark a 3rd term so we have 3 chips on flashcard back for layout check & screenshot.
        const thirdWord = lang === "en" ? "idempotency" : "权衡";
        await clickWord(page, backSel, thirdWord, 0);
        assert.equal((await chipTexts(page)).length, 3, `${tag}: 3 marked words displayed`);

        // 8. At 420px verify TermChips never covers toolbar or grading buttons and stays within viewport.
        if (width === 420) {
          const layout = await page.evaluate(() => {
            const rect = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
            return {
              chips: rect(document.querySelector(".term-strip")),
              stickyBar: rect(document.querySelector(".review-sticky-bar")),
              grading: rect(document.querySelector(".grading")),
              fill: rect(document.querySelector(".term-strip__fill")),
              scrollWidth: document.documentElement.scrollWidth,
              clientWidth: document.documentElement.clientWidth,
            };
          });
          assert.ok(layout.chips && layout.stickyBar && layout.grading && layout.fill, `${tag}: layout nodes exist`);
          assert.ok(!covers(layout.chips, layout.stickyBar), `${tag}: chips do not overlap toolbar`);
          assert.ok(!covers(layout.chips, layout.grading), `${tag}: chips do not overlap grading buttons`);
          assert.ok(layout.fill.right <= 420 && layout.fill.left >= 0, `${tag}: explain button stays within 420px`);
          assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `${tag}: no horizontal overflow (${layout.scrollWidth}/${layout.clientWidth})`);
        }

        await settleAnimations(page);
        await page.locator(".term-strip").scrollIntoViewIfNeeded();
        await takeShot(page, `term-marks-${lang}-${width}`);

        // 5. Space still flips flashcard while marking; Escape exits marking while keeping chips.
        // The pointer stayed over the old card as the strip scrolled into view. A hover
        // tooltip owns Escape while open, so leave it before exercising the card shortcuts.
        await page.mouse.move(-1, -1);
        await page.locator('[role="tooltip"]:visible').first().waitFor({ state: "hidden", timeout: 10000 });
        await page.keyboard.press("Space");
        await page.locator('.flip-front[aria-hidden="false"]').waitFor({ timeout: 10000 });
        assert.equal(await termsBtn.getAttribute("aria-pressed"), "true", `${tag}: Space keeps marking mode active`);
        await page.keyboard.press("Space");
        await page.locator('.flip-back[aria-hidden="false"]').waitFor({ timeout: 10000 });

        await page.keyboard.press("Escape");
        await termsBtn.and(page.locator('[aria-pressed="false"]')).waitFor({ timeout: 10000 });
        assert.equal(await page.locator(".review-body.is-marking").count(), 0);
        assert.equal((await chipTexts(page)).length, 3, `${tag}: chips remain visible after Escape`);

        // 7. Clicking "补齐这 N 个词" triggers assist ("terms") and shows ladder + prerequisite check cards under question.
        const fillBtn = page.locator(".term-strip__fill");
        assert.match(
          await fillBtn.innerText(),
          lang === "en" ? /Fill in these 3 words/ : /补齐这 3 个词/,
          `${tag}: button reads 补齐这 3 个词 / Fill in these 3 words`,
        );
        await fillBtn.click();
        await page.waitForFunction(
          (pattern) => {
            const openItem = document.querySelector(".explanation-followup .followup-item[open]");
            const prereqStrip = document.querySelector(".prereq-strip");
            return !!openItem && !!prereqStrip && new RegExp(pattern, "i").test(openItem.textContent || "");
          },
          lang === "en" ? "Preview formal definition" : "预览正式说法",
          { timeout: 25000 },
        );
        const firstFollowup = page.locator(".explanation-followup .followup-item[open]").first();
        await firstFollowup.locator(".md").waitFor({ state: "visible", timeout: 10000 });
        const followupText = await firstFollowup.innerText();
        if (lang === "en") {
          assert.match(followupText, /Fill terms:/i, `${tag}: English terms title shown`);
          assert.match(followupText, /Preview formal definition/i, `${tag}: ladder sections appeared`);
        } else {
          assert.match(followupText, /补词：/, `${tag}: Chinese terms title shown`);
          assert.match(followupText, /预览正式说法/, `${tag}: ladder sections appeared`);
        }
        const prerequisites = page.locator(".prereq-strip__toggle");
        await prerequisites.click();
        assert.equal(await prerequisites.getAttribute("aria-expanded"), "true");
        assert.equal(
          await page.locator(".prereq-strip .prereq-item").count(),
          3,
          `${tag}: 3 layer-1 prerequisite check cards linked directly`,
        );
        if (width === 420) {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
          assert.ok(overflow, `${tag}: no horizontal overflow after ladder`);
        }
        await settleAnimations(page);
        await page.locator(".prereq-strip").scrollIntoViewIfNeeded();
        await takeShot(page, `terms-ladder-${lang}-${width}`);
        await firstFollowup.scrollIntoViewIfNeeded();
        await settleAnimations(page);
        await takeShot(page, `terms-followup-${lang}-${width}`);
        await prerequisites.click();
        assert.equal(await prerequisites.getAttribute("aria-expanded"), "false");
        await page.waitForFunction(() => document.querySelectorAll(".term-strip").length === 0, { timeout: 10000 });

        // Mark 1 unfilled word on Card 1 so returning from Card 2 verifies per-question term memory (#1192, #1214).
        await enterMarkingMode(page, termsBtn);
        const memoryWord = lang === "en" ? "contrapositive" : "原子";
        if (lang === "zh") await dragPhrase(page, backSel, memoryWord, 0);
        else await clickWord(page, backSel, memoryWord, 0);
        assert.deepEqual(await chipTexts(page), [memoryWord], `${tag}: unfilled memoryWord staged on Card 1`);

        // Advance to Card 2 (quiz) to verify option click interception + per-question term memory.
        await gradeCard1AndReachCard2(page);
        assert.equal(await termsBtn.getAttribute("aria-pressed"), "false", `${tag}: question switch resets marking`);
        assert.equal(await page.locator(".term-strip").count(), 0, `${tag}: Card 2 starts with no chips`);

        // Enter marking mode via W shortcut.
        await page.locator(".question-card .question").click();
        await page.keyboard.press("w");
        assert.equal(await termsBtn.getAttribute("aria-pressed"), "true", `${tag}: W activates marking`);

        // 6. Clicking an option word marks it without submitting/selecting an option answer.
        const optionWord = lang === "en" ? "verification" : "版本";
        await clickWord(page, ".options", optionWord, 0);
        assert.deepEqual(await chipTexts(page), [optionWord], `${tag}: option word marked`);
        assert.equal(await page.locator(".options .option.correct, .options .option.incorrect, .options .option--selected, .next-due").count(), 0,
          `${tag}: option click in marking mode does not answer`);

        // Mark a 2nd word on Card 2 (unanswered quiz) and run 补齐这 2 个词 -> ladder + 2 prerequisite cards.
        const secondOptionWord = lang === "en" ? "mutex" : "互斥";
        await clickWord(page, ".options", secondOptionWord, 0);
        assert.deepEqual(await chipTexts(page), [optionWord, secondOptionWord], `${tag}: 2 words marked on quiz`);
        await page.keyboard.press("Escape");
        await page.locator(".term-strip__fill").click();
        await page.waitForFunction(
          () => !!document.querySelector(".explanation-followup .followup-item[open]") && !!document.querySelector(".prereq-strip"),
          { timeout: 25000 },
        );
        await prerequisites.click();
        assert.equal(
          await page.locator(".prereq-strip .prereq-item").count(),
          2,
          `${tag}: 2 marked words created 2 direct prerequisite check cards on Card 2`,
        );
        await page.waitForFunction(() => document.querySelectorAll(".term-strip").length === 0, { timeout: 10000 });

        // Moving back to Card 1 (flashcard) restores Card 1's unmarked term from memory.
        await page.locator('[data-usage="review.prev"]').click();
        await page.locator(".flashcard").waitFor({ timeout: 10000 });
        await page.locator(".term-strip").waitFor({ timeout: 10000 });
        assert.deepEqual(await chipTexts(page), [memoryWord], `${tag}: returning to Card 1 restores its marked words`);

        assert.deepEqual(errors, [], `${tag}: unexpected console/page errors: ${errors.join(" | ")}`);
      } finally {
        await context.close();
        await running.close();
      }
    }
  }
});

async function seedCourseTermsDeck(root, lang) {
  const service = new StudyService(root);
  await service.call("snapshot");
  const courseName = lang === "en" ? "Systems" : "系统课";
  await service.store.update((state) => {
    state.decks.push(
      {
        id: "d",
        title: lang === "en" ? "Distributed Systems" : "分布式系统",
        course: courseName,
        folder: "",
        publishedAt: "2026-10-01T00:00:00.000Z",
        cards: [
          {
            id: "c1",
            kind: "flashcard",
            topic: lang === "en" ? "Consistency" : "一致性",
            objective: lang === "en" ? "Recall key concept" : "理解核心概念",
            prompt: lang === "en"
              ? "What trade-off shapes replication guarantees?"
              : "分布式副本同步时最核心的权衡是什么？",
            answer: lang === "en"
              ? "Systems compare linearizability against weaker consistency models under partitions."
              : "系统常在 线性一致性 与弱一致性之间权衡并发读写顺序。",
            hint: lang === "en" ? "Focus on global ordering." : "关注全局原子顺序。",
            explanation: lang === "en"
              ? "Linearizability provides a single atomic order across replicas."
              : "线性一致性让所有节点对操作顺序达成单一原子视图。",
            misconception: lang === "en" ? "Assuming eventual implies linearizable." : "混淆强一致与最终一致。",
            citations: [],
          },
          {
            id: "c2",
            kind: "quiz",
            topic: lang === "en" ? "Linearizable Reads" : "线性读",
            objective: lang === "en" ? "Identify linearizability property" : "识别线性一致性性质",
            prompt: lang === "en"
              ? "Which guarantee does linearizability require across concurrent operations?"
              : "关于 线性一致性 对并发读写的要求，下列哪项准确？",
            options: [
              {
                id: "a",
                text: lang === "en" ? "Real-time atomic order across operations" : "所有并发读写存在满足实时顺序的全局原子序",
                correct: true,
                explanation: lang === "en" ? "Real-time ordering defines linearizability." : "实时全局原子序是线性一致性的定义。",
              },
              {
                id: "b",
                text: lang === "en" ? "Eventual convergence without ordering" : "只要求最终收敛，不约束先后顺序",
                correct: false,
                explanation: lang === "en" ? "That is eventual consistency." : "那是最终一致性的要求。",
              },
            ],
            hint: lang === "en" ? "Think about real-time ordering." : "思考实时顺序约束。",
            explanation: lang === "en" ? "Reads never observe stale values after completion." : "操作一旦完成，后续读取就能看到最新结果。",
            misconception: lang === "en" ? "Ignoring real-time bounds." : "忽略实时先后约束。",
            citations: [],
          },
        ],
      },
      {
        id: "d-checks",
        title: lang === "en" ? "Term Checks" : "生词检查",
        course: courseName,
        folder: "",
        publishedAt: "2026-10-01T00:00:00.000Z",
        cards: [
          {
            id: "c-chk-learned",
            kind: "flashcard",
            topic: "Checks",
            objective: "Check 1",
            prompt: lang === "en" ? "Explain idempotency formally." : "用正式的说法讲一遍什么是 幂等性？",
            answer: lang === "en" ? "Repeating an operation produces the same state." : "多次重复执行产生相同结果。",
            hint: "Retry",
            explanation: "Retry-safe.",
            misconception: "Same as commutativity.",
            citations: [],
            review: { repetitions: 1, interval_days: 1, ease: 2.5, due_at: "2027-06-01T00:00:00.000Z" },
          },
          {
            id: "c-chk-known",
            kind: "flashcard",
            topic: "Checks",
            objective: "Check 2",
            prompt: lang === "en" ? "Define eventual consistency." : "用正式的说法讲一遍什么是 最终一致性？",
            answer: lang === "en" ? "Replicas converge when updates stop." : "停止写入后各副本最终收敛到同一状态。",
            hint: "Convergence",
            explanation: "Asynchronous replication.",
            misconception: "Strong ordering.",
            citations: [],
            review: { repetitions: 2, interval_days: 10, ease: 2.5, due_at: "2027-06-01T00:00:00.000Z" },
          },
        ],
      },
    );
    state.attempts.push(
      { id: "att-1", deckId: "d-checks", quiz_id: "c-chk-learned", grade: 3, at: "2026-11-18T10:00:00.000Z" },
      { id: "att-2", deckId: "d-checks", quiz_id: "c-chk-known", grade: 4, at: "2026-11-18T10:01:00.000Z" },
    );
  });
  await service.call("course.save", {
    name: courseName,
    terms: {
      version: 1,
      items: [
        {
          term: lang === "en" ? "idempotency" : "幂等性",
          alt: lang === "en" ? "retry safety" : "idempotency",
          at: "2026-11-18T09:00:00.000Z",
          from: { deckId: "d", cardId: "c1" },
          card: { deckId: "d-checks", cardId: "c-chk-learned" },
        },
        {
          term: lang === "en" ? "eventual consistency" : "最终一致性",
          at: "2026-11-18T08:00:00.000Z",
          from: { deckId: "d", cardId: "c2" },
          card: { deckId: "d-checks", cardId: "c-chk-known" },
        },
      ],
    },
  });
}

test("course term persistence, pale study-term-seen highlight, click-to-stage, and TermListDialog (#1203)", async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to look with: ${String(error.message).split("\n")[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), "study-course-terms-dist-"));
  await buildPreview({ outdir: dist });
  t.after(async () => {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  for (const lang of ["zh", "en"]) {
    for (const width of [1280, 420]) {
      const tag = `course-terms-${lang}@${width}`;
      const running = await startLateServer({ distDir: dist, lang, seed: (root) => seedCourseTermsDeck(root, lang) });
      const { context, page, errors } = await openPage(browser, running, { lang, theme: "light", width, height: 900 });
      try {
        let termsGetCalls = 0;
        let lastMarkPromise = Promise.resolve();
        page.on("request", (req) => {
          if (!req.url().endsWith("/api/call")) return;
          const body = req.postData() || "";
          if (body.includes('"course.terms.get"')) termsGetCalls += 1;
          if (body.includes('"course.terms.mark"')) {
            lastMarkPromise = page.waitForResponse(
              (res) => res.url().endsWith("/api/call") && res.request() === req,
              { timeout: 10000 },
            ).catch(() => null);
          }
        });

        await page.goto(running.server.url);
        await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
        await page.locator(".question-toolbar").waitFor({ timeout: 30000 });
        await settleAnimations(page);
        await page.waitForFunction(() => true);
        assert.equal(termsGetCalls, 1, `${tag}: fetched course.terms.get once on round entry`);

        // 1. Mark unfamiliar term on Card 1 -> persists non-blockingly to course.terms.
        const frontProbe = lang === "en" ? "replication" : "副本";
        await clickWord(page, '.flip-front[aria-hidden="false"]', frontProbe);
        await waitForRevealedBack(page);
        await settleAnimations(page);

        const termsBtn = page.locator('[data-usage="review.terms"]');
        await enterMarkingMode(page, termsBtn);
        const targetWord = lang === "en" ? "linearizability" : "线性一致性";
        if (lang === "zh") {
          await dragPhrase(page, '.flip-back[aria-hidden="false"] .flash-prompt', targetWord, 0);
        } else {
          await clickWord(page, '.flip-back[aria-hidden="false"] .flash-prompt', targetWord, 0);
        }
        assert.deepEqual(await chipTexts(page), [targetWord], `${tag}: marked on Card 1`);
        await lastMarkPromise;

        const courseName = lang === "en" ? "Systems" : "系统课";
        const persisted = await previewCall(running.server, "course.terms.get", { course: courseName });
        assert.ok(
          persisted.items?.some((item) => item.term === targetWord && item.state === "unknown"),
          `${tag}: marked word persisted as unknown on course`,
        );

        // 2. Move to Card 2 containing same term: pale study-term-seen highlight shows, term strip stays closed, no extra RPC fetch!
        await gradeCard1AndReachCard2(page);
        await settleAnimations(page);

        assert.equal(termsGetCalls, 1, `${tag}: round cache prevents refetching course.terms.get on Card 2`);
        assert.equal(await page.locator(".term-strip").count(), 0, `${tag}: term strip does not auto-open for seen terms`);
        const seenHl = await highlightCount(page, "study-term-seen");
        const activeHlBefore = await highlightCount(page, "study-term-mark");
        if (seenHl >= 0) {
          assert.ok(seenHl >= 1, `${tag}: pale study-term-seen highlight paints seen unknown word on Card 2 (${seenHl})`);
          assert.equal(await highlightDrawn(page, "study-term-seen"), true, `${tag}: and it is drawn on the question, not only registered`);
          assert.equal(activeHlBefore, 0, `${tag}: active study-term-mark is empty before clicking`);
        }
        await takeShot(page, `term-seen-${lang}-${width}`);

        // 3. Enter marking mode on Card 2 and click the pale-highlighted word -> enters term strip!
        await enterMarkingMode(page, termsBtn);
        await clickWord(page, ".question-card .question", targetWord, 0);
        assert.deepEqual(await chipTexts(page), [targetWord], `${tag}: clicking seen word adds it to active term strip`);
        const activeHlAfter = await highlightCount(page, "study-term-mark");
        if (activeHlAfter >= 0) assert.ok(activeHlAfter >= 1, `${tag}: active study-term-mark highlights clicked seen word`);

        // 4. Open TermListDialog via quiet "生词表" / "Word list" button at end of term strip.
        const listBtn = page.locator(".term-strip__list-btn");
        await listBtn.waitFor({ state: "visible", timeout: 10000 });
        await listBtn.click();
        const dlg = page.locator("dialog[open]").last();
        await dlg.waitFor({ state: "visible", timeout: 10000 });
        await dlg.locator(".term-list-group").first().waitFor({ state: "visible", timeout: 10000 });
        await settleAnimations(page);

        const groupTitles = await dlg.locator(".term-list-group__title").allInnerTexts();
        assert.equal(groupTitles.length, 3, `${tag}: all 3 term groups (unknown/learned/known) displayed`);
        const dlgText = await dlg.innerText();
        assert.match(dlgText, lang === "en" ? /Unknown/ : /不认识/);
        assert.match(dlgText, lang === "en" ? /Studied/ : /学过/);
        assert.match(dlgText, lang === "en" ? /Known/ : /会了/);
        assert.match(dlgText, lang === "en" ? /From:/ : /出自：/);
        if (width === 420) {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
          assert.ok(overflow, `${tag}: no horizontal overflow with TermListDialog open at 420px`);
        }
        await takeShot(page, `term-list-dialog-${lang}-${width}`);

        // 5. Remove a single term inside dialog, then clear all via ⋯ menu + confirmation dialog.
        const removeLabel = lang === "en" ? /Remove “idempotency”/ : /从生词表移除「幂等性」/;
        await dlg.getByRole("button", { name: removeLabel }).click();
        await page.waitForFunction(
          (term) => !document.querySelector("dialog[open]")?.textContent?.includes(term),
          lang === "en" ? "idempotency" : "幂等性",
          { timeout: 10000 },
        );

        await dlg.locator(".term-list-head [aria-haspopup='menu']").click();
        const clearMenuItem = dlg.getByRole("menuitem", { name: lang === "en" ? /Clear word list/ : /清空生词表/ });
        await clearMenuItem.waitFor({ state: "visible", timeout: 10000 });
        await clearMenuItem.click();

        const confirmDlg = page.locator("dialog[open]").last();
        await confirmDlg.locator(".sh-btn--danger").waitFor({ state: "visible", timeout: 10000 });
        await confirmDlg.locator(".sh-btn--danger").click();

        await dlg.locator(".sh-empty").waitFor({ state: "visible", timeout: 10000 });
        const afterClear = await previewCall(running.server, "course.terms.get", { course: courseName });
        assert.deepEqual(afterClear.items, [], `${tag}: confirmed clear empties course.terms on server`);
        await page.keyboard.press("Escape");

        assert.deepEqual(errors, [], `${tag}: unexpected console/page errors: ${errors.join(" | ")}`);
      } finally {
        await context.close();
        await running.close();
      }
    }
  }
});

async function seedCandidateTermsDeck(root, lang) {
  const service = new StudyService(root);
  await service.call("snapshot");
  const courseName = lang === "en" ? "Systems" : "系统课";
  await service.store.update((state) => {
    state.decks.push({
      id: "d-cand",
      title: lang === "en" ? "Concurrency & Consensus" : "并发与一致性",
      course: courseName,
      folder: "",
      publishedAt: "2026-10-01T00:00:00.000Z",
      cards: lang === "en"
        ? [
            {
              id: "cand-q1",
              kind: "quiz",
              topic: "Concurrency Control",
              objective: "Recall optimistic locking",
              prompt: "Which assumption defines optimistic concurrency control?",
              answer: "Conflicts stay rare until commit validation checks versions.",
              options: [
                { id: "a", text: "Validation checks versions at commit", correct: true, explanation: "Optimistic locking defers checking until commit." },
                { id: "b", text: "Every reader acquires a mutex first", correct: false, explanation: "Acquiring a mutex upfront describes pessimistic locking." },
                { id: "c", text: "Transactions skip commit ordering entirely", correct: false, explanation: "Serializability checks still run at commit." },
              ],
              hint: "Think about validation time.",
              explanation: "Optimistic concurrency avoids read locks and verifies serializability at commit.",
              misconception: "Blocking every reader.",
              citations: [],
            },
            {
              id: "cand-q2",
              kind: "quiz",
              topic: "Consistency",
              objective: "Distinguish linearizability",
              prompt: "What guarantee distinguishes linearizability from sequential consistency?",
              answer: "Real-time ordering between non-overlapping operations.",
              options: [
                { id: "a", text: "Operations respect global real-time precedence", correct: true, explanation: "Linearizability binds reads to wall-clock recency." },
                { id: "b", text: "Replicas ignore clock drift completely", correct: false, explanation: "Clock assumptions differ across protocols." },
                { id: "c", text: "Clients cache stale reads indefinitely", correct: false, explanation: "Stale reads violate linearizability." },
              ],
              hint: "Consider real-time bounds.",
              explanation: "Linearizability preserves a total real-time order across replicas.",
              misconception: "Ignoring wall-clock precedence.",
              citations: [],
            },
            {
              id: "cand-q3",
              kind: "quiz",
              topic: "Replication",
              objective: "Recall quorum replication",
              prompt: "Which statement describes quorum replication?",
              answer: "A write commits once a majority of replicas acknowledge it.",
              options: [
                { id: "a", text: "A write commits after a majority acknowledges", correct: true, explanation: "A quorum is a majority of the replicas." },
                { id: "b", text: "A single follower decides every commit", correct: false, explanation: "One follower is not a quorum." },
                { id: "c", text: "Writes commit before any replica responds", correct: false, explanation: "That is asynchronous replication." },
              ],
              hint: "Count the acknowledgements.",
              explanation: "Quorum replication waits for a majority before a write counts as committed.",
              misconception: "Treating one acknowledgement as enough.",
              citations: [],
            },
          ]
        : [
            {
              id: "cand-q1",
              kind: "quiz",
              topic: "并发控制",
              objective: "区分乐观锁与悲观锁",
              prompt: "在并发控制中，下列哪项对应乐观锁的核心假设？",
              answer: "冲突很少发生，只在提交阶段校验版本号。",
              options: [
                { id: "a", text: "提交时通过版本号检查并发冲突", correct: true, explanation: "乐观锁推迟到提交时才验证版本。" },
                { id: "b", text: "每次读取必须先加互斥量阻塞", correct: false, explanation: "预先加互斥量属于悲观锁策略。" },
                { id: "c", text: "所有事务跳过序列化检验步骤", correct: false, explanation: "提交前仍需校验序列化条件。" },
              ],
              hint: "想想何时检查冲突。",
              explanation: "乐观锁不在读阶段加锁，只在提交时校验版本号与序列化条件。",
              misconception: "以为乐观锁也会阻塞读操作。",
              citations: [],
            },
            {
              id: "cand-q2",
              kind: "quiz",
              topic: "一致性",
              objective: "辨析线性一致性",
              prompt: "下列哪项描述了线性一致性的关键约束？",
              answer: "并发操作服从满足实时先后的全局原子序。",
              options: [
                { id: "a", text: "非重叠操作保持全局实时偏序", correct: true, explanation: "线性一致性保证实时全局原子序。" },
                { id: "b", text: "副本之间永远不比较时间戳", correct: false, explanation: "很多协议会利用逻辑时钟辅助定序。" },
                { id: "c", text: "读取请求可以无限返回旧副本", correct: false, explanation: "返回陈旧值破坏线性一致性。" },
              ],
              hint: "想想实时先后顺序。",
              explanation: "线性一致性要求操作在完成瞬间立即可见，满足全局原子序。",
              misconception: "把线性一致性混同最终一致性。",
              citations: [],
            },
            {
              id: "cand-q3",
              kind: "quiz",
              topic: "副本复制",
              objective: "说出多数派复制的提交条件",
              prompt: "下列哪项描述了多数派复制的提交条件？",
              answer: "写入获得多数副本确认后才算提交。",
              options: [
                { id: "a", text: "写入获得多数副本确认后提交", correct: true, explanation: "多数派指超过半数的副本。" },
                { id: "b", text: "由单个从节点决定每次提交", correct: false, explanation: "单个从节点不构成多数派。" },
                { id: "c", text: "任何副本响应之前就提交写入", correct: false, explanation: "这是异步复制的做法。" },
              ],
              hint: "数一数确认的副本。",
              explanation: "多数派复制要等超过半数的副本确认，写入才算提交。",
              misconception: "以为一个副本确认就够了。",
              citations: [],
            },
          ],
    });
  });
}

test("candidate unfamiliar words after wrong answers, 1-click mark, and 420px layout, zh & en (#1204)", async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to look with: ${String(error.message).split("\n")[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), "study-candidate-terms-dist-"));
  await buildPreview({ outdir: dist });
  t.after(async () => {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  for (const lang of ["zh", "en"]) {
    for (const width of [1280, 420]) {
      const tag = `cand-${lang}@${width}`;
      const running = await startLateServer({ distDir: dist, lang, seed: (root) => seedCandidateTermsDeck(root, lang) });
      const { context, page, errors } = await openPage(browser, running, { lang, theme: "light", width, height: 900 });
      try {
        let cardTermsCalls = 0;
        let lastMarkPromise = Promise.resolve();
        page.on("request", (req) => {
          if (!req.url().endsWith("/api/call")) return;
          const body = req.postData() || "";
          if (body.includes('"card.terms"')) cardTermsCalls += 1;
          if (body.includes('"course.terms.mark"')) {
            lastMarkPromise = page.waitForResponse(
              (res) => res.url().endsWith("/api/call") && res.request() === req,
              { timeout: 10000 },
            ).catch(() => null);
          }
        });

        await page.goto(running.server.url);
        await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
        await page.locator(".question-toolbar").waitFor({ timeout: 30000 });
        await settleAnimations(page);

        // 1. Wrong answer while toggle is OFF -> 0 card.terms calls and no candidates shown.
        await page.locator(".options .option", {
          hasText: lang === "en" ? "Every reader acquires a mutex first" : "每次读取必须先加互斥量阻塞",
        }).click();
        await page.locator(".options .option.incorrect, .next-due").first().waitFor({ state: "visible", timeout: 10000 });
        await settleAnimations(page);
        assert.equal(cardTermsCalls, 0, `${tag}: toggle OFF triggers zero card.terms calls on wrong answer`);
        assert.equal(await page.locator(".term-strip").count(), 0, `${tag}: no term strip when toggle OFF`);

        // 2. Open 更多 -> inspect label legibility & toggle "答错后列出生词" ON.
        await page.locator(".review-more-trigger").click();
        const menuToggle = page.locator('[data-usage="review.terms-auto"]');
        await menuToggle.waitFor({ state: "visible", timeout: 10000 });
        const menuMetrics = await page.evaluate(() => {
          const menu = document.querySelector(".sh-menu");
          const item = document.querySelector('[data-usage="review.terms-auto"]');
          const label = item?.querySelector(".sh-menu__label");
          return {
            scrollW: document.documentElement.scrollWidth,
            clientW: document.documentElement.clientWidth,
            menuRight: menu?.getBoundingClientRect().right ?? 0,
            labelWidth: label?.getBoundingClientRect().width ?? 0,
          };
        });
        assert.ok(menuMetrics.labelWidth >= 90, `${tag}: menu label stays readable (width=${menuMetrics.labelWidth})`);
        assert.ok(menuMetrics.menuRight <= menuMetrics.clientW, `${tag}: open menu stays inside viewport`);
        await menuToggle.click();

        await page.locator(".term-strip .term-strip__candidate").first().waitFor({ state: "visible", timeout: 15000 });
        await settleAnimations(page);
        assert.equal(cardTermsCalls, 1, `${tag}: enabling on a wrong revealed card calls card.terms once`);
        assert.equal(await page.locator(".term-strip__fill").count(), 0, `${tag}: fill button hidden before any term marked`);

        const candStyle = await page.evaluate(() => {
          const el = document.querySelector(".term-strip .sh-chip.term-strip__candidate");
          return el ? window.getComputedStyle(el).borderTopStyle : "";
        });
        assert.equal(candStyle, "dashed", `${tag}: candidate chips render with dashed border`);
        const candHl = await highlightCount(page, "study-term-candidate");
        if (candHl >= 0) assert.ok(candHl >= 1, `${tag}: study-term-candidate CSS highlight painted (${candHl})`);
        if (candHl >= 0) assert.equal(await highlightDrawn(page, "study-term-candidate"), true, `${tag}: and it is drawn on the question, not only registered`);

        if (width === 420) {
          const stripBox = await page.locator(".term-strip").boundingBox();
          assert.ok(stripBox && stripBox.x >= 0 && stripBox.x + stripBox.width <= 421, `${tag}: term-strip fits 420px`);
          const noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
          assert.ok(noOverflow, `${tag}: no horizontal overflow at 420px`);
        }
        await page.locator(".term-strip").scrollIntoViewIfNeeded();
        await settleAnimations(page);
        await takeShot(page, `candidate-terms-${lang}-${width}`);

        // 3. One-click candidate chip -> moves to solid marked chip + shows fill button + persists only clicked term.
        const initialCandBtns = page.locator(".term-strip .term-strip__candidate .sh-chip__main");
        const initialCandCount = await initialCandBtns.count();
        const pickedWord = (await initialCandBtns.first().innerText()).trim();
        await initialCandBtns.first().click();
        await page.locator(".term-strip .sh-chip__label").first().waitFor({ state: "visible", timeout: 10000 });
        await lastMarkPromise;

        assert.deepEqual(await chipTexts(page), [pickedWord], `${tag}: clicked candidate became marked chip`);
        assert.equal(
          await page.locator(".term-strip .term-strip__candidate .sh-chip__main").count(),
          initialCandCount - 1,
          `${tag}: clicked word removed from candidate list`,
        );
        assert.equal(await page.locator(".term-strip__fill").count(), 1, `${tag}: fill button shows after marking`);

        const courseName = lang === "en" ? "Systems" : "系统课";
        const persisted = await previewCall(running.server, "course.terms.get", { course: courseName });
        assert.ok(
          persisted.items?.some((item) => item.term === pickedWord && item.state === "unknown"),
          `${tag}: clicked candidate persisted as unknown`,
        );
        assert.equal(persisted.items.length, 1, `${tag}: unclicked candidates were NOT added to course word list`);

        // 4. Advance to Card 2 with toggle still ON, answer RIGHT -> zero card.terms call!
        await page.locator('[data-usage="review.next"]').click();
        await page.locator(".options .option:not([disabled])").first().waitFor({ timeout: 10000 });
        await page.locator(".options .option", {
          hasText: lang === "en" ? "Operations respect global real-time precedence" : "非重叠操作保持全局实时偏序",
        }).click();
        await page.locator(".options .option.correct, .next-due").first().waitFor({ state: "visible", timeout: 10000 });
        await settleAnimations(page);
        assert.equal(cardTermsCalls, 1, `${tag}: right answer does NOT call card.terms even when toggle is ON`);
        assert.equal(await page.locator(".term-strip .term-strip__candidate").count(), 0, `${tag}: no candidate chips on right answer`);

        // 5. Card 3 with the toggle already ON, answer WRONG -> the session asks for this card's words by itself, once.
        await page.locator('[data-usage="review.next"]').click();
        await page.locator(".options .option:not([disabled])").first().waitFor({ timeout: 10000 });
        await page.locator(".options .option", {
          hasText: lang === "en" ? "A single follower decides every commit" : "由单个从节点决定每次提交",
        }).click();
        await page.locator(".options .option.incorrect, .next-due").first().waitFor({ state: "visible", timeout: 10000 });
        await page.locator(".term-strip .term-strip__candidate").first().waitFor({ state: "visible", timeout: 15000 });
        await settleAnimations(page);
        assert.equal(cardTermsCalls, 2, `${tag}: a wrong answer with the toggle ON calls card.terms once, without a click on the toggle`);
        await page.waitForTimeout(1500);
        assert.equal(cardTermsCalls, 2, `${tag}: later polls of the run do not ask again`);

        assert.deepEqual(errors, [], `${tag}: unexpected console/page errors: ${errors.join(" | ")}`);
      } finally {
        await context.close();
        await running.close();
      }
    }
  }
});

async function seedUnmarkGuardDeck(root, lang) {
  const service = new StudyService(root);
  await service.call("snapshot");
  const courseName = lang === "en" ? "Systems" : "系统课";
  await service.store.update((state) => {
    state.decks.push({
      id: "d-guard",
      title: lang === "en" ? "Distributed Systems" : "分布式系统",
      course: courseName,
      folder: "",
      publishedAt: "2026-10-01T00:00:00.000Z",
      cards: lang === "en"
        ? [
            {
              id: "g1",
              kind: "flashcard",
              topic: "Replication",
              objective: "Understand consistency vs quorum",
              prompt: "Explain the core trade-off in distributed replication.",
              answer: "Systems balance linearizability against quorum guarantees while avoiding split-brain.",
              hint: "Focus on ordering and availability.",
              explanation: "Linearizability gives a single global order; quorum prevents split-brain.",
              misconception: "Assuming weak consistency prevents split-brain.",
              citations: [],
            },
            {
              id: "g2",
              kind: "quiz",
              topic: "Retry Safety",
              objective: "Connect idempotency and linearizability",
              prompt: "In distributed systems, how do idempotency and linearizability work together?",
              options: [
                { id: "a", text: "Linearizability gives real-time order while idempotency makes retries safe", correct: true, explanation: "Ordering and retry safety complement each other." },
                { id: "b", text: "Both only promise eventual convergence", correct: false, explanation: "Linearizability guarantees real-time atomic ordering." },
              ],
              hint: "Think about retries and ordering.",
              explanation: "Linearizability orders operations while idempotency handles duplicates.",
              misconception: "Treating them as identical.",
              citations: [],
            },
          ]
        : [
            {
              id: "g1",
              kind: "flashcard",
              topic: "副本同步",
              objective: "理解一致性权衡",
              prompt: "请说明分布式副本同步的核心权衡。",
              answer: "系统常在 线性一致性 与 最终一致性 之间权衡，另需防范 脑裂 问题。",
              hint: "关注全局顺序与容错。",
              explanation: "线性一致性保证全局原子序，另需防止脑裂。",
              misconception: "把弱一致与强一致混为一谈。",
              citations: [],
            },
            {
              id: "g2",
              kind: "quiz",
              topic: "并发与重试",
              objective: "区分幂等性与线性一致性",
              prompt: "在 分布式系统 里，关于 幂等性 与 线性一致性 的作用，下列哪项正确？",
              options: [
                { id: "a", text: "线性一致性保证全局实时序，幂等性保证重复执行安全", correct: true, explanation: "两者分别负责全局序与安全重试。" },
                { id: "b", text: "两者都只保证最终收敛", correct: false, explanation: "线性一致性要求实时全局原子序。" },
              ],
              hint: "想一想顺序保证与重试安全。",
              explanation: "线性一致性保证并发实时序，幂等性保证重试不出错。",
              misconception: "以为两者作用相同。",
              citations: [],
            },
          ],
    });
  });
  await service.call("course.save", {
    name: courseName,
    terms: {
      version: 1,
      items: lang === "en"
        ? [{ term: "idempotency", at: "2026-11-18T08:00:00.000Z", from: { deckId: "d-guard", cardId: "g2" } }]
        : [
            { term: "幂等性", at: "2026-11-18T08:00:00.000Z", from: { deckId: "d-guard", cardId: "g2" } },
            { term: "分布式", at: "2026-11-18T07:00:00.000Z", from: { deckId: "d-guard", cardId: "g2" } },
          ],
    },
  });
}

test("term-strip remove only unmarks unattached visit-added terms and protects filled/historical terms (#1212)", async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to look with: ${String(error.message).split("\n")[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), "study-unmark-guard-dist-"));
  await buildPreview({ outdir: dist });
  t.after(async () => {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  for (const lang of ["zh", "en"]) {
    const tag = `unmark-guard-${lang}`;
    const running = await startLateServer({ distDir: dist, lang, seed: (root) => seedUnmarkGuardDeck(root, lang) });
    const { context, page, errors } = await openPage(browser, running, { lang, theme: "light", width: 1280, height: 900 });
    try {
      let unmarkCalls = 0;
      let termsGetCalls = 0;
      let lastMarkPromise = Promise.resolve();
      let lastUnmarkPromise = Promise.resolve();
      let lastGetPromise = Promise.resolve();
      page.on("request", (req) => {
        if (!req.url().endsWith("/api/call")) return;
        const body = req.postData() || "";
        const waitRes = () =>
          page.waitForResponse((res) => res.url().endsWith("/api/call") && res.request() === req, { timeout: 10000 }).catch(() => null);
        if (body.includes('"course.terms.get"')) {
          termsGetCalls += 1;
          lastGetPromise = waitRes();
        }
        if (body.includes('"course.terms.mark"')) lastMarkPromise = waitRes();
        if (body.includes('"course.terms.unmark"')) {
          unmarkCalls += 1;
          lastUnmarkPromise = waitRes();
        }
      });

      const courseName = lang === "en" ? "Systems" : "系统课";
      const termA = lang === "en" ? "linearizability" : "线性一致性";
      const termB = lang === "en" ? "quorum" : "脑裂";
      const termC = lang === "en" ? "idempotency" : "幂等性";
      const removeAria = (term) => (lang === "en" ? `Remove word “${term}”` : `移除生词「${term}」`);

      const openWordListAndRead = async () => {
        const listBtn = page.locator(".term-strip__list-btn");
        await listBtn.waitFor({ state: "visible", timeout: 10000 });
        await listBtn.click();
        const dlg = page.locator("dialog[open]").last();
        await dlg.waitFor({ state: "visible", timeout: 10000 });
        await dlg.locator(".term-list-group, .sh-empty").first().waitFor({ state: "visible", timeout: 10000 });
        return dlg;
      };

      await page.goto(running.server.url);
      await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
      await page.locator(".question-toolbar").waitFor({ timeout: 30000 });
      await settleAnimations(page);
      await lastGetPromise;

      // Flip Card 1 and enter marking mode.
      await clickWord(page, '.flip-front[aria-hidden="false"]', lang === "en" ? "replication" : "副本");
      await waitForRevealedBack(page);
      await settleAnimations(page);
      const termsBtn = page.locator('[data-usage="review.terms"]');
      await enterMarkingMode(page, termsBtn);
      const backSel = '.flip-back[aria-hidden="false"] .flash-prompt';

      // (a) Mark Term A -> complete fill (补齐这 1 个词) -> click × in .term-strip -> TermListDialog & card link stay intact.
      if (lang === "zh") await dragPhrase(page, backSel, termA, 0);
      else await clickWord(page, backSel, termA, 0);
      assert.deepEqual(await chipTexts(page), [termA], `${tag}: termA marked`);
      await lastMarkPromise;

      const fillBtn = page.locator(".term-strip__fill");
      assert.match(await fillBtn.innerText(), lang === "en" ? /Fill in this 1 word/ : /补齐这 1 个词/);
      const getsBeforeFill = termsGetCalls;
      await fillBtn.click();
      await page.waitForFunction(
        () => !!document.querySelector(".explanation-followup .followup-item[open]") && !!document.querySelector(".prereq-strip"),
        { timeout: 25000 },
      );
      for (const pollUntil = Date.now() + 10_000; Date.now() < pollUntil && termsGetCalls <= getsBeforeFill;) {
        await page.waitForTimeout(50);
      }
      await lastGetPromise;

      // #1214 automatically clears filled termA from the strip; re-stage pale termA and verify #1212 guard on ×.
      await waitForChipStripGone(page);
      assert.equal(await modeBar(page).count(), 1, `${tag}: mode bar remains while marking mode is active`);
      await clickWord(page, backSel, termA, 0);
      assert.deepEqual(await chipTexts(page), [termA], `${tag}: pale termA clicks back into strip`);
      await page.locator(".term-strip .sh-chip__remove").click();
      await waitForChipStripGone(page);

      const afterA = await previewCall(running.server, "course.terms.get", { course: courseName });
      const savedA = afterA.items?.find((item) => item.term === termA);
      assert.ok(savedA, `${tag}: filled termA remains in course.terms after clicking ×`);
      assert.ok(savedA.card?.cardId, `${tag}: filled termA keeps its linked check card`);

      // Click pale study-term-seen termA to re-open .term-strip and verify TermListDialog shows termA.
      await clickWord(page, backSel, termA, 0);
      assert.deepEqual(await chipTexts(page), [termA], `${tag}: pale termA clicks back into strip`);
      const dlgA = await openWordListAndRead();
      assert.ok((await dlgA.innerText()).includes(termA), `${tag}: TermListDialog still lists filled termA`);
      await page.keyboard.press("Escape");
      await dlgA.waitFor({ state: "hidden", timeout: 10000 });
      await page.locator(".term-strip .sh-chip__remove").click();
      await waitForChipStripGone(page);

      // (b) Mark brand-new Term B (NOT filled) -> click × -> deleted from course.terms & TermListDialog.
      if (lang === "zh") await dragPhrase(page, backSel, termB, 0);
      else await clickWord(page, backSel, termB, 0);
      assert.deepEqual(await chipTexts(page), [termB], `${tag}: brand-new termB marked`);
      await lastMarkPromise;

      await page.getByRole("button", { name: removeAria(termB) }).click();
      await lastUnmarkPromise;
      await waitForChipStripGone(page);

      const afterB = await previewCall(running.server, "course.terms.get", { course: courseName });
      assert.equal(afterB.items?.some((item) => item.term === termB), false, `${tag}: unfilled misclick termB removed`);
      assert.ok(afterB.items?.find((item) => item.term === termA)?.card?.cardId, `${tag}: termA and card untouched`);

      // Verify in TermListDialog via staging pale termA.
      await clickWord(page, backSel, termA, 0);
      const dlgB = await openWordListAndRead();
      const dlgBText = await dlgB.innerText();
      assert.ok(dlgBText.includes(termA), `${tag}: TermListDialog retains termA`);
      assert.equal(dlgBText.includes(termB), false, `${tag}: TermListDialog no longer contains termB`);
      await page.keyboard.press("Escape");
      await dlgB.waitFor({ state: "hidden", timeout: 10000 });

      // (c) Advance to Card 2 -> click pale study-term-seen historical termC into .term-strip -> click × -> still present!
      await gradeCard1AndReachCard2(page);
      await settleAnimations(page);

      assert.equal(await page.locator(".term-strip").count(), 0, `${tag}: Card 2 starts without strip`);
      const seenHl = await highlightCount(page, "study-term-seen");
      if (seenHl >= 0) assert.ok(seenHl >= 1, `${tag}: Card 2 paints study-term-seen for historical termC`);

      await enterMarkingMode(page, termsBtn);
      await clickWord(page, ".question-card .question", termC, 0);
      assert.deepEqual(await chipTexts(page), [termC], `${tag}: historical termC staged into strip`);

      const unmarkBeforeC = unmarkCalls;
      await page.getByRole("button", { name: removeAria(termC) }).click();
      await waitForChipStripGone(page);
      assert.equal(unmarkCalls, unmarkBeforeC, `${tag}: removing historical termC from strip triggers no unmark RPC`);

      const afterC = await previewCall(running.server, "course.terms.get", { course: courseName });
      assert.ok(afterC.items?.some((item) => item.term === termC), `${tag}: historical termC remains in course.terms`);

      // Stage pale termA on Card 2 and confirm both termC and termA remain in TermListDialog.
      await clickWord(page, ".question-card .question", termA, 0);
      const dlgC = await openWordListAndRead();
      const dlgCText = await dlgC.innerText();
      assert.ok(dlgCText.includes(termC), `${tag}: TermListDialog retains historical termC`);
      assert.ok(dlgCText.includes(termA), `${tag}: TermListDialog retains filled termA`);
      assert.equal(dlgCText.includes(termB), false, `${tag}: TermListDialog excludes removed termB`);
      await page.keyboard.press("Escape");
      await dlgC.waitFor({ state: "hidden", timeout: 10000 });
      await page.getByRole("button", { name: removeAria(termA) }).click();
      await waitForChipStripGone(page);

      // (zh) Verify adjacent merge of historical A ("分布式") + new B ("系统") preserves A and manages merged term.
      if (lang === "zh") {
        await clickWord(page, ".question-card .question", "分布式", 0);
        assert.deepEqual(await chipTexts(page), ["分布式"], `${tag}: historical prefix staged`);
        const unmarkBeforeMerge = unmarkCalls;
        await clickWord(page, ".question-card .question", "系统", 0);
        assert.deepEqual(await chipTexts(page), ["分布式系统"], `${tag}: merged into 分布式系统`);
        await lastMarkPromise;
        assert.equal(unmarkCalls, unmarkBeforeMerge, `${tag}: merging over historical prefix does not unmark 分布式`);

        const afterMerge = await previewCall(running.server, "course.terms.get", { course: courseName });
        assert.ok(afterMerge.items?.some((item) => item.term === "分布式"), `${tag}: historical 分布式 kept after merge`);
        assert.ok(afterMerge.items?.some((item) => item.term === "分布式系统"), `${tag}: merged 分布式系统 persisted`);

        await page.getByRole("button", { name: removeAria("分布式系统") }).click();
        await lastUnmarkPromise;
        const afterUnmarkMerged = await previewCall(running.server, "course.terms.get", { course: courseName });
        assert.equal(afterUnmarkMerged.items?.some((item) => item.term === "分布式系统"), false, `${tag}: unfilled merged term removed`);
        assert.ok(afterUnmarkMerged.items?.some((item) => item.term === "分布式"), `${tag}: historical 分布式 still kept`);
      }

      assert.deepEqual(errors, [], `${tag}: unexpected console/page errors: ${errors.join(" | ")}`);
    } finally {
      await context.close();
      await running.close();
    }
  }
});

async function seedClearOnDoneDeck(root, lang) {
  const service = new StudyService(root);
  await service.call("snapshot");
  const courseName = lang === "en" ? "Systems" : "系统课";
  await service.store.update((state) => {
    state.decks.push({
      id: "d-clear",
      title: lang === "en" ? "Distributed Systems" : "分布式系统",
      course: courseName,
      folder: "",
      publishedAt: "2026-10-01T00:00:00.000Z",
      cards: lang === "en"
        ? [
            {
              id: "k1",
              kind: "flashcard",
              topic: "Replication",
              objective: "Coordinate replicas safely",
              prompt: "Explain why distributed protocols balance consistency and fault tolerance.",
              answer: "Protocols coordinate linearizability, quorum, and consensus across unreliable replicas.",
              hint: "Consider replica coordination.",
              explanation: "Linearizability orders operations while quorum and consensus prevent divergence.",
              misconception: "Assuming network links never drop messages.",
              citations: [],
            },
            {
              id: "k2",
              kind: "quiz",
              topic: "Recovery & Retries",
              objective: "Combine idempotency and snapshotting",
              prompt: "How do distributed systems combine idempotency and snapshotting under failures?",
              options: [
                { id: "a", text: "Idempotency makes retries safe while snapshotting bounds log replay", correct: true, explanation: "Both handle failure recovery cleanly." },
                { id: "b", text: "Replicas discard logs before checkpoint verification", correct: false, explanation: "Discarding unverified logs loses durable state." },
              ],
              hint: "Think about retries and recovery.",
              explanation: "Idempotency guards duplicate writes and snapshotting shortens recovery.",
              misconception: "Assuming retries are harmless without tracking.",
              citations: [],
            },
          ]
        : [
            {
              id: "k1",
              kind: "flashcard",
              topic: "副本协议",
              objective: "理解副本协调机制",
              prompt: "请说明分布式协议为什么要在一致性与容错之间做权衡。",
              answer: "系统通常围绕 线性一致性、多数派 与 幂等性 来协调副本状态与重试安全。",
              hint: "关注副本协同与重试。",
              explanation: "线性一致性约束操作顺序，多数派保证读写交集，幂等性确保重试安全。",
              misconception: "以为网络消息永远不会乱序或重传。",
              citations: [],
            },
            {
              id: "k2",
              kind: "quiz",
              topic: "恢复与重试",
              objective: "结合事务日志与检查点",
              prompt: "在 分布式 场景下，如何配合 事务日志 与 检查点 来加速恢复？",
              options: [
                { id: "a", text: "通过 事务日志 记录变更，再用 检查点 截断历史", correct: true, explanation: "两者协同缩短重启恢复时间。" },
                { id: "b", text: "在未落盘前直接丢弃所有状态", correct: false, explanation: "未落盘丢弃状态会导致数据丢失。" },
              ],
              hint: "想一想持久化与截断。",
              explanation: "事务日志保障持久性，检查点缩短重启回放长度。",
              misconception: "以为检查点可以取代全部日志。",
              citations: [],
            },
          ],
    });
  });
}

function createControlledTermsModel() {
  const baseModel = createFakeModel({ latencyMs: 20 });
  let mode = "auto";
  let activeHold = null;

  const model = async (system, prompt, options = {}) => {
    const isAssistTerms =
      system.startsWith("You are a background study assistant.") &&
      (prompt.includes('"mode":"terms"') || prompt.includes('"mode": "terms"'));
    if (isAssistTerms) {
      if (mode === "fail") {
        // Invalid ladder shape triggers 1 repair retry and then fails the assist task.
        return JSON.stringify({ ladder: "invalid" });
      }
      if (mode === "hold" && activeHold) {
        const hold = activeHold;
        hold.signalEntered();
        await Promise.race([
          hold.waitRelease,
          new Promise((resolve) => {
            if (options?.signal?.aborted) resolve();
            else options?.signal?.addEventListener("abort", resolve, { once: true });
          }),
        ]);
      }
    }
    return baseModel(system, prompt, options);
  };

  return {
    model,
    setAuto: () => { mode = "auto"; activeHold = null; },
    setFail: () => { mode = "fail"; activeHold = null; },
    armHold: () => {
      let signalEntered;
      const entered = new Promise((resolve) => { signalEntered = resolve; });
      let releaseGate;
      const waitRelease = new Promise((resolve) => { releaseGate = resolve; });
      activeHold = { signalEntered, waitRelease };
      mode = "hold";
      return {
        entered,
        release: () => {
          mode = "auto";
          activeHold = null;
          releaseGate();
        },
      };
    },
  };
}

async function startControlledServer({ distDir, seed, lang = "zh", model }) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), "study-terms-ctrl-"));
  const root = join(base, "library");
  const seeded = seed ? await seed(root) : null;
  const server = await createPreviewServer({
    libraryRoot: root,
    home: join(base, "home"),
    port: 0,
    model,
    distDir,
  });
  return {
    base,
    server,
    seeded,
    lang,
    api: (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: lang }),
    close: async () => {
      await server.close();
      await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test("term strip clears only filled terms on done, preserves mid-task marks, and keeps terms on failure (#1214)", async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to look with: ${String(error.message).split("\n")[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), "study-clear-on-done-dist-"));
  await buildPreview({ outdir: dist });
  t.after(async () => {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  for (const lang of ["zh", "en"]) {
    const tag = `clear-on-done-${lang}`;
    const controller = createControlledTermsModel();
    const running = await startControlledServer({
      distDir: dist,
      lang,
      seed: (root) => seedClearOnDoneDeck(root, lang),
      model: controller.model,
    });
    const { context, page, errors } = await openPage(browser, running, { lang, theme: "light", width: 1280, height: 900 });
    let pendingHold = null;
    try {
      let unmarkCalls = 0;
      let termsGetCalls = 0;
      let lastMarkPromise = Promise.resolve();
      let lastGetPromise = Promise.resolve();
      page.on("request", (req) => {
        if (!req.url().endsWith("/api/call")) return;
        const body = req.postData() || "";
        const waitRes = () =>
          page.waitForResponse((res) => res.url().endsWith("/api/call") && res.request() === req, { timeout: 10000 }).catch(() => null);
        if (body.includes('"course.terms.get"')) {
          termsGetCalls += 1;
          lastGetPromise = waitRes();
        }
        if (body.includes('"course.terms.mark"')) lastMarkPromise = waitRes();
        if (body.includes('"course.terms.unmark"')) unmarkCalls += 1;
      });

      const courseName = lang === "en" ? "Systems" : "系统课";
      const k1Term1 = lang === "en" ? "linearizability" : "线性一致性";
      const k1Term2 = lang === "en" ? "quorum" : "多数派";
      const k1Term3 = lang === "en" ? "consensus" : "幂等性";
      const k2TermA = lang === "en" ? "idempotency" : "事务日志";
      const k2TermB = lang === "en" ? "snapshotting" : "检查点";

      await page.goto(running.server.url);
      await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
      await page.locator(".question-toolbar").waitFor({ timeout: 30000 });
      await settleAnimations(page);
      await lastGetPromise;

      // Flip Card 1 and enter marking mode.
      await clickWord(page, '.flip-front[aria-hidden="false"]', lang === "en" ? "protocols" : "分布式");
      await waitForRevealedBack(page);
      await settleAnimations(page);
      const termsBtn = page.locator('[data-usage="review.terms"]');
      await enterMarkingMode(page, termsBtn);
      const backSel = '.flip-back[aria-hidden="false"] .flash-prompt';

      // 1. Mark 2 terms -> 补齐 -> done -> strip disappears, pale highlight remains, 生词表 keeps both, 0 unmark calls.
      if (lang === "zh") {
        await dragPhrase(page, backSel, k1Term1, 0);
        await dragPhrase(page, backSel, k1Term2, 0);
      } else {
        await clickWord(page, backSel, k1Term1, 0);
        await clickWord(page, backSel, k1Term2, 0);
      }
      assert.deepEqual(await chipTexts(page), [k1Term1, k1Term2], `${tag}: 2 terms marked on Card 1`);
      await lastMarkPromise;

      const fillBtn = page.locator(".term-strip__fill");
      assert.match(await fillBtn.innerText(), lang === "en" ? /Fill in these 2 words/ : /补齐这 2 个词/);
      const getsBeforeFill1 = termsGetCalls;
      await fillBtn.click();
      await page.waitForFunction(
        () => !!document.querySelector(".explanation-followup .followup-item[open]") && !!document.querySelector(".prereq-strip"),
        { timeout: 25000 },
      );
      await waitForChipStripGone(page);
      for (const pollUntil = Date.now() + 10_000; Date.now() < pollUntil && termsGetCalls <= getsBeforeFill1;) {
        await page.waitForTimeout(50);
      }
      await lastGetPromise;

      assert.equal(await chipStrip(page).count(), 0, `${tag}: term chip strip disappears once 补齐 finishes done`);
      assert.equal(await modeBar(page).count(), 1, `${tag}: marking-mode bar remains visible while still in marking mode`);
      assert.equal(unmarkCalls, 0, `${tag}: clearing strip on done never calls course.terms.unmark`);
      const activeHl1 = await highlightCount(page, "study-term-mark");
      const seenHl1 = await highlightCount(page, "study-term-seen");
      if (activeHl1 >= 0) assert.equal(activeHl1, 0, `${tag}: active study-term-mark cleared after done`);
      if (seenHl1 >= 0) assert.ok(seenHl1 >= 2, `${tag}: both filled terms remain faintly highlighted as study-term-seen`);

      const afterK1 = await previewCall(running.server, "course.terms.get", { course: courseName });
      assert.ok(afterK1.items?.find((item) => item.term === k1Term1)?.card?.cardId, `${tag}: term 1 saved with check card`);
      assert.ok(afterK1.items?.find((item) => item.term === k1Term2)?.card?.cardId, `${tag}: term 2 saved with check card`);

      // Re-stage pale term 1 to open 生词表 and verify both filled terms appear inside TermListDialog, then remove without unmarking.
      await clickWord(page, backSel, k1Term1, 0);
      assert.deepEqual(await chipTexts(page), [k1Term1], `${tag}: clicking pale term stages it to strip`);
      await page.locator(".term-strip__list-btn").click();
      const dlg = page.locator("dialog[open]").last();
      await dlg.waitFor({ state: "visible", timeout: 10000 });
      await dlg.locator(".term-list-group").first().waitFor({ state: "visible", timeout: 10000 });
      const dlgText = await dlg.innerText();
      assert.ok(dlgText.includes(k1Term1) && dlgText.includes(k1Term2), `${tag}: TermListDialog retains both filled terms`);
      await page.keyboard.press("Escape");
      await dlg.waitFor({ state: "hidden", timeout: 10000 });
      await page.locator(".term-strip .sh-chip__remove").click();
      await waitForChipStripGone(page);
      assert.equal(unmarkCalls, 0, `${tag}: removing attached term still keeps unmarkCalls=0`);

      // Stage an unfilled 3rd term on Card 1 so we can also confirm Card 2's completion leaves Card 1 untouched.
      if (lang === "zh") await dragPhrase(page, backSel, k1Term3, 0);
      else await clickWord(page, backSel, k1Term3, 0);
      assert.deepEqual(await chipTexts(page), [k1Term3], `${tag}: Card 1 keeps unfilled k1Term3`);
      await lastMarkPromise;

      // Advance to Card 2 (quiz).
      await gradeCard1AndReachCard2(page);
      await settleAnimations(page);
      assert.equal(await page.locator(".term-strip").count(), 0, `${tag}: Card 2 starts with no strip`);

      // 2. Mark term A -> click 补齐 -> while running, mark term B -> on done, A clears while B stays and count reads 1.
      await enterMarkingMode(page, termsBtn);
      const qSel = ".question-card .question";
      if (lang === "zh") await dragPhrase(page, qSel, k2TermA, 0);
      else await clickWord(page, qSel, k2TermA, 0);
      assert.deepEqual(await chipTexts(page), [k2TermA], `${tag}: term A marked on Card 2`);
      await lastMarkPromise;

      pendingHold = controller.armHold();
      const getsBeforeFill2 = termsGetCalls;
      await fillBtn.click();
      await pendingHold.entered;
      await page.locator('.term-strip__fill[aria-busy="true"]').waitFor({ state: "visible", timeout: 10000 });

      // Mark term B while task for term A is still running.
      if (lang === "zh") await dragPhrase(page, qSel, k2TermB, 0);
      else await clickWord(page, qSel, k2TermB, 0);
      assert.deepEqual(await chipTexts(page), [k2TermA, k2TermB], `${tag}: term B added while task A is running`);
      await lastMarkPromise;

      // Release task A -> finishes done -> A clears from strip while B remains!
      pendingHold.release();
      pendingHold = null;
      await page.waitForFunction(
        () => !!document.querySelector(".explanation-followup .followup-item[open]"),
        { timeout: 25000 },
      );
      await page.waitForFunction(
        (expected) => {
          const labels = [...document.querySelectorAll(".term-strip .sh-chip__label")].map((el) => el.textContent?.trim());
          return labels.length === 1 && labels[0] === expected;
        },
        k2TermB,
        { timeout: 10000 },
      );
      for (const pollUntil = Date.now() + 10_000; Date.now() < pollUntil && termsGetCalls <= getsBeforeFill2;) {
        await page.waitForTimeout(50);
      }
      await lastGetPromise;

      assert.deepEqual(await chipTexts(page), [k2TermB], `${tag}: term A cleared while mid-task term B stayed`);
      assert.match(await fillBtn.innerText(), lang === "en" ? /Fill in this 1 word/ : /补齐这 1 个词/);
      assert.equal(unmarkCalls, 0, `${tag}: unmark never called when clearing A`);

      const seenHl2 = await highlightCount(page, "study-term-seen");
      const activeHl2 = await highlightCount(page, "study-term-mark");
      if (seenHl2 >= 0) assert.ok(seenHl2 >= 1, `${tag}: term A switched to pale study-term-seen highlight`);
      if (activeHl2 >= 0) assert.ok(activeHl2 >= 1, `${tag}: term B kept active study-term-mark highlight`);

      // 3. Task fails (model returns invalid result twice) -> term B stays on the strip and button remains usable.
      controller.setFail();
      await fillBtn.click();
      await page.locator(".assist-failed").waitFor({ state: "visible", timeout: 25000 });
      assert.deepEqual(await chipTexts(page), [k2TermB], `${tag}: failed terms task preserves term B on strip`);
      assert.equal(await fillBtn.isDisabled(), false, `${tag}: fill button recovers and stays enabled after failure`);
      assert.match(await fillBtn.innerText(), lang === "en" ? /Fill in this 1 word/ : /补齐这 1 个词/);
      assert.equal(unmarkCalls, 0, `${tag}: failure does not call unmark`);
      assert.match(await page.locator(".assist-failed").innerText(), lang === "en" ? /Submit again/ : /重新提交/);

      // Return to Card 1 -> Card 1's unmarked term is untouched by Card 2's completed/failed tasks.
      await page.locator('[data-usage="review.prev"]').click();
      await page.locator(".flashcard").waitFor({ timeout: 10000 });
      await page.locator(".term-strip").waitFor({ timeout: 10000 });
      assert.deepEqual(await chipTexts(page), [k1Term3], `${tag}: unrelated Card 1 strip preserved`);

      assert.deepEqual(errors, [], `${tag}: unexpected console/page errors: ${errors.join(" | ")}`);
    } finally {
      pendingHold?.release();
      await context.close();
      await running.close();
    }
  }
});

async function seedMoreMenuTermListDeck(root, lang) {
  const service = new StudyService(root);
  await service.call("snapshot");
  const courseName = lang === "en" ? "Systems" : "系统课";
  await service.store.update((state) => {
    state.decks.push(
      {
        id: "d-course",
        title: lang === "en" ? "Consistency Basics" : "一致性基础",
        course: courseName,
        folder: "",
        publishedAt: "2026-10-01T00:00:00.000Z",
        cards: lang === "en"
          ? [
              {
                id: "m1",
                kind: "flashcard",
                topic: "Quorums",
                objective: "Recall quorum overlap",
                prompt: "Why do read and write quorums overlap?",
                answer: "Overlap guarantees every read sees the latest committed write.",
                hint: "Think about R + W > N.",
                explanation: "Quorum intersection ensures at least one replica holds the newest version.",
                misconception: "Assuming any replica always has the latest state.",
                citations: [],
              },
              {
                id: "m2",
                kind: "quiz",
                topic: "Replication",
                objective: "Identify leader role",
                prompt: "What is the leader's primary role in single-leader replication?",
                options: [
                  { id: "a", text: "Serialize writes in a single log order", correct: true, explanation: "A single leader orders mutations." },
                  { id: "b", text: "Eliminate all network partitions", correct: false, explanation: "Protocols tolerate partitions rather than preventing them." },
                ],
                hint: "Focus on write ordering.",
                explanation: "Single-leader replication orders all writes through the leader.",
                misconception: "Thinking a leader prevents packet drops.",
                citations: [],
              },
            ]
          : [
              {
                id: "m1",
                kind: "flashcard",
                topic: "多数派交集",
                objective: "理解读写交集",
                prompt: "为什么读多数派和写多数派需要有交集？",
                answer: "读写有交集时，每次读取至少能命中一个保存着最新写入版本的副本。",
                hint: "想一想 R + W > N。",
                explanation: "交集保证最新写入能被后续读请求观察到。",
                misconception: "以为任意单个副本都会立刻同步。",
                citations: [],
              },
              {
                id: "m2",
                kind: "quiz",
                topic: "主从复制",
                objective: "识别主节点职责",
                prompt: "单主复制模式中，主节点最核心的职责是什么？",
                options: [
                  { id: "a", text: "将所有写入排成单一顺序日志", correct: true, explanation: "单主负责全局写定序。" },
                  { id: "b", text: "消除所有网络分区故障", correct: false, explanation: "复制协议只能容错而不能消除网络分区。" },
                ],
                hint: "关注写入定序。",
                explanation: "主节点串行化写入顺序并向从节点传播变更。",
                misconception: "以为选主可以避免网络分区。",
                citations: [],
              },
            ],
      },
      {
        id: "d-nocourse",
        title: lang === "en" ? "Misc Notes" : "未归类题组",
        course: "",
        folder: "",
        publishedAt: "2026-10-01T00:00:00.000Z",
        cards: [
          {
            id: "nc1",
            kind: "flashcard",
            topic: "Misc",
            objective: "Uncategorized card",
            prompt: lang === "en" ? "What is a checksum?" : "什么是校验和？",
            answer: lang === "en" ? "A compact digest for detecting corruption." : "用于检测数据损坏的紧凑摘要。",
            hint: "Error detection.",
            explanation: "Checksums detect accidental bit flips.",
            misconception: "Same as encryption.",
            citations: [],
          },
        ],
      },
    );
  });
  await service.call("course.save", {
    name: courseName,
    terms: {
      version: 1,
      items: lang === "en"
        ? [
            { term: "idempotency", alt: "retry safety", at: "2026-11-18T09:00:00.000Z", from: { deckId: "d-course", cardId: "m1" } },
            { term: "linearizability", at: "2026-11-18T08:00:00.000Z", from: { deckId: "d-course", cardId: "m2" } },
          ]
        : [
            { term: "幂等性", alt: "idempotency", at: "2026-11-18T09:00:00.000Z", from: { deckId: "d-course", cardId: "m1" } },
            { term: "线性一致性", at: "2026-11-18T08:00:00.000Z", from: { deckId: "d-course", cardId: "m2" } },
          ],
    },
  });
}

test("More menu › 生词表… opens TermListDialog with 0 marked terms on flashcard & quiz, hides without course, and Finder targets 更多 (#1221)", async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to look with: ${String(error.message).split("\n")[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), "study-more-term-list-dist-"));
  await buildPreview({ outdir: dist });
  t.after(async () => {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  for (const lang of ["zh", "en"]) {
    for (const width of [1280, 420]) {
      const tag = `more-term-list-${lang}@${width}`;
      const running = await startLateServer({ distDir: dist, lang, seed: (root) => seedMoreMenuTermListDeck(root, lang) });
      const { context, page, errors } = await openPage(browser, running, { lang, theme: "light", width, height: 900 });
      try {
        const expectedTermA = lang === "en" ? "idempotency" : "幂等性";
        const expectedTermB = lang === "en" ? "linearizability" : "线性一致性";

        const assertMoreMenuOpensTermList = async (stepTag) => {
          assert.equal(await page.locator(".term-strip").count(), 0, `${stepTag}: 0 marked terms so strip is hidden`);
          await page.locator(".review-more-trigger").scrollIntoViewIfNeeded();
          await settleAnimations(page);
          await page.locator(".review-more-trigger").click();
          const item = page.locator('[data-usage="review.term-list"]');
          await item.waitFor({ state: "visible", timeout: 10000 });
          assert.equal((await item.innerText()).trim(), lang === "en" ? "Word list…" : "生词表…", `${stepTag}: More menu label matches`);
          await item.click();

          const dlg = page.locator("dialog[open]").last();
          await dlg.waitFor({ state: "visible", timeout: 10000 });
          await dlg.locator(".term-list-group").first().waitFor({ state: "visible", timeout: 10000 });
          const dlgText = await dlg.innerText();
          assert.match(dlgText, lang === "en" ? /Systems · Word list/ : /系统课 · 生词表/, `${stepTag}: course title shown`);
          assert.ok(dlgText.includes(expectedTermA) && dlgText.includes(expectedTermB), `${stepTag}: saved course terms appear`);
          await page.keyboard.press("Escape");
          await dlg.waitFor({ state: "hidden", timeout: 10000 });
        };

        await page.goto(running.server.url);
        // 1. Start the course deck directly (Card 1: flashcard, 0 marked terms).
        const coursePlay = page.locator('[data-deck-id="d-course"] > .deck-row .map-play');
        await coursePlay.waitFor({ state: "visible", timeout: 30000 });
        await coursePlay.click();
        await confirmStart(page);
        await page.locator(".flashcard").waitFor({ state: "visible", timeout: 30000 });
        await settleAnimations(page);
        await assertMoreMenuOpensTermList(`${tag}-flashcard`);

        // 2. Feature Finder locates course-term-list at 更多 › 生词表… and focuses review-more.
        if (width <= 560) {
          await page.locator(".nav-menu-toggle").click();
          await page.locator('[data-tour="nav-finder"]').waitFor({ state: "visible", timeout: 10000 });
          await page.locator('[data-tour="nav-finder"]').click();
        } else {
          await page.locator(".question-meta").click({ position: { x: 10, y: 10 } });
          await page.keyboard.press("Control+K");
        }
        const finderInput = page.locator('dialog[open] [role="combobox"]');
        await finderInput.waitFor({ state: "visible", timeout: 10000 });
        await finderInput.fill(lang === "en" ? "Word list" : "生词表");
        const finderRow = page.locator('[data-entry="course-term-list"]');
        await finderRow.waitFor({ state: "visible", timeout: 10000 });
        const rowText = await finderRow.innerText();
        assert.match(rowText, lang === "en" ? /More › Word list…/ : /更多 › 生词表…/, `${tag}: Finder crumbs point to 更多 › 生词表…`);
        await finderRow.locator(".finder-row__go").click();

        await page.waitForFunction(
          () => !!document.activeElement?.closest('[data-tour="review-more"]'),
          undefined,
          { timeout: 10000 },
        );
        const toast = page.locator(".sh-toast").first();
        await toast.waitFor({ state: "visible", timeout: 10000 });
        const toastText = await toast.innerText();
        assert.match(
          toastText,
          lang === "en" ? /click “More” below the question/i : /点题目下方的「更多」/,
          `${tag}: Finder shows run-more guidance toast`,
        );

        // 3. Flip & grade Card 1 to advance to Card 2 (quiz, 0 marked terms) and verify 更多 › 生词表… works there too.
        await page.locator('[data-usage="review.flip"]').click();
        await page.locator('.flip-back[aria-hidden="false"]').waitFor({ state: "visible", timeout: 10000 });
        await settleAnimations(page);
        await gradeCard1AndReachCard2(page);
        await settleAnimations(page);
        await assertMoreMenuOpensTermList(`${tag}-quiz`);

        // 4. Start self-paced flashcard mode on the course deck and verify 更多 › 生词表… opens TermListDialog too.
        await page.locator(".review-return").click();
        // Back in the library the list is still being placed (the run's snapshot lands, the page settles its scroll). A menu opened meanwhile
        // shuts when its trigger moves (ui/components/Menu.jsx), so open it once the row stops moving, and open it again if it shut anyway.
        // Every click in the loop has a short limit of its own: once 闪卡翻看 has started review.start the library leaves the page, and a
        // click still waiting on the deck menu then waits for a row that is gone (Playwright's 120 s) instead of the loop seeing the flashcard.
        const deckMenu = page.locator('[data-deck-id="d-course"] > .deck-row .map-menu-wrap button');
        await deckMenu.waitFor({ state: "visible", timeout: 15000 });
        await settleAnimations(page);
        let lastBox = "";
        await until(async () => { const box = JSON.stringify(await deckMenu.boundingBox()); const still = box === lastBox; lastBox = box; return still; },
          `${tag}: the deck row to stop moving`, { timeoutMs: 15000, intervalMs: 150 });
        const browse = page.getByRole("menuitem", { name: lang === "en" ? "Browse flashcards" : "闪卡翻看" });
        await until(async () => {
          if (await page.locator(".flashcard").count()) return true;
          if (!(await browse.isVisible())) await deckMenu.click({ timeout: 2000 }).catch(() => {});
          else await browse.click({ timeout: 2000 }).catch(() => {});
          return false;
        }, `${tag}: 闪卡翻看 from the deck menu`, { timeoutMs: 30000, intervalMs: 200 });
        await page.locator(".flashcard").waitFor({ state: "visible", timeout: 15000 });
        await settleAnimations(page);
        await assertMoreMenuOpensTermList(`${tag}-self-paced-flashcard`);

        // 5. Return to library and open an uncategorized deck (no course) -> 更多 omits 生词表….
        await page.locator(".review-return").click();
        const showOtherBtn = page.locator(".show-other-courses").first();
        await showOtherBtn.waitFor({ state: "visible", timeout: 15000 });
        await showOtherBtn.click();
        const noCoursePlay = page.locator('[data-deck-id="d-nocourse"] > .deck-row .map-play');
        await noCoursePlay.waitFor({ state: "visible", timeout: 15000 });
        await noCoursePlay.click();
        await confirmStart(page);
        await page.locator(".flashcard").waitFor({ state: "visible", timeout: 15000 });
        await settleAnimations(page);
        await page.locator(".review-more-trigger").scrollIntoViewIfNeeded();
        await page.locator(".review-more-trigger").click();
        await page.getByRole("menu").waitFor({ state: "visible", timeout: 10000 });
        assert.equal(await page.locator('[data-usage="review.term-list"]').count(), 0, `${tag}: no-course deck omits term list from More menu`);
        await page.keyboard.press("Escape");

        assert.deepEqual(errors, [], `${tag}: unexpected console/page errors: ${errors.join(" | ")}`);
      } finally {
        await context.close();
        await running.close();
      }
    }
  }
});

test("filled candidate term stays excluded from dashed candidates and keeps only pale study-term-seen highlight (#1242)", async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to look with: ${String(error.message).split("\n")[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), "study-cand-exclude-dist-"));
  await buildPreview({ outdir: dist });
  t.after(async () => {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  for (const lang of ["zh", "en"]) {
    const tag = `cand-exclude-${lang}`;
    const running = await startLateServer({ distDir: dist, lang, seed: (root) => seedCandidateTermsDeck(root, lang) });
    const { context, page, errors } = await openPage(browser, running, { lang, theme: "light", width: 1280, height: 900 });
    try {
      let termsGetCalls = 0;
      let lastGetPromise = Promise.resolve();
      let lastMarkPromise = Promise.resolve();
      page.on("request", (req) => {
        if (!req.url().endsWith("/api/call")) return;
        const body = req.postData() || "";
        const waitRes = () =>
          page.waitForResponse((res) => res.url().endsWith("/api/call") && res.request() === req, { timeout: 10000 }).catch(() => null);
        if (body.includes('"course.terms.get"')) {
          termsGetCalls += 1;
          lastGetPromise = waitRes();
        }
        if (body.includes('"course.terms.mark"')) lastMarkPromise = waitRes();
      });

      await page.goto(running.server.url);
      await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
      await page.locator(".question-toolbar").waitFor({ timeout: 30000 });
      await settleAnimations(page);
      await lastGetPromise;

      // Enable candidate terms and answer Card 1 wrong -> dashed candidate chips appear.
      await page.locator(".review-more-trigger").click();
      await page.locator('[data-usage="review.terms-auto"]').click();
      await page.locator(".options .option", {
        hasText: lang === "en" ? "Every reader acquires a mutex first" : "每次读取必须先加互斥量阻塞",
      }).click();
      await page.locator(".term-strip .term-strip__candidate").first().waitFor({ state: "visible", timeout: 15000 });
      await settleAnimations(page);

      const initialCandidates = (await page.locator(".term-strip .term-strip__candidate .sh-chip__main").allInnerTexts())
        .map((text) => text.trim())
        .filter(Boolean);
      assert.ok(initialCandidates.length >= 2, `${tag}: expected >= 2 candidate chips (${initialCandidates.join(", ")})`);
      const pickedWord = initialCandidates[0];
      const remainingExpected = initialCandidates.slice(1);

      // Click first candidate -> moves to active strip -> click 补齐 / Fill in this 1 word.
      await page.locator(".term-strip .term-strip__candidate .sh-chip__main").first().click();
      await page.locator(".term-strip .sh-chip__label").first().waitFor({ state: "visible", timeout: 10000 });
      await lastMarkPromise;
      assert.deepEqual(await chipTexts(page), [pickedWord], `${tag}: clicked candidate staged in active strip`);

      const getsBeforeFill = termsGetCalls;
      await page.locator(".term-strip__fill").click();
      await page.waitForFunction(
        () => !!document.querySelector(".explanation-followup .followup-item[open]") && !!document.querySelector(".prereq-strip"),
        { timeout: 25000 },
      );
      await page.waitForFunction(
        () => document.querySelectorAll(".term-strip .sh-chip__label").length === 0,
        { timeout: 10000 },
      );
      for (const pollUntil = Date.now() + 10_000; Date.now() < pollUntil && termsGetCalls <= getsBeforeFill;) {
        await page.waitForTimeout(50);
      }
      await lastGetPromise;
      await settleAnimations(page);

      // Server confirms filled term is saved with state === "unknown" and linked check card.
      const courseName = lang === "en" ? "Systems" : "系统课";
      const persisted = await previewCall(running.server, "course.terms.get", { course: courseName });
      const savedEntry = persisted.items?.find((item) => item.term.toLowerCase() === pickedWord.toLowerCase());
      assert.ok(savedEntry && savedEntry.state === "unknown" && savedEntry.card?.cardId, `${tag}: filled term stored as unknown with check card`);

      // Strip must NOT re-show pickedWord as a dashed candidate; unpicked candidates remain.
      const afterCandidates = (await page.locator(".term-strip .term-strip__candidate .sh-chip__main").allInnerTexts())
        .map((text) => text.trim())
        .filter(Boolean);
      assert.equal(
        afterCandidates.some((item) => item.toLowerCase() === pickedWord.toLowerCase()),
        false,
        `${tag}: filled term "${pickedWord}" must not reappear as dashed candidate (got: ${afterCandidates.join(", ")})`,
      );
      assert.deepEqual(afterCandidates, remainingExpected, `${tag}: unpicked candidates remain available`);
      assert.equal(await page.locator(".term-strip .sh-chip__label").count(), 0, `${tag}: active marked strip stays cleared`);

      // CSS highlights: pickedWord has ONLY pale study-term-seen highlight, NEVER study-term-candidate or study-term-mark.
      const seenTexts = await highlightTexts(page, "study-term-seen");
      const candTexts = await highlightTexts(page, "study-term-candidate");
      const activeCount = await highlightCount(page, "study-term-mark");
      if (seenTexts !== null && candTexts !== null) {
        assert.equal(activeCount, 0, `${tag}: active study-term-mark is empty`);
        assert.ok(
          seenTexts.some((text) => text.toLowerCase() === pickedWord.toLowerCase()),
          `${tag}: filled term "${pickedWord}" keeps pale study-term-seen highlight (${seenTexts.join(", ")})`,
        );
        assert.equal(
          candTexts.some((text) => text.toLowerCase() === pickedWord.toLowerCase()),
          false,
          `${tag}: filled term "${pickedWord}" has NO dashed study-term-candidate highlight (${candTexts.join(", ")})`,
        );
      }

      assert.deepEqual(errors, [], `${tag}: unexpected console/page errors: ${errors.join(" | ")}`);
    } finally {
      await context.close();
      await running.close();
    }
  }
});

async function seedCandidateCoverageDeck(root, lang) {
  const service = new StudyService(root);
  await service.call("snapshot");
  const courseName = lang === "en" ? "Systems" : "系统课";
  await service.store.update((state) => {
    state.decks.push({
      id: "d-cov",
      title: lang === "en" ? "Distributed Review" : "分布式复习",
      course: courseName,
      folder: "",
      publishedAt: "2026-10-01T00:00:00.000Z",
      cards: lang === "en"
        ? [
            {
              id: "cov-fc1",
              kind: "flashcard",
              topic: "Consistency",
              objective: "Understand linearizability",
              prompt: "Explain what linearizability guarantees across replicas.",
              answer: "Linearizability enforces real-time atomic ordering while balancing quorum availability and split-brain protection.",
              hint: "Focus on wall-clock order.",
              explanation: "Linearizability guarantees every read observes the newest completed write.",
              misconception: "Confusing linearizability with eventual convergence.",
              citations: [],
            },
            {
              id: "cov-fc2",
              kind: "flashcard",
              topic: "Retry Safety",
              objective: "Understand idempotency",
              prompt: "Why does idempotency matter for distributed RPC retries?",
              answer: "Idempotency guarantees repeated requests produce the same durable state without duplicate side effects.",
              hint: "Think about duplicate messages.",
              explanation: "Idempotency lets clients safely retry timeouts.",
              misconception: "Assuming retries are harmless by default.",
              citations: [],
            },
            {
              id: "cov-q1",
              kind: "quiz",
              topic: "Concurrency Control",
              objective: "Identify optimistic locking",
              prompt: "Which assumption defines optimistic concurrency control?",
              answer: "Conflicts stay rare until commit validation checks versions.",
              options: [
                { id: "a", text: "Validation checks versions at commit", correct: true, explanation: "Optimistic locking defers checking until commit." },
                { id: "b", text: "Every reader acquires a mutex first", correct: false, explanation: "Acquiring a mutex upfront describes pessimistic locking." },
              ],
              hint: "Think about validation time.",
              explanation: "Optimistic concurrency avoids read locks and checks serializability at commit.",
              misconception: "Blocking every reader.",
              citations: [],
            },
            {
              id: "cov-q2",
              kind: "quiz",
              topic: "Quorums",
              objective: "Recall quorum intersection",
              prompt: "Why must read and write quorums intersect in replicated storage?",
              answer: "Intersection guarantees every read sees at least one replica with the latest write.",
              options: [
                { id: "a", text: "Overlap ensures reads encounter the newest committed write", correct: true, explanation: "R + W > N guarantees overlap." },
                { id: "b", text: "Replicas discard commit logs before consensus finishes", correct: false, explanation: "Logs preserve durable history." },
              ],
              hint: "Think about R + W > N.",
              explanation: "Quorum overlap guarantees at least one up-to-date replica answers.",
              misconception: "Assuming any single replica is always current.",
              citations: [],
            },
          ]
        : [
            {
              id: "cov-fc1",
              kind: "flashcard",
              topic: "一致性",
              objective: "理解线性一致性",
              prompt: "请说明线性一致性对并发读写的核心保证。",
              answer: "系统在 线性一致性 与 最终一致性 之间权衡，依靠 多数派 与 原子序 防范 脑裂。",
              hint: "关注实时原子序。",
              explanation: "线性一致性保证并发读写呈现全局实时原子序。",
              misconception: "把线性一致性混同最终一致性。",
              citations: [],
            },
            {
              id: "cov-fc2",
              kind: "flashcard",
              topic: "重试安全",
              objective: "理解幂等性",
              prompt: "分布式系统里为什么需要幂等性？",
              answer: "幂等性 保证重复执行同一请求不会产生额外副作用，常配合 事务日志 使用。",
              hint: "想一想超时重试。",
              explanation: "幂等性让客户端超时重试保持结果一致。",
              misconception: "把幂等性和可交换性混为一谈。",
              citations: [],
            },
            {
              id: "cov-q1",
              kind: "quiz",
              topic: "并发控制",
              objective: "识别乐观锁假设",
              prompt: "在并发控制中，下列哪项对应乐观锁的核心假设？",
              answer: "冲突很少发生，只在提交阶段校验版本号。",
              options: [
                { id: "a", text: "提交时通过版本号检查并发冲突", correct: true, explanation: "乐观锁推迟到提交时才验证版本。" },
                { id: "b", text: "每次读取必须先加互斥量阻塞", correct: false, explanation: "预先加互斥量属于悲观锁策略。" },
              ],
              hint: "想想何时检查冲突。",
              explanation: "乐观锁不在读阶段加锁，只在提交时校验版本号与序列化条件。",
              misconception: "以为乐观锁也会阻塞读操作。",
              citations: [],
            },
            {
              id: "cov-q2",
              kind: "quiz",
              topic: "多数派交集",
              objective: "理解读写交集",
              prompt: "为什么分布式存储要求读多数派与写多数派有交集？",
              answer: "交集保证读取至少命中一个持有最新写入的副本。",
              options: [
                { id: "a", text: "交集确保读请求至少命中一个最新副本", correct: true, explanation: "R + W > N 保证读写集合必然相交。" },
                { id: "b", text: "副本在达成共识前可以随意丢弃事务日志", correct: false, explanation: "事务日志用于保障持久性。" },
              ],
              hint: "想想 R + W > N。",
              explanation: "多数派交集确保至少一个副本保存了最新已提交版本。",
              misconception: "以为任意单个副本总是最新的。",
              citations: [],
            },
          ],
    });
  });
}

async function seedQuizOnlyDeck(root, lang) {
  const service = new StudyService(root);
  await service.call("snapshot");
  const courseName = lang === "en" ? "Systems" : "系统课";
  await service.store.update((state) => {
    state.decks.push({
      id: "d-quiz-cov",
      title: lang === "en" ? "Concurrency Quiz" : "并发测验",
      course: courseName,
      folder: "",
      publishedAt: "2026-10-01T00:00:00.000Z",
      cards: lang === "en"
        ? [
            {
              id: "qz-1",
              kind: "quiz",
              topic: "Concurrency Control",
              objective: "Identify optimistic locking",
              prompt: "Which assumption defines optimistic concurrency control?",
              answer: "Validation checks versions at commit.",
              options: [
                { id: "a", text: "Validation checks versions at commit", correct: true, explanation: "Optimistic locking defers checking until commit." },
                { id: "b", text: "Every reader acquires a mutex first", correct: false, explanation: "Acquiring a mutex upfront describes pessimistic locking." },
              ],
              hint: "Think about validation time.",
              explanation: "Optimistic concurrency avoids read locks and checks serializability at commit.",
              misconception: "Blocking every reader.",
              citations: [],
            },
            {
              id: "qz-2",
              kind: "quiz",
              topic: "Quorums",
              objective: "Recall quorum intersection",
              prompt: "Why must read and write quorums intersect in replicated storage?",
              answer: "Overlap ensures reads encounter the newest committed write.",
              options: [
                { id: "a", text: "Overlap ensures reads encounter the newest committed write", correct: true, explanation: "R + W > N guarantees overlap." },
                { id: "b", text: "Replicas discard commit logs before consensus finishes", correct: false, explanation: "Logs preserve durable history." },
              ],
              hint: "Think about R + W > N.",
              explanation: "Quorum overlap guarantees at least one up-to-date replica answers.",
              misconception: "Assuming any single replica is always current.",
              citations: [],
            },
          ]
        : [
            {
              id: "qz-1",
              kind: "quiz",
              topic: "并发控制",
              objective: "识别乐观锁假设",
              prompt: "在并发控制中，下列哪项对应乐观锁的核心假设？",
              answer: "提交时通过版本号检查并发冲突。",
              options: [
                { id: "a", text: "提交时通过版本号检查并发冲突", correct: true, explanation: "乐观锁推迟到提交时才验证版本。" },
                { id: "b", text: "每次读取必须先加互斥量阻塞", correct: false, explanation: "预先加互斥量属于悲观锁策略。" },
              ],
              hint: "想想何时检查冲突。",
              explanation: "乐观锁不在读阶段加锁，只在提交时校验版本号与序列化条件。",
              misconception: "以为乐观锁也会阻塞读操作。",
              citations: [],
            },
            {
              id: "qz-2",
              kind: "quiz",
              topic: "多数派交集",
              objective: "理解读写交集",
              prompt: "为什么分布式存储要求读多数派与写多数派有交集？",
              answer: "交集确保读请求至少命中一个最新副本。",
              options: [
                { id: "a", text: "交集确保读请求至少命中一个最新副本", correct: true, explanation: "R + W > N 保证读写集合必然相交。" },
                { id: "b", text: "副本在达成共识前可以随意丢弃事务日志", correct: false, explanation: "事务日志用于保障持久性。" },
              ],
              hint: "想想 R + W > N。",
              explanation: "多数派交集确保至少一个副本保存了最新已提交版本。",
              misconception: "以为任意单个副本总是最新的。",
              citations: [],
            },
          ],
    });
  });
}

test("candidate terms behavioral guards: flashcard 1/4, right quiz, cache revisit, light-model failure auto-off, and exam mode (#1243, #1246)", async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to look with: ${String(error.message).split("\n")[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), "study-cand-1243-dist-"));
  await buildPreview({ outdir: dist });
  t.after(async () => {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // With autoTerms off, a low grade keeps its feedback on screen without requesting candidate terms.
  {
    const running = await startLateServer({ distDir: dist, lang: "zh", seed: (root) => seedCandidateCoverageDeck(root, "zh") });
    const { context, page, errors } = await openPage(browser, running, { lang: "zh", theme: "light", width: 1280, height: 900 });
    try {
      let cardTermsCalls = 0;
      page.on("request", (req) => {
        if (req.url().endsWith("/api/call") && (req.postData() || "").includes('"card.terms"')) cardTermsCalls += 1;
      });
      await page.goto(running.server.url);
      await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
      await page.locator(".flashcard").waitFor({ state: "visible", timeout: 30000 });
      await settleAnimations(page);

      await page.locator('[data-usage="review.flip"]').click();
      await page.locator('.flip-back[aria-hidden="false"]').waitFor({ state: "visible", timeout: 10000 });
      await page.locator(".grade-scale .grade").nth(1).click();
      await page.locator(".next-due").first().waitFor({ state: "visible", timeout: 10000 });
      assert.match(await page.locator('.flip-back[aria-hidden="false"] .flash-prompt').innerText(), /线性一致性/);
      assert.equal(await page.locator(".term-strip .term-strip__candidate").count(), 0);
      await page.locator('[data-usage="review.next"]').click();
      await page.waitForFunction(
        () => (document.querySelector(".question-card .flash-prompt")?.textContent || "").includes("幂等性"),
        null, { timeout: 10000 },
      );
      assert.equal(cardTermsCalls, 0, "autoTerms OFF makes no card.terms call during feedback or on moving to the next card");
      assert.equal(await page.locator(".term-strip .term-strip__candidate").count(), 0);
      assert.deepEqual(errors, [], `autoTerms-off guard errors: ${errors.join(" | ")}`);
    } finally {
      await context.close();
      await running.close();
    }
  }

  // Scenarios 1, 2, 3, 4: toggle already ON -> flashcard rate 1 -> next flashcard rate 4 -> quiz right -> revisit cached card.
  {
    const running = await startLateServer({ distDir: dist, lang: "zh", seed: (root) => seedCandidateCoverageDeck(root, "zh") });
    const { context, page, errors } = await openPage(browser, running, { lang: "zh", theme: "light", width: 1280, height: 900 });
    try {
      let cardTermsCalls = 0;
      page.on("request", (req) => {
        if (req.url().endsWith("/api/call") && (req.postData() || "").includes('"card.terms"')) cardTermsCalls += 1;
      });

      await page.goto(running.server.url);
      await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
      await page.locator(".flashcard").waitFor({ state: "visible", timeout: 30000 });
      await settleAnimations(page);

      // Scenario 1: Toggle already ON before flipping -> flashcard flip -> rate 1 -> stays on Card 1, candidates appear, card.terms called 1 time.
      await page.locator(".review-more-trigger").click();
      const autoToggle = page.locator('[data-usage="review.terms-auto"]');
      await autoToggle.waitFor({ state: "visible", timeout: 10000 });
      assert.equal(await autoToggle.getAttribute("aria-checked"), "false", "S1: toggle starts OFF");
      await autoToggle.click();
      assert.equal(cardTermsCalls, 0, "S1: turning toggle ON before reveal/grade triggers 0 card.terms calls");

      await page.locator('[data-usage="review.flip"]').click();
      await page.locator('.flip-back[aria-hidden="false"]').waitFor({ state: "visible", timeout: 10000 });
      await settleAnimations(page);
      assert.equal(cardTermsCalls, 0, "S1: flipping before grading triggers 0 card.terms calls");

      await page.locator(".grade-scale .grade").nth(1).click();
      await page.locator(".term-strip .term-strip__candidate").first().waitFor({ state: "visible", timeout: 15000 });
      await settleAnimations(page);
      assert.equal(cardTermsCalls, 1, "S1: rating flashcard 1 with toggle ON calls card.terms exactly 1 time");
      assert.ok(
        (await page.locator(".term-strip .term-strip__candidate").count()) >= 1,
        "S1: candidate chips appear after rating flashcard 1",
      );
      const fc1Prompt = await page.locator(".question-card").innerText();
      assert.match(fc1Prompt, /线性一致性/, "S1: stayed on Flashcard 1 after rating 1 (#1246)");

      // Scenario 2: Next flashcard in same round -> flip -> rate 4 -> no candidates appear, card.terms count unchanged.
      await page.locator('[data-usage="review.next"]').click();
      await page.waitForFunction(
        () => (document.querySelector(".question-card .flash-prompt")?.textContent || "").includes("幂等性"),
        { timeout: 10000 },
      );
      await settleAnimations(page);
      await page.locator('[data-usage="review.flip"]').click();
      await page.locator('.flip-back[aria-hidden="false"]').waitFor({ state: "visible", timeout: 10000 });
      await page.locator(".grade-scale .grade").nth(4).click();
      // Passing self-grade 4 still auto-advances to Card 3 (quiz).
      await page.locator(".options .option:not([disabled])").first().waitFor({ state: "visible", timeout: 15000 });
      await settleAnimations(page);
      assert.equal(cardTermsCalls, 1, "S2: rating next flashcard 4 keeps card.terms count at 1");

      // Step back to Card 2 (graded 4) to also verify directly on Card 2 that no candidates appear and no call fires.
      await page.locator('[data-usage="review.prev"]').click();
      await page.waitForFunction(
        () => (document.querySelector(".question-card")?.textContent || "").includes("幂等性"),
        { timeout: 10000 },
      );
      await settleAnimations(page);
      await page.waitForTimeout(250);
      assert.equal(await page.locator(".term-strip .term-strip__candidate").count(), 0, "S2: no candidate chips on flashcard rated 4");
      assert.equal(cardTermsCalls, 1, "S2: viewing flashcard rated 4 keeps card.terms count at 1");

      // Scenario 3: Toggle ON -> quiz question answered RIGHT -> no candidates, card.terms count unchanged.
      await page.locator('[data-usage="review.next"]').click();
      await page.locator(".options .option:not([disabled])").first().waitFor({ state: "visible", timeout: 10000 });
      await page.locator(".options .option", { hasText: "提交时通过版本号检查并发冲突" }).click();
      await page.locator(".options .option.correct, .next-due").first().waitFor({ state: "visible", timeout: 10000 });
      await settleAnimations(page);
      await page.waitForTimeout(250);
      assert.equal(cardTermsCalls, 1, "S3: answering quiz RIGHT with toggle ON keeps card.terms count at 1");
      assert.equal(await page.locator(".term-strip .term-strip__candidate").count(), 0, "S3: no candidate chips on right quiz answer");

      // Scenario 4: Toggle ON -> revisit already-fetched Flashcard 1 -> uses card cache, card.terms count unchanged.
      await page.locator('[data-usage="review.prev"]').click();
      await page.waitForFunction(
        () => (document.querySelector(".question-card")?.textContent || "").includes("幂等性"),
        { timeout: 10000 },
      );
      await page.locator('[data-usage="review.prev"]').click();
      await page.locator(".term-strip .term-strip__candidate").first().waitFor({ state: "visible", timeout: 10000 });
      await settleAnimations(page);
      await page.waitForTimeout(250);
      assert.equal(cardTermsCalls, 1, "S4: revisiting already-fetched question reuses card cache without calling card.terms again");
      assert.ok(
        (await page.locator(".term-strip .term-strip__candidate").count()) >= 1,
        "S4: cached candidate chips still display on revisit",
      );

      assert.deepEqual(errors, [], `S1-S4 unexpected console/page errors: ${errors.join(" | ")}`);
    } finally {
      await context.close();
      await running.close();
    }
  }

  // Scenario 5: Light model unavailable -> wrong answer -> page shows error AND toggle switches OFF; 2nd wrong answer never calls card.terms.
  {
    const running = await startControlledServer({
      distDir: dist,
      lang: "zh",
      seed: (root) => seedQuizOnlyDeck(root, "zh"),
      model: null,
    });
    const { context, page } = await openPage(browser, running, { lang: "zh", theme: "light", width: 1280, height: 900 });
    try {
      let cardTermsCalls = 0;
      let lastTermsResponse = Promise.resolve();
      page.on("request", (req) => {
        if (!req.url().endsWith("/api/call")) return;
        const body = req.postData() || "";
        if (body.includes('"card.terms"')) {
          cardTermsCalls += 1;
          lastTermsResponse = page.waitForResponse(
            (res) => res.url().endsWith("/api/call") && res.request() === req,
            { timeout: 10000 },
          ).catch(() => null);
        }
      });

      await page.goto(running.server.url);
      await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
      await page.locator(".options .option:not([disabled])").first().waitFor({ state: "visible", timeout: 30000 });
      await settleAnimations(page);

      // Turn toggle ON first.
      await page.locator(".review-more-trigger").click();
      await page.locator('[data-usage="review.terms-auto"]').click();

      // Answer Card 1 WRONG -> card.terms called once, fails -> page shows error toast AND toggle flips OFF.
      await page.locator(".options .option", { hasText: "每次读取必须先加互斥量阻塞" }).click();
      await page.locator(".options .option.incorrect, .next-due").first().waitFor({ state: "visible", timeout: 10000 });
      await page.locator(".sh-toast--error").waitFor({ state: "visible", timeout: 15000 });
      await lastTermsResponse;
      assert.equal(cardTermsCalls, 1, "S5: first wrong answer attempted card.terms once");
      const errText = (await page.locator(".sh-toast--error").innerText()).trim();
      assert.ok(errText.length > 0, `S5: error toast shows failure message (${errText})`);

      // Verify More menu toggle switched OFF automatically.
      await page.locator(".review-more-trigger").click();
      const autoToggleAfterErr = page.locator('[data-usage="review.terms-auto"]');
      await autoToggleAfterErr.waitFor({ state: "visible", timeout: 10000 });
      assert.equal(await autoToggleAfterErr.getAttribute("aria-checked"), "false", "S5: toggle switched OFF after light-model failure");
      await page.keyboard.press("Escape");

      // Advance to Card 2 and answer WRONG -> card.terms must NOT be called again!
      await page.locator('[data-usage="review.next"]').click();
      await page.locator(".options .option:not([disabled])").first().waitFor({ state: "visible", timeout: 10000 });
      await page.locator(".options .option", { hasText: "副本在达成共识前可以随意丢弃事务日志" }).click();
      await page.locator(".options .option.incorrect, .next-due").first().waitFor({ state: "visible", timeout: 10000 });
      await settleAnimations(page);
      await page.waitForTimeout(300);
      assert.equal(cardTermsCalls, 1, "S5: second wrong answer does NOT call card.terms after toggle switched OFF");
      assert.equal(await page.locator(".term-strip .term-strip__candidate").count(), 0, "S5: no candidate chips after failure");
    } finally {
      await context.close();
      await running.close();
    }
  }

  // Scenario 6: Exam mode -> toggle absent, wrong answer never calls card.terms (even with autoTerms persisted ON).
  {
    const running = await startLateServer({ distDir: dist, lang: "zh", seed: (root) => seedQuizOnlyDeck(root, "zh") });
    const { context, page, errors } = await openPage(browser, running, { lang: "zh", theme: "light", width: 1280, height: 900 });
    try {
      let cardTermsCalls = 0;
      page.on("request", (req) => {
        if (req.url().endsWith("/api/call") && (req.postData() || "").includes('"card.terms"')) cardTermsCalls += 1;
      });

      await page.goto(running.server.url);
      // Persist autoTerms = ON via normal practice More menu first, without answering any card.
      await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
      await page.locator(".question-toolbar").waitFor({ state: "visible", timeout: 30000 });
      await page.locator(".review-more-trigger").click();
      await page.locator('[data-usage="review.terms-auto"]').click();
      assert.equal(cardTermsCalls, 0, "S6 setup: 0 card.terms calls before exam");

      // Navigate to Exam page and start a written mock exam.
      const examNav = page.locator('[data-tour="nav-exam"]');
      if (!(await examNav.isVisible())) {
        await page.locator('[data-tour="nav-more"]').click();
      }
      await examNav.waitFor({ state: "visible", timeout: 10000 });
      await examNav.click();
      const startExamBtn = page.locator('[data-tour="exam-start"] button.sh-btn--primary');
      await startExamBtn.waitFor({ state: "visible", timeout: 15000 });
      await startExamBtn.click();
      await page.locator(".exam-card").waitFor({ state: "visible", timeout: 15000 });
      await settleAnimations(page);

      // Toggle is absent in exam mode.
      assert.equal(await page.locator('[data-usage="review.terms-auto"]').count(), 0, "S6: autoTerms toggle absent in exam mode");
      assert.equal(await page.locator(".review-more-trigger").count(), 0, "S6: no practice More menu toggle in exam mode");

      // Pick wrong answers on exam questions and submit -> zero card.terms calls.
      const wrongOpt1 = page.locator(".exam-option", { hasText: /每次读取必须先加互斥量阻塞|副本在达成共识前可以随意丢弃事务日志/ }).first();
      await wrongOpt1.click();
      const nextExamBtn = page.locator(".exam-toolbar button.sh-btn--primary");
      if (await nextExamBtn.isEnabled()) {
        await nextExamBtn.click();
        await settleAnimations(page);
        const wrongOpt2 = page.locator(".exam-option", { hasText: /每次读取必须先加互斥量阻塞|副本在达成共识前可以随意丢弃事务日志/ }).first();
        await wrongOpt2.click();
      }
      await page.locator(".exam-foot button").first().click();
      await page.locator(".exam-report, .report-summary, [data-exam-report], h1").first().waitFor({ state: "visible", timeout: 15000 });
      await settleAnimations(page);
      await page.waitForTimeout(300);

      assert.equal(cardTermsCalls, 0, "S6: exam mode wrong answers and submission never call card.terms");
      assert.equal(await page.locator(".term-strip .term-strip__candidate").count(), 0, "S6: no candidate chips in exam mode");
      assert.deepEqual(errors, [], `S6 unexpected console/page errors: ${errors.join(" | ")}`);
    } finally {
      await context.close();
      await running.close();
    }
  }
});

async function seedCodeTermDeck(root) {
  const service = new StudyService(root);
  await service.call("snapshot");
  await service.store.update((state) => {
    state.decks.push({
      id: "d-code",
      title: "Java 字符串常量池",
      course: "Java基础",
      folder: "",
      publishedAt: "2026-10-01T00:00:00.000Z",
      cards: [
        {
          id: "c-code-1",
          kind: "quiz",
          topic: "String.intern",
          objective: "理解字符串常量池与 intern 引用语义",
          prompt: "执行 `s3.intern()` 时，常量池与堆引用如何变化？",
          options: [
            {
              id: "a",
              text: "输出 `true, true`：`s1` 首次入池将自身堆引用登记入池，而 `s4` 命中了常量池中已存在的 `\"hello\"`",
              correct: true,
              explanation:
                "JDK 7+ 常量池在堆内，首次出现的 `\"java21\"` 直接登记堆引用故 `s1 == s2`；`\"hello\"` 已在池中，故 `s3.intern()` 返回池中同引用的 `s5`。",
            },
            {
              id: "b",
              text: "输出 `false, false`：每次调用都会复制新对象",
              correct: false,
              explanation: "JDK 7+ 不会在堆中重复复制首次入池的字符串对象。",
            },
          ],
          hint: "观察 `s3.intern()` 返回的引用来源。",
          explanation: [
            "完整代码示例：",
            "",
            "```java",
            "String s3 = new String(\"hello\");",
            "String s5 = s3.intern();",
            "StringBuilder buf = new StringBuilder(\"java\");",
            "```",
          ].join("\n"),
          misconception: "把 `StringBuilder` 误认为不可变字符串。",
          citations: [],
        },
        {
          id: "c-code-2",
          kind: "flashcard",
          topic: "String.intern 复查",
          objective: "复查 intern 行为",
          prompt: "调用 `pool.intern()` 在 JDK 7+ 下返回什么？",
          answer: "如果池中已存在，则 `pool.intern()` 直接返回池中引用。",
          hint: "回忆常量池在堆内的行为。",
          explanation: "与 `s3.intern()` 相同。",
          misconception: "以为总是新建对象。",
          citations: [],
        },
      ],
    });
  });
}

test("term marking works inside inline <code> and fenced <pre><code> blocks while skipping .md-code-head", async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to look with: ${String(error.message).split("\n")[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), "study-term-marks-code-dist-"));
  await buildPreview({ outdir: dist });
  t.after(async () => {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const running = await startLateServer({ distDir: dist, lang: "zh", seed: (root) => seedCodeTermDeck(root) });
  const { context, page, errors } = await openPage(browser, running, { lang: "zh", theme: "light", width: 1280, height: 900 });
  try {
    await page.goto(running.server.url);
    await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
    await page.locator(".question-toolbar").waitFor({ timeout: 30000 });
    await settleAnimations(page);

    const termsBtn = page.locator('[data-usage="review.terms"]');
    await termsBtn.click();
    assert.equal(await termsBtn.getAttribute("aria-pressed"), "true", "marking mode enabled");

    // 1. Clicking inline <code> inside an unanswered quiz option marks it without submitting the answer.
    await clickWord(page, ".options", "s1", 0);
    assert.deepEqual(await chipTexts(page), ["s1"], "inline <code> inside unanswered option is markable");
    assert.equal(
      await page.locator(".options .option.correct, .options .option.incorrect, .next-due").count(),
      0,
      "clicking <code> inside unanswered option in marking mode does not answer the quiz",
    );
    // Click again to toggle off.
    await clickWord(page, ".options", "s1", 0);
    assert.equal(await chipStrip(page).count(), 0, "clicking marked inline <code> word toggles it off");
    assert.equal(await modeBar(page).count(), 1, "marking-mode bar returns after untoggling inline <code> word");

    // 2. Exit marking mode, answer the quiz to reveal option explanation (inside disabled option button) + fenced code block explanation.
    await page.keyboard.press("Escape");
    await page.locator(".options .option", { hasText: "true, true" }).click();
    await page.locator(".option-explanation code").first().waitFor({ state: "visible", timeout: 10000 });
    await page.locator(".explanation .md-code-block pre.md-code code").waitFor({ state: "visible", timeout: 10000 });
    await settleAnimations(page);

    await enterMarkingMode(page, termsBtn);

    // 3. Exact repro: drag substring `intern` inside inline <code>s3.intern()</code> in disabled option's explanation.
    await dragPhrase(page, ".option-explanation", "intern", 0);
    const leftoverAfterInlineDrag = await page.evaluate(() => window.getSelection()?.toString() || "");
    assert.equal(leftoverAfterInlineDrag, "", "browser selection cleared after dragging inside inline <code>");
    assert.deepEqual(await chipTexts(page), ["intern"], "dragged substring inside inline <code> added to chips");

    const internHlTexts = await highlightTexts(page, "study-term-mark");
    if (internHlTexts !== null) {
      assert.ok(
        internHlTexts.length >= 3 && internHlTexts.every((text) => text === "intern"),
        `intern highlighted across stem inline <code>, option explanation <code>, and fenced <pre><code> (${internHlTexts.join(", ")})`,
      );
    }

    // Clicking the highlighted `intern` inside <code> toggles it off cleanly.
    await clickWord(page, ".option-explanation", "intern", 0);
    assert.equal(await chipStrip(page).count(), 0, "clicking highlighted substring inside inline <code> removes it");
    assert.equal(await modeBar(page).count(), 1, "marking-mode bar returns after removing inline <code> substring");

    // 4. Drag full inline code `s3.intern()` inside option explanation.
    await dragPhrase(page, ".option-explanation", "s3.intern()", 0);
    assert.deepEqual(await chipTexts(page), ["s3.intern()"], "full inline <code> expression marked");
    const fullExprTexts = await highlightTexts(page, "study-term-mark");
    if (fullExprTexts !== null) {
      assert.ok(
        fullExprTexts.length >= 2 && fullExprTexts.every((text) => text === "s3.intern()"),
        `full inline code highlighted cleanly (${fullExprTexts.join(", ")})`,
      );
    }

    // 5. Mark inside fenced <pre class="md-code"><code>:
    //    (a) clicking `s3.intern()` inside <pre><code> toggles off the active `s3.intern()` mark
    //    (b) clicking `intern` inside <pre><code> marks `intern`
    //    (c) dragging intra-identifier substring `Builder` inside `StringBuilder` marks & highlights `Builder`
    await clickWord(page, ".explanation .md-code-block pre.md-code code", "intern", 0);
    assert.equal(await chipStrip(page).count(), 0, "clicking highlighted expression inside <pre><code> toggles it off");
    assert.equal(await modeBar(page).count(), 1, "marking-mode bar returns after untoggling <pre><code> expression");

    await clickWord(page, ".explanation .md-code-block pre.md-code code", "intern", 0);
    assert.deepEqual(await chipTexts(page), ["intern"], "clicking word inside fenced <pre><code> marks it");

    await dragPhrase(page, ".explanation .md-code-block pre.md-code code", "Builder", 0);
    assert.deepEqual(
      await chipTexts(page),
      ["intern", "Builder"],
      "dragging intra-identifier substring inside fenced <pre><code> marks it",
    );
    const afterBuilderTexts = await highlightTexts(page, "study-term-mark");
    if (afterBuilderTexts !== null) {
      assert.ok(afterBuilderTexts.includes("Builder"), "explicitly dragged intra-identifier substring inside <pre><code> is highlighted");
    }
    // Click highlighted `Builder` inside <pre><code> to toggle it off.
    await clickWord(page, ".explanation .md-code-block pre.md-code code", "Builder", 0);
    assert.deepEqual(await chipTexts(page), ["intern"], "clicking highlighted intra-identifier substring removes it");

    // 6. Clicking .md-code-lang in .md-code-head must NOT mark `java` or highlight .md-code-head.
    await clickWord(page, ".explanation .md-code-head .md-code-lang", "java", 0);
    assert.deepEqual(await chipTexts(page), ["intern"], ".md-code-head language badge stays excluded");

    // Mark `java` inside <pre><code> body -> highlights body occurrence only, never .md-code-head.
    await clickWord(page, ".explanation .md-code-block pre.md-code code", "java", 0);
    assert.deepEqual(await chipTexts(page), ["intern", "java"], "marking `java` inside <pre><code> body succeeds");
    const headHighlighted = await page.evaluate(() => {
      if (typeof CSS === "undefined" || !CSS.highlights) return false;
      const head = document.querySelector(".explanation .md-code-head");
      const hl = CSS.highlights.get("study-term-mark");
      if (!head || !hl) return false;
      return [...hl].some((range) => head.contains(range.startContainer) || head.contains(range.endContainer));
    });
    assert.equal(headHighlighted, false, ".md-code-head is never highlighted even when its language label is a marked term");

    // 7. Advance to Card 2 -> persisted `intern` paints as pale study-term-seen inside <code>, and clicking stages it.
    await page.locator('[data-usage="review.next"]').click();
    await page.locator(".flashcard").waitFor({ state: "visible", timeout: 10000 });
    await settleAnimations(page);
    const seenOnCard2 = await highlightTexts(page, "study-term-seen");
    if (seenOnCard2 !== null) {
      assert.ok(seenOnCard2.some((text) => text.toLowerCase() === "intern"), `seen term highlights inside Card 2 <code> (${seenOnCard2.join(", ")})`);
    }
    await enterMarkingMode(page, termsBtn);
    await clickWord(page, '.flip-front[aria-hidden="false"] code', "intern", 0);
    assert.deepEqual(await chipTexts(page), ["intern"], "clicking pale seen term inside <code> stages it into term strip");

    assert.deepEqual(errors, [], `code term marking unexpected console/page errors: ${errors.join(" | ")}`);
  } finally {
    await context.close();
    await running.close();
  }
});

/* Touch taps (#1759 follow-up): Chromium synthesizes a tap's click in a later task, so the click that follows the pointerup
   that marked a word must be swallowed however late it comes. TOUCH_TAP_ROUNDS raises the number of taps for a soak run. */
test("a touch tap marks a word once and the late paired click does not unmark it (#1759)", async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to look with: ${String(error.message).split("
")[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), "study-term-touch-dist-"));
  await buildPreview({ outdir: dist });
  t.after(async () => {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const lang = "en";
  const rounds = Number(process.env.TOUCH_TAP_ROUNDS) || 2;
  const running = await startLateServer({ distDir: dist, lang, seed: (root) => seedDeck(root, lang) });
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, hasTouch: true, deviceScaleFactor: 1, locale: "en-US" });
  await context.addInitScript(() => {
    try {
      localStorage.setItem("study-ui-language", "en");
      localStorage.setItem("study-theme", "light");
    } catch {
      /* storage may be unavailable */
    }
  });
  const page = await context.newPage();
  try {
    await page.goto(running.server.url);
    await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
    await page.locator(".question-toolbar").waitFor({ timeout: 30000 });
    await settleAnimations(page);
    const front = await substringSpan(page, '.flip-front[aria-hidden="false"]', "contrapositive", 0);
    await page.mouse.click(front.x, front.y);
    await waitForRevealedBack(page);
    await settleAnimations(page);
    await enterMarkingMode(page);
    const words = ["contrapositive", "linearizability", "consensus", "idempotency", "invariant"];
    const doubleToggled = [];
    for (let round = 0; round < rounds; round += 1) {
      for (const word of words) {
        const wasMarked = (await chipTexts(page)).includes(word);
        const pt = await substringSpan(page, '.flip-back[aria-hidden="false"]', word, 0);
        await page.touchscreen.tap(pt.x, pt.y);
        // Wait for the tap's own click to have come and gone (it is a later task than the pointerup), then read the result.
        await page.waitForTimeout(150);
        const nowMarked = (await chipTexts(page)).includes(word);
        if (nowMarked === wasMarked) doubleToggled.push(`${word} round ${round}`);
      }
    }
    assert.deepEqual(doubleToggled, [], "every touch tap toggles its word exactly once");
  } finally {
    await context.close();
    await running.close();
  }
});
