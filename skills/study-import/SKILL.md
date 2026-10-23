---
name: study-import
description: Bring the learner's files into StudyHub from the main chat (material as sources, questions they already have as 题组, recordings as audio), converting a file with the shell only when StudyHub cannot read it.
whenToUse: The learner asks in chat to import, add, convert, split or enter a file, a folder, a question book, a past paper, a spreadsheet, a screenshot or a recording into StudyHub, or pastes a 「发给主会话」 message about an import.
---

# Bringing files into StudyHub

`study_workspace` actions take `action` plus `payload_json`; `study_materials` and `study_audio` are tools of their own with an `operation`. The parameters and every limit (file size, pages, characters, number of files) are in `library.context {"area":"imports"}`, the question format in `library.context {"area":"decks"}`. Read them before the first import and never quote a limit from memory.

## 1. Decide what you have

- **Material** (lecture notes, slides, a textbook, a paper, a web page): it becomes sources that questions are made from. Go to section 2.
- **Questions the learner already has** (a question book, a past paper with answers, a wrong-answer list, a spreadsheet, a screenshot of questions, a JSON question bank): they are entered as they are, never turned into new questions. Go to section 3.
- **A recording** (lecture audio, subtitles): go to section 4.
- Both at once (a past paper is material and questions): ask the learner once which they want; "both" means import it as material and enter its questions.
- Use a file only when the learner points at it (@path, a file name with an extension, "this folder") or a 「发给主会话」 message names it. Do not search their disk for others.

## 2. Material

1. StudyHub's own import first: `study_materials` operation `document.import {"path": "<absolute path>"}` (pdf, docx, pptx, ppt, md, html, txt, MinerU/Docling JSON). It keeps the original, finds the pages and returns `sourceIds` and `warnings`. Pass `course` when the learner named one.
2. Convert only when that import refuses the file (too large, too many pages, too much text, not UTF-8, a scan without text, a format it does not take):
   - A PDF over the page limit in area imports is refused whatever `pages` says: split it into files first (by chapter), or send it through the local MinerU when it is installed: `mineru.plan`, then `mineru.import` (a scanned PDF too). `pages` only narrows a PDF within that limit, for example to stay under the character limit.
   - Anything else: convert it to Markdown or plain text with the shell. Prefer Node (`node -e` or a small `.mjs` script): the host already runs on it. Use another program only when it is already installed.
   - Ask before installing anything (a package, a program, a model) and say what it is and how large. MinerU and Marker are installed and set up only in StudyHub's Settings page (设置 › PDF 转换): send the learner there, never install or configure them yourself.
   - Write every result as a new file under `studyhub-work/` in the workspace. Never delete, move or overwrite the learner's originals.
   - When you split a book, every part's title carries the original page numbers, for example `第3章 存储器（原书 p.45–78）`, so the learner finds the page in the original.
   - Never pretend to have read an image. When no text can be extracted and no OCR tool is installed, say so and ask.
3. Import the converted files with `document.import` (Markdown keeps its headings as chapters) and read the `warnings`.
4. Material makes no questions by itself. New questions come only from `generate` (a reviewed draft) or `supplement` (into an existing 题组), and only when the learner asks.

## 3. Questions the learner already has

- Keep their wording, options, answers and keys exactly. Add no questions. When an answer or explanation is missing, mark what you inferred as inferred.
- Pasted or short text: `ingest {"text": "…"}` keeps the stems and flags inferred answers itself.
- A file or many questions: write question-deck JSON in the `decks` format as new files under `studyhub-work/` (one file per chapter for a book), then `deck.import {"paths": ["…"], "draft": true}`: each file waits as a draft that the learner checks and publishes (检查草稿); leave `draft` out only when they asked to import directly. Read its report: `draftId` and `drafted` (or `added` without `draft`), `skipped` (already in that 题组, or with `draft` already waiting in its draft) and `errors`.
- `study_bank` `append` only adds to a 题组 that exists and checks citations; a new 题组 always goes through `deck.import`.
- A citation only when its quote is copied word for word from a material already imported; otherwise leave `citations` out.

## 4. Recordings

- `audio.import {"path": "…"}`, or `{"files": [{"path": "…"}]}` in recording order: transcription and proofreading run in the background, and audio makes no questions by itself.
- Never ask for or accept an API key in chat: `audio.settings.get` says whether one is set, and the learner sets it in Settings.

## 5. Background work

- Imports and conversions run as jobs. Report the receipt and return control; `job.status {"jobId": "…"}` when the learner asks how it is going. Never loop over `job.wait`.

## Report to the learner

结束时用中文简短汇报：导入了什么（资料标题和页数，或题组名和题数）、放进了哪门课或哪个题组；哪些文件先做了转换，转换结果是 studyhub-work/ 里的哪个文件；有哪些警告、跳过或失败的部分，原因是什么；还有什么要学习者自己做（例如去设置页安装 MinerU）。只说工具结果里有的数字，不说没核实过的。
