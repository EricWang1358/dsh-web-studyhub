# PDF sources to quizzes and flashcards

[中文 and historical verification notes](pdf-workflow.zh-CN.md)

## Workflow

1. In **Create deck → Generate questions from sources**, upload a PDF. **Add source** offers the same import. Optionally specify pages such as `3-12, 15`.
2. Original text is saved per page with an extraction preview. Select generation pages and deselect covers, contents, or diagrams as needed. Reimporting the same file and extraction-version page reuses its source.
3. Choose quiz, flashcard, or mixed types, a total count, and a course/deck title. A mixed job allocates half single-choice and half flashcards, with an extra single-choice question for odd counts.
4. Generation processes batches of up to five questions. It plans evidence, combines authorship with self-check, validates structure/citations, and runs **exactly one independent review per batch**. Passing candidates remain; failures are recorded and dropped. Since 1.4.6, generation does not automatically loop through repair/review or generate extra questions to fill the count. Later explicit repair is separate.
5. The draft shows requested and actual counts, failure reasons, and sources without accepted citations. Review and publication are separate from extraction; consult [quality boundaries](assessment-quality.md), especially the difference between default quick publication and reviewed publication.

The conversation API accepts an absolute local path through `source.import {path, pages?}`. Then pass the returned IDs to `generate {sourceIds, kind:"mixed", count, title?}`. Browser uploads use the same import action with file content. PDFs, attached text, and questions are treated as material rather than executable instructions.

Use `ingest` for existing questions. Generating from a handout does not add wrong-answer records or close question-capture mode. Enqueueing returns control by default; do not repeatedly wait or start duplicate generation.

## Limits

- PDFs: 8 MB, 200 pages, and 600,000 selected text characters. The documented PDF generation flow limits requested decks to 30 questions.
- Extraction reads a text layer; it does not perform OCR or understand diagrams. Results distinguish selected/usable pages, no-text pages, sparse text, and layout warnings. An entirely textless selection fails before saving sources. Sparse pages retain citable text but may contain only headings or footers; check whether the body is an image.
- When selected pages outnumber requested questions, narrow the range or generate in batches. Per-source planned objectives and accepted citation counts describe this job's reach, not full-page or complete conceptual coverage. Sources without accepted questions can be selected for a separate supplementary draft.
- Generation runs in the host process. Restart interrupts unfinished jobs. Saved drafts can be continued manually with a new model task and existing accepted questions; old model conversations are not resumed automatically.
- Existing questions are never rewritten simply because extraction or the plugin changes.

## Text order and extraction versions

Extraction reconstructs lines from page coordinates, joins font-split word fragments according to spacing, and preserves column gaps and continuation indentation. The preview retains whitespace, reports displayed character counts, and can load full-page text.

This is positional text transcription, not diagram interpretation. Complex tables, arrows, hierarchy, and rotated text cannot be reconstructed reliably through linear ordering. Check the original and do not infer relationships merely from neighboring labels.

Extraction version two creates new sources while retaining version-one sources to preserve citations. Repeated version-two imports deduplicate normally.

Historical checks used actual PDF structures and a lecture PDF in an isolated library; generation tests used deterministic model responses. Tests cover pages, duplicates, empty/sparse pages, mixed generation, source safety, coordinate ordering, font fragments, column continuations, citation-version stability, and model failure handling. They do not establish real model content quality or complete PDF understanding.
