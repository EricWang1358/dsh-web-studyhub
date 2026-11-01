# The state of a coverage run

The code is `transitionRunState` in `lib/contexts/generation/run-state.js`. This page is the same table in words, plus the glossary. `tests/generation-run-state.test.mjs` checks every row, and that this page names every event and state.

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
| `stop` | `running`, `paused`, `waiting`, not stopped before | `complete` when the reason is `complete` or `target`, otherwise `stopped` |
| `usage`, `auto`, `touch` | anything | state unchanged |

## Round statuses

`pending` (also: no status at all), `running`, `done`, `failed`, `skipped`.

| Event | Allowed when | Result |
|---|---|---|
| `round-start` | marker `running`, no round in flight | the round is `running` |
| `round-finish` | that round is `running` | `done` or `failed`, or `pending` when it still owes sections |
| `round-stopped` | anything; with no round in flight nothing changes | the round in flight is `failed`, or `pending` when it owes sections no pass asked for |
| `round-skip` | that round is not `running` | `done` if a pass of it ran, otherwise `skipped` |
| `fill-append` | anything | a new `pending` fill round at the end |
| `recover` | anything; running it twice equals running it once | every `running` round is `pending` again, and what its pass was asked for is owed again |

## A run that lost only its closing write

Every section has its question, but the draft still says `running` or `paused`. The run comes back as interrupted, because reading the job list never writes. 接着做 then closes it with one write of the draft and no model call (`closeRun`, `run-close.js`). A run on the runtime whose draft already says `complete` has its manifest forgotten, so it does not come back at all.

## Limits

- A pass cut in the middle may have covered a section with fewer questions than its quota. A section that has a question is not asked for again, so the finished draft can be a little short of the goal with every section covered.
- Before its first draft a run is lost on the legacy path and with `generation` alone: nothing was written. Behind `generationRestart` it comes back, because the manifest holds the request.
- A run on the runtime cannot be paused (declared unsupported in S3-2), so only the legacy path leaves a draft `paused`.

## What stays true on disk

- Same fields as v4.1.0: no store version change and no new field. `tests/generation-run-corpus.test.mjs` runs drafts written by v4.1.0 through the code and checks the field names.
- A host that stops writes nothing. The next process reads the marker it left.
