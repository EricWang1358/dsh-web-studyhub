# Course outline

[中文](course-outline.zh-CN.md)

The **Course outline** page lays out the current course by its materials instead of by its decks: each material, its chapters, and under each chapter the questions that cite it. Use it to find the questions about a part of the course and practise exactly those, without working out which deck holds them.

This is step 1: the outline is built from the materials' own chapters, with no AI text. Checked against the code on 2026-10-09.

## Open it

On the **Study library** home page, the course area (under the course name and its progress bar) has a **Course outline** link. It opens the outline of the current course. **Back to library** returns to the home page. The page has no sidebar entry.

The home page keeps one main card and its one continue button. The folded **Course route** list that used to sit under the progress bar is gone; the outline replaces it. The progress bar and **Continue course** still follow the deck order.

## What it shows

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

## Limits of step 1

- The outline is the materials' chapters; it does not yet group them into exam points or explain them (steps 2 and 3).
- The order of new questions in **Continue course** and on the home page is still the deck order.
- A question cannot be moved to another row by hand.
- Recordings keep their parts as chapters only when the material has chapters; there is no jump to a time in the recording.

## For developers

- `course.outline {course?, deckId?, expand?, pick?}` (lib/course-outline.js; the placement is lib/course-outline-index.js) is read on demand and never sent with the snapshot. Without `expand` it returns the material rows with counts; `expand: [key]` adds the chapters of a material or the questions of a row; `pick: { keys, cards }` returns only `practice: { scope, total, capped, limit }`, a scope `review.start {mode:'path'}` takes as it is.
- The placement is cached per library revision, minute, course and deck filter. A synthetic library of 200 materials (6 million characters), 3,000 questions and 600 fuzzy quotes takes about 75 ms the first time and 5 ms after; the answer without open rows is about 55 KB.
- The page is ui/outline/; the registry row is `outline` in ui/pages.js.
