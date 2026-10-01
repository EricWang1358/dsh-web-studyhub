# Coaching, prepared questions, and optional autopilot

[中文](coach.zh-CN.md)

This guide describes current coaching. The optional evidence-based system-learning proposal below is not delivered. Existing automatic behavior should not be assumed to define that proposed route.

## Teaching assistance and goals

Since 1.0.0, the practice page no longer has the old coaching bar. Help after an incorrect answer uses **Help me understand**, triggered by the learner; an incorrect answer alone does not call a model. Server actions `coach.nudge` and `coach.reply` remain available only on explicit invocation.

Select goals in **Settings → Coaching**. The result summary asks whether to prepare follow-up questions when consent has not yet been provided.

## Feedback

Use 👍/👎 in the toolbar or G/B. Negative feedback opens six tags: vague prompt, poor options, too easy, too hard, wrong answer, or unclear explanation. Keys 1–6 select tags; submission occurs after 1.2 seconds without further interaction.

For content-quality tags, background repair changes only the criticized parts. Quotations must still match sources; invalid output receives one bounded correction retry. The inbox offers undo. Feedback already shown for an answered question stays unchanged; later retries/reviews use the new version.

A wrong-answer report first checks sources. If the original answer is supported, it remains unchanged with an explanation. With preparation enabled, too-easy/too-hard feedback requests a harder application question or simpler prerequisite question.

## Prepared questions and round summaries

With preparation enabled, incorrect objective answers, self-ratings below mastery, too-easy/too-hard tags, and a successful concept-only round can become variant targets. Targets batch up to four, waiting at most 20 seconds. One call creates the batch; each question is validated independently and invalid candidates are discarded. At most 12 prepared questions wait.

Code computes cognitive-level distribution, objective pass rate, self-rating attainment, weak topics, feedback, and the next step. Objective results and self-ratings stay distinct; a high objective score does not hide low self-ratings. A model supplies wording/profile updates only when consistent with the chosen recommendation. **Work on weak points first** retries this round's low-scoring questions without mixing in new ones.

The final answer prefetches a summary. Prepared questions appear in the summary, sidebar, and library banner. Starting them moves them into the system **For you** deck for normal SM-2 review.

If `consent` is unset and a model is available, the result summary asks once whether to prepare variants/application questions. Accepting calls `coach.consent {prep:true,runId}` and adds eligible round targets; declining suppresses further prompts. Change this later in Settings.

The result summary calls `coach.debrief`, cached by answered-question count and shared with prefetch. A single primary action reflects its recommendation; other continuation buttons become secondary. Sidebar and library entry points appear once at least one question is ready.

## Optional autopilot

A toggles autopilot locally in the current browser. Correct answers advance after 1.5 seconds with a progress indicator; any click or key cancels. Incorrect answers do not advance automatically.

At the end of ordinary practice, a five-second cancelable countdown follows the summary recommendation: prepared practice, continuation, or weak-point practice. Rest recommendations do not auto-act. Learning-flow, detour, and return-to-original result views omit this countdown.

## Shortcuts

`1–6` options · `0–5` self-rating · `Enter` next/submit multi-choice or cloze/flip · `Space` flip · arrows switch questions · `H` hint/explanation · `G/B` feedback · `A` autopilot · `S` resume/start study from any page · `?` shortcut reference · `Esc` close.

## Token use and stored data

Lightweight coaching uses the session model's off/none/minimal level, otherwise low. Output caps apply only when reasoning is fully disabled: coaching 450, follow-up 320, repair 1,600, variants 3,600, and summary 650 tokens. Coaching nudges use embedded answers/explanations; repairs and variants receive citation-adjacent source excerpts of roughly 5–6 thousand characters. Code verifies exact quotes.

Metrics and recommendations are computed locally. Snapshot polling uses fingerprints and returns `unchanged` when possible rather than repeatedly sending source text.

Explanation Q&A and cached suggestions persist on cards. With preparation enabled, new follow-ups can create source-validated reinforcement questions; disabling preparation does not block Q&A. Concurrent identical help requests coalesce. See [follow-ups](followup.md).

Q&A, suggestion caches, and EN translations are separate from the coaching profile and survive **Clear profile**. Coaching data is stored in the library: `learner` holds consent, goals, a profile summary of up to 400 characters, and feedback counts; `coach` retains up to 400 thread entries; `feedback` records tags; `prepared` stores unused questions. Settings let you inspect these, stop preparation, change goals, or clear the profile without deleting practice history.

APIs: `coach.nudge`, `coach.reply`, `coach.feedback`, `coach.consent`, `coach.goal`, `coach.debrief`, `coach.practice`, `coach.revert`, `coach.status`, `coach.profile`, `coach.forget`, and `coach.prepare`.

## Proposed system-learning coaching

The proposed route would reuse examples and follow-ups for minimal diagnosis → worked example → partial exercise → independent check. The learner would enter remediation explicitly, with at most three local steps within the round budget and a return to the original task. Wrong answers would not switch tasks automatically or append another round.

Hint/answer exposure would affect evidence eligibility. Understanding clicks, completed explanations, and self-ratings would not certify independent attainment. Saved learning remains available without a model; pending open grading retains submissions for retry. Existing preparation consent would not authorize a whole-source audit or external execution.

See [R5–R9 and U4–U6](https://github.com/EricWang1358/dsh-web-studyhub/blob/v2.0.3/docs/plans/2026-09-27-1945-feat-evidence-based-learning-plan.md) and the [proposed workflow](study-workflows.md#proposed-system-learning).
