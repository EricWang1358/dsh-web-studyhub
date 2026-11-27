# StudyHub TUI Roadmap — Rounds 61–65

> **Historical milestone archive**: Standalone `round61-65-*.test.mjs` files referenced below were later consolidated into current suites, and backup export filenames now include a `-HHmmss` timestamp suffix; see `docs/ARCHITECTURE.md` for current state.

> **Baseline at Round 60 (`7454ed03`, `feat/studyhub-tui`)**:
> - **16 views** live + global `AppShell`, all **5 Barrel-Bypass rules** enforced (`0` importers across `render/index.js`, `components/index.js`, `host/index.js`), `0` `zod` runtime imports, `9` minimal runtime dependencies.
> - **Round 60 gate**: `470+` automated TUI tests across `135+` suites, permanent AST P2 quota-guard audit (`tests/p2-quota-audit.test.mjs`), `53+` non-markdown entry chunks locked `marked`-free (`tests/perf-budget.test.mjs`), `0` AST keymap conflicts, and `0` `--ascii` / `NO_COLOR=1` leaks.
>
> **Round 65 Full-Stack Certified Milestone (`feat/studyhub-tui`)**:
> - **Full-Stack Certified TUI Parity, Ergonomics & CLI Diagnostics**: Shipped Usage Frequency reporting/pause/export, dry-run draft publish preflight, Review Book revision history & revert, Guided Study teaching artifact capture, read-only library context overview & atomic JSON export, pending organize/folder proposal inspection & dismiss, parallel job promotion, Review Book AI-blocks management, P2-guarded multi-step study path wizard, 16/16 CommandPalette view slash commands + UI toggles + SGR 1006 mouse wheel, course terms check-card attach, `SelectList` SGR 1006 mouse wheel + paging, `InboxModal` `/` keyword filter & `[e]` atomic `inbox.raw` JSON export, and fast-path cross-platform `--doctor` / `--doctor --json` CLI diagnostics.
> - **Verified quality & guardrail bar**: `510+` automated TUI tests across `150+` suites (`470+ -> 510+` trajectory across Rounds 60–65), **permanent AST P2 quota-guard audit** (`tests/p2-quota-audit.test.mjs`, enforcing `generate.path.suggest` alongside `16` other guarded LLM actions across `src/views/` and `src/shell/`), **`55+` non-markdown entry chunks locked `marked`-free** in `tests/perf-budget.test.mjs` (including `BookHistoryModal-`, `BookAiBlocksModal-`, `GeneratePathModal-`, and `InboxModal-`), `0` AST keymap conflicts, `0` `--ascii` / `NO_COLOR=1` leaks, and `dist/cli.mjs <= 15 KB` with zero API key leakage in `--doctor`.

---

## Completed Rounds 61–65

### Round 61 — Usage Frequency Report/Export, Draft Publish Preflight & Review Book Revision History *(Completed: `112b0b68`)*
- **`WorkspaceTab.tsx` (`[i]`)**: Wired Usage Frequency report, pause/resume toggle, and atomic JSON export (`usage.frequency.report`, `usage.frequency.set`, `usage.frequency.export`).
- **`DraftEditor.tsx` (`[V]`)**: Added dry-run publish preflight modal (`draft.publish.plan`, 0 LLM tokens) to inspect target deck counts and validation warnings prior to publishing.
- **`BookView.tsx` & `BookHistoryModal.tsx` (`[H]`)**: Added lazy, `marked`-free `BookHistoryModal` (`course.book.revision` + `course.book.revert`) for inspecting and reverting Review Book revisions, locked `marked`-free in `tests/perf-budget.test.mjs`.
- **Tests**: `round61-usage-report.test.mjs`, `round61-draft-plan.test.mjs`, `round61-book-history.test.mjs`.

### Round 62 — Guided Study Artifact Save, Library Context Overview & Pending Organize/Folder Dismiss *(Completed: `4674608d`)*
- **`GuidedStudyModal.tsx` (`[A]`)**: Wired `[A]` to save teaching artifacts (`study.session.artifact.save`) with an idempotent `operationId`.
- **`WorkspaceTab.tsx` (`[L]`)**: Added read-only `library.context` overview modal (`0` LLM tokens) with live refresh (`[r]`) and atomic JSON export (`[e]`).
- **`OrganizeSourcesModal.tsx` & `FolderModal.tsx` (`[X]`)**: Added pending proposal inspection & dismiss (`source.organize.dismiss` / `source.folder.dismiss`).
- **Tests**: `round62-study-artifact.test.mjs`, `round62-library-ctx.test.mjs`, `round62-org-dismiss.test.mjs`.

### Round 63 — Tasks Parallel Promotion, Book AI Blocks Review & Concurrency E2E Hardening *(Completed: `cfe78b1b`)*
- **`TasksView.tsx` (`[P]`)**: Wired `[P]` to promote queued jobs to parallel execution (`job.parallel`).
- **`BookView.tsx` & `BookAiBlocksModal.tsx` (`[B]`)**: Added lazy, `marked`-free `BookAiBlocksModal` (`course.book.block` keep/delete) to review, keep, or delete AI-supplemented Review Book blocks, locked `marked`-free in `tests/perf-budget.test.mjs`.
- **Concurrency & E2E Hardening**: Hardened `round22-e2e.test.mjs`, `round51-reader-trans.test.mjs`, and `scale-nfr.test.mjs` V8 JIT warm-up handling under parallel/CI load.
- **Tests**: `round63-job-parallel.test.mjs`, `round63-book-aiblock.test.mjs`.

### Round 64 — P2-Guarded Study Path Wizard, 16/16 CommandPalette Slash & Terms Check Attach *(Completed: `9d184ab8`)*
- **`GenerateView.tsx` & `GeneratePathModal.tsx` (`[P]`)**: Added lazy, `marked`-free `GeneratePathModal` with deterministic local chapter/page partitioning (`buildLocalPathSteps`) and P2 `ConfirmDialog`-guarded `generate.path.suggest` refinement, locked in both `tests/p2-quota-audit.test.mjs` and `tests/perf-budget.test.mjs`.
- **`CommandPalette.tsx`**: Completed 16/16 direct view slash jumps plus `/compact`, `/hints`, and `/sidebar` UI toggles and SGR 1006 mouse wheel scrolling.
- **`CourseSettingsModal.tsx` (Tab 3 `[a]`)**: Wired `[a]` (`course.terms.attach`) to attach check cards to course terms (505/505 tests passing at `9d184ab8`).
- **Tests**: `round64-gen-path.test.mjs`, `round64-palette-slash.test.mjs`, `round64-terms-attach.test.mjs`.

### Round 65 — Full-Stack Certified Milestone: `SelectList` Ergonomics, `InboxModal` Filter/Export, `--doctor` CLI & Docs Sync *(Round 65 Milestone)*
- **`SelectList.tsx`**: Added opt-in SGR 1006 mouse wheel scrolling (`±3` rows) plus `PageUp`/`PageDown`/`Ctrl+D`/`Ctrl+U` paging while skipping disabled options cleanly.
- **`InboxModal.tsx` (`I`)**: Added `/` keyword filter (`c` / clearing resets) and `[e]` atomic `inbox.raw` JSON export to `<libraryRoot>/backups/studyhub-inbox-YYYY-MM-DD.json` (`InboxModal-` remains `marked`-free).
- **`cli-args.ts` & `cli.tsx` (`--doctor` / `--doctor --json`)**: Added fast-path cross-platform terminal, path, and provider diagnostics executed before importing React, Ink, `App.mjs`, or `host.mjs` (`dist/cli.mjs <= 15 KB`, 100% pure ASCII with `--ascii`, zero API key value leakage).
- **Milestone Docs & Certification**: Synced `HelpOverlay.tsx`, `docs/KEYBINDINGS.md`, `docs/ARCHITECTURE.md`, and `docs/ROADMAP-61-65.md` with full-stack verification.
- **Tests**: `round65-select-inbox.test.mjs`, `round65-cli-doctor.test.mjs`, `ergonomics.test.mjs`, `keymap-audit.test.mjs`, `p2-quota-audit.test.mjs`, `perf-budget.test.mjs`.
