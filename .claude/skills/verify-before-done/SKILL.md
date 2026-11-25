---
name: verify-before-done
description: "Asks the declare-done questions this repo's history raises before a change is called finished: every path carries the fix, checks match its reach, behaviour seen in the real host on real inputs, no orphans, formats safe across releases, work on the branch users get. Use before opening a PR, telling the owner a fix works, a release, or handing work to agents."
---

# Declare done, ship or hand off

**Outcome:** a claim of done that the owner can rely on without re-checking.

**Done:** each question is answered in the PR or report, with the commands run and their results.

Each question is the catch of a general-mistake class mined from this repo's PRs and issues. The classes recur on different features, so ask every question, not only the ones that look related to the file you touch.

## Questions

- [C03] Which real environments and inputs will this meet (language, width, theme, host, input method, real files, real model, real dependency version), and have I observed it on a sample of each?
- [C01] Which other paths carry this content or perform this action, and does each one now go through the one unit I changed?
- [C36] Does this test depend on wall-clock time, timer order, machine load or runtime behaviour it does not control, does it still pass if the run is slow or crosses a boundary, does cleanup run on the failure path in an order that does not race the code under test, and does every held request or promise get released when the code under test cancels or disposes?
- [C04] Which checks read the whole tree or the merged result, did they run on what will actually land, and for checks that live outside CI, did I run each one once after the change?
- [C31] For the path I replace, which outputs, codes, fields and abilities can a caller observe, and has each one been run on both paths and compared?
- [C41] Is this work present on the branch that ships and on every channel users install from, checked there and not from the PR, the branch or one channel's state?
- [C26] When I replace or remove something, did I delete everything it made redundant (code, tests, styles, listeners, and functions whose only users were what I removed), and what check fails on an orphan?
- [C38] Can the previous release read what this change writes, does this code refuse a newer or unknown version and leave its bytes alone, and which test runs each reader on real output of the other release?
- [C42] Before handing this item to a worker, is it already assigned, on a branch or in an open PR, and who merges or discards a second result?

For any question you cannot answer at once, read that class's entry (condition, boundary, pairs): `grep -A9 '^## C03 ' docs/agent-lessons/taxonomy.md`, with the class id in place of C03.

## Red flags

- "The tests pass, so it works."
- "I checked it at my width, in one language, with the fake model."
- "The other entry points use the same code."
- "It is merged, so users have it."
- "That failing test is unrelated."

## Pinned commands

- `npm run lint`
- `node scripts/test.mjs --fast` (about 11 minutes)
- `npm run qa:dsh` (the real host)
- `npm run release:check` (before a release)
