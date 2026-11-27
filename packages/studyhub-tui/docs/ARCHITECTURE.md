# StudyHub TUI Contributor Architecture

`@ericwang1358/studyhub-tui` is a React 19.3 + Ink 8 terminal client for StudyHub built with TypeScript, Zustand 5, Chalk 6, Marked 18, `esbuild` code splitting, and `@xterm/headless` E2E tests (0 `zod` runtime imports, 9 minimal runtime dependencies, 550+ automated tests across 165+ suites at the Round 70 milestone). It reuses `packages/studyhub-desktop` and `lib/` at runtime with zero invasive upstream edits.

---

## 1. Directory Layout

```text
packages/studyhub-tui/
├── bin/studyhub-tui.mjs        # CLI shim resolving dist/cli.mjs via import.meta.url
├── docs/                       # ARCHITECTURE.md, GUIDE.md, KEYBINDINGS.md, ASSISTANT-UX.md, ROADMAP-*.md
├── scripts/
│   ├── build.mjs               # esbuild code-split build (cli, boot-frame, App, host)
│   └── bench.mjs               # Bundle size, cold spawn, boot-frame & RSS/heap probe
├── src/
│   ├── cli.tsx, cli-args.ts    # Fast-path --help/--version/--doctor [--json], color/ASCII probe, boot frame
│   ├── terminal.ts             # UTF-8 stdio, alt-screen, signal-exit TTY teardown
│   ├── App.tsx                 # StudyHubTuiApp, ViewErrorBoundary, syncFromHost, lazy views
│   ├── types/contracts.ts      # PageId, PAGE_REGISTRY (16 views), HostClient & snapshot types
│   ├── input/                  # P1 single key dispatcher: dispatcher.ts, global-router.ts, hooks.ts
│   ├── shell/                  # AppShell, TopBar, SideNav, Launchpad, CommandPalette,
│   │                           # HelpOverlay, CoursePickerModal, InboxModal, NotificationHistoryModal,
│   │                           # AssistantPanel, ShellBootFrame, global-keymap.ts, toast-copy.ts, fuzzy
│   ├── components/             # Panel, Modal, ConfirmDialog, TextInput, VirtualList,
│   │                           # ScrollView, ScrollArea, SelectList, SplitPane, MarkdownView, Badge,
│   │                           # focus.ts, layout-tokens.ts, useAiConversation.ts, useStreamingBuffer.ts
│   ├── state/                  # Zustand store (store.ts) & O(K) snapshot-fingerprint.ts
│   ├── host/                   # desktop-deps.ts, tui-host.ts, presets.ts, tui-prefs.ts,
│   │                           # sample-actions.ts, ai-dialogue.ts, atomic-write.ts, tx-write.ts
│   ├── render/                 # lru.ts, cjk.ts, math.ts, markdown.ts, charts.ts
│   ├── theme/tokens.ts         # 6 WCAG palettes + runtime ColorLevel / makeChalk(level)
│   └── views/*/                # 16 view directories (lazy-loaded views & internal modals)
└── tests/                      # Unit, perf, scale, AST keymap, resilience, smoke & xterm E2E
```

---

## 2. Dual-Model Host Architecture & Dynamic Boundary

- **Dynamic `studyhub-desktop` boundary (`src/host/desktop-deps.ts`)**:
  - TUI TypeScript **never** statically imports `../../../lib/` or `studyhub-desktop` (`tsc --allowJs` would pull upstream `// @ts-check` JS into TUI typechecking, and `scripts/build.mjs` keeps them external).
  - `resolveDesktopRoot()` checks `STUDYHUB_DESKTOP_ROOT` or walks upward from `import.meta.url` (working from `src/host/`, `dist/`, and external working directories like `/tmp`).
  - `loadDesktopDeps()` imports desktop modules dynamically via `pathToFileURL(join(root, rel)).href`.
- **Host composition (`src/host/tui-host.ts`)**:
  - `createTuiHost` composes `createDesktopHost` with Node adapters (`createConfigStore`, `createProviderDiscovery`, `createInProcessJobExecutor`, `createDesktopLibraryEvents`) without an HTTP sidecar server.
  - Adds `streamComplete` for live token streaming, debounced snapshot/library events, headless-safe `openExternal`, and leak-free `dispose()`.
- **AI dialogue & `card.followup` boundary (#1354 D7 — Won't-Do for streaming `card.followup`)**:
  - All TUI live streaming Q&A surfaces share the single `useAiConversation` + `src/host/ai-dialogue.ts` (`buildUnifiedAiSystemPrompt`, `buildCardDialogueUserPrompt`) + `host.streamComplete` pipeline, enforcing pre-reveal reference-answer hiding (#1335), `AbortSignal`/`Esc` cancellation, and zero automatic writes to `card.followups` until the learner explicitly saves via `persistCardQaToFollowupAndNote`.
  - Backend `card.followup` intentionally remains a **non-streaming** request-response JSON action (optional backend streaming for `card.followup` in #1354 D7 is explicitly **not implemented** / Won't-Do): `card.followup` sends full `answer`/`explanation` (`followupSource(card)`), validates strict `{question, answer}` JSON with retry, checks card-digest conflicts, auto-persists into `card.followups`, and optionally queues coach prep — a fundamentally different contract from pre-reveal, opt-in-save live TUI streaming. Verified by `tests/d7-card-followup-boundary.test.mjs`.
- **Primary engine (`agy` CLI)**:
  - On first launch without an existing config, background `autoProbe` probes local `agy`, selects `mode: 'agy'` automatically, picks a default model, and supports `agy models` discovery, effort levels, and streaming output.
- **Secondary engine (8 OpenAI-compatible presets)**:
  - `src/host/presets.ts` defines 8 presets (`deepseek`, `openai`, `siliconflow`, `zhipu`, `openrouter`, `groq`, `moonshot`, `custom`) matching `studyhub-desktop` IDs.
  - Environment API keys (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, etc.) are applied as an in-memory overlay only and never persisted to `desktop.json`.
- **Zero-`zod` strict runtime parsers (`src/host/tui-prefs.ts`, `src/views/board/board-store.ts`)**:
  - `src/host/tui-prefs.ts` implements a zero-dependency field-level parser (`TuiPreferencesSchema.safeParse` + `parseTuiPreferences`) that catches corrupt, truncated, or non-object `tui.json`, falls back cleanly to frozen `DEFAULT_TUI_PREFERENCES`, and serializes writes atomically.
  - `src/views/board/board-store.ts` replaces `zod` with strict zero-dependency field-level validation (`BoardCard`, `FocusStats`, `MAX_DELETED_UPSTREAM_IDS = 500` tombstones) for `tui-board.json`, yielding `0` `zod` static or dynamic imports across all `dist/*.mjs` chunks (`tests/perf-budget.test.mjs`).
- **Minimal 9-dependency runtime footprint (`package.json`)**:
  - Runtime `dependencies` are pruned to 9 packages (`chalk`, `cli-highlight`, `get-east-asian-width`, `ink`, `marked`, `react`, `signal-exit`, `strip-ansi`, `zustand`), verified by bidirectional dependency and `npm pack --dry-run --json` audits in `tests/packaging-smoke.test.mjs`.
- **Shared cross-platform atomic persistence (`src/host/atomic-write.ts`)**:
  - `atomicWriteTextFile`, `atomicWriteJsonFile`, and `defaultBackupFilePath` centralize `<libraryRoot>/backups/studyhub-*-YYYY-MM-DD.{md,json}` writes across views and modals, powering universal `[x]`/`[X]` Markdown and JSON exports.
  - Writes to a UUID-suffixed `.tmp` sibling and promotes via `renameWithRetry` (retrying Windows transient lock errors `EBUSY`/`EPERM`/`EACCES`), with guaranteed `.tmp` cleanup on failure.
  - `atomicUpdateJson(path, mutator)` is the single entry for overwrite-style persistence (`tui.json`, `tui-board.json`): it reads, mutates, and renames as one queued unit, aborts on unreadable/corrupt input instead of clobbering it, and leaves the original bytes untouched on failure. `AtomicSkip` reports a merged value without writing (passive preference patches).
  - `withRollback(path, run)` restores the pre-write snapshot (or removes a file the failed run created) for a single logical write, rethrowing the original error so callers keep their existing failure notices; `AtomicRollbackError` separates the original failure from a failed restore. Multi-file commits use `atomicWriteFilesBatch` / `AtomicBatchWriteError` (#1465).

---

## 3. Input & Focus Stack (#1354 P1 Single Dispatcher)

Keystrokes traverse a single Ink `useInput` bridge (`src/input/hooks.ts`) backed by a deterministic priority/depth scope stack (`src/input/dispatcher.ts`) and centralized global/Alt-chord router (`src/input/global-router.ts`):

```text
Keypress (single Ink useInput in src/input/hooks.ts)
  ├── System & mouse layers run above scope masking (sorted by (layer >= KEY_LAYER_SYSTEM) DESC):
  │     KEY_LAYER_MOUSE  (610) ──► Mouse:sgrFallback (SGR 1006 mouse frames inside the dispatcher)
  │     KEY_LAYER_SYSTEM (600) ──► AppShell:system (SHELL_KEY_ROUTER.resolveSystem: Ctrl+C/K/Space/G/O/R)
  │                                & AppShell:alt-guard (SHELL_KEY_ROUTER.resolveAltChord)
  └── Scoped LIFO stack ordered by depth DESC:
        KEY_SCOPE_DEPTH_QUIT_CONFIRM (300) > KEY_SCOPE_DEPTH_TOO_SMALL (200) > KEY_SCOPE_DEPTH_SHELL_OVERLAY (100) > modal/view
        Within the top active scope, priority layers descend:
          KEY_LAYER_TEXT_INPUT  (500) ──► Focused TextInput (typing & Alt-editing chords)
          KEY_LAYER_MODAL       (400) ──► Active Modal / ConfirmDialog (inside opaque <KeyScope>)
          KEY_LAYER_DRAWER      (300) ──► Docked AssistantPanel / drawers
          KEY_LAYER_VIEW        (200) ──► Active View useKeyScope handlers
          KEY_LAYER_WIDGET      (150) ──► VirtualList / SelectList / ScrollView
          KEY_LAYER_MODAL_FRAME (120) ──► Modal:esc close fallback & drawer catch-all sinks
          KEY_LAYER_GLOBAL      (100) ──► AppShell:global (SHELL_KEY_ROUTER.resolveGlobal: 1-9,0,n,b,t,a,r,c,I,?,/,\\,[,],q)
```

1. **Single Ink `useInput` & opaque scope barriers (`src/input/dispatcher.ts`, `src/input/hooks.ts`)**: Components register via `useKeyScope` / `useScopedInput` and wrap modals/overlays in opaque `<KeyScopeProvider>` or explicit `KEY_SCOPE_DEPTH_*` (`KEY_SCOPE_DEPTH_SHELL_OVERLAY`, `KEY_SCOPE_DEPTH_TOO_SMALL`, `KEY_SCOPE_DEPTH_QUIT_CONFIRM`), stopping lower scopes from receiving consumed or masked keys.
2. **Centralized shell routing (`src/input/global-router.ts`, `src/shell/global-keymap.ts`)**: `SHELL_KEY_ROUTER` owns all system (`Ctrl+C/K/Space/G/O/R`), `Alt+*` containment, and global single-key routing; `GLOBAL_KEYMAP_ENTRIES` (`src/shell/global-keymap.ts`) is the single source of truth for `TopBar`, `Launchpad`, `KeyHintBar`, and `HelpOverlay`.
3. **View key claims & ref-counted capture (`src/components/focus.ts`)**: Non-modal views/lists claiming global keys declare them via `useKeyScope({ keys })` / `useClaimKeys`; modals and focused inputs coordinate footer hints via `useModalFooterHints` and `resolveShellFooterHints`.
4. **Unified toast & notification copy (`src/shell/toast-copy.ts`)**: `NotificationHistoryModal`, `InboxModal` (`toasts` tab), and `global-keymap.ts` share a single copy module so severity badges, empty/cleared states, timestamps, clipboard payloads, and `MAX_TOAST_HISTORY` stay aligned.

---

## 4. Performance & NFR Architecture

- **Instant boot (`ShellBootFrame`) & fast-path CLI diagnostics**:
  - `src/cli.tsx` and `src/cli-args.ts` handle `--help`, `--version`, and `--doctor` / `--doctor --json` before importing React, Ink, `App.mjs`, or `host.mjs` (delivering cross-platform Linux/Windows terminal, path, and provider diagnostics with zero API key value leakage while keeping `dist/cli.mjs <= 15 KB`), then mount `dist/boot-frame.mjs` (`ShellBootFrame`, tested to carry zero static `marked` or `cli-highlight` imports) immediately while `createTuiHost` and `dist/App.mjs` load in parallel.
  - A 64-byte boot stdin buffer captures early user keystrokes while stripping terminal probe/mouse escape noise.
- **5 Barrel-Bypass rules (startup bundle & chunk isolation, enforced in `tests/perf-budget.test.mjs` & `tests/keymap-audit.test.mjs`)**:
  1. `views/*/index.js`: `src/App.tsx` eagerly imports only `LibraryView` and lazy-loads the remaining 15 views plus `VoicePackModal` directly via `React.lazy(() => import('./views/<dir>/<View>.js'))` — never `./views/*/index.js` barrels (`tests/keymap-audit.test.mjs`).
  2. `shell/index.js`: `AppShell` lazy-loads `Launchpad`, `CommandPalette`, `HelpOverlay`, `CoursePickerModal`, and `InboxModal` directly (`./Launchpad.js`, etc.), and `src/App.tsx` / views never import `shell/index.js` (`0` static overlays in `App.mjs`, allowing `AppShell` to inline cleanly; `tests/perf-budget.test.mjs`).
  3. `components/index.js`: Complete `0`-importer Barrel-Bypass across all of `src/` (Round 47); every view, modal, drawer, and shell overlay imports leaf component files directly (`./Panel.js`, `./Badge.js`, `./focus.js`) instead of `components/index.js` (which re-exports `MarkdownView`; `tests/perf-budget.test.mjs`).
  4. `render/index.js`: Complete `0`-importer Barrel-Bypass across all of `src/` (Round 46); callers import leaf render utilities (`cjk.js`, `charts.js`) rather than `render/index.js` (which re-exports `markdown.js` and `math.js`), keeping `marked`, `cli-highlight`, `render/markdown.ts`, and `render/math.ts` out of `dist/boot-frame.mjs`, `dist/App.mjs`, and `55+` non-markdown `dist/*.mjs` entry chunks (`tests/perf-budget.test.mjs`, including `OriginalFileModal-`, `SkeletonDiagramsModal-`, `BookExplainModal-`, `CoachNudgeModal-`, `BookHistoryModal-`, `BookAiBlocksModal-`, and `GeneratePathModal-`).
  5. `host/index.js`: Complete `0`-importer Barrel-Bypass across all of `src/` (Round 48); UI modules import `host/sample-actions.js`, `host/tui-prefs.js`, or `host/presets.js` directly rather than `host/index.js`, isolating `tui-host.ts` and `desktop-deps.ts` from `dist/App.mjs` (`tests/perf-budget.test.mjs`).
- **Signed-int32 $O(K)$ snapshot fingerprinting (`src/state/snapshot-fingerprint.ts`)**:
  - `computeSnapshotFingerprint` feeds a dual signed-int32 FNV-1a `RollingHasher` (`Math.imul` + `| 0`) over structural metadata (revision, counts, timestamps, decks/progress, sources, courses, drafts, runs, jobs, attempts, settings) — avoiding `>>> 0` V8 HeapNumber boxing per step and deferring unsigned conversion to `digest()` — skipping unchanged store updates in `syncFromHost` in `< 1 ms` without full-snapshot `JSON.stringify`.
- **60fps streaming coalescing (`src/components/useStreamingBuffer.ts`)**:
  - `createStreamingCoalescer` and `useStreamingBuffer(24)` coalesce rapid AI token deltas in `AiHelpDrawer`, `DocumentReader`, and `CompanionsModal` using a 24 ms trailing timer (`<= ~40` Ink renders/s) and flush synchronously on `finish()`, error, abort, or unmount.
- **Bounded caches & virtualized rendering**:
  - `LruCache` (`src/render/lru.ts`) caps Markdown renders at 256 entries (`mdCache`, keyed with `colorLevel`) and TeX math conversions at 512 entries (`mathCache`).
  - `ReviewView` caps card translations at 32 entries; `store.ts` caps navigation history (24), active toasts (4), and `toastHistory (50)`; `TasksView` caps logs (200 lines); `cli-highlight` loads lazily on fenced code blocks; `VirtualList` windows long lists to viewport height.
- **Fast-path CJK width & math/Markdown rendering (`src/render/cjk.ts`, `src/render/math.ts`, `src/render/markdown.ts`)**:
  - `src/render/cjk.ts` uses a zero-allocation BMP fast-path (`fastBmpWidth` / `bmpCharWidth`) that bypasses `Intl.Segmenter` and ANSI regex scanning for safe non-combining BMP strings, delivering `~2x` speedup on `displayWidth` / `truncateDisplay` and faster Markdown line wrapping.
  - `src/render/math.ts` (and `src/render/markdown.ts`) short-circuit plain-text / plain-prose inputs without LaTeX or Markdown control tokens before invoking full parser passes.
- **`NO_COLOR=1` & cached `makeChalk(level)` (`src/theme/tokens.ts`)**:
  - `resolveColorCapability` maps `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, TTY state, `WT_SESSION`, and `COLORTERM` to `ColorLevel` (`0–3`).
  - `makeChalk(level)` memoizes `ChalkInstance` objects in `CHALK_CACHE` per `ColorLevel` to avoid per-render `new Chalk({ level })` allocations.
  - When `level === 0`, `src/cli.tsx` sets `FORCE_COLOR = '0'` before importing Ink and calls `setColorLevel(0)`; `src/render/markdown.ts`, `src/render/charts.ts`, `src/shell/HelpOverlay.tsx`, and `src/views/exam/ExamRunner.tsx` style text via `makeChalk(colorLevel)` so `NO_COLOR=1` emits zero SGR color escapes.
- **Centralized `--ascii` chrome normalization (`src/components/Badge.tsx`)**:
  - `normalizeAsciiChrome(text, ascii)` maps Unicode UI chrome glyphs (`…`, `↑↓`, `←→`, `›`, `▸`, `▾`, `•`, `✓`, `✕`, `★`, `◆`, `●`, `○`, `☑`, `☐`, `⚠`) via `ASCII_CHROME_MAP` across `Badge`, `StatusPill`, `Panel`, `KeyHintBar`, `ToastStack`, `EmptyState`, and `TextInput` without mutating user-entered values.
- **Deterministic GC & leak soak**:
  - `@xterm/headless` soak suites (`tests/responsive-audit.test.mjs`, `tests/packaging-smoke.test.mjs`) invoke V8 GC (`--expose_gc`) across resize storms (`80x24` ↔ `160x44`) and assert bounded heap deltas and `0` leaked `FSEventWrap`/`StatWatcher`/`ProcessWrap`/`Timeout` handles after `unmount()` and `host.dispose()`.

---

## 5. Cross-Platform Guarantees & Contributor Rules

- **Linux bash & Windows PowerShell / ConPTY**:
  - `enterTerminalSession` (`src/terminal.ts`) enforces UTF-8 stdio, manages the alternate screen buffer, and restores cursor/raw-mode via `signal-exit`.
  - **Opt-in SGR 1006 mouse wheel scrolling**: Disabled by default; enabled via `--mouse` or `STUDYHUB_TUI_MOUSE=1` (and suppressed via `--no-mouse` / `shouldEnableMouse` in `src/cli-args.ts`). `src/terminal.ts` exports `ENABLE_SGR_MOUSE` (`\x1b[?1000h\x1b[?1006h`) and `DISABLE_SGR_MOUSE` (`\x1b[?1006l\x1b[?1000l`), writing `DISABLE_SGR_MOUSE` ahead of `RESET_STYLE`/`SHOW_CURSOR`/`EXIT_ALT_SCREEN` on teardown. `VirtualList`, `ScrollView`, `SelectList`, and `CommandPalette` support SGR 1006 wheel scrolling (`VirtualList` and `ScrollView` expose `parseSgrWheelDelta` and `useSgrMouseWheel`, tapping `stdin.read` for intact `\x1b[<64;c;rM` sequences before Ink's CSI filter drops them while also handling ESC-stripped `[<64;c;rM` / `<64;c;rM` frames via `useScopedInput`; `SelectList` also binds `PageUp`/`PageDown`/`Ctrl+D`/`Ctrl+U`).
  - `shouldAutoAscii` (`src/cli-args.ts`) auto-enables pure ASCII borders/charts on legacy Windows `conhost` (absent `WT_SESSION`, `TERM_PROGRAM`, `ConEmuANSI`, `ANSICON`, `MSYSTEM`), `TERM=dumb`, `--ascii`, or `STUDYHUB_TUI_ASCII=1`.
- **Multiline & paste ergonomics (`src/components/TextInput.tsx`)**:
  - Cursor indexing uses grapheme clusters (`splitGraphemes` from `src/render/cjk.ts`) so ZWJ emoji, regional flags, and combining diacritics are never split across cursor moves or deletions.
  - Multiline fields bind `Ctrl+J`, `Shift+Enter` (including orphaned CSI-u `13;2u` and `modifyOtherKeys` `27;2;13~`), and `Alt+Enter` (when `submitOnEnter` is set) for newlines, and `Ctrl+S` / `Ctrl+Enter` (`13;5u`, `27;5;13~`) to submit, avoiding Windows Terminal's `Alt+Enter` fullscreen conflict.
  - `sanitizePastedText` strips ANSI escapes, stray CSI-u/`modifyOtherKeys` tails, and orphaned `200~`/`201~` bracketed-paste markers while preserving Windows/UNC paths; CJK/emoji display width and wrapping use `get-east-asian-width` + `strip-ansi` (`src/render/cjk.ts`).
- **AST & modal invariants (`tests/keymap-audit.test.mjs`)**:
  - Parses `src/**/*.tsx` via the TypeScript AST to enforce: (1) `AppShell` global shortcuts match `PAGE_REGISTRY` and `HelpOverlay` with zero duplicates, (2) zero unclaimed global key collisions in primary views, (3) zero barrel imports in `src/App.tsx`, and (4) explicit bounded `width` props on every `<Modal>` containing `<TextInput>` (preserving `Modal`'s 5-row vertical chrome and `-4` prompt padding).
- **Permanent P2 Quota-Guard Static Audit (`tests/p2-quota-audit.test.mjs`)**:
  - Parses every `.ts`/`.tsx` file under `src/views/` and `src/shell/` via the TypeScript AST to enforce: (1) zero silent paid/LLM action calls inside `useEffect(...)`, (2) every file invoking guarded LLM actions (`deck.merge.suggest`, `source.organize.suggest`, `draft.import.propose`, `generate.suggest`, `generate.path.suggest`, `focus.suggest`, `book.retell`, `generation.courseBook.explain`, `coach.debrief`, `coach.prepare`, `coach.rewrite.retry`, `coach.nudge`, `coach.reply`, `materials.translation.translate`, `note.generate`, `audio.corrections.review`, `source.folder.suggest`) directly imports `components/ConfirmDialog.js` (zero barrel imports) and renders `<ConfirmDialog`, and (3) zero `target: '中文'` / `'English'` regressions in `DocumentReader.tsx` `materials.translation.*` calls (`'zh'` / `'en'` only).
- **Contributor verification checklist**:
  - Keep React hooks above every early return; provide `useTheme()`, `t(lang, zh, en)`, and `asciiMode` fallbacks; route keys through `useKeyScope` / `KeyScopeProvider` (zero raw Ink `useInput` outside `src/input/hooks.ts` and the pre-app boot screen in `src/cli.tsx`); never spawn `sh -c` or `cmd /c`; verify changes with `npm run typecheck`, `npm run lint`, `npm run build`, `npm test`, and root `node scripts/test-audit.mjs --compare-baseline=docs/test-audit-baseline.json --annotations`.
