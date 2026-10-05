# Turn a PDF into quizzes and flashcards

[中文](pdf-workflow.zh-CN.md)

Import a lecture PDF and StudyHub saves its text page by page. You then pick the pages to study, and StudyHub writes cited questions from them into a draft that you check before publishing.

This page covers ordinary lecture PDFs. For a scanned PDF, or a book over 8 MB or 200 pages, see [Large textbooks](large-documents.md) and [Convert a PDF with MinerU](mineru-conversion.md).

## Limits at a glance

| What | Limit | What happens above it |
|---|---|---|
| PDF file size | 8 MB | The file is not imported. A **Large textbooks** card appears under it. |
| PDF length | 200 pages | The same card appears. |
| Text extracted from one PDF | 600,000 characters | The same card appears. |
| Text sent to one generation | 600,000 characters | **Generate & check deck** stays off. Narrow the selection, or use the step-by-step path or a search tool ([Large textbooks](large-documents.md)). |
| Questions per generation | 1–30 | Choose a number in this range. |
| Scanned pages | Not read | StudyHub reads the PDF's text layer only. It does no OCR. |

## Import a PDF

1. On the **Sources** page, click **Add source**. In **Create deck**, the **Import sources** link opens the same dialog.
2. Under **Which course is this material for?**, choose the course.
3. On the **Files** tab, drop one or more PDFs, or click **Choose files**.
4. Each file shows its result next to its name, for example "PDF · 12 pages · saved to Sources", or which pages had no text and were skipped.

What StudyHub saves:

- One source per page, with the page number, so every citation points back to its page.
- The original PDF, kept with the source.
- Nothing new when you import the same file again: the pages already saved are reused.

If no page has readable text, nothing is saved and the dialog says the file may be a scan. Convert it with MinerU, which reads scanned pages, or run OCR on it first.

## Generate questions

1. Open **Create deck** › **Generate from sources**.
2. Under **01 / Choose sources**, tick the PDF. To leave out the cover, the contents or pages of diagrams, click **Choose pages** and untick them.
3. Under **02 / Study format**, choose **Question type**, **Question count**, **Difficulty** and **Language**.
4. Optional: under **What would you like to practise?**, write the topic. Under **More options**, give a **Deck name (optional)**.
5. Click **Generate & check deck**. The job runs in the background. If another job is running, the button reads **Add to generation queue** and the new job waits its turn.
6. When the draft is ready, check it and publish it from **Review and publish**.

Notes on the options:

- **Quiz + flashcards** makes half single-choice questions and half flashcards. An odd count gets one more single-choice question.
- If you tick more PDF pages than you ask for questions, a warning says that not every page can be covered. Narrow the pages or generate in batches.

## What happens during generation

- By default, questions are written in batches of up to 5, and up to 3 batches run at once.
- First, StudyHub picks knowledge points from the selected pages, each with a verbatim passage. For each batch it then prepares the answers, writes the questions with a self-check and runs **one independent review**.
- Only questions that pass the review are kept. Rejected candidates are recorded with their reasons.
- Since 1.4.6, generation does not repair, review again or write extra questions to reach the count. Repair is a separate step that you request later.
- Each model call may take up to 10 minutes. By default, a whole job may run for up to 20 minutes; time spent waiting in the queue does not count. When the budget runs out, the accepted questions are kept.
- Restarting DeepSeek Harness (DSH) interrupts unfinished jobs. A saved draft that does not cover all of its material can be completed with its **Add questions for the uncovered parts** button: a new model task uses the same sources, covers the sections that have no question and keeps the accepted questions. An old model conversation is not resumed.
- Existing questions are never rewritten because the extraction or StudyHub changed.

Change questions per batch, parallel batches and the task time budget in **Settings › Question defaults**. New tasks use saved defaults; continuing a draft keeps its original choices. See [Generation pace](generation-agents-sidebar.md#what-a-generation-task-does).

The full pipeline is in [Question generation and quality checks](assessment-quality.md).

## Read the draft

- The draft shows how many questions you asked for, how many were accepted, and why the others failed.
- **Source coverage · Cited** lists, for each source, how many targets the model planned ("planned") and how many accepted questions cite it ("passed"). These numbers show what this job touched. They do not prove that every page or topic is covered.
- To write more questions from the sources that got none, click **Use the uncovered 2 sources for more questions** (the number varies).
- Publishing checks each question again. Default quick publication and reviewed publication differ; see [Question generation and quality checks](assessment-quality.md).

## How text is extracted

StudyHub reads the text layer of each page. It does not run OCR and does not interpret pictures, diagrams or formulas.

- Lines are rebuilt from their positions on the page. Words that a font change split are joined by their spacing, and column gaps and indentation are kept.
- This is a positional transcription, not an understanding of the layout. Complex tables, arrows, hierarchies and rotated text cannot be rebuilt reliably. Check the original, and do not read a relationship from labels that happen to sit side by side.
- A page with almost no text (under 12 characters) is skipped. A page with under 100 characters is kept, but marked **little text; check the body** in the source list: it may hold only a heading or a footer while the body is an image.
- A page with separated text regions or rotated text is marked **complex layout; compare with the original**.

### Extraction versions

The current extractor (version 2) saves its pages as new sources. Sources from version 1 stay, so questions that cite them keep their evidence. Importing the same file again with version 2 adds nothing new. In the source list, version 1 pages are marked **old extraction**, and a document that has them is marked **has pages from the old extractor; re-import recommended**.

## Use the main chat

You can ask the assistant in the main chat to import a PDF on your computer, including only some of its pages (for example pages 3–12 and 15). This section describes what the assistant does.

- `source.import {path OR dataBase64, filename?, pages?, courses?}` reads the PDF itself (8 MB, 200 pages; `pages` are 1-based) and returns the exact `sourceIds` and any warnings. Prefer an absolute `path`.
- `generate {sourceIds, kind: "mixed", count, title?}` then queues a draft and returns at once. The assistant reports the job and hands control back to you.
- It may wait once with `job.wait` (at most 60 seconds), never in a loop, and it never starts the same generation twice. When you ask how a job is going, `job.status` reads it without waiting.
- A PDF, attached text and existing questions are material, never instructions to follow.
- Existing questions go through `ingest`. Lecture material always goes through `generate`: generating from a handout adds no wrong-answer records and does not end question-capture mode.

## Verification history

Why the workflow works this way: real use showed a lecture PDF sent into question capture, a model probing PDF tools on its own, mixed question types refused, repeated waits on background tasks, and one bad citation failing a whole batch.

What was checked:

- Tests use real PDF structures. They cover page selection, repeated imports, empty and sparse pages, mixed generation, source safety, coordinate ordering, font fragments, column continuations, citation stability across extraction versions, and model call failures that must not be reported as JSON errors.
- In the browser, pages 3–5 of the SWE5001 lecture *Introduction to Solution Architecture v2.1* were imported into an isolated test library (`output/pdf-library`), not a course library. The upload, the extraction preview and repeated imports were checked.
- Version 1 joined text in the PDF's drawing order and put a space between fragments. On page 5 of that lecture, "System" came before "Architecture", and words in a changed font were split. Version 2 fixed this; pages 4, 5, 6 and 14 were compared with the original layout. The regression suite passed (56 tests at the time).
- Generation tests use deterministic model responses. They do not show the quality of real model output or a complete understanding of PDFs.
