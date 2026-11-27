---
name: decide-from-data
description: "Load before you write, change or fix code that decides, classifies or rewrites: a status, grade, mastery or schedule; a rule, regex, keyword match or filter, above all one that catches too much or too little; a migration or bulk edit (判定、掌握度、匹配、关键词、误判、迁移). Its questions come from this repo's own PRs and issues and are in the skill body, not in this description: read it before you answer."
---

# Compute a decision, classify input or rewrite stored data

**Outcome:** a decision that reads every signal that bears on it and a write that keeps or can restore what the user owned.

**Done:** each question is answered, with a test whose data makes the similar signals and identifiers differ.

Each question is the catch of a general-mistake class mined from this repo's PRs and issues. The classes recur on different features, so ask every question, not only the ones that look related to the file you touch.

## Questions

- [C50] For each decision this code makes, which signals the system already records or computes bear on it, and is each one read here or deliberately left out?
- [C46] Which contexts produce the signal this status or action is computed from, including the context where the evidence is absent, is it true in each of them, and is there an explicit flag that only the real thing sets?
- [C21] Which other variants, element kinds or family members does this rule, label or handler match or move, and have I looked at each one with its own kind and shape?
- [C20] Which properties of this data do other parts or the user rely on, and have I run the transformation on real data to see each one survive?
- [C18] If this runs over content the user already has or has typed, what happens to each existing item, and does the code keep it or show the user and get confirmation first?
- [C51] If the user does this by mistake, or the data is damaged, what brings the earlier state back, and does that path exist before the action ships?
- [C37] Does this rule or boundary select by a list of known names or spellings, and what else has the same capability that is not on the list (new, renamed, aliased)?
- [C58] For this key or lookup, which exact unit does the value belong to, does the identifier carry every coordinate that tells it from its neighbours, and does a test use data where the similar identifiers differ?
- [C22] Does this operation touch only the items I created or intend, or does it select by exclusion or wildcard, or switch, pull, rebase, reset, stash or reinstall the dependencies of a checkout that another session may be using?

For any question you cannot answer at once, read that class's entry (condition, boundary, pairs): `grep -A9 '^## C03 ' docs/agent-lessons/taxonomy.md`, with the class id in place of C03.

## Red flags

- "Matching this keyword is close enough."
- "Skip anything that looks like a question."
- "The latest correct answer means it was corrected."
- "Re-import simply overwrites."
- "Users will not do this by mistake."
- "These two ids are always the same."

## Pinned commands

- `node scripts/test.mjs --smart`
