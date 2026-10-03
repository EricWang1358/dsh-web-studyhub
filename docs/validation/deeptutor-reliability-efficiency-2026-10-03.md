# Reliability and generation efficiency: DeepTutor comparison

The selected priority is reliable, efficient practice. This is a source-code comparison and a measurement plan, not a claim that StudyHub has already outperformed DeepTutor. No competitor service, paid model or real learner library was used.

## Comparison baseline

The reference is [HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor), inspected at `ef2d9e5c3c99fd073742c5aadc2bb9584b1e503b`, under Apache-2.0. Its capabilities have concrete implementations:

- [Shared session context](https://github.com/HKUDS/DeepTutor/blob/ef2d9e5c3c99fd073742c5aadc2bb9584b1e503b/deeptutor/core/context.py#L86-L144) and [layered memory](https://github.com/HKUDS/DeepTutor/blob/ef2d9e5c3c99fd073742c5aadc2bb9584b1e503b/deeptutor/services/memory/paths.py#L1-L11).
- [Evidence-weighted mastery](https://github.com/HKUDS/DeepTutor/blob/ef2d9e5c3c99fd073742c5aadc2bb9584b1e503b/deeptutor/learning/mastery.py#L15-L37) and [mastery gates](https://github.com/HKUDS/DeepTutor/blob/ef2d9e5c3c99fd073742c5aadc2bb9584b1e503b/deeptutor/learning/policy.py#L33-L90).
- [Incremental book compilation](https://github.com/HKUDS/DeepTutor/blob/ef2d9e5c3c99fd073742c5aadc2bb9584b1e503b/deeptutor/book/compiler.py#L152-L250), controlled concurrency and [context budgets](https://github.com/HKUDS/DeepTutor/blob/ef2d9e5c3c99fd073742c5aadc2bb9584b1e503b/deeptutor/agents/loop/context_budget.py#L57-L103).

Both projects have source-grounding, learning-state and cost-control mechanisms. Those features alone do not establish an advantage. Popularity counts are not learning-quality measures. No competitor code was copied.

## Delivered reliability improvement

Two isolated races were reproduced before this change: an in-flight coaching summary restored a forgotten profile, and an in-flight preparation task recreated ready questions after forgetting. A temporary library and gated fake model held the responses until after the reset.

Learner memory and preparation-consent revisions now persist independently. The final storage transaction accepts prepared questions only while the captured revisions and current consent still match. A late coaching summary cannot overwrite a newer memory revision or a different goal. Forgetting preserves practice history and historical debriefs; it clears the learner profile and pending ready questions as before.

Regression coverage includes forgetting and restoring the same goal, a newer summary surviving the late response, revoking consent, revoking and re-enabling consent, forgetting and re-enabling consent, and preparing normally after reopening the service. An independent review ran 82 coach and assessment regressions successfully. The original two race reproductions changed from failing to passing. No model stage or call was added, and old learner records receive revision defaults.

Clear-expression guidance is shared by answer preparation, author self-check and independent review. It preserves exact quotes, technical terms, negation, exceptions and decisive conditions. It adds no fixed word limit, approved-word dictionary or additional call. See [question quality](../assessment-quality.md).

## Measurements required before claiming an advantage

| Dimension | Measurement | Acceptance boundary |
| --- | --- | --- |
| Supported questions | Blind-reviewed first-draft acceptance; unsupported-answer rate; invalid-citation rejection rate | Existing or forged quotes must not be accepted as evidence merely because their wording looks plausible. Scripted tests do not establish real semantic accuracy. |
| Preserved progress | Verified items retained after a failed correction; late writes after forgetting or revocation | Previously verified results survive supported correction failures; invalidated coaching writes must be zero in controlled race cases. |
| Useful latency | P50/P95 time to the first reviewed and durably saved question | Compare usable saved output, separating provider wait, generation, validation and storage time. |
| Generation cost | Actual tokens and provider cost divided by accepted questions; retry overhead | Rejected questions are not counted as successful output. Record model, settings and concurrency. |
| Learning outcomes | Delayed retention and new-scenario transfer | Requires a separate consented study; neither spaced repetition nor a mastery score proves better learning by itself. |

A comparative run must pin both commits and use the same materials, question count, model route and sampling settings. It must disclose concurrency, cache state and network conditions. Real-provider acceptance, latency, cost and learner outcomes remain unmeasured here. Broad research, writing and interactive-book features are outside this focused PR.
