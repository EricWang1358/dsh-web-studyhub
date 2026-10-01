# Question generation and quality checks

[中文 and historical verification records](assessment-quality.zh-CN.md)

Built-in source generation and explicitly reviewed publication have quality checks. The current draft interface defaults to quick publication without model review; do not apply model-review guarantees to every external JSON import or default publish action.

## Current generation pipeline

Source generation, including PDF-to-quiz/flashcard, uses batches of up to five questions. Shared evidence planning assigns objectives across source blocks, and up to three batches can run concurrently. Within each batch:

1. Plan evidence, answer boundaries, comparison dimensions, misconceptions, and required prompt context. Local validation confirms planned quotations exist in selected sources.
2. Write questions and perform author self-check in the same author task, returning revised complete candidates and brief changes.
3. Validate structure, citation locations, answer leakage, and learner-visible context.
4. Run **one independent editorial review** against material and candidate questions. Required per-question checks include self-contained context, answer leakage, option quality, learning value, evidence support, and explanation quality. Explanations must connect conditions to the answer and teach reasoning and error boundaries, rather than merely restating the answer.
5. Retain only accepted candidates and record rejected candidates with reasons. Since 1.4.6, neither normal generation nor supplementation automatically repairs, repeats independent review, or generates more merely to reach the requested count. Unreadable or incomplete review output is a protocol failure rather than permission to review again.

Author self-assessment is never independent approval. Type errors affect the corresponding candidate. Recoverable complete questions in damaged author JSON still require independent review. A batch-level problem that cannot be attributed safely is not ignored.

Normal model work comprises shared planning and one author plus one editor request per batch. Format recovery for authors remains bounded; it is separate from repeating editorial review. Execution records show native subagents when supported and actual direct calls otherwise. The plugin collects stage output internally and sends final notifications rather than flooding the main conversation with stage JSON.

For supplementation, budget expiry can merge saved questions with unchanged valid review evidence without another model request, while reporting the shortfall. Cancellation, version conflicts, target archival, and subsequent edits continue to block affected publication.

## Publication and explicit repair

Generated questions record reviewed-content fingerprints. Editing invalidates that review. Incomplete content can stay in drafts; publication validates structure question by question.

The explicit reviewed-publication route can independently check modified, new, or older questions lacking fingerprints when a model is available. If a batch failure cannot be attributed, it may review questions individually. Accepted questions publish while confirmed defects stay pending. A failed per-question model request means incomplete review; structurally valid content can publish with a **Not automatically reviewed** marker. Offline publication remains possible with visible unreviewed counts.

Users can explicitly request background repair and independent review, then publish accepted repairs into the original deck. Missing citations use original generation sources, or the single source of a single-source draft. If none is available, select material first. Repairs consider the target's existing objectives and cannot introduce duplicates. Unsaved page edits are not submitted to background repair. Saving a manually edited pending question clears its old failure verdict; the new content is checked when published.

These explicit publication/repair capabilities are separate from the one-round generation policy above. Default quick publication does not wait for them.

## Evidence, privacy, and limits

Checks address implausible distractors, leaked answers, dependence on invisible slides or recordings, meaningless diagram-position questions, and unsupported distinctions disguised as application problems. Concise foundational flashcards remain valid without an invented scenario. PDF text coordinates do not prove diagram semantics.

Before answering, public card data hides learning objectives and rubrics that could reveal answers. Original metadata remains stored; rubrics become available after reveal. `ingest` preserves existing questions rather than rewriting them. Do not generate in the conversation and then use ingest to bypass generation checks. Existing questions are not automatically rewritten after an update.

Generation-stage calls have a ten-minute limit across direct, one-shot, and communicating-subagent execution; ordinary teaching calls retain their separate limits. Timeout is not a content-quality rejection and does not guarantee the requested count.

After revealing an explanation, **Explain again clearly** generates and saves a supplementary explanation without first requesting follow-up suggestions or changing review progress. It must acknowledge insufficient evidence or an erroneous original question rather than invent reasons to defend an answer.

Automated fixtures verify sequencing, evidence and context checks, per-question review records, explanation quality, accepted subsets, protocol failures, and answer hiding. Browser fixtures verify explanation/retry interactions. These tests and repeated review do not prove factual correctness or real teaching effectiveness.

## Planned curriculum coverage and learning evidence

Question validity, curriculum coverage, and learner competence are separate conclusions. A reviewed question does not prove the course is complete or the learner can transfer knowledge.

The proposed evidence system is not delivered. It would bind tasks to stable concepts and objective versions, mandatory rubric criteria, and task families; track hint/answer exposure; and credit demonstrated dimensions only. Self-ratings, repetitions, keyword-based application labels, indirect prerequisite credit, and generated notes would not independently certify a concept. Missing model results would remain unassessed. Delayed recall would account for the concept's latest teaching, hint, or practice across questions.

See the [Evidence Policy and implementation units](https://github.com/EricWang1358/dsh-web-studyhub/blob/v2.0.3/docs/plans/2026-09-27-1945-feat-evidence-based-learning-plan.md) and [proposed workflow](study-workflows.md#proposed-system-learning). Historical audits remain in the Chinese companion.
