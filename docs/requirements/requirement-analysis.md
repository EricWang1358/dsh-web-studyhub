# Exercise 1. Architect the Solution Architecture (Requirements)

**Project:** DSH Daily Flashcard (`@ericwang1358/dsh-daily-flashcard`) — a native DeepSeek Harness plugin that turns study material into source-grounded flashcards, quizzes and spaced review inside a study workspace.

**Version of the analysed system:** 0.7.0

| Name | Email |
| --- | --- |
| EricWang | ziangw@u.nus.edu |

**Date:** 2026/09/15

> Use this page if your answers cannot fit in the above boxes.

---

## System Context

The plugin is not a standalone application. It is a **DSH (DeepSeek Harness) native npm plugin** that lives inside a host process. The host provides the tool registry, the model service, the system-prompt section, the slash-command registry, the session/workspace information and the client transport; the plugin contributes the study domain: a service layer (`lib/service.js`), a sharded library store (`lib/store.js`), the generation pipeline (`lib/generation*.js`, `lib/batch.js`), the review/teaching/insight projections (`lib/domain.js`, `lib/teaching.js`, `lib/insights.js`, `lib/mastery.js`), and the React study panel (`ui/`) mounted in the conversation view or the right sidebar.

The context therefore contains two very different kinds of user: a **human learner** clicking in the study panel, and the **in-conversation agent** calling one tool (`study_workspace`) or the `/study-spar` command on the learner's behalf. Both drive the same service and the same library; the panel is a projection of the library, the agent is an editor of it.

### Actors and external systems

| Actor / System | Type | Role in the context |
| --- | --- | --- |
| Learner (student, job candidate) | Primary human actor | Imports material, generates and curates questions, practises, self-assesses, fixes questions, plans study, publishes notebooks, plans tasks |
| DSH Agent (in-conversation study assistant) | Primary system actor | Calls `study_workspace` actions and `/study-spar`; answers with grounded evidence; files prerequisites; improves specific questions |
| DSH Host runtime | Secondary system | Supplies `tools`, `llm`, `systemPrompt`, `commands` and `sessions`; runs the plugin in-process; carries the client transport between panel and service |
| Model route (via the host `llm` service) | Secondary system | Generation (author/editor/review/repair), ingest inference, coach nudges, teaching plans, question improvement |
| Study Library store | System of record | Per-workspace library: `study-workspace.json` manifest plus `shards/` (sources, decks, drafts, attempts, runs, teaching, coach); `.dsh-study/` by default, or an existing workspace library |
| Global Study Catalog / Board | Shared external store | `~/.dsh/study/notebooks.json` (cross-workspace notebook links, respects `DSH_HOME`) and `~/.dsh/study/board.json` (shared todo board) |
| Other DSH workspaces | External system | Their published notebooks are readable, read-only, from any workspace |
| External study material | Input source | Pasted text, `.md`/`.txt` files, PDF lecture files, existing `study-lib-spar` libraries, screenshots transcribed in the conversation |
| DSH Web GUI (browser) | Delivery environment | Renders the 学习 panel in the conversation view / right sidebar and the whole-canvas graph |

### System context diagram

```text
                                  +----------------------------------+
   Learner (student)              |          DSH Host runtime        |
        |  clicks in the panel     |  tools  llm  systemPrompt        |
        |                          |  commands  sessions  transport   |
        v                          +---------------+------------------+
   +-------------------+   actions/snapshot  +-----+---------------------+
   | Study Workspace   |<------------------->|  daily-flashcard plugin   |
   | panel (ui/)       |                     |  service.js (actions)     |
   | conv. view /      |                     |  store.js  generation.js  |
   | right sidebar     |                     |  domain/teaching/insights |
   +-------------------+                     +-----+----------+----------+
                                                     |          |
              DSH Agent (in conversation)            |          | model calls
              study_workspace / /study-spar ----------+          v
                                                     |    Model route
                                                     |    (via host llm)
                                                     v
                            +-------------------------------------------+
                            |  Study Library store (.dsh-study/ or an   |
                            |  existing workspace library)              |
                            |  manifest + shards — the single source of |
                            |  truth, versioned, file-locked           |
                            +-------------------------------------------+
                                                     ^
                            other DSH workspaces ----+  (read-only published notebooks)
```

### Architectural drivers and constraints

- **Single tool surface.** Agents reach the whole domain through one `study_workspace {action, payload_json}` tool plus the `/study-spar` command; the panel and the tool must not diverge, so every capability is a service action, not a UI-only path.
- **The library on disk is the only source of truth.** UI state (drafts in `sessionStorage`), in-flight jobs, coach caches and generation queues are all transient. No second database and no in-place rewriting of the imported `study-lib-spar` Markdown.
- **Versioned, sharded, transactional storage.** A change writes only the shards whose content changed, then atomically replaces the manifest under a cross-process file lock, so an attempt and its SM-2 schedule commit together. Version-1 single-file libraries upgrade on first write with a `backups/` copy.
- **Model calls are reserved for judgement.** Viewing, answering, grading and SM-2 updates are code. The model is called for generation, review, ingest inference, coaching, teaching and question improvement only, and background/coach calls use the lowest reasoning effort available with caching.
- **Asynchronous generation.** A generation job is long-running and in-process; the panel observes it through snapshots, the agent through `job.wait` (max 60 s) and `job.message`; cancellation is a first-class action.
- **Two independent lifecycle boundaries.** The library survives host restarts; unfinished jobs and open practice runs behave differently on restart (jobs are lost, runs are resumed).

---

## Architectural Significant Use Cases

The use cases below were selected because they shape the architecture above, not because they are the most frequent. They force the single tool surface, the transactional sharded store, the asynchronous generation pipeline, the cross-workspace read-only catalog and the shared revision-checked board.

| UC-ID | Use Case | Primary Actor | Why it is architecturally significant |
| --- | --- | --- | --- |
| UC-01 | Import Study Material | Learner | Turns the filesystem into the system of record: sources, page previews, native PDF extraction, migration of an existing library |
| UC-02 | Generate Reviewed Questions | Learner, DSH Agent | Drives the asynchronous job pipeline, per-batch author/editor/review/repair agents, draft checkpointing and cancellation |
| UC-03 | Practise with Spaced Repetition | Learner | Drives SM-2 scheduling, code-based grading per card kind, attempt log and resumable runs under one transaction |
| UC-04 | Teach Step by Step after a Wrong Answer | Learner | Introduces the append-only teaching ledger that stores conclusions, never transcripts |
| UC-05 | Record Questions from the Live Conversation | Learner, DSH Agent | A write path with no draft: ingest keeps stems/options/keys, flags inferred answers, skips duplicates |
| UC-06 | Capture a Stuck Question and Link Prerequisites | Learner, DSH Agent | The hidden-answer agent contract and the prerequisite graph that orders the learning path |
| UC-07 | Improve a Published Question in Place | Learner, DSH Agent | Content mutation with revision history that must preserve or reset scheduling, and stay coherent with an open run |
| UC-08 | Review Progress and Plan the Next Session | Learner, DSH Agent | Read-only projections (map, stats, wrong book, graph) plus the exam mode that writes only on submission |
| UC-09 | Publish and Discover Notebooks Across Workspaces | Learner | Cross-workspace catalog whose study data stays in its own workspace and is read-only everywhere else |
| UC-10 | Plan Work on the Shared Board | Learner, DSH Agent | One global store with revision-checked writes, independent of the current library |

---

### Use Case - Import Study Material

| Field | Value |
| --- | --- |
| **Use Case ID** | UC-01 |
| **Description** | The system shall accept study material — pasted text, `.md`/`.txt` files, native PDF lecture files (optionally page-selected) and an existing `study-lib-spar` library — and store it in the study library as citable sources that later questions must be able to quote verbatim. |
| **Primary Actors** | Learner |
| **Secondary Actors** | DSH Host (directory picker, native PDF extraction), Study Library store, `study-lib-spar` library on disk |
| **Main Flow of events** | 1. The learner opens 学习 › 资料 and adds material by pasting text, choosing a file, importing a PDF lecture, or selecting an existing `study-lib-spar` library.<br>2. The system validates the material against its limits (PDF at most 8 MB and 200 pages; at most 600,000 characters per source selection).<br>3. For a PDF, the system extracts the text natively page by page and keeps each page's text and preview.<br>4. The system stores the material as a source (id, title, text, page previews, date) in the library.<br>5. The system reports any extraction warning to the learner, and never claims that images, diagrams or formulas were read.<br>6. Importing the same PDF again reuses the existing source instead of creating a duplicate.<br>7. The learner can open any source and read the original text at any time. |
| **Alternative Flow of events** | **A1. Image-only or scanned PDF at step 3:** the source is imported with an explicit OCR warning; the pages contribute no text until the learner OCRs them outside the plugin.<br>**A2. Existing `study-lib-spar` library at step 1:** the import is read-only; parseable interval, ease factor and due date are preserved; free-text legacy questions become self-assessed flashcards and no correct option is guessed; files with an incomplete format are reported one by one; re-importing the same path does not recreate decks or overwrite progress.<br>**A3. Material over the limits at step 2:** the PDF is refused with its actual size/page count; a long text source is split at 60,000 characters per call and the total selection is capped at 600,000 characters.<br>**A4. Save failure at step 4:** on Windows the atomic replacement is retried a bounded number of times for transient file locks; if it keeps failing, the previous library is kept intact and the learner is told the operation failed. |
| **Pre-conditions** | 1. The session has a workspace and the plugin is loaded by the host.<br>2. A library binding resolves (the session workspace `.dsh-study/`, an existing `study-workspace.json` in the workspace root, or a directory chosen in 设置).<br>3. For PDF import, the file is a text-based PDF within the size and page limits. |
| **Post conditions** | 1. The source(s) exist in the library and are visible in 资料, `source.list` and `source.get`.<br>2. No question has been created and no SM-2 state has changed.<br>3. If extraction or storage fails, the library is unchanged and the learner sees the reason. |

---

### Use Case - Generate Reviewed Questions

| Field | Value |
| --- | --- |
| **Use Case ID** | UC-02 |
| **Description** | The system shall plan the evidence and the knowledge points, write, self-revise, independently review and checkpoint questions generated from selected sources into a draft, and shall not let any generated card enter review scheduling before the learner publishes it. |
| **Primary Actors** | Learner, DSH Agent (asked to turn a lecture into questions) |
| **Secondary Actors** | DSH Host model route, Study Library store, generation child agents |
| **Main Flow of events** | 1. The learner (or the agent through `generate`) selects one or more sources and sets count (1–30), kind (flashcard / quiz / multi / open / cloze / mixed), difficulty, language, focus, and optionally a target role and a deck title or folder.<br>2. The system plans the evidence and the test points to cover across the whole selection before writing anything.<br>3. The system segments the material (at most 60,000 characters per segment) and batches it (at most 5 questions per batch), running batches in parallel.<br>4. In each batch an author writes cards with a hint, explanation, misconception, an independent objective and verbatim citations; the batch is then self-revised and independently reviewed.<br>5. Cards that fail review are repaired and re-reviewed once; cards that still fail are dropped and the resulting shortfall is reported on the draft.<br>6. Reviewed successes are checkpointed into one draft for the whole job; `kind:mixed` is one job and one draft.<br>7. The learner reviews and edits the draft, validates it, and publishes it — or discards it. |
| **Alternative Flow of events** | **A1. Validation failure at step 7:** a single-choice card must have exactly one correct option, a multi-choice card must not be all-correct, every distractor needs an explanation, and citations are checked verbatim by code; the draft lists the errors, publishes cards that pass, and keeps failed cards in a pending draft for optional background repair and later publication.<br>**A2. Cancellation:** `job.cancel` stops the workers and skips queued jobs for that library; drafts already checkpointed are kept as "cleanup pending".<br>**A3. New requirement during the run:** `job.message` broadcasts the refinement to the active generation children and reports the actual delivery status; completed batches are unchanged.<br>**A4. No model available at step 2:** generation is refused with a clear message; importing an existing library, manual card creation and review remain fully usable.<br>**A5. Host restart or a repaired card still failing review:** unfinished in-process jobs are interrupted and formally nothing is published; cards that never pass review are dropped and the draft shows the count gap. |
| **Pre-conditions** | 1. At least one source exists in the library.<br>2. A model route is available (session model, last-used model, DSH default, or a generation-only model configured in 设置).<br>3. The library is writable. |
| **Post conditions** | 1. Either a draft exists containing reviewed cards with the generated/published count, plus a reported shortfall when cards were dropped, or nothing is written.<br>2. No card is schedulable and no SM-2 state has changed before publication; on publication the deck's cards enter the learning path as new cards.<br>3. A cancelled or failed job leaves the committed library and every previously saved draft untouched. |

---

### Use Case - Practise with Spaced Repetition

| Field | Value |
| --- | --- |
| **Use Case ID** | UC-03 |
| **Description** | The system shall present a study session of due reviews, weak cards and new cards in syllabus order, grade each answer according to its card kind, record the attempt, and update SM-2 scheduling so the learner is shown the right card at the right time. |
| **Primary Actors** | Learner |
| **Secondary Actors** | Study Library store, DSH Host model route (only for the optional coach nudge) |
| **Main Flow of events** | 1. The learner opens 学习 (今日学习) or selects a deck/topic scope and presses 开始.<br>2. The system builds the queue: due reviews first, then weak cards, then new cards in syllabus order; a daily batch is at most 10 new cards and 20 in total, while an explicitly scoped start includes every available card in that scope.<br>3. The system displays one card at a time and shuffles choice order at runtime, so grading never depends on A/B/C position.<br>4. Grading is by kind: single-choice and multi-choice are graded by the correct-option set; cloze is graded by normalised text comparison against the accepted variants; open questions and flashcards are self-assessed 0–5 as a mastery signal, never as a submitted answer.<br>5. The system records the attempt, applies SM-2 (repetitions, interval, ease factor, next due date) in the same transaction and moves on.<br>6. Wrong answers — or a self-assessment of 0–1 — are appended once to the tail of the round as a hidden-answer retry that does not change the interval again.<br>7. The round summary reports question counts and retries separately. |
| **Alternative Flow of events** | **A1. Unfinished run:** returning to the library keeps the current practice, and 回到题目/Learn panel returns to the last run and card; the learner may also explicitly end the round and keep the recorded answers.<br>**A2. Question changed during an open run:** a content change syncs the live card into the run and requires a fresh answer, while wording/citation-only edits keep the current grade; a finished run keeps its original snapshot.<br>**A3. Suspended or archived:** suspended cards never enter a queue, and archiving a deck ends its active practice while history is kept.<br>**A4. Nothing due:** the system shows an empty state with entry points to create a deck or generate questions.<br>**A5. Save failure at step 5:** the attempt and schedule commit together or not at all under the library lock, so a failed write leaves both unchanged. |
| **Pre-conditions** | 1. A published, non-archived deck exists and contains at least one non-suspended card.<br>2. The library is readable and writable.<br>3. Reaching a card requires the correct answer on record for grading; no model call is required for viewing or answering. |
| **Post conditions** | 1. The attempt log contains entries for the answered cards, with feedback and grade.<br>2. The SM-2 schedule of each answered card is updated; mastery is derived from it later rather than stored separately.<br>3. The run is either resumable at the next card or closed with a summary; a graded retry is recorded but does not change intervals again. |

---

### Use Case - Teach Step by Step after a Wrong Answer

| Field | Value |
| --- | --- |
| **Use Case ID** | UC-04 |
| **Description** | After an incorrect answer, the system shall diagnose the core gap and walk the learner up an ordered ladder of prerequisite rungs, each gated by a small check, and shall persist only normalised teaching conclusions — never the learner's raw answer or a transcript. |
| **Primary Actors** | Learner |
| **Secondary Actors** | DSH Host model route, Study Library store |
| **Main Flow of events** | 1. The learner answers a card incorrectly and asks for 逐步讲解 (or the coach directs the learner to it).<br>2. The system diagnoses the gap as a missing model, a misconception or a procedure gap.<br>3. The system produces an ordered ladder of rungs from the learner's current level to the target, with a worked example and a one-choice check for each rung.<br>4. The learner answers the check for the current rung; a pass opens the next rung, a fail re-explains the same rung.<br>5. The small checks do not update SM-2.<br>6. When the ladder is complete, the system writes a teaching conclusion — diagnosis, mastered rungs, and a transfer rule with examples — and may offer a consolidation question derived from it. |
| **Alternative Flow of events** | **A1. Interrupted teaching:** the teaching progress is restored with its card and the plan is not regenerated.<br>**A2. No model available at step 3:** no plan is created; the card, its answer and the rest of the review flow remain usable.<br>**A3. Consolidation declined:** a separate append-only lifecycle event records the decline; the teaching event itself is never rewritten.<br>**A4. Learner replies "still confused" in the coach:** the panel produces at most two additional angles and then directs the learner to the conversation for free-form follow-up. |
| **Pre-conditions** | 1. A practice run exists with a recorded answer for the card (right or wrong, as the entry point requires).<br>2. The library is writable and a model route is available. |
| **Post conditions** | 1. A teaching record exists containing normalised conclusions only; no transcript, reasoning trace or raw learner answer is stored.<br>2. The learner has either mastered the rungs or the ladder remains resumable at the same position.<br>3. No SM-2 state was changed by the small checks. |

---

### Use Case - Record Questions from the Live Conversation

| Field | Value |
| --- | --- |
| **Use Case ID** | UC-05 |
| **Description** | While conversation recording mode is active, the system shall take question material pasted into the conversation — quiz-app stems, LMS mistake logs, screenshots transcribed in chat — and record it straight into the chosen deck without a draft, keeping the original stems, options and answer keys, writing a specific explanation per option, saving the paste as the cards' source, skipping duplicates, flagging inferred answers, and marking the learner's mistakes as weak. |
| **Primary Actors** | Learner, DSH Agent (transcribes the pasted material and calls `ingest`) |
| **Secondary Actors** | DSH Host model route, Study Library store |
| **Main Flow of events** | 1. The learner starts 现场对话录题, choosing the target deck (or a new deck with a folder), the kind (auto / flashcard / quiz / multi / open) and the mistake notation; the panel header shows 录题中 · deck · N recorded.<br>2. The learner pastes question material into the conversation, transcribed verbatim when it is a screenshot.<br>3. The system parses the material and validates each item, keeping its stem, options and answer key.<br>4. The system writes the cards with a specific explanation per option; the pasted text is stored as one source for the batch, and citations are verbatim to that source.<br>5. When the material contains no answer, the system infers one with the model and flags the card 答案由模型推断，待核对.<br>6. Questions the learner marks as wrong (or all of them, when 全部当错题 is chosen) are recorded as weak, so the learning path prefers them.<br>7. The system reports how many cards were added, which were duplicates and which were skipped and why; `ingest.status` and the panel header track progress.<br>8. Each call handles at most 60,000 characters; a longer paste is split across calls. |
| **Alternative Flow of events** | **A1. Duplicate question at step 3:** the existing card is kept, the item is skipped and reported, and no duplicate is created.<br>**A2. Format validation failure at step 3:** the system attempts one repair; items that still fail are listed with their reasons and are not written.<br>**A3. Lecture material rather than a mistake log:** a lecture PDF is not treated as an existing question bank; the agent uses the generation flow (UC-02) instead.<br>**A4. Stop recording:** the learner presses 停止录题 or says "stop"; the recording state clears and later pastes are no longer ingested automatically.<br>**A5. No model available at step 5:** items whose answer key is present are still recorded; items that would need inference are reported instead of guessed. |
| **Pre-conditions** | 1. The learner has a session workspace with a library.<br>2. A target deck is chosen, or the recording state names a title from which a deck is created.<br>3. Recording mode is active and a model route is available for parsing and inference. |
| **Post conditions** | 1. The deck contains the recorded cards with per-option explanations, verbatim citations and weak marks for the learner's mistakes.<br>2. The paste exists as a source, so every recorded card can be traced back to it.<br>3. Inferred answers are visibly flagged for checking; duplicates and skips are reported; new cards enter the path as new cards. |

---

### Use Case - Capture a Stuck Question and Link Prerequisites

| Field | Value |
| --- | --- |
| **Use Case ID** | UC-06 |
| **Description** | The system shall let a learner file a question they could not answer — classified into a deck and topic, checked against existing cards, answered from library evidence where evidence exists — and link it as a prerequisite of the question being practised, without revealing that question's answer. |
| **Primary Actors** | Learner, DSH Agent |
| **Secondary Actors** | DSH Host model route, Study Library store |
| **Main Flow of events** | 1. Stuck on a question, the learner uses 不会？问 AI (or types `/study-spar <question>`); the prompt placed in the conversation contains the deck and card identifiers but not the answer.<br>2. The agent helps the learner work out what they are missing through their own follow-up questions.<br>3. Each prerequisite point that becomes clear is filed with `capture`; the system classifies the matching deck and topic, checks for an equivalent card, and verifies and refines the answer.<br>4. If an equivalent card already exists, `capture` reports it as a duplicate and the existing card is linked instead with `card.link`.<br>5. Answers prefer the library's own source text; when no evidence exists, the model's explanation is saved as a supplementary note (补充笔记 · 主题) and the learner is told to check it.<br>6. The question page shows 前置题 N · 已掌握 M; the learner can 先学前置 and then 回到原题. Prerequisites can be added or removed at any time and never reset scheduling.<br>7. The learning path orders unlearned or wrong prerequisites before the cards that require them. |
| **Alternative Flow of events** | **A1. Cycle at step 4:** a link that would make the graph circular is refused.<br>**A2. Answering the dependent card correctly at step 6:** its unsatisfied prerequisites within two levels are credited with one pass each; prerequisites that are not yet due are left untouched.<br>**A3. Both prerequisite and dependent are due:** the learning path shows only the dependent card.<br>**A4. No model available at step 3:** the capture fails with a message; the existing library, the open run and the question's schedule are unaffected. |
| **Pre-conditions** | 1. An open practice run names the card being practised, or the learner supplies an explicit deck identifier.<br>2. The library is writable; a model route is available for classification and answer refinement. |
| **Post conditions** | 1. Either one new prerequisite card (or a link to an existing card) exists, marked with its notes, or nothing was added.<br>2. The original question's schedule is unchanged by the link; the prerequisite is scheduled like any other card.<br>3. The answer to the practised question was never revealed to the learner as part of the capture. |

---

### Use Case - Improve a Published Question in Place

| Field | Value |
| --- | --- |
| **Use Case ID** | UC-07 |
| **Description** | The system shall let the learner or the agent fix one published question in place — wording, options, explanations, citations or cloze blanks — with a revision history and an undo, keeping the review schedule unless the question, the answer or the correct option changes. |
| **Primary Actors** | Learner (through the agent) |
| **Secondary Actors** | DSH Host model route, Study Library store |
| **Main Flow of events** | 1. The learner states in the conversation what is wrong with a specific question (for example "every option explanation is too generic"), or presses 👎 and picks a reason tag.<br>2. The agent reads the card with `card.get`, fixes exactly what was criticised — for option explanations, saying why each option is right or wrong for this question, naming the concept or misconception, grounded in the cited source — and does not reveal the answer to the learner.<br>3. The agent saves the change with `card.update` and states what changed and why; the previous version is kept.<br>4. The system validates the patched card with the same quality rules used at publication, including verbatim citations.<br>5. If only wording, explanations or citations changed, the review schedule is kept; if the prompt, the answer or the correct option changed, the card's scheduling restarts while its answer history is preserved.<br>6. A question open in the current run syncs to the new version and is answered again within seconds; a finished run keeps its original snapshot.<br>7. The learner may undo the last change with `card.revert`. |
| **Alternative Flow of events** | **A1. Validation failure at step 4:** the update is refused with the card's errors and the published card is unchanged.<br>**A2. 👎 at step 1:** a small set of tags triggers a background rewrite of that card, revertible, or prepares a harder or more basic variant of the question.<br>**A3. Draft edited in two windows:** the stale version is refused and the learner must reopen the latest draft; scheduling writes never create unrelated edit conflicts.<br>**A4. No model available at step 2:** a text or field edit supplied by the learner is still saved; generated explanations cannot be produced. |
| **Pre-conditions** | 1. The card is published and the caller is allowed to read its deck.<br>2. The library is writable; a model route is available for generated wording. |
| **Post conditions** | 1. The card content is updated with a revision entry, or the update is refused and the card is byte-for-byte unchanged.<br>2. Scheduling is preserved or restarted according to the rule in the main flow, and all historical attempts remain.<br>3. No other card in the library was modified. |

---

### Use Case - Review Progress and Plan the Next Session

| Field | Value |
| --- | --- |
| **Use Case ID** | UC-08 |
| **Description** | The system shall project the attempt log into mastery, dashboard statistics, a knowledge / learning-path graph, a cross-deck wrong book and a mock exam, and use those projections to recommend the next thing to study. |
| **Primary Actors** | Learner, DSH Agent |
| **Secondary Actors** | Study Library store, DSH Host (agent calls `map` / `stats` / `graph` / `wrongbook`) |
| **Main Flow of events** | 1. The learner opens 统计 (or asks the agent for progress, which calls `map` and answers from the returned mastery and next-topic fields).<br>2. The system derives mastery per deck, topic and card from the SM-2 interval and the latest answer — wrong is weak, an interval of at least 6 days is familiar, at least 21 days is mastered — without storing a second mastery field.<br>3. The dashboard shows the current streak and active days, a 182-day heatmap, the daily average-grade trend and a weak-topic list with wrong counts, all recomputed from the attempt log.<br>4. The wrong book lists the latest wrong answer per card across decks; a single card or the whole book can be re-practised, which runs as a normal learning path and records SM-2 normally.<br>5. The graph renders either the knowledge structure (deck › topic › card, with dashed prerequisite edges) or the ordered learning path, on a full-canvas view; node colour is mastery and clicking a card node starts practice.<br>6. A mock exam draws single/multi-choice cards across decks (default 10 questions, maximum 50, 30-minute auto-submit), hides correctness while answering, does not update SM-2 during the exam, and reports the score, the distribution by topic and deck, and the wrong list, which can be queued into the learning path.<br>7. The first screen shows today's plan and a recommended next topic so the learner can start again in one click. |
| **Alternative Flow of events** | **A1. No attempts yet:** the dashboard and wrong book show empty states with entry points to import material or generate questions.<br>**A2. Unfinished run:** 回到题目 returns to the most recently operated run and its card.<br>**A3. Archived decks:** excluded from the wrong book, the graph's default scope and the exam pool.<br>**A4. Unreadable or damaged library file:** the panel shows a read-only notice and never overwrites the original file. |
| **Pre-conditions** | 1. The library is readable; for non-empty reports the attempt log contains at least one entry.<br>2. For a mock exam, at least one card of kind quiz or multi exists in the selected scope. |
| **Post conditions** | 1. Progress views are read-only projections that create no library state.<br>2. Submitting an exam writes feedback and SM-2 updates only for the cards the learner answered, and closes the exam run.<br>3. A failed read leaves the library untouched and the learner keeps the previous view. |

---

### Use Case - Publish and Discover Notebooks Across Workspaces

| Field | Value |
| --- | --- |
| **Use Case ID** | UC-09 |
| **Description** | The system shall let a learner expose one workspace's study notebook in a global catalog so other workspaces can see it and jump to it, and shall let any workspace discover and search the published catalog, without copying or synchronising study data. |
| **Primary Actors** | Learner |
| **Secondary Actors** | DSH Host (opening a new conversation in another workspace), Global Study Catalog, other DSH workspaces |
| **Main Flow of events** | 1. On the library home the learner presses 发布到全局目录 (optional and reversible at any time).<br>2. The system registers exactly one link in `~/.dsh/study/notebooks.json` — workspace path, library location and title; the study data itself stays in its own workspace.<br>3. Every workspace lists all published notebooks (its own first) with deck count, due-today count and a topic preview; 刷新 re-reads the catalog.<br>4. `notebook.list` returns the same catalog to an agent, and `notebook.search {query}` matches deck titles, topics and prompts across published libraries, read-only.<br>5. Selecting another workspace's notebook opens a new conversation in that workspace; the study panel there shows that notebook's own progress and review queue, and the original session is unaffected.<br>6. Unpublishing removes only the registration. |
| **Alternative Flow of events** | **A1. Registered workspace path missing or unreadable:** that notebook is shown as unavailable; the other notebooks and the current workspace are unaffected.<br>**A2. Write attempt against another workspace's notebook:** refused — the tool surface is read-only for notebooks that do not belong to the current workspace; writes must happen in that workspace's own session.<br>**A3. Duplicate publish:** the existing registration is updated rather than duplicated.<br>**A4. Corrupt catalog file:** the catalog is shown read-only and the file is never overwritten. |
| **Pre-conditions** | 1. The workspace has a study library.<br>2. The global study directory is writable (`~/.dsh/study`, honouring `DSH_HOME`). |
| **Post conditions** | 1. The catalog contains one registration for the notebook, or none after unpublishing.<br>2. No study data was copied, merged or synchronised; other workspaces hold a read-only view.<br>3. The publishing workspace's own review queue and schedule are unchanged. |

---

### Use Case - Plan Work on the Shared Board

| Field | Value |
| --- | --- |
| **Use Case ID** | UC-10 |
| **Description** | The system shall provide one three-column board shared by all workspaces so a learner can record study tasks, edit their notes, due dates and labels, move and archive cards, and so an agent can operate the same board — with revision-checked writes that never silently overwrite a concurrent edit. |
| **Primary Actors** | Learner, DSH Agent |
| **Secondary Actors** | Global Study Catalog / Board store (`~/.dsh/study/board.json`), DSH Host (workspace origin for a card) |
| **Main Flow of events** | 1. The learner opens 待办; the badge shows the number of unfinished cards.<br>2. The system reads the board file (default columns 待办 / 进行中 / 已完成), independent of the current library.<br>3. The learner adds a card by typing a title and pressing Enter, and edits its Markdown note, due date and labels by clicking the title.<br>4. The learner drags a card to reorder it or move it to another column, or uses the card's arrow buttons; a card keeps the workspace it was created in and can jump back there when the host supports it.<br>5. The column menu renames a column or deletes an empty one; a renamed 已完成 column still counts completion, and a new column counts as unfinished.<br>6. An agent reads the board with `board.get` and performs `board.card.add/edit/move/archive/restore/remove` and `board.column.add/rename/remove`, passing the revision returned by `board.get`. |
| **Alternative Flow of events** | **A1. Revision conflict at step 4 or 6:** the write is refused; the learner's typed input is kept, the latest board is shown, and the learner reconciles before retrying.<br>**A2. Removing a non-empty column:** refused; only empty columns may be removed.<br>**A3. Corrupt board file:** the board is shown read-only and the original file is never overwritten.<br>**A4. Card operations before a read:** a mutation without the current revision is refused, so an agent must call `board.get` first. |
| **Pre-conditions** | 1. The study directory is writable (`~/.dsh/study`, honouring `DSH_HOME`).<br>2. For agent operations, the board revision has been read with `board.get`. |
| **Post conditions** | 1. The board file reflects the card and column changes at a new revision, or is unchanged when the write was refused.<br>2. Archived cards remain recoverable from the archive list.<br>3. The current study library is unaffected — the board is shared state, not library state. |

---

## Notes on the boundary of the document

- `study_workspace` is a single tool with an action registry (63 actions at version 0.7.0: read handlers and in-transaction mutations). The use cases above are expressed at the level of user-observable outcomes, not one per action; the action registry is the implementation view of them.
- The generation pipeline (author → editor → independent reviewer → repair → re-review) and the record-only ingest path are deliberately separate: lecture material becomes new questions through UC-02, while UC-05 only records questions that already exist somewhere else.
- Everything the plugin stores is derived from the attempt log and the content model; mastery, streaks, the heatmap, the wrong book and the graph are projections and are never stored a second time.
