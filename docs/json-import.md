# Importing JSON question decks

[中文](json-import.zh-CN.md)

In **Create deck → JSON import**, select the question type, copy the prompt, and add your material before asking an external AI to produce JSON. You can also expand the format examples and write JSON yourself. Paste the result or select a UTF-8 `.json` or `.txt` file, then choose **Validate and import draft**. TXT files must contain JSON; use the conversational **Import existing questions** flow for ordinary question text.

Supported types are single-choice `quiz`, multiple-choice `multi`, `flashcard`, open-response `open`, and fill-in-the-blank `cloze`. One deck may mix types. The top-level structure is `{"title":"Deck name","folder":"Optional folder","cards":[...]}`. A deck needs at least one question; this import has no question-count limit. Text is limited to 500,000 characters and files to 2 MB. A UTF-8 BOM and a Markdown code fence around the entire JSON are accepted.

Complete examples are available in the interface and `ui/json-prompts.js`. Each question needs `kind`, `topic`, `objective`, `prompt`, `answer`, `hint`, `explanation`, and `misconception`. Choice questions need 3–6 options, each containing `id`, `text`, `correct`, and `explanation`. Open-response questions need `rubric`; cloze questions need `cloze.text` and `cloze.answers`.

The `draft.import {text}` service saves the imported source and new draft in one transaction. JSON syntax or structures that cannot be read safely are rejected. Questions with missing ordinary text fields or damaged option structures remain in the draft for repair; original content stays in the import source.

The interface defaults to `draft.publish.quick`: publish all questions without waiting for model review, then start up to ten new questions. Flagged questions retain warnings. An ungradable question can be skipped without changing review progress. The individually reviewed publication route remains separate. The per-question editor can add or remove options; selecting a correct single-choice option clears the other correct flags. External IDs, review progress, suspended status, and prerequisite links are not inherited.

If original material is already in the library, questions may include `citations: [{"quote":"An exact source passage of at least 12 characters"}]`. Add `sourceTitle` or a local `sourceId` when names or quotes are ambiguous. Citations link only on a unique local match. Unmatched citations are skipped and counted in the draft. External-import markers remain: imported questions themselves are not independent factual evidence.

Matching a quote proves that the passage exists, not that an answer was independently verified. Import and default quick publication do not invoke model review. Successful publication does not establish complete source coverage.

## Planned system-learning import boundary

This is proposed work, not a delivered feature. Five JSON files prove that five decks were saved, not that every core concept in five PDFs is covered. A proposed curriculum ledger would audit mappings between explicitly linked passages, required concepts, and learning tasks. Learning would remain possible without original sources, with coverage marked unverified.

The proposed audit would not block quick publication, require individual manual review, or merge decks automatically. The current import allowlist does not retain arbitrary fields such as `knowledgePointId` or scope versions; future support needs an explicit compatibility protocol or separate mapping.

See [R1–R4 and U2/U3 in the plan](https://github.com/EricWang1358/dsh-web-studyhub/blob/v2.0.3/docs/plans/2026-09-27-1945-feat-evidence-based-learning-plan.md) and the [proposed learning workflow](study-workflows.md#proposed-system-learning).
