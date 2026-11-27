# StudyHub TUI Roadmap — Rounds 56–60

> **Historical milestone archive**: Standalone `round56-60-*.test.mjs` files referenced below were later consolidated into current suites, and `useInput` references were later migrated to the P1 single dispatcher (`useScopedInput` / `useKeyScope`); see `docs/ARCHITECTURE.md` for current state.

> **Baseline at Round 55 (`22746d91`, `feat/studyhub-tui`)**:
> - **16 views** live + global `AppShell`, all **5 Barrel-Bypass rules** enforced (`0` importers across `render/index.js`, `components/index.js`, `host/index.js`), `0` `zod` runtime imports, `9` minimal runtime dependencies.
> - **Round 55 gate**: `425+` automated TUI tests across `120+` suites, permanent AST P2 quota-guard audit (`tests/p2-quota-audit.test.mjs`), `52/74` (`51+` non-markdown) entry chunks locked `marked`-free (`tests/perf-budget.test.mjs`), `0` AST keymap conflicts, and `0` `--ascii` / `NO_COLOR=1` leaks.
>
> **Round 60 Milestone (`feat/studyhub-tui`)**:
> - **Full-Stack Web-UI Parity, Cross-Platform Ergonomics & Update Lifecycle Complete**: Shipped deck course reassignment, weak-topics fill, CSDN publish assist, Book AI explain modal, semantic retrieval diagnostics + hybrid preview + mirror endpoint, opt-in SGR 1006 mouse wheel scrolling (`--mouse` / `--no-mouse` / `STUDYHUB_TUI_MOUSE`), guided study prerequisite branching & Q&A organize, Book/ExamPrep settings parity + smooth scrolling, full workflow context inspector, AI coach nudge & quick check (`CoachNudgeModal`), manual release update check + snooze, and live terminal capabilities diagnostics.
> - **Verified quality & guardrail bar**: `470+` automated TUI tests across `135+` suites (`425+ -> 470+` trajectory across Rounds 55–60), **permanent AST P2 quota-guard audit** (`tests/p2-quota-audit.test.mjs`, enforcing `generation.courseBook.explain`, `coach.nudge`, `coach.reply` across `13+` guarded view/modal files), **`53+` non-markdown entry chunks locked `marked`-free** in `tests/perf-budget.test.mjs` (including `BookExplainModal-` and `CoachNudgeModal-`), `0` AST keymap conflicts, and `0` `--ascii` / `NO_COLOR=1` leaks.

---

## Completed Rounds 56–60

### Round 56 — Deck Course Reassign, Generate Weak-Topics Fill & Notes CSDN Publish Assist *(Completed: `b1554784`)*
- **`DeckManageModal.tsx` (`[C]`)**: Wired `[C]` deck course reassignment (`deck.course`) inside the Deck Card Manager so decks can be moved across courses cleanly.
- **`GenerateView.tsx` (`[W]`)**: Wired `[W]` (`generate.weakTopics`) to auto-populate focus instructions from the active course's weak topics (0 LLM tokens).
- **`NotesView.tsx` (`Ctrl+P`, `Ctrl+L`)**: Added CSDN publishing helpers in the publish-link modal: `Ctrl+P` (`note.preparePublish`) prepares the publish baseline and `Ctrl+L` (`note.lookup`) looks up the published article URL.
- **Tests**: `round56-deck-course.test.mjs`, `round56-gen-weak-topics.test.mjs`, `round56-note-publish.test.mjs`.

### Round 57 — Book AI Explain Modal, Retrieval Diagnostics & SGR Mouse Wheel Scrolling *(Completed: `2e0c2756`)*
- **`BookExplainModal.tsx` & `BookView.tsx` (`[E]`)**: Added lazy, `marked`-free `BookExplainModal` wired to `[E]` with P2 `ConfirmDialog` quota guard before `generation.courseBook.explain` to explain or supplement Review Book sections.
- **`WorkspaceTab.tsx` (`[t]`)**: Added `RetrievalDiagModal` (`retrieval.index.plan` + `retrieval.test`, 0 LLM tokens) displaying active search provider verdict and page-level index plan.
- **`VirtualList.tsx` & `ScrollView.tsx`**: Added `parseSgrWheelDelta` and `useSgrMouseWheel` for SGR 1006 mouse wheel scrolling (`±3` rows per tick, supporting both intact `\x1b[<64;c;rM` via stdin tap and ESC-stripped `[<64;c;rM` / `<64;c;rM` via `useInput`).
- **Tests**: `round57-book-explain.test.mjs`, `round57-retrieval-diag.test.mjs`, `round57-scroll-mouse.test.mjs`.

### Round 58 — Opt-In SGR Mouse TTY Lifecycle, Retrieval Preview/Mirror & Guided Study Branching *(Completed: `a28af159`)*
- **`cli-args.ts`, `cli.tsx`, `terminal.ts`**: Added cross-platform opt-in `--mouse` / `--no-mouse` CLI flags and `STUDYHUB_TUI_MOUSE` env resolution (`shouldEnableMouse`), plus `ENABLE_SGR_MOUSE` / `DISABLE_SGR_MOUSE` TTY lifecycle and `signal-exit` teardown ordering.
- **`WorkspaceTab.tsx` (`RetrievalDiagModal` `[s]`, `[m]`)**: Added `[s]` local hybrid preview search (`retrieval.preview`, 0 LLM tokens) and `[m]` HuggingFace mirror endpoint configuration (`retrieval.endpoint.set`).
- **`GuidedStudyModal.tsx` (`[B]`, `[u]`)**: Wired prerequisite sub-branch opening (`[B]` `study.branch.open`) and return (`[u]` `study.branch.return`) inside AI Guided Study.
- **Tests**: `round58-cli-mouse-tty.test.mjs`, `round58-retrieval-tools.test.mjs`, `round58-study-branch.test.mjs`.

### Round 59 — Book/ExamPrep Settings Parity, Guided Q&A Organize & Workflow Context Inspector *(Completed: `3da119af`)*
- **`StudyGenTab.tsx`**: Added 5 Web-UI parity settings rows (`book_coverage`, `book_inlinePractice`, `book_confusableDrill` via `settings.book.set`; `examprep_autoRoles`, `examprep_showOtherCourses` via `settings.examPrep.set`) plus smooth cursor-following viewport scrolling (`nextScrollOffset`, `scrollbarThumb`, `PageUp`/`PageDown`, `Ctrl+D`/`Ctrl+U`, `useSgrMouseWheel`).
- **`GuidedStudyModal.tsx` (`[Q]`)**: Added `[Q]` (`study.qa.organize`, 0 LLM tokens) form to save organized session Q&A into flashcards.
- **`WorkflowHistoryModal.tsx` (`[Enter]` / `[c]`)**: Added read-only `ScrollView` workflow context inspector (`workflow.context` & `workflow.session.get`, 0 LLM tokens, `marked`-free).
- **Tests**: `round59-study-settings.test.mjs`, `round59-guided-qa.test.mjs`, `round59-workflow-ctx.test.mjs`.

### Round 60 — Milestone Release: Coach Nudge & Check, Release Update Checker, Terminal Capabilities & Guardrail Lock-In *(Round 60 (Milestone))*
- **`ReviewView.tsx` & `CoachNudgeModal.tsx` (`[N]`)**: Wired `[N]` on non-exam cards with grade `< 3` to a new lazy, `marked`-free `CoachNudgeModal` supporting P2 `ConfirmDialog`-guarded `coach.nudge` generation, 0-token `coach.reply` quick check (`[1]`/`[2]`) and understood (`[o]`/`[k]`, `got`), and P2 `ConfirmDialog`-guarded follow-up (`[c]`, `confused`).
- **`WorkspaceTab.tsx` (`[A]`, `[z]`)**: Wired `[A]` manual release update check (`update.check { force: true }`) into an inline `marked`-free modal with `[r]` re-check, `[z]` snooze/unsnooze (`update.preferences`), and graceful offline/error handling.
- **`AppearanceTab.tsx`**: Added a live, read-only terminal capabilities strip displaying platform, viewport dimensions, `ColorLevel` (`L0`–`L3`), ASCII/Unicode & Math render mode, and SGR 1006 mouse wheel status.
- **Permanent P2 AST & Bundle Guardrails**: Locked `coach.nudge` and `coach.reply` in `tests/p2-quota-audit.test.mjs` (`guardedFiles.length >= 12`), locked `CoachNudgeModal-` as `marked`-free in `tests/perf-budget.test.mjs` Test 7, and synced `HelpOverlay.tsx`, `docs/KEYBINDINGS.md`, `docs/ARCHITECTURE.md`, and `docs/ROADMAP-56-60.md`.
- **Tests**: `round60-coach-nudge.test.mjs`, `round60-update-caps.test.mjs`, `p2-quota-audit.test.mjs`, `perf-budget.test.mjs`.
