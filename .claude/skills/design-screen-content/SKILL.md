---
name: design-screen-content
description: "Load before you change what a screen shows: a message, toast, warning, status or label; a list row; a loading, empty or failed state; which controls appear; parts that must line up or match, such as buttons whose spacing or borders differ (界面、文案、提示、状态、空状态、不一致). Its questions come from this repo's own PRs and issues and are in the skill body, not in this description: read it before you answer."
---

# Design what one screen shows

**Outcome:** a screen whose every message, control and layout state matches what is true for the user at that moment.

**Done:** each question is answered, and the screen was looked at loading, empty, full and failed.

Each question is the catch of a general-mistake class mined from this repo's PRs and issues. The classes recur on different features, so ask every question, not only the ones that look related to the file you touch.

## Questions

- [C06] For each outcome (success, each failure cause, each item in a list), does the user or caller see the real state and the real cause?
- [C27] When this data arrives after first paint, does anything already shown move or change, is the loading state the same size as the ready state, and does a row that never gets it pay nothing for the slot?
- [C40] For each control, prompt or warning I show, what condition makes it valid or true, is that condition read at the moment of showing, and is it shown only then?
- [C09] Can a user predict what this does, when, and what it costs, and can a keyboard or touch user reach that explanation?
- [C54] Which pieces (or rows of one list) does the user take as one unit here, and does one grid, row unit, builder or list-level value set their edges, frames, spacing, separators and how much each shows, checked with each optional piece present and absent and with neighbouring rows side by side?
- [C45] For each view, what does it show with no data, a zero value or nothing configured, and have I looked at that state next to the populated one?
- [C30] What is common to all rows here, and is it stated once at the group level with the right unit?

For any question you cannot answer at once, read that class's entry (condition, boundary, pairs): `grep -A9 '^## C03 ' docs/agent-lessons/taxonomy.md`, with the class id in place of C03.

## Red flags

- "The loading state only lasts a moment."
- "The message is close enough to what happened."
- "Show the button always; it just does nothing when it cannot run."
- "It looks right with my data."
- "The tooltip explains it."

## Pinned commands

- `npm run qa:honest-states` (states and messages)
- `npm run qa:journey` (screenshots along the main path)
