# Import JSON decks

[中文](json-import.zh-CN.md)

A JSON deck brings in questions you already have, or questions another AI wrote from your sources. StudyHub saves the import as a draft. You check it, then one click publishes it and starts practice. Importing does not review questions with a model.

## Choose where to import

| Where | What it takes | What happens |
| --- | --- | --- |
| **Create deck** › **Import JSON deck** tab | Pasted JSON, or one `.json` or `.txt` file of up to 2 MB | You confirm a suggested title and course, then StudyHub saves a draft. |
| **Add source** dialog | One or more `.json` deck files of up to 2 MB each | Each file becomes a draft with the suggested title, filed under the course chosen in the dialog or the suggested one. |
| Main chat | Files or folders on your computer, up to 50 files at a time | Questions are published at once. See [Import files from the main chat](#import-files-from-the-main-chat). |

In the **Add source** dialog, StudyHub recognises JSON from a document converter (MinerU, Docling) and subtitle JSON, and imports those as a document or as subtitles instead.

## Import a deck on the Create deck page

1. Open **Create deck** and choose the **Import JSON deck** tab.
2. Under **01 / JSON prompts by question type**, choose a **Question type**, or **Mixed question types (copy all)**.
3. Click **Copy prompt**. Paste it into another AI and add your sources and requirements after it. The mixed prompt asks for 10 questions, 2 of each type, unless you ask for something else.
4. Under **02 / Import deck**, paste the AI's reply into **JSON content**, or drop a file on **Drag a JSON deck file here**. **Read JSON / TXT file** opens a file picker.
5. Click **Check & suggest grouping**. StudyHub checks the JSON and suggests a **Short title** and a **Course**. Edit either one if needed.
6. Click **Confirm & import draft**. The draft opens.

To write the JSON yourself, expand **View JSON example** for the chosen type.

A `.txt` file must contain JSON. For questions that are not JSON, such as quiz-app questions, mistakes or screenshots, use the **Record questions in the chat** tab. That tab appears only when a chat is available.

### What the suggestion step does

- If a model is available, **Check & suggest grouping** makes one model call to suggest the title, the course and a deck to merge into. The note above the fields reads **AI suggestion; confirm or edit**.
- The model receives the deck title and folder, up to 8 sample questions (topic, objective and the start of the prompt), your course names, and the titles and topics of up to 30 recent decks. StudyHub uses only its three suggestions and never changes the questions.
- Without a model, StudyHub suggests the original title and your current course, or the deck's `folder` when it names one of your courses. The note reads **Initial suggestion; confirm or edit**.
- A `course` field in the JSON takes priority over the model's course.
- If the model finds an active deck in the same course on the same topic, a checkbox offers **Merge into the suggested deck for the same concept when publishing (keep all questions and records)**. Changing the course removes this offer.

## Write the JSON

### Deck fields

| Field | Required | Notes |
| --- | --- | --- |
| `title` | Yes | Non-empty text. |
| `folder` | No | Text. Folders only group decks for display. |
| `course` | No | Text of up to 200 characters. Becomes the suggested course instead of the model's choice. |
| `cards` | Yes | The questions: at least 1, with no upper limit. One deck may mix question types. |

### Question fields

| Field | Required for | Notes |
| --- | --- | --- |
| `kind` | Every question | `quiz` (single choice), `multi` (multiple choice), `flashcard`, `open` (open response) or `cloze` (fill in the blank). |
| `topic`, `objective`, `prompt`, `answer`, `hint`, `explanation`, `misconception` | Every question | Non-empty text. |
| `options` | `quiz`, `multi` | 3–6 options. Each has `id`, `text`, `correct` (`true` or `false`) and `explanation`. A `quiz` has exactly 1 correct option. A `multi` has at least 1 correct and at least 1 incorrect option. |
| `rubric` | `open` | The scoring rubric, as text. |
| `cloze` | `cloze` | `{"text": "...", "answers": [...]}`. `text` is the sentence shown, with each blank marked `{{id}}`. Each answer has `id`, `value` and an optional `accept` list of other correct answers. Every marker needs one answer, and every answer needs one marker. |
| `citations` | Optional | Links to sources already in your library. See [Link questions to your sources](#link-questions-to-your-sources). |

A single-choice deck looks like this (from the built-in examples in `ui/json-prompts.js`):

```json
{
  "title": "Binary search practice",
  "folder": "Algorithms",
  "cards": [
    {
      "kind": "quiz",
      "topic": "Binary search",
      "objective": "Explain the input requirement for binary search",
      "prompt": "Which sequence can be used directly for binary search?",
      "answer": "An ascending sequence",
      "hint": "Consider what justifies eliminating half of the search range.",
      "explanation": "Ordering allows comparison with the middle value to eliminate half of the search range.",
      "misconception": "Assuming binary search works directly on any sequence.",
      "options": [
        { "id": "a", "text": "An ascending sequence", "correct": true, "explanation": "Ascending order allows half of the search range to be discarded." },
        { "id": "b", "text": "A randomly shuffled sequence", "correct": false, "explanation": "Shuffled data cannot eliminate half based on the middle value." },
        { "id": "c", "text": "A sequence with no ordering guarantee", "correct": false, "explanation": "Without ordering, the correct half cannot be determined." }
      ]
    }
  ]
}
```

### What StudyHub accepts and drops

- Text of up to 500,000 characters. Files must be UTF-8.
- A UTF-8 BOM, and a Markdown code fence around the whole JSON (```` ``` ```` or ```` ```json ````).
- StudyHub keeps only the fields in the tables above and drops everything else.
- Every imported question gets a new ID. IDs, review progress, suspended status and prerequisite links from elsewhere are not carried over.

## How StudyHub checks an import

**The whole import is rejected** when StudyHub cannot read it safely:

- the JSON has a syntax error, or the top level is not an object;
- `cards` is missing or empty, or a question is not an object;
- `title` is missing or empty;
- a question has no `kind`, or one outside the five above;
- a field has the wrong type, such as a number where text belongs or a `folder` that is not text;
- `course` is longer than 200 characters.

**Damaged questions stay in the draft** for you to repair:

- missing text fields are left empty;
- malformed `options` become an empty list;
- a malformed `cloze` keeps its text but loses its answers;
- a `rubric` that is not text is left empty.

The original JSON of every question is also saved in a separate import source.

**Other problems are flagged, not rejected.** The draft lists them, and publishing keeps a flag on each affected question. A question is flagged when, for example:

- a required field is empty;
- two questions in the deck share an objective or a prompt;
- the hint repeats the answer;
- the options break the rules above, or two options share an `id` or text;
- an `open` question has no rubric;
- `cloze` markers and answers do not match.

The draft also warns when option lengths differ enough to give the answer away.

## Publish and start practising

The draft opens on the **Draft & publish** page.

- **Save & validate** saves your edits and checks them again.
- For choice questions, you can add options (up to 6) or click **Delete this option**. Choosing the correct option of a single-choice question clears the others.
- **Save & publish** publishes every question at once, without waiting for model review. It then starts a round of up to 10 new questions. If none can start, StudyHub says the deck is published and returns to the library.
- If you ticked the merge option, publishing merges the questions into the suggested deck and keeps its questions and records.
- Questions with problems are published with their flags. During practice, a question with nothing to grade can be skipped with **Skip without scoring**. Skipping records no score and does not change the review schedule.

A separate publication path reviews questions one by one. It is not the default for imports. See [Publish a draft into an existing deck](main-session-queries.md#publish-a-draft-into-an-existing-deck).

## Link questions to your sources

If the original source is already in your library, a question can cite it:

```json
"citations": [{ "quote": "An exact passage from the source, at least 12 characters", "sourceTitle": "Optional source title" }]
```

- `quote` must be copied word for word from the source and be at least 12 characters long.
- When titles or passages repeat, add `sourceTitle`, or the source's local `sourceId`.
- StudyHub links a citation only when exactly 1 source in your library matches. Other JSON import sources never count.
- Unmatched citations are skipped, and the draft shows how many.

What a citation proves:

- A matched quote shows that the passage exists. It does not show that the answer was checked.
- Imported questions keep their import marker, so a question never counts as evidence for itself.
- Import and the default publish do not run model review. A successful publish does not mean your sources are fully covered.

## Import files from the main chat

In the main chat, you can ask StudyHub to import JSON deck files from your computer. The assistant uses `deck.import`, which works differently from the panel:

- Paths must be absolute. A folder means all the `.json` files in it, in name order. A single file may be `.json` or `.txt`.
- Up to 50 files per call, each of up to 500,000 characters.
- Each file may be a deck object as above, or a bare array of questions. A missing title becomes the file name.
- Questions are **published at once**, not saved as a draft.
- `into` names the target deck, and works only with a single file. Otherwise, an active deck with the same title, folder and course receives the questions.
- A question whose prompt (for `cloze`, its text) already exists in that deck is skipped, as is a repeat within the file. The comparison ignores case, spaces and punctuation.
- The reply lists, per file, the questions added and skipped, the deck total and up to 5 warnings, or the error.

`folder` and `course` in the call override the values in the files.

## Reference for the main chat and developers

| Call | What it does |
| --- | --- |
| `draft.import.propose {text}` | Checks the JSON and returns `originalTitle`, `title`, `course`, `mergeTargetId` and `method` (`ai` or `rules`). Writes nothing. |
| `draft.import {text, title?, course?, mergeTargetId?}` | Saves the import source and the new draft in one transaction. |
| `draft.publish.quick {id, draftVersion, mergeTargetId?}` | What **Save & publish** calls after saving the draft. Publishes all questions with structural checks only. |
| `draft.publish` / `draft.publish.start` | Reviewed publication, now or as a background task. |
| `deck.import {path \| paths \| text, folder?, course?, into?}` | Imports files from disk and publishes them, as described above. |

Complete examples for every question type are in `ui/json-prompts.js`. For how the main chat calls these actions, see [Query sources and decks from the main chat](main-session-queries.md).

## Planned: coverage audit for system learning

This is proposed work, not a delivered feature.

- Five JSON files prove that five decks were saved. They do not prove that every core concept in five PDFs is covered.
- A proposed curriculum ledger would audit the mapping between explicitly linked passages, required concepts and learning tasks.
- Learning would stay possible without the original sources; coverage would be marked unverified.
- The audit would not block quick publication, require manual review of each question, or merge decks automatically.
- The current import keeps only the fields listed above. Extra fields such as `knowledgePointId` or scope versions are dropped. Future support needs an explicit compatibility protocol or a separate mapping.

See [R1–R4 and U2/U3 in the plan](plans/2026-09-27-1945-feat-evidence-based-learning-plan.md) and the [proposed learning workflow](study-workflows.md#proposed-system-learning).
