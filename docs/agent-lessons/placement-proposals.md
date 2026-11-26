# Placement proposals that need the owner (2026-11-25)

The 53 homed classes now live in six decision-moment skills plus one record (`solutions/windows-tool-assumptions.md`). The homes below are cheaper or stronger than a skill question, but each one is persistent configuration or product work, so none was added without the owner.

## Hooks (fire at a matched tool call, zero tokens otherwise): applied 2026-11-25

Both hooks are in `.claude/settings.json`, run by the kit in `.claude/hooks/` (`skill-moment.mjs` plus the moment table `skill-moments.json`). They add context only; they never block or change permissions. Guard tests are in `tests/skill-forge-scripts.test.mjs`.

| Moment | Matches | Injects | Classes |
|---|---|---|---|
| declare-done | `Bash` command that runs `gh pr create` | every verify-before-done question | C01 C03 C04 C26 C31 C36 C38 C41 C42 |
| release | `Bash` command that runs `gh release create` or `npm run release:pack` | the C38 and C41 questions | C38 C41 |

The first version matched the text anywhere in the command, so a heredoc that only mentioned `gh pr create` fired it, and three `if` entries each injected the full list. The kit now ignores quoted strings and heredoc bodies, and each entry runs only its own moment.

## CLAUDE.md rules (every session; at most ten in total): not applied

The repo has no CLAUDE.md yet. These three would cost tokens in every session, and the declare-done hook now asks C01 and C03 at the moment they matter, so they stay proposals. Add them only if the hook and skill questions are seen to miss. Candidates, one line each:

1. Before saying a UI or host change works, observe it in the real host on each theme, width and language the user can pick (C03).
2. When changing how something behaves, list every other path that carries the same content and route each through the one unit you changed (C01).
3. Before adding a component, constant, list or rule, search for its existing owner; keep one owner per fact (C02 C24).

## Checks to build (product work, rung 2 of the ladder)

| Check | Catches | Note |
|---|---|---|
| Orphan exports and files after a removal | C26 | a dead-export scan in `npm run lint` or a guard test |
| No fixed sleeps or text-change waits in browser tests | C36 | lint rule on `tests/browser/**` |
| Release artefacts built from the commit that contains the merged PRs | C41 | extend `npm run release:check` |
| Each new shared fact (counts, limits, option lists) read from one module | C24 | per case, as guard tests next to the module |

## Memory lines now covered

These feedback memories state lessons that a class and its skill question now hold. Their index lines could be removed to save standing tokens; the owner decides: fix-whole-surface (C01), integrate-not-parallel (C02), walk-the-whole-flow (C03), short-main-flow (C07), unified-foolproof-ui (C02 C25), windows-editing-gotchas (C15 record).
