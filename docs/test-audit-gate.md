# Test quality on pull requests

Run `node scripts/test-audit.mjs --gate-from=origin/main --annotations` from a checkout with the target commit available. In pull request CI, pass the event's base SHA. The command exits 1 when it finds a new blocking assertion or cannot read the base commit. A successful run exits 0 and reports the number of changed test files it checked.

The gate checks `*.test.mjs` under `tests/` and package test directories. It recognizes direct Node assertions that check a program source file for a text fragment, assert the literal `true`, or compare a simple identifier with itself using an equality assertion. It compares each assertion with the same test in the base revision. Adding a second copy, or replacing an old source-string assertion with a different one, fails. Moving an unchanged assertion down a few lines or renaming the test file retains its allowance. Local runs include untracked test files.

Use the reported file and line to replace the assertion with an observation of the public output, saved state or failure mode. Checks on the contents of documents and assertions on an application's rendered text remain valid. The scanner recognizes direct calls syntactically. Aliases, computed paths and arbitrary helper functions require review.

The existing [seven-category audit](test-audit.md) compares totals against [the committed JSON baseline](test-audit-baseline.json) and remains advisory. Use it to locate older tests for replacement and review heuristic findings such as similar titles, call counts or mocked external fields. Updating the JSON baseline cannot grant an allowance for the pull request gate.

## Does the replacement still catch the defect?

Run `node scripts/qa/replacement-controls.mjs --base=origin/main` to check committed changes. Use `--head=<commit>` to examine a proposed test without checking out its branch. `--all` reruns the four independent reference tests against their respective defects.

| Registered behavior | Deliberate defect | Observation required from the reference test |
| --- | --- | --- |
| Second written exam | Carry the first report’s practice message through restart and submission | The second report has its own run ID and an empty message |
| Number animation after unmount | Let the pending module import call the component’s state setter after cleanup | The import finishes and the count of calls to an unmounted setter stays at zero |
| Board drag | Read the bounding boxes of all sibling cards on each pointer move | Drag entry measures one card and four pointer moves add zero reads |
| Skeleton viewport | Omit the skeleton ID from the viewport reset key | Same-ID data preserves a manually panned viewport and changing only the ID restores the fitted transform |

CI selects controls when their production file changes. Editing the runner, registry, reference cases or rendering harness selects all four. For changed registered test files it compares named top-level `test` bodies between the base and head commits. If a registered test changes, CI runs the proposed replacement itself as well as the independent reference. Other test bodies in the same file can change independently.

For each selected test, CI applies the defect in a temporary checkout, runs the named case, restores the production code and runs the same case again in a fresh process. `CAUGHT` requires an assertion failure on the broken code and a passing case on the restored code. `SURVIVED` means the replacement passed both times. `INVALID` means the comparison did not run correctly, such as a loading failure, skipped case or timeout. Both `SURVIVED` and `INVALID` fail CI. A changed implementation that no longer matches its stored defect also requires updating the reproduction.

To register another behavior, add an entry to `scripts/qa/replacement-control-cases.mjs` with its implementation file, focused test name pattern and an edit that restores a specific defect. Add a reference case with an observable result to `tests/replacement-controls.test.mjs`. The skeleton entry shows how to register the original and replacement titles when a test is split. Register the new path or title when moving a protected test. The gate currently recognizes literal top-level Node test names. Detecting arbitrary changes in imported test helpers and unregistered behavior still requires review.

The original replacement tests in #1511 (`d8dfa11a3`), #1531 (`b59f52748`), #1532 (`e953f867e`) and #1545 (`835d863da`) each passed with its defect restored. To reproduce those results from a clone containing the commits, use `--base=282b0fc0d` and the respective `--head`. In a local copy of #1532, adding calls to the registered card’s `onDragEnter` and `onDrag` callbacks and asserting one bounding-box read made the replacement catch the repeated scan. The proposed branches are unchanged by these checks.
