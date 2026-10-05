# Study coach, personalised questions and autopilot

[中文](coach.zh-CN.md)

The study coach works around practice. You can report a bad question and have it fixed in the background. Each round ends with a summary and one recommended next step. If you agree, the coach also prepares personalised questions from your weak spots. Autopilot moves you through a round without clicking.

Answering a question in practice never calls a model by itself. Everything the coach sends to a model runs on the session model at its lowest reasoning level (see [Model use and tokens](#model-use-and-tokens)).

## At a glance

| Feature | Where | Model calls |
| --- | --- | --- |
| Rate a question | Thumbs-up / thumbs-down in the practice toolbar, or G / B | Recording a rating: none. Fixing a reported problem: one background call per fix |
| Round summary | The **Coach · next step** card on the result page | Numbers and next step: none. Wording: one light call once you have answered 3 or more questions |
| Personalised questions | Sidebar entry **Personalised**, the result page, **Study library** | One call per batch, only after you agree |
| Help after a wrong answer | **Help me understand** in the practice toolbar | Only when you click it |
| Autopilot | Key A | None |

## Set up the coach

Open **Settings › Study profile and tour** and find the **Study coach** section.

- **Prepare variations and application questions in the background while I practise**: your consent for [personalised questions](#get-personalised-questions). It stays off until you turn it on or say yes on a result page.
- **Learning objective**: Exam preparation, Interview preparation, Apply at work, Explore or Not set. The coach's tone and examples follow this goal.
- **Profile**: a short summary the coach writes after a round, plus your feedback counts. It shapes the wording and focus of coach hints, question fixes, personalised questions and round summaries. It does not change question generation or review scheduling.
- **Clear profile**: see [Data and privacy](#data-and-privacy).

## Report a problem with a question

1. While practising, click the thumbs-down button (**Question needs work**) or press B. For a good question, click thumbs-up (**Good question**) or press G.
2. A tray of tags opens (**What needs improvement?**). Click one or more tags, or press 1–7 while the tray is open.
3. Pause for 1.2 seconds. The tags you chose are sent. Sent tags cannot be withdrawn.

If you choose no tag, the thumbs-down still counts: after 1.2 seconds it is sent as a general "check and fix this question" request. If the question only asks what the material says, **Only asks what the source says** is already selected. You can unselect it before it is sent.

| Tag | What happens |
| --- | --- |
| **Vague question**, **Weak options**, **Unclear explanation**, **Only asks what the source says**, or no tag | A background repair changes only the criticised parts |
| **Incorrect answer** | The sources are checked first. If they support the original answer, the question stays as it is and the inbox says why |
| **Too easy** | With preparation on, a harder application question is prepared |
| **Too hard** | With preparation on, a simpler prerequisite flashcard is prepared. Once you start practising it, it is linked as a prerequisite of the original question |

Repairs and prepared questions need a model in the session. Without one, your rating is still recorded.

How a repair behaves:

- Any citation the fix adds must be quoted verbatim from the sources. A reply that cannot be read or fails validation gets one more attempt, with the error attached. If the model call itself fails, an empty reply or a brief provider error is retried up to 2 times; a timeout is not retried.
- Each finished fix appears in the **Inbox**. **Revert this question edit** restores the previous version while that fix is still the latest change.
- A fix never changes a result already on screen. If the question is open and unanswered, you answer the version you saw. The fixed version is used from the next attempt, such as the end-of-round retry or a later review.
- Up to 3 questions are repaired at the same time. Repeating a tag on the same question does not start a second repair. More tags on one question within 10 minutes join the same feedback record.

## Read the round summary

When an ordinary practice round ends, the **Coach · next step** card appears right under your score. Mock exams have their own report instead. Code works out the numbers and the recommendation, so the card works without a model.

The card shows:

- **Objectively correct**: single-choice, multiple-choice and fill-in-the-blank questions you got right.
- **Self-rating passed**: flashcards and open responses you rated 3 or higher.
- How the round splits into **Recall**, **Concepts** and **Application** questions, with the number passed at each level.
- Short notes on the reason, for example a round made mostly of recall and concept questions, or a low pass rate.

The two kinds of result stay separate. A low self-rating is not counted as a wrong answer, and a high objective score does not hide low self-ratings.

The card recommends one next step:

| Situation | Button |
| --- | --- |
| Personalised questions are ready | **Practise N personalised questions** (with your count) |
| You missed a question in this round, or rated one below 3 | **Review weak points first**: retries only this round's low-scoring questions, with no new ones mixed in |
| No low scores and 15 or more answers | A suggestion to rest, with no button |
| No low scores, fewer than 15 answers | **Continue studying** |

When the recommendation is personalised questions or weak points, the page's other main buttons switch to a secondary style, so there is one primary action.

With a model and at least 3 answers, one light call rewrites the headline and reason and updates your profile summary. If the model suggests a different next step from the one code chose, its text is discarded. The summary is saved with the round and reused until the number of answered questions changes; simultaneous requests share one call.

## Get personalised questions

Personalised questions are new questions written from your weak spots, checked against your sources and kept until you practise them. You need a model in the session and your consent.

### Give consent

Any one of these works:

- On a result page, the summary card asks: **Yes, prepare questions** or **Not now**. It stops asking once you answer.
- Turn on the switch in **Settings › Study profile and tour** (section **Study coach**).
- On **Mistakes & weak points**, **Generate variants** asks first. **Agree and generate** gives consent and starts.

After **Not now** you can still turn preparation on in Settings.

### What gets prepared

| Trigger | What is prepared |
| --- | --- |
| You turn preparation on, on a result page or in Settings | Variants of up to 4 questions you most recently missed or rated below 3. On a result page, also application questions if that round's summary calls for them |
| A round summary, with consent on | Application questions for up to 4 topics you passed. This happens after a round of 4 or more mostly recall and concept questions that you passed, after you missed most of 2 or more objective application questions, or after you tagged 2 or more questions **Too easy** |
| A **Too easy** or **Too hard** tag | A harder application question, or a simpler prerequisite flashcard |
| A new question under **Ask a follow-up?**, with consent on | A reinforcement question built on your doubt, only if the sources support it |
| **Generate variants** on **Mistakes & weak points** | Variants of the questions you chose, up to 8 per request |

A wrong answer during practice does not prepare anything on its own. To get variants of your mistakes, use **Generate variants** on **Mistakes & weak points**.

### How they are written

- Targets wait up to 20 seconds, or until 3 are waiting, then go out together. Each model call writes up to 4 questions.
- Variants are single-choice questions, or multiple-choice when the original was. A **Too hard** target becomes a flashcard.
- Each question is checked on its own. Its quotes must come verbatim from the cited sources, it must not repeat an existing question, and it must pass normal question validation. A question that fails is dropped, not repaired.
- At most 12 personalised questions wait at a time.

### Practise them

As soon as one is ready, they appear in:

- the sidebar entry **Personalised**, with a count (a dot when the sidebar is collapsed);
- the summary card's button on the result page;
- **Other ways to start** on the **Study library** page;
- a banner on **Mistakes & weak points**.

Starting them moves them into the system deck **Personalised**. From there they follow normal spaced repetition (SM-2).

## Use autopilot

- Press A to turn autopilot on or off. The setting is saved only in this browser.
- After a correct answer, or a self-rating of 3 or higher, the next question opens after 1.5 seconds. Click anywhere or press any key to stop it. Wrong answers and low self-ratings never advance on their own.
- At the end of an ordinary round, the summary's recommended step runs after a 5-second countdown. Click anywhere, or click **Cancel**, to stop it. A suggestion to rest does nothing automatically.
- There is no countdown on result pages reached from a **Learning flow** or from a detour (a side round that ends with a button back to the earlier question), or on result pages that offer **Return to original question**.

## Ask follow-ups on an explanation

After you reveal an explanation, **Ask a follow-up?** offers suggested questions and a box for your own. See [Follow-up questions](followup.md) for details.

- Answers are saved on the question.
- With preparation on, each new follow-up can produce a reinforcement question, checked like any personalised question. Turning preparation off does not stop follow-ups.
- Asking a saved question again reuses its answer. Identical requests sent at the same time share one model call.

## Keyboard shortcuts

Shortcuts work while the panel has focus and you are not typing in a text field.

| Key | Action |
| --- | --- |
| 1–6 | Choose an option |
| 1–7 | Choose a tag while the thumbs-down tray is open |
| 0–5 | Rate a flashcard or open response |
| Enter | Next question; submit a multiple-choice or fill-in-the-blank answer; flip a card |
| Space | Flip a card |
| ← / → | Previous / next question (→ after you answer) |
| H | Hint before you answer, explanation after |
| T | Ask the background assistant for a plain-language explanation |
| G / B | Thumbs-up / thumbs-down |
| A | Turn autopilot on or off |
| S | Resume the last round or start today's study, from any page |
| P | While reading a source: practise these pages |
| ? | Show or hide the shortcut sheet |
| Esc | Close a dialog |

## Data and privacy

Coach data is stored in your library, not in the browser.

| Record | File | Contents | Limit |
| --- | --- | --- | --- |
| `learner` | `study-workspace.json` (the library manifest) | Consent, goal, profile summary, feedback counts | Summary up to 400 characters |
| `coach` | `shards/misc/` | Coach notes, such as fix notices | Latest 400 entries |
| `feedback` | `shards/misc/` | Your ratings and tags | Latest 400 records |
| `prepared` | `shards/misc/` | Personalised questions | 12 waiting; the latest 100 used ones are kept |

Autopilot's on/off state is the exception: it is kept in this browser.

**Clear profile** in Settings deletes the goal, the profile summary, the feedback counts and any unused personalised questions. It also resets your preparation consent, so the next result page asks again. It keeps your practice records, review progress and feedback records. Follow-up Q&A, suggested follow-ups and EN translations saved on questions are not part of the profile and stay too.

## Model use and tokens

- The coach uses the session model at its lowest reasoning level: off, none or minimal when the model offers one, otherwise low, otherwise the lowest level listed. Your **Reasoning effort** setting for question generation does not apply here.
- Output caps apply only when reasoning is fully off, so reasoning is never cut short: 450 tokens for a hint, 320 for a coach reply, 1,600 for a repair, 3,600 for a batch of personalised questions and 650 for a round summary.
- A hint sends only the question with its own answer and explanation, no source text. A repair sends source excerpts around the cited quotes, up to 5,000 characters. A batch of personalised questions sends up to 6,000 characters. Code checks every quote verbatim.
- Cognitive level, metrics, notes and the next step are computed by code.
- The panel polls the host with a fingerprint. When nothing has changed, the host answers `unchanged` instead of sending the library again, source text included. Polling runs every 2.5 seconds, slows down after many unchanged answers in a row (unless a task is running) and stops while the panel is hidden.
- **Study statistics › Model usage** lists coach calls under **Study coach**. See [Token usage](token-usage.md).

## For developers

- Server actions: `coach.nudge`, `coach.reply`, `coach.feedback`, `coach.consent`, `coach.goal`, `coach.debrief`, `coach.practice`, `coach.revert`, `coach.status`, `coach.profile`, `coach.forget`, `coach.prepare`, `coach.variants` and `coach.rewrite.retry`.
- `coach.feedback { vote, tags, rewriteVia }`: a panel that opens its own fix-the-question box (修题) for the rewrite tags sends `rewriteVia: "assist"`. The silent coach rewrite is then not started (one visible path to the background assistant), and the result carries `fix`, the rewrite tags the panel should offer as fixes; `scheduled` has no `rewrite`. A client without the flag keeps the background rewrite and gets no `fix`.
- Since 1.0.0 the practice page has no coach column. `coach.nudge` (a hint after an objective miss or a self-rating below 3; not in mock exams) and `coach.reply` (got it, still unclear, or an answer to the hint's check; at most 2 extra explanations per hint) remain on the server, but the panel does not call them. Concurrent identical requests share one call.
- `coach.consent {prep: true, runId}` from a result page also queues that round's application questions.
- `coach.forget` clears `learner` and the waiting `prepared` questions only.
- Design decision: help after a wrong answer starts only when the learner asks ([F-010 in user feedback intake](user-feedback-intake.md)).
- Code: `lib/coach.js`, `lib/contexts/coach/`, `ui/CoachDebrief.jsx`, `ui/ThumbFeedback.jsx`.

## Planned: system-learning coaching (not built)

This is a proposal. None of it is in the current release, and the current automatic behaviour above does not define it.

- The route would reuse examples and follow-ups for a short sequence: minimal diagnosis, then a worked example, then a partial exercise, then an independent check.
- You would enter remediation explicitly. It would take at most 3 local steps within the round's budget and then return you to the original task. A wrong answer would not switch tasks or append another round automatically.
- Seeing a hint or the answer would affect whether an answer counts as evidence. Clicking "understood", finishing an explanation or a high self-rating would not certify independent mastery.
- Saved learning would stay available without a model. Open answers waiting to be graded would keep the submission for a retry.
- Consent to prepare questions would not cover a whole-source audit or running anything outside StudyHub.

See [R5–R9 and U4–U6 of the plan](plans/2026-09-27-1945-feat-evidence-based-learning-plan.md) and the [proposed workflow](study-workflows.md#proposed-system-learning).
