# The job contract (v1)

Every background job of StudyHub (audio import, PDF conversion, question run, translation, repair, publication check, a third-party task) is seen by consumers through ONE shape. The 任务 console reads nothing else; a compact card or an agent may too. It is produced by one adapter, `lib/job-contract.js`, over the job records the plugin already keeps. Nothing in it is persisted, and nothing is invented: what a job cannot know is `null` or absent.

The snapshot (`snapshot`, panel only) puts it on each job as `job.contract`. The lean job the chat tools read (`job.status`, `job.wait`, the compact snapshot) does not carry it.

## Shape

```
contract = {
  contractVersion: 1,
  jobId,           what survives a retry (an audio batch's id), else the job's own id
  attemptId?,      the current attempt's id; only for kinds that have retries (audio import)
  kind,            audio-import | pdf-convert | translation | generation | supplement | draft-repair | draft-publish | extension
  title,           the name the learner knows it by, or null
  status,          queued | running | pausing | paused | cancelling | cancelled | complete | failed | interrupted
  endReason?,      user-cancel | superseded     (why a cancelled job ended)
  stage,           { code, args?, text? }       a code the UI translates; `text` is the producer's prose, a fallback only
  progress,        { done, total | null, unit | null, percent | null, segments: [{ stage, done, total }] }
  actions,         { cancel, pause, resume, retry, set }
  result,          { refs: [{ kind: source | draft | deck, id }], completeness: complete | partial | null }
  error,           null | { message, code? }
  usage,           { tokens | null, tokenUsage | null, calls }
  execution,       { mode: direct | subagent | mixed | null }
  detail,          plain data for the kind's own section (audio: files, notices; pdf: route, window; ...)
  startedAt, finishedAt?,
  calls,           [call]
  events           [{ id, at, level: info | step | warn | error | done, tag, code, args, text? }]
}
```

Legacy statuses map as follows: `done` is `complete`; `partial` is `complete` with `result.completeness: "partial"` (a run that ends short of what was asked says so there, never in the status); `superseded` is `cancelled` with `endReason: "superseded"`; a status nobody knows is `failed` once the job has finished and `running` before.

`stage.code` is `<family>.<name>`: `audio.transcribe`, `pdf.parse`, `generation.authoring`, `translation.writing`, `task.running`, or `finished` (with `args.status`) once the job is over. `progress.total` is `null` when it is not known (a PDF before the converter has said how many pages).

## Actions

`job.control {jobId, action, patch?}`, with `action` one of `cancel`, `pause`, `resume`, `retry`, `set`. A patch without an action is `set`. `job.cancel` and `job.dismiss` remain as before. `jobId` may be the contract's `jobId` or the id of an attempt.

Each entry of `contract.actions` is `{ available: true }` or `{ available: false, reason: { code } }`. Legality is decided in ONE place (`checkAction`), from what the kind of job declares and the state it is in; calling an action that is not available is an error carrying the same `code` (`error.code`) and a clear message. A UI draws a button only for an available action and says the reason otherwise.

| code | meaning |
| --- | --- |
| `job-ended` | the job is over |
| `not-ended` | retry only after it ended |
| `not-retryable` | nothing to continue from |
| `capability-unsupported` | this kind of job does not do that |
| `no-safe-checkpoint` | the kind pauses only while queued, and it is running |
| `single-round` | a question run of one round: nothing to pause between (a coverage run of several rounds pauses between them) |
| `manual-run` | a coverage run that does not go on by itself (自动补到完整 off) ends after the round in flight: no boundary to pause at |
| `already-paused`, `not-paused`, `already-cancelling` | the state already is (or is not) that |
| `no-control-yet` | it has not started, so there is nothing to adjust or pause |
| `unknown-action` | not one of the five |
| `archived` | the job is archived: a read-only record (see Archive and delete below); unarchive it first |

### Pause

A kind declares its `pause.mode` (`actions.pause.mode`):

- `unsupported`: no pause. Offered nowhere it is not real: a question run of ONE round keeps nothing a pause could stop at, so it is stopped (what passed review is kept) or left running (`single-round`); a PDF conversion cannot pause either.
- `queued-only`: a job can be held until it starts. Declared by the contract; no kind uses it yet (it needs a library queue that can skip a held job).
- `checkpoint`: audio import, translation and a **coverage run** (lib/coverage-run.js: the rounds of a coverage plan on one draft; the draft keeps every round that is done, so the boundary between two rounds is a safe place). A coverage run pauses between rounds: the round in flight finishes, no new round starts (`pausing` until then, `paused` at the boundary; the console says 暂停于第 i 轮之后). Its `set` settings add the bool `autoComplete` (自动补到完整: after the round in flight it goes on by itself, or ends and waits for the learner); `retry` is 接着做 for a run the last process left running (the draft is the checkpoint: it continues at the next round that is not done); `detail.run` carries `{ rounds, round, done, left, percent, tokensUsed, projection, state, auto, pausedAfter?, stop?, list: [{ round, questions, status, fill, kept?, covered?, tokens?, ms? }] }`. Audio import and translation: Pause stops dispatching new calls and lets the admitted ones finish. The status is `pausing` (with `actions.pause.waiting = { reason: "calls-in-flight", count }`) until nothing is in flight, then `paused`; the audio batch writes its manifest at that boundary (finished windows are already kept in their checkpoints, so a restart continues from them). A pause that only blocked new calls with nothing checkpointed is never offered.

### Set

`actions.set.settings` lists what can be changed while the job runs, each `{ key, type: int | enum | bool, min?, max?, values?, value }`: audio `textConcurrency` (1-6), `transcribeConcurrency` (1-3), `proofreadReasoning`, `translateReasoning`, `autoBackoff`; generation `concurrency` (1-8) and the reasoning of each stage; translation `concurrency`. A change applies to LATER dispatch only and interrupts nothing: lowering a limit makes new calls wait, raising it admits waiting ones, and the automatic back-off never raises the limit above the configured cap. The reply is `{ applied, changed, values }`: `applied` is what is now in force for the keys asked. `pause` and `resume` are actions, not settings.

### Retry

`retry` starts a new attempt from what is kept (`audio.retry`, `mineru.retry`). The new attempt has a new `attemptId` and the same `jobId`.

## Archive and delete (2.6.1)

Finished jobs (`complete`, `failed`, `cancelled`, `interrupted`) can be put away without being lost, and removed for good in batches. Nothing here changes what a job is while it runs.

| operation | what it does |
| --- | --- |
| `job.archive {jobId \| jobIds \| all: true}` | Moves finished jobs out of the default list into a read-only record. Nothing is deleted: an audio batch's folder stays where it is, and the sources, drafts and decks a job made are untouched. Reply `{ archived, alreadyArchived, skipped, missing }`. A running, queued or stopping job is refused when it is the only id asked for (the same words as `job.dismiss`) and is `skipped: [{ id, reason: "running" }]` in a list. Archiving twice is harmless. A day of 为你定制 is skipped (`not-archivable`: its own file keeps fourteen days). At most 100 ids. |
| `job.unarchive {jobId \| jobIds}` | Puts the record back in the list. An audio batch or a PDF conversion whose folder is still on disk is read again the way a restart reads it (retry works); anything else comes back from its record as an ended job (nothing to retry; 打开结果 works while its target exists). Reply `{ unarchived, missing }`. |
| `job.delete {jobIds}` | Removes records for good: finished jobs and archived records. For audio the working copy of the batch is cleaned in the background (`lib/job-cleanup.js`); the imported sources, the drafts and the decks are never touched. A running job is skipped (`skipped: [{ id, reason: "running" }]`), unknown ids are `missing`. At most 100 ids per call. Deleting an archived record removes it from the archive. |
| `job.dismiss {jobId \| jobIds \| all: true}` | Unchanged: removes finished records for good (the same removal as `job.delete`; running jobs are refused). It also removes an archived record by id. The 任务 console's 「知道了」 no longer calls it: it calls `job.archive`, so a finished task is put away, not lost. |

**Where the archive lives.** One file next to the library, `<library>/job-archive.json` (`{ version: 1, records: [...] }`, written atomically and queued per library, like `coach-daily.json`; never inside an audio batch folder). A record is `{ id, ids, archivedAt, files?, legacy?, auto?, job: { id, archived: { at, auto? }, contract } }`. `id` is what survives a retry (the contract's `jobId`), `ids` is every name the job answers to, `files` is the batch folder name (only remembered, never touched), and `contract` is the job's contract as the console draws it. It is read-only (every action is `{ available: false, reason: { code: "archived" } }` and `archivedAt` is set) and bounded: no output previews, no buffers, no settings, no keys, no library path, at most the newest 60 calls and log lines, and at most 12 000 characters per record.

**Limits.** The file keeps the **newest 200 records of the last 90 days**; the oldest fall off, and an audio batch's working copy falls off with its record. A finished job that the in-memory list trims (more than 100 finished jobs) is archived first (`auto: true`) instead of vanishing.

**Reading it.** The library snapshot carries `archivedJobs` (newest archived first; not in the compact snapshot an agent reads), so the console needs no second data source. After a restart an archived audio batch is not brought back into the list, but its record is. `job.control` on an archived job fails with `code: "archived"`.

## Calls

```
call = { callId, jobId, attemptId?, stepKey, kind, stage, slot | null,
         queuedAt?, startedAt, firstOutputAt?, endedAt, status, runner, childId, parentId,
         part, parts, reasoning, tokens, file?, reason? }
```

`kind` is `transcribe | proofread | translate | title | plan | blueprint | author | review | repair | publish | wait | other`; `status` is `running | ok | failed | cancelled | skipped | waiting` (a rate-limit back-off is a call of `kind: "wait"`, `reason: "rate-limit"`). `runner` is `subagent` (DSH sub-agent; `childId` opens it where the host can), `direct`, `gemini` ... A retry or a fallback is a call of its own with the same `stepKey`. A time is present only when it was observed: `queuedAt` is derived from the wait for a free slot where the job measured it, `firstOutputAt` is set when the first text arrived; a missing one stays missing. At most 300 calls are kept per job (the newest), 100 waits, 200 events.

## Live output

`job.output {jobId, callId, cursor}` returns `{ supported, live, text, nextCursor, truncated, reasoningChars, retention: { unit: "chars", limit: 8192, persisted: false, endedCalls: 60 } }`. `cursor` is the `nextCursor` of the previous answer (0 to start); only the text after it is returned. `truncated: true` means the cursor is older than what is kept (or from another buffer), or that the answer is a whole replacement (`source: "session"`): `text` is what to show, the reader replaces what it shows and re-reads the snapshot; nothing depends on replaying a full log. `supported: false` is a call that offers no text on the way (a Gemini request); a call through the host model is opened for output from its first moment, even before its first character.

**A running call** is read from a bounded in-memory buffer (the last 8192 characters, plus a count of everything written). **An ended call keeps its tail** (2.6.1): when the call ends its buffer is marked ended and kept, together with the buffers of the 60 most recently finished calls (oldest finished first out; each is capped at 8192 characters, so the whole store stays under about half a megabyte). It is memory only: never persisted, gone when the host restarts (`retention.persisted` stays `false`). `job.output` for an ended call answers `ended: true, retained: true, source: "memory"` with that tail, readable from cursor 0 once (then nothing new); `writtenChars` is how much the call wrote in all, and `partial: true` says the tail is shorter than that.

**The final reply of a DSH sub-agent is read from its session on demand.** When an ended call has a `childId` and the kept tail is shorter than what was written, or no tail is left (older than the 60, or after a restart), `job.output` reads the child's last `assistant/message` that has text blocks from the DSH session store (`ctx.get('sessionQuery').observeSession(childId)`, the same lease as the token-usage read; the jobs context gets it as the port `ports.sessions.lastReply`, `lib/session-reply.js`) and answers `source: "session"` with that text, at most 200 KB (`clipped: true` when it was longer; the beginning is kept). `retained` says whether a tail was also still in memory. A session that cannot be read is not an error: the answer keeps whatever tail there is and adds `sessionUnreadable: true`. The session is never read for a running call, for a reader that already has the text (`cursor > 0`), or for a call without a sub-agent; a call that never offered text (a Gemini request) answers `supported: false, retained: false` with an empty text.

The text comes from the model path of this plugin: the direct streamed call, and, for a DSH sub-agent, the process-local `agent/assistant-stream` events DSH publishes for each model attempt (`dsh-agent-loop`, verified in DSH 0.2.0-rc.2: a listener of an unscoped context receives every agent's, and the plugin picks its child by id).

## Parts of a question run

`detail.partList` (generation, supplement) is one entry per part: `{ part, status, stages: { author?, review?, repair? }, sourceIds?, sourceCount?, range?, asked?, kept?, reasons? }`. `asked`, `kept` and `reasons` (codes `quote | plan | quality | other`) appear once the run has reported (`partReport`). `sourceIds` (each source once, at most 20), `sourceCount` (how many there really are) and `range` (a short label of at most 80 characters, such as "Book · 第 12–14 页", written in the job's language) say what the part covers; they come from the job's `partPlan` (`[{ part, sourceIds, sourceCount, label }]`, lib/part-plan.js), which the run writes when it plans its parts, so a part that is still waiting has them too. A job without a plan (an older run, a case paper, a translation) has parts without these three fields. The 任务 console's 在资料中查看 opens the reader on the first of `sourceIds` that is still in the library, through the app's own handler (`partOpener` in ui/tasks/task-actions.js, the handler `resultOpener` uses for transcripts and conversions).

## What each kind could and could not map

| kind | maps | does not map |
| --- | --- | --- |
| audio-import | everything: batch identity + attempt, per-file rows, grouped notices, pause (checkpoint), set, retry, calls with slots and waits, live output of host-model windows | live output of Gemini transcription and Gemini text (no stream); the stage of a batch is the batch's phase, per-file stages are in `detail.files` |
| pdf-convert | status, stage, progress (total unknown until reported), retry, result refs, detail (route, window) | pause, set, calls (the converter reports none), live output |
| translation | status, progress, pause (checkpoint at a wave), set concurrency, calls, live output | retry (a new translation is started, never twice) |
| generation, supplement | status, stage, progress in questions, set (concurrency, per-stage reasoning), calls with slots and waits, live output, result refs (draft/deck); a coverage run (generation): pause between rounds, `autoComplete`, 接着做 after a restart, `detail.run` | pause of a one-round run (nothing is checkpointed), retry of a plain run (continuing a draft is its own action) |
| draft-repair, draft-publish | status, stage, progress (repair), cancel (repair only), result refs | calls and controls (their own loops do not record them yet) |
| extension tasks | status, stage, progress, cancel | everything else |
| coach-daily (为你定制) | ONE row per local day (`jobId: "coach:YYYY-MM-DD"`, kept in `<library>/coach-daily.json`, the last 14 days; the snapshot shows seven): its batches as calls of kind `prep` (when, cards asked, written, kept, skipped, tokens in / out / cache, a `reason` code when a batch wrote nothing), the day's figures (`detail.metrics`: generated, passed, practised, correct, accuracy, skippedExpired; practice is read from the attempts on the 为你定制 deck, never copied), pause today (`pause`, mode `checkpoint`: no new batch starts, the one in flight finishes), resume, and `set` (`maxBatchesPerDay` 1-48, `maxReady` 1-12, `reasoning` lowest..highest; applies from the next batch). Only today's row can be adjusted; a past day is a record and `job.dismiss` removes it | cancel (a day is a record, not a run: `capability-unsupported`), retry, live output (a batch writes no stream) |
