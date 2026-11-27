# StudyHub TUI Roadmap — Rounds 51–55

> **Historical milestone archive**: Standalone `round51-55-*.test.mjs` and `round12-e2e.test.mjs` files referenced below were later consolidated into current suites; see `docs/ARCHITECTURE.md` for current state.

> **Baseline at Round 50 (`15684e2e`, `feat/studyhub-tui`)**:
> - **16 views** live + global `AppShell`, all **5 Barrel-Bypass rules** enforced (`0` importers across `render/index.js`, `components/index.js`, `host/index.js`), `0` `zod` runtime imports, `9` minimal runtime dependencies.
> - **Round 50 gate**: `391+` automated TUI tests across `85+` suites, `49+/71` entry chunks `marked`-free, `0` AST keymap conflicts, `0` `--ascii` / `NO_COLOR=1` leaks.
>
> **Round 55 Milestone (`feat/studyhub-tui`)**:
> - **P1/P2 Hardening & Web-UI Parity Complete**: Eliminated silent AI quota leaks (`DeckOpsModal`, `OrganizeSourcesModal`, `DocumentReader`), shipped Web-UI parity across translation, audio review, palette commands, reader Q&A-to-flashcard, manual AI grade adjust, note-to-source import, AI draft/cancel, coach debrief, memory bullets CRUD, rewrite retry, prep queue flush, and import filing proposal.
> - **Verified quality & guardrail bar**: `425+` automated TUI tests across `120+` suites (`391 -> 425+` trajectory across Rounds 50–55), **permanent AST P2 quota-guard audit** (`tests/p2-quota-audit.test.mjs`), **52/74 (`51+` non-markdown) entry chunks locked `marked`-free** in `tests/perf-budget.test.mjs` (including `OriginalFileModal-` and `SkeletonDiagramsModal-`), `0` AST keymap conflicts, and `0` `--ascii` / `NO_COLOR=1` leaks.

---

## Completed Rounds 51–55

### Round 51 — Bilingual Reader Translation Fix, Audio Corrections Review & Command Palette Slash Commands *(Completed: `5d2d3912`)*
- **`DocumentReader.tsx` (`[t]`, `[L]`, `[R]`)**: Fixed P1 `'zh' | 'en'` target bug (replacing invalid `'中文' | 'English'`) and `quote`/`text` field mapping; wired cache-first `materials.translation.list` (0 tokens) + `estimate: true` + P2 `ConfirmDialog` quota guard before `materials.translation.translate` + `materials.translation.cancel` on `Esc`.
- **`AudioView.tsx` (`[c]`)**: Fixed `audio.results`/`audio.result.get` route names, added `countPendingCorrections` inspection + detail-panel badges/samples, and wired `[c]` behind P2 `ConfirmDialog` for `audio.corrections.review`.
- **`CommandPalette.tsx`**: Added zero-token slash commands `/ascii`, `/math`, `/recover` (`coverage.recover`), and direct page commands (`/review`, `/book`, `/exam`, `/skeleton`, `/wrongbook`, `/tasks`, `/audio`, `/settings`).
- **Tests**: `round51-reader-trans.test.mjs`, `round51-audio-review.test.mjs`, `round51-palette-cmds.test.mjs`.

### Round 52 — Reader Q&A-to-Flashcard, Manual AI Grade Adjust & Note-to-Source Import *(Completed: `e164b842`)*
- **`DocumentReader.tsx` (`ask-view` `[f]`)**: Exported `extractPageAnchorSlice` and wired 0-token `generation.selection.saveAnswer` (handling `complete` and `duplicate` cleanly).
- **`ReviewView.tsx` & `review-helpers.ts` (`[J]`, `[K]`)**: Exported `canAdjustAiGrade`, wired `[J]` manual AI grade adjust modal (`review.grade.adjust`, preserving `gradeOriginal`) and `[K]` delayed correction acknowledge (`review.correction.ack`).
- **`NotesView.tsx` (`[M]`)**: Wired 0-token `note.material.prepare` + `source.add` to import notes directly into the Sources library.
- **Tests**: `round52-reader-savecard.test.mjs`, `round52-review-grade-adj.test.mjs`, `round52-notes-material.test.mjs`.

### Round 53 — Deck Merge P2 Guard, Round AI Debrief & Coach Memory Bullets CRUD *(Completed: `3391dfb4`)*
- **`DeckOpsModal.tsx` (Tab 2 `[g]`, `[a]`)**: Fixed P2 silent AI quota leak by removing auto-firing `useEffect` on `deck.merge.suggest`; wired on-demand `[g]` behind P2 `ConfirmDialog` and `[a]` to apply top merge suggestion with merge confirmation.
- **`RoundSummary.tsx` (`[d]`)**: Wired post-round coaching debrief (`coach.debrief`) — opens cached debrief immediately (0 tokens) or gates uncached calls behind P2 `ConfirmDialog`, rendering `DebriefModal`.
- **`CoachPreferencesModal.tsx` (`Tab`/`1`/`2`, `[a]`, `[d]`)**: Added 2-tab switcher (`Preferences` / `Memory Bullets`) supporting 0-token `coach.profile` `addBullet` / `removeBullet` with `expectedRevision`.
- **Tests**: `round53-deck-merge-guard.test.mjs`, `round53-round-debrief.test.mjs`, `round53-coach-bullets.test.mjs`.

### Round 54 — Organize Sources P2 Guard, Notes AI Draft/Cancel & CardTools Rewrite Retry *(Completed: `2a300496`)*
- **`OrganizeSourcesModal.tsx`**: Fixed P2 silent AI quota leak by removing auto-firing `useEffect` on `source.organize.suggest`; gated initial analysis and `[r]` re-analysis behind P2 `ConfirmDialog` (0-token `EmptyState` when 0 sources); updated `round12-e2e.test.mjs`.
- **`NotesView.tsx` (`[g]`, `[C]`)**: Wired `[g]` P2 `ConfirmDialog`-guarded AI draft note generation (`note.generate`) and `[C]` cancellation (`note.cancel`) alongside daily recap cancel.
- **`CardToolsModal.tsx` (`[R]`)**: Wired `[R]` P2 `ConfirmDialog`-guarded retry for failed AI card rewrites (`coach.rewrite.retry`).
- **Tests**: `round54-org-sources-guard.test.mjs`, `round54-notes-gen-cancel.test.mjs`, `round54-card-retry.test.mjs`.

### Round 55 — Milestone Release: Coach Prep Queue, Import Filing Proposal, Permanent P2 Audit & Docs Sync *(Completed: `22746d91`)*
- **`ExamCoachView.tsx` (`[f]`)**: Wired `[f]` P2 `ConfirmDialog`-guarded manual flush of the background coach prep queue (`coach.prepare`).
- **`DeckOpsModal.tsx` (Tab 1 `Ctrl+G`)**: Wired `Ctrl+G` P2 `ConfirmDialog`-guarded AI import filing proposal (`draft.import.propose`) with automatic blank-course prefill and merge-target display.
- **Permanent P2 Quota-Guard Static Audit (`tests/p2-quota-audit.test.mjs`)**: AST-based static guardrail scanning all `src/views/` and `src/shell/` `.ts`/`.tsx` files to enforce zero silent LLM calls in `useEffect(...)`, direct `ConfirmDialog` import & render co-location for all guarded LLM actions, and zero `target: '中文' | 'English'` translation regressions.
- **Bundle Closure Lock (`tests/perf-budget.test.mjs`)**: Added `OriginalFileModal-` and `SkeletonDiagramsModal-` to Test 7, locking all `51+` non-markdown entry chunks (`52/74` total) `marked`-free.
- **Milestone Docs & Help Sync**: Updated `HelpOverlay.tsx`, `docs/KEYBINDINGS.md`, `docs/ARCHITECTURE.md`, and `docs/ROADMAP-51-55.md`.
- **Tests**: `round55-coach-prep.test.mjs`, `round55-import-propose.test.mjs`, `p2-quota-audit.test.mjs`.

---

## Candidate Tracks for Rounds 56–60

1. **Review Book Revision History & Snapshot Diff**: Section-level revision browser (`course.book.history`), line-by-line diff preview inside `ScrollView`, and P2-safe one-key restore.
2. **Audio Segment Editing & Selective Clip Generation**: Inline transcript segment correction editing, segment timestamps/playback markers, and selective clip-to-note / clip-to-card generation.
3. **DocumentReader Side-by-Side Bilingual Split & Paragraph Retranslate**: Split-pane bilingual alignment mode using `SplitPane`, per-paragraph glossary highlighting, and cached translation diff inspection.
4. **Command Palette Deep Modal Dispatch**: Direct `Ctrl+K` action routing into `OriginalFileModal`, `SkeletonDiagramsModal`, `RoundConfigModal`, and `StudyMapModal` with active-context preselection.
5. **Windows ConPTY CI Matrix & Memory Ceiling Tightening**: Automated ConPTY PTY test coverage in CI, stricter per-chunk byte budgets in `tests/perf-budget.test.mjs`, and 128-transition resize soak assertions.
