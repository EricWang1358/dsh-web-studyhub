# Adding questions to an existing deck

[中文](supplementation.zh-CN.md)

Use `supplement` to add missing concepts from material to an existing deck. The plugin generates, reviews, and publishes within the authorized workflow.

```json
{"action":"supplement","payload_json":"{\"deckId\":\"complete-target-deck-id\",\"sourceIds\":[\"source-id\"],\"count\":5,\"kind\":\"flashcard\",\"focus\":\"Missing concepts confirmed by comparison with existing questions\"}"}
```

Compare sources with actual target questions before choosing gaps, counts, and prerequisites. `source.coverage` direct-reference counts locate evidence, not semantic coverage. Title numbers are not question counts. Save explicit prerequisites with `capture.requiredBy` or `card.link`.

The target must be an explicit, non-archived ordinary deck. The request authorizes local generation, review, and publication. Stage JSON is collected internally rather than injected into the conversation. `generate` still creates a draft only.

Reviewed questions merge into the original deck; complete success removes the internal draft checkpoint. Final receipts contain `publication.deckId`, `added`, `total`, and `remainingDraftId`. Report committed additions only. Original IDs, review records, and history remain; no new standalone deck is created.

Each batch gets one independent review. Accepted questions remain, rejected candidates are removed with reasons, and the plugin does not repeatedly repair or generate to meet a count. Budget expiry can publish saved questions with unchanged review evidence without another model call and reports the shortfall. Cancellation takes priority. Version conflicts, target archival, and edits still prevent affected publication.

Deleted/archived targets, conflicts, cancellation, and review failures do not restart automatically or fall back to another deck. Checkpoints remain recoverable. Zero accepted questions fails; partial success reports additions and shortfall. Resume with `resumeDraftId` and current `draftVersion`; the target must match `deckId`.

`job.wait` permits one bounded wait up to 60 seconds for authorized work without an extra request to wait. Timeout returns control; final notifications report results. Do not poll in a loop or enqueue duplicates.
