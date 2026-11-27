---
name: verify-before-done
description: "Load before you call a change finished, even when the tests pass: before opening a PR, telling the owner a fix works, a release, or handing work to agents (开 PR、可以了吗、修好了吗、发布、交给代理). Its questions come from this repo's own PRs and issues and are in the skill body, not in this description: read it before you answer."
---

# Declare done, ship or hand off

**Outcome:** a claim of done that the owner can rely on without re-checking.

**Done:** each question is answered in the PR or report, with the commands run and their results.

Each question is the catch of a general-mistake class mined from this repo's PRs and issues. The classes recur on different features, so ask every question, not only the ones that look related to the file you touch.

## Questions

- [C03] Which real environments and inputs will this meet (language, width, theme, host, input method, real files, real model, real dependency version), and have I observed it on a sample of each?
- [C36] Does this test depend on wall-clock time, timer order, machine load or runtime behaviour it does not control, does it still pass if the run is slow or crosses a boundary, does cleanup run on the failure path in an order that does not race the code under test, and does every held request or promise get released when the code under test cancels or disposes?
- [C01] Which other paths carry this content or perform this action, and does each one now go through the one unit I changed?
- [C04] Which checks read the whole tree or the merged result, did they run on what will actually land, and for checks that live outside CI, did I run each one once after the change?
- [C59] Before I remove, rewrite or add a check for a property, which defect does it stop, and have I put that defect back (one change only: the guard deleted, the value hardcoded, the key dropped) and watched this check fail?
- [C31] For the path I replace, which outputs, codes, fields and abilities can a caller observe, and has each one been run on both paths and compared?
- [C26] When I replace or remove something, did I delete everything it made redundant (code, tests, styles, listeners, and functions whose only users were what I removed), and what check fails on an orphan?
- [C41] Is this work present on the branch that ships and on every channel users install from, checked there and not from the PR, the branch or one channel's state?
- [C38] Can the previous release read what this change writes, does this code refuse a newer or unknown version and leave its bytes alone, and which test runs each reader on real output of the other release?
- [C42] Before handing this item to a worker, is it already assigned, on a branch or in an open PR, and who merges or discards a second result?

For any question you cannot answer at once, read that class's entry (condition, boundary, pairs): `grep -A9 '^## C03 ' docs/agent-lessons/taxonomy.md`, with the class id in place of C03.

## Handing work to a worker

A worker sees only its brief. Give it these six lines:

- **Goal:** one sentence on the result, not the steps.
- **Owns:** the files it may change and its own worktree (`git worktree add .local/wt/<name>`), never a checkout another session uses; no two workers own the same file.
- **Reuse and never:** what already exists to extend, and what it must not do (a second copy, a parallel path, the full test suite).
- **Done when:** the checks for its own files only (`node --test <files>`); the whole-tree checks run once, after every worker's change is merged.
- **Hand back:** the diff summary, each command run and its result, and what it did not check.
- **Stop if:** the brief contradicts the code, or two fixes failed; then report the assumption both fixes rested on instead of trying a third.

## Red flags

- "The tests pass, so it works."
- "I checked it at my width, in one language, with the fake model."
- "The other entry points use the same code."
- "It is merged, so users have it."
- "That failing test is unrelated."
- "One more try will fix it." (After two failed fixes, write down the assumption both rested on before a third.)

## Pinned commands

- `npm run lint`
- `node scripts/test.mjs --fast` (about 11 minutes)
- `npm run qa:dsh` (the real host)
- `npm run release:check` (before a release)
