# Mining PRs and issues into cards

## Contents
- Prepare the workbench
- Which items carry a lesson
- Writing a card
- Good and bad rungs
- Classifying against the taxonomy
- Running a batch with sub-agents
- Capturing a single item

Scripts live in `.claude/skills/skill-forge/scripts/`. `<wb>` is the workbench path from `project-profile.md`.

## Prepare the workbench

Run these once, in order. The export is paced and resumable; rerun it to fetch new items.

```
node scripts/export-github.mjs --repo <owner/name> --out <wb> --kind all
node scripts/triage.mjs index --workbench <wb>
node scripts/triage.mjs split --workbench <wb> --holdout-after <date from profile>
node scripts/triage.mjs sample --workbench <wb> --n 50 --seed 1
node scripts/triage.mjs dossier --workbench <wb> --refs <wb>/samples/calib-50.json --per-batch 10 --name calib
```

The holdout items are never read while mining. They exist only for `evaluate.md`.

## Which items carry a lesson

An item carries a lesson when something was corrected: a bug fix, a revert, a follow-up fix to an earlier PR, an issue reporting a defect or a confusing experience, a review that asked for changes, an owner complaint after a release, or a plan the owner rejected. A feature PR whose body reports corrections made along the way (bugs found in its own walkthrough, review rounds) also carries one: card the most important correction. A feature PR that went as planned teaches nothing here. Write it as a card with `"noise": true` and short placeholder text in the prose fields, so stats can count what was skipped.

## Writing a card

One JSON line per item, fields as in the schema checked by `cards.mjs check`:

- `surface`: one sentence, the concrete place and symptom.
- `mechanism`: one sentence, how the code or process produced it.
- `mistake`: one sentence naming the violated condition. It must not name a feature, page, file or provider, and it must be specific enough that a reviewer could say yes or no to it about a different change.
- `layer`: `concept` (the model of the domain or the user was wrong), `logic` (the reasoning or the code path was wrong), or `process` (a step was skipped or done in the wrong order).
- `moment`: when the mistake was made, not when it was found.
- `catch`: the yes/no question or the check that, asked at that moment, would have stopped it.
- `home`: your first guess at the cheapest home (see `place.md`); the main session decides.
- `area`: the feature area in two or three lowercase words (`reader`, `job-runtime`, `book-api`). Stats count distinct areas as surfaces, because issues change no files.
- `costly_reason` (optional): set it when the dossier shows an owner correction, a broken release or a red main that the index cannot see.
- `evidence`: other refs that show the same mistake, when the dossier links them.
- `confidence`: how sure you are of rung 3. Below 0.5 means the dossier did not show the cause; say so in `mechanism`.

## Good and bad rungs

| Rung | Bad | Good |
|---|---|---|
| mistake | "Formula rendering was broken in Markdown." (still a surface) | "A display fix was applied to the path in the report instead of every path that carries the same content." |
| mistake | "Be more careful with tests." (not answerable) | "The verification ran on a subset that excluded the guards which scan the whole tree." |
| catch | "Test more." | "Which other routes carry this content, and does each one go through the shared unit I changed?" |
| layer | `logic` for a skipped walkthrough | `process`: the code was right for the path tested; a step was skipped |

When two items look unrelated but the same catch question would have stopped both, they are the same class. That pair is the most valuable thing a batch can find; name both refs in `evidence`.

## Classifying against the taxonomy

Read `docs/agent-lessons/taxonomy.md` before the batch. Give a card an existing class only when that class's catch question would have stopped this item. Otherwise set `"class": "new"` and write `proposed_class` as a condition in the same style. Do not stretch a class to fit; a wrong fit hides a missing class.

Write `proposed_class` at the level where it would fit at least two different features. In the first calibration batch, card writers proposed 29 new classes for 38 cards, almost all of them one feature in disguise ("a saved scroll position was restored too early"). The main session then merged them into five classes ("a decision was made on state that was not settled"). Before proposing a class, ask which other feature could make the same mistake, and word the condition so it covers both.

## Running a batch with sub-agents

- Respect the concurrency and model limits in the profile.
- Give each sub-agent one dossier batch file, this reference, the taxonomy, and the card schema. Ask it to return the JSONL lines in its report and nothing else; it does not write files and does not read raw exports or GitHub.
- The main session writes `<wb>/cards/<batch>.jsonl`, then runs `cards.mjs check`. It re-reads any card with confidence below 0.5 against its dossier before accepting it.
- After each batch, run `cards.mjs stats` and apply `taxonomy-rules.md`. The taxonomy has one writer: the main session.

## Capturing a single item

After a fix lands, write one card for it in the same way, from the PR and its linked issue. If an existing class covers it, add the ref to that class's evidence and check that its home still stops the repeat. If the existing home did not stop it, that is the finding: report which home failed and why, then go to `place.md`.
