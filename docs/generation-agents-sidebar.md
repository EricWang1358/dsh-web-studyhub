# Generation task visibility and the DSH sidebar

[中文 and historical verification records](https://github.com/EricWang1358/dsh-web-studyhub/blob/v2.0.3/docs/generation-agents-sidebar.zh-CN.md)

A generation task processes batches of up to five questions. It combines writing with author self-check, validates structure and quotations, and obtains exactly one independent review per batch. It retains accepted questions and records rejected candidates without automatic repair/review loops or extra generation to fill a requested count. Explicit later repair is a separate operation. Expand the execution record for each model stage's actual route, start and end times, and real subagent session ID when available.

## Subagents and direct model calls

A supported native DSH host uses restricted subagents through its official interface. They receive selected material and candidate questions, cannot access unrestricted tools, and must return completed output. Failed or interrupted output is not a final answer. Run handles are released afterward.

Local structure checks have no subagents. Standalone previews and hosts lacking capabilities explicitly show direct model calls. Old jobs have no retrospective trace; start a new task to see current execution records. The learning background and dialogs stay inside the plugin pane; moving it to the sidebar leaves the main conversation available.

## Background teaching on desktop

A desktop panel can have a selected model and saved conversation without a running parent agent. Assistance, repair, generation, and historical transcript correction share capability checks and prefer official `spawn` subagents.

Without an active parent, a host offering `agents.create` and saved-session working-directory access can create an idle coordinator. Actual work runs in its child. The coordinator receives no model task and does not resume or drive the learner's conversation. Both use the selected model; their handles are released after completion.

Missing native capabilities, tool restrictions, or model-override support can lead to direct execution. Once native startup or execution begins, failure ends the task rather than repeating it through another route. Assistance fixes model selection when submitted.

Both routes return bounded JSON validated and saved by the service in one transaction. Native teaching subagents use `toolFilter: {allow: []}` and cannot write directly to the library. Answers reuse follow-up and inbox handling. Repairs retain validation, revision history, and undo. Prerequisites are created or linked only on explicit request; new questions inherit the target course. Supplementary material is labeled. Invalid output leaves no partial answer or orphan prerequisite.

Errors and timeouts report actual causes. Late output and results based on old question versions cannot overwrite newer content. The status fingerprint lets failures refresh even if the question bank is unchanged. Historical correction honors the selected audio text-model route: Gemini uses Gemini; the host route prefers official subagents and, when capabilities are insufficient, calls that same host model directly.

## Model selection and configuration failures

The panel honors a pending model selection before a last-used selection. An explicitly pinned learning model takes priority. Reading a saved session's selection does not start a parent agent or replay a long conversation during unchanged polling.

`NO_ADAPTER` means the selected provider is missing from the profile actually running the task. Configure it in that DSH profile; a working web configuration does not prove desktop has the same provider. Adapter and credential errors stop text processing without repeated requests. After correction, saved audio transcription checkpoints remain reusable.

Diagnostics may recover the real error from a persisted session before releasing a handle. Better diagnostics do not establish provider availability.

## Updates and remaining boundaries

Desktop may load an installed tarball while web links a workspace. Editing source files does not prove a running desktop package was updated. Updating the package, completing a required restart, and checking the running feature are separate steps. Finish or stop queued and active learning jobs before restarting; the plugin has its own task queue.

Same-question teaching follow-ups can reuse an idle subagent on supported local hosts. New requests are serialized and retain the same session ID; unavailable or expired agents are recreated with the last three valid Q&A entries. Changing the question, content/source version, model, or language starts a fresh context. At most four reusable teaching agents remain cached, with a two-minute idle limit and eight-round limit. Failure, timeout, library-job cleanup, and plugin shutdown release them and reject late output.

Cross-stage generation-agent reuse remains proposed work. A one-shot handle is not a continuable conversation. Further reuse needs task/role/model/batch identity, fresh completion events, cancellation, timeout, stale-result rejection, and cleanup. Reviewers must remain independent of authors.

Historical checks used isolated libraries, simulated adapters, and the official local DSH SDK. They establish lifecycle, routing, validation, and persistence behavior, not a user's authentication, connectivity, or real model quality. The complete Chinese companion retains historical audits.
