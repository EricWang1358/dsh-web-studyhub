---
name: study-import
description: Bring the learner's files into StudyHub from the main chat (material as sources, questions they already have as decks, recordings as audio), converting a file with the shell only when StudyHub cannot read it.
whenToUse: The learner asks in chat to import, add, convert, split or enter a file, a folder, a question book, a past paper, a spreadsheet, a screenshot or a recording into StudyHub, or pastes a "Send to main chat" / 「发给主会话」 message about an import.
---

# Bringing files into StudyHub

`study_workspace` actions take `action` plus `payload_json`; `study_materials` and `study_audio` are tools of their own with an `operation`. The parameters and every limit (file size, pages, characters, number of files) are in `library.context {"area":"imports"}`, the question format in `library.context {"area":"decks"}`. Read them before the first import and never quote a limit from memory.

## 1. Decide what you have

- **Material** (lecture notes, slides, a textbook, a paper, a web page): it becomes sources that questions are made from. Go to step 2.
- **Questions the learner already has** (a question book, a past paper with answers, a wrong-answer list, a spreadsheet, a screenshot of questions, a JSON question bank): they are entered as they are, never turned into new questions. Go to step 3.
- **A recording** (lecture audio, subtitles): go to step 4.
- **Exam focus highlights** (exam scope notes, screenshots or photos; Chinese `重点`): go to step 4a.
- Both at once (a past paper is material and questions): ask the learner once which they want; "both" means import it as material and enter its questions.
- Use a file only when the learner points at it (@path, a file name with an extension, "this folder") or a "Send to main chat" / 「发给主会话」 message names it. Do not search their disk for others.

## 2. Material

1. StudyHub's own import first: `study_materials` operation `document.import {"path": "<absolute path>"}` (pdf, docx, pptx, ppt, md, tex, html, txt, MinerU/Docling JSON). It keeps the original, finds the pages and returns `sourceIds` and `warnings`. Pass `course` when the learner named one.
2. Convert only when that import refuses the file (too large, too many pages, too much text, not UTF-8, a scan without text, a format it does not take):
   - A PDF over the page limit in area imports is refused whatever `pages` says: split it into files first (by chapter), or send it through the local MinerU when it is installed: `mineru.plan`, then `mineru.import` (a scanned PDF too). `pages` only narrows a PDF within that limit, for example to stay under the character limit.
   - Anything else: convert it to Markdown or plain text with the shell. Prefer Node (`node -e` or a small `.mjs` script): the host already runs on it. Use another program only when it is already installed.
   - Ask before installing anything (a package, a program, a model) and say what it is and how large. MinerU and Marker are installed and set up only in StudyHub's Settings page (Settings › PDF conversion / 设置 › PDF 转换): send the learner there, never install or configure them yourself.
   - Write every result as a new file under `studyhub-work/` in the workspace. Never delete, move or overwrite the learner's originals.
   - When you split a book, every part's title carries the original page numbers in the book's language, for example `Ch. 3 Memory (orig. pp. 45–78)` in English or `第3章 存储器（原书 p.45–78）` in Chinese, so the learner finds the page in the original.
   - Never pretend to have read an image. When no text can be extracted and no OCR tool is installed, say so and ask.
3. Import the converted files with `document.import` (Markdown keeps its headings as chapters) and read the `warnings`.
4. Material makes no questions by itself. New questions come only from `generate` (a reviewed draft) or `supplement` (into an existing deck), and only when the learner asks.

## 3. Questions the learner already has

- Keep their wording, options, answers and keys exactly. Add no questions. When an answer or explanation is missing, mark what you inferred as inferred.
- Pasted or short text: `ingest {"text": "…"}` keeps the stems and flags inferred answers itself.
- A file or many questions: write question-deck JSON in the `decks` format as new files under `studyhub-work/` (one file per chapter for a book), then `deck.import {"paths": ["…"], "draft": true}`: each file waits as a draft that the learner checks and publishes in Review draft; leave `draft` out only when they asked to import directly. Read its report: `draftId` and `drafted` (or `added` without `draft`), `skipped` (already in that deck, or with `draft` already waiting in its draft) and `errors`.
- `study_bank` `append` only adds to an existing deck and checks citations; a new deck always goes through `deck.import`.
- A citation only when its quote is copied word for word from a material already imported; otherwise leave `citations` out.

## 4. Recordings

- `audio.import {"path": "…"}`, or `{"files": [{"path": "…"}]}` in recording order: transcription and proofreading run in the background, and audio makes no questions by itself.
- Never ask for or accept an API key in chat: `audio.settings.get` says whether one is set, and the learner sets it in Settings.

## 4a. Exam focus highlights (exam scope / screenshots)

- Screenshots or photos staged under `studyhub-work/focus-intake/` (or handed in chat): transcribe them word for word when your model reads images; on a text-only model (such as DeepSeek), read those workspace paths via installed MinerU (`mineru.import {"path": "…"}`) or an already-installed local OCR tool (ask before installing anything; never pretend to have read an image or guess unclear words).
- Save the transcribed highlight text as a course material with `source.add {"title": "…", "text": "…", "courses": ["…"]}`, optionally extract concise topic names with `focus.extract {"course": "…", "text": "…"}`, read the existing course first with `course.get {"name": "…"}`, and merge the concise topics into `focusTopics` plus the material id into `guidanceSourceIds` via `course.save {"name": "…", "focusTopics": ["…"], "guidanceSourceIds": ["…"]}` (preserving any `exam` and `plan`).
- Saved `focusTopics` automatically increase focus review frequency and escalate question generation depth; call `generate` or `supplement` only when the learner asks for questions.

## 5. Background work

- Imports and conversions run as jobs. Report the receipt and return control; `job.status {"jobId": "…"}` when the learner asks how it is going. Never loop over `job.wait`.

## 6. Taking things away

- Importing needs no deleting. If the work would replace, archive or delete something that is already in StudyHub (an earlier import, a deck, a draft), stop first. Before any permanent delete or archive, ask the learner first, in ONE sentence that says what goes and what stays, and act only on a clear yes.

## Report to the learner

Report briefly in the learner's language (English when the learner writes in English; 中文对话：结束时用中文简短汇报): what was imported (material titles and page counts, or deck names and question counts) and into which course or deck; which files were converted first and their output paths under `studyhub-work/`; any warnings, skipped items or failures with their reasons; and any step left for the learner in StudyHub (such as setting up MinerU in Settings). Quote only verified numbers returned by the tools.
