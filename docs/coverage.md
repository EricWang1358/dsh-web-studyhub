# Coverage of a material (覆盖)

Phase 2 of [coverage-driven generation](plans/coverage-generation/README.md). A learner who generates questions from a long material can see, before practising, **which sections of it have a question**, which were planned and did not come out (and why), and which were never planned; and one action fills the gaps.

## The model (`lib/coverage.js`, pure and browser-safe)

`coverageOf({ sources, cards, partPlans, ...sectionOptions })` counts **leaf sections** (`lib/sections.js`: kept outline, PDF page, transcript part, Markdown heading, fixed window). A section is

| state | meaning |
| --- | --- |
| `covered` | at least one question's place falls in it. The place is the question's selection offsets, else where its quote stands in the source (a quote written a little differently from the stored text is still found: `lib/quote-locate.js`); a question that cites a source with a single section covers it with no offset. |
| `planned-failed` | a planned target of a run (`editorial.partPlans`, `lib/plan-record.js`: offsets, else the quote, else the range of its part) with status `failed` or `omitted` falls in it and no question does; a part that never reached targets is its range. `reason` is the code of `lib/generation-failure.js`. |
| `never-planned` | neither. A draft from before plans were kept has no `partPlans` (`recorded: false`): its uncovered sections are said to have *no record*. |

The result carries `sections`, the counts, `percentLeaves`, `percentChars`, `perTenK` (questions per 10 000 characters), `units`, `unplaced` (questions that point into a many-section source at no offset that can be found: they cover nothing, and the count says so) and `groups` (one row per recording or chapter). A 530,000-character, 80-part material with 400 questions takes about 40 ms.

Backend views (`lib/coverage-state.js`): a draft's own coverage, a document's (every published or draft question of the library that points into it; archived decks, suspended questions and copies of published decks are left out), and the digest the snapshot keeps per document (`materialCoverage`: `[covered, plannedFailed, neverPlanned, recorded, units]`, a few characters, because the snapshot is paid for in characters).

Service actions: `coverage.get { draftId }` (coverage and the round a top-up would run now, `canTopUp`) and `coverage.get { documentId | sourceId }`.

## Where it is shown (one wording: `ui/coverage/copy.js`)

- 任务 console › 资料部分: each part says 覆盖 3/8 小节 for its range and a small bar; the strip names the sections of the part with no question and the real reason of each. A finished (or archived) run has 为没覆盖的部分补题 in the header.
- Draft page: the summary at the top (「覆盖 7/80 个部分（9%）· 3 个计划了没出成 · 70 个没计划到」), one row per recording, the list of what has no question with the way to the reader at that section, and the one top-up.
- 资料 page row and the reader's toolbar: 覆盖 9% beside the mastery mark, before anything is published (drafts count).
- Reader outline: a square mark per section (solid with a tick · hatched · dashed), a count on every recording, 覆盖 7/80 in the header and 只看没覆盖的; the 做这几页的题 panel says in one line when part of its range has no question. Coverage is *asked*, mastery is *learned*: coverage is a square, mastery a ring, and the words never mix.

## The one top-up (`lib/coverage-round.js`)

`generate { resumeDraftId, draftVersion, coverage: { sectionIds? } }` (without `sectionIds`: the default round). It covers exactly the uncovered sections, planned-and-failed first, then never-planned, in reading order, up to the generation limit of 30 questions a round (raising it is phase 3); it says honestly how many more rounds the rest needs. A planned-and-failed section with located targets is written again from those targets as they were (no planning call; the verbatim quote is the stored text between the offsets); every other section is planned from its own text, the planner being given only the text of those sections (cut at their offsets, so every citation still checks against the full source). The approved questions stay and the new ones merge into the same draft. The draft's `requested` does not grow beyond the questions it holds. `usage.estimate { feature: 'generate', resumeDraftId, draftVersion, coverage }` prices exactly that request, so it costs about what it covers (see [token usage](token-usage.md)). The old two controls (继续补齐 N 题, 补 N 题) are gone from the screens; the agent's plain `generate { resumeDraftId, draftVersion }` and `extraSourceIds` still work.
