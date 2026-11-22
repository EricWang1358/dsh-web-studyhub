# StudyHub TUI Roadmap — Rounds 21–40

> Baseline at Round 21 (`b9965932`, PR #1297 `feat/studyhub-tui-r20` → `main`):
> - **16 views** live (`Library`, `Review`, `Sources`, `Generate`, `WrongBook`, `Exam`, `Dashboard`, `Book`, `Skeleton`, `ExamCoach`, `ExamPrep`, `Notes`, `Board`, `Tasks`, `Audio`, `Settings`) + global `AppShell` (`CommandPalette`, `Inbox`, `HelpOverlay`, `CoursePicker`, `Launchpad`).
> - **Dual-model engine**: `agy` CLI primary (auto-probed, streaming) + 8 OpenAI-compatible presets secondary (env-key memory overlay).
> - **NFR baseline**: Cold CLI spawn `56ms` (≤350ms), `ShellBootFrame` `514ms`, interactive ready `1172–1537ms`, RSS `189.5 MB`, V8 heap `72.5 MB`, `dist/App.mjs` `58.8 KB`.
> - **Quality baseline**: `169/169` TUI tests, `34/34` live `agy` tests, `297/297` upstream `test:core`, `0` root ESLint errors, `0` `tsc` errors.

---

## Wave A: Power-User Parity & Interactive Workflows (Rounds 21–25)

### Round 21 — Case/Oral Exam Ergonomics, Skeleton Lint & Notes Linked-Ref Jump *(Completed: `b9965932`)*
- **Goal**: Upgrade Case & Oral exam experience (`ScrollView` scenario pane, `[s]` narrow toggle, `[H]` `review.highlights`, rich criteria breakdown & prior-attempt comparison), add `[L]` `skeleton.lint` + diagram count badge in `SkeletonView`, and `[o]` linked-card/source direct jump in `NotesView`.
- **Acceptance Criteria**:
  - `ExamRunner` renders side-by-side scenario at `≥104` cols and `[s]` toggle at `<104` cols; `[H]` persists via `review.highlights`.
  - `ExamReportView` renders Case criteria bars, Oral band distribution, and prior-attempt deltas with 100% `--ascii` purity.
  - `SkeletonView` `[L]` runs `skeleton.lint`; `NotesView` `[o]` jumps to `ReviewView` or `DocumentReader`.
  - `tests/round20-e2e.test.mjs` covers `RoundSummary` `review.lookBack` + `[w]` retry and `CommandPalette` slash sweep (`169/169` pass).
- **Affected Files**: `src/views/exam/{ExamRunner,ExamReportView,ExamSetup,ExamView,types,utils}.ts(x)`, `src/views/skeleton/SkeletonView.tsx`, `src/views/notes/NotesView.tsx`, `tests/round20-e2e.test.mjs`.
- **Risks**: Keybinding collision between `l` (expand tree) and `L` (lint) or `s` (scenario toggle) vs text inputs → mitigated via uppercase claiming gated by `!modalOpen && !typing`.

### Round 22 — MinerU Long/Scanned PDF Planner & Live Review Queue Editor *(In Progress)*
- **Goal**: Bring scanned/long PDF conversion (`mineru.plan` / `mineru.import` / `mineru.retry` / `mineru.history.list`) into `SourcesView` (`[M]`), add non-restarting live review queue editing (`review.queue.edit`) in `ReviewView` (`[Q]`), and lock Round 21 with E2E + `HelpOverlay` sync.
- **Acceptance Criteria**:
  - `MinerUModal` (`[M]`) plans local PDFs with Tab path completion, lists conversion history, retries failed jobs, and handles missing MinerU cleanly.
  - `QueueModal` (`[Q]`) displays answered/current/upcoming cards with compare-and-set `queueVersion`, removes upcoming cards (`[d]`), and inserts searched cards at `next`/`end` (`[a]`).
  - `tests/round21-e2e.test.mjs` verifies Case Exam scenario/highlight, Skeleton `[L]`, and Notes `[o]` direct jump; full gate green.
- **Affected Files**: `src/views/sources/{MinerUModal,SourcesView,index}.ts(x)`, `src/views/review/{QueueModal,ReviewView,index}.ts(x)`, `src/shell/HelpOverlay.tsx`, `tests/{round21-e2e,ergonomics}.test.mjs`.
- **Risks**: Stale `queueVersion` conflicts during concurrent edits → refresh `review.get` on open and retry/surface conflict toast cleanly.

### Round 23 — Interactive Course Book Inline Editing, Diff/Revert & Suggestions + Round 22 E2E
- **Goal**: Add terminal editing for Review Book sections (`course.book.save` with compare-and-set `version`, `course.book.suggestion` accept/ignore, `course.book.revert`), plus E2E suite for Round 22 (`MinerUModal`, `QueueModal`).
- **Acceptance Criteria**:
  - `BookEditModal` (`[e]` in `BookView`) edits the active `bk:` section markdown, persists with `version`, supports `[u]` `course.book.revert`, and accepts/ignores pending outline suggestions.
  - `tests/round22-e2e.test.mjs` verifies `MinerUModal` (`[M]`) and `QueueModal` (`[Q]` add/remove upcoming card + `--ascii` purity).
- **Affected Files**: `src/views/book/{BookEditModal,BookView,index}.ts(x)`, `tests/round22-e2e.test.mjs`, `src/shell/HelpOverlay.tsx`.
- **Risks**: Version conflict errors when background book rebuild finishes mid-edit → display clear reload prompt without silently overwriting user edits.

### Round 24 — Companion Interactive Builder, Feedback Sync & Catch-Up Cards
- **Goal**: Upgrade `CompanionsModal` in `SourcesView` from read/ask/open to full lifecycle parity: `generation.companion.build` (4-stage interactive lesson builder), `companion.compile`, `companion.sync` (disk reload), `companion.catchup.save`, and `companion.feedback.sync`.
- **Acceptance Criteria**:
  - Users can launch a new Companion build job for a selected source, trigger disk sync/recompile, inspect catch-up cards, and view build job progress cleanly in `TasksView`.
  - 100% `--ascii` pure and responsive at `80x24` / `120x36` / `160x44`.
- **Affected Files**: `src/views/sources/CompanionsModal.tsx`, `src/views/sources/SourcesView.tsx`, `tests/round23-e2e.test.mjs`.
- **Risks**: HTML companion payloads can be large → project only structured metadata/catch-up summaries in terminal and never dump raw HTML into React state.

### Round 25 — Course Custom Plan Interactive Builder & Save (`course.custom.*` + `course.save`)
- **Goal**: Upgrade `StudyPlanModal` (`ExamPrepView`) so learners can interactively configure and save a custom study plan (`purpose: preview|follow|review|openbook`, `scope: all|exam|chapters`, `book.parts`, `questions.kinds/strength`, `minutesPerDay`), preview rough token/call estimates (`course.custom.preview`), save (`course.save { custom }`), and apply (`course.custom.apply`).
- **Acceptance Criteria**:
  - Full interactive wizard inside `StudyPlanModal` Tab 2/3 enforcing upstream part dependencies (`terms` → `explain`, etc.), showing rough token/call estimates before confirmation, and persisting cleanly.
  - Dedicated E2E coverage for custom plan preview → save → readiness readout.
- **Affected Files**: `src/views/examprep/{StudyPlanModal,CustomPlanWizard,ExamPrepView}.tsx`, `tests/round24-e2e.test.mjs`.
- **Risks**: `course.save` replaces the whole `plan`/`custom` object → always read `course.get` first and preserve untouched `exam`/`focusTopics`/`guidanceSourceIds`.

---

## Wave B: Terminal UX Mastery & Workflow Speed (Rounds 26–30)

### Round 26 — Deck Merge Suggestions, Batch Card Operations & WrongBook Bulk Triage
- **Goal**: Add AI-free/assisted `deck.merge.suggest` in `DeckOpsModal` Tab 2, multi-select batch card actions (`card.update.batch`, `card.focus`, `card.suspend`) in `DeckManageModal`, and batch wrong-reason tagging in `WrongBookView`.
- **Acceptance Criteria**:
  - `DeckOpsModal` displays suggested merge candidates when available.
  - `DeckManageModal` supports `[Space]` multi-select + batch focus/suspend/move without losing cursor position.
  - `WrongBookView` supports quick-tag cycling + batch practice scope launch.
- **Affected Files**: `src/views/library/{DeckOpsModal,DeckManageModal}.tsx`, `src/views/wrongbook/WrongBookView.tsx`, `tests/round25-e2e.test.mjs`.
- **Risks**: Batch mutations touching >100 cards hit upstream limit → enforce explicit chunking or cap at 100 with visible selection counter.

### Round 27 — Command Palette v3: Action History, Course Scoping & Jump-to-Card/Note Deep Actions
- **Goal**: Upgrade `CommandPalette` (`Ctrl+K`) with scoped search prefixes (`#` cards, `@` courses, `>` commands, `:` pages, `?` passages), persistent command frecency across restarts (`tui.json`), and instant inline preview hint of the highlighted search hit.
- **Acceptance Criteria**:
  - Prefix filters narrow live queries immediately (`#Memento`, `?Bridge`, `/theme`).
  - Recent/frecency order persists atomically via `saveTuiPreferences`.
  - Latency of synchronous fuzzy filter over 1,000+ entities remains `<10ms` (unit benchmarked).
- **Affected Files**: `src/shell/{CommandPalette,fuzzy}.ts(x)`, `src/host/tui-prefs.ts`, `tests/round26-e2e.test.mjs`.
- **Risks**: Writing `tui.json` on every palette invocation could cause disk churn → debounce/serialize via existing atomic queue in `tui-prefs.ts`.

### Round 28 — Review Mode Power Ergonomics: Round Configurator, Cloze Multi-Blank UX & Undo Polish
- **Goal**: Add pre-round quick configurator modal (`[R]` in `LibraryView`: round size `5–50`, `only: due|new|wrong`, `focusOnly` toggle), polish multi-blank `cloze` Tab/Shift+Tab navigation and per-blank diff feedback in `ReviewView`, and add `[u]` quick undo (`review.undo`) verification.
- **Acceptance Criteria**:
  - Starting custom rounds (`size`, `only`, `focusOnly`) works cleanly from `LibraryView`.
  - Multi-blank cloze cards highlight exact per-blank match/mismatch in Unicode and `--ascii` modes.
  - `[u]` undo restores previous card state cleanly in E2E.
- **Affected Files**: `src/views/library/{RoundConfigModal,LibraryView}.tsx`, `src/views/review/{ReviewView,review-helpers}.ts(x)`, `tests/round27-e2e.test.mjs`.
- **Risks**: `review.undo` availability depends on active run state → guard clearly when at card 0 or exam mode.

### Round 29 — Skeleton Graph Editing (`skeleton.patch` / `topic.groups.save`) & Course Route Viewer
- **Goal**: Enable lightweight terminal editing of course skeletons (`skeleton.patch`, `topic.groups.save` for organizing topic groups) and add a `course.route` chapter roadmap sub-view inside `SkeletonView`.
- **Acceptance Criteria**:
  - Users can inspect exact `course.route` chapters and rename/re-group skeleton topics safely with confirm/undo feedback.
  - Full E2E + `--ascii` purity verification.
- **Affected Files**: `src/views/skeleton/{SkeletonView,TopicGroupsModal}.tsx`, `tests/round28-e2e.test.mjs`.
- **Risks**: Corrupted skeleton patch could fail upstream schema validation → run `skeleton.lint` preview before saving and surface exact validation messages.

### Round 30 — Milestone Audit #2: UX Polish, Mouse-Free Accessibility & Complete Keymap Audit
- **Goal**: Comprehensive audit of EVERY keybinding across all 16 views + 30+ modals to eliminate any hidden conflict with global shell shortcuts (`1-9, 0, n, b, t, a, r, c, ,, I, ?, /, \, [, ]`), verify every `Modal` respects `5`-row chrome + `TextInput` `-4` prompt padding + `loading` initial-state race immunity, and run full live `agy` + upstream `test:core` + `npm run lint`.
- **Acceptance Criteria**:
  - Automated static + runtime keymap conflict test (`tests/keymap-audit.test.mjs`) passes with 0 conflicts.
  - All modals pass `80x24`, `100x30`, `120x36`, `160x44` + `--ascii` + `en`/`zh` checks.
  - Full repo lint + `test:core` + live `agy` green.
- **Affected Files**: `tests/keymap-audit.test.mjs`, `src/shell/HelpOverlay.tsx`, `packages/studyhub-tui/README.md`, surgical fixes across any audited view/modal.
- **Risks**: Broad touch across views → keep fixes minimal and test every touched view immediately.

---

## Wave C: Deep Performance, Memory & Large-Library Scale NFR (Rounds 31–35)

### Round 31 — Large-Library Stress Benchmark (5,000 Cards / 500 Sources / 200 Notes)
- **Goal**: Build a synthetic large-library stress suite (`tests/scale-nfr.test.mjs` & `scripts/bench-scale.mjs`) to measure and optimize snapshot ingest, `LibraryView` / `SourcesView` / `WrongBookView` / `CommandPalette` filtering, and RSS/heap under 5,000-card libraries.
- **Acceptance Criteria**:
  - `CommandPalette` fuzzy search over 5,000 items < `25ms`.
  - Switching across all 16 views on a 5,000-card library maintains RSS `< 300 MB` and 0 dropped frames/timeouts.
  - Identify and eliminate any $O(N^2)$ grouping/sorting loops in `SourcesView`, `LibraryView`, or `WrongBookView`.
- **Affected Files**: `tests/scale-nfr.test.mjs`, `src/shell/fuzzy.ts`, `src/views/sources/sources-helpers.ts`, `src/views/library/LibraryView.tsx`, `src/views/wrongbook/WrongBookView.tsx`.
- **Risks**: Large synthetic fixture generation slows default `npm test` → keep fixture creation fast (<500ms in-memory/tempdir) or bound default run while keeping heavy mode via `STUDYHUB_TUI_SCALE=1`.

### Round 32 — Host Cold-Start & `syncFromHost` Fingerprint Optimization
- **Goal**: Profile `createTuiHost` (`interactiveReadyMs` ~1170ms) and `syncFromHost` `JSON.stringify` cost on large snapshots; replace full-snapshot `JSON.stringify` diffing with an $O(1)$/`O(K)` structural fingerprint (revision/updatedAt/counts/hash) and lazy-defer non-critical host initialization so interactive ready drops below `< 950ms`.
- **Acceptance Criteria**:
  - `syncFromHost` dedup cost on 5,000-card snapshot drops from `~15ms` to `< 1ms` with zero missed updates (verified by unit tests).
  - Measurable improvement in `interactiveReadyMs` / steady-state CPU in `npm run bench`.
- **Affected Files**: `src/App.tsx`, `src/state/snapshot-fingerprint.ts`, `src/host/create-tui-host.ts`, `scripts/bench.mjs`, `tests/perf-budget.test.mjs`.
- **Risks**: Weak fingerprint missing an in-place mutation (e.g., card focus toggle or title rename) → hash key mutable fields + revision counter and add targeted mutation tests.

### Round 33 — Streaming AI Render Smoothness & Token Coalescing (60fps Frame Pacing)
- **Goal**: Add `16–32ms` chunk coalescing buffer in streaming AI surfaces (`AiHelpDrawer`, `DocumentReader` Page Ask & Translate, `TeachModal`, `RetellModal`) so high-throughput token streams (100+ chunks/sec from local `agy` or Groq) never saturate Ink's ANSI reconciler or flicker on narrow/SSH terminals.
- **Acceptance Criteria**:
  - Export reusable `useStreamingBuffer` hook with deterministic unit tests proving coalescing, immediate flush on stream end/abort, and zero leaked timers.
  - Lower render count by >60% during simulated 200-chunk bursts.
- **Affected Files**: `src/components/useStreamingBuffer.ts`, `src/views/review/AiHelpDrawer.tsx`, `src/views/sources/DocumentReader.tsx`, `tests/streaming-buffer.test.mjs`.
- **Risks**: Delayed final chunk after stream completion → always flush synchronously on `finally` / `complete`.

### Round 34 — Memory Leak & Long-Session Soak Hardening (100-Transition + Resize Storm)
- **Goal**: Extend memory soak testing to a 100-transition view/modal/theme/resize storm (`80x24 ↔ 160x44 ↔ 100x30`), verify all `LruCache` bounds (`math`, `markdown`, `translate`), verify zero orphaned `AbortController`s, `setTimeout`/`setInterval` timers, or `fs.watch` handles on exit/unmount.
- **Acceptance Criteria**:
  - 100-transition soak test passes with heap growth `< 40 MB` and `process._getActiveHandles()` delta `=== 0` after `dispose()`.
  - Fix any retained closures or unbounded caches discovered.
- **Affected Files**: `tests/soak-nfr.test.mjs`, `src/render/lru.ts`, `src/host/create-tui-host.ts`, any view with leaked listener/timer.
- **Risks**: Node test runner GC timing variance → run explicit cleanup + bounded delta assertions (never brittle exact byte checks).

### Round 35 — Pure `NO_COLOR` / 16-Color / High-Contrast Terminal Fidelity
- **Goal**: Wire `resolveColorCapability` (from Round 13) end-to-end into Chalk & Theme rendering so `NO_COLOR=1` emits **zero** ANSI color codes (relying on bold/underline/reverse/ASCII markers for crisp hierarchy), 16-color terminals map cleanly without muddy approximations, and all 4 themes pass both truecolor and `NO_COLOR` readability audits.
- **Acceptance Criteria**:
  - `NO_COLOR=1` render audit verifies zero SGR foreground/background color escapes while preserving selection highlight (via `inverse` or `> ` marker) and clean borders.
  - Updated `tests/theme-contrast.test.mjs` + `tests/cli-args.test.mjs`.
- **Affected Files**: `src/theme/tokens.ts`, `src/render/markdown.ts`, `src/shell/HelpOverlay.tsx`, `src/cli.tsx`, `tests/theme-contrast.test.mjs`.
- **Risks**: Chalk instance created at module top-level before CLI flags parsed → centralize color level resolution cleanly.

---

## Wave D: Cross-Platform Polish, Reliability & Production Release Readiness (Rounds 36–40)

### Round 36 — Windows PowerShell / ConPTY / WSL2 Deep Hardening
- **Goal**: Audit and harden every Windows & WSL2 edge case: UNC paths (`\\server\share`), drive-letter root completion (`C:\`), PowerShell 5.1 UTF-8 codepage warnings, `ctrl+backspace` / `alt+backspace` word deletion differences between bash & Windows Terminal, and `clipboard` / `app.open` safe cross-platform fallbacks (`start ""` / `xdg-open` / `open` disabled in headless/SSH).
- **Acceptance Criteria**:
  - Expanded `tests/cross-platform.test.mjs` covering UNC paths, drive roots, WSL path normalization, Windows key sequences, and SSH headless detection (`SSH_TTY` / `SSH_CONNECTION`).
  - Zero shell injection surfaces (`execFile` only, never `sh -c` or `cmd /c`).
- **Affected Files**: `src/host/path-utils.ts`, `src/host/fs-complete.ts`, `src/components/TextInput.tsx`, `src/terminal.ts`, `tests/cross-platform.test.mjs`.
- **Risks**: Testing `win32` logic on Linux host → keep all platform-specific branches parameterized via injectable `platform` / `env` helpers.

### Round 37 — Offline / Degraded / Corrupt-Data Resilience & Crash Recovery
- **Goal**: Stress-test every failure mode: corrupt `tui.json`, corrupt `tui-board.json`, read-only library folder, missing/revoked API key, offline OpenAI endpoint (timeout / 429 / 500 / malformed SSE), crashed `agy` subprocess, and invalid JSON deck import; ensure every failure shows an actionable bilingual recovery hint and never crashes the TUI or strands the terminal in alt-screen.
- **Acceptance Criteria**:
  - Dedicated `tests/resilience.test.mjs` verifying all 8+ failure modes recover gracefully with clean UI state and intact terminal restoration.
  - `ViewErrorBoundary` supports copyable diagnostic summary + `[r]` retry / `[1]` Library recovery.
- **Affected Files**: `src/App.tsx`, `src/host/openai-stream.ts`, `src/host/tui-prefs.ts`, `src/views/board/board-store.ts`, `tests/resilience.test.mjs`.
- **Risks**: Unhandled promise rejections on aborted SSE streams → verify `AbortError` is swallowed cleanly everywhere.

### Round 38 — Onboarding Tour, Empty-State Polish & Bilingual Copy Consistency Audit
- **Goal**: Audit every empty state and first-run flow across all 16 views (fresh empty library WITHOUT sample course, and WITH sample course) in both `zh` and `en`: ensure clear next-step CTAs (`[i]` Import, `[s]` Load Sample, `[,]` Configure Model), eliminate any remaining mixed-language labels or awkward truncations, and polish `Launchpad` + model readiness indicator.
- **Acceptance Criteria**:
  - Empty-library sweep test in both `zh` and `en` (`80x24` & `120x36`) verifies all 16 views render helpful, non-broken empty states with zero errors.
  - Zero mixed-language leakage in English mode across all primary views.
- **Affected Files**: `src/shell/Launchpad.tsx`, `tests/empty-state-audit.test.mjs`, targeted copy/CTA fixes in views.
- **Risks**: Overly strict regex for Chinese characters failing on sample course content → run empty-library `en` audit without Chinese sample data.

### Round 39 — Packaging, Bin Entrypoint, Man/Help Docs & Installation Smoke Test
- **Goal**: Verify `packages/studyhub-tui/package.json` `exports`, `bin`, `files`, `engines`, standalone `npm pack --dry-run`, `npx`/global bin execution from arbitrary working directories (not just repo root!), and write a concise `docs/ARCHITECTURE.md` + `docs/KEYBINDINGS.md` reference for contributors and users.
- **Acceptance Criteria**:
  - Running `bin/studyhub-tui.mjs` from `/tmp` (outside the git repo) resolves `dist/` and desktop host cleanly and passes smoke tests.
  - `npm pack --dry-run` contains zero stray scratch/test/cache files.
  - Complete, accurate `README.md` + `docs/KEYBINDINGS.md`.
- **Affected Files**: `packages/studyhub-tui/package.json`, `packages/studyhub-tui/bin/studyhub-tui.mjs`, `packages/studyhub-tui/README.md`, `packages/studyhub-tui/docs/KEYBINDINGS.md`, `tests/packaging-smoke.test.mjs`.
- **Risks**: Path resolution to `packages/studyhub-desktop` when invoked from outside repo → verify `import.meta.url`-relative resolution works regardless of `process.cwd()`.

### Round 40 — Release Candidate Milestone Audit (Round 21–40 Final Gate)
- **Goal**: Full release-candidate certification across the entire stack:
  - `npx tsc --noEmit` (0 errors)
  - Full repo `npm run lint` (0 errors, 0 warnings)
  - `npm run tui:build` + bundle budget check (`tests/perf-budget.test.mjs`)
  - Full `npm run tui:test` (target: `220+` unit, WCAG contrast, 4-viewport responsive, resilience, scale & `@xterm/headless` E2E tests, 0 failures)
  - Live `STUDYHUB_TUI_LIVE=1` real `agy` CLI E2E check
  - Full upstream `npm run test:core` (0 regressions)
  - Fresh `npm run bench` NFR report (cold spawn `< 60ms`, RSS `< 195 MB`, heap `< 75 MB`, 0 leaked handles)
- **Acceptance Criteria**: Every single gate exits `0`, clean git history from Round 21–40 ready for Milestone #2 review.
- **Affected Files**: Final polish fixes only + updated benchmark/summary docs.
- **Risks**: Flaky timing on slower CI hosts → ensure every E2E wait uses deterministic UI-state predicates rather than fixed sleeps.
