# Coverage of a material (覆盖)

Phase 2 of [coverage-driven generation](plans/coverage-generation/README.md). A learner who generates questions from a long material can see, before practising, **which sections of it have a question**, which were planned and did not come out (and why), and which were never planned; and one action fills the gaps.

## The model (`lib/coverage.js`, pure and browser-safe)

`coverageOf({ sources, cards, partPlans, ...sectionOptions })` counts **leaf sections** (`lib/sections.js`: kept outline, PDF page, transcript part, Markdown heading, fixed window). A section is

| state | meaning |
| --- | --- |
| `covered` | at least one question's place falls in it. The place is the question's selection offsets, else where its quote stands in the source (a quote written a little differently from the stored text is still found: `lib/quote-locate.js`); a question that cites a source with a single section covers it with no offset. |
| `planned-failed` | a planned target of a run (`editorial.partPlans`, `lib/plan-record.js`: offsets, else the quote, else the range of its part) with status `failed` or `omitted` falls in it and no question does; a part that never reached targets is its range. `reason` is the code of `lib/generation-failure.js`. |
| `never-planned` | neither. A draft from before plans were kept has no `partPlans` (`recorded: false`): its uncovered sections are said to have *no record*. |

The result carries `sections`, the counts, `percentLeaves`, `percentChars`, `perTenK` (questions per 10 000 characters), `units`, `unplaced` (questions that point into a many-section source at no offset that can be found: they cover nothing, and the count says so) and `groups` (one row per recording or chapter). A 530,000-character, 80-part material with 400 questions takes about 40 ms.

Backend views (`lib/coverage-state.js`): a draft's own coverage, a document's (every published or draft question of the library that points into it; archived decks, suspended questions and copies of published decks are left out), and the digest the snapshot keeps per document (`materialCoverage`: `[covered, plannedFailed, neverPlanned, recorded, units]`, a few characters, because the snapshot is paid for in characters).

Service actions: `coverage.get { draftId }` (coverage and the round a top-up would run now, `canTopUp`) and `coverage.get { documentId | sourceId }`.

## Where it is shown (one wording: `ui/coverage/copy.js`)

- 任务 console › 资料部分: each part says 覆盖 3/8 小节 for its range and a small bar; the strip names the sections of the part with no question and the real reason of each. A finished (or archived) run has 为没覆盖的部分补题 in the header.
- Draft page: the summary at the top (「覆盖 7/80 个部分（9%）· 3 个计划了没出成 · 70 个没计划到」), one row per recording, the list of what has no question with the way to the reader at that section, and the one top-up.
- 资料 page row and the reader's toolbar: 覆盖 9% beside the mastery mark, before anything is published (drafts count).
- Reader outline: a square mark per section (solid with a tick · hatched · dashed), a count on every recording, 覆盖 7/80 in the header and 只看没覆盖的; the 做这几页的题 panel says in one line when part of its range has no question. Coverage is *asked*, mastery is *learned*: coverage is a square, mastery a ring, and the words never mix.

## The one top-up (`lib/coverage-round.js`)

`generate { resumeDraftId, draftVersion, coverage: { sectionIds? } }` (without `sectionIds`: the default round). It covers exactly the uncovered sections, planned-and-failed first, then never-planned, in reading order, up to the generation limit of 30 questions a round (raising it is phase 3); it says honestly how many more rounds the rest needs. A planned-and-failed section with located targets is written again from those targets as they were (no planning call; the verbatim quote is the stored text between the offsets); every other section is planned from its own text, the planner being given only the text of those sections (cut at their offsets, so every citation still checks against the full source). The approved questions stay and the new ones merge into the same draft. The draft's `requested` does not grow beyond the questions it holds. `usage.estimate { feature: 'generate', resumeDraftId, draftVersion, coverage }` prices exactly that request, so it costs about what it covers (see [token usage](token-usage.md)). The old two controls (继续补齐 N 题, 补 N 题) are gone from the screens; the agent's plain `generate { resumeDraftId, draftVersion }` and `extraSourceIds` still work.

## Coverage strength and enforced planning (phase 3)

A coverage plan answers the second half of the problem: how many questions a material deserves and where they go. The learner chooses a **覆盖强度** (coverage strength) when creating a deck from sources, sees what it means for the chosen sources before anything runs, and the program, not the model, makes sure the questions are spread over the material.

### The one table (`lib/coverage-strength.js`)

| level | which leaf sections must get a question | questions per 10,000 characters | per section |
| --- | --- | --- | --- |
| `lean` 精简 | the heaviest sections that together hold ~60% of the weighted content, and at least one section per recording | 3 | 1–4 |
| `standard` 标准 (default) | every leaf section of at least 600 characters; a smaller stub shares its neighbour's question (its range is part of the neighbour's assignment) | 6 | 1–6 |
| `full` 完整 | every leaf section, however small | 10 | 1–8 |

The densities count the leaf sections' characters of evidence (a bilingual transcript counts its original language only, see the end; transcript furniture and headings belong to the non-leaf recording section and are never counted): 6 per 10,000 is about one question per page and a half of a dense textbook. The quota range is per *slot* of 10,000 characters, so a longer section may hold that many times the range and length keeps counting; a quota above the range is cut into slots a planning call can answer. The only limits are sanity bounds (`LIMITS`): 500 questions in all (also the most a custom count may ask) and 400 from one source; a plan that reaches them says so (`capped`, `dropped`) instead of quietly covering less.

`strengthPlan(sections, weights, level, { goalCount })` returns `{ level, goal, leaves, mustCover, quotas, dropped, capped }`; `quotasFor` gives `[{ sectionId, quota, reason }]` in reading order, adding up to the goal. A section's weight is its length times `IMPORTANCE[importance 1..5]` times `KIND_FACTOR[kind]`. The goal is the density times the characters (or the custom total); the quotas are one each, then the rest shared by weight within the range (largest remainder, ties by reading order). Everything is deterministic: the same input gives the same quotas whatever the order of the weights. A custom total rescales within the same rules: fewer than the must-cover sections keeps the heaviest of them, more than the quota ranges hold is cut to what they hold. `assignmentsOf` turns a plan into assignments; `roundsOf` groups them into rounds of at most 30 questions (a quota is never split between rounds), heaviest first, in reading order inside a round.

### Importance (`lib/section-weights.js`)

One light-model call per chunk of about 20 sections, over each section's title, position, size and its first 300 characters, never the whole text (the system text and the chunk's evidence come first, the instructions after: a stable prefix). The reply is `{ sections: [{ id, importance: 1..5, kind, reason }] }`. A reply that cannot be read is asked again like the review of a generation is (the first re-ask says what was wrong, the last gives the exact format), a cut-off reply keeps its complete ratings and only the missing sections are asked for again, and a call that fails stops the asking. Without a light model, or on failure, the weights are the lengths (importance 3, no kind) and the draft says `weightSource: 'length'`. The job weighs the sections when it runs (the form's estimate, which cannot call a model, plans from the lengths: the goal and the sections of 标准 and 完整 are the same either way).

### Enforced planning (`lib/assigned-plan.js`)

A planner that is only hinted to spread its knowledge points over a long material clusters at the start of it (one round of 29 sections raised the covered ones from 7 to 13), so the server enforces the spread. A planning call is given an **assignment**: a few sections with their ranges and quotas (at most 60,000 characters and 10 questions per call), and sees only the text of those sections (pieces of the source with absolute offsets, so every citation still checks against the full stored text). What comes back is validated:

1. every target's quote is located (`lib/quote-locate.js`: as written, then letters and digits only, then an elided quote) inside the range of an assigned section, else it is dropped (`outside`);
2. at most `quota` targets per section (`over-quota`), no repeated passage (`duplicate`);
3. a section whose quota is not met is asked again **once**, alone, with the quota it still lacks, its exact range, and the passages already used for it;
4. what is still missing is recorded: `lib/batch.js` makes one failed part for the sections concerned (range = exactly those sections) with the failure code **`plan-short`** (`lib/generation-failure.js`, described once in `ui/generation-status.js`), so it is a planned-failed section in the coverage view and a line in the failures: never silently dropped.

A failure that repeating cannot fix (a refused key, a stop) is thrown, not turned into dozens of short sections. With a deliberately clustering fake planner (`tests/helpers/clustering-model.mjs`) on the audited 81-section material, one plan puts a question on every must-cover section with exactly its quota (80 of 81; the 81st is the continuation of a recording that starts in the middle of a sentence, which the fake cannot quote: it is reported short with its quota), where the planner alone covers 1 section of 8.

### What is kept, and the rounds

`editorial.coverageSpec = { version, level, goal, leaves, mustCover, custom?, weightSource, weights: [{ sectionId, importance, kind, reason, source }], quotas: [{ sectionId, quota, reason }], rounds: [{ round, questions, sectionIds }], dropped?, capped?, truncated? }`, bounded (600 rows each). The first run makes the first round (the heaviest sections, at most 30 questions); the plan keeps all of them. Phase 3b runs the rest (below); **为没覆盖的部分补题** is the manual way and runs the next round of the plan: an uncovered section costs the quota the plan gave it, the heaviest first, through the same enforced assignments. On the draft page the summary says the plan (「出题计划：标准，约 343 题，分 12 轮」), sections the plan puts in a later round are 「排在后面的轮次」 (not "never planned"), and each row of the list of sections with no question says its importance, what it is, how many questions the plan gave it and the model's reason in one line.

### The request and the limits

`generate { sourceIds, coverageLevel?: 'lean' | 'standard' | 'full', count? }`: `coverageLevel` plans a new draft by its level (default 标准); `count` (1–500) is a custom total; above 30 it is made in rounds of at most 30. A caller that sends only a `count` of 30 or less is planned exactly as before; a `count` above 30 alone is a custom total at the default strength. The answer carries `plan: { level, goal, sections, rounds, round: 1, questions }`. The whole-selection limit of 600,000 characters stays for a request without a plan (the whole selection is sent in calls of 60,000 characters); a request with a plan is bound per call (a call never sees more than 60,000 characters: only its assigned sections) and by a sanity bound on the whole selection of 3,000,000 characters (`LARGE_DOCUMENT_LIMITS.coverageSelectionChars`), because the work it makes is bounded by the 500-question plan, not by the text. Retrieval narrows a coverage selection only above that bound or when asked for.

`usage.estimate { feature: 'generate', sourceIds, coverageLevel?, count? }` prices the plan from the real prompts of the pipeline (every round, the importance calls, the planner's re-asks at the high end of the calls) and adds `coverage: { level, goal, sections, leaves, units, rounds, firstRound, custom?, capped?, levels }`: the creation form's line 「标准：约 343 道题，覆盖 81/81 个部分，分 12 轮，预计 2.2M–3.1M tok · 285–896 次模型调用」 is that answer, and the job that starts makes the plan it promised (a test and the browser journey compare the two). The old clamp of the count to 30 in the pricing is gone.

## Running the plan: rounds one after another (phase 3b, `lib/coverage-run.js`)

Phase 3a plans every round; phase 3b **executes** them. A run is one generation job that makes the rounds of the plan on the same draft, each round the coverage top-up (the enforced assignments, at most 30 questions), one after another, never overlapping. The approved questions stay, each round's questions merge into the draft, `editorial.requested` does not move.

### The draft is the checkpoint

Nothing is kept in a second store:

- `editorial.coverageSpec.rounds[i] = { round, questions, sectionIds, status?, fill?, planned?, kept?, covered?, tokens?, ms?, startedAt?, finishedAt?, reason? }` with `status` one of `pending` (also: none, a plan from phase 3a) | `running` | `done` | `failed` | `skipped`. `planned` is what the round asked for, `kept` the questions it kept, `covered` the sections that had no question and have one now, `tokens` / `ms` what it cost. A **fill round** (`fill: true`) is appended after the planned ones: the sections that were planned and did not come out, written again.
- `editorial.coverageRun = { jobId, autoComplete, state, startedAt, updatedAt, tokensUsed, tokenBudget?, estimate?, stop? }`, written when the run starts and at every round boundary. `state`: `running` | `paused` (between rounds) | `waiting` (manual: the round is done, the learner presses the button for the next) | `stopped` (it ended for a reason: `stop = { reason, at, round, left?, detail? }`) | `complete`.

### What happens after each round (`stepOf`, one function)

| condition | what the run does |
| --- | --- |
| every section the plan wants has a question | stop: `complete` (all rounds ran) or `target` (the target of the level was reached first; the rounds not run are marked `skipped`) |
| `autoComplete` is off | wait for the learner (`waiting`) |
| the token budget the learner set is spent | stop: `budget`, at the boundary |
| the next planned round has sections without a question | run it (a round whose sections were all covered meanwhile is `skipped`) |
| every planned round is done and sections are still without a question | a **fill round** for them, at most `fillRounds` (2) of them per job; then stop: `sections-left` |
| a round covered no section that had none, after its own retries | stop: `no-progress`, with the reason of the failure; the run does not ask again and again |
| the learner stopped it (停在这里 = cancel) | stop: `learner`; everything approved is kept, the round in flight is marked `failed` (`cancelled`) |
| a refused key or no credit | stop: `refused`; a round that failed otherwise and covered nothing is `no-progress`; a first round that left no draft fails the job as it always did |

Each reason is a plain sentence on the job, in the log and on the draft (`ui/coverage/copy.js stopText`). The bound is the rounds the plan lists plus `fillRounds` fill rounds per job; a manual press is the learner's choice and is not bounded.

### 自动补到完整 (manual or automatic)

`generate { sourceIds, coverageLevel, autoComplete?, tokenBudget? }`. `autoComplete` is a checkbox on the creation form, default per level (the one table, `lib/coverage-strength.js`):

| level | 自动补到完整 by default | why |
| --- | --- | --- |
| 精简 `lean` | off | the quick look: its first round already holds the heaviest sections, so it waits for the learner |
| 标准 `standard` | on | the learner asked for completeness |
| 完整 `full` | on | the same |

With it **off** the run does round 1 and waits: the draft page and the console say 「第 1 轮完成，还有 N 轮」 and the one button 为没覆盖的部分补题 runs the next round of the plan (`topUpRound` without section keys is the next planned round: the same function the button's number, the estimate and the job read). It can be flipped any time: on the console header and on the draft page for a run that works (the run goes on, or stops after the round in flight), and on the draft page for a draft that waits (ticking it starts the rest as one run: `generate { resumeDraftId, draftVersion, coverage: { run: true, autoComplete: true } }`). `tokenBudget` (「最多用 X tok」, the form's 花费上限, optional) stops the run at a round boundary once the tokens used reach it.

### Pause, resume, stop, restart

- **暂停**: the round in flight finishes, no new round starts (`pause` is declared `checkpoint` for a coverage run; a plain single-round generation says `single-round`, a run that does not go on by itself says `manual-run`). The status is `pausing` until the round ends, then `paused`, and the console says 暂停于第 i 轮之后. **继续** goes on with the next round. Pause is the boundary between rounds and nowhere else.
- **停在这里** is cancel: it keeps everything approved (the rounds done stay done).
- **重启**: a run that was running when the host stopped is not lost. The draft says `running` / `paused` with rounds not done; the snapshot (and the jobs context) brings it back as an **interrupted** job with the same id and the retry **接着做** (`generate { resumeDraftId, draftVersion, coverage: { run: true } }`), which continues at the next round that is not done. A round that was in flight is run again from its start (the log says so: its partial output is not trusted; the questions that passed review stay). A host that is closed under a run (the plugin is unloaded) is not the learner stopping it: the draft is left as it was and the job becomes `interrupted` with 接着做 at once. One run per draft: resuming twice starts one job and the second call is refused ("this draft is being generated"); a round never runs twice. What it leaves for the unified job runtime: a paused run keeps its place in the library's one queue (other background jobs of the library wait behind it until it is resumed or stopped); the interrupted record lives in memory and is rebuilt from the draft at each start (no job journal, no attempts lineage), a `job.delete` of it is undone by the next start, and the executor is the generation context's, not a shared one.

### Time limits

`jobTimeoutMinutes` (settings, 5-180, default 20) is **per round**; a coverage run has no total limit (it ends by its stop conditions); the 10-minute limit of one model call stays. A round that reaches its limit keeps the questions that passed review (they are saved as they pass) and the run goes on from there; a first round that left nothing fails the job with the reason. A plain one-round generation keeps the limit it always had for the whole job.

### What the screens say (one function: `draftRunFacts` / `runFacts`, one wording set: `ui/coverage/copy.js`)

- The 任务 console header: 「第 3/12 轮 · 覆盖 31% · 已用 1.2M tok · 预计还要 2.0M tok、约 25 分钟」. The projection is the rounds done (tokens and time per planned question times the questions still to make); with no round done yet it is the estimator's number, labelled 「预计还要约 …（出题前的估算）」, and nothing is made up when neither exists. Paused: 「暂停于第 2 轮之后」; waiting: 「第 1 轮完成，还有 11 轮」; interrupted: 「中断于第 3 轮 · 接着做会从第 3 轮继续」.
- The 资料部分 tab lists the **rounds** (state, sections, questions, what each kept and cost; a row opens to its sections); the parts below are those of the round being made. The log has one line per round boundary and one for the reason a run stops.
- The draft page and the home 待发布 row say the same line; the draft page adds the choice 自动补到完整 and the true reason a run stopped.

### Tests

`tests/coverage-run-core.test.mjs` (the pure rules), `tests/coverage-run-exec.test.mjs` (the executor through the service with a fake model that clusters on purpose and a small injected round size: `new StudyService(root, { coverage: { roundLimit, roundTimeoutMs, fillRounds } })`: all rounds in order, manual, 接着做, no progress, fill rounds, budget, pause/resume, cancel, double resume, the toggle, per-round time, a restart simulated by a second service over a copy of the library folder), `tests/coverage-run-ui.test.mjs` (the screens in zh and en), `tests/evidence-chars.test.mjs` (the language of a bilingual transcript). The browser journey is `npm run qa:coverage-run [-- --lang zh|en --theme dark|light --width 1280|420 --accent jade]` (`scripts/qa/coverage-run.mjs`: the merged transcript, a round size of 90 so the plan is three rounds, pause and resume between rounds, a restart over a copy of the library folder, 接着做, manual 精简 with the one button and the toggle on the draft page); the preview takes the same seam as the tests (`createPreviewServer({ coverage })`, the host reads `studyCoverage` from its context).

### One language counts (`evidenceChars`)

A bilingual transcript says every part twice (the original, then its translation). A question density, an importance weight and the estimate count the **evidence** only (`lib/sections.js` `evidenceChars`: the original language; the translation block, the labels and the furniture of a recording are not evidence). On the audited merged transcript (81 sections, 572 427 characters of which 419 537 are evidence) 标准 plans about 251 questions where both languages counted 343 (精简 126 instead of 172, 完整 419 instead of 500): about three quarters of the characters are the original, because the Chinese side of the fixture is shorter than the English. The planning and authoring prompts still send the translation block with the original (phase 5: send only the evidence, with the cited windows).
