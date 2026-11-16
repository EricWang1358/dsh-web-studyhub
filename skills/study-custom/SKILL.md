---
name: study-custom
description: Customise how to study a large textbook in StudyHub — interview the learner on purpose, chapter scope, review-book sections, question types and study plan before generating only what they chose (深度定制).
whenToUse: The learner wants a big book customised — "customise how I study this book", "I only need the exam chapters", "only build a cheat sheet", 「深度定制」「这本书我只想学考试范围」「复习全书只要速查」「帮我定制一下怎么学这本书」 — or pastes a "Send to main chat" / 「发给主会话」 message whose id is custom.start (from a long document's row, or from the review book's More / 更多 menu).
---

# Custom Study Plan for a Large Book: Ask First, Generate Only What Was Chosen (深度定制)

Not every part of a thick textbook needs a review book or hundreds of questions. Interview the learner with a short sequence of option cards, save their choices as the course's **custom plan** (`custom`), and start only what they ticked. **Nothing is generated and nothing is saved before the learner confirms** (确认之前不生成任何东西，也不存任何东西).

**Language rule:** If the learner writes in English, run the entire interview, option labels, cost updates, the post-confirmation apply step (`"language": "en"`), and closing summary in 100% natural English with zero Chinese characters or `「…」` quotes. Otherwise default to Chinese.

Every action below runs through `study_workspace` (`action` plus `payload_json`). Full schemas and limits: `library.context {"area":"custom"}`, `{"area":"book"}`, `{"area":"generation"}`, `{"area":"plan"}`.

## Read Once Before Asking

1. `library.context {}`: check the active course, course list, and whether an AI model is available. If the course is missing or ambiguous, ask one short question instead of guessing.
2. `course.get {"name": "<course>"}`: check whether the course already has a saved `custom` plan.
3. `course.custom.preview {"course": "<course>"}`: read-only, zero model calls. Inspect `skeleton` (materials, chapters, page ranges—use its exact chapter titles), `defaults` (per-purpose defaults), `estimate` (model calls and read tokens), and `saved`. When the hand-off names a document `key`, find it in `skeleton.documents` and open with one sentence: `"This book has N pages across M chapters."`
4. If no model is connected, run the interview and save the plan anyway, explaining clearly that nothing can be generated until a model is set up.

## How to Run the Interview

- Ask **one question at a time** (一次只问一个问题) via `ask_user_question`, with **2–4 options** (2–4 个选项) per question, one line per option stating **what it does · what you get**. Never bundle multiple questions into one call.
- Put the default as the **first option** (第一个选项) suffixed with ` (Recommended)`. After Question 1, defaults come from `defaults[purpose]` (or `filled` returned by `course.custom.preview` with partial `custom`).
- Pass `"multiSelect": true` for multi-choice questions (Q3 parts, Q4 question kinds). If the host rejects `multiSelect` or returns only one selection, switch to numbered plain-text choices (`"1 Explanations  2 Term cards & confusables  3 Answer kit & cheat sheet  4 Formulas & index"` — reply `"1 2"` or `"default"`).
- Skip any question the learner already answered in one message (e.g. `"Final exam revision, whole book, quiz questions, schedule by exam date"`).
- After each answer, re-read `course.custom.preview {"course": "<course>", "custom": {…choices so far…}}` (`filled` completes unset fields from `defaults[purpose]`) and state in **one sentence** how the estimate changed (`"+/- N model calls, ~X read tokens"`; mention `"rough estimate"` when `estimate.rough` is true). Report calls and tokens only—**never prices** (只说调用次数和 token，不说价格).
- Keep the tone direct and matter-of-fact (in Chinese use 「你」, never 「您」).

## 问题 1 · Question 1: What are you using this book for?

Options (`custom.purpose`):
- **Preview — skim the big picture** (`"preview"`, 预习)
- **Follow lectures — chapter by chapter** (`"follow"`, 跟课学)
- **Final exam revision — cover the whole book** (`"review"`, 期末复习)
- **Open-book quick reference — bring into the exam** (`"openbook"`, 开卷考试)

## 问题 2 · Question 2: Which content should we cover?

Options (`custom.scope.kind`):
- **Whole book** (`"all"`, 全书)
- **Exam scope only** (`"exam"`, 考试范围) — ask the learner to paste the syllabus/scope note or share scope slides/screenshots; import and merge into `focusTopics` following skill `study-import`, then store the source title in `scope.note` with `scope.kind: "exam"`.
- **Pick specific chapters** (`"chapters"`, 挑几章) — list numbered chapter titles from `skeleton` (up to 40 first, noting the rest can be chosen by number) and accept ranges like `"Ch. 3–7"`, `"1,4,9"`, or `"Part II"`; store resolved chapter IDs in `scope.chapters` (ask if ambiguous).

## 问题 3 · Question 3: Review book sections

Ask in up to three sequential steps on the same topic:
1. **Build a review book?** (`Yes` / `No`). If `No`, set `book.make: false` and move to Q4.
2. **Which sections?** (`multiSelect: true`, written into `book.parts`):
   - **Explanations** (`explain`)
   - **Term cards & confusable concepts** (`terms`, `confusables`)
   - **Answer templates & cheat sheet** (`answerKit`, `cheatSheet`)
   - **Formula sheet & lookup index** (`formulas`, `index`)
   *(Finer splits like `terms` without `confusables` can be typed in Other.)*
3. **Explanation depth** (only if `explain` is included, written into `book.coverage`): **Brief** (`"brief"`) · **Standard** (`"standard"`) · **Full** (`"full"`).

## 问题 4 · Question 4: Practice questions

1. **Generate practice questions?** (`Yes` / `No`). If `No`, set `questions.make: false` and move to Q5.
2. **Question types** (`multiSelect: true`, written into `questions.kinds`): **Single-choice** (`quiz`) · **Multiple-choice** (`multi`) · **Fill-in-the-blank** (`cloze`) · **Open-ended** (`open`); learner may also request `flashcard`, `truefalse`, or hands-on `task` in Other.
3. **Coverage strength** (`questions.strength`, showing `~estimate.questions.count` next to each): **Lean** (`lean`) · **Standard** (`standard`) · **Full** (`full`).
4. **Auto-prepare variants for mistakes in this course?** (`Yes` / `No`, written into `questions.variants`).

## 问题 5 · Question 5: Study schedule

Options (`custom.plan`):
- **Schedule by exam date** (`"by": "exam"`, requires course exam date)
- **Schedule by chapters per week** (`"by": "weekly"`, works without an exam date)
- **No schedule** (`plan.make: false`)

If enabled, ask daily study minutes (`30` / `60` / `120` or custom -> `plan.minutesPerDay`), and for `"weekly"` ask chapters per week (`1` / `2` / `3` or custom -> `plan.chaptersPerWeek`).

## 问题 6 · Question 6: Summary & confirmation

Summarize in at most 8 lines: purpose, chapter scope, review-book sections & depth, question types & strength, schedule, and `estimate.total` (calls + tokens). Then ask:
- **Build a small sample first (Recommended)** (`sampleFirst: true`, 先做一个样例看看): writes a 2-point review-book sample and the first round of the first chapter group, then waits for your go-ahead.
- **Build everything now** (`sampleFirst: false`, 直接全部做).
- **Trim it down** (再精简一些): revisit Q3–Q4 to drop sections or lower question volume, then re-summarize and confirm.

## 确认之后 · After confirmation: save, then apply once

1. **Save:** Call `course.get` first to preserve existing fields, then `course.save {"name": "<course>", "custom": {…complete custom object…}}` (`custom: null` deletes only on explicit request).
2. **Apply once (只调用一次):** Call `course.custom.apply {"course": "<course>", "language": "en"}` (use `"language": "zh"` when chatting in Chinese) **once**—do NOT manually invoke `generation.courseBook.build` or `generate` for the runs, and do not call `apply` repeatedly. Summarize the returned buckets using each item's localized `what` text:
   - `started`: background jobs started now (review book, per-chapter-group question runs with `jobId`, saved study plan).
   - `waiting`: what did not start and why (no model, sample waiting for review, stale chapter IDs, max 12 concurrent question groups, missing exam date) plus what the learner should do next.
   - `recorded`: choices只记在定制方案里 that no backend job enforces yet—**never claim they were executed** (不要说已经做了).
   - `done`: items already completed or active (existing book/questions/plan, variants toggle).
3. **Continuing after sample (`sampleFirst`):** Once the learner inspects the sample and says `"finish the rest"` / `"go ahead"` (or Chinese 「做完」), call `course.custom.apply {"course": "<course>", "confirm": true, "language": "en"}` (or `"zh"`). Never pass `confirm: true` before they ask.
4. **Missing outline:** If `waiting` says a fresh course outline is required first (`skeleton.basis` is `"documents"`), run `generation.courseOutline.build {"course": "<course>"}`, inspect top-level chapters with `course.outline {"course": "<course>"}`, map `scope.chapters` by title and page range (flagging any unmatched chapter honestly), `course.save`, and call `course.custom.apply` once more.
5. **Term & confusable cards:** Once the review book finishes writing, run `generation.courseBook.build {"course": "<course>", "cards": true}` (preview with `estimate: true` first).
6. **Detailed study plan:** `"weekly"` plans are saved directly by `apply`; `"exam"` plans save a baseline schedule (or wait in `waiting` until the exam date is set in Course settings). For multi-phase schedules and mock dates, draft with `course.plan {"course": "<course>"}` per `library.context {"area":"plan"}` and save only after agreement.
7. **Background jobs:** Check once with `job.status {}` when asked; never loop-wait or promise proactive push updates between turns.

## How Question Scope Works

`course.custom.apply` scopes question runs strictly to the selected chapters' pages and `questions.kinds` (mixed in one run per chapter group, up to 500 questions per run across multiple groups so large books are never capped at 500). Unpaged single-text sources are read whole and reported honestly in `recorded`.

## 只记录 · Recorded-only choices

- Choices returned in `recorded` are stored in the custom plan (`只记在定制方案里`) without chapter-filtering enforcement: **Exam scope (`scope.kind: "exam"`, 考试范围)** currently builds across the whole course rather than slicing chapters from free-text scope notes. Review-book `parts`, by contrast, ARE honoured directly (unticked parts are skipped).
- State clearly at the end what has started running vs what is recorded only—**never say recorded-only items were built** (不要说已经做了).

## 已有定制 · Updating an existing custom plan

When the course already has `custom` (已有定制, in the hand-off or `course.get`), **do not re-run the whole 6-question interview from scratch** (不要把整套访谈再问一遍):
1. Summarize the current plan in one sentence (purpose, scope, book parts, questions, schedule).
2. Ask one question: **What changed?** (`Purpose changed` · `Added new materials` · `Add/remove chapters` · `Something else`).
3. Re-ask only the affected questions, preview `course.custom.preview`, confirm, `course.save`, and call `course.custom.apply` once (completed/running work is never duplicated).

## Boundaries

- Note honestly that generated explanations and variants are AI-written and can contain mistakes (可能有错); every answer carries source citations and page numbers (页码) to verify against the original.
- Present costs and trade-offs clearly and let the learner choose.
- Before any permanent delete or archive, ask the learner first, in ONE sentence that says what goes and what stays, and act only on a clear yes. (永久删除或归档任何东西之前，先用一句话问学习者：什么会没有，什么会留下；得到明确的「好」再动手。)
- Never comment on study streaks or usage time.
- Match the learner's language (`English` when they write English, Chinese otherwise). End with one concise sentence stating what is running and what is waiting (结束时用一句中文说明现在在跑什么、在等什么；English if the learner writes English).
