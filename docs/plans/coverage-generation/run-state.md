# The state of a coverage run

The code is `transitionRunState` in `lib/contexts/generation/run-state.js`, and the executor that makes its moves is `lib/contexts/generation/generate/execute.js`. This page is the same table in words, plus the glossary. `tests/generation-run-state.test.mjs` checks every row, and that this page names every event and state.

## Glossary

| Term | Meaning |
|---|---|
| **Run** | One coverage plan being worked through on one draft, across any number of jobs and restarts. |
| **Plan** | `editorial.coverageSpec`: the sections wanted, their quotas and the rounds. Also called the spec. |
| **Round** | One step of the plan: some sections and a number of questions. A **fill round** is added afterwards for sections that did not come out. |
| **Pass** | One execution of a round by a job. A round can take several passes when a pass was asked for only some of its sections. |
| **Asked / tried / owed** | `askedKeys`: what the last pass was asked for. `triedKeys`: what any finished pass was asked for. Owed: sections of the round no finished pass was asked for. |
| **Marker** | `editorial.coverageRun`: which job works the run, its state, its tokens and why it stopped. |
| **Checkpoint** | The draft. The plan and the marker travel with every save, and nothing else is needed to go on. |
| **Job** | What the task console lists. In-process on the legacy path; a Job of the unified runtime behind `runtime.pilot.generation`. |
| **Attempt** | One try of a runtime Job. A retry is a new Attempt of the same logical job. |
| **Manifest** | `generation-runs/<id>.json`, kept only behind `runtime.pilot.generationRestart`: the request as asked and the kernel's record of the job. It is not a second checkpoint. |
| **Interrupted** | A run whose host stopped. Never stored in the marker: it is read from a marker that says `running` or `paused` with no job working on the draft. |
| **接着做** | Go on from the next round that is not done (`generate { coverage: { run: true } }`). |

## Who owns which status

| Status | Owner | Where |
|---|---|---|
| Marker state | this table | the draft |
| Round status | this table | the draft |
| Job status, runtime | the kernel | `lib/jobs/contract-schema.js`, manifest |
| Job status, legacy | the executor, decided by `endOfRun` | memory only |

## Marker states

`running`, `paused`, `waiting`, `stopped`, `complete`. An unknown value is never refused when read. Such a run does not come back by itself, and 接着做 still works.

| Event | Allowed from | Result |
|---|---|---|
| `start` | no marker | `running` |
| `resume` | anything, including no marker or an unknown state | `running`, last stop forgotten, tokens and first start kept |
| `pause` | `running`, no round in flight | `paused` |
| `unpause` | `paused` | `running` |
| `wait` | `running` | `waiting` |
| `stop` | `running`, `paused`, `waiting`, not stopped before | `complete` when the reason is `complete` or `target`, otherwise `stopped` (`questions-short` included: see below) |
| `goal-met` | stopped with the reason `questions-short` | `complete`, the stop becomes `complete`: its continuation reached the goal |
| `usage`, `auto`, `touch` | anything | state unchanged |

## Round statuses

`pending` (also: no status at all), `running`, `done`, `failed`, `skipped`.

| Event | Allowed when | Result |
|---|---|---|
| `round-start` | marker `running`, no round in flight | the round is `running` |
| `round-finish` | that round is `running` | `done` or `failed`, or `pending` when it still owes sections |
| `round-stopped` | anything; with no round in flight nothing changes | the round in flight is `failed`, or `pending` when it owes sections no pass asked for |
| `round-skip` | that round is not `running` | `done` if a pass of it ran, even one cut short (`askedKeys` or `triedKeys` on it), otherwise `skipped` |
| `fill-append` | anything | a new `pending` fill round at the end |
| `recover` | anything; running it twice equals running it once | every `running` round is `pending` again, and what its pass was asked for is owed again |

## A run with nothing left to ask by section

Every section has its question, but the draft still says `running` or `paused`. The run comes back as interrupted, because reading the job list never writes. 接着做 then closes it with one write of the draft and no model call (`closeRun`, `run-close.js`).

- **It holds the plan's goal:** `complete` when every round ran, `target` when a planned round never ran.
- **It is short of the goal:** the host stopped in the last round, after every section had its first question and while the round's other parts were in flight. Measured with a fake model and `roundLimit` 30: 3 sections, 30 asked, 25 of 30; 2 sections, 30 asked, 11 of 24; 4 sections, 60 asked, 39 of 48. The run is `stopped`, reason `questions-short`, and the goal stays the one the interrupted card showed. The job keeps `requestedTotal`, the stage says the count against the goal, and `shortfallOf` gives `reason: questions-short`, `percent` as kept over goal, `action: continue`, `continueKind: count`.
- **Adding what is missing:** `generate { resumeDraftId, draftVersion }`, the same way a plain short draft is continued. The close writes `editorial.requested = goal` because that is the number `lib/draft-continuation.js` counts. One press asks for at most `ROUND_LIMIT` (`nextContinuation`), and the button, the estimate and the job all say that number; a run that owes more takes more than one press. Its selection has the limit of a coverage run.
- **Until the goal is met:** a continuation's saves carry the `questions-short` marker, so a press that falls short (a part failed, more owed than one press asks, a kill) still offers the action. When the draft reaches the goal, `goal-met` makes the marker `complete`. A later attempt of the press asks for the count, not `coverage: { run: true }` (`resume-args.js`).
- **A round's row:** the round in flight is `done`, not `skipped`: it wrote the questions. What it kept and cost was lost with the host, so `kept`, `covered` and `tokens` are absent and the row says they are not known. No row of a closed run is `pending`, fill rounds included.

`questions-short` is a new value of `stop.reason`, and the only addition to what a draft can hold. A release from before it reads the draft as a stopped run whose sections are covered, with no sentence for the reason.

## After a restart (`generationRestart`)

A draft has one run. Every save of a run's draft writes `editorial.generation.runId`, the closing save and `persist` too.

- A run whose draft says `complete` has its manifest forgotten. So does one whose draft is closed short, unless it is a press of 接着做 by count (`continues`): that one has its work still to do, and it comes back.
- 接着做 through `generate` is a new logical job over the same draft. A run that saved to a draft that now names another run is over, whether or not that other run still has a manifest. Its retry would otherwise ask its first request again and make a second draft.
- Of two manifests left on one draft (one never saved), the one the draft names comes back, else the newest.
- A manifest that is forgotten settles the usage it owes first, through the same ledger call a preflight makes.

Known window: a run killed between its first draft commit and its first checkpoint has no draft in its manifest. If the draft names it, that is enough. If another job has since saved to that draft, nothing links them: the manifest comes back and its retry makes a second draft. It takes a kill in that moment and a direct `generate` on the draft after it; the UI's retry stays the same logical job. Linking them needs a field on the draft or the manifest, so it is not done.

## Limits

- A pass cut in the middle may have covered a section with fewer questions than its quota, and a section that has a question is not asked for again. When later rounds still have work, the run goes on through them and ends `complete` as it would uncut, so the draft shows what it holds as its goal, and the questions the cut pass did not write are not reported. Measured on the corpus world, killed with part of a round saved: 18 kept of a goal of 19, shown as 18/18, percent 100. This is the case `shortfallOf` calls a met plan, the same as an uncut run that came back short (22 of a goal of 24 in the 2-section world). Only a close reports against the plan's goal.
- A fill round left pending by a stopped host, when other sections still need asking, stays pending if the run then stops by `stepOf`. Only a close settles every row.
- Before its first draft a run is lost on the legacy path and with `generation` alone: nothing was written. Behind `generationRestart` it comes back, because the manifest holds the request.
- A run on the runtime cannot be paused (declared unsupported in S3-2), so only the legacy path leaves a draft `paused`.

## What stays true on disk

- Same fields as v4.1.0: no store version change and no new field. `tests/generation-run-corpus.test.mjs` runs drafts written by v4.1.0 through the code and checks the field names.
- A host that stops writes nothing. The next process reads the marker it left.
