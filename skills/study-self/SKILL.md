---
name: study-self
description: Build a self-study course from a goal in up to five questions — draft a custom study method for confirmation, import or draft materials, and generate the first batch of questions (一句话建一门自学课).
whenToUse: The learner wants a course built from a goal rather than from material they already imported — "help me prepare for a backend interview", "build a self-study course", "finish linear algebra in two months", 「我要准备 Java 后端面试」「帮我建一门自学课」「两个月把线代学完」 — or picks Self-study goal / 自学目标 in StudyHub's new-course page, or pastes a "Send to main chat" / 「发给主会话」 message whose id is self.start.
---

# Goal-Driven Self-Study Course Setup (一句话建一门自学课)

When a learner states a study goal (e.g. `"Backend + AI interview prep"`, `"Finish Linear Algebra in two months"`, `"Bar Exam Torts"`, or Chinese 「Java 后端 + AI 求职」), or clicks **Self-study goal (career / exams / skills)** / 「自学目标（求职 / 考证 / 自学技能）」 on StudyHub's New Course screen, turn that goal into a ready-to-use course: a **study method** (`method`, 1–12 stages the learner can see and edit), grounded materials, and the first batch of practice questions.

**Language rule:** When the learner writes in English, keep every interview option, stage name, drafted handout (`"AI-drafted · unverified"`), UI label (`Jobs`, `Sources`, `Course settings`), and closing summary in 100% natural English with zero Chinese characters. When they write in Chinese, use Chinese (labeling drafted handouts 「AI 撰写 · 未核对」).

Every workspace action below uses `study_workspace` (`action` plus `payload_json`); document imports use `study_materials` operation `document.import`. Full schemas and limits live in `library.context {"area":"guided"}`, `{"area":"imports"}`, and `{"area":"generation"}`.

## 先读一次，再问 · Read context first

1. Call `library.context {}` once to check the active course, existing courses, and whether an AI model is connected. Discuss generating questions only when a model is available; without a model, still interview the learner, create the course, and save the study method, stating clearly that question generation waits until a model is connected.
2. If the learner already shared a study plan, job description (JD), exam syllabus, or schedule, read it first and skip any interview question it already answers.
3. If a course of that name already exists, ask whether to update its study method or start fresh—never overwrite silently.

## 怎么问：最多五问，一次一个 · Interview (at most 5 questions, one at a time)

Use `ask_user_question` for **at most five questions** (最多五问), one question per turn, 2–4 options each, one line per option explaining what choosing it does. Put the recommended default first with ` (Recommended)`. **Skip any question already answered** in the learner's message or attached files, and move straight to the method draft without repeating their answers back.

1. **Goal or target role:** Why they are studying this (`Job interview / Certification exam / University course / Core foundations / Hands-on project`). Tailor stage names and materials to the exact discipline—never force a rigid template.
2. **Target date:** If they have a deadline, store it in `targetDate` (`YYYY-MM-DD`) and pace stages by date; otherwise pace weekly.
3. **Current level:** `Brand new to it / Learned partway / Solid basics, want a systematic pass`. This decides whether Stage 1 starts with `explain` or `practice`.
4. **Daily study time:** `30 minutes / 1 hour / 2 hours` (used for pacing guidance; optional in `method`).
5. **Materials on hand:** `Have slides, notes or a question bank / Only a syllabus or outline / Nothing yet`. If they have files, import them (`study-import`); if not, follow the **Course materials** section below.

## 学法草稿：先给他看，再存 · Draft the study method before saving

Design a flexible 3–5 stage sequence (limit: 1–12 stages) tailored to the subject and goal:

- `name`: Plain, concrete stage title (`<= 40` chars), e.g. `"Vector spaces & linear maps"` or `"Concurrency & JVM internals"` (Chinese e.g. 「把 Java 集合和并发过一遍」).
- `activity`: Primary stage activity — `publish` (for importing materials only; auto-advances once imported — **never mark substantive Stage 1 learning as `publish`**, 不要把第 1 阶段实质内容标成 `publish`; pick `explain` or `practice` based on Q3) / `practice` / `review` / `explain` / `check` / `project`.
- `alternatives`: Up to 2 optional alternative activities.
- `level`: Stage gate strictness — `loose` (~80% attempted) / `medium` (~80% correct) / `strict` (100% correct).

Summarize the draft in **one sentence** (what Stage 1 does, how many stages total, target date) and ask: `"Start with this study method, or adjust any stage first?"` (Chinese: 「照这个学法开始，还是先改哪一段？」). Save **only after** the learner confirms (没确认之前不生成、不存):

`course.save {"name": "<课程名>", "method": {…full method object…}}`
`focus.set {"mode": "class", "course": "<课程名>"}`

Keep the learner's own course title; send the complete `method` object (`1–12` stages, each `name <= 40` chars, optional `targetDate`); if `course.save` rejects a field, fix it and save again.

## 资料 · Course materials

1. **Learner has materials:** Help import them (`study-import`), keep the relevant scope, and check alignment with `course.outline`.
2. **Missing materials for Stage 1:** Draft a well-structured Markdown study guide under `studyhub-work/` in the learner's language, and import it via `study_materials` operation `document.import` with `provenance: "ai-drafted-unverified"` (or `source.add` with `provenance: "ai-drafted-unverified"`), labeling its title and provenance honestly as `"AI-drafted · unverified"` in English or 「AI 撰写 · 未核对」 in Chinese.
3. **Never generate ungrounded questions (不做无资料生成):** If a stage has zero verifiable sources, do not call `generate`; tell the learner `"This stage has no material yet: import a file, or ask me to draft study notes"` (matching the card badge `"No material yet · Import, or ask main chat to draft"` / 「还没有资料 · 导入，或请主会话起草」).

## 第一批题 · First batch of questions

Generate questions **only for Stage 1's scope**: `generate {"course": "<course>", "sourceIds": [...], "count": <n>, "kind": "quiz", "language": "en"}` (use `"zh"` for Chinese courses; adjust `kind` to fit the subject; see `library.context {"area":"generation"}`). Progress appears in **Jobs** (`任务`), and finished questions land as a draft for review before publishing: tell the learner `"Your first batch of questions is generating into Drafts—review and publish it in StudyHub to start practising, then come back when you're ready for the next stage."`

## 收尾 · Wrap-up

Back on StudyHub's home screen, the new course shows `"Method · Stage 1"` (`学法 · 第 1 阶段`) and `"Start stage ①"` (`开始第 ① 阶段`), with the full method editable in **Course settings**. Report three things briefly in the learner's language: the course name, the number of stages, and that the first question batch has started (or that the course is ready while waiting for a model). Never answer cards on the learner's behalf or claim a stage is already completed.

## 边界 · Boundaries

- Never guess the goal, deadline, or starting level—ask one short question when unclear.
- Keep provenance honest: never present `"AI-drafted · unverified"` / 「AI 撰写 · 未核对」 notes as the learner's own textbook or slides.
- Every stage remains editable via `course.save` whenever the learner asks.
- Generate or save nothing before explicit confirmation (没确认之前不生成、不存).
- Before any permanent delete or archive, ask the learner first, in ONE sentence that says what goes and what stays, and act only on a clear yes. (永久删除或归档任何东西之前，先用一句话问学习者：什么会没有，什么会留下；得到明确的「好」再动手。)
