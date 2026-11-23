# StudyHub TUI Test Timing & Redundancy Baseline (`tests/TIMING.md`)

> Measured on commit `92d80291` (Round 74, `feat/studyhub-tui`) on a 4-core Linux host (`nproc = 4`, Node.js `v24.22.3`).

## 1. Baseline Summary (Before Governance)

| Metric | Baseline Value |
| --- | ---: |
| Command | `npm run build && node --test --test-concurrency=2 tests/*.test.mjs` |
| Total wall time | **578.6 s** (9m 38.6s; build 0.53s + tests 578.1s) |
| Sum of per-suite durations | **947.8 s** (across 212 top-level suite blocks) |
| Test files (`tests/*.test.mjs`) | **153** (`125` PTY/xterm E2E + `28` unit/static/CLI) |
| Test suites (`node --test`) | **178** |
| Test cases (`node --test`) | **589** (`588` pass, `0` fail, `1` live-agy skipped) |
| Static assertions (`assert.*` / `assert(`) | **6,424** |
| Total test code lines | **84,728** |
| Files containing `@xterm/headless` | **125 / 153** (81.7%) |
| Files containing ASCII checks (`--ascii` / `assertAsciiPure`) | **121 / 153** (79.1%) |
| Files containing `setTimeout` / `sleep` | **130 / 153** (85.0%) |
| Files with `<= 2` tests (fragmented) | **52 / 153** (34.0%) |

## 2. Top 20 Slowest Suites (Baseline)

| Rank | File | Suite | Duration | Type | Tests | Asserts | Lines |
| ---: | --- | --- | ---: | --- | ---: | ---: | ---: |
| 1 | `xterm-e2e.test.mjs` | StudyHub TUI xterm-headless E2E | 25,196 ms | E2E | 8 | 27 | 788 |
| 2 | `empty-state-audit.test.mjs` | Empty-Library 16-View Onboarding & Bilingual Audit | 22,497 ms | E2E | 4 | 17 | 581 |
| 3 | `packaging-smoke.test.mjs` | Packaging, Out-of-Repo Bin Smoke & 64-Transition Resize Soak | 22,188 ms | E2E | 4 | 34 | 552 |
| 4 | `responsive-audit.test.mjs` | 4-Viewport Bilingual & ASCII Responsive Audit | 19,702 ms | E2E | 2 | 6 | 388 |
| 5 | `ascii-full-sweep.test.mjs` | Full 16-View `--ascii` Runtime Purity Sweep | 18,943 ms | E2E | 2 | 6 | 394 |
| 6 | `parity-e2e.test.mjs` | Round 7 Parity E2E & Memory Soak | 16,626 ms | E2E | 5 | 18 | 783 |
| 7 | `round15-e2e.test.mjs` | Round 15 Features & Regression E2E | 16,602 ms | E2E | 4 | 15 | 754 |
| 8 | `round43-coach-consent.test.mjs` | Round 43: Coach Background Prep Consent & Profile Reset | 15,540 ms | E2E | 2 | 63 | 729 |
| 9 | `round19-e2e.test.mjs` | Round 19 Features E2E | 14,841 ms | E2E | 3 | 20 | 811 |
| 10 | `deep-views-e2e.test.mjs` | Deep Interactive Core Views E2E | 13,831 ms | E2E | 4 | 11 | 687 |
| 11 | `round40-coach-goal.test.mjs` | Round 40: Coach Learning Goal, Feedback & Revert | 13,711 ms | E2E | 2 | 56 | 649 |
| 12 | `round11-e2e.test.mjs` | Round 11 Features E2E | 12,551 ms | E2E | 3 | 10 | 709 |
| 13 | `round22-e2e.test.mjs` | Round 22 Features E2E | 11,982 ms | E2E | 3 | 18 | 717 |
| 14 | `pr1297-p0.test.mjs` | PR #1297 P0 Regression Suite | 11,496 ms | E2E | 8 | 58 | 845 |
| 15 | `round17-e2e.test.mjs` | Round 17 E2E & Cross-Platform CLI Matrix | 10,220 ms | E2E | 3 | 38 | 618 |
| 16 | `round53-coach-bullets.test.mjs` | Round 53: CoachPreferencesModal Memory Bullets CRUD | 10,148 ms | E2E | 2 | 43 | 584 |
| 17 | `round20-e2e.test.mjs` | Round 20/21 Features E2E | 10,111 ms | E2E | 2 | 28 | 716 |
| 18 | `round62-study-artifact.test.mjs` | Round 62: GuidedStudyModal Save Teaching Artifact | 10,103 ms | E2E | 3 | 62 | 649 |
| 19 | `round66-wrongbook-export.test.mjs` | Round 66: WrongBookView `[X]` Markdown Export | 10,082 ms | E2E | 3 | 59 | 596 |
| 20 | `round74-cli-search.test.mjs` | Round 74: CLI `--search` Headless Fast-Path | 9,957 ms | CLI | 5 | 61 | 276 |

## 3. Root Causes Identified

1. **Process & module cold-start tax (153 files)**: `node --test` spawns one Node.js worker per file. 125 E2E files each independently boot Node + React + Ink + `@xterm/headless` and scan/import every `dist/chunk-*.mjs` file just to locate `createTuiHost`/`displayWidth`.
2. **Duplicated generic checks across 121 files**: Almost every `round36..round74` file mounts a second full `80x24 --ascii` PTY session solely to re-verify `assertAsciiPure` and `assertHealthyScreen`, duplicating the authoritative `ascii-full-sweep` + `responsive-audit` suites.
3. **Fixed `sleep()` polling loops (130 files)**: Copy-pasted `createVirtualTty` helpers sleep `20ms + 25ms = 45ms` on every `waitFor()` tick plus `60–180ms` fixed delays between inputs, adding both latency and timing flakiness under parallel load.
4. **Unpooled `@xterm/headless` instances**: Every test case allocates a fresh `new Terminal(...)` instead of resetting and resizing a pooled instance.
5. **Flat concurrency (`--test-concurrency=2`)**: Fast unit/static suites are throttled behind 2-way E2E concurrency on a 4-core CPU.
6. **Uncached rebuilds**: Every `npm test` wipes `dist/` and re-runs esbuild even when `src/` is unchanged.

## 4. Optimization Results (After Governance)

### Before vs. After Comparison

| Metric | Before (Baseline `92d80291`) | After (Governed) | Delta |
| --- | ---: | ---: | ---: |
| **Total wall time (`npm test`)** | **578.6 s** (9m 38.6s) | **284.4 s** (4m 44.4s) | **-50.8%** (`-294.2 s`) |
| Build step (`dist/` cache hit) | 530 ms (always rebuilds) | **140 ms** (SHA-256 skip) | **-73.6%** |
| Sum of per-suite durations | 947.8 s | **529.9 s** | **-44.1%** (`-417.9 s`) |
| **Test files (`tests/*.test.mjs`)** | **153** (`28` unit + `125` E2E) | **40** (`9` unit + `2` bench + `29` E2E) | **-73.9%** (`<= 60` target met) |
| Test suites (`node --test`) | 178 | **149** (`44` unit + `6` bench + `99` E2E) | -16.3% |
| Passing tests / Failures / Flakes | 588 pass / 0 fail / intermittent CPU-jitter flakes | **537 pass / 0 fail / 0 flakes** (`1` live-agy skipped) | **0 flakes** |
| **Static assertions (`assert.*` / `assert(`)** | **6,424** | **6,590** | **+166 (+2.6%)** |
| Total test code lines | 84,728 | **49,513** | **-41.6%** (`-35,215` lines) |
| Files with `@xterm/headless` | 125 / 153 (81.7%) | **29 / 40** (72.5%, pooled Terminal) | -96 files |
| Files with `--ascii` / `assertAsciiPure` | 121 / 153 (79.1%) | **20 / 40** (converged to authoritative suites) | -101 files |
| Files with `setTimeout` / `sleep` | 130 / 153 (85.0%) | **16 / 40** (only explicit teardown/retry waits) | -114 files |

### Tiered Execution Breakdown (4-Core Host)

- **Build cache** (`scripts/build.mjs`): SHA-256 over `src/**`, `package.json`, `scripts/build.mjs` -> `dist/.build-hash` (cache hit in `140 ms`, synced with `.github/workflows/verify.yml` `actions/cache@v4`).
- **`[tier:unit]`** (`9` files, `concurrency = min(nproc, 8) = 4`, LPT-ordered): `200/200` pass (`1` live-agy skipped) in **20.68 s**.
- **`[tier:bench]`** (`2` files: `perf-budget.test.mjs`, `scale-nfr.test.mjs`, isolated `concurrency = 1`): `23/23` pass in **4.20 s** (eliminates parallel CPU jitter flakes permanently).
- **`[tier:e2e]`** (`29` files, `concurrency = 2`, LPT-ordered): `314/314` pass in **259.36 s**.

### Top 20 Slowest Suites (After Governance)

| Rank | Suite | Duration |
| ---: | --- | ---: |
| 1 | StudyHub TUI Core Views E2E, Deep Interactions & Memory Soak | 23,004 ms |
| 2 | StudyHub TUI Packaging, Out-of-Repo Bin Smoke & 64-Transition Resize Soak | 19,368 ms |
| 3 | StudyHub TUI xterm-headless E2E | 18,501 ms |
| 4 | CLI fast-path subprocess suite (`--doctor` / `--stats` / `--search` / `--export`) | 18,116 ms |
| 5 | Domain Sources Operations: Pins, Reread, Links, Batch, Original File & Export | 17,877 ms |
| 6 | Domain Settings & Workspace: Hygiene, Host Integration & PTY E2E | 17,044 ms |
| 7 | StudyHub TUI 4-Viewport Bilingual & ASCII Responsive Audit | 15,480 ms |
| 8 | StudyHub TUI Full 16-View `--ascii` Runtime Purity Sweep | 13,280 ms |
| 9 | PR #1297 P0, P1 & P2 regression suite | 13,036 ms |
| 10 | Domain Tasks & Audio: AudioView, TasksView Jobs Control/Recovery/Parallel/Filter/Export & WorkflowContext | 12,562 ms |
| 11 | Domain Shell Overlays: CommandPalette, HelpOverlay, SelectList & InboxModal | 10,990 ms |
| 12 | Domain Settings Retrieval: Coverage, Diagnostics Planner & Hybrid Preview/Mirror | 10,232 ms |
| 13 | Domain Notes & Board: NotesView PTY E2E (zh & --ascii en) | 10,185 ms |
| 14 | Round 40: Coach Learning Goal, Card Quality Feedback & Coach Revert | 9,522 ms |
| 15 | Round 43: Coach Background Prep Consent & Learner Profile Reset | 9,182 ms |
| 16 | Domain Generate & Drafts: Suggest, Weak Topics, Path Planner, Source Filter & Draft UX/Preflight | 8,904 ms |
| 17 | Round 8: Board Pomodoro, Backup Export & Feynman Retell | 8,191 ms |
| 18 | Reader Domain Suite 3: DocumentReader Progress, Drawers & Persistent Page Resume E2E | 8,164 ms |
| 19 | Round 15: CoachPreferencesModal, BookQaModal & NotesView Save-Keeps-Selection Regression | 7,974 ms |
| 20 | StudyHub TUI Empty-Library 16-View Onboarding & Bilingual Audit | 7,638 ms |

### What Redundant Checks Were Removed & Why It Is Safe

1. **Duplicate per-round `80x24 --ascii en` second `StudyHubTuiApp` PTY boots**: Removed across `round36..round74` feature suites when the second boot only re-ran `assertAsciiPure`/`assertHealthyScreen` on the same workflow. Every unique functional assertion (narrow viewport layout via in-place `tty.resize(80, 24)`, ASCII formatter output, English labels/empty states, `modelCalls === 0` P2 guards) was folded into the primary PTY test or unit tests (net assertions increased `6,424 -> 6,590`). Authoritative coverage lives in `ascii-full-sweep.test.mjs` (all 16 views × 2 viewports × 2 locales + modal static audit) and `responsive-audit.test.mjs` (all 16 views × 4 viewports + empty-library onboarding).
2. **Duplicate 32-transition memory soak in `core-views-e2e.test.mjs`**: Trimmed from 4×8=32 transitions to 1×8=8 transitions + teardown leak check because `packaging-smoke.test.mjs` already runs the stricter 64-transition × 4-viewport resize-storm memory soak (`heap delta < 40 MB`, 0 leaked handles).
3. **Brittle implementation-detail assertions in `perf-budget.test.mjs`**: Replaced hardcoded esbuild internal comment regexes (`// src/...`), `chunk-*.mjs` filename assumptions, and a static 55-entry chunk prefix table with behavioral static-closure & dynamic chunk discovery assertions (`zod`/`marked`/`cli-highlight` exclusion, barrel-bypass, lazy overlay splits, and entry-size budgets).
4. **Copy-pasted `createVirtualTty` / `chunk-*.mjs` scan / `sleep(20)+sleep(25)` loops & repeated `sample.load` calls**: Replaced across all 29 E2E suites by `tests/helpers/virtual-tty.mjs` (pooled reusable `@xterm/headless` terminals, event-driven `waitFor` waking immediately on `term.write` commit callbacks, direct `dist/App.mjs` + `dist/host.mjs` loading, and `cloneSampleLibrary` ~3ms `fs.cp` cloning of per-worker seeded templates).

