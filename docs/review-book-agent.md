# The review book and the main chat

[中文](review-book-agent.zh-CN.md)

You can ask the main DSH chat to write or rewrite your [review book](review-book.md) (复习全书): one point, a chapter or the whole book, in your own words ("rewrite 2.3 for a beginner, with an example") or by sending it the part to change. Asking in chat is the permission: the chat saves without asking again, and every write keeps the version before it, so **Back to the previous version** on the book page (or asking the chat to undo) takes it back. The one hard rule is that the book respects your materials: what it says comes from the materials, quotes are checked word for word, and anything beyond them is marked （资料以外）. Checked against the code on 2026-10-11.

## How the chat works on the book

The chat follows the `study-book` skill that StudyHub ships (`skills/study-book/SKILL.md` in the plugin). It works one knowledge point at a time:

1. It reads the table of contents (`book.toc`): each point's id, what is written, and how many of its pages were already read.
2. It reads one point (`book.read`): its files, its headings, the previous and the next point, and the material pages the point stands on.
3. It opens those pages (`source.pages`, at most 4 pages a call). The app records which pages were opened, so the chat (and you) can see how much of a point's material was really read (`book.coverage`).
4. It writes the point heading by heading (`book.write`). Every quote is a footnote naming its material; the app looks the words up in that material (else in the point's own pages) and takes out a footnote whose words are not there, telling the chat which one. A quote taken out twice for the same point comes with the advice to delete the sentence.
5. It reads the result, checks the coverage and goes on to the next point. At the end it tells you, in Chinese, which points changed, which quotes were taken out, what was marked as beyond the materials and which pages were not read.

What the chat writes into a point's generated text becomes yours: rebuilding the explanations later no longer replaces it, the new generated text only waits as a suggestion (**Take it** / **Ignore**), as when you edit the page yourself. Your own notes and the Q&A of a point are changed only when you name them or ask for the whole book to be rewritten.

## Long work

The chat's calls are small on purpose: the host cuts long tool answers, and in Auto permission mode it reviews every call with all the earlier ones, so a conversation that writes whole files would overflow. When a conversation gets long, the chat finishes the point it is on, says where it stopped and suggests a new conversation; in Auto mode one conversation per chapter works best. Write "go on from 3.2" in the new conversation.

## Making the skill available

When the plugin starts in a DSH that has the skill registry, it registers `study-book` itself, and the chat's skill list shows it in every session that has the skill tool (the study preset has it). If your chat does not show `study-book`, copy the folder `skills/study-book` of the installed plugin to `~/.dsh/skills/study-book` (so that the file is `~/.dsh/skills/study-book/SKILL.md`); DSH reads skills from there too. The plugin itself never writes outside its own folder and the library.

## For developers

- `book.toc {course?, offset?, limit?}` (at most 40 rows a call), `book.read {course?, hid, file?: 'gen' | 'mine' | 'qa', offset?}` (4 500 characters of text together, `more: {file, offset}` goes on), `book.coverage {course?, hid}`: lib/book-agent-read.js, read only; `book.toc` first brings the book up to date as `course.book.open` does (it creates it, maps it to a rebuilt outline). Each answer stays under the host's 8 192-character cut of a tool result.
- `source.pages {sourceId | documentId, from?, to?, offset?, hid?, course?}`: lib/book-pages.js, at most 4 pages and 6 000 characters (`next: {from, offset?}`, `end: true`); the library's own lists (exam point lists, the outline, the book) are refused. What it showed is recorded by lib/book-reading.js in `book-history/reading.json` under the library folder (ranges of characters per source, the sources a point's work opened, the quotes a point's writes dropped), written through a temporary file and a rename; it is not in the library and not in a portable backup.
- `book.write {course?, hid, file?, markdown | section: {heading, markdown} | edits: [{find, replace}], version?}`: lib/book-agent-write.js with the footnote rules of lib/book-footnotes.js and the quote locator lib/book-quote.js (shared with the review book build). At most 20 000 characters a call and 20 edits. It runs in the book's writer queue (lib/course-book-writer.js) and one store transaction through `course.book.save`'s rule (lib/course-book-edit.js), so a save from the book page and a write from the chat are served one after the other. Footnotes are written back in the book's form, `[^n]: [「words」](studyhub://source/<id>) · title`, numbered in order under **出处**; headings are put below the point's own heading; the 练 5 道 line stays last; Q&A, answer-card and AI blocks are kept as they are. A stale `version` on a whole-file write saves the chat's text and keeps the other as a suggestion; a section or edits are applied to the file as it is now. Answer: `{status, hid, file, name, version, dropped: [{n, quote, reason, again?}], outsideCount, warnings, advice?, note?}`; warnings name another language than the book's, pages not opened yet, and blocks no longer in the file. Refusals: book-write-mode, book-write-too-long, book-edit-find, book-section-missing, book-file-invalid, book-point-missing, book-point-not-leaf, course-book-missing.
- The skill is lib/study-skills.js: `skills/<name>/SKILL.md` (YAML frontmatter `name`, `description`, `whenToUse`) registered with `ctx.skills.register` when the host injects `skills`. The tool contract is area `book` of `library.context`.
