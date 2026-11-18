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
import { launchChromium } from "../scripts/qa/browser.mjs";
import { openPage, settleAnimations, startLateServer } from "../scripts/qa/layout-late.mjs";

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

const highlightCount = (page) =>
  page.evaluate(() => (typeof CSS !== "undefined" && CSS.highlights ? CSS.highlights.get("study-term-mark")?.size || 0 : -1));

const covers = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

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
        await page.locator('.flip-back[aria-hidden="false"]').waitFor({ timeout: 10000 });
        await settleAnimations(page);
        assert.equal(await page.locator(".term-strip").count(), 0, `${tag}: no chips before marking`);

        // 2. Enter marking mode: click word on back -> chip appears -> click again -> disappears.
        await termsBtn.click();
        assert.equal(await termsBtn.getAttribute("aria-pressed"), "true", `${tag}: button reports aria-pressed=true`);
        assert.equal(await page.locator(".review-body.is-marking").count(), 1, `${tag}: .review-body.is-marking set`);

        const backSel = '.flip-back[aria-hidden="false"] .flash-prompt';
        const toggleWord = lang === "en" ? "contrapositive" : "权衡";
        await clickWord(page, backSel, toggleWord, 0);
        assert.deepEqual(await chipTexts(page), [toggleWord], `${tag}: clicked word appears in chip bar`);
        const expectedHl = lang === "en" ? 2 : 1;
        const hl = await highlightCount(page);
        if (hl >= 0) assert.ok(hl >= expectedHl, `${tag}: highlight spans all occurrences (${hl})`);

        // Click again (on 2nd occurrence in EN, same word in ZH) -> toggles off.
        await clickWord(page, backSel, toggleWord, lang === "en" ? 1 : 0);
        assert.equal(await page.locator(".term-strip").count(), 0, `${tag}: clicking marked word cancels it`);

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
        await page.keyboard.press("Space");
        await page.locator('.flip-front[aria-hidden="false"]').waitFor({ timeout: 10000 });
        assert.equal(await termsBtn.getAttribute("aria-pressed"), "true", `${tag}: Space keeps marking mode active`);
        await page.keyboard.press("Space");
        await page.locator('.flip-back[aria-hidden="false"]').waitFor({ timeout: 10000 });

        await page.keyboard.press("Escape");
        assert.equal(await termsBtn.getAttribute("aria-pressed"), "false", `${tag}: Escape exits marking mode`);
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
        await page.locator(".prereq-strip summary > span").click();
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
        await page.locator(".prereq-strip summary > span").click();

        // Advance to Card 2 (quiz) to verify option click interception + per-question term memory.
        await page.locator(".grade-scale .grade").nth(4).click();
        await Promise.race([
          page.locator(".options .option:not([disabled])").first().waitFor({ timeout: 15000 }),
          page.locator('[data-usage="review.next"]:not([disabled])').waitFor({ timeout: 15000 }).then(() =>
            page.locator('[data-usage="review.next"]').click(),
          ),
        ]);
        await page.locator(".options .option:not([disabled])").first().waitFor({ timeout: 15000 });
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
        await page.locator(".prereq-strip summary > span").click();
        assert.equal(
          await page.locator(".prereq-strip .prereq-item").count(),
          2,
          `${tag}: 2 marked words created 2 direct prerequisite check cards on Card 2`,
        );

        // Moving back to Card 1 (flashcard) restores Card 1's 3 marked terms from memory.
        await page.locator('[data-usage="review.prev"]').click();
        await page.locator(".flashcard").waitFor({ timeout: 10000 });
        await page.locator(".term-strip").waitFor({ timeout: 10000 });
        assert.equal((await chipTexts(page)).length, 3, `${tag}: returning to Card 1 restores its marked words`);

        assert.deepEqual(errors, [], `${tag}: unexpected console/page errors: ${errors.join(" | ")}`);
      } finally {
        await context.close();
        await running.close();
      }
    }
  }
});
