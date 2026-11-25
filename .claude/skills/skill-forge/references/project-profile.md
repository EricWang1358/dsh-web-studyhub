# Project profile: StudyHub (dsh-web-studyhub)

Facts the other references need. Update this file when they change; nothing else in the skill hard-codes them.

## Repository and workbench

- Repo: `EricWang1358/dsh-web-studyhub`. On 2026-11-25 it had 851 PRs and 609 issues.
- Workbench: `../studyhub-skill-mining/` (a sibling of the repo checkout). It holds `raw/`, `index.jsonl`, `train.json`, `holdout.json`, `samples/`, `batches/`, `cards/`, `stats.md` and `evals/`. It is not part of the repo; `git init` it if the owner wants history.
- Noise patterns for `triage.mjs`: the defaults (release chores, dependency bumps). Put extra patterns in `<wb>/profile.json` as `{"noisePatterns": [...]}`.
- Holdout date: `2026-11-18`. Items created after it are the holdout (209 of 1,439 non-noise items on 2026-11-25, about 15%; 2026-11-10 would have held a third). Move it forward only together with a fresh evaluation.

## Before calling GitHub

- Run `gh api user --jq .login` once. If it fails, stop and tell the owner; do not retry in a loop.
- Only `export-github.mjs` reads GitHub in bulk, one page at a time.

## Agents and models

- At most three agents at once, reviewers included.
- Card writing: `research-analyst` (Sonnet); it returns JSONL in its report. Taxonomy decisions and skill text are written by the main session.
- Never use the Fable tier. A `general-purpose` agent must be given an explicit model (Haiku, Sonnet or Opus).

## Decision moments (the first skill slots)

These are hypotheses until calibration confirms them: design a change, implement, verify in the real host, declare done or open a PR, release, communicate to the user (UI wording, numbers, causes), delegate to agents. Merge or drop slots that end up with fewer than three placed classes.

## Seed classes

The seed classes in `docs/agent-lessons/taxonomy.md` come from the owner's feedback lessons, recorded before mining started. Treat them as candidates: mining confirms, merges, splits or retires them.

## Before anything leaves the machine

- Scan changed files for personal names, email addresses, local user paths, keys and tokens before a commit, PR or issue comment. Taxonomy entries cite refs and paraphrase; they never quote the owner or users.
- Repo checks before a PR: `npm run lint` and `node scripts/test.mjs --fast`, plus `node --test tests/skill-forge-scripts.test.mjs` when the scripts changed.
