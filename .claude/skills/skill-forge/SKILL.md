---
name: skill-forge
description: "Turns this repo's PR and issue history into general-mistake classes and puts each lesson in its cheapest home: a check, a hook, a CLAUDE.md rule, a solution record, or a question in a decision-moment skill. Use when mining PRs or issues (复盘、归纳、提炼成 skill), when a fixed bug shows a mistake that could recur on another surface, or for any change to a file under .claude/skills/."
---

# Skill Forge

**Outcome:** every lesson from history lives where it stops the next repeat at the lowest standing token cost, and every skill under `.claude/skills/` meets the budgets and has been evaluated.

**Done:** the mode's report is written, `node .claude/skills/skill-forge/scripts/check-skills.mjs` exits 0, cards pass `cards.mjs check`, and a behavior change was evaluated or its exact skip reason is recorded.

**Non-goal:** a summary of history. A card that only says where something broke is not a lesson.

## Recurrence is conceptual

Surface symptoms rarely repeat. The same mistake in concept, logic or process does, on a different page, job or file. Lift every item up this ladder before grouping it:

1. **Surface:** what broke, where.
2. **Mechanism:** how it broke.
3. **General mistake:** the condition that was violated, worded so it could apply to a feature that does not exist yet. Record its layer (concept, logic, process) and the moment it was made (design, implement, verify, declare-done, release, communicate, delegate).
4. **Catch:** the one question or check at that moment that would have stopped it.

Group by rung 3, never by label or path. Labels and paths are only evidence that a class spans surfaces.

## Modes

Pick the mode from the request; a request can chain them (mine, then place, then author).

| You are | Read | Done when |
|---|---|---|
| Mining a batch of PRs or issues | `references/mine.md`, then `references/taxonomy-rules.md` | The batch's cards pass `cards.mjs check`, the taxonomy is upserted, and `cards.mjs stats` was re-run |
| Capturing the lesson of one problem just fixed | `references/mine.md` (single item), then `references/place.md` | One card, a taxonomy upsert and a placement, or "nothing durable" with the reason |
| Placing or retiring a class | `references/place.md` | The class names its home and the home is written, or the needed check is reported as work |
| Creating or changing a skill | `references/author.md` | `check-skills.mjs` passes and the change follows the authoring rules |
| Evaluating the taxonomy or a skill | `references/evaluate.md` | Coverage, interception and activation results are recorded, or the skip reason is |

Project facts (repo, workbench path, noise rules, holdout date, agent and model limits, privacy scan) are in `references/project-profile.md`. Read it before the first command of any mode.

## Where things live

- **Workbench:** raw exports, index, cards, dossiers and stats live outside the repo (path in the profile). Raw exports are never committed.
- **Taxonomy:** `docs/agent-lessons/taxonomy.md` holds the classes, their catch questions, boundaries, pairs and status. It is the single source the produced skills cite, and only the main session edits it.
- **Produced skills:** one per decision moment under `.claude/skills/<moment>/`; long-tail records under `docs/agent-lessons/solutions/`.

## Rules in every mode

- **Upsert, never append.** Before adding an entry, find the class it belongs to. Merge it, raise the class's wording, or split a class whose catch question no longer fits every member. A taxonomy or skill that only grows is failing.
- **A class is a condition,** with one catch question, a boundary ("not this class: …") and two to four pairs of items that look different but are the same mistake. Cite refs such as `#123`. Never paste issue text and never quote people.
- **Recurring** means at least three items across at least two surfaces, or one costly item (a revert, a red main, a broken release, an owner correction). Anything less stays a card.
- **Cheapest home first.** A check costs nothing per session; a paragraph in a skill is the most expensive home. Follow the ladder in `references/place.md`.
- **Budgets** checked by `check-skills.mjs`: description warns over 400 chars / fails over 1,024 (all skills together fail over 3,000), SKILL.md warns over 6,000 bytes / fails over 8,000, each reference warns over 12,000 bytes and fails when over 100 lines without a Contents heading in the first 20 lines. Keep references one level deep (convention; not currently enforced by `check-skills.mjs`). When a file is over budget, move a coherent block to a reference or merge entries. Never squeeze the wording into dense prose.
- **Models read dossiers, not raw exports** (`triage.mjs dossier`). The abstraction to rung 3 and every taxonomy decision need a strong model; a cheap model may only extract facts.
- **GitHub is read by one paced exporter** (`export-github.mjs`), never by parallel agents.
- **Before anything leaves the machine** (commit, PR, issue comment), run the privacy check in the profile.

## Report

End every mode with: what changed (cards added; classes created, merged, split or retired; homes written), the numbers (items read, cards written, classes recurring or costly, size and token estimate from `check-skills.mjs`), and what was not done or not verified.
