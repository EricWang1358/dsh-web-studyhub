# StudyHub TUI Roadmap — Rounds 41–50

> **Historical milestone archive**: Standalone `round41-50-*.test.mjs` files referenced below were later consolidated into current suites, and `ReaderNotesDrawer`'s seen/reread toggle has since moved to `[R]`; see `docs/KEYBINDINGS.md` and `docs/ARCHITECTURE.md` for current state.

> **Baseline at Round 40 (`48b64afb`, `feat/studyhub-tui`)**:
> - **16 views** live (`Library`, `Review`, `Sources`, `Generate`, `WrongBook`, `Exam`, `Dashboard`, `Book`, `Skeleton`, `ExamCoach`, `ExamPrep`, `Notes`, `Board`, `Tasks`, `Audio`, `Settings`) + global `AppShell`.
> - **Round 40 gate**: `318/318` TUI tests (`0` failures), `34/34` Live + Core, `0` AST keymap conflicts, `0` `zod` runtime imports, `9` minimal runtime dependencies.
>
> **Round 50 Milestone (`feat/studyhub-tui`)**:
> - **Verified quality & NFR bar**: `385+` automated TUI tests across `82+` suites, all **5 Barrel-Bypass rules** enforced (`0` importers of `render/index.js`, `components/index.js`, and `host/index.js` across `src/`), `49+/71` entry chunks `marked`-free (`tests/perf-budget.test.mjs`), `0` `zod` runtime imports, `9` minimal runtime dependencies, grapheme-cluster + CSI-u hardened `TextInput`, `0` AST keymap conflicts, and `0` `--ascii` / `NO_COLOR=1` leaks.

---

## Completed Rounds 41–50

### Round 41 — Book Retell, Review Auto-Draft & Course Terms *(Completed: `104d751b`, `326/326`)*
- **BookView `[T]` (`BookRetellModal`)**: P2 quota-guarded Feynman retell on selected outline point (`course.book.retell`).
- **ReviewView & CardTools**: Auto-draft persistence (`review.draft.save` / restore on resume) and `CardToolsModal` placement controls.
- **CourseSettingsModal**: Terms tab `[Space]` mark toggle and `[C]` clear-all terms.
- **Tests**: `round41-book-retell.test.mjs`, `round41-course-terms.test.mjs`, `round41-review-draft.test.mjs`.

### Round 42 — Reader Mark Lifecycle, Chapter Mock & Study Map *(Completed: `a0429a2b`, `333/333`)*
- **ReaderNotesDrawer**: Full mark lifecycle (`seen` toggle `[r]`, delete `[d]`, purge stale `[S]`).
- **BookView `[M]` & `[P]`**: Chapter/point mock exam launch (`book.mock.plan` + `book.mock`) and outline section Q&A (`course.outline.qa`).
- **DashboardView `[m]`**: Lazy `StudyMapModal` mastery map explorer.
- **Tests**: `round42-book-mock.test.mjs`, `round42-dashboard-map.test.mjs`, `round42-reader-marks.test.mjs`.

### Round 43 — Reread Queue, Coach Consent/Forget & Job Queue Control *(Completed: `85dd6e27`, `340/340`)*
- **SourcesView `[R]` (`RereadQueueModal`)**: Dedicated reread queue viewer & direct jump into `DocumentReader`.
- **CoachPreferencesModal (`[p]` / `[F]`)**: P2-guarded auto-prep consent toggle (`[p]`) and profile/prepared-card forget (`[F]`).
- **TasksView (`[p]` / `[+/-]`)**: Live job queue pause/resume and concurrency adjustment.
- **Tests**: `round43-coach-consent.test.mjs`, `round43-jobs-control.test.mjs`, `round43-reread-queue.test.mjs`.

### Round 44 — Passage Marks, AI Generation Strategy & WrongBook Coach Variants *(Completed: `e9c4f6e2`, `347/347`)*
- **DocumentReader `[H]` (`MarkPassageModal`)**: Paragraph-level highlight/mark creation with 4 styles.
- **GenerateView `[S]`**: P2 quota-guarded `generate.suggest` strategy advice (falls back cleanly to model setup if unconfigured).
- **WrongBookView `[V]`**: Direct launch of prepared coach variants (`coach.practice`).
- **Tests**: `round44-gen-suggest.test.mjs`, `round44-mark-save.test.mjs`, `round44-wrongbook-coach.test.mjs`.

### Round 45 — Prerequisite Graph, AddFocus AI Match, Outline Clear & Auto-Update *(Completed: `a7550518`, `354/354` + `34/34` Live + Core)*
- **StudyMapModal Tab 2**: Prerequisite dependency graph view alongside Mastery Map.
- **AddFocusModal (`[Ctrl+G]`)**: P2 quota-guarded `focus.suggest` topic matching inside `ExamPrepView`.
- **ReaderOutlineDrawer `[X]`**: Custom AI outline clear (`materials.outline.clear`) with `ConfirmDialog`.
- **WorkspaceTab `[a]`**: Automatic update check preference toggle (`update.preferences`).
- **Tests**: `round45-focus-suggest.test.mjs`, `round45-outline-update.test.mjs`, `round45-study-graph.test.mjs`.

### Round 46 — `render/index.js` Barrel-Bypass, Batch Slay & Translation Glossary *(Completed: `57278fc3`, `360/360`)*
- **NFR Architecture**: Completed `render/index.js` Barrel-Bypass (`0` importers across `src/`, `172.8 MB` RSS).
- **DeckManageModal `[X]`**: Atomic batch slay (`card.slay.batch`) over multi-selected cards.
- **DocumentReader `[G]` (`TranslationGlossaryModal`)**: Per-course translation glossary & saved page translations manager.
- **Tests**: `round46-batch-slay.test.mjs`, `round46-glossary.test.mjs`.

### Round 47 — `components/index.js` Barrel-Bypass, Source Coverage Links & Batch Retag *(Completed: `27255c7f`, `365/365`)*
- **NFR Architecture**: Completed `components/index.js` Barrel-Bypass (`0` importers across `src/`, `49+/71` non-markdown `dist/*.mjs` entry chunks `marked`-free).
- **SourceCoverageModal Tab 2**: Linked cards & document mastery breakdown (`materials.pages.cards`, `materials.links.list`) with `[p]`/`Enter` practice launch.
- **DeckManageModal `[T]`**: Batch topic retag (`card.update.batch`).
- **Tests**: `round47-batch-topic.test.mjs`, `round47-source-links.test.mjs`.

### Round 48 — `host/index.js` Barrel-Bypass, Reader Page Resume & Sources Multi-Select *(Completed: `a746d1fe`, `372/372`)*
- **NFR Architecture**: Completed `host/index.js` Barrel-Bypass (`0` importers across all 5 barrels, `-32.5 KB` `App.mjs` closure, `firstFrameMs=111ms`).
- **DocumentReader**: Persistent `lastReadPages` auto-resume in `tui.json` (capped at 100 docs, preserving explicit page jumps).
- **SourcesView (`[Space]`, `[E]`)**: Multi-select batch move/archive/enrich (`source.folder.set { keys }`) and 0-token `materials.enrich`.
- **Tests**: `round48-reader-resume.test.mjs`, `round48-sources-batch.test.mjs`.

### Round 49 — `TextInput` Grapheme & CSI-u Hardening, Interrupted Run Recovery & Batch Prereq Link *(Completed: `fbfbb542`, `385/385`)*
- **Cross-Platform Input (`src/components/TextInput.tsx`)**: Switched cursor indexing to `splitGraphemes` (never splits ZWJ emoji, flags, or combining marks); hardened `sanitizePastedText` against CSI-u / `modifyOtherKeys` / orphaned `200~`/`201~` fragments; recognized orphaned CSI-u `Shift+Enter` (`13;2u`, `27;2;13~`) & `Ctrl+Enter` (`13;5u`, `27;5;13~`) in multiline mode.
- **TasksView `[R]`**: Interrupted coverage run recovery (`coverage.recover`, 0-token).
- **DeckManageModal `[L]`**: Batch prerequisite linking (`card.link.batch`).
- **Tests**: `round49-textinput-edge.test.mjs`, `round49-tasks-recover.test.mjs`, `round49-batch-link.test.mjs`.

### Round 50 — Milestone Release: Diagrams, Original Files, Retrieval Coverage & Docs Sync *(Completed: `15684e2e`)*
- **SkeletonView `[M]` (`SkeletonDiagramsModal`)**: Interactive HTML diagrams manager (`skeleton.diagram.list` / `.attach` / `.get` / `.remove`, max 8 diagrams).
- **SourcesView `[O]` (`OriginalFileModal`)**: Original file attachment (`reference`/`copy`), probe, verification, and safe disk-preserving detach (`materials.original.*`).
- **Settings `WorkspaceTab` `[v]`**: Live `retrieval.index.coverage` status display and provider cycling (`retrieval.set`).
- **Milestone Docs & Help Sync**: Updated `HelpOverlay.tsx`, `docs/KEYBINDINGS.md`, `docs/ARCHITECTURE.md`, and `docs/ROADMAP-41-50.md`.
- **Tests**: `round50-skel-diagrams.test.mjs`, `round50-orig-file.test.mjs`, `round50-retrieval-cov.test.mjs`.

---

## Candidate Tracks for Rounds 51–60

1. **DocumentReader Paragraph Translation & Side-by-Side Diff**: Per-paragraph translation trigger, inline bilingual toggle, and persisted translation edits synced with `TranslationGlossaryModal`.
2. **Audio Clip Transcription & Segment Corrections**: Segment-level audio playback markers, inline transcript correction editing, and selective clip-to-note / clip-to-card generation.
3. **Review Book Revision History & Snapshot Diff**: Section-level revision browser (`course.book.history`), line diff viewer, and one-key restore.
4. **Command Palette Deep Modal Actions**: Direct palette action dispatch into nested workflows (e.g., open `OriginalFileModal`, `SkeletonDiagramsModal`, `RoundConfigModal`, or switch retrieval provider directly from `Ctrl+K`).
5. **Windows ConPTY & NFR Tightening**: Automated Windows ConPTY PTY harness verification, tighter `App.mjs` / per-chunk byte budgets, and extended 128-transition soak memory ceilings.
