# Persistent author and reviewer workflow

The Java engine writes one card per topic, then asks a different model family to review the cards against the same source. The original PDF and the resulting deck remain under the ordinary StudyHub library actions. The packaged lifecycle check exercises both engines together.

## Run

Use JDK 21 with `--enable-preview` and start the desktop gateway with `--studyhub.ai.enabled=true`. Each request uses the same local `X-Study-Token` as the StudyHub page.

```json
{
  "id": "lecture-7-revision-2",
  "source": "An index maps a lookup key to a row location.",
  "topics": ["Index lookups", "Row locations"],
  "author": "deepseek",
  "reviewer": "openai",
  "fallback": "ollama"
}
```

| Request | Result |
| --- | --- |
| `POST /api/ai/jobs` | Submit the request above. Reusing its ID and input returns the existing job. |
| `GET /api/ai/jobs`, `GET /api/ai/jobs/{id}` | List persisted workflows or inspect their individual stages, receipts, timings and results. |
| `GET /api/ai/jobs/{id}/events` | Receive the latest snapshot immediately, then SSE `progress` frames with increasing revisions. A reconnect can begin from the latest persisted state. |
| `POST /api/ai/jobs/{id}/cancel`, `POST /api/ai/jobs/{id}/resume` | Interrupt active calls or continue pending stages. Cancellation enters `CANCELLING` until all local workers exit. |
| `POST /api/ai/jobs/{id}/reconcile` | Supply `receipt`, the provider-confirmed JSON `result` string and `tokens` for a stage whose outcome is unknown. Resume after reconciling its outstanding receipts. |

The existing React task console lists active workflows under their first topic. The task row exposes progress, usage, stop and a continuation after a known rate rejection. Finished workflows have a durable history in the native jobs API. Ordinary UI question generation still uses the compatibility engine.

The default provider IDs are `deepseek`, `openai` and `ollama`. The first two resolve `DEEPSEEK_API_KEY` and `OPENAI_API_KEY` at dispatch. The local Ollama endpoint expects `qwen2.5:7b` on port 11434. Configure `studyhub.ai.providers.<id>.{family,model,base-url,key-env,json-schema}` to register an alternative set. A base URL denotes the provider's origin and the adapter appends `/v1/chat/completions`. Configure the model's actual family when using a locally hosted model. The reviewer must differ from every permitted author family. A fallback is used only when explicitly named by the submitting request.

The SQL journal lives in `workflows/workflow.sqlite` under the selected platform data directory. A process lock fences recovery from another writer. The workflow fixes each model identity, format, source prefix, topic order and job token budget at submission. Rate controls and credential lookup are shared at execution time. The caller's request budget uses a conservative UTF-8 size estimate plus the output cap. Provider-reported usage replaces the reservation on success; the full reservation stays held when the provider's outcome is unknown. The server records token and cached-token counters and latency histograms in Micrometer. Configure `studyhub.ai.concurrency`, `rpm`, `tpm`, `token-budget`, `output-tokens`, `max-topics`, `max-source-bytes` and `timeout-seconds` as needed.

A 429 can retry once with the same receipt. A known client rejection or an invalid structured result stops its stage. A 5xx, lost response or crash after intent persistence may have consumed provider tokens. The stage enters `RECONCILE`; recovery never resends it automatically. The provider may continue remote execution after its local HTTP client disconnects. Actual billing and cache behavior depend on the provider.

An installed OpenTelemetry Java agent or configured global SDK receives `studyhub.workflow.run`, `studyhub.workflow.stage` and `studyhub.ai.call` spans. Parallel author threads inherit the workflow trace context. Per-call spans record the model, provider ID, receipt and token counts. Source text, generated content and credentials stay outside span attributes. A clean shutdown leaves safe undispatched work queued for the next launch.

## Publish a reviewed draft

A desktop automation starts a source-linked workflow through the token-protected `POST /api/ai/reviewed-drafts`. Supply a stable request ID, the ID of an existing library source, a deck title, topics and provider IDs. For example:

```json
{
  "id": "database-lecture-7",
  "sourceId": "your-imported-page-id",
  "title": "Database indexes",
  "topics": ["Equality lookups"],
  "author": "deepseek",
  "reviewer": "openai"
}
```

The response contains `jobId` and `draftId`. The server resolves the source text from the active library. Select an individual source up to 60,000 characters, within the configured model input budget. Replaying identical input in the same library returns the same IDs. The author supplies the question, answer, objective, hint, explanation, misconception and source quotation. The reviewer receives the complete authored cards and the same source.

1. Follow `GET /api/ai/jobs/{jobId}/events`. A completed workflow stores the reviewer’s approval or rejection.
2. Call `POST /api/ai/reviewed-drafts/{draftId}/prepare` to save the authored flashcards into the ordinary desktop draft list. This can also open a rejected result for inspection.
3. Publish the prepared version from the desktop draft page, or call `POST /api/ai/reviewed-drafts/{draftId}/publish`. The REST action also prepares the draft if needed. Both paths require an approved review, the same library and source text, and the exact saved draft. Node checks the cards and their citations and commits the deck using the version from its plan. Each native draft publishes to its own new deck. A real edit requires a new review workflow. The editor can save an unchanged draft and continue to publish it.

The local journal stores each reservation, the complete prepared version, Node’s publication plan and the final receipt in `workflows/reviewed-drafts.sqlite`. A retry retrieves that receipt. If a process stops after Node writes the deck, the gateway checks the published card identities, content and review receipt before recording recovery. The generated `studyhub-reviewed-<UUIDv4>` IDs identify this workflow across desktop backup and restore. A restored native draft from another library needs a new source-linked workflow there. Manual drafts use their existing publication path. The original text-only `/api/ai/jobs` endpoint remains available for generation without a library draft.

## Verification

From the Track S directory, run `mvn -pl studyhub-ai-engine -am test`. The WireMock suite exercises two concurrent authors and their dependent reviewer, structured responses, 429 fallback, cache usage, an interrupted provider connection, a 503 and reconciliation, malformed results, permanent errors and the token guard. It recreates the persisted crash boundary and verifies that recovery does not reissue the call. A delayed HTTP response is cancelled from a live workflow; a JFR recording checks that its workers do not pin a carrier for 250 ms or longer during the test. These measurements use loopback fixtures.

## Before implementation

| Project checks | Decision |
| --- | --- |
| C11, C32, C35, C43 | Persist a request intent before dispatch. A known rate-limit rejection may retry. An interrupted or ambiguous remote outcome requires reconciliation against its receipt before the stage can advance. Completed stages supply their saved outputs on resume. |
| C19, C39 | Snapshot the ordered topics, fixed source text, provider endpoint, model, family, format and token budget with the job. Keep credentials outside the database. |
| C13, C28, C44, C48 | Execute independent authors on virtual threads under a global concurrency cap. A review depends on all authors. Rate and token budgets apply to each provider. Time-bound remote calls; publish stage timings and usage. |
| C33, C34, C36 | Persist a cancellation request, interrupt its structured scope, expose cancellation completion only after workers stop. Provide a durable status resource and resumable progress stream. WireMock exercises remote outcomes without paid traffic. |
| C29, C03, C31 | Reject invalid configuration or a reused request ID with different inputs before dispatch. Compare received request shape and resulting stage transitions against a controlled HTTP server on Java 21. |
