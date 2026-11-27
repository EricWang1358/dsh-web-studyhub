# StudyHub TUI Roadmap — Rounds 66–70

> **Historical milestone archive**: Early standalone test names (such as `ergonomics.test.mjs`) were later consolidated, backup export filenames now include a `-HHmmss` timestamp suffix, and `dist/App.mjs` has since been split further (`<= 64 KB` budget); see `docs/ARCHITECTURE.md` for current state.

> **Baseline at Round 65 (`55e9226d`, `feat/studyhub-tui`)**:
> - **16 views** live + global `AppShell`, all **5 Barrel-Bypass rules** enforced (`0` importers across `render/index.js`, `components/index.js`, `host/index.js`), `0` `zod` runtime imports, `9` minimal runtime dependencies.
> - **Round 65 gate**: `510+` automated TUI tests across `150+` suites (`511` at `55e9226d`), permanent AST P2 quota-guard audit (`tests/p2-quota-audit.test.mjs`), `55+` non-markdown entry chunks locked `marked`-free (`tests/perf-budget.test.mjs`), `0` AST keymap conflicts, `0` `--ascii` / `NO_COLOR=1` leaks, and `dist/cli.mjs <= 15 KB` with `--doctor` CLI diagnostics.
>
> **Round 70 Full-Stack Certified Milestone (`feat/studyhub-tui`)**:
> - **Universal Markdown Export Coverage, Shared Cross-Platform Atomic Persistence & Fast-Path Rendering**: Shipped universal `[x]` / `[X]` atomic Markdown exports across Board, Dashboard, Wrong Book, Skeleton, Audio, Exam Setup, Exam Prep, Exam Coach, Library, Notes, and Sources; consolidated atomic temp-file writes and Windows transient lock retries into `src/host/atomic-write.ts` across views and modals; added `/` keyword filters and SGR 1006 mouse wheel scrolling across core views; and delivered zero-allocation BMP CJK width (`~2x` speedup) alongside plain-text / plain-prose fast-paths in `src/render/math.ts` and `src/render/markdown.ts`.
> - **Verified quality & guardrail bar**: `550+` automated TUI tests across `165+` suites (`511 -> 550+` trajectory across Rounds 65–70), **permanent AST P2 quota-guard audit** (`tests/p2-quota-audit.test.mjs`), **non-markdown entry chunks locked `marked`-free** in `tests/perf-budget.test.mjs` (`App.mjs = 103.4KB`), `0` AST keymap conflicts, and `0` `--ascii` / `NO_COLOR=1` leaks.

---

## Completed Rounds 66–70

### Round 66 — Board Filter/Export/Wheel, Dashboard Usage Window & Wrong Book Study Sheet *(Completed: `1b7a3629`)*
- **`BoardView.tsx` (`/`, `[x]`, SGR 1006 wheel)**: Added `/` keyword filter across Kanban cards, `[x]` Kanban Markdown export, and opt-in SGR 1006 mouse wheel support.
- **`DashboardView.tsx` (`[d]`, `[x]`)**: Added `[d]` usage window selector (`7` / `30` / `90` days) and `[x]` atomic progress report Markdown export.
- **`WrongBookView.tsx` (`[X]`)**: Added `[X]` printable wrong-book Markdown study sheet export (`backups/studyhub-wrongbook-YYYY-MM-DD.md`).
- **Tests**: `520` passing tests at `1b7a3629`.

### Round 67 — Skeleton Filter/Wheel/Export, Audio Filter/Export & Exam History Report *(Completed: `7f9c3050`)*
- **`SkeletonView.tsx` (`/`, `[x]`, SGR 1006 wheel)**: Added `/` skeleton node filter, SGR 1006 mouse wheel scrolling, and `[x]` outline Markdown export.
- **`AudioView.tsx` (`/`, `[x]`)**: Added `/` keyword filter across audio jobs and `[x]` transcript Markdown export.
- **`ExamSetup.tsx` (`[x]`)**: Added `[x]` exam history Markdown report export (`backups/studyhub-exam-YYYY-MM-DD.md`).
- **Tests**: `529` passing tests at `7f9c3050`.

### Round 68 — Shared `atomic-write.ts` DRY Refactor, Exam Prep & Exam Coach Exports *(Completed: `d160f5a1`)*
- **`src/host/atomic-write.ts` (DRY refactor across 8 views/modals)**: Extracted shared cross-platform atomic persistence (`atomicWriteTextFile`, `atomicWriteJsonFile`, `renameWithRetry` handling Windows `EBUSY`/`EPERM`/`EACCES` locks, guaranteed `.tmp` cleanup, and `defaultBackupFilePath`) used across 8 views and modals.
- **`ExamPrepView.tsx` (`/`, `[x]`)**: Added `/` focus-point filter and `[x]` exam prep guide Markdown export.
- **`ExamCoachView.tsx` (`[X]`)**: Added `[X]` calibration & learner profile Markdown export (`backups/studyhub-coach-YYYY-MM-DD.md`).
- **Tests**: `541` passing tests at `d160f5a1`.

### Round 69 — Zero-Allocation BMP CJK Fast-Path, Library Deck Export & Notes Filter/Export *(Completed: `c86e3489`)*
- **`src/render/cjk.ts` (zero-allocation BMP fast-path)**: Added `fastBmpWidth` / `bmpCharWidth` fast-path for safe non-combining BMP strings (`12.4ms` / 10k mixed CJK calls, `~2x` speedup on `perf-budget` Test 3 and `~26%` faster Markdown rendering).
- **`LibraryView.tsx` (`[x]`)**: Added `[x]` deck study sheet Markdown export (`backups/studyhub-deck-YYYY-MM-DD.md`) while keeping `dist/App.mjs` lean (`103.4KB`).
- **`NotesView.tsx` (`/`, `[x]`)**: Added `/` keyword filter across notes and migrated export to the shared `atomic-write.ts` helper.
- **Tests**: `548` passing tests at `c86e3489`.

### Round 70 — Full-Stack Certified Milestone: Math/Markdown Fast-Paths, Sources Catalog Export & Docs Sync *(Round 70 Milestone)*
- **`src/render/math.ts` & `src/render/markdown.ts`**: Added plain-text and plain-prose fast-paths to bypass heavy TeX/Markdown parsing when content has no math or formatting syntax.
- **`SourcesView.tsx` (`[x]`)**: Added `[x]` atomic materials catalog & citation coverage Markdown export (`backups/studyhub-sources-YYYY-MM-DD.md`), completing universal export coverage across StudyHub TUI views.
- **Milestone Docs & Certification**: Synced `HelpOverlay.tsx`, `docs/KEYBINDINGS.md`, `docs/ARCHITECTURE.md`, and `docs/ROADMAP-66-70.md` with full-stack verification (`ergonomics.test.mjs`, `keymap-audit.test.mjs`, `tsc --noEmit`, lint & lint-guard).
