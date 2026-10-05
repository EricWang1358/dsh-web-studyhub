# Background tasks and the right sidebar

English · [简体中文](generation-agents-sidebar.zh-CN.md)

StudyHub runs model work in the background, so you can keep practising or chatting while it works. Background tasks include:

- generating a deck with **Generate from sources** or **Add questions from sources**, and **Send for background repair** on a draft;
- **Help me understand**, **Improve question**, making a new question from a Q&A, and rubric grading of an open answer;
- correcting earlier sentences of a **Live class** transcript.

This page shows where to follow these tasks, what each one saves, and what to do when one fails.

## Keep the question beside the chat

StudyHub opens in three places: **StudyHub** in DSH's left sidebar, the StudyHub tab of a session, and DSH's right sidebar.

To practise next to the chat, click **Open in right panel** at the top of the question. The question moves to the right sidebar and the main area returns to the chat. The button appears while a round is unfinished and DSH has a right sidebar.

StudyHub draws its background and its dialogs inside its own pane, so the chat beside it stays usable.

## Follow a generation task

Generation tasks appear on the **Study library** page. Each task card shows:

- the current stage, and how many questions are saved out of how many you asked for;
- **Stop**, which stops generating and keeps the saved questions in the draft;
- **Show the steps**, which lists each step with its status (**Starting**, **In progress**, **Finishing**, **Completed** or **Failed**), its tokens and how long it took. Click **View background assistant** to open that step's DSH subagent session;
- **Open draft**, once the task has ended and a draft exists;
- if the task failed, the reason and how to fix it, with **Set up a model** when the model is the problem. The raw error is under **Technical details**.

At the end of the step list, open **Method, usage and technical details** to see, for each stage, whether it ran as a **DSH subagent** or a **Direct model call**, its reasoning effort and its subagent session ID. The token usage of the whole task is there too.

Generation tasks in one library run one at a time. A later task waits in the queue until the earlier one ends. A task started before StudyHub recorded steps has no step list; start a new task to see one.

### Add a requirement while a task runs

In the main chat, ask StudyHub to pass an extra requirement to the running task. It appears under **Extra requirements** with one of these notes:

- **Received by the running assistants; later steps follow it too**: every running step that supports two-way communication received it.
- **Received by some assistants; the remaining steps follow it**: some running steps received it, and the rest follow it from their next step.
- **Later steps will follow it**: no running step received it, so it is added to the next model steps.

Deck generation steps do not take messages while they run, so there a requirement applies from the next step. A background repair can pass it to a running step when DSH supports two-way communication. Batches that already finished do not change. A task accepts up to 20 requirements of 1–4,000 characters each.

## What a generation task does

Generation works from verbatim quotes of your sources:

1. For each group of sources, the model picks knowledge points and copies the sentences that support them. This happens once per group.
2. The questions are split into batches of up to 5 (by default). For each batch, the model settles the supported answers and any scenarios, writes the questions and checks its own work. Then an independent review judges every question.
3. StudyHub checks the quotes and attaches the verified answers and citations locally, without a model.

Time and parallel work:

- By default, up to 3 batches run at the same time, and a whole task runs at most 20 minutes, not counting time in the queue.
- Each stage waits at most 10 minutes.
- When time runs out, questions that already passed review stay in the draft.

To change the batch settings for new tasks, open **Settings › Question defaults**. Under **Generation pace**, set **Parallel batches** (1–6), **Questions per batch** (1–5) and **Time budget per round (minutes)** (5–180; every round of a coverage plan has its own budget and the plan as a whole has none), then click **Save question defaults**. Tasks that already started, and drafts you continue, keep the settings they started with. Lower **Parallel batches** if your provider limits requests. Smaller batches save checked questions sooner but need more model calls. A background repair always has a 20-minute limit.

The same page saves a default question type, count (1–30), language, difficulty and focus. Initial defaults are Single choice, 10 questions, Follow interface language, Mixed difficulty and an empty focus. Choices on a new request take precedence, and a started task keeps its own settings snapshot. Continue or supplement from a draft keeps that draft’s content choices and generation pace, independently of later library-default changes. Older drafts without a pace snapshot use 3 parallel batches, 5 questions per batch and 20 minutes. Reset edits the form until you save; saving these preferences does not start generation.

Each batch gets exactly one independent review:

- Questions that pass are kept. Rejected candidates are listed with the reason.
- StudyHub does not repair and re-review automatically, and it does not generate extra questions to reach the count you asked for.
- To repair rejected questions later, click **Send for background repair** in the draft. That is a separate task you start yourself.

A model review does not prove that a question is correct. Check the sources before you publish.

## Get help on a question in the background

These actions start a background assistant for the current question:

| Action | Where | What it saves |
| --- | --- | --- |
| **Help me understand** | Question toolbar | The answer, added to the question as a Q&A. With **Review prerequisites** chosen, it can also link or create up to 3 prerequisite questions. |
| **Improve question** | **More** menu | An edit to the question. The old version stays in the question's history, and you can undo the change. |
| **Make a prerequisite question** | **More** menu | One new flashcard about a knowledge point you type, as a prerequisite of this question or as a separate question. |
| **Make a prerequisite question** / **Make a separate question** | Under a saved Q&A | One new flashcard built from that Q&A. See [Follow-up questions](followup.md). |

How these tasks behave:

- The assistant starts only when you click **Send to background assistant** (or a button under a Q&A). A status line shows what it is doing. You can keep practising or chatting, and the result arrives in the **Inbox**.
- The model is fixed when you submit. Choosing another model later does not change a request that is already running.
- A task stops after 8 minutes. Nothing is saved on a timeout.
- If a task fails, the question shows the reason with **Submit again** and **Edit, then submit again**.

StudyHub checks a result before it saves anything:

- The result is validated and saved in one step. An invalid result saves nothing: no half answer and no orphan prerequisite.
- If the check refuses a reply, StudyHub sends it back once with the reason, as a direct call to the same model, before the task fails. A timeout, a stop or a changed question is never retried.
- A result based on an older version of the question is not saved. Ask again on the updated question.
- New questions go into the same deck, so they belong to its course. Knowledge that your sources do not support is saved as a separate, labelled supplementary note among your sources.

### Keep talking to the same assistant

When DSH runs the assistant as a local subagent, repeated **Help me understand** requests on one question reuse one assistant and its earlier answers:

- Requests you submit close together are handled in order, in the same subagent session.
- The assistant starts fresh when you switch questions, when the question or its sources change, or when you change the model or the interface language. A fresh assistant receives the question's last 3 Q&A.
- StudyHub keeps at most 4 assistants. Each one is released after 2 idle minutes or 8 rounds, after a failure or timeout, and when StudyHub shuts down. Output that arrives after release is discarded.

## Correct live class transcripts

**Live class** can correct earlier transcript sentences in the background. It uses the model chosen in **Settings › Audio transcription › Advanced › Expert options › Model for proofreading and translation**:

- **Gemini (free first, then paid)**: Gemini makes the correction. Its availability, quota and billing depend on the provider and your account.
- **The model the conversation uses**: a DSH subagent runs it when DSH supports one; otherwise StudyHub calls the same model directly.
- **Automatic (the conversation model when there is one, otherwise Gemini)**: one of the two above.

Each correction stops after 60 seconds. If the sentences it covers changed in the meantime, the result is not merged; retry it.

## Choose the model

StudyHub's model work uses, in this order:

1. the **Generation model** set in **Settings › Library & model**;
2. otherwise, the model chosen for the session's next message, even before DSH has used it;
3. otherwise, DSH's default model.

**Reasoning effort** in the same settings applies to generation and to background help. Reading a saved session's model does not start that session's agent, and unchanged polling does not replay a long conversation.

## Fix a failed task

- **Errors and timeouts show the real cause.** A failure appears even when nothing else in the library changed. Late output, and results based on an older version of a question, never overwrite newer content.
- **`NO_ADAPTER`** means the DSH profile that runs the task has no provider with that name. For example, the provider is set up in DSH web but not in the DSH desktop app; a working web setup does not prove the desktop app has it. Add the provider in that profile's DSH **Settings › Models**, then try again. An audio import resumes from its saved transcription, so finished audio is not transcribed again.
- **Permanent errors stop at once.** In audio proofreading and translation, a missing provider, a key problem or exhausted quota stops the step without repeated requests, because repeating cannot fix them. StudyHub keeps the checkpoint and does not mistake the error for a format problem.
- **No second route.** Once a subagent has started, a failure ends the task. StudyHub does not run the same work again through a direct call. The single refused-reply retry in background help, described above, is the only exception.
- **Clearer diagnostics.** When DSH does not report why a subagent failed, StudyHub reads the reason from the subagent's saved session before releasing it. A clearer error message does not mean the provider works.

## Update and restart DSH

- **Finish or stop background tasks before you restart DSH.** StudyHub keeps its task queue in memory, so a restart drops queued and unfinished work. Refreshing the StudyHub page does not restart that queue.
- The in-app upgrade (**Upgrade to** followed by the version) checks for running background tasks first. If any are running, it offers **Stop tasks and upgrade**. Finished parts are kept.

## Development notes

### How StudyHub uses DSH subagents

- **Capability check** (`lib/host-capabilities.js`). A step runs as a subagent when DSH offers the official `spawn` provider with `toolFilter`, `agentOptions` support when a model is chosen, and either a running parent agent or the desktop coordinator below. Otherwise it runs as a direct model call and the step says so. Local structure and quote checks never create a subagent.
- **Plugin-owned steps** use one-shot subagents with `toolFilter: {allow: []}`. These are deck generation (including **Add questions from sources**), publication review, generation from a selection, translation and audio steps. The plugin collects their JSON, so it never flows into the main chat. (`lib/generation-agent.js`)
- **Background repair of a draft** runs each stage as a continuable subagent when the parent agent is running and DSH offers `startContinuable`, `sendMessage`, `drainContinuableChildren`, the `subagent/end` event and `send_message` in the parent's scope. The child may use only `send_message`, and only to its parent. (`lib/generation-continuable.js`)
- **Background help** uses `toolFilter: {allow: []}`. The subagent cannot write to the library; the service validates and saves its JSON. (`lib/assist.js`, `lib/assist-child.js`)
- **Output** counts only when the subagent ends as `completed`. Failed or interrupted output is never treated as a final answer, and every handle is released afterwards.
- **Desktop panels without a running parent agent.** If DSH offers `agents.create` and StudyHub can read the saved session's working directory (from the session header, `sessionPersistence.stat` or `sessionQuery.observeSession`), StudyHub creates a fresh idle coordinator and runs the work in its child. The coordinator gets no model task and never resumes or drives your chat. Both use the selected model and are released after the child returns.
- **Model selection** (`lib/host.js`) reads the same `modelSelection.next` projection as DSH's composer. For a saved session that is not running, StudyHub reads the stored projection through `sessionQuery.observeSession`, releases the observation and caches the result by revision.
- **Diagnostics.** DSH's in-process driver may leave `SubagentResult.diagnostic` empty. StudyHub then reads `turn/end.reason.error.message` from the child's session, and keeps `stopReason` when nothing is found.
- **Token usage** of a subagent comes from DSH's own usage record of the child session, read after the step ends.

### Desktop and web packages

The DSH desktop profile can install its own copy of the package while a web profile links the workspace. Editing the workspace does not update the desktop app. Updating the package, restarting DSH and checking the running feature are three separate steps. The DSH 0.2.0-rc.2 desktop plugin manager reports `restart-required` after an installed dependency is updated.

### Not built: reuse across generation stages

Reuse of the **Help me understand** assistant is built (see above). Reusing subagents across generation stages is not. In DSH 0.2.0-rc.2, `SubagentRuntime.startContinuable` and `sendMessage` let an idle continuable child take its next turn, and an unloaded direct child can be restored from its saved session. A one-shot `start` handle has no such contract, so keeping a handle is not reuse.

A design would reuse by task and role:

- the author of a batch would keep repairing after the review's feedback arrives;
- reviewers stay independent, and an author never reviews its own output;
- batches run in parallel, so one agent per job ID is not enough. The service passes only the stage and job ID to the host today; it would also need to pass the part, the role and the question or source version;
- live class history correction stays a bounded new task, since its input already carries the window, memory and evidence, and a long-lived history would tend to carry over old recognition judgements.

That would need keys by session, model, role and batch or question version; one message at a time per child; a wait for each real completion event rather than an earlier end or a receipt; the existing version checks, cancellation, timeouts and late-output rejection; clean-up when idle and when the job ends; and a desktop coordinator owned by the whole job. A change of model, sources or question version, or a failure, would start a new agent.

### Verification scope

These behaviours were checked with isolated temporary libraries, simulated model adapters and the official local DSH SDK. The checks cover lifecycle, routing, validation and saving. They do not prove a user's authentication, connectivity or real model quality. The 2026-09-30 verification records are in the [Chinese page](generation-agents-sidebar.zh-CN.md#历史记录) only.
