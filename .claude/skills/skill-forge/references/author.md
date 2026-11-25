# Creating or changing a skill

## Contents
- Before the first line
- The description
- The body of a decision-moment skill
- Structure and budgets
- Editing an existing skill
- Sources

## Before the first line

1. Confirm no existing skill already covers the trigger: read every description under `.claude/skills/`.
2. Write the outcome spine as plain prose: the result the skill produces, who uses it next, and the done condition. If you cannot write these in one paragraph, the skill is not ready.
3. Decide the moment. A produced skill belongs to one decision moment (design, implement, verify, declare-done, release, communicate, delegate), because a mistake that recurs across surfaces is caught by the moment, not by the file it lands in.
4. Run a baseline before writing anything (see `evaluate.md`): a fresh agent on two or three holdout tasks without the skill. If the baseline does not show the mistake, there is nothing to teach yet.

## The description

The description is in context in every session, so it is the most expensive line in the skill.

- Sentence one names what this skill does that a sibling would not, with the word a prompt would use first.
- Then one trigger per genuinely distinct situation, in "Use when …" form, written as an observable work state ("before opening a PR", "after a fix touches one of several paths").
- Add Chinese trigger words only where the owner actually uses them.
- Do not summarise the workflow in the description: an agent that reads a workflow there follows it instead of reading the skill.
- Add "Not for …" only when the same words would fire a sibling skill.

Good: "Asks the declare-done questions drawn from this repo's history before a change is called finished. Use before opening a PR, before telling the owner a fix works, or when a UI change is about to be reported as done."
Bad: "Helps with code quality and best practices." (no mechanism, no observable trigger)

## The body of a decision-moment skill

```
# <Moment>
**Outcome:** … **Done:** …
## Questions
- [C03] <catch question>. If unsure, read `references/pairs.md#c03`.
- … ordered by friction, highest first; at most about 12
## Red flags
- Thoughts that preceded the mistake in history (for example "the tests pass, so it works").
## Pinned commands
- The exact verification commands for this moment, once each.
```

Match the form to the failure. A rule the agent knows but skips under pressure needs a firm question plus red flags. Output with the wrong shape needs a positive template, not a list of prohibitions. A behavior that depends on a condition needs an "if <observable condition>" line, not a rule with exceptions.

## Structure and budgets

- Only `SKILL.md`, `scripts/`, `references/` and `assets/` go in a skill folder. No README and no notes on how the skill was made.
- References are one level deep. Each one is named in SKILL.md at the point where it is needed, with the condition for reading it.
- A fact lives in one place: SKILL.md or a reference, never both.
- Budgets are in SKILL.md under "Rules in every mode" and are enforced by `scripts/check-skills.mjs`. Run it after every change.
- Write plain sentences, one idea each. When a body must shrink, move a block or remove a duplicate; never compress wording.

## Editing an existing skill

- Upsert: put the new lesson into the existing question it sharpens, or replace a weaker question. Do not append a near-duplicate.
- Before removing a line, look for what it protects: a test that asserts it, a class that cites it, a commit that added it to fix a named bug. If you find one, keep the line or move the protection elsewhere first.
- For every "must" you remove, name what now decides. If the answer is "the model, if it remembers", keep the "must".
- Re-run `check-skills.mjs`, then the evaluation in `evaluate.md` for any change to triggers, questions or commands.

## Sources

Adapted, in our own words, from the skill-authoring standards in EveryInc/compound-engineering-plugin (ce-skill-work, ce-compound; MIT), obra/superpowers (writing-skills; MIT) and Anthropic's skill-creator.
