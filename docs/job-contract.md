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
| `already-paused`, `not-paused`, `already-cancelling` | the state already is (or is not) that |
| `no-control-yet` | it has not started, so there is nothing to adjust or pause |
| `unknown-action` | not one of the five |

### Pause

A kind declares its `pause.mode` (`actions.pause.mode`):

- `unsupported`: no pause. Offered nowhere it is not real: a question run keeps nothing a pause could stop at, so it is stopped (what passed review is kept) or left running; a PDF conversion cannot pause either.
- `queued-only`: a job can be held until it starts. Declared by the contract; no kind uses it yet (it needs a library queue that can skip a held job).
- `checkpoint`: audio import and translation. Pause stops dispatching new calls and lets the admitted ones finish. The status is `pausing` (with `actions.pause.waiting = { reason: "calls-in-flight", count }`) until nothing is in flight, then `paused`; the audio batch writes its manifest at that boundary (finished windows are already kept in their checkpoints, so a restart continues from them). A pause that only blocked new calls with nothing checkpointed is never offered.

### Set

`actions.set.settings` lists what can be changed while the job runs, each `{ key, type: int | enum | bool, min?, max?, values?, value }`: audio `textConcurrency` (1-6), `transcribeConcurrency` (1-3), `proofreadReasoning`, `translateReasoning`, `autoBackoff`; generation `concurrency` (1-8) and the reasoning of each stage; translation `concurrency`. A change applies to LATER dispatch only and interrupts nothing: lowering a limit makes new calls wait, raising it admits waiting ones, and the automatic back-off never raises the limit above the configured cap. The reply is `{ applied, changed, values }`: `applied` is what is now in force for the keys asked. `pause` and `resume` are actions, not settings.

### Retry

`retry` starts a new attempt from what is kept (`audio.retry`, `mineru.retry`). The new attempt has a new `attemptId` and the same `jobId`.

## Calls

```
call = { callId, jobId, attemptId?, stepKey, kind, stage, slot | null,
         queuedAt?, startedAt, firstOutputAt?, endedAt, status, runner, childId, parentId,
         part, parts, reasoning, tokens, file?, reason? }
```

`kind` is `transcribe | proofread | translate | title | plan | blueprint | author | review | repair | publish | wait | other`; `status` is `running | ok | failed | cancelled | skipped | waiting` (a rate-limit back-off is a call of `kind: "wait"`, `reason: "rate-limit"`). `runner` is `subagent` (DSH sub-agent; `childId` opens it where the host can), `direct`, `gemini` ... A retry or a fallback is a call of its own with the same `stepKey`. A time is present only when it was observed: `queuedAt` is derived from the wait for a free slot where the job measured it, `firstOutputAt` is set when the first text arrived; a missing one stays missing. At most 300 calls are kept per job (the newest), 100 waits, 200 events.

## Live output

`job.output {jobId, callId, cursor}` returns `{ supported, live, text, nextCursor, truncated, reasoningChars, retention: { unit: "chars", limit: 8192, persisted: false } }`. `cursor` is the `nextCursor` of the previous answer (0 to start); only the text after it is returned. `truncated: true` means the cursor is older than what is kept (or from another buffer): `text` is the retained tail, the reader replaces what it shows and re-reads the snapshot; nothing depends on replaying a full log. The buffer is in memory, per running call, and gone when the call ends (`ended: true`). `supported: false` is a call that offers no text on the way (a Gemini request); a call through the host model is opened for output from its first moment, even before its first character.

The text comes from the model path of this plugin: the direct streamed call, and, for a DSH sub-agent, the process-local `agent/assistant-stream` events DSH publishes for each model attempt (`dsh-agent-loop`, verified in DSH 0.2.0-rc.2: a listener of an unscoped context receives every agent's, and the plugin picks its child by id).

## What each kind could and could not map

| kind | maps | does not map |
| --- | --- | --- |
| audio-import | everything: batch identity + attempt, per-file rows, grouped notices, pause (checkpoint), set, retry, calls with slots and waits, live output of host-model windows | live output of Gemini transcription and Gemini text (no stream); the stage of a batch is the batch's phase, per-file stages are in `detail.files` |
| pdf-convert | status, stage, progress (total unknown until reported), retry, result refs, detail (route, window) | pause, set, calls (the converter reports none), live output |
| translation | status, progress, pause (checkpoint at a wave), set concurrency, calls, live output | retry (a new translation is started, never twice) |
| generation, supplement | status, stage, progress in questions, set (concurrency, per-stage reasoning), calls with slots and waits, live output, result refs (draft/deck) | pause (nothing is checkpointed), retry (continuing a draft is its own action) |
| draft-repair, draft-publish | status, stage, progress (repair), cancel (repair only), result refs | calls and controls (their own loops do not record them yet) |
| extension tasks | status, stage, progress, cancel | everything else |
| 为你定制 (coach prep) | not a job record of the snapshot: shown through a separate aggregate (see the console) | |
