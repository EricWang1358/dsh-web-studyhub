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
| `/` | Commands (`cmd`) | Filters slash commands (`/sample`, `/theme`, `/lang`, `/model`, `/voicepack`, `/inbox`, `/refresh`, `/course`, `/import`, `/sidebar`, `/help`, `/back`, `/quit`) |
| `#` | Cards (`card`) | Live full-text question search (`card.search`, min 2 chars); Enter starts focused practice |
| `?` | Passages (`passage`) | Live source passage search (`search.content`, min 2 chars); Enter opens `DocumentReader` at exact page |
| `@` | Courses (`course`) | Filters courses and switches active course focus |
| `:` | Pages (`page`) | Filters all 16 TUI views for instant jump |

Inside the palette: `↑`/`↓`, `Ctrl+P`/`Ctrl+N`, or `Ctrl+J`/`Ctrl+K` move selection; `PgUp`/`PgDn` jump a page; `Enter` executes and saves to recent frecency (`tui.json`); `Esc` closes.

---

## 4. Per-View Power Shortcuts

### `1` Library (`library`)
- **Practice & Rounds**: `Enter` start deck / open work item · `R` custom round configurator (`RoundConfigModal`) · `r` resume or start review · `p` daily plan · `g` AI Guided Study
- **Deck & Course Ops**: `o` deck import / merge / split (`DeckOpsModal`) · `[` / `]` reorder selected deck up / down · `C` course settings · `v` voice pack · `a` archive/unarchive · `d` delete deck · `h` show/hide archived · `s` load/remove sample course · `Tab` toggle Decks / Drafts & Failed Jobs (`y` retries failed job)
- **Deck Card Manager (`m`)**: `+` supplement cards · `k` convert card kind · `Space` multi-select (up to 100) · `F` batch focus · `S` batch suspend · `x` clear selection · `/` or `f` search · `c` clear search · `n` rename · `e` open draft · `p` practise deck

### `r` Review (`review`)
- **Answering**: `1-6` / `a-f` select MCQ (`Space` toggles multi-select, `Enter` submits) · `1/t` & `2/f` True/False · `i` / `Enter` edit fill-blank or open answer (`Tab`/`Shift+Tab` cycle blanks) · `Space` / `Enter` flip flashcard
- **FSRS-6 Rating & Flow**: `0-5` six-grade rating · `u` undo last rating · `Enter` / `.` next card · `,` / `←` / `→` prev/next card · `s` skip · `q` end round (with confirmation)
- **Card Tools & AI**: `h` AI Help drawer · `L` Socratic teach · `F` Feynman retell · `G` AI rubric grade · `T` translate card · `S` similar cards · `D` card tools · `A` answer card & drills · `Q` live queue editor (non-exam) · `*` toggle focus · `E` flag card · `o` jump to cited source page · `m` toggle Unicode/LaTeX math

### `2` Sources & DocumentReader (`sources`)
- **Sources List**: `Enter` open `DocumentReader` · `i` import source (Tab path completion) · `M` MinerU scanned/long PDF planner · `g` generate questions · `G` AI organize into courses · `V` citation coverage · `F` folder filter · `m` move to folder · `C` companions builder & sync · `r` rename · `c` set course · `p` pin/unpin · `[` / `]` reorder pinned material up / down · `a` archive · `d` delete · `/` filter · `f` filter by active course
- **DocumentReader**: `[` / `]` previous / next page · `O` outline TOC drawer · `B` bookmarks & notes drawer · `a` ask AI on current page (`s` saves reply to note) · `t` translate page · `g` jump to page · `/` search in page · `m` toggle Unicode/LaTeX math · `q` generate from page · `p` practise page · `Esc` / `Backspace` close reader

### `3` Generate & Drafts (`generate`)
- **New Generation**: `Tab` switch to Drafts · `Space` toggle source · `a` select/clear all sources · `i` capture & ingest existing cards · `c` cycle course · `k` cycle question kind · `n` cycle count · `p` page range scope · `f` focus instructions · `Ctrl+S` start generation · `S` open model settings (when unconfigured)
- **DraftEditor**: `d` switch draft · `e` edit selected card (`Ctrl+N` switch field, `Ctrl+S` save) · `x` remove card from draft · `u` undo last removed draft card · `S` / `s` check similar cards · `R` repair draft · `P` publish draft to deck · `D` delete entire draft

### `4` Mistakes / Wrong Book (`wrongbook`)
- `Tab` / `h` / `l` switch tabs · `Space` multi-select · `B` / `P` batch practice · `x` clear selection / similar cards · `e` tag wrong reason · `t` 0-token triage · `f` filter by reason · `Enter` / `p` practise selected · `m` toggle math · `J` / `K` scroll detail pane · `R` reload

### `5` Mock Exam (`exam`)
- **Setup**: `Tab` / `h` / `l` switch Setup / History · `1` / `2` / `3` Written MCQ / Case / Oral · `c` question count · `t` time limit · `k` question kinds · `r` resume active exam
- **Runner**: `1-9` select/toggle options · `f` flag question · `n` / `p` / `Tab` / `Shift+Tab` / `←` / `→` step questions · `s` toggle case scenario pane · `H` highlight paragraph · `[` / `]` step paragraphs · `Ctrl+S` submit exam

### `6` Stats / Dashboard (`dashboard`)
- `j` / `k` select weak topic or course · `Enter` / `p` drill selected item · `w` practise all weak questions · `f` toggle 7-day forecast · `r` refresh

### `7` Review Book (`book`)
- `Tab` / `h` / `l` switch TOC / reading pane · `m` toggle Unicode/LaTeX math · `e` edit or revert (`[u]`) section · `R` rename TOC node · `[` / `]` move node up/down among siblings · `D` delete node (keeps notes in Unplaced) · `z` revert last structure change · `p` practise 5 cards · `P` pinned book QA · `w` final-week crunch & mock · `x` export Markdown · `g` build/rebuild book (`a` apply / `u` undo when rebuild-pending) · `r` refresh

### `8` Skeleton (`skeleton`)
- `j` / `k` move node · `Space` / `Enter` / `h` / `l` expand/collapse · `Tab` switch pane · `p` practise node · `E` edit skeleton node · `R` course learning route · `G` topic groups manager · `L` skeleton lint · `g` generate skeleton · `s` switch skeleton · `r` refresh

### `9` Exam Coach (`examcoach`)
- `1-4` switch Calibration / Variants / Evidence / Compile tabs · `p` / `P` coach profile & long-term prefs · `a` / `A` analyze / AI deepen · `N` past paper notes · `v` reveal sample answer · `x` / `y` / `z` three-item confirmation · `e` edit quota · `g` / `G` generate variants / batch · `b` compile preview · `m` mock check · `r` refresh

### `0` Exam Prep (`examprep`)
- `1` / `2` switch Focus / Crunch tabs · `a` add focus point · `d` remove focus point · `p` practise unmastered / mock · `g` / `G` gap-fill generation · `P` study plan & custom wizard · `Space` mark seen (Crunch) · `m` mark read (Crunch)

### `n` Notes (`notes`)
- `Tab` / `h` / `l` switch list / reader pane · `a` new note · `e` edit draft note · `o` / `O` jump to linked card or source · `R` generate daily recap · `x` export Markdown · `d` delete note · `f` filter active course · `m` toggle math

### `b` Board (`board`)
- **Kanban**: `h` / `l` switch column · `j` / `k` move card · `H` / `L` / `m` move card across columns · `a` add card · `e` / `Enter` edit card · `d` delete card · `S` sync StudyHub board · `r` reload
- **Pomodoro**: `P` / `Space` start/pause timer · `M` switch focus/break mode · `+` / `-` adjust minutes · `R` reset timer

### `t` Jobs / Tasks (`tasks`)
- `1` / `2` / `3` / `Tab` filter Running / All / Archived · `o` live output modal · `m` send refinement message to active job · `w` workflow history · `v` toggle output / trace · `e` export trace JSON · `D` purge saved traces · `Enter` open draft · `x` cancel job · `a` archive/restore · `d` dismiss/delete

### `a` Audio (`audio`)
- `i` import audio file (with Tab path completion) · `s` transcription provider settings · `t` test provider connectivity · `g` generate questions from transcript · `r` refresh

### `,` Settings (`settings`)
- `1-4` switch Models / Workspace / StudyGen / Appearance tabs
- **Models (`1`)**: `Tab` switch pane · `a` / `Enter` save & activate · `t` test connection · `s` rescan / save
- **Workspace (`2`)**: `e` change library root · `s` toggle sample course · `x` export JSON backup · `r` refresh restore points · `Enter` restore selected point
- **StudyGen (`3`)** & **Appearance (`4`)**: `j` / `k` select option · `←` / `→` (`Enter`) adjust/toggle & save
