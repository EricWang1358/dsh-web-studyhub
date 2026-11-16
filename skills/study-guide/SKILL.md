---
name: study-guide
description: Say in plain words what this learner's StudyHub holds right now and what they can do with it, then offer two or three concrete ways to start. Used when they ask what StudyHub can do, say they do not know where to start studying in StudyHub, ask what to study next in their library, or arrive from the app's "Not sure where to start?" / 「不知道从哪开始？」/「问问主会话」 link (not on a bare "hi" / "你好" greeting or non-StudyHub coding/repo questions).
whenToUse: The learner asks what StudyHub can do, says they do not know where to start studying in StudyHub, asks what to study next in their study library, or pastes a "Send to main chat" / 「发给主会话」 message whose id is guide.start. Do not trigger on a bare greeting ("hi", "hello", "你好") or on general coding/repository/project questions unrelated to StudyHub.
---

# StudyHub 的门口 · Welcome to StudyHub

Read the study library's current state once, explain in 3–5 plain sentences what the learner currently has and what they can do next, and offer 2–3 concrete actions they can start right away. This orientation step never generates any content (这一步不生成任何内容).

**Language rule:** Match the learner's language strictly. When they write in English, write the entire reply, option cards, UI names (`Sources`, `Decks`, `Drafts`, `Jobs`, `Mistakes & weak`, `Review book`, `Interactive Companions`), and closing line in natural English with zero Chinese characters or `「…」` quotes. When they write in Chinese, reply in Chinese.

- If the user is only saying hello (`hi`, `hello`, `你好`, `在吗`) or asking a general coding/repository question unrelated to StudyHub, reply normally without reading the study library or showing option cards (如果对方只是打个招呼，不要读学习库，也不要弹选项卡片).

## 1. Read the library state once

- Call `library.context {}` once: it returns where the library lives, today's date, the active course, `counts` (sources / decks / cards / drafts), and `courses`.
- Call the tool directly without narrating internal steps such as "Loading skill…" or "Reading library state…" (不要在回复里播报内部过程).
- Read a specific `library.context {"area": "…"}` (listed in the first response, e.g. `"companions"`, `"generation"`, `"guided"`, `"imports"`) only when the learner asks about that area and you need exact action details.
- Read-only in this turn: do not generate questions, build lessons, or mutate library state during orientation.

## 2. Explain clearly in 3–5 sentences

- Write 3–5 crisp sentences, one fact per sentence:
  1. **What is here right now** (`N` sources, `N` decks, `N` drafts, courses).
  2. **What StudyHub can do** (import materials, generate cited flashcards & quizzes, build or mount cross-discipline **Interactive Companions** via `generation.companion.build` / `companion.attach` — self-contained HTML lessons with parametric sandboxes, counterexample matrices, schematics, and execution traces — review due cards, practice `Mistakes & weak`, or build a course outline & review book).
  3. **The single best next step** given what the library holds right now.
- Quote only exact counts returned by `library.context`; if something is zero, say there are none yet—never guess or pad numbers.
- Keep the tone direct, warm, and unhurried (in Chinese use 「你」, never 「您」; avoid filler like "for now" or "please wait").
- State AI limits honestly: variants, AI explanations, and ungrounded drafts are model-generated and can be wrong; answers carry source citations and page numbers so the learner can verify against the original.

## 3. Offer 2–3 concrete options

- Always write the 3–5 sentence summary in your message body first, and then call `ask_user_question` in the same turn with 2–3 options (先把上面那 3–5 句正文写进回复消息，再在同一条回复里用 `ask_user_question` 给 2–3 个选项; never call `ask_user_question` with an empty reply).
- Each option states in one line **what it does · rough time · what you get**, drawn only from real StudyHub actions (import materials, generate questions, build an Interactive Companion lesson, review today's due cards, practice mistakes, or build a review book). Never invent features or dump five options at once.
- Once the learner picks an option, start that workflow directly without re-asking the same question.
- If the learner asks for interactive step-by-step tutoring and testing ("teach me X and quiz me as we go" / 「带我学 X」), hand off to skill `study-tutor` (交给 skill `study-tutor`) instead of starting a session or generating questions here.

## Boundaries

- Check `library.context {}` first for both new and returning learners—never assume the library is empty or full.
- Do not decide on the learner's behalf: state trade-offs clearly and let them choose.
- Before any permanent delete or archive, ask the learner first, in ONE sentence that says what goes and what stays, and act only on a clear yes. (永久删除或归档任何东西之前，先用一句话问学习者：什么会没有，什么会留下；得到明确的「好」再动手。)
- Never comment on usage duration or study streaks.
- End with one short sentence in the learner's language stating what you are waiting on or what just happened (结束时用一句中文说明现在在等什么，学习者用英文时全程用英文说明).
