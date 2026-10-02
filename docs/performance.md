# Performance and memory

How StudyHub's host and panel are measured, what 2.4.0 cost on a large real library, what dominated it, what changed, and the budgets that keep it that way. Everything here is reproducible with the scripts below on any library; nothing needs a network, a key or the real DSH. (The earlier `performance-2026-09-16.md` covers the coach and follow-up latency; this page covers the host process and the panel.)

## Measure it

| What | Command |
| --- | --- |
| Host: payload, per-request work, memory stages, growth, heap summary | `node scripts/qa/perf-baseline.mjs --library <dir with study-workspace.json> [--minutes 10] [--heap]`. The library is copied first (`--in-place` measures it where it is); `--seed 600` builds a synthetic library instead. |
| Panel: first render, DOM nodes, JS heap, long tasks, polling cost | `npm run build`, then `node scripts/qa/perf-browser.mjs --seed 600 [--library <dir>] [--lang en --theme light --width 420]` |
| Regression budgets | `node --test tests/perf-budget.test.mjs` (part of `npm test`) |

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

Deterministic bounds on a seeded library (`scripts/qa/perf-seed.mjs`: 160 sources, 14 decks, 420 cards, 24 runs, 1 200 attempts), as ratios of the library's own size so they do not depend on the machine:

- a review click parses and copies <= 5% of the library, stringifies <= 10%, writes <= 2 shards;
- the snapshot after a click parses <= 10% and copies <= 35% of the library; building it again makes <= 1.5 `JSON.stringify` calls per card;
- an unchanged poll parses nothing and makes <= 8 `structuredClone` calls;
- the snapshot is <= 40% of the source text and <= 1 500 characters per source, ships no text outside case scenarios, and `source.get` returns the text;
- every page read copies <= 2x its answer plus 2% of the library;
- a write that copies a whole collection reads no shard file back;
- 300 click+poll cycles grow the heap <= 12 MB after a collection;
- course names are normalised once each; `yaml`, `pdf-lib` and `pdfjs-dist` are not imported statically anywhere in `lib/`.

`tests/store-sharing.test.mjs`, `tests/runtime-view.test.mjs`, `tests/snapshot-share.test.mjs`, `tests/poll-schedule.test.mjs` and `tests/scroll-window-chunks.test.mjs` pin the mechanisms.

## Switches and contracts

- `STUDY_STORE_PRIVATE=1` turns the shared parsed shards off: every transaction parses private copies, as in 2.4.0. `STUDY_STORE_FREEZE=1` still deep-freezes the whole cached state for tests.
- A collection or record that `Store.read()` returns, or that `storagePort.view()` hands a handler, is **frozen**: writing to it throws (inside a transaction: `A read-only state field was changed in <api>.<operation>`). `read()` on a context's state port is still a private, writable copy. Code that only looks should use `view()`.
- `references/library-schema.md` and the on-disk format are unchanged, and so are the snapshot's `fingerprint` semantics. The snapshot's `sources[]` carry `chars` and `excerpt` instead of `text` (the agents' compact snapshot already did); the reader fetches text through `materials.document.get`.

## Not done, and why

- Real DSH transport and the owner's machine: the host measured here is the preview host (same handler, same runtime, fake model); DSH's RPC serialisation and the owner's RAM were not measured.
- `materials.document.get` and `materials.links.list` (reader open, ~90 ms) still copy the sources and documents they read; they sit beside the reader and outline code being changed elsewhere.
- `mineru.local.status` took 8.6-10.3 s on this Windows machine when Settings opened (probing a local MinerU install). It is MinerU code being changed elsewhere and was only observed.
- `review.answer` still copies and rewrites every deck (a `decks: 'all'` hint): ~0.9 MB parsed, ~100 ms. A precise hint (the answered deck plus its prerequisite decks) would cut it; the click is already 1.7x faster and its snapshot 5.6x.
- Client bundle (`npm run build`: 3.45 MB in 27 files; `client.workspace` 1.0 MB, KaTeX 628 KB, the English dictionary 563 KB load at start): KaTeX and the dictionary are candidates for lazy loading but sit in the reader and i18n code. The preview's `dist/app.js` is 6.7 MB unminified.
- `content-visibility: auto` on source rows was rejected: its paint containment would clip the row's "more" menu and the new-import glow. The sources page with every group expanded is still 6 155 nodes.
- A second hour-long growth run: the 10-minute loops show a flat heap, not a proof for a day.
