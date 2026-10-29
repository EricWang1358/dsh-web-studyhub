---
name: study-book
description: Write and rewrite the learner's StudyHub 复习全书 (review book) from the main chat, one knowledge point at a time, with every quote checked against the course materials.
whenToUse: The learner asks in chat to write, rewrite, extend, restructure, shorten or fix their 复习全书 / review book (one point, a chapter or the whole book), or pastes a 「发给主会话」 message from the book page.
---

# StudyHub review book (复习全书)

Every tool below is an action of `study_workspace` (`action` plus `payload_json`). The details of each one: `library.context {"area":"book"}`.

## Authority

- A learner's request in chat to change the book, in their own words or as a 「发给主会话」 message, IS the authorisation. Do not ask again before saving.
- You may edit any file of the book: the generated text of a point (`gen`, the default), and the learner's own notes (`mine`) and Q&A (`qa`) when the learner names them or asks for a whole-book rewrite.
- Every write keeps the previous version; `course.book.revert {"file": <name from the write's answer>}` undoes it. Say so when the learner is unsure.
- Always report which points changed (number and title).
- Taking text away is not writing it. Before any permanent delete or archive, ask the learner first, in ONE sentence that says what goes and what stays, and act only on a clear yes. This covers deleting a chapter, a point or a section of the book (`course.book.delete`, `book.write` with op `delete`) and anything else in StudyHub that is archived or deleted for good.

## The one hard rule: respect the materials

- Facts, definitions, numbers, steps and quotes come from the course materials. Open the pages with `source.pages` before you write what they say; never write a point from memory of the title.
- Quote only as footnotes the app verifies: put the mark in the text (`…写下来[^1]。`) and the footnote below it, `[^1]: 「exact words from the page」 (sourceId)`. Copy the words exactly as `source.pages` shows them (a short phrase is enough). A footnote the app cannot find is taken out and listed in `dropped`; if the answer says `again: true`, delete or rewrite the sentence that rested on it.
- Anything that goes beyond the materials (your own example, background, an analogy, a tip) is marked （资料以外） right after it (English book: "(beyond the materials)").
- The book is never evidence: do not use its text to make or check questions or answers.
- Everything else is free: structure, length, tone, order, headings, tables, transitions, rewriting a point from scratch.

## Style

Write for a beginner revising alone: long-form, plain language, the why before the what. Start from where the previous point left off and lead into the next one. Use a worked example where it helps and name the usual traps (常见误区). It should read like a strong classmate's open-book notes, not an outline: whole sentences and paragraphs, a few headings, a table only where it compares things. No fixed sections, no length floor or ceiling: as long as the point needs. Write in the book's language (`language` in `book.toc`).

## Working loop: one point at a time

1. `book.toc {}` (pages with `offset`): the points, their `hid`, what is written, `read` = pages opened / pages the point stands on.
2. `book.read {"hid": …}`: the point's files, headings with ids, the previous and next point, and `materials` (documentId and pages). Long files: `more {file, offset}` → `book.read {"hid", "file", "offset"}`.
3. `source.pages {"documentId": …, "from": p, "to": p+3, "hid": …}`: 2–4 pages a call; follow `next` until the point's pages are read. Always pass the `hid`.
4. `book.write {"hid": …, "section": {"heading": "…", "markdown": "…"}}`: write heading by heading (an existing heading by its id; a title the file does not have is added at the end of the file). To put a NEW section in its place use `"op": "insert"` with `"after"`, `"before"` or `"within"` a heading id (or `"position": "start" | "end"`). A first draft of a short point may be one `markdown`; small fixes are `edits [{find, replace}]` with words copied from `book.read`.
5. `book.read` the point again and check the result; read `dropped` and `warnings` of every write and fix what they name.
6. `book.coverage {"hid": …}`: pages not opened yet are named in `readNext`; read them if the point needs them.
7. Next point.

## Restructuring

Only when the learner asks for it (rename, reorder, remove, tidy up the structure). Nothing here rebuilds the outline or sends the book's text.

- Sections inside one point's file, by the heading ids `book.read` lists: `book.write {"hid", "op": "rename", "heading": id, "title"}`, `{"op": "move", "heading": id, "after" | "before" | "within": id}` (or `"position"`), `{"op": "delete", "heading": id}` (its sub-sections move up; `"children": "delete"` removes them too, `"toUnplaced"` keeps them in 未归位; to put such a section back, revert the point's file, never `unplaced.md`: its copy may be the only one). A heading of the same title twice is refused (spaces, case and full-width or half-width punctuation do not count): never write placeholder text or a second copy to work around it; delete or rename instead.
- Chapters and knowledge points of the book, by the `hid` of `book.toc` and its `structureVersion`: `course.book.rename {"hid", "title", "version"}`, `course.book.move {"hid", "toParent" | "afterHid" | "beforeHid", "version"}`, `course.book.delete {"hid", "children": "promote" | "toUnplaced", "version"}` (what the learner wrote in a deleted point goes to 未归位; a chapter left empty stays, named in `emptied`). Each answer gives the next `structureVersion`; a `course-book-conflict` means the book changed: read `book.toc` again. `course.book.revert {"file": "book.structure"}` undoes the latest change, until the outline is made again; a file edited since is left as it is (`kept`): tell the learner, never revert that file to make the undo pass. `course.book.revert {"file", "redo": true}` brings back what a file's revert replaced.

## Limits

- Small calls only: at most 4 pages read, and one point or one section written per call. Never `course.book.open` or `course.book.save` for this work (they carry the whole book or a whole file).
- Call `study_workspace` directly, never inside `run_code`.
- If a call is refused with `INVALID_REQUEST` or a 400 from the permission review (the host's, not StudyHub's; it can hit reads like `book.toc` too), do not retry in a loop and do not turn to `course.book.open` or `course.book.save` instead. Nothing was changed by that call: tell the learner it is the host's review service, and suggest waiting a few minutes, a new conversation, or a permission mode that asks them.
- When the conversation gets long, finish the point you are on, say where you stopped (number and title) and suggest a new conversation to go on. In Auto permission mode prefer a fresh conversation per chapter.

## Report to the learner

结束时用中文简短汇报：改了哪些知识点（编号和标题），每一点大致改了什么；有几处引文没能在资料里找到、已经删掉或改写；哪些内容标了（资料以外）；还有哪些页没有读到。告诉学习者：每次修改都保留了上一版，在书页上可以「回退到上一版」，或者让我用 course.book.revert 撤回；书里的文字只是复习参考，不是出题和判分的依据。
