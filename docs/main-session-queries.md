# Querying sources and existing decks from the main conversation

[中文](main-session-queries.zh-CN.md)

Use the existing `study_workspace` tool and begin with the small `library.context` summary. Request `library.context {area:"sources"}`, `{area:"generation"}`, or `{area:"cards"}` for specific contracts. Read source text, questions, and relationships in pages only when needed. Temporary filesystem-scanning scripts are unnecessary.

## Find sources by import date

`source.list {importedOn:"2026-09-29",timeZone:"Asia/Shanghai",offset:0,limit:50}` uses the local calendar date. You may use `importedOn:"today"` or `"yesterday"`, or an inclusive `importedFrom` / `importedTo` range. A single date and a range cannot be combined. Results report resolved dates, timezone, and each item's timestamp basis. Existing `createdAt` values remain a compatibility fallback. Dates inferred from question citations are display-only and do not participate in exact date filtering. Unknown dates are not guessed.

Omit `course` or use `"*"` for the whole library; an empty string selects uncategorized material. `sourceIds:[]` explicitly selects no sources. Date, course, and source scopes apply consistently to listing, search, and coverage. Empty results never silently broaden to the whole library.

## Compact catalogs and reference relationships

`source.list {groupBy:"document",course:"Part Three",offset:0,limit:30}` groups PDF pages by original document ID and multipart audio transcripts by batch ID. Groups retain total member counts, paginated source IDs, and reference relationships. Use `memberOffset` / `memberLimit` for further members and `source.get {id,offset,limit}` for text. Avoid loading the full library into one conversation.

`source.coverage {sourceIds:["actual-source-id"],deckIds:["actual-deck-id"],targetOffset:0,targetLimit:20}` lists questions in the exact target decks that explicitly cite selected sources. Active decks, archived decks, and drafts appear separately. JSON-import self-reference sources are separate and are not independent evidence.

The `directReferences` numerator and denominator describe explicit source references only. Missing references do not prove missing concepts. Read the sources and existing questions before deciding to add prerequisites or supplementary questions; direct-reference rate is not semantic coverage.

Search questions using `card.search` scoped to exact deck IDs. To add questions, point `generate.mergeTargetId` at the existing deck. Resume partial generation with `resumeDraftId` and the current `draftVersion`. Validation and publication merge the draft while preserving original card IDs, review records, history, and prerequisite links. Use `capture.requiredBy` or `card.link` for prerequisites.

Design and verification boundaries are recorded in the [integration plan](https://github.com/EricWang1358/dsh-web-studyhub/blob/v2.0.3/docs/plans/2026-09-30-0016-feat-quiet-product-integration-plan.md) and [verification record](https://github.com/EricWang1358/dsh-web-studyhub/blob/v2.0.3/docs/quiet-product-integration-verification.md).

## Publish an existing draft into an existing deck

Read `draft.get {id}` for `draftVersion`, then call `draft.publish {id,draftVersion,mergeTargetId}`. Quick and background publication share target rules. Compatibility fields `deckId` and `deck` (an ID or `{id}`) are accepted, but multiple fields must agree. Invalid, conflicting, or archived targets fail.

Success returns `id/deckId`, `added`, and `total` from the same committed transaction. `accepted` counts questions passing checks and does not establish the merge destination by itself. `draft.save {deck}` saves a draft without publishing or merging.
