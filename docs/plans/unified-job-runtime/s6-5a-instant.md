# S6-5a: instant model requests through one metered entry

An instant request is one the learner waits for: one answer, no Job, no card (S4-0 decided that on purpose). Until now each caller reached the host's model through the
ports of its context, and the ports booked the usage in the ledger but took no part in the provider quota. S6-5a gives them one entry, `lib/runtime/instant.js`.

## What changed

- `createInstant().models(services, { ledger, feature, action })` is the only place that calls `modelServices(...)`. It returns the request's model services with the usage booked
  once in the library ledger (the same `recordedModels` path as before), and, for an instant request under the shared provider quota, every call made inside the lease of the
  `instant-text` resource. `builtins.js` calls it at the four places that used to build the services itself (the context ports, the materials operations, the legacy selection and
  translation executors); the callers are unchanged.
- **Shared quota off: nothing changes.** The function returns exactly what `recordedModels(modelServices(services), ledger, feature)` returned, so the ledger rows are the same.
  `tests/instant-ledger-characterization.test.mjs` pins the rows of fourteen instant requests (taken on main, green before and after).
- **The quota is the config's.** The `runtime.resources.bindings` entry with `resourceRef: 'instant-text'` and the route `instant-text` (observation `host-attempt`, accepted only
  for that route) decides its quota domain and limit. With no such binding instant requests are not limited, whatever audio is bound to; bound to the audio domain they share it
  and wait behind a long audio job, which is the user's choice. Each call opens a lease, runs inside `adapter.run`, and finishes it. A rate-limit answer (`lib/rate-limit.js`)
  puts the shared pool on cooldown (`INSTANT_COOLDOWN_MS`) and is counted.
- **Recorded per call:** the ledger write (feature, tokens, one call, as before) and, in memory only, how many instant calls waited more than `INSTANT_NOTICEABLE_MS` for the lease,
  for how long, and how many rate-limit cooldowns. Nothing is written to the job store, the manifests or any file: no new persisted field (release 2.7.1 rejects unknown keys in
  manifests).
- **Seen by the learner:** `usage.summary` carries an optional `instant` block read through the port `ports.instantStats` (the usage context does not import runtime internals);
  the 模型用量 panel shows one quiet line only when something waited. A missing block is zero; the counters start again from zero with the process.

## Which requests lease

Exactly these, and every `oral.*` (the list is `INSTANT_ACTIONS` and `tests/instant-model-guard.test.mjs` keeps it equal to this one):

- `capture`
- `ingest`
- `card.grade`
- `card.translate`
- `card.followup`
- `card.followup.suggest`
- `focus.suggest`
- `teach.start`
- `teach.answer`
- `coach.nudge`
- `coach.reply`
- `coach.feedback`
- `coach.rewrite.retry`
- `generate.suggest`
- `generate.path.suggest`
- `case.drills`
- `source.organize.suggest`
- `deck.merge.suggest`
- `draft.import.propose`
- `draft.publish.review`
- `materials.selection.ask`
- `materials.outline.suggest`
- `materials.translation.translate`
- `oral.*`

Everything else a port hands a model to (a Job's executor, a background request, the legacy in-process executors) keeps the ledger-only path: it is a Job family of its own, or it
leaves with S6-2.

## The guard

`tests/instant-model-guard.test.mjs` fails any call of `modelServices(...)` outside the entry, its definition (`lib/runtime/models.js`) and the compatibility getters of
`lib/service.js`. The three files are registered in `s1-7-legacy-exceptions.json` under `hostModelAccess` with a disposition (`entry`, `definition`, `exception`). The remaining
exception, the `StudyService` getters, leaves with the in-process executors (S6-2).

## Known gap, fixed in S6-5b

`materials.selection.ask` booked no ledger row (the operation preferred the request's own, unwrapped model; the usage the learner spent was invisible and the lease did not cover it).
S6-5b makes it prefer the metered model like `outline.suggest` and `translation.translate`: one `coach` call is booked and the lease applies.
