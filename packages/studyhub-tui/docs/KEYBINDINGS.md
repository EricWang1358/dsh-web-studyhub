# StudyHub TUI Keybindings Reference

Complete keyboard reference for `@ericwang1358/studyhub-tui`, synchronized with `src/shell/AppShell.tsx`, `src/shell/HelpOverlay.tsx`, `src/shell/CommandPalette.tsx`, `src/components/TextInput.tsx`, and all 16 view modules.

> **Convention**: Keys shown in `Title/Lower` case are case-sensitive (`g` vs `G`, `r` vs `R`). Global shortcuts are automatically yielded whenever a text input, modal, or view-claimed key (`useClaimKeys`) is active.

---

## 1. Global Navigation & Overlays

| Key | Action | Notes |
| --- | --- | --- |
| `Ctrl+K` / `/` | Command palette & search | Opens Command Palette v3 (`Ctrl+K` toggles even during overlays) |
| `?` | Context help overlay | Shows global, current-page, and feature shortcuts (`?` / `q` / `Esc` closes) |
| `c` | Switch course | Opens `CoursePickerModal` |
| `I` | Notification inbox | Opens `InboxModal` |
| `1-9`, `0`, `n`, `b`, `t`, `a`, `,`, `r` | Jump directly to page | See 16-page registry below |
| `[` / `]` | Previous / next page | Cycles across the 15 main nav pages (`group !== null`) |
| `Backspace` (`Bksp`) | Go back | Pops navigation history |
| `\` | Toggle sidebar | Collapses or expands `SideNav` (auto-collapses when `columns < 100`) |
| `Ctrl+R` | Force refresh | Reloads snapshot from StudyRuntime host |
| `q` / `Ctrl+C` | Quit | Exits cleanly and restores terminal alt-screen/cursor |
| `j` / `k` or `↑` / `↓` | Move up / down | Lists, trees, and scrollable panes |
| `Ctrl+D` / `Ctrl+U` | Half-page scroll down / up | Active in `ScrollView` / `VirtualList` |
| `Ctrl+F` / `Ctrl+B` (`PgDn` / `PgUp`) | Full-page scroll down / up | `Space` also pages down in `ScrollView` |
| `g` / `G` (`Home` / `End`) | Jump to top / bottom | Active in `ScrollView` / `VirtualList` |
| `Mouse Wheel` | Scroll up / down (3 rows) | Opt-in SGR 1006 wheel lifecycle (`--mouse` / `--no-mouse` / `STUDYHUB_TUI_MOUSE=1`, intact & ESC-stripped, disabled before alt-screen exit) in `VirtualList` & `ScrollView` |
| `Esc` | Close / cancel | Closes active modal, drawer, or palette |

### Page Jump Shortcuts (`PAGE_REGISTRY`)

| Key | Page ID | Name (EN / ZH) | Group |
| --- | --- | --- | --- |
| `1` | `library` | Library / 学习库 | Daily |
| `2` | `sources` | Sources / 资料 | Daily |
| `3` | `generate` | Generate / 创建题组 | Daily |
| `4` | `wrongbook` | Mistakes / 错题本 | Daily |
| `5` | `exam` | Mock Exam / 模拟考试 | Exam |
| `6` | `dashboard` | Stats / 学习统计 | Exam |
| `7` | `book` | Book / 复习全书 | Exam |
| `8` | `skeleton` | Skeleton / 知识骨架 | Exam |
| `9` | `examcoach` | Coach / 考试教练 | Exam |
| `0` | `examprep` | Exam Prep / 备考补习 | Exam |
| `n` | `notes` | Notes / 学习笔记 | Tools |
| `b` | `board` | Board / 待办看板 | Tools |
| `t` | `tasks` | Jobs / 后台任务 | Tools |
| `a` | `audio` | Audio / 音频转写 | Tools |
| `,` | `settings` | Settings / 设置 | Tools |
| `r` | `review` | Review / 刷题复习 | Practice |

---

## 2. TextInput & Multiline Editing

Applies to all `<TextInput>` fields (paste input automatically strips ANSI escapes and orphaned `200~`/`201~` bracketed-paste markers):

| Key | Single-line | Multiline (`multiline={true}`) |
| --- | --- | --- |
| `Enter` | Submit (`onSubmit`) | Insert newline (or submit when `submitOnEnter` is set) |
| `Ctrl+S` | — | Submit (`onSubmit`) |
| `Ctrl+J` / `Shift+Enter` | — | Insert newline |
| `Alt+Enter` | — | Insert newline when `submitOnEnter` is set |
| `Esc` | Cancel (`onCancel`) | Cancel (`onCancel`) |
| `Tab` | Path / field completion (`onTab`) | Path / field completion (`onTab`) |
| `←` / `→` | Move char left / right | Move char left / right |
| `Alt+←/→` or `Ctrl+←/→` | Move word left / right | Move word left / right |
| `↑` / `↓` | — | Move cursor up / down one line |
| `Home` / `Ctrl+A` | Start of input | Start of current line |
| `End` / `Ctrl+E` | End of input | End of current line |
| `Backspace` / `Delete` | Delete previous / next char | Delete previous / next char |
| `Alt+Backspace` / `Ctrl+W` | Delete previous word | Delete previous word |
| `Ctrl+U` / `Ctrl+K` | Clear to line start / end | Clear to cursor start / end |

---

## 3. Command Palette v3 Scoped Prefixes

Open the palette with `Ctrl+K` or `/`. Prefix the query to scope results immediately:

| Prefix | Scope | Behavior |
| --- | --- | --- |
| `/` | Commands (`cmd`) | Filters slash commands (`/sample`, `/theme`, `/lang`, `/ascii`, `/math`, `/recover`, `/model`, `/voicepack`, `/inbox`, `/refresh`, `/course`, `/import`, `/sidebar`, `/help`, `/back`, `/quit`, and direct page jumps `/review`, `/book`, `/exam`, `/skeleton`, `/wrongbook`, `/tasks`, `/audio`, `/settings`) |
| `#` | Cards (`card`) | Live full-text question search (`card.search`, min 2 chars); Enter starts focused practice |
| `?` | Passages (`passage`) | Live source passage search (`search.content`, min 2 chars); Enter opens `DocumentReader` at exact page |
| `@` | Courses (`course`) | Filters courses and switches active course focus |
| `:` | Pages (`page`) | Filters all 16 TUI views for instant jump |

Inside the palette: `↑`/`↓`, `Ctrl+P`/`Ctrl+N`, or `Ctrl+J`/`Ctrl+K` move selection; `PgUp`/`PgDn` jump a page; `Enter` executes and saves to recent frecency (`tui.json`); `Esc` closes.

---

## 4. Per-View Power Shortcuts

### `1` Library (`library`)
- **Practice & Rounds**: `Enter` start deck / open work item · `R` custom round configurator (`RoundConfigModal`) · `r` resume or start review · `p` daily plan · `g` AI Guided Study (`GuidedStudyModal`: `B` open prerequisite branch via `study.branch.open`, `u` return from branch via `study.branch.return`, `Q` save organized Q&A to card via `study.qa.organize`)
- **Deck & Course Ops**: `o` deck import / merge / split (`DeckOpsModal`: Import tab `Ctrl+G` P2-guarded AI filing proposal `draft.import.propose`; Merge tab `g` P2-guarded AI merge suggestions `deck.merge.suggest`, `a` apply proposal) · `[` / `]` reorder selected deck up / down · `C` course settings (tabs `1-4`: `m` merge course, `a` activate/deactivate course; Terms tab: `Space` toggle term mark, `C` clear all terms, `/` filter) · `v` voice pack · `a` archive/unarchive · `d` delete deck · `h` show/hide archived · `s` load/remove sample course · `Tab` toggle Decks / Drafts & Failed Jobs (`y` retries failed job)
- **Deck Card Manager (`m`)**: `+` supplement cards · `k` convert card kind · `u` restore slain card (Slain deck / slain card) · `m` move deck to folder (non-system decks) · `Space` multi-select (up to 100) · `F` batch focus · `S` batch suspend · `T` batch retag topic · `L` batch link prerequisite · `X` batch slay · `C` reassign deck course (`deck.course`) · `x` clear selection · `/` or `f` search · `c` clear search · `n` rename · `e` open draft · `p` practise deck

### `r` Review (`review`)
- **Answering**: `1-6` / `a-f` select MCQ (`Space` toggles multi-select, `Enter` submits) · `1/t` & `2/f` True/False · `i` / `Enter` edit fill-blank or open answer (`Tab`/`Shift+Tab` cycle blanks; auto-draft persisted on edit & restored on resume) · `Space` / `Enter` flip flashcard
- **FSRS-6 Rating & Flow**: `0-5` six-grade rating · `u` undo last rating · `Enter` / `.` next card · `,` / `←` / `→` prev/next card · `s` skip · `q` end round (with confirmation)
- **Round Summary**: `j` / `k` select row · `Enter` / `Space` / `v` toggle answer preview · `d` P2-guarded round AI debrief (`coach.debrief`) · `w` retry weak cards · `g` daily recap · `r` new round · `Esc` / `b` / `1` back to Library
- **Card Tools & AI**: `h` AI Help drawer · `L` Socratic teach · `F` Feynman retell · `G` AI rubric grade (`J` manual AI grade adjust, `K` acknowledge delayed correction) · `T` translate card · `S` similar cards · `D` card tools (edit, suspend/slay, prereqs, terms, P2-safe quality feedback `coach.feedback`, revert last rewrite `coach.revert`, `[R]` P2-guarded retry failed rewrite `coach.rewrite.retry`) · `A` answer card & drills · `Q` live queue editor (non-exam) · `*` toggle focus · `E` flag card · `o` jump to cited source page · `m` toggle Unicode/LaTeX math

### `2` Sources & DocumentReader (`sources`)
- **Sources List**: `Enter` open `DocumentReader` · `Space` multi-select (`[m]` batch move folder via `source.folder.set { keys }`, `[a]` batch archive/restore, `[E]` batch enrich metadata, `Esc` clear selection) · `E` enrich deterministic metadata (`materials.enrich`, 0-token) · `i` import source (Tab path completion) · `M` MinerU scanned/long PDF planner · `O` original file attachment & verification (`OriginalFileModal`: attach `reference`/`copy`, probe, detach while keeping disk files) · `g` generate questions · `G` AI organize into courses (`OrganizeSourcesModal`, P2 `ConfirmDialog` guard before `source.organize.suggest`) · `V` citation coverage & linked cards (`SourceCoverageModal`: `Tab` / `1`/`2` switch Coverage / Linked Cards; Tab 2 `p` / `Enter` practise linked cards) · `F` folder filter / `m` move to folder (`FolderModal`: `a` create, `r` rename, `d` delete, `g` AI classify folders [P2 quota-guarded], `0`/`x` clear) · `C` companions builder & sync · `R` reread queue · `r` rename · `c` set course · `p` pin/unpin · `[` / `]` reorder pinned material up / down · `a` archive · `d` delete · `/` filter · `f` filter by active course
- **DocumentReader**: Automatic last-read page resume (`lastReadPages` persisted across sessions in `tui.json`, capped at 100 recent documents; explicit page/citation jumps preserve target page) · `[` / `]` previous / next page · `O` outline TOC drawer (`Space`/`m` toggle chapter read, `g` AI suggest, `s` save proposal, `X` clear custom AI outline) · `H` mark/highlight passage (`MarkPassageModal`: `j`/`k` pick passage, `1-4`/`Tab` style, `Enter` save) · `B` bookmarks & notes drawer (`ReaderNotesDrawer`: `Tab` Annotations/Marks, `Enter` jump page; Annotations `d` delete; Marks `r` mark reread, `d` delete mark, `S` purge stale marks) · `G` translation glossary & saved translations (`TranslationGlossaryModal`: `Tab`/`1`/`2` Glossary & Saved, `a` add term, `d` delete, `l` toggle `zh`/`en`, `C` clear saved) · `M` toggle chapter read · `a` ask AI on current page (`s` saves reply to note, `f` saves grounded Q&A as flashcard) · `t` bilingual translate page (cache-first + cost estimate + P2 `ConfirmDialog` quota guard; inside translation pane: `L` switch target language, `R` retranslate) · `g` jump to page · `/` search in page · `m` toggle Unicode/LaTeX math · `q` generate from page · `p` practise page · `Esc` / `Backspace` close reader

### `3` Generate & Drafts (`generate`)
- **New Generation**: `Tab` switch to Drafts · `Space` toggle source · `a` select/clear all sources · `i` capture & ingest existing cards · `c` cycle course · `k` cycle question kind · `n` cycle count · `p` page range scope · `f` focus instructions · `W` fill course weak topics (`generate.weakTopics`) · `S` AI suggest strategy (`generate.suggest`, P2 `ConfirmDialog` quota-guarded; also opens model settings when unconfigured) · `Ctrl+S` start generation
- **DraftEditor**: `d` switch draft · `e` edit selected card (`Ctrl+N` switch field, `Ctrl+S` save) · `x` remove card from draft · `u` undo last removed draft card · `S` / `s` check similar cards · `R` repair draft · `P` publish draft to deck · `D` delete entire draft

### `4` Mistakes / Wrong Book (`wrongbook`)
- `Tab` / `h` / `l` switch tabs · `Space` multi-select · `B` / `P` batch practice · `V` practise prepared coach variants (`coach.practice`) · `x` clear selection / similar cards · `e` tag wrong reason · `t` 0-token triage · `f` filter by reason · `Enter` / `p` practise selected · `m` toggle math · `J` / `K` scroll detail pane · `R` reload

### `5` Mock Exam (`exam`)
- **Setup**: `Tab` / `h` / `l` switch Setup / History · `1` / `2` / `3` Written MCQ / Case / Oral · `c` question count · `t` time limit · `k` question kinds · `r` resume active exam
- **Runner**: `1-9` select/toggle options · `f` flag question · `n` / `p` / `Tab` / `Shift+Tab` / `←` / `→` step questions · `s` toggle case scenario pane · `H` highlight paragraph · `[` / `]` step paragraphs · `Ctrl+S` submit exam

### `6` Stats / Dashboard (`dashboard`)
- `j` / `k` select weak topic or course · `Enter` / `p` drill selected item · `w` practise all weak questions · `f` toggle 7-day forecast · `m` study map & prerequisite graph (`StudyMapModal`: `Tab`/`1`/`2` switch Mastery Map / Prerequisite Graph, `s` toggle scope, `/` filter, `c` clear, `r` refresh, `Enter` practise) · `r` refresh

### `7` Review Book (`book`)
- `Tab` / `h` / `l` switch TOC / reading pane · `m` toggle Unicode/LaTeX math · `e` edit or revert (`[u]`) section · `E` P2-guarded AI explain / add section (`BookExplainModal`, `generation.courseBook.explain`) · `R` rename TOC node · `[` / `]` move node up/down among siblings · `D` delete node (keeps notes in Unplaced) · `z` revert last structure change · `U` place unplaced section into target leaf point (`BookStructureModal`) · `T` Feynman retell selected point (`BookRetellModal`) · `M` chapter/point mock paper (`book.mock.plan` + `book.mock`, opens Exam) · `p` practise 5 cards · `P` pinned book QA & section Q&A (`course.outline.qa`) · `w` final-week crunch & mock · `x` export Markdown · `g` build/rebuild book (`a` apply / `u` undo when rebuild-pending) · `r` refresh

### `8` Skeleton (`skeleton`)
- `j` / `k` move node · `Space` / `Enter` / `h` / `l` expand/collapse · `Tab` switch pane · `p` practise node · `E` edit skeleton node · `R` course learning route · `G` topic groups manager · `L` skeleton lint · `M` interactive HTML diagrams manager (`SkeletonDiagramsModal`: `a` attach UTF-8 HTML `<= 5 MB`, `Enter` inspect, `d` remove, max 8) · `g` generate skeleton · `s` switch skeleton · `D` delete skeleton (removes diagrams; keeps decks/cards) · `r` refresh

### `9` Exam Coach (`examcoach`)
- `1-4` switch Calibration / Variants / Evidence / Compile tabs · `p` / `P` coach profile, prefs & memory bullets (`CoachPreferencesModal`: `Tab`/`1`/`2` switch Preferences & Memory Bullets tabs; Preferences `a` add, `d` remove, `x` clear all; Memory Bullets `a` add bullet, `d` remove selected bullet; `g` cycle learning goal, `p` toggle auto-prep consent, `F` forget/reset profile & prepared cards, `r` refresh) · `f` P2-guarded flush coach prep queue (`coach.prepare`) · `a` / `A` analyze / AI deepen · `N` past paper notes · `v` reveal sample answer · `x` / `y` / `z` three-item confirmation · `e` edit quota · `g` / `G` generate variants / batch · `b` compile preview · `m` mock check · `r` refresh

### `0` Exam Prep (`examprep`)
- `1` / `2` switch Focus / Crunch tabs · `a` add focus point (`AddFocusModal`: `Ctrl+T` cycle Text / Image / AI Match Topics, `Ctrl+G` jump/trigger `focus.suggest` with P2 quota-guarded `ConfirmDialog`, `Ctrl+E` extract, `Ctrl+S` save) · `d` remove focus point · `p` practise unmastered / mock · `g` / `G` gap-fill generation · `P` study plan & custom wizard · `Space` mark seen (Crunch) · `m` mark read (Crunch)

### `n` Notes (`notes`)
- `Tab` / `h` / `l` switch list / reader pane · `a` new note · `e` edit draft note · `g` P2-guarded AI draft note (`note.generate`) · `L` publish link (`Ctrl+P` prepare publish baseline via `note.preparePublish`, `Ctrl+L` auto-lookup published article via `note.lookup`, `Tab` edit CSDN home, `Enter` save link) · `M` import note to Sources library · `o` / `O` jump to linked card or source · `R` generate daily recap · `C` cancel note / daily recap generation (`note.cancel` / `note.daily.cancel`) · `x` export Markdown · `d` delete note · `f` filter active course · `m` toggle math

### `b` Board (`board`)
- **Kanban**: `h` / `l` switch column · `j` / `k` move card · `H` / `L` / `m` move card across columns · `a` add card · `e` / `Enter` edit card · `d` delete card · `S` sync StudyHub board · `r` reload
- **Pomodoro**: `P` / `Space` start/pause timer · `M` switch focus/break mode · `+` / `-` adjust minutes · `R` reset timer

### `t` Jobs / Tasks (`tasks`)
- `1` / `2` / `3` / `Tab` filter Running / All / Archived · `p` pause/resume job queue · `+` / `-` adjust queue concurrency · `R` recover interrupted jobs · `o` live output modal · `m` send refinement message to active job · `w` workflow history & context inspector (`WorkflowHistoryModal`: `Enter`/`c` inspect full `workflow.context` & `workflow.session.get`, `b`/`Esc` back to list, `r` refresh) · `v` toggle output / trace · `e` export trace JSON · `D` purge saved traces · `Enter` open draft · `x` cancel job · `a` archive/restore · `d` dismiss/delete

### `a` Audio (`audio`)
- `i` import audio file (with Tab path completion) · `u` import subtitles (`.srt`/`.vtt`/`.txt`/`.json`) · `p` preflight diagnostics · `c` review transcript corrections (P2-guarded) · `R` retry failed job · `s` transcription provider settings · `t` test provider connectivity · `g` generate questions from transcript · `r` refresh

### `,` Settings (`settings`)
- `1-4` switch Models / Workspace / StudyGen / Appearance tabs
- **Models (`1`)**: `Tab` switch pane · `a` / `Enter` save & activate · `t` test connection · `s` rescan / save
- **Workspace (`2`)**: `e` change library root · `c` confirm library location · `s` toggle sample course · `f` toggle experimental features · `v` cycle semantic retrieval provider (`retrieval.set` + displays `retrieval.index.coverage`) · `t` semantic retrieval diagnostics & index plan (`retrieval.index.plan` + `retrieval.test`; inside modal: `s` local hybrid preview search via `retrieval.preview`, `m` HuggingFace mirror endpoint via `retrieval.endpoint.set`) · `u` toggle usage frequency tracking · `U` clear usage data · `a` toggle auto update check (`update.preferences`) · `x` export JSON backup · `r` refresh restore points / retrieval / usage / update prefs · `Enter` restore selected point
- **StudyGen (`3`)** & **Appearance (`4`)**: `j` / `k` (`↑` / `↓`) select option across smoothly scrollable rows (`22` StudyGen rows including Book `qaToBook`, `coverage`, `inlinePractice`, `confusableDrill` via `settings.book.set`; ExamPrep `autoRoles`, `showOtherCourses` via `settings.examPrep.set`; Practice reset; and ExamPrep reset) · `←` / `→` (`Enter` / `Space`) adjust/toggle & save
