# Performance and memory

How StudyHub's host and panel are measured, what 2.4.0 cost on a large real library, what dominated it, what changed, and the budgets that keep it that way. Everything here is reproducible with the scripts below on any library; nothing needs a network, a key or the real DSH. (The earlier `performance-2026-09-16.md` covers the coach and follow-up latency; this page covers the host process and the panel.)

## Measure it

| What | Command |
| --- | --- |
| Host: payload, per-request work, memory stages, growth, heap summary | `node scripts/qa/perf-baseline.mjs --library <dir with study-workspace.json> [--minutes 10] [--heap]`. The library is copied first (`--in-place` measures it where it is); `--seed 600` builds a synthetic library instead. |
| Panel: first render, DOM nodes, JS heap, long tasks, polling cost | `npm run build`, then `node scripts/qa/perf-browser.mjs --seed 600 [--library <dir>] [--lang en --theme light --width 420]` |
| Regression budgets | `node --test tests/perf-budget.test.mjs` (part of `npm test`, in `tests/slow-tests.json`) |
| Fast NFR gates (`< 2 s`) | `node --test tests/perf-nfr-fast.test.mjs` (always runs in `npm run test:fast`) |

`perf-baseline` runs the real preview host (`scripts/preview-server.mjs`, `lib/host.js`, fake model, key/token/base-URL variables removed from the environment) in a forked process (`scripts/qa/perf-host.mjs`), so its memory and event loop are the host's alone, and sends the requests the panel sends. A `Probe` (`scripts/qa/perf-probe.mjs`) counts `JSON.parse`/`JSON.stringify` characters, `structuredClone` calls and characters, and shard reads and writes per request. Counts are exact and repeat. Milliseconds depend on the machine and on what else it is doing (the numbers below were taken on a Windows 11 laptop shared with other agents' test runs): compare counts and medians, never single runs.

## The library the numbers come from

A copy of the owner's real library (read-only original): 1 012 sources (4.8 M characters of text, 15 courses), 58 decks, 2 923 cards, 147 practice runs (79 open), 1 091 attempts; 1 254 shard files, 31.8 MB of shards plus 56.6 MB of old upgrade backups. Node 22.22.

## Before: what 2.4.0 cost

Host, one request at a time. "Next snapshot" is the full snapshot the panel polls after the click: every click changes the library file's stat, so the poll after it is a rebuild.

| request | ms | loop block ms | peak rss MB | peak heap MB | parsed MB | stringified MB | clones |
| --- | --- | --- | --- | --- | --- | --- | --- |
| full snapshot (median of 7) | 500.6 | 231.6 | 764 | 667 | 0 | 9.6 | 2 837 |
| unchanged poll (`since` = fingerprint) | 5.9 | 0 | 757 | 666 | 0 | 0 | 2 221 |
| review.reveal | 179.8 | 165.5 | 886 | 541 | 21.57 | 24.94 | 7 |
| review.reveal: next snapshot | 578 | 239.3 | 886 | 541 | 21.84 | 9.6 | 2 857 |
| review.answer | 163.8 | 139.2 | 910 | 713 | 21.58 | 18.48 | 7 |
| review.answer: next snapshot | 558.8 | 218.2 | 910 | 713 | 21.84 | 9.61 | 2 857 |
| review.move | 175.1 | 5 | 880 | 650 | 21.58 | 24.95 | 7 |
| review.move: next snapshot | 531.6 | 226 | 769 | 286 | 21.85 | 9.61 | 2 857 |
| card.flag | 117 | 104.3 | 790 | 418 | 11.42 | 17.4 | 6 |
| card.flag: next snapshot | 520 | 217.2 | 823 | 564 | 21.85 | 9.61 | 2 857 |
| source.add (2 KB) | 63.1 | 50.1 | 762 | 376 | 5.76 | 6.0 | 6 |
| source.add: next snapshot | 535.5 | 231.1 | 793 | 520 | 21.85 | 9.61 | 2 857 |

The snapshot response was 8.81 MB, 92.5% of it `sources` and 6.87 MB of that the sources' text. A cold first snapshot (library load) took 984 ms and peaked at 323 MB RSS; the panel ran at 1.3 review actions per second with a poll after each.

What dominated, from a CPU profile of 12 rounds of reveal, answer, move and a full snapshot (48 requests, 19.1 s of CPU):

| Share | Where | Why |
| --- | --- | --- |
| 18% | `structuredClone` in the runtime's state reads | the snapshot asked for a private copy of every library field (sources, decks, runs: ~30 MB), then `coach.status`, called from it, copied the same fields through the coach domain; the answer was cloned once more on its way out |
| 18% | `JSON.parse` of shards | a click parsed ~21 MB of shard text to build its draft, and the next snapshot parsed the same 21 MB again (the committed state decoded lazily from text on first read) |
| 18% | two `JSON.stringify` passes in the runtime's transaction guard | every field a transaction could read but not write was stringified before and after the mutation to prove it untouched (~25 MB per click) |
| 9% | garbage collection | the above, as 440-713 MB of transient heap per click |
| 5% | `serialize` hashing | stringify + sha1 of every item of a rewritten collection |
| ~10% | the snapshot's own build | `latestOutcomes` building a JSON key per attempt five times, `reviewedCardStatus` fingerprinting every card, a course list that filtered every source once per course, `courseKey` normalising the same names 5 000 times |

Memory and growth. After the first snapshot the host held 100 MB of heap, the library twice: 32 MB of JSON text plus its parsed objects (strings were 85 of the 105 MB in the heap summary; 158 strings over 100 KB held 40.7 MB). A click and its snapshot spiked to 440-713 MB of heap and 836-910 MB RSS; RSS fell back to ~350 MB within minutes. A 10-minute poll-and-click loop (17 collections) showed no growth: heap 103.3 -> 103.2 MB, so no leak was found in the poll path. Module-level maps (`runs` of the retrieval operations, usage ledgers, job, coach and session maps) are keyed by library root or pruned (100 terminal jobs, 20 coach tasks); a finished generation job is ~1.3 KB in the snapshot. Importing a 150-page PDF three times left heap, external memory and array buffers flat after the first import (which loads pdfjs: +14 MB of heap).

Panel (Chromium, same library, 1440 px, "all courses" scope), first render 1.6 s on a quiet machine and 3.2 s on a loaded one: first snapshot 6.4 M characters, 30 MB of JS heap after it and 56-66 MB after a polling session, 163-213 ms of main thread per changed poll with 2-4 long tasks.

## What changed

Each row is one commit. A budget in `tests/perf-budget.test.mjs` pins it unless noted; every test was written first and run red.

| Commit | Change | Evidence |
| --- | --- | --- |
| `perf(runtime): an unchanged poll no longer rebuilds every operation schema` | `has(context, id)` rebuilt the capability list (a `structuredClone` of every operation's schema); every action cloned fresh field defaults | unchanged poll: 2 221 clones -> 3 on the budget fixture |
| `perf(store): share parsed shards ...` | the store keeps each parsed shard deep-frozen, keyed by its content-hash name; a transaction copies only the fields it writes (and, with a `changed` hint, only the hinted items) and reads the rest from the shared values; the runtime guard skips its stringify for frozen read-only fields | click: parsed 21.6 -> 0.4 MB, stringified 25 -> 0.6 MB (fixture: 90.7% -> 1.8% and 142% -> 4.7% of the library) |
| `perf(snapshot): read the library once, from the cache, without copying it` | the snapshot builds from the store's committed state (the backup port's `inspect()` now returns it); `coach.status` reads two fields | snapshot after a click: parsed 90.8% -> 1.8%, copied 218% -> 31.8% of the library (8.3% after the next row) |
| `perf(snapshot): ship source metadata and length ...` | `sources[].text` replaced by `chars` and a 160-character `excerpt`; a case set's scenario keeps its text | payload 8.81 -> 1.96 MB (fixture 663 K -> 197 K characters) |
| `perf(panel): keep unchanged parts of a polled snapshot ...` | per-key structural sharing of the polled snapshot, one stringify per key instead of one for the whole; the poll backs off to 5 s after 30 s and 10 s after 2 minutes without a change | main thread per changed poll 213 -> 64 ms, no long task |
| `perf(snapshot): stop rebuilding the same derived facts ...` | outcome maps, reviewed-card status, source relations, course names and the course list are computed once per committed value | build: 9 031 -> 461 `JSON.stringify` calls, 5 000 -> 100 name normalisations |
| `perf(runtime): read-only handlers read the committed values ...` | `storagePort.view()` for `map`, `stats`, `wrongbook*`, `graph`, `inbox`, `source.get/list/search/coverage`, `course.route`, `library.context`, `skeleton.*`, `workflow.list/context`, `review.get` | a page read copied 1.9 M characters for a 14 K answer, now within 2x the answer; 33 answers on the real library equal to 2.4.0's |
| `perf(store): hold the library once ...` | once a shard is parsed its text is dropped | heap after the first snapshot 100.4 -> 57.8 MB |
| `perf(store): copy a parsed shard from memory ...` | a private copy of a parsed shard is a `structuredClone` of the cached value, not a synchronous re-read of its file (517 ms for the sources, 96 ms for the decks, against 24 and 66 ms) | a full-collection write reads 0 shard files back |
| `perf(startup): load the YAML parser only for a legacy import` | `yaml` imported on use | `lib/host.js` module load 617 -> 487 ms in a fresh process; a test forbids static imports of `yaml`, `pdf-lib`, `pdfjs-dist` in `lib/` |
| `perf(panel): a long scroll window draws a first chunk ...` | `ScrollWindow` draws 120 rows and the next 120 on scroll or on tabbing into the last rows | generate page 2 667 -> 1 415 DOM nodes |
| `perf(panel): the once-a-minute fingerprint rollover does not restart the poll rhythm` | the host's per-minute fingerprint change no longer resets the back-off | 95 s idle: 25 snapshot requests, 38 before |
| `perf(snapshot): when only time moved, the minute's poll answers the time-dependent parts (#567)` | a poll with `partial: true` whose fingerprint differs only by the minute (same day, nothing written) gets `{ partial, fingerprint }` plus the clock-reading parts (`lib/snapshot-time.js` TIME_KEYS) that came out different from what was answered under that fingerprint; the panel merges them and keeps every other key's object | 150 s idle on the library page, `seedLibrary({ sources: 300 })`: 1 348 KB -> 31 KB of snapshot answers; the minute's answer 440 KB -> 0.9 KB (no card fell due) |
| `perf(snapshot): keep live job progress out of the library fingerprint (#886)` | while a job is active its row puts only its structure in the fingerprint (`lib/job-structure.js`: id, type, status, and the contract's identity, kind, title, status, end reason, continuedBy, actions, result, error, start and finish); its progress, usage, calls, log and streamed output reach the panel through `job.live.list` (the active rows exactly as `snapshot.jobs` has them), which the snapshot poll asks after any answer that is not a whole snapshot and merges over the snapshot's rows (`ui/app/live-jobs.js`) | 10 minutes of polls (240 x 2.5 s), a question run and a unified-runtime job ticking progress and streamed output every poll and writing nothing, `seedLibrary({ sources: 300 })`: whole snapshots 241 -> 2 (start and end; plus 10 clock-only answers), UTF-8 bytes of the answers 83.4 MB -> 1.03 MB of snapshot answers + 6.93 MB of live reads (239 x ~29 KB) = 7.95 MB; a run that writes its draft N times: <= N + 2 whole snapshots (`tests/job-live-snapshot.test.mjs`, which prints the same counts for its 20-source library) |

## After

Same library, same harness, quiet-as-possible machine. `before -> after`:

| request | ms | loop block ms | peak rss MB | peak heap MB | parsed MB | stringified MB | clones |
| --- | --- | --- | --- | --- | --- | --- | --- |
| full snapshot (median of 7) | 500.6 -> 96.7 | 231.6 -> 53.7 | 764 -> 188 | 667 -> 103 | 0 -> 0 | 9.6 -> 2.01 | 2 837 -> 576 |
| unchanged poll | 5.9 -> 3.1 | 0 -> 0 | 757 -> 186 | 666 -> 98 | 0 -> 0 | 0 -> 0 | 2 221 -> 556 |
| review.reveal | 179.8 -> 25 | 165.5 -> 8.8 | 886 -> 274 | 541 -> 94 | 21.57 -> 0.42 | 24.94 -> 0.56 | 7 -> 5 |
| review.reveal: next snapshot | 578 -> 116 | 239.3 -> 16.3 | 886 -> 274 | 541 -> 100 | 21.84 -> 0 | 9.6 -> 2.01 | 2 857 -> 576 |
| review.answer | 163.8 -> 99.3 | 139.2 -> 7.7 | 910 -> 284 | 713 -> 114 | 21.58 -> 0.87 | 18.48 -> 6.17 | 7 -> 81 |
| review.answer: next snapshot | 558.8 -> 99 | 218.2 -> 15.6 | 910 -> 284 | 713 -> 114 | 21.84 -> 0 | 9.61 -> 2.01 | 2 857 -> 576 |
| review.move | 175.1 -> 26.5 | 5 -> 8.5 | 880 -> 287 | 650 -> 193 | 21.58 -> 0.42 | 24.95 -> 0.56 | 7 -> 5 |
| review.move: next snapshot | 531.6 -> 111 | 226 -> 16.1 | 769 -> 280 | 286 -> 76 | 21.85 -> 0 | 9.61 -> 2.01 | 2 857 -> 576 |
| card.flag | 117 -> 86.4 | 104.3 -> 65.8 | 790 -> 283 | 418 -> 96 | 11.42 -> 0.4 | 17.4 -> 5.66 | 6 -> 78 |
| card.flag: next snapshot | 520 -> 104.6 | 217.2 -> 16.7 | 823 -> 283 | 564 -> 104 | 21.85 -> 0 | 9.61 -> 2.01 | 2 857 -> 576 |
| source.add (2 KB) | 63.1 -> 56.2 | 50.1 -> 5.2 | 762 -> 299 | 376 -> 148 | 5.76 -> 0 | 6.0 -> 5.87 | 6 -> 1 034 |
| source.add: next snapshot | 535.5 -> 88.1 | 231.1 -> 20.1 | 793 -> 296 | 520 -> 149 | 21.85 -> 0 | 9.61 -> 2.01 | 2 857 -> 576 |

(`clones` rise for writes that copy a whole collection because each shard is now copied individually: 1 034 small `structuredClone` calls instead of one parse of 5.7 MB; the milliseconds are what matters, and they fell.)

| | before | after |
| --- | --- | --- |
| snapshot response | 8.81 MB (6.87 MB source text) | 1.96 MB (no source text) |
| cold first snapshot / its peak RSS | 984 ms / 323 MB | 625 ms / 231 MB |
| review actions per second, each followed by a poll | 1.3 | 6.7 |
| `lib/host.js` module load, fresh process | 617 ms | 487 ms |

| host memory (after a forced collection) | RSS MB | heap MB |
| --- | --- | --- |
| host started, no library loaded | 79.6 -> 83.4 | 16.7 -> 16 |
| idle, after the first snapshot | 277.5 -> 182.4 | 100.5 -> 57.8 |
| after 100 polls | 700.3 -> 274.9 | 102.5 -> 59.1 |
| after 200 review actions, each followed by a poll | 710.4 -> 296.9 | 103.1 -> 59.6 |
| after opening every page action and every deck | 714.2 -> 395.9 | 103.3 -> 59.9 |

| page action (host ms) | before -> after |
| --- | --- |
| wrongbook | 128.9 -> 11.6 |
| stats | 222.5 -> 39.8 |
| graph | 139.3 -> 13.8 |
| skeleton.list | 131.3 -> 2.4 |
| workflow.list | 139.7 -> 24.4 |
| coach.status | 110.4 -> 2.3 |
| source.list | 127.4 -> 12.2 |
| inbox | 119 -> 4.2 |
| materials.links.list | 86.5 -> 89.3 (not changed: it lives next to the reader) |

| 10 minutes of poll (2.5 s) + a review click every 10 s | before | after |
| --- | --- | --- |
| heap first -> last (MB) | 103.3 -> 103.2 | 59.5 -> 59.7 |
| heap slope (MB/h) | -0.1 | 0.4 |
| RSS first -> last (MB) | 703.2 -> 353.5 | 138.6 -> 147.3 |
| heap snapshot: total / strings / strings over 100 KB | 105.4 / 84.7 MB / 158 holding 40.7 MB | 61.8 / 40.8 MB / 40 holding 7 MB |

RSS rose 8.7 MB in the 10 minutes while the heap and external memory stayed flat; that is most likely allocator behaviour rather than a leak, but a loop longer than 10 minutes was not run to settle it.

Panel, paired runs on the same machine in quick succession (real library, 1440 px, "all courses"):

| page | DOM nodes | long tasks / ms | JS heap MB |
| --- | --- | --- | --- |
| library | 284 -> 284 | 0 / 0 -> 0 / 0 | 31 -> 13.2 |
| sources (all groups expanded) | 6 155 -> 6 155 | 3 / 830 -> 2 / 438 | 39.5 -> 21.7 |
| generate | 2 667 -> 1 415 | 5 / 1 631 -> 5 / 809 | 38.7 -> 17.6 |
| wrongbook | 2 728 -> 2 728 | 4 / 663 -> 3 / 261 | 38.1 -> 20.2 |
| exam | 617 -> 617 | 2 / 372 -> 2 / 205 | 33.4 -> 15.5 |
| dashboard | 1 061 -> 1 061 | 2 / 201 -> 1 / 65 | 34.7 -> 16.9 |
| skeleton | 582 -> 582 | 2 / 151 -> 1 / 66 | 34.7 -> 16.9 |
| workflows | 371 -> 371 | 2 / 129 -> 0 / 0 | 35.1 -> 17.3 |
| settings | 994 -> 1 005 | 3 / 283 -> 1 / 105 | 36.4 -> 18.5 |

| | before | after |
| --- | --- | --- |
| first render (navigation to enabled sidebar) | 3 211 ms | 1 396 ms |
| first snapshot | 6.37 M characters, parse 26.4 ms | 1.77 M characters, parse 4.3 ms |
| JS heap after the first render | 30.1 MB | 12.2 MB |
| main thread per changed poll | 213 ms | 64 ms |
| long tasks while polling a changing library | 4 | 0 |
| JS heap at the end of the session | 55.8 MB | 17.7 MB |

On a seeded 600-source library the 8 combinations of zh/en, dark/light and 1440/420 px open every page of the sidebar with 0 console errors and 0 page errors; a reader check (open a pasted source in the reader, see the text; the generate page counts characters from `chars`) passes in 4 of them.

## Budgets (`tests/perf-budget.test.mjs`)

The DSH workspace has a separate first-load check in `tests/workspace-closure-pages.test.mjs`. Opening the workspace loads each of its static JavaScript dependencies once. At the November 26 baseline that closure was 3,861,788 esbuild bytes and 4,193,489 bytes of final DSH modules across 150 files. The final count includes the loader code added during packaging, before HTTP compression. The limits are 3,950,000 esbuild bytes, 4,300,000 final bytes and six sequential dependency waves. Optional page chunks enter the budget only when an import makes them part of the initial load. Run `node scripts/test.mjs tests/workspace-closure-pages.test.mjs` to print the bytes and waves for the current checkout.

Deterministic bounds on a seeded library (`scripts/qa/perf-seed.mjs`: 160 sources, 14 decks, 420 cards, 24 runs, 1 200 attempts), as ratios of the library's own size so they do not depend on the machine:

- a review click parses and copies <= 5% of the library, stringifies <= 10%, writes <= 2 shards;
- the snapshot after a click parses <= 10% and copies <= 35% of the library; building it again makes <= 1.5 `JSON.stringify` calls per card;
- an unchanged poll parses nothing and makes <= 8 `structuredClone` calls;
- the snapshot is <= 50% of the source text and <= 1 800 characters per source, ships no text outside case scenarios, and `source.get` returns the text;
- every page read copies <= 2x its answer plus 2% of the library;
- a write that copies a whole collection reads no shard file back;
- 300 click+poll cycles grow the heap <= 12 MB after a collection;
- course names are normalised once each; `yaml`, `pdf-lib` and `pdfjs-dist` are not imported statically anywhere in `lib/`;
- planning an unscoped daily round over 3 000 overdue cards (`planPath`, #881) builds the FSRS model once and evaluates `retrievabilityAt` once per due card (`<= 1.5` `Math.pow` calls per card).

The near-duplicate check of a draft (`draft.similar`, #890) has a budget of its own in `tests/draft-similar-890.test.mjs`: a 500-question draft against 3 000 published questions of its course (synthetic stems of 45 characters). Comparing every pair took 10.6 s; `similarStemPairs` (`lib/stem-similarity.js`) indexes each stem by its rarest bigrams (prefix filtering) and compares only the stems that share one, which took 67-72 ms on a Windows developer machine (up to 160 ms while other test runs shared it). The target is under 300 ms; the test's limit is 3 s, loose enough for a slow CI runner. The test also counts the exact comparisons (`stats.compared`): 50 of the 1.75 million pairs, so the index, not the machine, keeps it fast. A second fixture in the same file is the hard case: course-like English stems from five frames and 40 words of one subject, where almost every stem shares many bigrams with almost every other one. Prefix filtering alone compared 1.31 million of its 1.75 million pairs and took 1.0-1.2 s (1.1-1.6 s in the review of #909); a position filter (ppjoin: a shared prefix bigram at place p of one stem and q of the other leaves at most min(n - p, m - q) - 1 more) cut that to about 360 000 exact comparisons and 250-450 ms for the search alone, 300-600 ms for the whole `draft.similar` answer, and close to 1 s while other agents and test runs shared the machine. About 2 s while 81 test files ran in parallel. Its budget is under 1 s on an idle machine; the test's limit is 10 s, and its guard is the count of exact comparisons (under a third of the pairs). On top of that the draft page asks at most one question at a time per draft (plus one more for whatever changed meanwhile), not while a job is still changing the draft, and the backend reuses its last answer while the draft and the drafts, decks, sources and courses collections are the very same stored objects, so a running job does not make the search run again and again.

`tests/store-sharing.test.mjs`, `tests/runtime-view.test.mjs`, `tests/snapshot-share.test.mjs`, `tests/poll-schedule.test.mjs` and `tests/scroll-window-chunks.test.mjs` pin the mechanisms.

### CI stability rules for performance tests

CI runs the test suite in parallel (`--test-concurrency=4`) on shared 2-vCPU runners. A single-shot wall-clock `performance.now()` assertion is vulnerable to 3–15 ms OS scheduling preemptions and minor GC ticks that have nothing to do with production regressions. Every performance test in this repository follows four rules:

1. **Prefer deterministic work counters over timing.** Count exact work — `Probe` parse/stringify bytes, `structuredClone` calls, shard reads/writes, `Math.pow` calls, pair comparisons (`stats.compared`), cache-hit counts, or payload sizes (`tests/perf-budget.test.mjs`, `tests/perf-nfr-fast.test.mjs`). Deterministic bounds never flake under CI load.
2. **When timing is necessary, use `process.cpuUsage()` + warmup + multi-sample aggregation.** Never assert a single-shot `performance.now()` duration in parallel tests. Reuse `tests/helpers/perf-gate.mjs` (`assertCpuBudget`, `measureCpuBatched`) for root suites (and the matching helper in `packages/studyhub-tui/tests/` for TUI suites): warm up the JIT first, measure batched process CPU time (`(used.user + used.system) / 1000`), and assert the median across multiple batches (optionally paired with a relative scaling ratio or deterministic work counter). Sibling-worker preemption does not inflate `process.cpuUsage()`, and multi-sample aggregation filters out isolated GC ticks while still failing decisively on real algorithmic or cache regressions.
3. **Avoid real-clock boundary races and fixed-sleep coordination.** Snapshot/fingerprint tests that depend on minute or day buckets (`tests/pace-forecast.test.mjs`) must pin `Date` via `t.mock.timers.enable({ apis: ['Date'], now })` (explicitly testing both same-day minute rollovers and midnight transitions), and multi-step async workflows (`tests/coverage-run-exec.test.mjs`) must use deterministic `gate()` barriers and monotonic clock accounting (`workedMs` / `idleMs`) rather than `sleep(...)` races or arbitrary `-2ms` drift tolerances.
4. **Pair hardened timing gates with flake-reproduction tests.** Each hardened timing family carries a dedicated flake-repro test proving (a) the legacy wall-clock or race pattern flakes under injected jitter/boundary/lag, (b) the hardened gate stays green under that condition, and (c) a genuine regression still fails the gate.
5. **Isolate heavy TUI benchmarks in `[tier:bench]`.** Throughput and scale suites for `packages/studyhub-tui` (`packages/studyhub-tui/tests/perf-budget.test.mjs`, `packages/studyhub-tui/tests/scale-nfr.test.mjs`) run in the dedicated `[tier:bench]` tier at `concurrency=1`; lightweight timing guards that remain in `[tier:unit]` must follow rule 2.

## Long lists draw their rows in chunks (#900)

The sources page (each day group and the pinned group), the wrong book (each group) and a draft of more than 80 questions no longer draw every row when they open. A list draws its first chunk (120 rows; 80 questions for a draft, because a question is a fold with its whole editor inside) and one more chunk each time the end of what is drawn comes within a screen of the window (320 px: scrolling there, or focus moving into the last rows). It is the picker's helper (`windowRows`, `nearEnd` in `ui/components/ScrollWindow.jsx`) applied to a page that scrolls as a whole (`ChunkedRows`): no timer, rows are never removed, so the rows already drawn do not move when a chunk is appended. Folding a group away or changing the filter starts it from the first chunk again.

- What still covers every row: the counts in the headers, **Select current view** and **Archive selected**, the filters and the search, **Practise this group** and the batch buttons, publishing a draft. They read the data, not the drawn rows.
- What draws a row first: the material just imported, the anchors **Find a feature** looks for (`ui/tour/anchor.js` asks the lists before it looks), a question added to a draft, and **View details** on a draft (the details follow the last question, so every question is drawn before it scrolls). The jumps (the wrong book's group, the new import, **Find a feature**) scroll without animation via `scrollToAnchor` (`ui/tour/anchor.js`): a smooth scroll let the open groups it passed draw their next chunk and move the row it was going to (`tests/chunked-lists-browser.test.mjs` fails with the animation back), and when a jump lands within half a window below the end of an open list so that list appends a chunk and pushes the target down, `scrollToAnchor` re-checks after layout settles and scrolls instantly back onto the target (#930).
- Browser find-in-page cannot find a row that is not drawn yet; searching inside the app can.

`node scripts/qa/chunked-lists.mjs --rounds 5` builds the preview, writes the fixture (one day group of 1 001 materials and a 160-page book, 1 000 mistakes in two decks, a draft of 500 questions) and prints the DOM nodes of the first paint and the time from pressing the sidebar row (or the draft's row) to the first rows being on screen. Headless Chromium on the Windows development machine, five visits per page, two runs of each build; the times are the medians of a run, written run 1 / run 2 (they move by a few hundred milliseconds between runs, the node counts do not):

| list | DOM nodes, first paint | rows drawn | page switch, ms |
|---|---|---|---|
| sources, the day group open | 31 562 -> 4 080 | 1 005 -> 120 | 2 451 / 2 751 -> 42 / 393 |
| wrong book, the first group (500) opened | 10 461 -> 2 862 | 500 -> 120 | 686 / 741 -> 213 / 220 |
| draft, 500 questions | 23 833 -> 4 094 | 500 -> 80 | 573 / 592 -> 179 / 226 |

Not measured: a real library, a real DSH window, memory, and `scripts/qa/page-switch-perf.mjs` (the fixture above is the probe of these three lists). `tests/chunked-lists-browser.test.mjs` walks the same fixture and pins the behaviour; `tests/scroll-window-chunks.test.mjs` and `tests/anchor-reveal.test.mjs` pin the helpers.

## Switches and contracts

- `STUDY_STORE_PRIVATE=1` turns the shared parsed shards off: every transaction parses private copies, as in 2.4.0. `STUDY_STORE_FREEZE=1` still deep-freezes the whole cached state for tests.
- A collection or record that `Store.read()` returns, or that `storagePort.view()` hands a handler, is **frozen**: writing to it throws (inside a transaction: `A read-only state field was changed in <api>.<operation>`). `read()` on a context's state port is still a private, writable copy. Code that only looks should use `view()`.
- `references/library-schema.md` and the on-disk format are unchanged, and so are the snapshot's `fingerprint` semantics. The snapshot's `sources[]` carry `chars` and `excerpt` instead of `text` (the agents' compact snapshot already did); the reader fetches text through `materials.document.get`.
- Since #886 the fingerprint no longer moves with a running job's progress, usage, calls or output: only with its structure (`lib/job-structure.js`). A caller that polls the snapshot with `since` and shows job progress must also read `job.live.list` while a job is active, as the panel does (`ui/app/use-library-connection.js`); a job that is not active is in the fingerprint whole, as before. `job.live.list` is the panel's: the main chat is refused it (`lib/assistant-boundary.js`) and keeps `job.status`.

## Not done, and why

- Real DSH transport and the owner's machine: the host measured here is the preview host (same handler, same runtime, fake model); DSH's RPC serialisation and the owner's RAM were not measured.
- `materials.document.get` and `materials.links.list` (reader open, ~90 ms) still copy the sources and documents they read; they sit beside the reader and outline code being changed elsewhere.
- `mineru.local.status` took 8.6-10.3 s on this Windows machine when Settings opened (probing a local MinerU install). It is MinerU code being changed elsewhere and was only observed.
- `review.answer` still copies and rewrites every deck (a `decks: 'all'` hint): ~0.9 MB parsed, ~100 ms. A precise hint (the answered deck plus its prerequisite decks) would cut it; the click is already 1.7x faster and its snapshot 5.6x.
- Client bundle (`npm run build`: 3.45 MB in 27 files; `client.workspace` 1.0 MB, KaTeX 628 KB, the English dictionary 563 KB load at start): KaTeX and the dictionary are candidates for lazy loading but sit in the reader and i18n code. The preview's `dist/app.js` is 6.7 MB unminified.
- `content-visibility: auto` on source rows was first rejected (its paint containment would clip the row's "more" menu and the new-import glow) and is on since 2026-11-18: the glow is gone, and the containment is lifted while the pointer or the focus is in a row and while its menu is open (`ui/sources.css`, `source-doc--menu`). See "Page switches, 2026-11-18" below.
- A second hour-long growth run: the 10-minute loops show a flat heap, not a proof for a day.

## UI smoothness: how to measure it (2.5.5)

- `node scripts/qa/ui-motion.mjs --production` records frame times (requestAnimationFrame deltas), long tasks and the share of frames over 24 ms for the everyday interactions on a seeded heavy library (`--sources 300` by default): opening each page, going through a review (flip, next), opening the reader, scrolling the **Sources** list. With `--production` the harness builds the bundle it serves with React's production build (the development build validates every prop and is several times slower: never judge speed on it); the repository's `dist/` is left alone. Until 2026-11-18 the flag rebuilt `dist/` that way and then measured the harness's own development bundle, so numbers recorded with it before that date are development-build numbers.
- `node scripts/qa/ui-profile.mjs --page generate --production` is the companion: a CPU profile of a few visits to one page, printed as the functions with the most self time (says WHY, where ui-motion says WHICH). Its production bundle keeps its names (`--readable true`, the default here; `page-switch-perf.mjs` takes the same flag to name the code behind a forced layout).
- Headless Chromium has no GPU compositor, so absolute numbers are pessimistic and noisy (a few ms either way); compare before and after on the same machine.
- 2.5.5, production build, 300 materials, three visits per page: long tasks while opening Create deck 4 (259 ms) before and 1 (85 ms) after the page entrance became one animated block instead of a staggered layer per block; Sources 1 (59 ms) before, 0 after; review flip/next, reader open and list scroll showed no long tasks before or after.

### Page switches, 2026-11-18

`node scripts/qa/page-switch-perf.mjs --widths 1440 --rounds 3 --production true --sources 300 --trace true`, one run before and one after on the same machine (headless Chromium, 21 switches over 7 pages):

| | before | after |
|---|---|---|
| long tasks | 16, 1948 ms | 13, 996 ms |
| worst frame entering Sources | 208 ms | 125 ms |
| worst frame entering Create deck | 325 ms | 167 ms |
| script time | 2814 ms | 2221 ms |
| forced layout (trace) | 1270 ms | 340 ms |
| press to next frame, median | 15.7 ms | 12.0 ms |

What changed:

- Sources rows far from the window are not laid out (`content-visibility: auto`). One layout of the 38 drawn rows was 82-88 ms of the 136-150 ms task that opens the page; it is 12-16 ms now, and the rows on screen are styled in a second, shorter task.
- A segmented control measured its items after writing the thumb's size (four layouts per placement), and did so in every render. It reads first, and with a resize observer only a newly chosen item is placed during the commit.
- The sidebar highlight read `offsetTop` in a layout effect on every page change, and the number on Sources was counted in every render of the sidebar. The observer measures the highlight now, and the count is once per snapshot.

What this did not change: moving a forced layout out of an effect only helps where it removes a layout. A new page needs one layout whoever asks for it first, so after the first fix the same 80-120 ms showed up under the next reader (`use-narrow`, then the auto-height of the focus box). The long tasks that remain on these two pages are that one layout plus 40-58 ms of React rendering.

Not measured: a real DSH window, a real library, 420 px (the script's sidebar locator is stale at that width), and run-to-run spread (single runs; three earlier runs during the work agreed on the direction).

## Component overhaul and A/B verification (`v5.2.1` -> `feat/v521-component-overhaul`)

The `feat/v521-component-overhaul` branch layers backend, algorithm, storage and UI optimizations on top of the 2.4.0 foundation, alongside a `< 2 s` fast NFR gate that runs on every `npm run test:fast`.

### Architectural changes

| Area | Change |
| --- | --- |
| Citation locator (`lib/quote-locate.js`) | Bounded LRU cache (`INDEX_CACHE_MAX_ENTRIES = 800`, `INDEX_CACHE_MAX_CHARS = 8_000_000`) storing compact `Int32Array` / `Uint8Array` UTF-16 offset maps and a per-text approximate-match cache (up to 256 queries) so repeated snapshot rebuilds reuse normalized indices in O(1). |
| FSRS-6 hot loop (`lib/sm2.js`) | Adopted `ts-fsrs` in runtime `dependencies` and hoisted `computeDecayFactor` out of the `retrievabilityAt` hot loop so planning 3,000 overdue cards calls `Math.pow` once per card (`<= 1.1x`). |
| Sharded store (`lib/store.js`, `lib/atomic-json.js`) | Reuses unmodified items and whole collections in O(1) when they remain the exact deep-frozen shared reference (`itemRefs` / `wholeRefs`), and writes shards and manifests with `fsync` (`sync: true`) before atomic rename to prevent zero-filled corrupt shards on sudden power loss. |
| Large PDF reader (`materials.document.range`, `ui/document-preview/peek/paged-renderer.js`) | Primary pdf.js `PDFDataRangeTransport` streaming 64 KB aligned byte-range blocks with a 32-block (~2 MB) LRU cache, in-flight deduplication and worker-safe buffer copies, eliminating full-file loads and false slow-page timeouts on oversized referenced PDFs (`materials.document.pages` remains as fallback). |
| Workbench store & Sources rows (`ui/app/store.js`, `ui/Sources.jsx`) | Fine-grained per-`<App>` Zustand store (`useAppSelector` / `useAppSlice`) with synchronous `stageSlices` during render and `useLayoutEffect` `flushPending` (eliminating stale `data: null` boot renders without mid-render subscriber notifications). `DocumentRow` receives pre-derived `companionTarget` from its parent with zero `AppContext` subscription. |
| Board drag-and-drop (`ui/Board.jsx`) | Migrated to `@atlaskit/pragmatic-drag-and-drop`; caches each target card's vertical midpoint once on `dragEnter`, eliminating 60–120 Hz `getBoundingClientRect()` reflow loops during dragging. |
| WrongBook loading (`ui/WrongBook.jsx`) | Replaced serial chunk waterfalls and N+1 detail bursts with bounded-concurrency `fetchWrongBookPage` (concurrency 4) and a concurrency-limited, LRU-cached `wrongbook.detail` loader (cache limit 200). |
| Term marking (`ui/review/use-term-marking.js`, `ui/review/term-marking-dom.js`) | Collects active, seen-unknown and candidate term highlights in a single DOM `TreeWalker` scan instead of repeated full-subtree traversals. |
| Interaction sound assets (`ui/sound-effects.js`, `ui/sound-effects-assets.js`) | Moved ~40 KB of pre-baked studio MP3 base64 assets behind dynamic `import('./sound-effects-assets.js')` loaded on first playback, keeping startup bundles lean when sound is off. |
| Fast NFR gate (`tests/perf-nfr-fast.test.mjs`) | Kept outside `tests/slow-tests.json` so `npm run test:fast` runs it every time (`< 2 s`), pinning hoisted `computeDecayFactor`, `createLocator` LRU reuse and synchronous `useAppStore` boot staging. |

### Host A/B comparison (`perf-baseline.mjs --seed 600`)

Measured on the same machine (Node v22.22.3, win32) against the same synthetic library (`--seed 600`: 600 sources / 2.24 M chars / 30 decks / 1,200 cards / 2,500 attempts), comparing clean `v5.2.1` (`5d68932f`) against `feat/v521-component-overhaul` (`24a31763`):

| Metric | `v5.2.1` (`5d68932f`) | `feat/v521-component-overhaul` (`24a31763`) | Delta |
| --- | --- | --- | --- |
| Throughput (review actions with a poll each) | 1.9 / s | **2.5 / s** | **+31.6%** |
| `review.reveal: next snapshot` loop block | 281.5 ms | **245.5 ms** | **-12.8%** |
| `review.answer: next snapshot` loop block | 254.4 ms | **203.4 ms** | **-20.0%** |
| `review.move: next snapshot` loop block | 243.5 ms | **200.8 ms** | **-17.5%** |
| `card.flag: next snapshot` loop block | 227.3 ms | **194.1 ms** | **-14.6%** |
| `source.add (2 KB): next snapshot` loop block | 249.3 ms | **190.8 ms** | **-23.5%** |
| RSS after 200 review actions (post forced GC) | 241.2 MB | **197.6 MB** | **-43.6 MB (-18.1%)** |
| RSS after opening every page & deck (post forced GC) | 244.3 MB | **199.4 MB** | **-44.9 MB (-18.4%)** |

**Write-durability trade-off:** single disk-writing actions increased by ~19–36 ms (`review.reveal` 24.0 -> 43.4 ms, `review.answer` 64.1 -> 100.9 ms, `card.flag` 36.8 -> 63.0 ms). This is an explicit durability trade-off from adding `fsync` (`sync: true`) to `lib/store.js` commits so committed shards and manifests are flushed to disk before rename and cannot corrupt into zero-filled files on power loss. Net end-to-end review throughput still rose +31.6% because post-write snapshots and GC pressure dropped.

### Chromium production page-switch benchmark (`page-switch-perf.mjs`)

Run on `feat/v521-component-overhaul` (`24a31763`) with `node scripts/qa/page-switch-perf.mjs --widths 1440 --rounds 2 --sources 300 --production true` (headless Chromium, 7 pages, 3,401 frames):

- **Summary:** `pressP50 = 8.3 ms`, `pressWorst = 16.2 ms`, `janky = 0%`, `bigRestyles = 0`, `longTasks = 3 (198 ms)`, `pageErrors = 0`, `consoleErrors = 0`, `apiErrors = 0`.

| Target | `press -> frame` p50 | `press -> frame` worst |
| --- | --- | --- |
| `sources` | 10.1 ms | 11.6 ms |
| `generate` | 15.3 ms | 16.2 ms |
| `wrongbook` | 8.3 ms | 12.6 ms |
| `exam` | 8.3 ms | 12.2 ms |
| `dashboard` | 9.3 ms | 11.6 ms |
| `tasks` | 4.7 ms | 8.3 ms |
| `book` | 7.1 ms | 10.7 ms |
| `open+close 更多` | 3.1 ms | 4.2 ms |
