# Question generation and quality checks

[中文](assessment-quality.zh-CN.md)

This page explains which checks run when StudyHub writes questions from your sources, what publishing a draft does and does not check, and where the limits are.

In short:

- **Generate from sources** (on the **Create deck** page) runs every question through evidence extraction, answer preparation, writing with a self-check and one independent review. Only questions that pass reach the draft.
- **Save & publish** on the draft page publishes at once with structural checks only. It does not wait for a model review. Questions without a current review record are marked **Not automatically reviewed**.
- [JSON decks you import](json-import.md) and questions saved through `ingest` do not go through this pipeline.
- A passed review does not prove a question is factually correct. Check the sources before you rely on it.

## How generation works

The pipeline covers **Quiz + flashcards**, **Single choice**, **Multiple choice**, **Flashcard**, **Open response** and **Fill in the blank**, including questions written from converted PDFs. **Case paper** has its own workflow, which this pipeline does not change.

StudyHub splits a request into batches of up to 5 questions by default. Knowledge extraction runs once for each group of selected pages. After that, up to 3 batches run at the same time by default. Adjust [question defaults and generation pace](generation-agents-sidebar.md#what-a-generation-task-does) in **Settings › Question defaults**.

1. **Extract knowledge points.** The model finds valuable facts, rules, mechanisms or boundaries and quotes the passages that support them, word for word. It does not design questions, scenarios or distractors at this stage. Code confirms that every quote exists in the selected sources before any later stage uses it. If the sources support fewer points than you asked for, the valid ones are kept: the requested count is a ceiling, not a quota.
2. **Prepare answers.** For each verified point, the model first gives a concrete answer and a derivation that can be checked. Then it adds the scenario conditions the question needs, plus the options, rubric or blanks for the question type. A constructed scenario must state its assumptions and must not invent subject-matter facts. If an application is not supported, it is narrowed to a supported recall question or dropped. Code checks the answer structure before writing starts.
3. **Write and self-check.** One author call writes the stem, hint and explanation and revises them. Each question must name the verified point it tests. Code then copies that point's objective, citations, answer and scoring fields onto the question; a missing, unknown or duplicate link fails. Code also checks structure, citation locations, answer leakage and whether the learner can see all the context the question needs.
4. **Review independently.** A separate call sees the material, the knowledge points, the answer plans and the candidate questions. It checks each question for self-contained context, answer leakage, option quality, learning value, evidence support and explanation quality. It also checks that the cited passage really supports the answer and the decisive scenario conditions. An explanation must show how the conditions lead to the answer and where the common mistakes lie. Restating the answer, or option notes that only say true or false, fails. A question without a complete check record, or with any failed dimension, does not pass.
5. **Keep what passed.** Only accepted questions stay. Reasons for omitted points and rejected candidates are recorded.

Answer preparation, writing and independent review share clear-expression guidance for Chinese, English and bilingual content. They prefer short, direct sentences, explicit conditions, stable technical terms and comparable option wording. Explanations connect the conclusion to the cited rule, scenario conditions and relevant mistakes. Negation, exceptions, units and necessary reasoning take priority over brevity. Quotes stay verbatim, and writing or reviewing cannot replace verified answer fields. This borrows clarity principles from controlled technical writing; it does not impose the ASD-STE100 English dictionary or hard word limits. It adds no model call and does not guarantee factual correctness or a higher acceptance rate.

Rules that hold across these stages:

- The author's self-check is never an approval. Only the independent review approves a question.
- A defect counts against the question it belongs to. A batch-level problem that cannot be pinned on a question is not ignored.
- If the author's JSON is damaged, complete questions recovered from it still need the independent review.
- Neither normal generation nor [supplementation](supplementation.md) repairs questions automatically, reviews them a second time or writes extra questions to reach the requested count. An unreadable or incomplete review is a protocol failure, not a reason to review again.
- If you turned on the experimental Jev review replacement (off by default), Jev may judge some candidates in place of the model review, and the draft records which ones. See [Jev](jev-experimental.md).

### Model calls

| Stage | Calls | Retries |
| --- | --- | --- |
| Extract knowledge points | 1 per page group | 1 correction; valid points are kept |
| Prepare answers | 1 per batch | 1 correction; valid items are kept |
| Write and self-check | 1 per batch | 1 retry for malformed JSON; complete questions are recovered from damaged output |
| Independent review | 1 per batch | None |

Extraction and answer preparation also re-ask once when a reply is not JSON at all.

### What the draft records

- The knowledge points, answer plans, reasons for omissions, the author's revisions and each question's review record.
- **Source coverage**: for each selected source, how many targets were planned and how many questions passed. Questions from a source do not mean the whole page or every point on it is covered.
- A batch that fails does not discard the questions from batches that passed.

### Progress and notifications

The job record shows each stage. Where DSH supports native subagents, the stages appear as subagents; otherwise the record shows the direct model calls (see [Background tasks](generation-agents-sidebar.md)). Stage output stays inside StudyHub. The main chat gets one final notification instead of stage JSON.

### Time limits

- Each generation-stage call: 10 minutes, whether it runs as a direct call, a one-shot subagent or a communicating subagent. Ordinary teaching calls keep their own limits.
- A whole generation job: 20 minutes of running time by default, adjustable to 5–60 minutes in **Settings › Question defaults**. Time waiting in the queue does not count. Questions that already passed are kept.
- A timeout is not a quality rejection, and it does not guarantee the requested count.

In supplementation, when the time budget runs out, saved questions whose review records are still valid can be published without another model call. The job reports the shortfall. Cancellation, version conflicts, an archived target deck and later edits still block publishing the affected questions.

## Publish a draft

Each generated question stores a fingerprint of the content that was reviewed. Editing the question invalidates that review, and the draft shows **Not automatically reviewed** for it. Incomplete questions can stay in the draft; **Save & validate** saves without publishing.

### Quick publication (the default)

The draft page's main button is **Save & publish**. It reads **Save & update deck** when you edit a deck, and **Save & add to original deck** after a repair. Clicking it:

1. saves the draft and checks its structure question by question;
2. publishes every question, without a model review;
3. marks questions without a current review record **Not automatically reviewed**;
4. opens a practice round of up to 10 new questions from the deck.

Questions with structural problems still publish. During practice they carry a **Needs verification** mark that lists the problems and offers **Send for background repair**. A question with nothing to grade can be skipped without recording a result.

### Reviewed publication

[Supplementation](supplementation.md) always publishes this way, and the main chat can use it for a draft (`draft.publish`). It runs these checks:

- **Local checks first**: structure, duplicates within the draft and against the target deck, dependence on slides or notes the learner cannot see, stems that ask what the source says, explanations that only repeat the answer, and answers leaked in the topic or hint.
- **Then an independent review** of every question that is new, edited or has no review record, in groups of 5. If a group's review raises a problem it cannot pin on one question, or the group request fails, the questions are reviewed one at a time, so one question cannot hold back the rest.
- Accepted questions publish. Questions with confirmed defects stay behind in a draft of pending questions, linked to the published deck.
- If one question's review request fails, its review is incomplete. A structurally valid question then publishes with **Not automatically reviewed**. In supplementation it is not added; it stays in the draft.
- Without a model, publication still works. The number of unreviewed questions is shown and kept. Running reviewed publication again once a model is available completes the review.

### Background repair

A draft with pending questions offers **Send for background repair**. It fixes the questions one at a time:

- Each question gets a repair call that uses only its sources, then the local checks, then an independent review. If either finds a problem, the question gets one more attempt with those specific problems, and the second version also needs the review. A question that still fails stays in the draft.
- Sources come from the question's own citations. Without citations, the repair uses the sources the draft was generated from or, if your library has only one source, that source. If none applies, add a citation first.
- The repair sees the target deck's existing questions and must not duplicate an objective or a stem.
- Save first: the button is disabled while the draft has unsaved edits. Saving a pending question you edited by hand clears its earlier failure; the new content is checked when you publish.
- **Stop repairs & keep draft** stops the job and keeps the questions already fixed. Repairs have the same 20-minute limit.
- When it finishes, click **Save & add to original deck** (or **Save & update deck** for an edited deck) to publish the accepted questions.

Reviewed publication and repair are separate from the one-round generation policy above. Quick publication does not wait for either.

## What the checks look for

The rules come from real failures:

- distractors on a different axis from the correct answer, or plainly absurd ones;
- answers given away in the stem, topic or hint;
- questions that depend on a slide, diagram, recording or notes the learner cannot see;
- questions about where something sits on a diagram;
- stems that ask what the material, text or notes say instead of testing the concept;
- distinctions the source does not support, dressed up as application questions;
- explanations that only restate the answer.

A short foundational flashcard can stay a simple recall question; it does not need an invented scenario. PDF text positions do not prove what a diagram means.

## Answer hiding and imported questions

- Before you answer, the question data sent to the panel leaves out the learning objective and rubric, because they could reveal the answer. Both stay stored; the rubric is shown after you reveal the answer.
- `ingest` keeps the wording of existing questions and does not rewrite them. Do not write questions in the conversation and save them with `ingest` to skip these checks.
- Updating StudyHub never rewrites questions you already have. Fix them one by one if needed.

## Explain more clearly

After you reveal an explanation, **Explain more clearly** next to **Ask a follow-up?** asks for a fuller explanation and saves it on the question as a follow-up answer. It does not wait for suggested follow-ups and does not change your review progress. If the evidence is thin or the original question is wrong, the new explanation must say so instead of inventing reasons for the answer. See [Follow-up questions](followup.md).

## What has been verified

Automated tests cover stage order, quote checks limited to the selected sources, stable target binding, answer preparation, context checks, per-question review records, explanation quality, keeping accepted subsets, protocol failures, cancellation and answer hiding. The model outputs in these tests are scripted. Browser tests cover the explanation and retry interactions.

No first-pass success rate with a real model has been measured for this workflow. Neither the tests nor the independent review prove factual correctness or real teaching effectiveness.

## History

- **2026-09-14.** Three generation runs had stopped at about 180 seconds, each time from the generation stage's own timeout. Generation calls now have a 10-minute limit, the same for one-shot subagents, communicating subagents and direct calls; ordinary teaching calls are unchanged. A timeout is not treated as a quality failure. At that time, reviewing a repaired subset cost at most one extra model call and still did not guarantee the requested count.
- **2026-09-20.** A repairer's own approval stopped counting; review records moved to version 3 and must include `explanationQuality`. Generation started rejecting explanations that only repeat the answer. The independent review now receives the requested role, difficulty and focus. Old questions are not rewritten automatically; after revealing an explanation, **Explain more clearly** writes and saves a supplementary explanation. Verification at the time: two regression tests failed before the fix and passed after it; 218 automated tests, the build and ESLint on the changed files passed; a 360 px browser check covered direct re-explanation, error messages, a successful retry and no horizontal overflow, using stubbed replies rather than real teaching samples. No blocking defect was found; teaching quality with real models and real weak questions had not been evaluated. These changes shipped in 0.9.0.

The Chinese page keeps the full verification record.

## Planned: curriculum coverage and learning evidence (not built)

A valid question, complete coverage of the material and a learner's competence are three separate conclusions. A question that passed review does not prove the course has no gaps, or that you can transfer the knowledge.

The proposed evidence system is not built. It would:

- bind tasks to stable concepts and objective versions, required rubric criteria and task families;
- record when a hint or the answer was shown, and credit only the dimensions you actually demonstrated;
- not let self-ratings, repeats of the same question, keyword-based "application" labels, indirect prerequisite credit or generated notes certify a concept on their own;
- record missing or insufficient model results as not assessed, never as a default pass or fail;
- compare real-model samples with a human standard and count false passes and false rejections separately. A substantive false pass confirmed by blind human review would have to be fixed and rechecked on the original failure and on independent samples; until then, the affected grading path could give only candidate or supporting feedback, never certified evidence;
- check delayed recall against the concept's latest teaching, hint or practice across questions, so a correct answer right after relearning does not count as retention.

See the [Evidence Policy and implementation units](plans/2026-09-27-1945-feat-evidence-based-learning-plan.md) (U1, U5, U6 and U8; coverage in R2–R4 and U3; pilot thresholds in R16 and the Verification Contract) and the [proposed workflow](study-workflows.md#proposed-system-learning).
