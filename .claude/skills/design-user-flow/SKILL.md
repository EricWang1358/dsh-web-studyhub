---
name: design-user-flow
description: "Asks the questions this repo's history raises when a user journey is designed or changed: where the feature is found, how long the main path gets, whether the job is covered from start to end, which unit it acts on, what stays in view, and the order things come in. Use before adding or changing an entry point, a multi-step flow, a default, or a feature proposal (方案、新功能、流程)."
---

# Design the user's path

**Outcome:** a flow design in which every question below has an answer you could show the owner.

**Done:** each question is answered in the plan or PR text, or marked not applicable with the reason.

Each question is the catch of a general-mistake class mined from this repo's PRs and issues. The classes recur on different features, so ask every question, not only the ones that look related to the file you touch.

## Questions

- [C17] Walking the user's whole job with this thing, from a fresh start through every view and every intermediate state to changing, handing on and removing it, where does it stop?
- [C08] Looking at the whole surface after this change, how many equal-weight entries are there, and what tells a first-time user that this feature exists at the moment they need it?
- [C49] Before proposing this, what does the existing mechanism already cover, what is the smallest change that closes the remaining gap, and who pays the upkeep of the proposal on every later change?
- [C12] For a large input, how many calls, how much cost and how much output does this default produce, can the user afford and read it, is the repeated part placed first (measured on the real provider's cache), is there a cap checked before each paid call, and does each stage use only the model it needs?
- [C55] In which unit does the user get stuck, understand or work on this, is that the unit this feature acts on and records, and if not, where can the user name that unit and see the result gathered by it?
- [C47] On this screen and in this sequence, where does the user look and in what order do they decide or work through the items, and does each action, message, warning and default order sit and weigh in that order?
- [C07] How many required actions are on the best path and on a fresh user's path, and can each optional choice live behind one fold?
- [C53] When the user takes this step, what must stay visible or be restored (the question, the place, the draft, and any selection this step changed), and does this step keep it in view or bring the user back to it?
- [C52] For each kind of material the user owns, can they bring it in and read it in its faithful original form without an export or conversion first, and is that form one step from the derived view, at the same place and remembered?

For any question you cannot answer at once, read that class's entry (condition, boundary, pairs): `grep -A9 '^## C03 ' docs/agent-lessons/taxonomy.md`, with the class id in place of C03.

## Red flags

- "Users can find it in the menu."
- "It is optional, so it does not make the main path longer."
- "The main case works; the start, the end and the variants can come later."
- "Open it full screen, it is clearer."
- "One request per item is simpler; batches can come later."
- "The ideal version is worth the upkeep."

## Pinned commands

- `npm run qa:journey` (walk the main path in a browser)
