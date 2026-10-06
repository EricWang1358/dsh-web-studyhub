# S1-6 public single-audio pilot contract

Baseline: S1-5 #275, head `da3c22b528f322050edf2212dc27a52984fb324e`, merge `5aecc769d657c094b1dac5b5b832779e976dd9c2`. Its delegated technical acceptance is [comment 6010606981](https://github.com/EricWang1358/dsh-web-studyhub/pull/275#issuecomment-6010606981). This publishes the public pilot's adapter interfaces before implementation; it does not certify the pilot or enable it. The owner's 2026-10-06 04:07:50 UTC S1 delegation applies; paid models, permission/credential changes, irreversible user-data deletion, publishing and deployment remain excluded.

## Admission and ownership

`runtime.pilot.audioSingle` is a boolean, default false, separate from `runtime.resources`. It is evaluated only for new single-file `audio.import` admission. Existing validation, path/upload handling, frozen course/vocabulary context and duplicate-recording exclusion remain. Batch, live audio, subtitle import and correction review retain their registered legacy paths. Turning the switch off does not convert an already managed record to legacy, retry an in-flight task, change its definition/executor/policy or disable its valid control/recovery path.

A migrated single manifest has exactly one canonical Job in existing `work.jobs`. Its domain record ID remains an external alias; the canonical jobId and physical attemptId are distinct from the legacy card ID. Ordinary old manifests stay v1. Explicit new managed execution of an old record may create a new canonical identity, with a real new Attempt; it cannot fabricate historical Attempts. In-flight legacy records keep their original worker even if the switch is enabled.

The audio definition is registered once per owning runtime/domain, using an actual Cordis effect scope. Disposing the domain/runtime removes that registration and drains owned execution. Definitions do not belong to whichever request Agent happens to call first. Actual execution still requires the legitimate live Agent and existing official DSH controller established by S1-2. A cold read may inspect existing records but cannot manufacture an Agent/controller to submit or resume.

Trusted domain code may pass private `bindings` separately from serializable input to scoped submit/restore/recovery. They contain existing domain state/library, settings resolution, notification, gate and output ports, never durable facts or a second job table. Registration's `run(context, input, bindings)` and `persistence.open(input, bindings)` receive those ports. Submitted JSON cannot provide functions or replace trusted adapters. Background domain ports detach an HTTP/tool observer signal while preserving domain/owner/grant checks; the lifecycle's actual Attempt signal controls production work. Cold restored records can acquire current legitimate execution bindings on an explicit new Attempt after recovery validation. A running Attempt cannot have its bindings replaced by a later snapshot/control request.

## Additive lifecycle hooks

Public contract version 2, runtime schema 1 and storage envelope schema 1 remain unchanged.

- Optional trusted definition `admit(context, input, bindings)` waits through the existing host audio gate before logical running is exposed. It returns an idempotent release/finish lease, released early when transcription finishes and always drained/released on exit. The queue timeout remains active until admission. The native callback may exist while the business Attempt is queued; no second business queue is created.
- Context exposes pause-request observation/notification for an admission adapter to withdraw a waiting slot without cancelling completed work. After queued or running pause reaches a safe boundary, a saved domain checkpoint ends the physical Attempt; resume creates a new native handle. No pause is represented by an indefinitely blocked pool with a retained transcription permit.
- `context.present(...)` / a trusted presentation reader updates only title, stage, progress, domain detail and explicitly declared legacy display fields. Lifecycle identity/status/times/actions/result/usage/Calls remain kernel-owned. Domain log events may be projected with stable namespaced identities, but cannot emit the kernel's settled event. The public legacy facade derives from these data; it cannot run an independent lifecycle.
- A trusted per-Attempt control adapter supplies validated `set` settings and applies patches to the existing audio control/pool/gate. `control(id, 'set', patch)` passes only the validated patch to that adapter; `paused` is not a set field. Unsupported/not-ready controls expose an explicit reason. Pause/resume use the lifecycle. Preserve adjustable text/transcription concurrency, proofread/translation effort and adaptive backoff, including persisted values needed for checkpoint resume.
- Physical resource leases drain independently from notification delivery. Public observer waits include the admitted terminal domain bookkeeping needed by the old audio facade, without turning notification failure into Job failure or holding physical model permits. Delivery keeps the S1-5 stable event/channel guarantee and its documented at-most-one external attempt limitation.

All new hooks are optional for existing registered definitions. Generic modules contain no audio-kind branches. Domain code continues to use the existing shared gate, recording text pool, cache, upload registry, audioResults/materials writer, inbox and notifier.

## Pipeline checkpoints and publication

Reuse `executeAudioJob` and `runAudioImport`; do not fork transcription/proofread/translation/title logic. Add optional managed cache and pause-boundary ports. Legacy off-path defaults keep their current behavior.

A managed pause stops admitting new windows, allows already admitted windows to finish and write their existing cache entries, then saves a domain checkpoint. The pause signal is raised outside provider/format-repair/error-wrapping code so it cannot be mistaken for a model failure. It must work between raw chunks, proofread/translation windows and before title/publication. Queued pause may save an empty, validated pipeline checkpoint. Cancellation still aborts in-flight work, retains completed cache data and refuses unknown remote-result recovery.

The domain checkpoint payload is versioned independently from generic checkpoint references. Existing prepared-artifact payload version 1 remains supported. A pipeline payload records its discriminator/version, original input/context identity, non-secret effective settings/cache-key context, phase and actual completed cache file references/digests. Validate actual bytes and path containment (including Windows paths); never treat a filename or an intent as completion evidence. No keys, prompts or raw provider results are copied into generic metadata. Existing transcript/cache content remains domain data. Managed cache writes use the existing atomic writer; legacy cache behavior is unchanged.

The final sources are prepared through the same `storeDocuments` formatting and deterministic IDs, then admitted through `commitArtifact` and the guarded existing audio/materials writer. Reconciliation recognizes an already published source and restores its receipt/checkpoint; it does not publish a duplicate. Preserve courses, corrections, bilingual order, content-based reuse and no automatic question generation. Completed upload cleanup follows durable terminal bookkeeping; failed/cancelled records retain recoverable input.

## Calls, controls and console compatibility

Gateway Step admission gains optional validated display labels (`stage`, `part`, `parts`, `file`, `slot`) and a bounded output sink. Each observed Call inherits its own labels and stable callId. Native children use the existing `tapChildStream` and output buffers; direct native completion forwards the existing streaming sink. Dispose subscriptions with the Attempt. The console's UTF-16 cursor, retention and session fallback stay unchanged; the native byte ring is not substituted.

A cached unit may produce a skipped producer observation with runner `saved`, reason/checkpoint reference, `modelRequest:false` and the existing `legacy` boundary (requestCount null). It never becomes a provider request or ledger charge. `legacy` here describes the existing pipeline producer observation, not a fabricated historical Attempt. Keep `local-wait` reserved for actual kind `wait`; do not broaden its existing meaning or add an enum that older v2 readers reject. Actual external requests remain count 1; host-internal requests remain unknown. The canonical record supplies Calls to the existing output reader. Preserve purpose, labels, file/window position, actual effort/fallback, live output and unknown-value semantics without a second task tracker on the managed path.

Audio presentation supplies existing detail files/steps/warnings/parallelism/pace and legacy card fields through the existing generic view. No audio-specific branch is added to the public console. Stage inbox messages retain their existing cache-aware behavior; settled delivery reads the kernel's stable event. Failed-notice replacement on retry and `wakeup:false` remain.

## Behavior differences requiring explicit review

The dual-path matrix must use the same synthetic audio, response fixtures, concurrency and model/effort conditions and map AU-01…AU-20 from S1-0. It must distinguish baseline behavior from these already intended v2 differences:

1. v2 has separate logical/physical/legacy IDs and observed native bindings; legacy aliases continue to resolve. Physical pause ends an Attempt while logical wait remains open.
2. S1-4 removed repeated outer model/pool transport retries on the managed path, retaining the approved single provider retry owner. Exhausted nested-failure request counts can differ; record exact off/on counts and review the difference rather than claiming equivalence. Format repair remains distinct from transport retry.
3. A crash during an unreconciled dispatched request refuses recovery with `remote-result-unknown`; old v1 blindly retries. No provider call may be issued to make a test appear equivalent.
4. Cold managed admission is refused without a real live Agent/controller, as accepted in S1-2. Observed Calls/usage can remain unknown when the host cannot expose them.

Do not silently discard an old behavior outside these reviewed differences. Deferred or unsupported cases must remain visibly blocked and cannot satisfy S1-6 by assertion.

## Required evidence before S1-6 acceptance

- Default-off config and both public routes; validation/upload failures create no executor/model call; old manifests remain readable and do not gain false history.
- Public submit/queued/running/complete/cancel/wait/retry/set/pause/resume, including queued pause/cancel, partial window drain, resumed fresh Attempt, observer timeout and failure-notice replacement.
- Same-fixture AU matrix, deterministic source/course/correction output, retained legacy details/Calls/output, no duplicate accounting/artifact/event and no automatic questions.
- Toggle during simultaneous old/new work: executor, version and policy snapshots unchanged; new admissions alone change route. Existing shared gate, early transcription release and separately enabled provider-quota/cooldown matrix retain actual occupancy assertions.
- New process restoration with zero implicit dispatch; alive/unknown executor and uncertain request refusal; validated checkpoint recovery with one actual new binding. Cold snapshot followed by explicitly authorized live-Agent recovery must not remain bound to a missing request executor.
- Installed current package in a workspace-private DSH rc.2 profile, fake models only: public submission, queue/progress, cancellation/completion, recovery/capability feedback, console screenshots at 1280/420 widths and 100%/150% scale, layout checks and exact versions/source hashes.
- Full verify, both-platform CI and 17-item delegated review. Paid quality, publishing and deployment remain unrun/excluded and cannot be replaced by this fake-model evidence.

## Contract verification (not pilot implementation)

`node scripts/test.mjs tests/unified-runtime-audio-contract.test.mjs tests/unified-runtime-contract.test.mjs`: **28 passed / 0 failed / 0 skipped**, 343.927273ms. Lint and `git diff --check` passed. Full verify was not rerun for this documentation and synthetic-shape-only change; #275's final full run is recorded separately, not attributed to this contract.

The initial synthetic cache fixture incorrectly used `local-wait` for a non-wait kind and correctly failed the existing validator (one failure). The contract/fixture were corrected to the existing `legacy` producer boundary with null wire count and `modelRequest:false`; no production validator was weakened. No pilot producer, config switch, model call or public control implementation is included in this PR.
