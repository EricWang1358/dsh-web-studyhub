# S1-5 durable runtime implementation and evidence

Status: implementation under verification; not yet accepted or merged. Contract #273 (`58c52d9`, merge `5c8342e`) was published first. This implementation incorporates concurrent #271 at `b2349a2ea82d8285c03e2e67990024d2cf25b4bc`; #269 was already in #273's actual merge. Owner delegated routine S1 technical acceptance/qualified merges on 2026-10-06 04:07:50 UTC. Paid models, credential/permission changes, irreversible user-data deletion, release and deployment remain excluded.

## What is wired

- `atomic-json.js` extracts the existing audio writer and per-manifest serialization. Both domain and lifecycle updates use it; Windows replacement still has exactly eight attempts with the original delays and temporary-file cleanup. Removal/retirement runs in that same file queue. The DSH generic writer's nine-attempt policy is not silently substituted.
- `jobs/store.js` validates a schema-1 `runtimeJob` envelope inside the existing audio manifest. Canonical Job state remains in the existing `work.jobs`; no second live Job table or metadata file. Revision-checked read-modify-write preserves current domain fields; stale domain saves preserve runtime metadata and its legacy facade.
- `jobs/lifecycle.js` admits persistent definitions through trusted adapters. It saves the planned Attempt and then the actual native binding before producer dispatch. A failed native admission cannot dispatch business work. A binding-save failure drains the admitted callback and retains the observed identity when storage permits. Concurrent retry is fenced; unsuccessful retry preserves the facade on disk and in memory.
- Terminal state/event is saved before public completion/wait resolution. Physical Calls and admitted artifact commits drain before settlement and resource release. Async domain publication receives an epoch guard at the existing serialized library mutation boundary. An already admitted write may complete during cancellation and becomes a retained partial artifact; a new Attempt cannot overlap it.
- `jobs/durability.js` keeps revision/journal bookkeeping over that same manifest. Request intents are saved before I/O and do not count as Calls. Completed Call observations are saved before existing-ledger aggregation; accounting replay uses stable callId. Failed transport or opaque host outcomes that cannot be reconciled remain uncertain and refuse resend.
- `jobs/executor.js` inspects the actual native owner/handle and a process witness. Matching running/stopping jobs are alive; matching native terminal jobs or same-host witnessed process death establish loss. Missing jobs, live/reused PIDs, foreign witnesses, unavailable services and access/identity failures are unknown. Only positive loss marks a persisted active Attempt interrupted.
- `audio-runtime-store.js` binds the existing single manifest, original input hash/size and submitted context, versioned checkpoint bytes, deterministic source identities and existing library writer. Recovery reconciles prepared artifacts with actual source content. Missing/conflicting or damaged evidence refuses; no remote request is recreated from an intent.
- Stable-call model/audio ledger writes now refuse malformed/future metadata rather than discarding deduplication history. Legacy records without callIds remain supported. The existing audio JSONL and library model-usage file remain the only ledgers.
- Settled event IDs remain stable across repeated restore. Delivery attempts are journaled by event/channel. Idempotent sinks may retry; sinks without that guarantee receive at most one persisted attempt and can lose delivery across a crash. Delivery failure never changes the terminal Job outcome.
- Before the S1-6 pilot adapter is installed, legacy audio recovery reads canonical manifests as read-only observations. It cannot declare their executors lost or run a legacy retry against them. Ordinary legacy manifests keep their existing path.

## Scope and limits

This is the internal durable kernel and single-audio storage adapter. The public `audio.import` pilot is not enabled or switched here. S1-6 still owns default-off admission, full audio behavior/controls/UI fields, switch handling and installed-package console evidence. S1-1 is not marked wholly complete by this step alone.

Storage guarantees apply to one owning host with serialized manifest writes and explicit revision checks. Process-death witnesses are local-host observations, not a distributed lease protocol. A live or reused PID can conservatively block recovery. There is no automatic recovery, fsync guarantee or cross-file atomic transaction. Application-level reconciliation bridges artifact/manifest/ledger crash windows. An unresolved operation with no usable remoteOperationId remains blocked, including an opaque host request. Exactly-once external chat delivery is not claimed.

The single-audio input reference's hash binds both the original input identity and submitted args; the original file hash/size remain in the domain manifest and are checked against actual bytes. Checkpoint content remains domain data; generic metadata stores references/digests and commit receipts. The core does not store prompts or raw model results in request intents.

## Verification record

Commands use the scrubbed workspace-private runner, Node 22.22.3, workspace TEMP/DSH_HOME and the shared full-run lock. No local user computer/profile or paid endpoint is used. Logs under `output/s13-contract` are private execution evidence; final source hashes/results are recorded in the implementation PR and companion evidence JSON.

| Evidence | Result / boundary |
|---|---|
| Contract #273 | 28 contract tests; cloud fast 5217/0/0; CI Ubuntu/Windows each 5636/0/94 on `a41db5a` (head `58c52d9` + base `be820896`) |
| Post-merge #273 + #269 baseline | Separate clean worktree at `5c8342e`: full verify 5753/0/2, lint/build passed, 587096.047518ms; SHA256 `a9df0f0010101f0b328f3e03840f38b757620cebe229e4f06f9b4518c2b94ac6` |
| Shared writer / existing ledger-gateway regression | 51/0/0; existing Windows eight-attempt assertions unchanged |
| Broader implementation focused run before final hardening | 90/0/0; historical intermediate result |
| Freeze focused run on implementation + #271 | 57/0/0, 1789.955702ms; `s15-freeze-focused.log` |
| Real child-process fault matrix | Three artifact windows plus dispatched-request uncertainty passed; one retained source, one accounting entry and no duplicate event per Attempt |
| Recovery refusal matrix | Alive/unknown executor, inaccessible/changed input, submitted-context change, version mismatch, corrupt checkpoint, future/malformed store/ledger, revision conflict and unknown remote result covered by the new tests |
| Final current-source focused | 58/0/0, 2158.225683ms; `s15-final-source-focused.log`; source/log hashes in [evidence JSON](s1-5-store-evidence.json) |
| Installed rc.2 | Passed 2026-10-06 05:49:38–05:49:46 UTC: current-source durable Job → local fake native llm → real library commit/checkpoint → native settlement → explicit restore. One source, one restored completion event, one recorded host Call; five local fake requests across companion checks, cleanup converged |
| Final full implementation verify | Passed on implementation + `b2349a2`: 5812/0/2, 545474.666611ms, lint/build passed; log/hash in evidence JSON |
| Implementation PR CI | Pending; full cloud results are not substitutes for both platforms |
| Paid model quality/billing, remote compute stop | Not run / not claimed |

The crash worker uses a controlled native-service double and an actual separate Node process, filesystem, library writer and existing ledger. Its local fake call counter is not a paid-provider quality test. The installed rc.2 companion separately verifies the real owner/jobs/llm binding. The installed StudyHub package remains unchanged in this step.

## Red tests and corrections

The initial store test failed because the production store module did not yet exist (one file failure, not three behavior failures). Further observed reds: semantic model-ledger corruption was accepted; executor inspection was absent; persistence capability was rejected; request intents were absent; async artifact commit was absent; concurrent retries interfered; pending terminal writes exposed completion too early; notification delivery records were absent; guarded audio publication skipped the guard; malformed audio ledger lines lost deduplication history; failed durable retry changed the stored facade; initial admission left an un-actionable queued record; legacy recovery mislabeled canonical running work as failed; recoveryMode none could expose retry after restore.

Two test-construction errors are kept separate: the first gateway persistence fixture called observe without starting its Step; the first missing-artifact-method fixture waited on a never-entered callback and was corrected to surface the producer failure. These are not presented as production regression evidence. The notification red reached the helper's 90-second condition timeout; it was not a stuck external command. Final corrected tests exercise actual behavior, not fixture timing assumptions. The first frozen full verification stopped at architecture lint because the legacy worker imported the storage module directly; it ran no full tests. The worker now uses the permitted public contract validator and a schema-version guard. The corrected full verification is recorded separately.

## Remaining phase gates

S1-5 requires its final full verify, current-source host evidence, PR CI and delegated technical review before completion. S1-6 remains the first public single-audio pilot switch. S1-7 still requires architecture guards, an explicit old-version rollback exercise, packaging checks and disclosure of paid-quality/release gates. Independent alpha has not moved; nothing has been published or deployed.
