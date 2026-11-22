# StudyHub TUI Contributor Architecture

`@ericwang1358/studyhub-tui` is a React 19.3 + Ink 8 terminal client for StudyHub built with TypeScript, Zustand 5, Chalk 6, Marked 18, `esbuild` code splitting, and `@xterm/headless` E2E tests (0 `zod` runtime imports, 9 minimal runtime dependencies, 385+ automated tests). It reuses `packages/studyhub-desktop` and `lib/` at runtime with zero invasive upstream edits.

---

## 1. Directory Layout

```text
packages/studyhub-tui/
├── bin/studyhub-tui.mjs        # CLI shim resolving dist/cli.mjs via import.meta.url
├── docs/                       # ARCHITECTURE.md, KEYBINDINGS.md, ROADMAP-21-40.md, ROADMAP-41-50.md
├── scripts/
│   ├── build.mjs               # esbuild code-split build (cli, boot-frame, App, host)
│   └── bench.mjs               # Bundle size, cold spawn, boot-frame & RSS/heap probe
├── src/
│   ├── cli.tsx, cli-args.ts    # Fast-path --help/--version, color/ASCII probe, boot frame
│   ├── terminal.ts             # UTF-8 stdio, alt-screen, signal-exit TTY teardown
│   ├── App.tsx                 # StudyHubTuiApp, ViewErrorBoundary, syncFromHost, lazy views
│   ├── types/contracts.ts      # PageId, PAGE_REGISTRY (16 views), HostClient & snapshot types
│   ├── shell/                  # AppShell, TopBar, SideNav, Launchpad, CommandPalette,
│   │                           # HelpOverlay, CoursePickerModal, InboxModal, ShellBootFrame, fuzzy
│   ├── components/             # Panel, Modal, ConfirmDialog, TextInput, VirtualList,
│   │                           # ScrollView, SelectList, SplitPane, MarkdownView, Badge,
│   │                           # focus.ts, useStreamingBuffer.ts
│   ├── state/                  # Zustand store (store.ts) & O(K) snapshot-fingerprint.ts
│   ├── host/                   # desktop-deps.ts, tui-host.ts, presets.ts, tui-prefs.ts,
│   │                           # sample-actions.ts
│   ├── render/                 # lru.ts, cjk.ts, math.ts, markdown.ts, charts.ts
│   ├── theme/tokens.ts         # 4 WCAG palettes + runtime ColorLevel / makeChalk(level)
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

---

## 3. Input & Focus Stack

Keystrokes traverse a deterministic priority stack across `src/shell/AppShell.tsx`, `src/components/focus.ts`, and `src/components/ConfirmDialog.tsx`:

```text
Keypress
  ├── Ctrl+K / Ctrl+R ──► AppShell (Ctrl+K blocked if inputCaptured && !paletteOpen)
  ├── overlayOpen || inputCaptured?
  │     ├── yes ──► Active Modal / TextInput / Overlay (ConfirmDialog gates !shellOverlay)
  │     └── no  ──► isKeyClaimed(input)?
  │                   ├── yes ──► Active View / SelectList (useClaimKeys)
  │                   └── no  ──► AppShell global shortcuts (1-9,0,n,b,t,a,r,c,,,I,?,/,\\,[,],q)
```

1. **Shell global routing (`AppShell`)**: A render-time `routing` ref freezes `overlayOpen`, `inputCaptured`, and `showLaunchpad` for the duration of a single keystroke so pressing `?` or `Esc` never closes and immediately re-opens an overlay in the same tick.
2. **View key claims (`useClaimKeys`)**: Views or lists that legitimately bind a global key in non-modal mode (such as `DIGIT_KEYS` in `SelectList` or `n` in `NotesView`) call `useClaimKeys(keys, active)`; `AppShell` checks `isKeyClaimed(input)` and yields those keys.
3. **Ref-counted capture (`useInputCapture`)**: Every `<Modal>` and focused `<TextInput>` calls `useInputCapture(active)` (via `acquireInputCapture`), incrementing `captureCount` so `store.inputCaptured` suppresses all global single-key shortcuts.
4. **Shell-overlay defense (`ConfirmDialog`)**: `ConfirmDialog` passes `effectiveActive = isActive && !shellOverlay` (`commandPaletteOpen || helpOpen || coursePickerOpen || inboxOpen`) to `useInput`, preventing shell overlays from leaking `y`/`n`/`Enter` into a destructive confirmation underneath.

---

## 4. Performance & NFR Architecture

- **Instant boot (`ShellBootFrame`)**:
  - `src/cli.tsx` handles `--help`/`--version` before importing React or Ink, then mounts `dist/boot-frame.mjs` (`ShellBootFrame`, tested to carry zero static `marked` or `cli-highlight` imports) immediately while `createTuiHost` and `dist/App.mjs` load in parallel.
  - A 64-byte boot stdin buffer captures early user keystrokes while stripping terminal probe/mouse escape noise.
- **5 Barrel-Bypass rules (startup bundle & chunk isolation, enforced in `tests/perf-budget.test.mjs` & `tests/keymap-audit.test.mjs`)**:
  1. `views/*/index.js`: `src/App.tsx` eagerly imports only `LibraryView` and lazy-loads the remaining 15 views plus `VoicePackModal` directly via `React.lazy(() => import('./views/<dir>/<View>.js'))` — never `./views/*/index.js` barrels (`tests/keymap-audit.test.mjs`).
  2. `shell/index.js`: `AppShell` lazy-loads `Launchpad`, `CommandPalette`, `HelpOverlay`, `CoursePickerModal`, and `InboxModal` directly (`./Launchpad.js`, etc.), and `src/App.tsx` / views never import `shell/index.js` (`0` static overlays in `App.mjs`, allowing `AppShell` to inline cleanly; `tests/perf-budget.test.mjs`).
  3. `components/index.js`: Complete `0`-importer Barrel-Bypass across all of `src/` (Round 47); every view, modal, drawer, and shell overlay imports leaf component files directly (`./Panel.js`, `./Badge.js`, `./focus.js`) instead of `components/index.js` (which re-exports `MarkdownView`; `tests/perf-budget.test.mjs`).
  4. `render/index.js`: Complete `0`-importer Barrel-Bypass across all of `src/` (Round 46); callers import leaf render utilities (`cjk.js`, `charts.js`) rather than `render/index.js` (which re-exports `markdown.js` and `math.js`), keeping `marked`, `cli-highlight`, `render/markdown.ts`, and `render/math.ts` out of `dist/boot-frame.mjs`, `dist/App.mjs`, and `49+/71` non-markdown `dist/*.mjs` entry chunks (`tests/perf-budget.test.mjs`).
  5. `host/index.js`: Complete `0`-importer Barrel-Bypass across all of `src/` (Round 48); UI modules import `host/sample-actions.js`, `host/tui-prefs.js`, or `host/presets.js` directly rather than `host/index.js`, isolating `tui-host.ts` and `desktop-deps.ts` from `dist/App.mjs` (`tests/perf-budget.test.mjs`).
- **Signed-int32 $O(K)$ snapshot fingerprinting (`src/state/snapshot-fingerprint.ts`)**:
  - `computeSnapshotFingerprint` feeds a dual signed-int32 FNV-1a `RollingHasher` (`Math.imul` + `| 0`) over structural metadata (revision, counts, timestamps, decks/progress, sources, courses, drafts, runs, jobs, attempts, settings) — avoiding `>>> 0` V8 HeapNumber boxing per step and deferring unsigned conversion to `digest()` — skipping unchanged store updates in `syncFromHost` in `< 1 ms` without full-snapshot `JSON.stringify`.
- **60fps streaming coalescing (`src/components/useStreamingBuffer.ts`)**:
  - `createStreamingCoalescer` and `useStreamingBuffer(24)` coalesce rapid AI token deltas in `AiHelpDrawer`, `DocumentReader`, and `CompanionsModal` using a 24 ms trailing timer (`<= ~40` Ink renders/s) and flush synchronously on `finish()`, error, abort, or unmount.
- **Bounded caches & virtualized rendering**:
  - `LruCache` (`src/render/lru.ts`) caps Markdown renders at 256 entries (`mdCache`, keyed with `colorLevel`) and TeX math conversions at 512 entries (`mathCache`).
  - `ReviewView` caps card translations at 32 entries; `store.ts` caps navigation history (24) and toasts (4); `TasksView` caps logs (200 lines); `cli-highlight` loads lazily on fenced code blocks; `VirtualList` windows long lists to viewport height.
- **`NO_COLOR=1` & cached `makeChalk(level)` (`src/theme/tokens.ts`)**:
  - `resolveColorCapability` maps `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, TTY state, `WT_SESSION`, and `COLORTERM` to `ColorLevel` (`0–3`).
  - `makeChalk(level)` memoizes `ChalkInstance` objects in `CHALK_CACHE` per `ColorLevel` to avoid per-render `new Chalk({ level })` allocations.
  - When `level === 0`, `src/cli.tsx` sets `FORCE_COLOR = '0'` before importing Ink and calls `setColorLevel(0)`; `src/render/markdown.ts`, `src/render/charts.ts`, `src/shell/HelpOverlay.tsx`, and `src/views/exam/ExamRunner.tsx` style text via `makeChalk(colorLevel)` so `NO_COLOR=1` emits zero SGR color escapes.
- **Centralized `--ascii` chrome normalization (`src/components/Badge.tsx`)**:
  - `normalizeAsciiChrome(text, ascii)` maps Unicode UI chrome glyphs (`…`, `↑↓`, `←→`, `›`, `▸`, `▾`, `•`, `✓`, `✕`, `★`, `◆`, `●`, `○`, `☑`, `☐`, `⚠`) via `ASCII_CHROME_MAP` across `Badge`, `StatusPill`, `Panel`, `KeyHintBar`, `ToastStack`, `EmptyState`, and `TextInput` without mutating user-entered values.
- **Deterministic GC & leak soak**:
  - `@xterm/headless` soak suites (`tests/parity-e2e.test.mjs`, `tests/packaging-smoke.test.mjs`) invoke V8 GC (`--expose_gc`) across 32- and 64-transition resize storms (`80x24` ↔ `160x44`) and assert bounded heap deltas and `0` leaked `FSEventWrap`/`StatWatcher`/`ProcessWrap`/`Timeout` handles after `unmount()` and `host.dispose()`.

---

## 5. Cross-Platform Guarantees & Contributor Rules

- **Linux bash & Windows PowerShell / ConPTY**:
  - `enterTerminalSession` (`src/terminal.ts`) enforces UTF-8 stdio, manages the alternate screen buffer, and restores cursor/raw-mode via `signal-exit`.
  - `shouldAutoAscii` (`src/cli-args.ts`) auto-enables pure ASCII borders/charts on legacy Windows `conhost` (absent `WT_SESSION`, `TERM_PROGRAM`, `ConEmuANSI`, `ANSICON`, `MSYSTEM`), `TERM=dumb`, `--ascii`, or `STUDYHUB_TUI_ASCII=1`.
- **Multiline & paste ergonomics (`src/components/TextInput.tsx`)**:
  - Cursor indexing uses grapheme clusters (`splitGraphemes` from `src/render/cjk.ts`) so ZWJ emoji, regional flags, and combining diacritics are never split across cursor moves or deletions.
  - Multiline fields bind `Ctrl+J`, `Shift+Enter` (including orphaned CSI-u `13;2u` and `modifyOtherKeys` `27;2;13~`), and `Alt+Enter` (when `submitOnEnter` is set) for newlines, and `Ctrl+S` / `Ctrl+Enter` (`13;5u`, `27;5;13~`) to submit, avoiding Windows Terminal's `Alt+Enter` fullscreen conflict.
  - `sanitizePastedText` strips ANSI escapes, stray CSI-u/`modifyOtherKeys` tails, and orphaned `200~`/`201~` bracketed-paste markers while preserving Windows/UNC paths; CJK/emoji display width and wrapping use `get-east-asian-width` + `strip-ansi` (`src/render/cjk.ts`).
- **AST & modal invariants (`tests/keymap-audit.test.mjs`)**:
  - Parses `src/**/*.tsx` via the TypeScript AST to enforce: (1) `AppShell` global shortcuts match `PAGE_REGISTRY` and `HelpOverlay` with zero duplicates, (2) zero unclaimed global key collisions in primary views, (3) zero barrel imports in `src/App.tsx`, and (4) explicit bounded `width` props on every `<Modal>` containing `<TextInput>` (preserving `Modal`'s 5-row vertical chrome and `-4` prompt padding).
- **Contributor verification checklist**:
  - Keep React hooks above every early return; provide `useTheme()`, `t(lang, zh, en)`, and `asciiMode` fallbacks; gate `useInput` with `isActive` + loaded state; never spawn `sh -c` or `cmd /c`; verify changes with `npx tsc --noEmit`, `npm run build`, root `npx eslint` on `.mjs` tests, and `npm test`.
