# S1-4 gateway implementation record

Owner delegated routine S1 acceptance and qualified merges at 2026-10-06 04:07:50 UTC. Contract #270 merged as `6b6be21ddc7fdaefcef070db7a396e1530e529ff`; implementation branch `codex/runtime-s14-gateway`. S1-4 is not marked complete until the exact implementation PR is verified and merged. No paid-model, credential, release or deployment authorization is inferred.

## Implemented boundary

- `lib/jobs/gateway.js` is an Attempt-scoped Step/Call observer over the existing canonical record. Lifecycle creates it, waits for physical requests/Steps and resource cleanup, and remains the sole Job settlement owner. It adds no Job map, provider queue, ledger file, or transport retry.
- Explicit purpose/feature/effort/mode/budget admission; invalid fields, monetary budgets and unsupported modes refuse. Timeout signals reach execution. Output token limits go through existing `modelCompletion`/DSH agent options; native rc.2 source validates maxTokens. `model-effort.js` selects supported levels, records requested/selected levels and fallback. Actual direct-model effort remains unknown when not exposed by the host.
- `modelCompletion` handles direct calls; `backgroundCapability` and `startBoundedChild` use a real live parent and tools restricted to none. Required refuses absent parent; preferred falls back only before native admission, never repeats a failed child directly. Late native admission cancellation awaits disposal with the new opt-in helper option; other callers retain existing behavior.
- Host hidden retries remain a `host-attempt` with requestCount null. Physical provider quota policy refuses opaque host execution. Gateway Calls carry actual Job/Attempt/Step identity, observed start/end and native child/parent identity. Unknown usage/first output remains unknown.
- `GeminiTiers.transport` observes each HTTP leaf **inside** the existing provider permit, through response body and local close. Retry, fallback and form repair produce distinct Calls. Upload/poll/delete are observed non-model Calls, excluded from model billing. Existing Gemini request policy is unchanged.
- `audio-gateway.js` projects completed Calls into the existing audio ledger; managed `tiersFromSettings` replaces `audioUsageFetch`, so only one writer records a request. Failed transports are still observed/recorded, then the original error is rethrown.
- The existing single-file `executeAudioJob` accepts the internal gateway capability; both provider and host text paths use it. No new public entry or pilot configuration is activated here. Domain metadata/artifact logic remains in audio modules. The gateway path stops legacy taskTracker from writing duplicate Calls. Old quota/cost summaries remain domain compatibility projections; canonical observed token usage is folded from Calls.
- Original audio JSONL writer deduplicates retained stable callId values, fails closed on an incomplete tail, and caches identities only while file size/mtime match. The existing library model-usage writer retains stable callIds in the same atomic tally and rejects corrupt-file replay. Legacy records without IDs behave as before. Dedupe applies within existing retention windows, with the existing one-host writer scope; cross-process concurrent writers are not claimed.

## Retry ownership and behavior boundary

The published #270 table applies. GeminiTiers remains the sole provider transport retry owner (its existing transient delays/count, timeout retry, quota waits, tier/form order remain unchanged). On the **explicit internal gateway path**, enclosing `withModelRetry` and window refusal retry are disabled, as S1-4 requires removing stacked transport retries. This removes extra outer repetitions after the provider policy is exhausted; it is not claimed that old nested failure-path request counts/delays are identical. Default old audio entry remains unchanged; shared quota is still a separate default-off S1-3 strategy. S1-6 must record this intentional S1-4 wrapper difference in its dual-path matrix. No recovery or broad scheduling improvements are activated by this adapter.

## Validation and retained failures

All tests use scrubbed provider variables, private workspace TEMP/DSH_HOME and the existing full-run lock. No real provider requests.

- Initial gateway red: module absent, 1 file failure (not 8 executed behavioral failures).
- Host ledger red: replay after writer reconstruction counted 3 calls instead of 1. Corrected writer regression passed.
- Native admission cleanup red against the pre-change helper: returned before late physical disposal. Corrected opt-in path and actual native cancellation probe passed.
- Full audio pipeline red: 4 mock requests produced 0 canonical Calls; explicit pipeline integration fixed it. Both Gemini and host text pipeline tests then passed, with source artifacts and one ledger writer.
- 84 focused gateway/lifecycle/resource/old audio/ledger/host composition checks passed before the final pipeline additions; the final gateway/pipeline file passes 16/0/0 (990.910ms), including independent Node-process audio ledger replay, native-required refusal/preferred fallback, request failure usage, corrupt ledger refusal, retry/fallback/permanent failure, upload and cleanup.
- Actual isolated installed DSH 0.2.0-rc.2: canonical native Job runs direct + native child + unsupported effort fallback; a second Job is cancelled while native child admission is held and remains cancelling until physical disposal. Original parent remains genuine, no synthetic session. Runtime modules come from this worktree; the installed StudyHub package is not replaced. Probe report/fingerprints in `s1-4-gateway-evidence.json`.
- Final cloud complete verification and exact-head Ubuntu/Windows CI results are recorded in the implementation PR after completion. An earlier full run began before pipeline integration and is explicitly intermediate, not final source acceptance.

## Review checklist

| Items | Verdict / evidence |
|---|---|
| 1 DSH-first | Yes: DSH-04/05/07, original modelCompletion/host helpers; actual rc.2 probe and SDK maxTokens source |
| 2 one owner | Yes: original resource/transport policy, existing ledger writers, gateway Call ownership, lifecycle settlement; red/green dedup tests |
| 3 separation | Yes: core has no audio branches; provider/ledger projection in audio-gateway; domain execution remains in audio-job |
| 4 published contract | Yes: #270 merged before implementation |
| 5 behavior / switches | Default old path unchanged; internal managed pipeline tested; explicit wrapper difference above; public pilot switching remains S1-6 |
| 6 settlement / cleanup | Existing lifecycle/resource regressions plus fire-and-forget drain and late native admission cancellation |
| 7 capabilities | Direct/native modes checked; absent required parent refuses; opaque host quota refuses; pause/recovery not expanded |
| 8 recovery | Not claimed in S1-4; cross-file Call/manifest crash recovery is S1-5, still required |
| 9 once-only usage | Audio independent-process replay and model writer reconstruction tests; failed responses retain observed usage; corrupt model ledger refuses |
| 10 resource policy | Same S1-3 resource instance, observation inside admission; original sharing regressions preserved |
| 11 honest observation | Unknown host request count, actual direct effort and absent tokens remain null; local closure is not remote compute-stop proof |
| 12 UI | No UI implementation change; pilot console behavior remains S1-6 |
| 13 real model | Not run / not authorized; paid quality and billing remain release gates |
| 14 tests | Red logs retained, focused checks above; final verify/CI required before merge |
| 15 safety | Private scrubbed cloud fixtures, local fake endpoints only |
| 16 handoff | Contract merge/branch/scope recorded; S1-4 checkbox remains open until merge |
| 17 rollback/switching | No public activation here; drain before reverting. Old readers ignore additive Call/ledger identity metadata; replay after an old writer strips identities is not claimed. Full old-version exercise remains S1-7 |
