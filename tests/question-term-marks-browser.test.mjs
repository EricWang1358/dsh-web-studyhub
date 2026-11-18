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
import { previewCall } from "../scripts/preview-server.mjs";
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

const highlightCount = (page, name = "study-term-mark") =>
  page.evaluate((hlName) => (typeof CSS !== "undefined" && CSS.highlights ? CSS.highlights.get(hlName)?.size || 0 : -1), name);

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
        await page.locator('.flip-back[aria-hidden="false"]').waitFor({ timeout: 10000 });
        await settleAnimations(page);

        const termsBtn = page.locator('[data-usage="review.terms"]');
        await termsBtn.click();
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
        await page.locator(".grade-scale .grade").nth(4).click();
        await Promise.race([
          page.locator(".options .option:not([disabled])").first().waitFor({ timeout: 15000 }),
          page.locator('[data-usage="review.next"]:not([disabled])').waitFor({ timeout: 15000 }).then(() =>
            page.locator('[data-usage="review.next"]').click(),
          ),
        ]);
        await page.locator(".options .option:not([disabled])").first().waitFor({ timeout: 15000 });
        await settleAnimations(page);

        assert.equal(termsGetCalls, 1, `${tag}: round cache prevents refetching course.terms.get on Card 2`);
        assert.equal(await page.locator(".term-strip").count(), 0, `${tag}: term strip does not auto-open for seen terms`);
        const seenHl = await highlightCount(page, "study-term-seen");
        const activeHlBefore = await highlightCount(page, "study-term-mark");
        if (seenHl >= 0) {
          assert.ok(seenHl >= 1, `${tag}: pale study-term-seen highlight paints seen unknown word on Card 2 (${seenHl})`);
          assert.equal(activeHlBefore, 0, `${tag}: active study-term-mark is empty before clicking`);
        }
        await takeShot(page, `term-seen-${lang}-${width}`);

        // 3. Enter marking mode on Card 2 and click the pale-highlighted word -> enters term strip!
        await termsBtn.click();
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
