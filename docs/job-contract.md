# The job contract (v1)

Every background job of StudyHub (audio import, PDF conversion, question run, translation, repair, publication check, a third-party task) is seen by consumers through ONE shape. The 任务 console reads nothing else; a compact card or an agent may too. It is produced by one adapter, `lib/job-contract.js`, over the job records the plugin already keeps. Nothing in it is persisted, and nothing is invented: what a job cannot know is `null` or absent.

The snapshot (`snapshot`, panel only) puts it on each job as `job.contract`. The lean job the chat tools read (`job.status`, `job.wait`, the compact snapshot) does not carry it.

## Shape

```
contract = {
  contractVersion: 1,
  jobId,           what survives a retry (an audio batch's id), else the job's own id
  attemptId?,      the current attempt's id; only for kinds that have retries (audio import)
  kind,            audio-import | pdf-convert | translation | generation | supplement | draft-repair | draft-publish | coach-daily | extension
  title,           the name the learner knows it by, or null
  status,          queued | running | pausing | paused | cancelling | cancelled | complete | failed | interrupted
  endReason?,      user-cancel | superseded     (why a cancelled job ended)
  continuedBy?,    the jobId of the task that continued this one (接着做 of a plain question run): the record stays as it ended, with its own numbers, and offers nothing more (retry: `continued`)
  stage,           { code, args?, text? }       a code the UI translates; `text` is the producer's prose, a fallback only
  progress,        { done, total | null, unit | null, percent | null, segments: [{ stage, done, total }] }
                   a question run's progress is the questions kept over what the PLAN asked for (a coverage run's whole plan, not the round it is making); `percent` is 100 only when nothing is
                   missing: a run that stopped short (budget, no progress, sections left, a refused key), waits for the learner after round 1, or holds fewer questions than it was asked for is never 100
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
| `continued` | it was continued already (`reason.by` is the task that continued it): its numbers stay as they were and the new progress is there |
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
         part, parts, reasoning, tokens, outputTokens?, timing?, file?, reason? }
```

`outputTokens` is the provider's own completion count and `timing` is DSH's `sessionStats` for the child session the
call ran in, when the host served one (`{ ttftMs, ttftSteps, decodeMs, decodeTokens }`): together with the three
timestamps they are what the console's 首 token 平均（TTFT）/ 输出速度（TPS） are folded from (`lib/job-timing.js`).
Both are absent when nobody observed them, and a count is never derived from the text.

`kind` is `transcribe | proofread | translate | title | plan | blueprint | author | review | repair | publish | prep | wait | other`; `status` is `running | ok | failed | cancelled | skipped | waiting` (a rate-limit back-off is a call of `kind: "wait"`, `reason: "rate-limit"`). `runner` is `subagent` (DSH sub-agent; `childId` opens it where the host can), `direct`, `gemini` ... A retry or a fallback is a call of its own with the same `stepKey`. A time is present only when it was observed: `queuedAt` is derived from the wait for a free slot where the job measured it, `firstOutputAt` is set when the first text arrived; a missing one stays missing. At most 300 calls are kept per job (the newest), 100 waits, 200 events.

## Live output

`job.output {jobId, callId, cursor}` returns `{ supported, live, text, nextCursor, truncated, reasoningChars, retention: { unit: "chars", limit: 8192, persisted: false, endedCalls: 60 } }`. `cursor` is the `nextCursor` of the previous answer (0 to start); only the text after it is returned. `truncated: true` means the cursor is older than what is kept (or from another buffer), or that the answer is a whole replacement (`source: "session"`): `text` is what to show, the reader replaces what it shows and re-reads the snapshot; nothing depends on replaying a full log. `supported: false` is a call that offers no text on the way (a Gemini request); a call through the host model is opened for output from its first moment, even before its first character.

**A running call** is read from a bounded in-memory buffer (the last 8192 characters, plus a count of everything written). **An ended call keeps its tail** (2.6.1): when the call ends its buffer is marked ended and kept, together with the buffers of the 60 most recently finished calls (oldest finished first out; each is capped at 8192 characters, so the whole store stays under about half a megabyte). It is memory only: never persisted, gone when the host restarts (`retention.persisted` stays `false`). `job.output` for an ended call answers `ended: true, retained: true, source: "memory"` with that tail, readable from cursor 0 once (then nothing new); `writtenChars` is how much the call wrote in all, and `partial: true` says the tail is shorter than that.

**The final reply of a DSH sub-agent is read from its session on demand.** When an ended call has a `childId` and the kept tail is shorter than what was written, or no tail is left (older than the 60, or after a restart), `job.output` reads the child's last `assistant/message` that has text blocks from the DSH session store (`ctx.get('sessionQuery').observeSession(childId)`, the same lease as the token-usage read; the jobs context gets it as the port `ports.sessions.lastReply`, `lib/session-reply.js`) and answers `source: "session"` with that text, at most 200 KB (`clipped: true` when it was longer; the beginning is kept). `retained` says whether a tail was also still in memory. A session that cannot be read is not an error: the answer keeps whatever tail there is and adds `sessionUnreadable: true`. The session is never read for a running call, for a reader that already has the text (`cursor > 0`), or for a call without a sub-agent; a call that never offered text (a Gemini request) answers `supported: false, retained: false` with an empty text.

The text comes from the model path of this plugin: the direct streamed call, and, for a DSH sub-agent, the process-local `agent/assistant-stream` events DSH publishes for each model attempt (`dsh-agent-loop`, verified in DSH 0.2.0-rc.2: a listener of an unscoped context receives every agent's, and the plugin picks its child by id).

## Parts of a question run

`detail.partList` (generation, supplement) is one entry per part: `{ part, status, stages: { author?, review?, repair? }, sourceIds?, sourceCount?, range?, asked?, kept?, reasons? }`. `asked`, `kept` and `reasons` (codes `quote | plan | quality | other`) appear once the run has reported (`partReport`). `sourceIds` (each source once, at most 20), `sourceCount` (how many there really are) and `range` (a short label of at most 80 characters, such as "Book · 第 12–14 页", written in the job's language) say what the part covers; they come from the job's `partPlan` (`[{ part, sourceIds, sourceCount, label }]`, lib/part-plan.js), which the run writes when it plans its parts, so a part that is still waiting has them too. A job without a plan (an older run, a case paper, a translation) has parts without these three fields. The 任务 console's 在资料中查看 opens the reader on the first of `sourceIds` that is still in the library, through the app's own handler (`partOpener` in ui/tasks/task-actions.js, the handler `resultOpener` uses for transcripts and conversions).

## The time limit of a job

`detail.timeLimit` (generation, supplement, translation) is `{ seconds, scope, callSeconds, keeps }`, taken from the job record (`totalTimeoutSeconds`, `generationTimeoutSeconds`) when the job was started; a record without `totalTimeoutSeconds` has no `timeLimit`, and a consumer shows nothing for it. An archived contract carries it with the rest of `detail`; one archived before the field existed simply lacks it.

- `scope: 'run'`: the limit is for the whole run (a plain question run, a supplement of a deck). It is the setting 每轮运行时限（分钟） of 设置 › 出题偏好 (`jobTimeoutMinutes`, 5 to 180) as it was when the run started; changing it does not touch a run that has started.
- `scope: 'round'`: a **coverage run** (`job.coverageRun`) has the same limit for EACH round and none for the run as a whole. A round that reaches it keeps the questions that passed review (`detail.run.list[i].reason === 'timeout'` names it) and the run goes on.
- `scope: 'fixed'`: a limit nobody sets: a translation's 60 minutes (`TRANSLATION_JOB_TIMEOUT_MS`), a selection run's 20 minutes (`origin: 'selection'`, `GENERATION_JOB_TIMEOUT_MS`).
- `callSeconds`: the limit of ONE model call (`GENERATION_TIMEOUT_MS`, 10 minutes), which no setting changes and which is independent of the run's limit; `null` when the job records none.
- `keeps`: what a stop by the limit leaves: `questions` (the ones that passed review, saved as they pass), `paragraphs` (the ones already translated), `nothing` (a selection run saves nothing until it is done).

A consumer decides that a job ENDED BY THE LIMIT with the classifier of the list row (`ui/generation-status.js` `hitTimeLimit`, the `budget` row of `FAILURES`, over `error.message`, else `stage.text`) and never with a second pattern. The console's strip (`ui/tasks/TimeLimit.jsx`) says the limit, what is used (`已用`, the same number as the facts row; for a limit per round, the time since the round in flight made its first call), what is kept and the steps that took the time (`ui/tasks/time-limit.js`: past 3 x the median of the other finished steps of its kind and past 2 minutes, or, for a job that ended by its limit, its longest step); the link 调整时限 opens the one editor of the setting (`openSettings('settings-generation-time')`) and is offered only for `run` and `round`.

## What each kind could and could not map

| kind | maps | does not map |
| --- | --- | --- |
| audio-import | everything: batch identity + attempt, per-file rows, grouped notices, pause (checkpoint), set, retry, calls with slots and waits, live output of host-model windows | live output of Gemini transcription and Gemini text (no stream); the stage of a batch is the batch's phase, per-file stages are in `detail.files` |
| pdf-convert | status, stage, progress (total unknown until reported), retry, result refs, detail (route, window) | pause, set, calls (the converter reports none), live output |
| translation | status, progress, pause (checkpoint at a wave), set concurrency, calls, live output | retry (a new translation is started, never twice) |
| generation, supplement | status, stage, progress in questions, set (concurrency, per-stage reasoning), calls with slots and waits, live output, result refs (draft/deck); a coverage run (generation): pause between rounds, `autoComplete`, 接着做 after a restart or a failed round, `detail.run`; a plain run (a count, no plan) that ended before it was done and kept a draft: 接着做 = `retry` (the executor marks the record `retryable`; `job.control retry` starts `generate { resumeDraftId, draftVersion }`, which keeps every approved question and makes the questions the run was asked for and did not get, with its own settings) | pause of a one-round run (nothing is checkpointed) |
| draft-repair, draft-publish | status, stage, progress (repair), cancel (repair only), result refs | calls and controls (their own loops do not record them yet) |
| extension tasks | status, stage, progress, cancel | everything else |
| coach-daily (为你定制) | ONE row per local day (`jobId: "coach:YYYY-MM-DD"`, kept in `<library>/coach-daily.json`, the last 14 days; the snapshot shows seven): its batches as calls of kind `prep` (when, cards asked, written, kept, skipped, tokens in / out / cache, a `reason` code when a batch wrote nothing), the day's figures (`detail.metrics`: generated, passed, practised, correct, accuracy, skippedExpired; practice is read from the attempts on the 为你定制 deck, never copied), pause today (`pause`, mode `checkpoint`: no new batch starts, the one in flight finishes), resume, and `set` (`maxBatchesPerDay` 1-48, `maxReady` 1-12, `reasoning` lowest..highest; applies from the next batch). Only today's row can be adjusted; a past day is a record and `job.dismiss` removes it | cancel (a day is a record, not a run: `capability-unsupported`), retry, live output (a batch writes no stream) |

<a id="proposed-v2-s1-1-contract-review"></a>

## Accepted v2: S1-1 versioned reads

**Accepted read contract; legacy production remains v1.** [PR #245](https://github.com/EricWang1358/dsh-web-studyhub/pull/245) merged as `169a69ee8c64476576ce5bbc4ef9331d2db8ee1e` before compatibility implementation. The canonical [production schemas and version reader](../lib/jobs/contract.js) now validate explicitly declared v1/v2 data; [synthetic fixtures](../tests/fixtures/unified-runtime-contract.mjs) import that same implementation. `lib/job-contract.js` still exports `CONTRACT_VERSION = 1` for ordinary legacy records. Saved and already projected reads preserve their declared version; restored v2 history retains runtime metadata and uses the existing action judge with its declared capabilities. Compatibility targets and entry-point differences remain in [the S1-1 matrix](plans/unified-job-runtime/s1-1-compatibility.md). [Implementation evidence and limits](plans/unified-job-runtime/s1-1-compatibility-implementation.md) distinguish read validation from the later executor and lifecycle work.

The accepted prerequisite is [S1-0 / PR #241](https://github.com/EricWang1358/dsh-web-studyhub/pull/241), merge `f091f09f830c226bfebc9af22344896733893a10`. The alpha branch also incorporates official 2.6.1, commit `e61f6debe9436794cafc2bc8c65a0d0164e5ac5e`; its archive and ended-output behavior above is part of the compatibility baseline. Acceptance preserves the S1-0 unverified limits. In particular, final StudyHub scope/Agent/controller binding is still an implementation gate.

### Versions and read boundaries

| Record | Required result |
| --- | --- |
| Published v1 record | Keep its v1 projection and existing queries/actions. A missing runtime identity, owner, executor, checkpoint or loss observation cannot be reconstructed from legacy status or token totals. |
| v2 record with observed runtime metadata | Validate the same public read fields plus the metadata below. Preserve extra public read fields so a consumer does not discard kind-specific additions. |
| Missing or unknown `contractVersion` | Reject with `unsupported-contract-version`; do not guess a version or start an executor. |
| v2 with unknown `runtime.schemaVersion` | Reject with `unsupported-runtime-schema-version`; preserve the stored source for investigation. |
| Invalid shape / identity references | Reject with `invalid-contract-shape` / `invalid-contract-reference`. |
| Contradictory call observation / capabilities | Reject with `invalid-call-observation` / `inconsistent-capability`. |

These codes describe the proposed validator. They do not change the errors emitted by published v1 operations. A version reader and any storage upgrade still need separate implementation tests. Public read objects remain extensible; capabilities, runtime metadata, physical Attempt/Step metadata and call observation are closed so misspelled control fields are rejected.

### Job and capabilities

All v1 read fields remain: identity, kind/title, status/end reason, stage/progress, actions/result/error, usage/execution/detail, times, calls and events. v2 sets `contractVersion: 2` and adds:

```js
capabilities = {
  cancel, retry, set,                         // booleans declared by the definition
  pauseMode: 'unsupported' | 'queued-only' | 'checkpoint',
  recoveryMode: 'none' | 'retry-from-start' | 'resume-checkpoint',
  executionModes: ['direct' | 'subagent']      // permitted managed model modes
}
runtime = {
  schemaVersion: 1, definitionVersion, scopeId,
  legacyId?,                                 // an actually created legacy facade record ID
  activeAttemptId: string | null,
  attempts: [attempt], steps: [step]
}
```

`jobId` is the logical business identity. Root `attemptId`, when present, is the **latest physical Attempt**; `runtime.activeAttemptId` selects the currently active one. An unadmitted Job can have neither a physical Attempt nor a root attemptId. At most one Attempt is active. The version and scope are admission facts recorded by the sole lifecycle writer, not values inferred from a legacy name or Symbol. The latest Attempt matches runtime.definitionVersion; historical Attempts retain their original versions. A definition and policy snapshot stay fixed while their Attempt is in flight. The snapshot contains approved execution/limit/settings values, never credentials or an entire host/session configuration.

`actions` continues to state what is legal now, with the existing five action names and refusal codes. Capability booleans describe what the definition can do, not whether a button is available in this state. Unsupported pause/resume, an available action with a false capability, or a pause mode that disagrees with `actions.pause.mode` is rejected. `queued-only` cannot offer pause after execution has started. Recovery describes restart behavior independently of user pause and explicit retry; `none` does not mean the kind can never be explicitly retried.

The nine Job states remain `queued/running/pausing/paused/cancelling/cancelled/complete/failed/interrupted`. Partial completion is still in `result.completeness`, not a lifecycle state. Old status aliases are read through the published projector; v2 writes use only canonical states. The [state and action tables](plans/unified-job-runtime/s1-1-compatibility.md#4-状态与动作) specify the proposed transitions and the v1 refusal order separately.

### Physical Attempts and Steps

```js
attempt = {
  jobId, attemptId, definitionVersion,
  status: 'queued' | 'running' | 'pausing' | 'cancelling'
        | 'complete' | 'failed' | 'cancelled' | 'interrupted',
  executor: null | { service: 'dsh-jobs', handleId, ownerAgentId },
  policySnapshot,                            // captured plain data, not mutable configuration
  startedAt?, finishedAt?,
  endReason?: 'checkpoint-pause' | 'user-cancel' | 'superseded' | 'executor-lost',
  checkpointRef?
}
step = { jobId, attemptId, stepKey, stepRunId,
         status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled' | 'interrupted' | 'skipped',
         checkpointRef? }
```

An executor reference contains only an observed host handle and its legitimate registered live Agent. An unknown or pending binding has `executor: null`; that does not authorize execution without a legitimate owner. Neither model mode (`direct/subagent`) nor a fabricated owner ID is an executor binding. `scopeId` is a persisted association; authorization still uses the real plugin scope and host owner, retaining the legacy Symbol/domain fence. DSH's `running/stopping/completed/killed/failed` handle states are not the nine business states.

A checkpoint pause stops new dispatch, waits for admitted work to reach a safe boundary, successfully saves the checkpoint and releases actual resources. That physical Attempt ends as `complete` with `endReason: 'checkpoint-pause'` and the saved reference. The Job is `paused`, its latest attemptId remains, and activeAttemptId becomes null. Resume creates a new physical Attempt. `paused` is not a physical Attempt state. A held, unadmitted queued-only Job need not have an Attempt.

A terminal Job has no active Attempt and agrees with its latest physical terminal status when an Attempt exists. Cancelling an already checkpoint-paused Job is the exception: the Job becomes cancelled while its ended checkpoint Attempt stays complete; that history is never rewritten. Cancellation before admission may have no Attempt. A running Job requires an active physical Attempt; if a queued Job has an active Attempt, that Attempt is still queued. An ended checkpoint-pause Attempt cannot by itself complete the logical Job.

The legacy facade keeps its visible ID and published control/wait semantics across this physical pause/resume by delegating to the sole lifecycle owner; explicit retry creates a new legacy ID as the old path already does. A physical checkpoint pause must not complete the old observer wait or send an old terminal notification. It must not keep an independent execution promise/controller or settlement layer. This facade is a target for the next implementation PR, not supplied by the schema fixture.

`stepKey` names a logical unit of work; `stepRunId` identifies one execution of that unit within a particular Attempt. IDs must be unique in their relevant collection and all Job/Attempt/Step references must agree. A reference alone does not prove that a checkpoint is valid, persisted or safe to resume; S1-5 must verify those conditions.

### Call observations

A v2 Call keeps the v1 Call fields and adds optional `stepRunId` plus:

```js
observation = {
  boundary: 'external-request' | 'host-attempt' | 'legacy' | 'local-wait' | 'local-process',
  requestCount: integer | null
}
```

| Boundary | Meaning / requestCount |
| --- | --- |
| `external-request` | One actually observed wire request; count 1. Each observed transport retry is another Call observation. |
| `host-attempt` | One host-visible model attempt; internal requests were not observed, count null. |
| `legacy` | A published producer record with no wire observation, count null. |
| `local-wait` | Local queue/rate-limit waiting, count 0. |
| `local-process` | A local child process or host tool call the plugin cannot count as wire requests (install, model preparation, search-extension ingest); count null, never a model request. |

A fallback or format repair has its own Call and stable stepKey; an actual execution can associate it with stepRunId. Observation does not add another retry policy or infer hidden host retries. The existing `usage.calls` remains the published summary (tokenUsage.calls or producer-record count); it is not reinterpreted as actual HTTP requests.

Unknown totals/percent, times, tokens and host lineage remain null or absent according to the read contract. Historical v1 detail defaults are compatibility facts, not observations that authorize a v2 writer to fill unknown values with zero. Missing child/parent IDs cannot create session links. Live output keeps its UTF-16 cursor and bounded, in-memory retention; the host byte ring is not substituted.

### Archived and restored v1 records

Official 2.6.1 keeps archived contracts read-only and delegates archive, unarchive, delete and dismiss to the existing archive service. Its saved and restored v1 records stay v1 when they lack runtime admission evidence; they must not acquire invented Attempts, owners or checkpoint references. Unarchive restores a record and does not dispatch an executor. The adapter must preserve existing aliases and refusal order and use the same archive writer, including its bounds and removal behavior. Any future v2 archive writer must preserve the declared version and required runtime fields together; it cannot store a v2 marker after dropping its required metadata.

### One writer per operation

| Field or operation | Sole responsibility for the migrated path |
| --- | --- |
| Definition version/capabilities | Registry declaration, validated before admission. |
| Logical identity, physical Attempts, active selection, lifecycle and stable completion event | Core lifecycle writer over the existing shared business records. |
| Host executor handle, stop and execution settlement | Verified DSH service/owner binding. The adapter relates it to the business Job; it does not add a second queue or independent settlement. |
| Domain progress/detail, checkpoints, result refs and artifacts | Existing domain writer, admitted by current Attempt and business-version checks. A stale Attempt cannot submit artifacts. |
| Runtime metadata in a domain manifest | One authorized lifecycle/store writer; the old worker relinquishes these fields for the pilot. Domain fields retain their domain writer and serialized file writes. |
| Calls and observed model usage | Model gateway for the migrated path; existing ledger writer retained with a stable deduplication identity. |
| Actual permits / 429 / transport retry | The approved existing/shared resource and retry owner; S1-3/4 must verify the common counters and policy. |
| Completion delivery | Business notification adapter reads the one completion event and legacy facade ID; delivery failure cannot change the terminal state. |

This follows [DSH-01/02/03/04/07/08/09](plans/unified-job-runtime/s1-0-dsh-capabilities.md#固定行-id-能力对照). The fixture uses the existing direct `schemastery@3.18.0` dependency. Its small relationship checks express business identity and capability invariants missing from primitive field schemas; they are not a new validation framework, lifecycle engine, task table, scheduler or provider wrapper.

The [golden compatibility vectors](../tests/fixtures/unified-runtime-compatibility.json) contain actual v1 projector outputs from synthetic old records. Their proposed v2 records explicitly list additional synthetic admission/checkpoint/host-loss premises. Passing them proves schema and projection expectations; it does not prove production control, ownership, persistence, recovery, UI links or facade behavior. The later implementation must exercise real public operations against this contract and the default-off audio pilot.

### Managed gateway admission (S1-4)

The [gateway interface and ownership contract](plans/unified-job-runtime/s1-4-gateway-contract.md) defines explicit purpose/feature/effort/mode/budget admission, Step/Call observation and the existing ledger deduplication boundary. These additive v2 Call read extensions preserve contract version 2; v1 producers remain unchanged. Publication does not claim gateway implementation or persistence acceptance.

### Durable admission and recovery (S1-5)

The [durable lifecycle contract](plans/unified-job-runtime/s1-5-store-contract.md) places the canonical v2 record in the existing domain manifest's explicitly versioned `runtimeJob` envelope. Public contract version 2 and runtime schema 1 are unchanged; the storage envelope has its own schema version. Legacy manifests remain legacy. Recovery requires positive executor-loss evidence, input/version/checkpoint validation and reconciliation of uncertain requests and artifact commits. Request intents do not count as observed Calls. Publication of this interface is not evidence that persistence or recovery is implemented.

### Default-off public audio pilot (S1-6)

The [audio pilot adapter contract](plans/unified-job-runtime/s1-6-audio-contract.md) adds trusted admission, presentation/control, checkpoint-boundary and bounded output ports without changing public contract version 2. `runtime.pilot.audioSingle` defaults off and selects only new single-file admissions; existing Attempts and managed recovery retain their owner and path. A skipped cached unit retains the non-wire producer observation (`legacy`, requestCount null, `modelRequest:false`), never an observed model request. `local-wait` remains reserved for actual wait records. Publishing this contract does not enable or certify the public pilot.

### Default-off translation pilot (S4-2)

`runtime.pilot.translation` (default off, new submissions only) runs each page or chapter translation started through `generation.translation.start` as a Job of kind `translation` (capabilities: `cancel`, `set`, `pauseMode: checkpoint`; no `retry`; `recoveryMode: none`; `executionModes` `direct` and `subagent`; result ref `{ kind: 'source', id }`). The paragraphs, the glossary, the document revisions and the per-library write locks stay in materials; the job still waits in the one `queues(root)` chain it shared with generation (order unchanged), now as the Job's admission. Every batch is a Step of the gateway (`translate`, `part` = batch number, agent-preferred as the generation path always was) and its usage is booked once, by the gateway. Pause is real: at a wave boundary the Attempt ends with its waves kept and the library queue is released; a resume is a new Attempt that queues again and asks only what has no translation yet (the live concurrency setting returns to the submitted one). The one-hour budget is still the executor's own timer: a budget stop ends the Job `failed` with outcome `budget` and a late answer is not kept. Two differences from the legacy path, both fixes found by the S4-0 baseline: the glossary is frozen in the submitted input (D1), and cancelling a queued translation ends it at once (D8). Immediate translations of a selection or one material passage are not jobs and do not change. With the switch off nothing here is reachable.

### Default-off translation scheduling (S4-3)

`runtime.pilot.translationParallel` (default off, its own switch: it applies to the in-process path and to `runtime.pilot.translation` alike, and to new submissions only) takes translation out of the library's one queue. Until then a translation waits behind everything the library accepted (generate, supplement, selection fill, repair, publish) and everything waits behind it. With the switch a translation waits in a chain of its own per document (`translation/lane.js`: `<root>\0translation:<documentId>`), so it overlaps whole-library generation, and two documents overlap each other; two translations of the same document stay one at a time. `queuedBehind` then counts the active translations of that document. Nothing else of the queue changes; the generation side keeps its chain, order and locks.

What each side reads and writes, which is why that is safe:

| Writer | Writes | Reads | Chain |
| --- | --- | --- | --- |
| translation | the `translations` record of one document revision (one atomic `update` per kept paragraph batch) | the stored text of that revision, its glossary | per document |
| generate / supplement / selection fill | drafts, decks, coverage, usage | the text of the sources | the library's chain |
| draft repair / publish | one draft, the deck it publishes into | that draft, the sources | the library's chain |

No generation path reads or writes a translation, and translation writes no text, source id, draft or deck; a changed revision is checked by the translate operation itself (a translation is kept per revision). What the two families share is the model: the provider's rate limit. Parallel translation therefore meets a "busy" answer (HTTP 429, "rate limit", "too many requests") by cooling instead of failing the job: the wave waits 5 s, then 10 s, then 20 s (a stop ends the wait at once; the wait is a Call of kind `wait` on the `local-wait` boundary, request count 0, reason `rate-limit`, so the 任务 console draws it; the in-process path records the same wait on its record, and the gateway now accepts `local-wait` for kind `wait` only), asks again one batch at a time and counts what the earlier try had kept; a fourth busy answer fails the job as before. Without the switch nothing is retried, as before. With shared provider quota enabled a runtime translation is still refused (`capability-unverified`, S4-2); the switch changes nothing there.

Rollback: switch it off; jobs already queued in their own chains finish there, new ones queue in the library's chain again. The suites `translation-jobs` and `job-control-translation` also run with the switch on (`*.parallel` and `*.runtime-parallel` twins) and `unified-runtime-translation-scheduling` observes the model's occupancy (in-flight calls per family) for generation legacy/runtime x translation legacy/runtime.

### Default-off assistant pilot (S4-7)

`runtime.pilot.assist` (default off, new requests only) runs each request of the learner's assistant as a Job of kind `assist` in the study context (`cancel` only; `recoveryMode: none`; both `direct` and `subagent` declared; result ref `{ kind: 'card', id }`), started through the internal operation `assist.job` by the host's assistant service. The panel's task list (`snapshot.assist`, the last 20 per library, memory only), the request validation, the digest guard against a changed card, the atomic save and the host's teacher pool (`assist-child`: reuse, idle expiry, disposal) stay as they are; the Job is the execution record: a Step `assist:<n>` (or its one repair `repair:<n>`) per direct model call, and `child:<n>` for a host teacher's turn, observed as the host's own attempt (`runner: subagent`, `childId`/`parentId` from the host) without counting a model request of ours. Stopping the assistant (a clear, a plugin unload, a timeout, `job.control cancel`) stops the request, the Job and the teacher through one signal, and the Job settles only after the teacher has been released; the learner's task ends at once, as before. A direct call is now booked once by the gateway (feature `coach`); a teacher's turn stays unrecorded (usage unknown). Contract: [S4-1](plans/unified-job-runtime/s4-1-model-contract.md).

### Default-off learning-workflow pilot (S4-6)

`runtime.pilot.workflow` (default off, new units only) runs the two background units of 学习流 as Jobs: `workflow-teaching` (an author and an independent review, Steps `author:<n>` / `review:<n>`, purposes `author` / `review`) and `workflow-skeleton` (Steps `skeleton:<n>`, purpose `plan`, result ref `{ kind: 'skeleton', id }`). Both declare `cancel` only and `recoveryMode: none`. The session, the step's record (`records[step].teaching`, `session.skeletonJob`), the single-flight table and its admission limit, the citation and quality checks, the guard against a changed step or a deleted session and every navigation, material and draft action stay in workflows; plain navigation starts no Job. The time limit is the Job's own execution time (a stopped request, not an abandoned answer); a stop is recorded on the step as cancelled, timed out or ended, and a stopped teaching can be started again. Contract: [S4-1](plans/unified-job-runtime/s4-1-model-contract.md).

### Default-off daily recap pilot (S4-5)

`runtime.pilot.dailyRecap` (default off, new generations only) runs each generation of a day's recap as a Job of kind `daily-recap` (`cancel` only; `recoveryMode: none`; result ref `{ kind: 'note', id }`). The note, its revision, fingerprint and fragments, the manual-edit protection, `generation.next` merging and the supersede/cancel/delete rules stay in notes; stopping a generation (a supersede, `note.daily.cancel`, a deleted note, an unloaded plugin) stops its Job. Every model call is a Step `recap:<n>` of the gateway, so a generation shows Calls and usage and is a row of the 任务 console. The inbox letter is no longer written in the commit transaction: the Job asks for it and the definition's settled-event sink writes it, so a failed letter never changes how the generation ended. A superseded generation ends `cancelled` (the note says `superseded`). Contract: [S4-1](plans/unified-job-runtime/s4-1-model-contract.md).

### Default-off coach pilot (S4-4)

`runtime.pilot.coach` (default off, new submissions only) runs each batch of 为你定制 as a Job of kind `coach-prep` (capabilities: `cancel` only; `recoveryMode: none`). The day row `coach:YYYY-MM-DD` and `coach-daily.json` stay the one place a day is aggregated, paused and adjusted. A batch names its row in the legacy field `listedIn`: it is not a row, an archive record or a share of the 100 finished jobs of its own (`isOwnRow`, `lib/job-status.js`), but it answers to its logical id (the batch id in the day's calls) in `job.status/wait/control/output`. Its model is the gateway's light lane (`gateway.step(key, policy, { model: 'light' })`: hedged, one transient retry); the gateway books its usage once, by the day the call began. A cancelled batch is `skipped` with reason `cancelled` in the day. Contract: [S4-1](plans/unified-job-runtime/s4-1-model-contract.md).

### Non-model jobs (S5-1)

The [non-model contract](plans/unified-job-runtime/s5-1-nonmodel-contract.md) lets processes, transfers and host tool calls use the same Call/Step records without pretending to be model requests: a Step policy without `requestedEffort`/`executionMode` is a non-model Step (it can `run`/`observe` but `complete` refuses with `model-policy-required`); the `local-process` boundary records a Call with `requestCount` null and `modelRequest:false`; `execution.mode` and `usage.calls` describe model Calls only, so a job with none keeps `execution.mode` null and unknown tokens null; an executor admission refusal carries `code: 'executor-unavailable'` before any job exists. Contract version stays 2.
