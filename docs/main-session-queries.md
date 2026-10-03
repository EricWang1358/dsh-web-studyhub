# Query sources and decks from the main chat

[中文](main-session-queries.zh-CN.md)

In DSH, the main chat reaches your StudyHub library through the `study_workspace` tool. You ask in plain words, and the assistant chooses the calls. This page lists what it can look up, so you can phrase requests precisely and check what it reports.

The assistant reads your library in small pages through these calls. It does not need temporary scripts that scan your files.

## What you can ask

| You want to | For example | The assistant calls |
| --- | --- | --- |
| See what is in your library | "What's in my study library?" | `library.context` |
| Find sources imported on a given day | "Which sources did I import yesterday?" | `source.list {importedOn:"yesterday"}` |
| Search or read source text | "Where do my sources explain the TCP handshake?" | `source.search`, then `source.get` |
| See which questions cite a source | "Which questions cite this lecture?" | `source.coverage` |
| Find existing questions | "Do I have questions on binary search?" | `card.search` |
| Add questions to an existing deck | "Add 5 questions from this lecture to my binary search deck." | `supplement`, see [Add questions to an existing deck](supplementation.md) |
| Publish a draft into an existing deck | "Merge this draft into my binary search deck." | `draft.publish` |

To import JSON deck files from your computer, see [Import files from the main chat](json-import.md#import-files-from-the-main-chat).

## How calls are written

This page writes a call as `action {arguments}`, for example `source.list {importedOn:"today"}`. The tool receives the action name and the arguments as a JSON string:

```json
{"action":"source.list","payload_json":"{\"importedOn\":\"today\"}"}
```

## Start with the library summary

`library.context` returns a short summary:

- the library folder, the time zone and today's date;
- the current focus: class or interview mode, course and target role;
- counts of sources, active decks, archived decks, drafts and questions in active decks;
- the first page of course names;
- the list of contract areas.

For the exact arguments of a group of actions, request one area, such as `library.context {area:"sources"}`, `{area:"generation"}` or `{area:"cards"}`. The areas are `sources`, `imports`, `classroom`, `generation`, `cards`, `learning`, `organization`, `notes`, `board`, `workflows`, `cases` and `skeletons`.

Read source text, questions and relationships page by page, and only when needed.

## Find sources by import date

```text
source.list {importedOn:"2026-09-29", timeZone:"Asia/Shanghai", offset:0, limit:50}
```

- `importedOn` takes a local calendar date (`YYYY-MM-DD`), `"today"` or `"yesterday"`.
- `importedFrom` and `importedTo` give a range that includes both end days. A range cannot be combined with `importedOn`.
- `timeZone` defaults to the host's time zone. Invalid dates, invalid time zones and reversed ranges return an error.
- `query` narrows the list by source title.

The result repeats the resolved dates and time zone. It also counts recorded, inferred and unknown dates before date filtering (`dateCounts`), and gives each source's time basis.

How a source's date is decided:

- StudyHub uses the recorded import time first. Older sources fall back to their `createdAt` value.
- Dates inferred from question citations are for display only and never match a date filter.
- A source with no known date never matches either. StudyHub does not guess from file timestamps.

## Limit by course or source

- Omit `course`, or pass `"*"`, for the whole library. An empty string selects uncategorised sources.
- A course name also covers its sub-courses, such as `Part Three / Week 2` under `Part Three`.
- `sourceIds:[]` explicitly selects no sources.
- These filters work the same way in `source.list`, `source.search` and `source.coverage`.
- An empty result is reported as empty. It never widens to the whole library.

## Browse large courses compactly

```text
source.list {groupBy:"document", course:"Part Three", offset:0, limit:30}
```

- `groupBy:"document"` groups the pages of one document, such as a PDF, by document ID. It groups the parts of a multi-part audio transcript by batch ID.
- Each group keeps its total member count, a page of member source IDs and the reference relationships.
- `memberOffset` and `memberLimit` page through members. `relationOffset` and `relationLimit` page through relationships.
- To read text, use `source.get {id, offset, limit}`. Avoid loading the whole library into one conversation.

## Check which questions cite a source

```text
source.coverage {sourceIds:["actual-source-id"], deckIds:["actual-deck-id"], targetOffset:0, targetLimit:20}
```

- Lists, per target deck, the questions that explicitly cite the selected sources.
- Active decks, archived decks and drafts are listed separately. Drafts are included only when you do not pass `deckIds`.
- Exact `deckIds` take priority over `course`. An unknown ID returns an error, and `deckIds:[]` selects no decks.
- `cardOffset` and `cardLimit` page through each deck's questions.
- Sources saved by a JSON import are counted separately and are not independent evidence.

How to read the numbers:

- `directReferences` counts selected independent sources (denominator) and those the target decks and drafts cite directly (numerator).
- `semanticCoverage` stays `unassessed`. A direct-reference rate is not concept coverage.
- A missing reference does not prove a missing concept. Read the sources and existing questions before you add prerequisites or more questions.

## Find questions and add them to a deck

- Search questions with `card.search {query, deckIds}`, scoped to exact deck IDs. Archived decks are skipped unless you pass `includeArchived:true`.
- When you ask for questions to be added to a deck, the assistant uses `supplement {deckId, sourceIds, count}`. It runs generation, review and publication into that deck as one background task. See [Add questions to an existing deck](supplementation.md).
- `generate {..., mergeTargetId}` instead creates a reviewed draft aimed at that deck. It never publishes by itself.
- Resume partial generation with `generate {resumeDraftId, draftVersion}`, using the draft's current `draftVersion`.
- Publishing merges the questions into the target deck. Original question IDs, review records, history and prerequisite links are kept.
- Record prerequisites with `capture {requiredBy}` or `card.link`.

## Publish a draft into an existing deck

1. Read the draft with `draft.get {id}` to get its current `draftVersion`.
2. Call `draft.publish {id, draftVersion, mergeTargetId}`.

Rules for the target:

- Reviewed publication (`draft.publish`), quick publication (`draft.publish.quick`) and background publication (`draft.publish.start`) use the same target rules.
- `deckId`, or `deck` (an ID or `{id}`), are accepted as compatibility aliases. When several are given, they must name the same deck, and it must match any target already saved on the draft.
- A target that is invalid, missing, conflicting, archived or not an ordinary deck fails with an error. It is never ignored.

Reading the result:

- `id`/`deckId`, `added` and `total` come from the same committed transaction. Use them to confirm where the questions went.
- `accepted` counts questions that passed the checks. On its own it does not show the merge destination.
- `draft.publish` publishes only the questions that pass its checks and review. The others stay in a draft with their problems listed (`rejectedDraft`). `draft.publish.quick` publishes every question and flags the problems instead.
- When every question is rejected, nothing is published: `id` is `null` and the questions stay in the draft.

`draft.save {deck}` saves a draft without publishing or merging it.

## Page sizes

| Call | Paging fields | Default / maximum |
| --- | --- | --- |
| `library.context` | `offset`, `limit` (course names) | 30 / 100 |
| `source.list` | `offset`, `limit` | 100 / 200 |
| `source.list {groupBy:"document"}` | `memberOffset`, `memberLimit` | 50 / 200 |
| Relationship lists | `relationOffset`, `relationLimit` | 20 / 100 |
| `source.get` | `offset`, `limit` (characters) | 20,000 / 60,000 |
| `source.search` | `limit` (snippets) | 8 / 50 |
| `source.coverage` | `offset`, `limit` (sources) | 50 / 200 |
| `source.coverage` | `targetOffset`, `targetLimit`; `cardOffset`, `cardLimit` | 20 / 100 each |
| `card.search` | `limit` | 20 / 50 |

## Design notes

The design and verification boundaries are recorded in the [integration plan](plans/2026-09-30-0016-feat-quiet-product-integration-plan.md) and the [verification record](quiet-product-integration-verification.md).
