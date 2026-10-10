# Review book

[中文](review-book.zh-CN.md)

The **review book** (复习全书) is a book page per course, made from the [course outline](course-outline.md) and the explanations the review book task writes for each knowledge point. It is for reading and studying; questions appear in it as links that take you to practise them. This covers milestones M1 (reading) and M2 (editing) of the [design](plans/review-book.md); adding Q&A to the book, export and print come in later milestones. Checked against the code on 2026-10-11.

## Open it

On the **Course outline** page, once the review book is written, **Open the book page** sits next to the line about the learning order; an opened knowledge point has its own **Open the book page**, which opens the book at that point. **Back to the outline** returns.

## What the page shows

| Part | What it is |
| --- | --- |
| Contents (目录) | Every heading of the book: the outline's chapters, sections and knowledge points. **You are here** marks the heading on screen. Select a heading to go there. At wide widths it sits beside the text; at narrow widths it is folded under the title (**Contents**) and folds again after a jump. |
| Chapters | One per chapter of the outline. Only the chapters you open are drawn, so a big book stays light; the one you were reading opens by itself. |
| A knowledge point | Its explanation (in the sample papers, key points, explanation, example, extra beyond the materials, sources as footnotes) with **Practise 5** and **Questions and answers**, then **Questions of this point**: its questions as they are now, the first five as links and **N more** for the rest. A point without questions says **This point has no questions yet.** and offers **出题** (make questions). Without sample papers nothing about exams is shown. |
| Not placed (未归位) | Only when the outline was rebuilt and some of your own text has no knowledge point any more; each piece is headed with its old title and **no longer a point of the outline**. |

## The links

- **A question** (`studyhub://card/<deck>/<card>`) opens the practice page on that question, the same answering, grading and scheduling as everywhere. **Back to the review book** returns to the book at the heading and scroll position you left.
- **Practise 5** (`studyhub://practice?heading=<id>&n=5`) practises the first five of the point's questions in the order a practice round takes them (due, weak, new, then the rest); an unfinished round of exactly those questions goes on. A question answered well a moment ago is no longer due, weak or new, so it comes after the others.
- **Questions and answers** (`studyhub://qa?heading=<id>`) opens, under the point, what was asked about it: follow-ups kept on its questions, the reader's notes on passages inside its places, and question-and-answer cards. Each item is folded; open it for the answer, then go to the question or to the original passage.
- A footnote mark and the sources list open the reader at the quoted sentence.
- A link to a question that was deleted reads **This question was deleted**. Links only navigate; they never run anything. Any other link opens normally.

## Edit it

Above the book, **Preview** and **Source** switch how it is shown; the choice is remembered per course. **Source** shows the raw Markdown of ONE file in the Markdown editor; the file picker lists every file in reading order: each knowledge point's **explanation (generated)** and **my notes**, and 未归位. Any file can be edited.

- **Save** saves the file. A heading you type (`## …`) gets a stable id on save (written at the end of its line, hidden in the preview); an id is never given twice and never taken from the outline's headings. **Discard changes** goes back to the saved text. While there are unsaved changes the file picker is locked, so switching files never loses them.
- **Editing a generated file makes it yours** (**Changed by you**). When the explanations are written again, a file you changed is never written over: the new text waits under it in the preview as **New generated text**, with **Take it** and **Ignore** (an ignored text is not offered again; a newer one is). A file keeps up to three waiting suggestions, newest first, each with its own buttons, so one never pushes out another. A file you did not change follows the new explanations by itself. Your notes are never touched by the program.
- **The book was updated.** A save is checked against the version of the file you started from. When the same file was changed meanwhile (by the program or in another tab), your text is saved anyway and the other text waits as a suggestion (**The book was updated**, with **Take it** and **Ignore**); other files are not affected.
- **Back to the previous version** takes the file's previous text back, one version at a time; any write of the program can be undone this way. The last 20 versions of a course are kept (fewer when they are large), outside the library's materials; a portable backup carries them and a restore brings them back. Two copies of the app writing the same book at the same moment may lose a version from this history, never the book.
- The preview of an edited file still draws the question links, footnotes and 本节问答, and never renders HTML: tags stay visible as text. A heading you typed is in the contents and can be reached from it, and the way back after practice returns to it.

## Where it is kept

The book is one hidden record of the library (`provenance: 'course-book-doc'`) holding Markdown files: for each knowledge point a generated file (the program's) and your own file (empty in M1), a manifest (the outline's tree with a stable id per heading) and a file for text without a point. It is a reference, never material: it is not in the materials list, the pickers or the search, not in the retrieval index, not counted in the assistant's library context, and a request that names it as material is refused. Questions keep citing the original materials.

Opening the page makes the files the first time (no model call) and brings the generated ones up to date with the explanations. The list of a point's questions is not kept in a file: it is read live each time, so new or deleted questions change no file, and an open that changes nothing writes nothing to the library. Your own files are never changed by this. When the outline is rebuilt, each knowledge point keeps its files and heading id if a new point holds the same materials (else one of the same title); what cannot be mapped goes to Not placed; nothing is deleted.

## Rolling back

Upgrade only. An older release (3.3.0 and before) does not know this record: it keeps it as it is, but may list it as a Markdown material named **复习全书 · course** whose text is one line, **复习全书（由 StudyHub 3.4 以上管理，请勿删除）** (the review book, managed by StudyHub 3.4 or later; do not delete). Deleting that entry in an older release deletes the book's files. The version history (the `book-history` folder of the library) is ignored by older releases.

## For developers

- `course.book.open {course?}` (lib/course-book-files.js) answers `{ status, course, revision, title, language, notes, papers, nodes, unplaced, missing, changed }`; `nodes` are `{ hid, key, title, number, depth, leaf, gen, mine, questions: [{ deckId, cardId, prompt }], questionTotal, children }` (`questions` read live, at most 200), `missing` the questions the files link that are gone. It looks at the library first and writes the record only when a file changes; it is never in the snapshot.
- `course.book.save {course?, file, text, version}`, `course.book.suggestion {course?, file, action: 'accept' | 'ignore', version}`, `course.book.revert {course?, file}` (lib/course-book-edit.js): one writer queue per course, one store transaction each; they answer the book like `course.book.open` plus `write` ('saved', 'merged', 'unchanged', 'accepted', 'ignored', 'reverted') and `history` ({ file: versions kept }). The history is lib/course-book-history.js: `book-history/<hash of the course>.json` under the library folder, written through a temporary file and a rename after the book's own write.
- lib/course-book-links.js (browser-safe): the three question links (`parseBookLink`), heading ids on the heading line (`## Title <!-- sh:id h3 -->`, `assignHeadingIds`: given once, never reused), `bookIndex` (the heading tree with the question links under each heading), `stitchBook` (files in order, footnotes named per file), `plainBook`.
- The page is ui/book/ (registry row `book` in ui/pages.js); the links are drawn through `resolveLink` of ui/Markdown.jsx.
