# Generation performance and settings validation

Pre-fix HEAD: `ea08a2a`, branch `codex/studyhub-2.5.9`. Package version remains 2.5.8; this work does not publish or replace that release. Pre-existing README, documentation, site, blob and configuration work is excluded from the fix commits.

## Confirmed defects and corrections

The evidence-first workflow from the preceding fixes is retained: extract useful knowledge statements and original passages; verify citations in code; derive concrete answers, scenario conditions and comparable options; author questions bound to those target IDs; independently review every candidate. Separate prompts prohibit inventing facts to fill a quota and permit explicit omissions. Binding prevents authoring or rewrite steps from replacing verified citations or prepared answer fields. Tests cover the stage order, fabricated author answers, missing target references and insufficient source evidence.

- All selected material groups had to finish planning before the first batch could begin. Planning remains sequential to reserve distinct learning targets, but each verified group now releases its batches immediately. Planning, supported-answer design, authoring and independent review share one cancellable FIFO concurrency limit. The number of active batches is also bounded. Source verification, stable result ordering and serialized checkpoints remain in place.
- Saved generation settings were not consumed by the worker or the estimate, and invalid settings were accepted. One shared contract now validates patches, normalizes older persisted settings and resolves each request before queuing. Defaults remain 3 concurrent calls, batches of 5 and a 20-minute execution budget. The settings page exposes concurrency 1–6, batch size 1–5, budget 5–60 minutes, kind, count, language, difficulty and focus.
- A visibility/activity event during a pending snapshot could leave two permanent timer chains. The pending request now owns the next timer and coalesces wake requests into one immediate refresh.
- Integration checks caught and corrected ordinary question-count defaults interfering with case papers, estimates dropping explicit mixed-kind counts, continuation merges losing performance metadata, and corrupt retained performance being mistaken for an explicit request override. Case papers keep their original two-question default and one complete-paper batch. Continuations retain their original choices and normalize legacy performance; explicit invalid overrides are still rejected.

## Measurement and evidence

Controlled 120 ms fake-model workload, same material and question requests:

| Metric | Before | After, default settings |
| --- | --- | --- |
| First saved qualified batch | 752–761 ms | 498–508 ms |
| Default total duration | Baseline | Approximately unchanged |
| Model calls in measured scenarios | 12 / 21 | 12 / 21 |
| Checkpoints | 6 / 12 | 6 / 12 |

First qualified results arrived about 33–34% earlier. A separate configured 6-concurrency run finished 20/30 questions in 767/798 ms, compared with the old default's 1154/1156 ms; this is a configuration comparison, not a claim about default throughput. Prompt-token figures are local estimates, not actual usage or cost. No real-provider throughput or first-pass acceptance rate was measured.

Real local preview, controlled standard DOM visibility event during a delayed response: 14-second snapshot counts changed from 10 to 7, with an uninterrupted baseline of 6. Maximum request concurrency remained 1 and incremental `since` requests remained intact. Headless automation did not perform a native background-tab transition.

Raw evidence (local, ignored QA output):

- `output/bugfix-audit-round3/performance/comparison.json` and `performance/repair-results.md`
- `output/bugfix-audit-round3/ui/public-poll-red.log`, `public-poll-green.log`
- `output/bugfix-audit-round3/ui/generation-settings-runtime-red.log`, `generation-settings-legacy-red.log`, `generation-settings-runtime-green.log`
- `output/bugfix-audit-round3/corrupt-draft-red.log`, `settings-final.log`
- `output/bugfix-audit-round3/settings-to-generation.json` and three `flow-*` summaries/screenshots
- `output/playwright/generation-settings/summary.json`

## Validation

Directed scheduler checks: 96/96; adjacent generation checks: 66/66. Settings contract/UI/runtime/status/estimate checks after the final compatibility correction: 57/57. The actual settings-to-generation browser chain passed English 360 px, Chinese 420 px and English 720 px at 200% scale, without page, console or API errors. Settings-only checks passed eight Chinese/English width/scale layouts, all eight persisted fields, reset-without-save and invalid-range feedback; they made zero model calls.

The first broad run encountered an in-progress test fixture error and a Node HTTP-parser exception after a main-context test ended. The fixture was corrected without weakening production validation. Main-context rerun passed 19/19; the combined runtime/estimate/main-context rerun passed 44/44. A second broad run passed 3329/3331 but reproduced the HTTP-parser exception and exposed a fixed-duration conversion-state fixture race. A four-file-concurrency diagnostic run passed 3331/3331; this alone did not resolve environment isolation.

A network-blocking probe confirmed that the main-context fixture inherited enabled machine experiments and attempted 22 auxiliary Jev requests to an external service. Main-context and new generation-runtime fixtures now use temporary machine settings and await service disposal. Their blocked-network run passed 26/26 with zero external request attempts. The exact Node parser timing mechanism is an inference from the built-in timeout callback and later mock-clock advancement; no further real external requests were used to reproduce it.

The conversion fixture race was independently reproduced by delaying each read-only probe 1100 ms. The fake conversion now waits for a completion marker, released only after the public snapshot reports parsing and passes the original timestamp assertions. Ordinary and delayed checks passed, as did 37/37 adjacent tests. The 30-second wait is bounded and failures include observed states and probe history; no production conversion behavior changed.

An isolated full-suite run passed 3332/3332 with the original default file concurrency. Its guard blocked four automatic update-check connection attempts; no external transmissions were permitted. This isolation is now part of the persistent `npm test` entry: a fresh temporary machine home, scrubbed inherited credentials and a loopback/local-IPC-only network guard. The wrapper preserves Node test arguments, forwards termination signals, removes its temporary home and preserves success/nonzero exit status. Controlled Windows proof covered local HTTP and named-pipe IPC, six rejected external connection paths, clean child-CLI output, argument filtering and temporary-home cleanup. The persistent entry's directed checks passed 34/34, with a separate filtered 2/2 run.

Final verification through the persistent default `npm test` entry passed **3332/3332**, with zero failures, cancellations or skipped tests (179.54 seconds, 346 worker processes, original default file concurrency). The guard blocked four automatic update-check connection attempts. Full `npm run lint` and `npm run build` both passed. Evidence: `output/bugfix-audit-round3/npm-test-final.log`, `lint-entry-final.log` and `build-entry-final.log`.

Three independent simplification reviews completed. Applied one reuse improvement (existing localized question-kind names) and one efficiency improvement (unchanged generation defaults preserve the form reference); quality review had no actionable findings. Cancellation, citation checks, independent review, version checks and data-retention safeguards were retained.

Primary models were simulated and libraries were isolated. The initial broad runs did not fully isolate machine-wide experimental settings, so no zero-network claim is made for those runs. The isolated final validation and persistent default entry use scrubbed credentials, a temporary machine home and a loopback-only network guard. This improves workflow reliability and time to the first result; it does not establish a 100% acceptance guarantee or prove semantic correctness of every model answer.
