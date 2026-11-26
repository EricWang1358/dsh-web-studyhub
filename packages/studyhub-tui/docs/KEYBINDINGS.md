# StudyHub TUI Keybindings Reference

Complete keyboard reference for `@ericwang1358/studyhub-tui`, synchronized with `src/input/dispatcher.ts`, `src/input/hooks.ts`, `src/shell/AppShell.tsx`, `src/shell/global-keymap.ts`, `src/shell/HelpOverlay.tsx`, `src/shell/CommandPalette.tsx`, `src/components/TextInput.tsx`, and all 16 view modules.

> **Convention**: Keys shown in `Title/Lower` case are case-sensitive (`g` vs `G`, `r` vs `R`). Reserved global keys (`r` return to review, `q` quit, `?` help) are never shadowed by any page. Other global shortcuts yield to view-claimed keys registered via `useKeyScope({ keys })` (or compatibility `useClaimKeys`), and `SideNav` automatically hides overridden shortcut hints. For a task-oriented Chinese tutorial, see [docs/GUIDE.md](./GUIDE.md) or run `/guide` in `Ctrl+K`.

---

## 0. Scope Stack & Priority Layers (`KEY_LAYER_*`)

All keyboard events for a given `stdin` pass through a single unified dispatcher hub (`src/input/dispatcher.ts`), bridged once in `AppShell` (`useKeyDispatcherBridge`).

- **LIFO Opaque Scope Stack**: `<KeyScope opaque>` (aliased as `<KeyScopeProvider>`) pushes an opaque frame `{ scopeId, depth, pushSeq }`. The top-most frame by `(depth DESC, pushSeq DESC)` exclusively owns keyboard routing — automatically masking underlying views and earlier sibling modals without manual boolean chains. Only `KEY_LAYER_SYSTEM` (`600`) bypasses opaque masking.
- **Deterministic Priority Order**: Among eligible active handlers, dispatch sorts by `(system ? 1 : 0) DESC, depth DESC, layer DESC, seq DESC`.
- **Single-Consumption Contract**: Returning `true` (or calling `ctx.consume()`) stops dispatch immediately so one keystroke never triggers two handlers.
- **`<KeyScope>` / `useKeyScope` Migration Status**: Primary views and modals use `<KeyScope>` + `useKeyScope({ id, active, layer, keys, onKey })` (unifying scoped dispatch, reactive `useScopeActive` masking, and `SideNav` key claiming). Legacy unmigrated modals and reusable widgets remain compatible on the same dispatcher hub via `useScopedInput` + `useClaimKeys`.

| Layer Constant | Priority | Scope & Role |
| --- | --- | --- |
| `KEY_LAYER_SYSTEM` | `600` | Always-reachable shell controls in `AppShell:system` (`Ctrl+C`, `Ctrl+K`, `Ctrl+Space`, `Ctrl+G`, `Ctrl+O`, `Ctrl+R`); never masked by opaque scopes |
| `KEY_LAYER_TEXT_INPUT` | `500` | Focused `<TextInput>` fields (character entry, cursor/word edits, paste, `Ctrl+U`/`Ctrl+K`/`Ctrl+W`) |
| `KEY_LAYER_MODAL` | `400` | Active modal & dialog body handlers (`ConfirmDialog`, `NotificationHistoryModal`, modal forms) |
| `KEY_LAYER_DRAWER` | `300` | Side drawers and docked panels |
| `KEY_LAYER_VIEW` | `200` | Active page / view handlers (default layer for `useKeyScope` and `useScopedInput`) |
| `KEY_LAYER_WIDGET` | `150` | Reusable navigation widgets (`VirtualList`, `ScrollView`, `SelectList`) |
| `KEY_LAYER_MODAL_FRAME` | `120` | `<Modal>` frame `Esc` close fallback (runs only if no higher layer in the modal consumed `Esc`) |
| `KEY_LAYER_GLOBAL` | `100` | `AppShell:global` single-key navigation & overlays (page jumps, `/`, `?`, `c`, `I`, `\`, `[`/`]`, `Backspace`, `q`, passive dock `Esc`) |

---

## 1. Global Navigation & Overlays

| Key | Action | Notes |
| --- | --- | --- |
| `Ctrl+K` / `/` | Command palette & search | Opens Command Palette v3 (`Ctrl+K` at `KEY_LAYER_SYSTEM` toggles closed when the palette is open and opens when no overlay/input is active; `/` opens at `KEY_LAYER_GLOBAL` when unclaimed) |
| `Ctrl+Space` / `Ctrl+G` | Right-docked AI Assistant & Guided Study | Non-blocking right dock (`Ctrl+Space` / `Ctrl+@` 1st press opens without stealing focus, 2nd press focuses, 3rd press collapses; `Ctrl+G` opens+focuses or collapses when focused/fullscreen); unified 2-step `Esc` on every docked page (1st `Esc` hands keyboard back keeping dock visible, 2nd `Esc` folds dock); inside `AssistantPanel`: `i`/`a`/`Enter` input, `1-4` context chips (2–4 chips), `Tab` Assistant/Guided+Retell, `o` expand earlier turns, `z` undo, `P` copy prompt, `A` apply fallback, `F` fullscreen, `c`/`C`/`y` OSC 52 copy, `S` skip retell (Retell stage), `n`/`p` next/prev turn (see [docs/ASSISTANT-UX.md](./ASSISTANT-UX.md)) |
| `?` | Context help overlay | Shows global, current-page, and feature shortcuts (`Tab` or `1`/`2` switches Shortcuts / In-App Guide, `j`/`k`/`Space`/`Ctrl+D`/`Ctrl+U` scrolls, `?` / `q` / `Esc` closes) |
| `c` | Switch course | Opens `CoursePickerModal` |
| `I` | Notification inbox & toast history | Opens `InboxModal` (`Tab` cycles All / Unread / Read, `h` toggles「近期提示」/ recent multi-line toast history keeping the last 50 notices, `C` clears toast history, `/` keyword filter, `c` clears filter, `e` atomic `inbox.raw` JSON export, `r` refresh, `m` toggle read, `M` mark all read, `Enter` open & mark read) |
| `Ctrl+O` | Notification history panel | Standalone recall of the last 50 notices with time / level / optional source; `j`/`k` or `↑`/`↓` selects, `c` / `y` / `Enter` copies the full entry (shared OSC 52 helper), `C` clears, `Ctrl+D` / `Ctrl+U` (half-page) and `PgDn` / `PgUp` (full-page) scroll the untruncated multi-line detail, `Esc` closes only this panel. Opening it pauses toast auto-dismiss without touching history |
| `1-9`, `0`, `n`, `b`, `t`, `a`, `,`, `r` | Jump directly to page | See 16-page `PAGE_REGISTRY` below |
| `[` / `]` | Previous / next page | Cycles across the 15 main nav pages (`group !== null`) |
| `Backspace` (`Bksp`) | Go back | Pops navigation history (unless claimed by current view) |
| `\` | Toggle sidebar | Collapses or expands `SideNav` (auto-collapses when `columns < 112`, `LAYOUT_BP.SIDENAV_AUTO_COLLAPSE`) |
| `Ctrl+R` | Force refresh | Reloads snapshot from StudyRuntime host (`KEY_LAYER_SYSTEM` lets active views also reload domain state) |
| `q` / `Ctrl+C` | Quit | Runs quit guard (`ConfirmDialog` when an exam/practice session is active; pressing `Ctrl+C` a second time while `ConfirmDialog` is open force-quits immediately) and restores terminal alt-screen/cursor |
| `j` / `k` or `↑` / `↓` | Move up / down | Lists, trees, and scrollable panes (`SelectList` also supports `Tab` / `Shift+Tab` and `1-9` jump-select when `numberShortcuts` is enabled) |
| `Ctrl+D` / `Ctrl+U` | Half-page scroll down / up | Active in `ScrollView`, `VirtualList`, and `SelectList` (`PgDn` / `PgUp` also scroll half-page in `SelectList`) |
| `Ctrl+F` / `Ctrl+B` (`PgDn` / `PgUp`) | Full-page scroll down / up | Active in `ScrollView` and `VirtualList` (`Space` also pages down in `ScrollView` unless `spacePageDown={false}`; `n` / `N` jump to next / previous search highlight in `ScrollView`; `PgDn` / `PgUp` also page in `CommandPalette` and `NotificationHistoryModal`) |
| `Home` / `End` (`g` / `G` opt-in) | Jump to top / bottom | `Home` / `End` active in `ScrollView`, `VirtualList`, and `SelectList`; Vim `g` / `G` default to `vimJumpKeys={false}` so parent view shortcuts never conflict |
| `Alt+Click` / `Mouse` | Click & scroll wheel | **Alt+点击 = 鼠标操作；普通点击保留终端选择**（SGR 1000+1006，`--mouse` / `STUDYHUB_TUI_MOUSE=1` 启用，滚轮不受影响；`--mouse-alt=0` 或 `STUDYHUB_TUI_MOUSE_ALT=0` 放开普通点击；`--no-mouse` 禁用）。支持侧栏、顶栏、列表（首次选中、再次打开）、刷题选项/评分/底栏、AI 推荐追问、弹窗按钮与设置页签 |
| `Esc` | Close / cancel / fold dock | Closes active modal, drawer, or palette; cancels active filter/edit; or folds a passive right-docked `AssistantPanel` (step 2 of unified 2-step `Esc`) |

> **First-Run Launchpad** (auto-shown when the library is empty unless `--no-launchpad` is passed): `s` load sample course · `i` import first material · `m` configure model (`agy` / OpenAI) · `Enter` enter Library.

> **CLI Launch Flags**: `--root <path>` (`--library <path>`), `--page <id>`, `--theme <id>`, `--lang <zh|en>`, `--no-alt-screen`, `--no-launchpad`, `--skip-probe`, `--ascii` / `--unicode`, `--mouse` / `--no-mouse` / `--mouse-alt=0` (or `STUDYHUB_TUI_MOUSE=1`, `STUDYHUB_TUI_MOUSE_ALT=0`; default Alt+click = TUI action, plain click keeps terminal selection), `--doctor` / `--doctor --json` (fast-path cross-platform terminal/env/provider diagnostics, zero API key leakage), `--stats` / `--stats --json` (fast-path offline library dashboard summary, zero Ink/React mount or LLM calls), `--due` / `--due --json` / `--course <name>` (fast-path offline today's due review queue summary by deck, zero Ink/React mount or LLM calls), `--board` / `--board --json` / `--course <name>` (ultra-fast offline Kanban board & Pomodoro summary directly from `tui-board.json`, fails cleanly on corrupt JSON, zero StudyRuntime/Ink/React mount or LLM calls), `--search <query>` / `--search <query> --json` / `--limit <n>` (fast-path offline keyword search across library cards & sources, capped by `--limit`, zero Ink/React mount or LLM calls), and `--export [rel-path]` (`--json`, fast-path 1-shot atomic JSON library backup strictly sandboxed inside `<libraryRoot>/backups/` with collision-safe `studyhub-backup-YYYY-MM-DD-HHmmss.json` naming, zero Ink/React mount or LLM calls).

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

Applies to all `<TextInput>` fields at `KEY_LAYER_TEXT_INPUT` (`500`). Paste input automatically strips ANSI escapes and orphaned `200~`/`201~` bracketed-paste markers:

| Key | Single-line | Multiline (`multiline={true}`) |
| --- | --- | --- |
| `Enter` | Submit (`onSubmit`) | Insert newline (or submit when `submitOnEnter` is set) |
| `Ctrl+Enter` | Submit (`onSubmit`) | Submit (`onSubmit`) |
| `Ctrl+S` | — | Submit (`onSubmit`; falls through when `onSubmit` is omitted so parent modal save handlers run) |
| `Ctrl+J` / `Shift+Enter` | — | Insert newline |
| `Alt+Enter` | — | Insert newline when `submitOnEnter` is set |
| `Esc` | Cancel (`onCancel`) | Cancel (`onCancel`) |
| `Tab` | Path / field completion (`onTab`) | Path / field completion (`onTab`) |
| `←` / `→` | Move char left / right | Move char left / right |
| `Alt+←/→` or `Ctrl+←/→` | Move word left / right | Move word left / right |
| `↑` / `↓` | — | Move cursor up / down one line |
| `Home` / `Ctrl+A` | Start of input | Start of current line |
| `End` / `Ctrl+E` | End of input (`Ctrl+E` also passes through to parent modals such as `AddFocusModal`) | End of current line (`Ctrl+E` also passes through to parent modals) |
| `Backspace` / `Delete` | Delete previous / next char | Delete previous / next char |
| `Alt+Backspace` / `Ctrl+W` | Delete previous word | Delete previous word |
| `Ctrl+U` / `Ctrl+K` | Clear to line start / end | Clear to cursor start / end |

---

## 3. Command Palette v3 Scoped Prefixes

Open the palette with `Ctrl+K` or `/`. Prefix the query to scope results immediately:

| Prefix | Scope | Behavior |
| --- | --- | --- |
| `/` | Commands (`cmd`) | Filters slash commands (`/sample`, `/guide`, `/assistant`, `/guided`, `/due`, `/theme` [6 themes incl. `warm-amber`, `soft-sage`], `/density`, `/proactive`, `/pin`, `/terminal`, `/lang`, `/ascii`, `/math`, `/compact`, `/hints`, `/recover`, `/model`, `/voicepack`, `/inbox`, `/refresh`, `/course`, `/import`, `/sidebar`, `/help`, `/back`, `/quit`, and all 16/16 direct page jumps `/library`, `/sources`, `/generate`, `/wrongbook`, `/exam`, `/dashboard`, `/book`, `/skeleton`, `/coach`, `/prep`, `/notes`, `/board`, `/tasks`, `/audio`, `/settings`, `/review`) |
| `#` | Cards (`card`) | Live full-text question search (`card.search`, min 2 chars); Enter starts focused practice |
| `?` | Passages (`passage`) | Live source passage search (`search.content`, min 2 chars); Enter opens `DocumentReader` at exact page |
| `@` | Courses (`course`) | Filters courses and switches active course focus |
| `:` | Pages (`page`) | Filters all 16 TUI views for instant jump |

Inside the palette: `↑`/`↓`, `Ctrl+P`/`Ctrl+N`, `Ctrl+J`, or `Mouse Wheel` move selection (`Ctrl+K` toggles the palette closed via `AppShell:system`); `PgUp`/`PgDn` jump a page; `Enter` executes and saves to recent frecency (`tui.json`); `Esc` closes.

---

## 4. Per-View Power Shortcuts

### `1` Library (`library`)
- **Practice, Briefing & Rounds**: `Enter` start deck / open work item · `B` accept / `Z` dismiss Daily Study Briefing banner · `R` custom round configurator (`RoundConfigModal`) · `r` resume or start review · `p` daily plan · `g` AI Guided Study (`GuidedStudyModal`: `B` open prerequisite branch via `study.branch.open`, `u` return from branch via `study.branch.return`, `Q` save organized Q&A to card via `study.qa.organize`, `A` save guided artifact)
- **Deck, Work & Course Ops**: `x` export deck study sheet Markdown (`backups/studyhub-deck-YYYY-MM-DD.md`) · `/` filter decks by keyword (`Enter` keep, `Esc` clear) · `o` open selected work item when on Drafts & Jobs tab, otherwise open deck import / merge / split (`DeckOpsModal`: Import tab `Ctrl+G` P2-guarded AI filing proposal `draft.import.propose`; Merge tab `g` P2-guarded AI merge suggestions `deck.merge.suggest`, `a` apply proposal) · `[` / `]` reorder selected deck up / down · `C` course settings (tabs `1-4`: `m` merge course, `a` activate/deactivate course; Terms tab: `Space` toggle term mark, `a` attach check card via `course.terms.attach`, `C` clear all terms, `/` filter) · `v` voice pack · `a` archive/unarchive · `d` delete deck · `h` show/hide archived · `s` load/remove sample course · `Tab` toggle Decks / Drafts & Failed Jobs (`y` retries failed job)
- **Deck Card Manager (`m` / `DeckManageModal`)**: `j`/`k`/`↑`/`↓` select card · `J`/`K` scroll detail · `Ctrl+D`/`Ctrl+U` half-page, `Ctrl+F`/`Ctrl+B`/`PgDn`/`PgUp` full-page, `Home`/`End`/`g`/`G` top/bottom · `Enter` study selected card · `+` supplement cards (`Space` toggle sources, `a` toggle all, `+`/`=`/`>`/`.`, `-`/`<`/`,` adjust count, `Tab`/`t` cycle kind, `Ctrl+S`/`Enter` queue) · `k` convert card kind (`Tab`/`←`/`→`/`h`/`l` target kind, `Space` toggle T/F or `e` edit fields, `Enter`/`Ctrl+S` convert) · `u` restore slain card (Slain deck / slain card) · `m` move deck to folder (non-system decks) · `Space` multi-select (up to 100) · `F` batch focus · `S` batch suspend · `T` batch retag topic · `L` batch link prerequisite · `X` batch slay · `C` reassign deck course (`deck.course`) · `x` clear selection · `/` or `f` search · `c` clear search · `n` rename · `e` open draft · `p` practise deck

### `r` Review (`review`)
- **Answering**: `1-6` / `a-f` select MCQ (`Space` toggles multi-select, `Enter` submits) · `1` & `2` True/False · `i` / `Enter` edit fill-blank or open answer (`Tab`/`Shift+Tab` cycle blanks; auto-draft persisted on edit & restored on resume; `Space` reveals answer on open/fill-blank) · `Space` / `Enter` flip flashcard
- **FSRS-6 Rating & Flow**: `0-5` six-grade rating · `u` undo last rating · `R` redo card (when eligible) · `Enter` / `.` next card · `,` / `←` / `→` prev/next card · `s` skip · `X` end round (with confirmation) · **Empty / Completed State**: `R` / `Enter` practice card again (`R` / `Ctrl+R` reload on empty), `Esc` / `l` / `L` back to Library
- **Round Summary**: `j` / `k` select row · `Enter` / `Space` / `v` toggle answer preview · `d` P2-guarded round AI debrief (`coach.debrief`) · `w` retry weak cards · `g` daily recap · `R` new round · `Esc` / `b` / `1` back to Library
- **Card Tools & AI**: `h` AI Help drawer (reuses saved & in-round explanations; `R` explicit regenerate; `N` atomically saves to follow-up + study note via `note.qa.save`) · `t` / `T` Guided Study (unified AI Assistant workbench backed directly by backend `teach.get`/`teach.start`/`teach.answer`/`teach.skip`; `[S]` / `Ctrl+N` skip step, `[X]` reveal remaining points, `[M]` toggle understanding/calculation mode; `c`/`C`/`y` OSC 52 copy; `[F]` fullscreen) · `F` Feynman Retell modal (`teach.retell`) · `N` AI coach nudge & quick check (`CoachNudgeModal`: P2 `ConfirmDialog`-guarded `coach.nudge` + `coach.reply`; `[g]`/`[Enter]` generate nudge, `[1]`/`[2]` check, `[o]`/`[k]` got it, `[c]` P2-guarded follow-up; available on non-exam cards with grade `< 3`) · `G` AI rubric grade (`J` manual AI grade adjust, `K` acknowledge delayed correction) · `W` translate card · `S` similar cards (highlights origin card + `[B]` back to origin) · `D` card tools (edit, suspend/slay, prereqs, terms, P2-safe quality feedback `coach.feedback`, revert last rewrite `coach.revert`, `[R]` P2-guarded retry failed rewrite `coach.rewrite.retry`) · `A` answer card & drills · `Q` live queue editor (non-exam) · `*` toggle focus · `E` flag card · `o` jump to cited source page (pushes Practice Context Stack; global `r` returns step-by-step & restores draft) · `m` toggle Unicode/LaTeX math · **AI Result Follow-up**: press `a` at the bottom of Vocab, Retell, Answer Card, or Similar Cards results to issue free-form instructions (presets `1-4`, `N` atomically saves to follow-up/notes via `note.qa.save`)

### `2` Sources & DocumentReader (`sources`)
- **Sources List**: `Enter` open `DocumentReader` · `Space` multi-select (`[m]` batch move folder via `source.folder.set { keys }`, `[a]` batch archive/restore, `[E]` batch enrich metadata, `Esc` clear selection) · `E` enrich deterministic metadata (`materials.enrich`, 0-token) · `i` import source (Tab path completion) · `M` MinerU scanned/long PDF planner · `O` original file attachment & verification (`OriginalFileModal`: attach `reference`/`copy`, probe, detach while keeping disk files) · `g` generate questions · `G` AI organize into courses (`OrganizeSourcesModal`, P2 `ConfirmDialog` guard before `source.organize.suggest`; `X` dismiss pending proposals via `source.organize.dismiss`) · `V` citation coverage & linked cards (`SourceCoverageModal`: `Tab` / `1`/`2` switch Coverage / Linked Cards; Tab 2 `p` / `Enter` practise linked cards) · `F` folder filter / `m` move to folder (`FolderModal`: `a` create, `r` rename, `d` delete, `g` AI classify folders [P2 quota-guarded], `X` dismiss pending proposals via `source.folder.dismiss`, `0`/`x` clear) · `C` companions builder & sync · `R` reread queue · `e` rename · `c` set course · `p` pin/unpin · `[` / `]` reorder pinned material up / down · `a` archive · `d` delete · `/` filter · `f` filter by active course · `x` export sources catalog & citation coverage Markdown (`backups/studyhub-sources-YYYY-MM-DD.md`)
- **DocumentReader**: Automatic last-read page resume (`lastReadPages` persisted across sessions in `tui.json`, capped at 100 recent documents; explicit page/citation jumps preserve target page) · `[` / `]` previous / next page · `O` outline TOC drawer (`Space`/`m` toggle chapter read, `g` AI suggest, `s` save proposal, `X` clear custom AI outline, `r` return to review) · `H` mark/highlight passage (`MarkPassageModal`: `j`/`k` pick passage, `1-4`/`Tab` style, `Enter` save) · `B` bookmarks & notes drawer (`ReaderNotesDrawer`: `Tab` Annotations/Marks, `Enter` jump page; Annotations `d` delete; Marks `R` mark reread, `d` delete mark, `S` purge stale marks, `r` return to review) · `G` translation glossary & saved translations (`TranslationGlossaryModal`: `Tab`/`1`/`2` Glossary & Saved, `a` add term, `d` delete, `l` toggle `zh`/`en`, `C` clear saved) · `M` toggle chapter read · `a` ask AI on current page (`s` saves reply to note, `f` saves grounded Q&A as flashcard) · `t` bilingual translate page (cache-first + cost estimate + P2 `ConfirmDialog` quota guard; inside translation pane: `L` switch target language, `R` retranslate) · `g` jump to page · `/` search in page · `m` toggle Unicode/LaTeX math · `Q` generate from page · `p` practise page · `Esc` / `Backspace` close reader

### `3` Generate & Drafts (`generate`)
- **New Generation**: `Tab` switch to Drafts · `Space` toggle source · `a` select/clear all visible sources · `/` live filter materials by title/course/folder/format (`Enter` keep, `Esc` clear; `Space`/`a` preserve hidden selections) · `i` capture & ingest existing cards · `c` cycle course · `k` cycle question kind · `n` cycle count · `p` page range scope · `f` focus instructions · `W` fill course weak topics (`generate.weakTopics`) · `S` AI suggest strategy (`generate.suggest`, P2 `ConfirmDialog` quota-guarded; also opens model settings when unconfigured) · `P` multi-step study path wizard (`GeneratePathModal`, P2 `ConfirmDialog`-guarded `generate.path.suggest`) · `Ctrl+S` start generation
- **DraftEditor**: `d` switch draft · `/` filter draft cards by keyword (`Enter` keep, `Esc` clear) · `X` export draft Markdown (`backups/studyhub-draft-YYYY-MM-DD.md`) · `e` edit selected card (`Ctrl+N` switch field, `Ctrl+S` save) · `x` remove card from draft · `u` undo last removed draft card · `S` / `s` check similar cards · `R` repair draft · `V` draft publish preflight · `P` publish draft to deck · `D` delete entire draft

### `4` Mistakes / Wrong Book (`wrongbook`)
- `Tab` / `Shift+Tab` / `h` / `l` switch tabs · `←` / `→` switch left list / right detail pane (`Esc` returns to left pane on narrow layout) · `Q` 1-key drill on highest-frequency weak topic/reason cluster · `/` filter wrong cards by keyword (`Enter` keep, `Esc` clear) · `Space` multi-select · `B` / `P` batch practice (selected / visible) · `V` practise prepared coach variants (`coach.practice`) · `X` export wrong-book Markdown study sheet (`backups/studyhub-wrongbook-YYYY-MM-DD.md`) · `x` clear selection / similar cards · `e` tag wrong reason · `t` 0-token triage (Confusable contrast modal: `Enter`/`p` practise contrast set, `b` open Review Book, `Esc` close) · `f` filter by reason · `o` jump to cited source page · `Enter` / `p` practise selected · `m` toggle math · `J` / `K` scroll detail pane · `R` reload

### `5` Mock Exam (`exam`)
- **Setup**: `Tab` / `h` / `l` switch Setup / History · `1` / `2` / `3` Written MCQ / Case / Oral · `c` question count · `t` time limit · `k` question kinds · `R` resume active exam · `x` export exam history report (`backups/studyhub-exam-YYYY-MM-DD.md`)
- **Runner — Written MCQ**: `1-9` select/toggle options · `f` flag question · `n` / `p` / `Tab` / `Shift+Tab` / `←` / `→` step questions · `Ctrl+S` submit exam · `Esc` exit confirmation
- **Runner — Case**: `s` toggle case scenario pane · `H` highlight paragraph · `[` / `]` step paragraphs · `e` / `Enter` edit answer · `f` flag question · `n` / `p` / `Tab` / `Shift+Tab` / `←` / `→` step questions · `Ctrl+S` submit exam · `Esc` exit confirmation
- **Runner — Oral**: `e` / `Enter` edit oral answer · `a` request AI follow-up (when answer is non-empty) · `u` answer follow-up · `n` next oral question · `Ctrl+S` submit exam · `Esc` exit confirmation
- **Exam Report (`ExamReportView`)**: `Tab` / `h` / `l` / `←` / `→` switch question list & detail pane · `w` / `p` drill weak questions · `b` / `Esc` return to Exam setup/history

### `6` Stats / Dashboard (`dashboard`)
- `j` / `k` select weak topic or course · `T` toggle borderless course stat matrix (`renderStatTable`) · `/` live filter weak topics & courses by keyword (`Enter` keep, `Esc` clear) · `Enter` / `p` drill selected item · `w` practise all weak questions · `f` toggle 7-day forecast · `m` study map & prerequisite graph (`StudyMapModal`: `Tab`/`1`/`2` switch Mastery Map / Prerequisite Graph, `s` toggle scope, `/` filter, `c` clear, `r` refresh, `Enter` practise) · `d` cycle usage window · `x` export progress report · `Ctrl+R` refresh

### `7` Review Book (`book`)
- `Tab` / `h` / `l` / `←` / `→` switch TOC / reading pane · `Enter` (on TOC) jump into reading pane · `/` live filter TOC chapters/points by keyword (`Enter` keep, `Esc` clear) · `m` toggle Unicode/LaTeX math · `e` edit or revert (`[u]`) section · `H` revision history & revert (`BookHistoryModal`, `course.book.revision` / `course.book.revert`) · `E` P2-guarded AI explain / add section (`BookExplainModal`, `generation.courseBook.explain`) · `B` review / keep / delete AI blocks (`BookAiBlocksModal`) · `R` rename TOC node · `[` / `]` move node up/down among siblings · `D` delete node (keeps notes in Unplaced) · `z` revert last structure change · `U` place unplaced section into target leaf point (`BookStructureModal`) · `T` Feynman retell selected point (`BookRetellModal`) · `M` chapter/point mock paper (`book.mock.plan` + `book.mock`, opens Exam) · `p` practise 5 cards · `P` pinned book QA & section Q&A (`course.outline.qa`) · `w` final-week crunch & mock · `x` export Markdown · `g` build/rebuild book (`a` apply / `u` undo when rebuild-pending) · `Ctrl+R` refresh

### `8` Skeleton (`skeleton`)
- `j` / `k` / `↑` / `↓` move node · `Space` / `Enter` toggle expand/collapse (or focus detail pane on leaf) · `l` / `→` expand, step into child, or focus detail pane · `h` / `←` collapse or jump to parent · `e` expand / collapse all nodes · `Tab` switch pane · `/` filter skeleton nodes · `x` export skeleton outline Markdown · `p` practise node · `E` edit skeleton node · `R` course learning route · `G` topic groups manager · `L` skeleton lint (`r` re-run) · `M` interactive HTML diagrams manager (`SkeletonDiagramsModal`: `a` attach UTF-8 HTML `<= 5 MB`, `Enter` inspect, `d` remove, max 8) · `g` generate skeleton · `s` switch skeleton · `D` delete skeleton (removes diagrams; keeps decks/cards) · `Ctrl+R` refresh

### `9` Exam Coach (`examcoach`)
- **All Tabs**: `1-4` switch Calibration / Variants / Evidence / Compile tabs · `Tab` switch left/right pane · `/` live filter Calibration families, Variants weak items, or Evidence points (`Enter` keep, `Esc` clear) · `f` P2-guarded flush coach prep queue (`coach.prepare`) · `X` export coach calibration & learner profile Markdown (`backups/studyhub-coach-YYYY-MM-DD.md`) · `Ctrl+R` refresh
- **Tab `1` Calibration**: `a` / `A` analyze / AI deepen · `N` / `n` past-paper notes (`Tab` switch field, `Ctrl+S` save) · `v` reveal sample answer · `x` / `y` / `z` three-item confirmation · `e` edit quota/priority (`Tab` field, `←`/`→`/`Space` priority, `Enter`/`Ctrl+S` save) · `p` coach profile, prefs & memory bullets (`CoachPreferencesModal`)
- **Tab `2` Variants**: `g` / `G` generate variant for selected / batch up to 5 · `p` start coach practice (all ready) · `P` practise selected weak card
- **Tab `3` Evidence**: `p` practise selected point · `P` coach preferences (`CoachPreferencesModal`)
- **Tab `4` Compile**: `b` compile preview · `m` strict mock check · `g` calibrated generate · `p` coach preferences (`CoachPreferencesModal`)
- **`CoachPreferencesModal`**: `Tab`/`1`/`2` switch Preferences & Memory Bullets tabs; Preferences `a` add, `d` remove, `x` clear all; Memory Bullets `a` add bullet, `d` remove selected bullet; `g` cycle learning goal, `p` toggle auto-prep consent, `F` forget/reset profile & prepared cards, `r` refresh

### `0` Exam Prep (`examprep`)
- `1` / `2` / `Tab` switch Focus / Crunch tabs · `Ctrl+R` refresh · `T` toggle the saved study plan's schedule table (backend `course.plan`, rendered by `renderExamScheduleTable`; no plan yet = one line pointing at `P`) · `Z` dismiss exam gap alert for session · `a` add focus point (`AddFocusModal`: `Ctrl+T` cycle Text / Image / AI Match Topics, `Tab` / `Shift+Tab` cycle fields, `Ctrl+G` jump/trigger `focus.suggest` with P2 quota-guarded `ConfirmDialog`, `Ctrl+E` extract / AI match, `Ctrl+M` toggle save as material, `Ctrl+S` save) · `d` remove focus point · `/` filter focus points · `x` export exam prep plan Markdown (includes 7-day countdown schedule & gap-fill checklist) · `p` practise unmastered / mock · `g` / `G` gap-fill generation · `P` study plan & custom wizard · `Space` mark seen (Crunch) · `m` mark read (Crunch)

### `n` Notes (`notes`)
- `Tab` / `h` / `l` switch list / reader pane · `a` new note · `e` edit draft note · `g` P2-guarded AI draft note (`note.generate`) · `L` publish link (`Ctrl+P` prepare publish baseline via `note.preparePublish`, `Ctrl+L` auto-lookup published article via `note.lookup`, `Tab` edit CSDN home, `Enter` save link) · `M` import note to Sources library · `o` / `O` jump to linked card or source · `R` generate daily recap · `C` cancel note / daily recap generation (`note.cancel` / `note.daily.cancel`) · `/` filter notes by keyword (title, content, course, tags; `Enter` keep, `Esc` clear) · `x` export Markdown (atomic write) · `d` delete note · `f` filter active course · `m` toggle math

### `b` Board (`board`)
- **Kanban**: `h` / `l` / `←` / `→` switch column · `j` / `k` / `↑` / `↓` move card · `H` / `L` / `m` move card across columns · `a` add card · `e` / `Enter` edit card · `d` delete card · `S` sync StudyHub board · `/` filter cards · `x` export board Markdown · `Ctrl+R` reload
- **Pomodoro**: `P` / `Space` start/pause timer · `M` switch focus/break mode · `+` / `-` adjust minutes · `R` reset timer

### `t` Jobs / Tasks (`tasks`)
- `1` / `2` / `3` / `Tab` filter Running / All / Archived · `/` live filter jobs by title/type/status/course/stage/id (`Enter` keep, `Esc` clear) · `X` export jobs summary Markdown (`backups/studyhub-tasks-YYYY-MM-DD.md`) · `p` pause/resume job queue · `P` promote queued job to parallel · `+` / `=` / `-` adjust queue concurrency · `R` recover interrupted jobs · `o` live output modal (`m` toggle Markdown/JSON, `r` refresh, `[`/`]` or `←`/`→` switch stream/section, `Esc` close) · `m` send refinement message to active job · `w` workflow history & context inspector (`WorkflowHistoryModal`: `Enter`/`c` inspect full `workflow.context` & `workflow.session.get`, `b`/`Esc` back to list, `r` refresh) · `v` toggle output / trace · `e` export trace JSON · `D` purge saved traces · `Enter` open draft · `x` cancel job · `a` archive/restore · `d` dismiss/delete

### `a` Audio (`audio`)
- `i` import audio file (with Tab path completion) · `u` import subtitles (`.srt`/`.vtt`/`.txt`/`.json`) · `/` filter audio jobs · `x` export transcript Markdown · `p` preflight diagnostics · `c` review transcript corrections (P2-guarded) · `R` retry failed job · `s` transcription provider settings · `t` test provider connectivity · `g` generate questions from transcript · `Ctrl+R` refresh

### `,` Settings (`settings`)
- `1-4` switch Models / Workspace / StudyGen / Appearance tabs
- **Models (`1`)**: `Tab` switch route / detail pane (`l` / `→` focus detail; `Esc` / `←` return to route list on non-preset) · `a` / `Enter` / `Ctrl+S` save & activate · `e` edit CLI path / field · `m` edit Codex model · `h` / `l` / `←` / `→` cycle OpenAI preset model & options · `t` test connection · `s` rescan CLI / save preset
- **Workspace (`2`)**: `e` change library root · `c` confirm library location · `s` toggle sample course · `f` toggle experimental features · `v` cycle semantic retrieval provider (`retrieval.set` + displays `retrieval.index.coverage`) · `t` semantic retrieval diagnostics & index plan (`retrieval.index.plan` + `retrieval.test`; inside modal: `s` local hybrid preview search via `retrieval.preview`, `m` HuggingFace mirror endpoint via `retrieval.endpoint.set`, `r` refresh, `Esc`/`q` close) · `L` library context modal (`e` export JSON, `r` refresh, `Esc`/`q` close) · `u` toggle usage frequency tracking · `U` clear usage data · `i` usage frequency report modal (`1-3` period, `p` pause/resume, `e` export, `r` refresh, `Esc`/`q` close) · `a` toggle auto update check (`update.preferences`) · `A` manual release update check (`update.check { force: true }`; inside modal: `r` re-check, `z` snooze/unsnooze via `update.preferences`, `Esc`/`q` close) · `x` export JSON backup · `Ctrl+R` refresh restore points / retrieval / usage / update prefs · `Enter` restore selected point
- **StudyGen (`3`)**: `j` / `k` (`↑` / `↓`) select across scrollable rows (`22` StudyGen rows including Book `qaToBook`, `coverage`, `inlinePractice`, `confusableDrill` via `settings.book.set`; ExamPrep `autoRoles`, `showOtherCourses` via `settings.examPrep.set`; Practice reset; and ExamPrep reset) · `Ctrl+D`/`Ctrl+U` half-page · `Ctrl+F`/`Ctrl+B`/`PgDn`/`PgUp` full-page · `Home`/`End`/`g`/`G` top/bottom · `←` / `→` / `h` / `l` / `Enter` / `Space` adjust/toggle & save · `Ctrl+R` reload
- **Appearance (`4`)**: `j` / `k` (`↑` / `↓`) select option · `←` / `→` / `h` / `l` / `Enter` / `Space` cycle/toggle & save; also displays a live read-only terminal capabilities strip (platform, viewport size, `ColorLevel` L0–L3, ASCII/Unicode & Math mode, SGR 1006 mouse wheel status)
