---
name: place-shared-code
description: "Asks the questions this repo's history raises when code is added that another part could own or reuse: is there already one owner for this component, fact, list or rule; is a shared primitive shaped for one case; is a written rule enforced by a check. Use before adding a component, constant, list, rule, guard or helper, or copying code from a sibling feature."
---

# Decide who owns new code

**Outcome:** new code that has exactly one owner per fact, component and rule, with rules that fail when broken.

**Done:** each question is answered; any second copy you kept is named in the PR with its reason.

Each question is the catch of a general-mistake class mined from this repo's PRs and issues. The classes recur on different features, so ask every question, not only the ones that look related to the file you touch.

## Questions

- [C02] Does something in the repo already own this, and am I going through it? If it does not fit my context, can I widen it instead of copying it?
- [C16] Which test or guard fails if the next change or the next generated output breaks this rule or lacks this property, and does it scan the whole tree or the real outputs?
- [C24] Is this fact or list defined once and read everywhere else? If I am adding another case, how many places must I edit, and should they become one table?
- [C25] Is this shared thing in a shared place under a neutral name, does it cover the variants its callers need, and can a consumer differ from it without an override? How many overrides, resets or copies exist already?
- [C14] Does this addition make an existing file, function or prop chain longer, and is there a seam it should plug into instead?
- [C10] Is this limit a product decision with a configurable default, or did I pin it to the case in front of me?

For any question you cannot answer at once, read that class's entry (condition, boundary, pairs): `grep -A9 '^## C03 ' docs/agent-lessons/taxonomy.md`, with the class id in place of C03.

## Red flags

- "A small local version is quicker."
- "I will keep my own copy of the list."
- "The rule is written in the docs."
- "This primitive only needs this one case."
- "Exclude the paths we do not want; everything else is fine."

## Pinned commands

- `npm run lint`
- `npm run lib-graph` (module boundaries)
