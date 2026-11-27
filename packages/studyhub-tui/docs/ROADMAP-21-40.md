# StudyHub TUI Roadmap — Rounds 21–40

> **Historical milestone archive**: Early standalone `round*-*.test.mjs` / `pr1297-*.test.mjs` test files referenced below were later consolidated into current suites, and package metadata (`engines`, `files`) has since evolved; see `docs/ARCHITECTURE.md` and `package.json` for current state.

> **Baseline at Round 21** (`b9965932`, PR #1297 `feat/studyhub-tui-r20` → `main`):
> - **16 views** live (`Library`, `Review`, `Sources`, `Generate`, `WrongBook`, `Exam`, `Dashboard`, `Book`, `Skeleton`, `ExamCoach`, `ExamPrep`, `Notes`, `Board`, `Tasks`, `Audio`, `Settings`) + global `AppShell` (`CommandPalette`, `Inbox`, `HelpOverlay`, `CoursePicker`, `Launchpad`).
> - **Dual-model engine**: `agy` CLI primary (auto-probed, streaming) + 8 OpenAI-compatible presets secondary (env-key memory overlay).
> - **Round 21 NFR baseline**: Cold CLI spawn `56ms`, `ShellBootFrame` `514ms`, RSS `189.5 MB`, V8 heap `72.5 MB`, `169/169` TUI tests.
>
> **Round 40 Complete (`feat/studyhub-tui`)**:
> - **Verified TUI quality gate**: `314+` TUI tests across `77+` suites (`0` failures), `0` AST keymap conflicts (`tests/keymap-audit.test.mjs`), `0` `zod` runtime imports (`tests/perf-budget.test.mjs`), `9` minimal runtime dependencies, `0` CJK leaks across all `16` empty views in English mode, `0` `--ascii` modal/view Unicode leaks, and `0` leaked active handles after soak unmount/dispose.
> - **Verified NFR measurements**: `dist/cli.mjs` `~6.3 KB`, cold CLI spawn `~57 ms` (budget `<= 350 ms`), `ShellBootFrame` `~521 ms`, V8 heap `~57–58 MB`, 16-view sweep RSS `~325 MB`, `2.8 MB` 32-transition soak heap delta (and `< 40 MB` across 64-transition 4-viewport resize storm).

---

## Wave A: Power-User Parity & Interactive Workflows (Rounds 21–25)

### Round 21 — Case/Oral Exam Ergonomics, Skeleton Lint & Notes Linked-Ref Jump *(Completed: Exec Round 21, `b9965932`)*
- **Goal**: Upgrade Case & Oral exam experience (`ScrollView` scenario pane, `[s]` narrow toggle, `[H]` `review.highlights`, rich criteria breakdown & prior-attempt comparison), add `[L]` `skeleton.lint` + diagram count badge in `SkeletonView`, and `[o]` linked-card/source direct jump in `NotesView`.
- **Completed Deliverables**:
  - `ExamRunner` renders side-by-side scenario at `>= 104` cols and `[s]` toggle at `< 104` cols; `[H]` persists via `review.highlights`.
  - `ExamReportView` renders Case criteria bars, Oral band distribution, and prior-attempt deltas with 100% `--ascii` purity.
  - `SkeletonView` `[L]` runs `skeleton.lint`; `NotesView` `[o]` jumps to `ReviewView` or `DocumentReader`.
  - `tests/round20-e2e.test.mjs` verified `RoundSummary` `review.lookBack` + `[w]` retry and `CommandPalette` slash sweep (`169/169` pass).

### Round 22 — MinerU Long/Scanned PDF Planner & Live Review Queue Editor *(Completed: Exec Round 22, `73fa2f99`)*
- **Goal**: Bring scanned/long PDF conversion (`mineru.plan` / `mineru.import` / `mineru.retry` / `mineru.history.list`) into `SourcesView` (`[M]`), add non-restarting live review queue editing (`review.queue.edit`) in `ReviewView` (`[Q]`), and lock Round 21 with E2E + `HelpOverlay` sync.
- **Completed Deliverables**:
  - `MinerUModal` (`[M]`) plans local PDFs with Tab path completion, lists conversion history, retries failed jobs, and handles missing MinerU cleanly.
  - `QueueModal` (`[Q]`) displays answered/current/upcoming cards with compare-and-set `queueVersion`, removes upcoming cards (`[d]`), and inserts searched cards at `next`/`end` (`[a]`).
  - Enforced Barrel-Bypass lazy imports in `src/App.tsx` and added `tests/round21-e2e.test.mjs`.

### Round 23 — Interactive Course Book Inline Editing, Diff/Revert & Suggestions + Round 22 E2E *(Completed: Exec Round 23, `aa3482ae`)*
- **Goal**: Add terminal editing for Review Book sections (`course.book.save` with compare-and-set `version`, `course.book.suggestion` accept/ignore, `course.book.revert`), plus E2E suite for Round 22 (`MinerUModal`, `QueueModal`).
- **Completed Deliverables**:
  - `BookEditModal` (`[e]` in `BookView`) edits active `bk:` section markdown, persists with `version`, supports `[u]` `course.book.revert`, and accepts/ignores pending outline suggestions.
  - `tests/round22-e2e.test.mjs` verifies `MinerUModal` (`[M]`) and `QueueModal` (`[Q]`) with `--ascii` purity.

### Round 24 — Companion Interactive Builder, Feedback Sync & Catch-Up Cards *(Completed: Exec Round 23, `aa3482ae`)*
- **Goal**: Upgrade `CompanionsModal` in `SourcesView` from read/ask/open to full lifecycle parity: `generation.companion.build`, `companion.compile`, `companion.sync`, `companion.catchup.save`, and `companion.feedback.sync`.
- **Completed Deliverables**:
  - Users can launch new Companion build jobs, trigger disk sync/recompile, inspect catch-up cards, and track build job progress in `TasksView`, verified across responsive viewports and `--ascii`.

### Round 25 — Course Custom Plan Interactive Builder & Save (`course.custom.*` + `course.save`) *(Completed: Exec Round 24, `182d0fef`)*
- **Goal**: Upgrade `StudyPlanModal` (`ExamPrepView`) so learners can interactively configure and save a custom study plan (`purpose`, `scope`, `book.parts`, `questions.kinds/strength`, `minutesPerDay`), preview estimates (`course.custom.preview`), save (`course.save { custom }`), and apply (`course.custom.apply`).
- **Completed Deliverables**:
  - Interactive custom plan wizard inside `StudyPlanModal` enforcing part dependencies, showing token/call estimates before confirmation, preserving untouched course fields, and covered by `tests/round23-e2e.test.mjs` / `tests/round24-e2e.test.mjs`.

---

## Wave B: Terminal UX Mastery & Workflow Speed (Rounds 26–30)

### Round 26 — Deck Merge Suggestions, Batch Card Operations & WrongBook Bulk Triage *(Completed: Exec Round 24, `182d0fef`)*
- **Completed Deliverables**:
  - `DeckOpsModal` Tab 2 surfaces `deck.merge.suggest` candidates; `DeckManageModal` supports `[Space]` multi-select (up to 100) with batch focus/suspend; `WrongBookView` supports quick-tag cycling + batch practice scope launch, verified by E2E (`tests/round24-e2e.test.mjs`).

### Round 27 — Command Palette v3: Action History, Course Scoping & Deep Actions *(Completed: Exec Round 25, `0b6578ae`)*
- **Completed Deliverables**:
  - Upgraded `CommandPalette` (`Ctrl+K`) with scoped search prefixes (`#` cards, `@` courses, `/` commands, `:` pages, `?` passages), persistent command frecency via `tui.json`, and instant hit previews (`tests/round25-e2e.test.mjs`).

### Round 28 — Review Mode Power Ergonomics: Round Configurator, Cloze Multi-Blank UX & Undo Polish *(Completed: Exec Rounds 25–26, `0b6578ae`, `6fea889b`)*
- **Completed Deliverables**:
  - Added `RoundConfigModal` (`[R]` in `LibraryView`: size `5–50`, `only: due|new|wrong`, `focusOnly`), polished multi-blank `cloze` `Tab`/`Shift+Tab` navigation and per-blank diff feedback (`tests/cloze-helpers.test.mjs`), and verified `[u]` `review.undo` + `ExamSetup` single-start fix (`tests/round25-e2e.test.mjs`).

### Round 29 — Skeleton Graph Editing (`skeleton.patch` / `topic.groups.save`) & Course Route Viewer *(Completed: Exec Round 26, `6fea889b`)*
- **Completed Deliverables**:
  - Added `CourseRouteModal` (`[R]` in `SkeletonView`) for `course.route` chapter roadmap inspection, `TopicGroupsModal` (`[G]`) for `topic.groups.save`, and `[E]` node editing via `skeleton.patch`, verified by `tests/round26-e2e.test.mjs`.

### PR #1297 Review Remediation — P0 through P4 *(Completed: `7596c2f5`, `022674ad`, `267fafad`, `86c0a25b`)*
- **P0 (`7596c2f5`, `#1`, `#5–#11`)**: Single `review.start` in `ExamSetup`, `Ctrl+K` `inputCaptured` + `ConfirmDialog` shell-overlay guards, `tui-board.json` read-only parse failure protection, `[q]` confirm before ending review, `job.delete` `skipped` check, archive-delete rollback, draft-safe deck rename, and `[x]`/`[u]` draft card delete undo.
- **P1 (`022674ad`, `#2–#4`, `#14–#19`)**: Oral/sidebar card & wrong counts (`count`), `SkeletonView` real mastery via `deck.get`, `BookView` `outlineId` on rebuild, 2-way Board sync with `MAX_DELETED_UPSTREAM_IDS` (500) tombstones, `0–5` FSRS self-grading, `source-helpers` / `note.qa.add` / LaTeX JSON import / mock check parity.
- **P2 (`267fafad`, `#12–#13`)**: Quota guards (estimate + confirmation + `busyRef`) on `SkeletonView` `[g]`, `ExamPrepView` `[g]`/`[G]`, `ExamCoachView` `[g]`/`[A]`, and note-save auto-analysis.
- **P3 & P4 (`86c0a25b`, `#20–#24` & Section 6)**: Cross-platform Windows/CI/lint-guard/smoke/soak GC fixes plus ASCII fallback, `SideNav` alignment, head-truncating path display, bilingual copy, Pomodoro store persistence, `Ctrl+J`/`Shift+Enter` multiline newlines, and bounded 64 B boot input buffer (`tests/pr1297-p0.test.mjs`, `tests/pr1297-p1-p2.test.mjs`).

### Round 30 — Milestone Audit #2: UX Polish, Mouse-Free Accessibility & Complete Keymap Audit *(Completed: Exec Round 27, `21b4e4e6`)*
- **Completed Deliverables**:
  - Added AST + runtime conflict audit `tests/keymap-audit.test.mjs` verifying `AppShell` global shortcuts vs `PAGE_REGISTRY` & `HelpOverlay`, `useClaimKeys` coverage across all primary views, `src/App.tsx` Barrel-Bypass compliance, and bounded `width` on all `<Modal>` + `<TextInput>` pairs (`0` AST keymap conflicts).
  - Synced `src/shell/HelpOverlay.tsx`, `tests/ergonomics.test.mjs`, and `README.md`.

---

## Wave C: Deep Performance, Memory & Large-Library Scale NFR (Rounds 31–35)

### Round 31 — Large-Library Stress Benchmark (5,000 Cards / 2,000 Sources / 200 Notes) *(Completed: Exec Round 28, `df76cfef`)*
- **Completed Deliverables**:
  - Optimized `src/shell/fuzzy.ts` (`prepareQuery`, native `indexOf` fast-reject, `ASCII_BOUNDARY` lookup, zero-split BMP fast path; ~3.6x–4.2x faster on 5,000 items) and `src/views/sources/source-helpers.ts` (`addCardSourceCounts`, O(1) `libraryListField`, single-pass group building, cached `Intl.Collator`).
  - Added `tests/scale-nfr.test.mjs` verifying 5,000-card / 250-deck / 2,000-page-source / 200-note budgets (`fuzzyFilter < 25ms`, `groupSourcesFromSnapshot < 40ms`, `computeSnapshotFingerprint < 10ms`, `buildScopeChoices < 15ms`, and Markdown/wrap LRU speedup).

### Round 32 — Host Cold-Start & `syncFromHost` Fingerprint Optimization *(Completed: Exec Round 27, `21b4e4e6`)*
- **Completed Deliverables**:
  - Added `src/state/snapshot-fingerprint.ts` (`computeSnapshotFingerprint` via dual 32-bit FNV-1a `RollingHasher`), replacing full-snapshot `JSON.stringify` diffing in `src/App.tsx` `syncFromHost` with $O(K)$ metadata hashing (`tests/snapshot-fingerprint.test.mjs`).

### Round 33 — Streaming AI Render Smoothness & Token Coalescing (60fps Frame Pacing) *(Completed: Exec Round 28, `df76cfef`)*
- **Completed Deliverables**:
  - Created `src/components/useStreamingBuffer.ts` (`createStreamingCoalescer` + `useStreamingBuffer(24)`), wired into `AiHelpDrawer` and `DocumentReader` (Page Ask & Translate) with synchronous `finish()`/`flush()` and automatic `dispose()` on unmount (`tests/streaming-buffer.test.mjs`).

### Round 34 — Memory Leak & Long-Session Soak Hardening (64-Transition Resize Storm) *(Completed: Exec Round 29, `10c0c234`)*
- **Completed Deliverables**:
  - Verified `LruCache` bounds (`mdCache <= 256`, `mathCache <= 512`, `ReviewView` translations `<= 32`), added `2.8 MB` 32-transition soak check (`tests/parity-e2e.test.mjs`) and 64-transition 4-viewport (`80x24` ↔ `160x44`) resize-storm soak with deterministic V8 GC (`tests/packaging-smoke.test.mjs`: heap delta `< 40 MB`, `0` leaked `FSEventWrap`/`StatWatcher`/`ProcessWrap`/`Timeout` handles).

### Round 35 — Pure `NO_COLOR` / 16-Color / High-Contrast Terminal Fidelity *(Completed: Exec Round 28, `df76cfef`)*
- **Completed Deliverables**:
  - Centralized `ColorLevel`, `getColorLevel`, `setColorLevel`, and `makeChalk` in `src/theme/tokens.ts`; wired `resolveColorCapability` + `FORCE_COLOR='0'` before Ink import in `src/cli.tsx`; keyed `mdCache` by `colorLevel` in `src/render/markdown.ts`; added `tests/no-color-audit.test.mjs` verifying zero SGR color escapes under `NO_COLOR=1`.

---

## Wave D: Cross-Platform Polish, Reliability & Production Release Readiness (Rounds 36–40)

### Round 36 — Windows PowerShell / ConPTY / WSL2 Deep Hardening *(Completed: `0b7a665d` + `26e3c757`)*
- **Completed Deliverables**:
  - Hardened PowerShell drag-and-drop paths (`& '...'` / `& "..."`), UNC paths (`\\server\share`), drive roots (`C:\`), `completeFsPath`, and `isHeadlessOrSsh` detection (`src/terminal.ts`) with expanded `tests/cross-platform.test.mjs` (`execFile` only, zero `sh -c`/`cmd /c`).
  - Pruned 4 dead runtime dependencies (`13 -> 9` minimal dependencies) with bidirectional dep audit (`tests/packaging-smoke.test.mjs`), added `LibraryView` `[` / `]` deck reordering, and added `DocumentReader` `[M]` chapter reading progress + lazy drawers (`tests/round36-library-e2e.test.mjs`, `tests/round36-reader-e2e.test.mjs`).

### Round 37 — Offline / Degraded / Corrupt-Data Resilience & Crash Recovery *(Completed: `10c0c234` + `3363211c`)*
- **Completed Deliverables**:
  - Hardened `src/host/tui-prefs.ts` (`parseTuiPreferences` fallback + frozen defaults) and `ViewErrorBoundary` in `src/App.tsx` (ASCII-safe diagnostic summary + `[r]` retry / `[1]` Library).
  - Added `tests/resilience.test.mjs` covering corrupt `tui.json`, read-only corrupt `tui-board.json`, loopback OpenAI 401/429/500/503 + malformed/truncated SSE + abort, crashing `agy` stub, invalid `deck.import` JSON, and `ViewErrorBoundary` recovery (`10/10` pass).
  - Delivered `SourcesView` `[` / `]` pin reordering, `CourseSettingsModal` course merge & activate/deactivate, and `SettingsView` Book/Practice/Experimental toggles (`3363211c`).

### Round 38 — Onboarding Tour, Empty-State Polish & Bilingual Copy Consistency Audit *(Completed: `10c0c234` + `e45a95eb`)*
- **Completed Deliverables**:
  - Added `tests/empty-state-audit.test.mjs` sweeping `Launchpad` and all `16` views in an empty library (no sample course) across `en` & `zh` at `120x36` & `80x24` (`9/9` pass, `0` CJK leaks across all 16 empty views in English mode, `0` `--ascii` Unicode leaks).
  - Delivered `AudioView` preflight diagnostics / usage / retry / subtitle import, `NotesView` publish link (`[L]`) & daily recap cancel (`[C]`), `SkeletonView` delete (`[D]`), signed-int32 `computeSnapshotFingerprint` 2x speedup, and `Launchpad` lazy split (`e45a95eb`).

### Round 39 — Packaging, Bin Entrypoint, Architecture & Keybindings Docs, Smoke Test *(Completed: `10c0c234`, `0b7a665d`, `261d3cac`)*
- **Completed Deliverables**:
  - Configured `package.json` `engines` (`>=22.0.0`) and `files` (`["bin/", "dist/", "README.md", "docs/KEYBINDINGS.md"]`); added `tests/packaging-smoke.test.mjs` verifying `/tmp` out-of-repo `bin/studyhub-tui.mjs` execution and clean `npm pack --dry-run --json` output.
  - Authored `docs/KEYBINDINGS.md` (`10c0c234`) and contributor guide `docs/ARCHITECTURE.md` (`0b7a665d`).
  - Delivered `DeckManageModal` slain card restore (`[u]`) & folder move (`[m]`), `FolderModal` P2-guarded AI classify (`[g]`), and `SettingsView` ExamPrep reset, Retrieval status & Usage telemetry (`[f]`/`[u]`/`[U]`) (`261d3cac`, `314/314` tests across `77` suites).

### Round 40 — Release Candidate Milestone Audit (Round 21–40 Final Gate) *(Completed)*
- **Completed Deliverables**:
  - Wired `BookView` `[U]` Unplaced Section Placement (`course.book.place` via lazy `BookStructureModal`), `CoachPreferencesModal` `[g]` learning goal (`coach.goal`), and `CardToolsModal` P2-safe quality feedback (`coach.feedback` with `rewriteVia: 'assist'`) & rewrite revert (`coach.revert`).
  - Synced `docs/ROADMAP-21-40.md`, `docs/ARCHITECTURE.md`, `docs/KEYBINDINGS.md`, and `src/shell/HelpOverlay.tsx` with verified Rounds 31–40 metrics and shortcuts.
  - Passed full-stack gate (`npx tsc --noEmit`, `npm run build`, `314+` TUI tests across `77+` suites, `0` AST keymap conflicts, `0` `zod` runtime imports, `9` minimal runtime deps).

---

## Rounds 31–40 Execution Log

| Exec Round | Commit | Verified Deliverables |
| --- | --- | --- |
| Round 31 | `9b1ab5d1` | `NO_COLOR` parity + cached `makeChalk(level)` (-12 MB RSS), lazy sub-views (`ExamView`, `SettingsView`, `GenerateView`), `CompanionsModal` streaming coalescer, SSH `app.open` guard, Oral/Coach/Pomodoro E2E (`tests/no-color-audit.test.mjs`, `tests/round31-e2e.test.mjs`) |
| Round 32 | `33646f86` | Shell overlay (-67%) & view modal (-30%) lazy-splitting, full 16-view `--ascii` purity sweep & 20+ view leak fixes (`tests/ascii-full-sweep.test.mjs`) |
| Round 33 | `9378c3ae` | Complete shell Barrel-Bypass (0 static overlays, `23 -> 16` chunks), `ExamPrepView` lazy split, final `--ascii` polish & ~327 MB sweep RSS |
| Round 34 | `7a070f50` | Removed `zod`/`marked` from boot (-150 ms, -15.6 MB heap), `BookView` structure ops (`R`/`[`/`]`/`D`/`z`/`u`) + `BookStructureModal`, modal `--ascii` audit (`tests/ascii-modals-audit.test.mjs`, `tests/round34-e2e.test.mjs`, `274/274`) |
| Round 35 | `a7ee0f5c` | 100% zero-`zod` runtime (`board-store.ts` + `tui-prefs.ts`), centralized `normalizeAsciiChrome`, `TasksView` trace export (`[e]`) & purge (`[D]`) (`tests/board-store.test.mjs`, `tests/round35-e2e.test.mjs`, `288/288` + `34/34` Live + Core) |
| Round 36 | `26e3c757` | Pruned 4 dead runtime deps (`13 -> 9`) + bidirectional dep audit, `LibraryView` deck reorder (`[`/`]`), `DocumentReader` `[M]` chapter reading progress & lazy drawers (`tests/round36-library-e2e.test.mjs`, `tests/round36-reader-e2e.test.mjs`, `294/294`) |
| Round 37 | `3363211c` | `SourcesView` pin reorder (`[`/`]`), `CourseSettingsModal` course merge & activate/deactivate, `SettingsView` Book/Practice/Experimental toggles (`tests/round37-course-merge.test.mjs`, `tests/round37-settings-e2e.test.mjs`, `tests/round37-sources-e2e.test.mjs`, `301/301`) |
| Round 38 | `e45a95eb` | `AudioView` preflight/usage/retry/subtitles, `NotesView` publish link (`[L]`) & recap cancel (`[C]`), `SkeletonView` delete (`[D]`), signed-int32 `computeSnapshotFingerprint` 2x speedup & `Launchpad` lazy split (`tests/round38-audio-e2e.test.mjs`, `tests/round38-notes-e2e.test.mjs`, `tests/round38-skeleton-e2e.test.mjs`, `307/307`) |
| Round 39 | `261d3cac` | `DeckManageModal` slain restore (`[u]`) & folder move (`[m]`), `FolderModal` AI classify (`[g]`, P2-guarded), `SettingsView` ExamPrep reset, Retrieval status & Usage telemetry (`[f]`/`[u]`/`[U]`) (`tests/round39-deck-restore.test.mjs`, `tests/round39-folder-ai.test.mjs`, `tests/round39-settings-usage.test.mjs`, `314/314`) |
| Round 40 | *Milestone* | `BookView` `[U]` unplaced section placement (`course.book.place`), `CoachPreferencesModal` `[g]` goal (`coach.goal`), `CardToolsModal` P2-safe quality feedback (`coach.feedback` `rewriteVia: 'assist'`) & revert (`coach.revert`), Milestone docs & `HelpOverlay` sync |
