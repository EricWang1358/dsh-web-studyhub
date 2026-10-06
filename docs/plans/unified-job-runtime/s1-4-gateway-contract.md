# S1-4 gateway contract and ownership review

Baseline: `48ff29c301676533744eca65ef2015178edc17b5` (S1-3 #267 and concurrent #268). Owner accepted S1-3 and delegated routine S1 technical acceptance/merges on 2026-10-06 04:07:50 UTC. Paid models, credentials/permissions, release/deployment remain excluded. This document publishes an interface, not implementation acceptance.

## Admission and authority

`createModelGateway({ context, record, host, ledger })` is constructed by trusted lifecycle/adapter code. `context` supplies Job/Attempt identity, signal and current-Attempt assertion. `record` is the existing canonical contract, never another Job table. A gateway cannot obtain authority from a submitted jobId, credential hash or plain JSON port. `step(stepKey, policy)` returns an Attempt-scoped capability. It rejects stale/new business execution after cancellation, while previously admitted physical requests are recorded through cleanup. A step has a stable business key and a fresh physical stepRunId.

Policy requires explicit `purpose`, `feature`, `requestedEffort`, `executionMode`, `budget`. Modes: `direct`, `agent-preferred`, `agent-required`; effort uses `model-effort.js`. Budget is null (no new budget policy) or bounded `timeoutMs`/`maxOutputTokens`; unsupported monetary/request-budget fields reject before I/O. Existing quota checks and retry counts are unchanged. Preferred falls back only when the verified host capability is unavailable before admission, records why, and never repeats a failed child as a direct call. Required refuses without a native live parent. No synthetic parent/session.

`step.run(operation)` establishes the scope for one logical operation; `step.observe(metadata, operation)` records one observable leaf request. It does not retry or hold a parent provider permit around child work. Adapter metadata names `external-request` or `host-attempt`, actual provider/model/tier, requested/applied effort and fallback reason when observed. Unknown actual effort stays null. Child/parent IDs are recorded only from actual host events. Record count is 1 for external requests, null for opaque host execution. Upload/poll/delete are physical non-model Calls, not billed model requests. Requests refused before leaf admission create no external-request Call.

Every actual retry/fallback gets a new callId; identity remains stable when the same completed Call is re-aggregated. A Call links jobId/attemptId/stepKey/stepRunId and records local observed start/end; first-output and usage stay null if unavailable. No prompts, audio bytes, raw model responses, secrets, raw URLs or authorization headers are stored in Calls. Only bounded diagnostic codes, not untrusted provider bodies, enter the public record.

## Existing owners and migration table

| Existing path/symbol | S1 managed path responsibility | Off/legacy |
|---|---|---|
| `modelCompletion` / `ctx.llm` | Reuse modelCompletion with host-attempt observation; hidden retries unknown. Existing refusal fallback retained and visible at observed boundary. | unchanged |
| `backgroundCapability`, `startBoundedChild` | Reuse native scoped subagent service; no tools; await child disposal; effort via model-effort | unchanged |
| `GeminiTiers.request` | Sole provider transport retry/tier fallback policy | unchanged |
| `GeminiTiers.complete/transcribe` | Existing form/effort fallback retained; leaf HTTP gets separate Call | unchanged |
| `GeminiTiers.transport` | Existing physical permit covers HTTP/body/close; gateway observes inside admission | unchanged |
| `audio-import.withModelRetry`, window refusal retry | Delegate transport retry to GeminiTiers for managed provider path; format repair remains domain work | unchanged |
| `audioUsageFetch` | Replaced on managed path by Call aggregation to the **same** recordAudioUsage writer | unchanged |
| `recordAudioUsage` | Add stable callId deduplication inside the existing serialized writer; repeat/restart aggregation is idempotent for retained records | legacy records without callId unchanged |
| `withJobUsage` / model ledger sinks | Managed host Call captures one existing usage report; do not attach an additional ledger sink | unchanged |
| lifecycle / completion | Lifecycle alone settles Job; gateway only owns Step/Call observations | unchanged |

No second ledger or retry wrapper. Audio ledger keeps its existing retention and provider quota meanings; callId is additive. Usage absent in responses is null in canonical Calls, never invented zero. Failed ledger writes are exposed as unrecorded and may be replayed using the same Call identity; they do not rerun the provider. Persistence of Calls/checkpoints and cross-file crash reconciliation is S1-5, not proved by this contract. Concurrent independent host processes are outside the single-host writer guarantee.

## DSH evidence and tests required

DSH-04/05/07: installed rc.2 `modelCompletion`/llm stream and native one-shot spawn were exercised in `s1-0-dsh-capabilities.md` R03/R07 and the actual host probe. That proves service capability, not new gateway wiring. Gateway implementation must rerun direct and native-child paths in that isolated actual host with fake models, capture identities/effort/usage, test unavailable-required/preferred fallback and cancellation disposal. Provider leaf tests must cover retry-success, tier fallback, permanent failure, abort, missing usage, non-model requests, repeated aggregation and process restart. Paid model quality/billing is untested until separately authorized.

Review checklist: 1–4 ownership/interface stated above; 5–11/14/17 implementation evidence required later (not claimed by schema tests); 12 no UI change; 13 paid quality gate remains open; 15 isolated scrubbed test environment; 16 this is contract-only and S1-4 is not marked complete.
