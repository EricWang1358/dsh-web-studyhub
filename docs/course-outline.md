# Course outline

[中文](course-outline.zh-CN.md)

The **Course outline** page lays out the current course by its materials instead of by its decks: each material, its chapters, and under each chapter the questions that cite it. Use it to find the questions about a part of the course and practise exactly those, without working out which deck holds them.

Step 1 lays the course out by the materials' own chapters, with no AI text. Step 2 adds **Generate outline**: the model organises the materials into a book-like outline (chapters, sections, knowledge points) in learning order. The review book's explanation layer writes notes under each knowledge point of the outline (see The review book below). Checked against the code on 2026-10-09.

## Open it

On the **Study library** home page, the course area (under the course name and its progress bar) has a **Course outline** link. It opens the outline of the current course. **Back to library** returns to the home page. The page has no sidebar entry.

The home page keeps one main card and its one continue button. The folded **Course route** list that used to sit under the progress bar is gone; the outline replaces it. The progress bar and **Continue course** still follow the deck order.

## The organised outline (step 2)

Without an outline, the page lists the materials as in step 1, with one main button, **Generate outline**, above them. One click starts the task **Organise the outline** in the background; there is no estimate and no confirmation, and the **Tasks** page shows its progress and what it used, as for every task. While it runs, the page says **Organising the outline (step i of n)…** with **View progress**; it can be paused, stopped (nothing is kept) or retried there (the finished model calls are kept).

Once the outline exists, the page reads like a book's contents:

| Row | What it is |
| --- | --- |
| **Chapter N** | A chapter of the course, with a short introduction. Chapters are open when the page first shows the outline. |
| N.M | A section of a chapter, with its introduction (a chapter without sections holds its knowledge points directly). Closed at first. |
| N.M.K | A knowledge point. It holds rows of the materials (a whole material, or some chapters of one); opening it lists those rows, each named with its material, and they open to their questions. A point that holds a single row opens straight to its questions. Materials of the same name under one point (four notes called **补充笔记 · Reintroduction**) are one row, **(4 with this name)**. |
| Other | Everything no knowledge point holds: what the model left out, and materials added after the outline was made. Never hidden. |
| Not placed | As in step 1. |

Every row has the mastery line (**Mastery 62% · 12 questions**), **Practise this**, and a tick box that picks every question under it at any depth. The counts are computed from the library as it is now, not stored in the outline: a question added, answered or deleted later counts at once.

Above the outline, one line says what the learning order rests on (**Learning order based on: the order of the syllabus “…” · the numbers in the material titles · the recording dates**). The model is told to follow, in this order, a syllabus material of the course (a short material whose name says 大纲 or syllabus), the numbers and version marks in titles (01., Lecture 3, Day1, v2.1), recording dates and parts, and what must be learned first; the line keeps only the grounds the library actually has. Next to it, a quiet **Reorganise** makes a new version; the old one is kept as an archived record. When the course's materials change after the outline was made (added, removed, renamed, re-imported), the line says **Your materials have changed since; reorganising is suggested**.

**Have sample papers?** (folded under the button) lists the course's materials, the ones that look like a sample paper first, none ticked. With papers, the task reads each paper and marks the knowledge points its questions test, **In sample papers (N/M)**, from quotes found word for word in the paper; the others say **Extra**. Without papers, nothing about exams is said. **Reorganise** keeps the papers the outline rested on.

**A reference, never evidence.** The outline is a record of the library, but it is not a material: the **Sources** page, the pickers, search, counts and every list of materials leave it out, and a request that names it as material (to make questions from, as a reference source) is refused. Questions keep citing the original materials word for word.

**What the model is shown.** Not the texts: for each material, its name, format, chapters, question count, the most frequent topics and the first prompts of its questions, its number, version and date hints; the syllabus text is the only text sent (at most 12,000 characters). Copies with the same name and chapters are shown once. In the test library shaped like a real course (134 materials, about 900 questions) that is two model calls (one batch of materials, one arrangement), plus one call per 8,000 characters of sample paper; more materials make more batches of at most 36,000 characters each. Every answer is checked by the program: an invented or repeated id is dropped and counted, at most three levels, names cut to size.

## The review book (explanation layer)

The review book (复习全书) writes, for every knowledge point of the outline, a condensed, exam-minded explanation a beginner can follow, so someone with one week left and a whole textbook can study the book instead of the original. This step is the explanation layer only; the full book page (reading, practice and question columns, inline 弄懂 blocks) comes in later versions.

**Making it.** The outline page has one main button, **Write the review book** (when there is an outline and no book yet). One click starts the task **Write the review book** in the background: no estimate, no confirmation; the **Tasks** page shows its progress and lets you pause, stop (nothing is saved) or retry (finished model calls are kept). While it runs the page says **Writing the review book (step i of n)…** with **View progress**. Without a model the button is disabled and says where to set one up (its own hint: the outline and the explanations already written stay readable without one). The only hard precondition is a course with at least one material: no questions, decks of questions, with or without sample papers, a single short material (one chapter is fine) and no outline yet all work; a missing input removes only its own part. Without an outline the task first organises it with exactly the steps of **Generate outline**, then writes the explanations, and saves both at once; so the button is offered (as a secondary one) before there is an outline too.

**What a knowledge point holds.** Opening a knowledge point shows its notes, read-only, above its materials and questions:

| Part | What it is |
| --- | --- |
| In the sample papers (考情) | Only when the outline rests on sample papers: **Tested in the sample papers.** and one line by the model on how the paper asks it, or **The sample papers do not test this point.** Without papers this heading is not shown. |
| Key points | A few short bullets: definitions, facts, formulas, steps. |
| Explanation | Plain language: what it is, why it matters, how the ideas connect, the usual mistakes. Formulas are shown with KaTeX. |
| Example | When the materials have a worked example, an exercise or a case, one short example step by step; otherwise not shown. |
| Extra (beyond the materials) | What the model adds that the materials do not say (background, a standard definition, an intuition), marked apart and without citation marks. |
| Sources | The original passages the citation marks point to. Each mark in the text and each line here opens the reader at that sentence. |

**Marks point to the original only.** Every quote the model gives must be found word for word in the point's own materials (the rule question citations use, lib/quote-locate.js); the original's own words and place are stored. A quote that is not found is dropped together with its mark in the text, and the task's result says how many were dropped.

**A reference, never evidence.** Like the outline, the review book is a hidden record of the library (`provenance: 'course-outline-notes'`), not a material: material lists, pickers and search leave it out, and using it to make questions or as a reference source is refused. Questions keep citing the original materials. It holds only what the machine wrote; personal blocks to come (弄懂 blocks, notes, common mistakes) are stored elsewhere and are never overwritten by it.

**An update changes only what changed.** Each point's explanation records an input fingerprint: the texts it was written from (which material, which passage, what words) and the language; 考情 records its own: the point's sample paper places. So:

- When materials are added, removed or changed, the page says **Your materials have changed since; updating the book is suggested** and the main button becomes **Update the book**. An update first organises the outline again (the materials changed), then asks the model only for points whose texts changed and for new points; unchanged points are kept as they are, with no model call.
- After the outline is reorganised its node ids change: earlier explanations are matched to the new points by anchor overlap and title, and kept when their texts did not change.
- Ticking sample papers after the book exists and selecting **Update the book** keeps the outline's chapters and knowledge points and only reads the papers again (a call per chunk of paper); only the points whose paper places changed get new 考情. The explanations stay byte for byte.
- New questions and answers are no input: adding questions neither changes the book nor marks it out of date.
- Each update makes a new version and keeps the old one as an archived record; a rewritten part names the version it replaces (`replaces`). When nothing changed, nothing is written.

**How many calls.** A call explains at most three points with at most 24,000 characters of their materials; a point is shown at most 12,000 characters, a beginning of each passage when it has more. In the test library shaped like a real course (134 materials, about 900 questions, 19 knowledge points, 20 with a sample paper): two calls for the outline (one batch of materials, one arrangement) and seven for the explanations; with one sample paper also one call to read it and one for 考情. A 考情 call covers at most eight points.

## What it shows (without an outline)

| Row | What it is |
| --- | --- |
| A material | Every material filed under the course, also one with no question yet (**No questions yet**). A material that has no course of its own counts as filed under the course its questions' decks belong to. A material filed under no course, a material of another course and an archived one are not rows, even when this course's questions cite them. |
| A chapter | The chapters the material has on the **Sources** page: the converter's chapters of a book, or the chapters you applied from a kept outline. A material without chapters is one row. |
| Not matched to a chapter | Questions of a material with chapters whose place could not be put in a chapter (a question written from an older version whose quote is no longer in the text). |
| Not placed | The course's questions that no material row holds, each with why: it cites no material; **Cites a material that is not filed under this course** (a material filed under no course); it cites a material of another course or an archived one; or the material was deleted. The group names the materials filed under no course and links to the **Sources** page: file them under the course there and their questions move into their rows. These questions can be practised; they cannot be moved by hand. |

Each row shows its mastery in the words of the **Sources** list (**Mastery 62% · 12 questions**, **New · 3 questions**, **No questions yet**) and **Practise this**. When a round of exactly a row's questions is unfinished, the button says **Continue i/n** and goes on with that round.

Open a chapter (or a material without chapters, or **Not placed**) to list its questions: the question, its deck, its level and **Due** when it is due. A row lists at most 400 questions; the rest are counted and **Practise this** includes them.

**Filter by deck** narrows every row to one deck's questions. Decks stay where they are; this page never edits them.

The one hover explanation is on **What is the outline?** next to the course line.

## Where a question goes

A question is placed by the rule the coverage figure uses: its selection, else the place a generation plan verified, else where its quote stands in the text, also when the quote is written a little differently. A question that cites a page of a material is under the material's chapter that holds that place; one that cites an older version of the material, or another material made from the same recording, is placed by finding its quote in the current text.

A question that cites two chapters is listed under both and flagged **Also listed elsewhere**. It counts once in the material, in the course total and in a practice round.

The questions are those of the course's decks: archived decks and suspended questions are left out, as everywhere else. Questions still in drafts are only counted (**N more in drafts**) until they are published.

The numbers on this page are its own. The **Sources** row counts every deck's questions that cite a material, any course; the outline counts this course's questions. The numbers the **Sources** page shows are unchanged.

## Practise

Tick a row to pick all its questions, or tick single questions. The bar at the bottom says how many are picked, each question once, and **Practise picked (N)** starts the round. **Practise this** on a row starts a round of that row.

A round takes at most 200 questions. When more are picked, the round takes the first 200 in the order a practice round asks them, and the bar says so. A practice round asks due questions first, then weak ones, then new ones; it does not follow the outline order.

The round comes back to the outline: **Back to the outline** in the round and on its result page opens it as you left it (the same rows open, the same deck filter).

## Limits

- The quality of the organised outline depends on the model; it has been checked with a fake model on a synthetic library shaped like a real one, not yet with a real model on a real course.
- The order of new questions in **Continue course**, on the home page and in the **Study map** is still the deck order (step 3 will prefer the outline).
- An outline is never edited by hand; **Reorganise** makes a new one.
- A question cannot be moved to another row by hand.
- Recordings keep their parts as chapters only when the material has chapters; there is no jump to a time in the recording.
- The quality of the review book's explanations depends on the model; the flow, the call counts and the quote checks have been verified with a fake model, the content not yet with a real model on a real textbook.
- The review book is updated as a whole; a single point cannot be rewritten or edited by hand.

## For developers

- `course.outline {course?, deckId?, expand?, pick?}` (lib/course-outline.js; the placement is lib/course-outline-index.js) is read on demand and never sent with the snapshot. Without `expand` it returns the material rows with counts; `expand: [key]` adds the chapters of a material or the questions of a row; `pick: { keys, cards }` returns only `practice: { scope, total, capped, limit }`, a scope `review.start {mode:'path'}` takes as it is.
- `course.outline.qa {course?, keys?, cards?}` (lib/course-outline-qa.js) reads, on demand, the questions and answers kept about some rows (a knowledge point of the book page's 本节问答): a card's follow-ups of its current wording, the reader's passage annotations inside the rows' places (the chapter holding the offset, as a question is placed; the passage still the stored text) and source-QA cards. At most 200 cards are read (`cards: { total, read, capped, limit }`); each item is `{ kind: 'card' | 'passage' | 'qa-card', question, answer, at, place, openRef }`, in reading order.
- The placement is cached per library revision, minute, course and deck filter. A synthetic library of 200 materials (6 million characters), 3,000 questions and 600 fuzzy quotes takes about 75 ms the first time and 5 ms after; the answer without open rows is about 55 KB.
- The page is ui/outline/; the registry row is `outline` in ui/pages.js.
- The organised outline is a source record (lib/course-outline-book.js): `provenance: 'course-outline'`, a readable `text` and the structured `courseOutline` (`nodes` of at most three levels, each leaf's `anchors` being the document and chapter keys of `course.outline`, `other`, `orderBasis`, `papers`, a materials `fingerprint`, `supersedes`). lib/exam-point-list.js `isLibraryListSource` hides it with the 考点清单. `course.outline` answers `book` (lib/course-outline-book-view.js lays it over the engine's rows; its keys start with `bk:` and work with `expand` and `pick`).
- `generation.courseOutline.build {course, language?, papers?, supersedes?}` starts the Job `course-outline-build` (lib/contexts/generation/outline/): map calls over batches of descriptors, one reduce call, a call per chunk of sample paper, one write. Refusals: course-outline-no-course, course-outline-no-materials, course-outline-paper-invalid, course-outline-no-readable-text, course-outline-supersedes-invalid. Its result names `{ kind: 'course-outline', id, course }`; the console's open button goes to this page for that course. `papersOnly: true` keeps the current outline's knowledge points (the same ids) and only marks them again with `papers`; without an outline it is refused (course-outline-no-outline). While a review book build of the course runs, a build is refused (course-outline-book-running).
- The review book is a source record (lib/course-book.js): `provenance: 'course-outline-notes'`, a readable `text` and the structured `courseNotes` (`outlineId`, `language`, `leaves: [{ id, title, anchors, body?, exam? }]`, `papers`, `counts`, `supersedes`). A `body` is `{ fingerprint, points, explain, example?, extra?, cites: [{ n, sourceId, quote, start, end }], replaces? }` (`[^n]` marks cite n in the texts) or `{ fingerprint, empty: true }`; an `exam` is `{ fingerprint, tested, note?, replaces? }`. The fingerprints and what "out of date" means are lib/course-book-inputs.js, shared by the page and the task. `isLibraryListSource` hides it; `assertMaterials` refuses it with course-notes-not-material. `course.outline` answers `book.notes` (`{ id, stale, missing, changed, leaves, papers }`), and an expanded knowledge point carries its own notes in `open[key].notes` (lib/course-book-view.js).
- `generation.courseBook.build {course, language?, papers?}` starts the Job `course-book-build` (lib/contexts/generation/book/): the outline's stages first when needed (the same Job, `organiseOutline`), explanation calls in batches, 考情 calls, and one `sources.ingest` (the outline and the book together; what they replace is archived in the same write). The language follows the request's `language`. Refusals: course-book-no-course, course-book-no-materials, course-book-outline-running, and the outline's own. Its result names `{ kind: 'course-book', id, course }`; the console's **Open the review book** goes to the outline page of that course.
