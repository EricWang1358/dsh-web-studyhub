# S1-5 durable lifecycle and recovery contract

Baseline: S1-4 #272, head `ff33db3e510cfc63974707a6f847123bf449e5e9`, merge `be82089666427ac8b8a2fbe0e4ab20c96b35bf39`. Owner delegated routine S1 implementation, technical acceptance and qualified merges on 2026-10-06 04:07:50 UTC. This publishes the next interface; it does not certify persistence or recovery implementation.

## One manifest and one writer

`lib/jobs/store.js` provides a versioned durable envelope in the existing single-audio `manifest.json`, under `runtimeJob`. It is the durable representation of the canonical record already held in `work.jobs`, not a second live registry or a separate job file. `manifest.job` remains a derived legacy facade. The audio domain owns args/input/upload/checkpoint content and source publication. Lifecycle alone owns the canonical contract, Attempt admission/settlement and terminal event. Domain saves must preserve the latest runtime envelope and canonical facade; stale captured manifests cannot overwrite them.

Envelope schema version 1 contains `revision`, `contract`, `inputRef`, `checkpoint`, `requestIntents`, `commits`, `deliveries` and `executorWitness`. Revision advances under the same per-file writer for each mutation. Input reference binds the existing manifest identity and hash/size. Checkpoint is null or an explicit versioned reference with digest and stable stepKey. Executor witness is null before native admission, otherwise records the process/host identity associated with the actual native owner/handle in the canonical Attempt. Metadata contains no settings, credentials, prompts or raw model output. Unknown/future schemas and malformed metadata refuse mutation; missing runtimeJob remains legacy and is never silently promoted.

Extract the existing `audio-batch.atomicJson` and manifest serialization together. Keep exactly eight rename attempts on EPERM/EACCES/EBUSY, existing 25ms exponential backoff capped at 500ms, temporary-file cleanup and existing file modes. Preserve serial ordering, including removal/retirement. Shared read-modify-write operations read the latest manifest within that queue. A queued failure must reject its caller without poisoning later independent reads/writes. Do not claim fsync or atomicity across the manifest, library sources and existing ledgers.

DSH-08: installed `@deepseek-ai/dsh-atomic-write@0.2.0-rc.2` exposes `writeFileAtomic` and `withFileLock`. Its writer uses nine attempts and different delays without an option to preserve the audio baseline, so reuse of that writer would change verified Windows behavior. Retain the extracted writer; reuse native file locking if a concurrent-host admission guarantee is introduced and validated. Initial scope is one owning host writer; detect a still-live previous process conservatively and refuse recovery. Do not claim independent hosts may concurrently mutate the same manifest safely.

## Trusted ports and durable ordering

A trusted definition may supply a persistence adapter; submitted input cannot name arbitrary storage paths or carry executable hooks. Adapter operations are `load`, `save` (with expected revision), and domain `validateInput`, `validateCheckpoint`, `reconcileCommit`. Lifecycle exposes explicit scoped `restore`/`recover`; registration may advertise recovery only with these hooks and a supported mode. Automatic recovery remains disabled; startup identification alone never executes a provider call.

Persist the new Attempt before dispatch, then its actual native owner/handle before producer work. A crash between those writes has no fabricated handle: reconciliation requires a positive executor-loss witness before another Attempt can start. Persistence failure blocks dispatch; an admitted native handle must be stopped and drained when its binding cannot be persisted. Save checkpoints/terminal outcome before making their durable success observable. A storage error after physical completion must remain visible as a durability failure, not silently report a persisted terminal success. Recovery keeps logical jobId; explicit retry changes legacy facade ID, while checkpoint resume preserves it. Every execution has a new physical attemptId and real native handle.

An async domain commit is a trusted transaction, not an arbitrary unfenced callback. `context.commitArtifact(stepKey, prepare, adapter)` first prepares without publication, rechecks the current Attempt, persists stable commit intent, and invokes the domain writer with an Attempt guard checked inside its existing serialized transaction. An admitted commit drains before Attempt settlement/lease release. Cancellation can prevent unadmitted publication; if a transaction already committed before cancellation, its artifact remains a recorded partial result. Never allow an old Attempt to publish after a new Attempt starts.

Domain reconciliation verifies stable source IDs/content identity against the actual library. If publication happened before checkpoint recording, recover its existing receipt and checkpoint without republishing. An ambiguous or conflicting artifact refuses recovery. This is application-level reconciliation, not a distributed transaction.

## Physical requests, existing ledgers and delivery

Before external operation dispatch, gateway persistence records a request intent with stable callId and Attempt/Step identity. An intent is not a public Call or proof of a wire request. After intent save, recheck authority before I/O. Record the actual Call once dispatch begins; persist completion/known usage before aggregating it into the existing audio/model ledger. Repeat aggregation uses the same callId. A crash after remote dispatch but before durable completion leaves an unresolved intent and blocks resend until the domain can reconcile a real remoteOperationId/result. Absence of an operation ID is not evidence of failure. Opaque host requests obey the same uncertainty rule. Never invent tokens or request counts from intents.

Validate existing ledger schema and stable-call metadata before replay; a legacy ledger without callIds remains valid, but malformed/future metadata must not be cleaned into an apparently empty deduplication history. No second accounting ledger.

Persist one settled event keyed by jobId/attemptId before notification. Delivery records use that stable event key. Idempotent inbox insertion may retry; an external chat sink without a deduplication/ack contract gets at most one persisted delivery attempt and may lose delivery across a crash. Do not promise exactly-once external delivery. Notification failure never changes the durable Job outcome. Repeated restore/reconcile cannot append another settled event for the same Attempt.

## Executor evidence and recovery refusals

Executor inspection returns `alive`, `lost` or `unknown`, with a bounded reason. Match the persisted native ownerAgentId and handleId; do not inspect a replacement owner's task with the same local handle. A matching live native job means alive. A matching settled native job proves its physical execution ended. Unknown-job errors alone across an unverified service/host instance are insufficient. Same-host process death (ESRCH with the recorded witness) can establish loss; permission errors, reused/live PIDs, inaccessible services, wrong owner, incompatible witness or identity mismatch remain unknown and block recovery. Never kill another owner to make recovery admissible.

Refusal codes include `executor-alive`, `executor-unknown`, `input-unavailable`, `input-changed`, `definition-version-mismatch`, `unsupported-store-version`, `checkpoint-invalid`, `remote-result-unknown`, `artifact-conflict`, `ledger-invalid`, `revision-conflict` and `recovery-unsupported`. Refusal does not start an Attempt, call a model, publish a source or reset metadata. Mark an active Attempt interrupted only after positive loss evidence. Terminal records with unsettled intents/commits still require reconciliation before retry.

## Required implementation evidence

1. Existing legacy manifest fixtures remain readable; future/malformed envelopes fail closed; stale domain and runtime saves cannot clobber each other.
2. Existing Windows eight-attempt and cleanup assertions pass unchanged; serial writes/removal and injected write failures retain committed data.
3. Actual installed rc.2 inspection demonstrates running, settled, missing and wrong-owner outcomes. Local fake models do not prove paid quality or remote stop.
4. Separate-process crashes before artifact publication, after publication/before checkpoint, and after checkpoint/before terminal/delivery reconcile without duplicate artifacts, retained-ledger accounting or settled events.
5. Refusal matrix covers every reason above, with zero new provider/producer invocation; two restore attempts cannot create overlapping physical Attempts.
6. Persisted request-intent crash refuses blind resend; completed-Call replay uses the existing ledger and retains unknown usage. Failed notification preserves terminal outcome.
7. Full verify and both CI platforms must pass on the implementation revision. This contract's synthetic fixtures prove shape compatibility only. S1-6 alone wires the default-off public audio pilot.

## Preflight observations (not implementation acceptance)

The actual rc.2 companion `tests/fixtures/runtime-s15/host-probe.mjs` passed on 2026-10-06: owned running job, owned completed job, wrong-owner/callerless refusal and exact missing-job error. Cleanup converged with one parent scope disposal. [Machine-readable evidence](s1-5-preflight-evidence.json) records identities, source/report hashes and two corrected probe API errors. This only establishes inspection capability; process witnesses, durable binding and crash recovery remain unimplemented.

Commands in the scrubbed cloud worktree:

```sh
node output/s13-contract/run-command.mjs s15-contract-tests.log node scripts/test.mjs tests/unified-runtime-store-contract.test.mjs tests/unified-runtime-contract.test.mjs
node output/s13-contract/run-command.mjs s15-contract-final-lint.log npm run lint
node output/s13-contract/run-command.mjs s15-native-inspection-final.log node tests/fixtures/runtime-s10/run-host-probe.mjs --repo /workspace/runtime-s12 --dsh-bin /workspace/runtime-s12/output/qa/dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js --out /workspace/runtime-s12/output/qa/s15-executor-inspection-final --variant official-jobs-preset --executor-inspection --port 3493 --model-port 4497 --lang zh
```

Contract tests: 28 pass / 0 fail / 0 skip, 246.500435ms. Lint passed. Full verify was not rerun for this contract-only change. The companion uses the existing local fake adapter; no paid model or installed StudyHub package replacement.
