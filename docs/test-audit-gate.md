# Test quality on pull requests

Run `node scripts/test-audit.mjs --gate-from=origin/main --annotations` from a checkout with the target commit available. In pull request CI, pass the event's base SHA. The command exits 1 when it finds a new blocking assertion or cannot read the base commit. A successful run exits 0 and reports the number of changed test files it checked.

The gate checks `*.test.mjs` under `tests/` and package test directories. It recognizes direct Node assertions that check a program source file for a text fragment, assert the literal `true`, or compare a simple identifier with itself using an equality assertion. It compares each assertion with the same test in the base revision. Adding a second copy, or replacing an old source-string assertion with a different one, fails. Moving an unchanged assertion down a few lines or renaming the test file retains its allowance. Local runs include untracked test files.

Use the reported file and line to replace the assertion with an observation of the public output, saved state or failure mode. Checks on the contents of documents and assertions on an application's rendered text remain valid. The scanner recognizes direct calls syntactically. Aliases, computed paths and arbitrary helper functions require review.

The existing [seven-category audit](test-audit.md) compares totals against [the committed JSON baseline](test-audit-baseline.json) and remains advisory. Use it to locate older tests for replacement and review heuristic findings such as similar titles, call counts or mocked external fields. Updating the JSON baseline cannot grant an allowance for the pull request gate.
