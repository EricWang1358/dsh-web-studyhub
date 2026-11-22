# StudyHub TUI Contributor Architecture

`@ericwang1358/studyhub-tui` is a React 19.3 + Ink 8 terminal client for StudyHub built with TypeScript, Zustand 5, Zod 4, Chalk 6, Marked 18, `esbuild` code splitting, and `@xterm/headless` E2E tests. It reuses `packages/studyhub-desktop` and `lib/` at runtime with zero invasive upstream edits.

---

## 1. Directory Layout

```text
packages/studyhub-tui/
├── bin/studyhub-tui.mjs        # CLI shim resolving dist/cli.mjs via import.meta.url
├── docs/                       # ARCHITECTURE.md, KEYBINDINGS.md, ROADMAP-21-40.md
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
- **Resilient preferences (`src/host/tui-prefs.ts`)**:
  - `tui.json` reads catch corrupt, truncated, or non-object JSON and fall back cleanly to `DEFAULT_TUI_PREFERENCES`; writes are serialized atomically.

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
- **Barrel-Bypass lazy view imports (`src/App.tsx`)**:
  - Only `LibraryView` is statically imported; the remaining 15 views and `VoicePackModal` use direct `React.lazy(() => import('./views/<dir>/<View>.js'))`—never `./views/*/index.js` barrels—and views lazy-load heavy modals internally.
  - This keeps `dist/cli.mjs` at `6.3 KB` and prevents eager parsing of inactive modal modules.
- **$O(K)$ snapshot fingerprinting (`src/state/snapshot-fingerprint.ts`)**:
  - `computeSnapshotFingerprint` feeds a dual 32-bit FNV-1a `RollingHasher` over structural metadata (revision, counts, timestamps, decks/progress, sources, courses, drafts, runs, jobs, attempts, settings) without `JSON.stringify` on full card/source bodies, skipping unchanged store updates in `syncFromHost` in `< 1 ms`.
- **60fps streaming coalescing (`src/components/useStreamingBuffer.ts`)**:
  - `createStreamingCoalescer` and `useStreamingBuffer(24)` coalesce rapid AI token deltas in `AiHelpDrawer` and `DocumentReader` using a 24 ms trailing timer (`<= ~40` Ink renders/s) and flush synchronously on `finish()`, error, abort, or unmount.
- **Bounded caches & virtualized rendering**:
  - `LruCache` (`src/render/lru.ts`) caps Markdown renders at 256 entries (`mdCache`, keyed with `colorLevel`) and TeX math conversions at 512 entries (`mathCache`).
  - `ReviewView` caps card translations at 32 entries; `store.ts` caps navigation history (24) and toasts (4); `TasksView` caps logs (200 lines); `cli-highlight` loads lazily on fenced code blocks; `VirtualList` windows long lists to viewport height.
- **`NO_COLOR=1` & color fidelity (`src/theme/tokens.ts`)**:
  - `resolveColorCapability` maps `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, TTY state, `WT_SESSION`, and `COLORTERM` to `ColorLevel` (`0–3`).
  - When `level === 0`, `src/cli.tsx` sets `FORCE_COLOR = '0'` before importing Ink and calls `setColorLevel(0)`; `src/render/markdown.ts` styles text via `makeChalk(colorLevel)` so `NO_COLOR=1` emits zero SGR color escapes.
- **Deterministic GC & leak soak**:
  - `@xterm/headless` soak suites (`tests/parity-e2e.test.mjs`, `tests/packaging-smoke.test.mjs`) invoke V8 GC (`--expose_gc`) across 32- and 64-transition resize storms (`80x24` ↔ `160x44`) and assert bounded heap deltas and `0` leaked `FSEventWrap`/`StatWatcher`/`ProcessWrap`/`Timeout` handles after `unmount()` and `host.dispose()`.

---

## 5. Cross-Platform Guarantees & Contributor Rules

- **Linux bash & Windows PowerShell / ConPTY**:
  - `enterTerminalSession` (`src/terminal.ts`) enforces UTF-8 stdio, manages the alternate screen buffer, and restores cursor/raw-mode via `signal-exit`.
  - `shouldAutoAscii` (`src/cli-args.ts`) auto-enables pure ASCII borders/charts on legacy Windows `conhost` (absent `WT_SESSION`, `TERM_PROGRAM`, `ConEmuANSI`, `ANSICON`, `MSYSTEM`), `TERM=dumb`, `--ascii`, or `STUDYHUB_TUI_ASCII=1`.
- **Multiline & paste ergonomics (`src/components/TextInput.tsx`)**:
  - Multiline fields bind `Ctrl+J` and `Shift+Enter` for newlines (`Alt+Enter` when `submitOnEnter` is set) and `Ctrl+S` to submit, avoiding Windows Terminal's `Alt+Enter` fullscreen conflict.
  - Paste input strips ANSI escapes and orphaned `200~`/`201~` bracketed-paste markers; CJK/emoji display width and wrapping use `get-east-asian-width` + `strip-ansi` (`src/render/cjk.ts`).
- **AST & modal invariants (`tests/keymap-audit.test.mjs`)**:
  - Parses `src/**/*.tsx` via the TypeScript AST to enforce: (1) `AppShell` global shortcuts match `PAGE_REGISTRY` and `HelpOverlay` with zero duplicates, (2) zero unclaimed global key collisions in primary views, (3) zero barrel imports in `src/App.tsx`, and (4) explicit bounded `width` props on every `<Modal>` containing `<TextInput>` (preserving `Modal`'s 5-row vertical chrome and `-4` prompt padding).
- **Contributor verification checklist**:
  - Keep React hooks above every early return; provide `useTheme()`, `t(lang, zh, en)`, and `asciiMode` fallbacks; gate `useInput` with `isActive` + loaded state; never spawn `sh -c` or `cmd /c`; verify changes with `npx tsc --noEmit`, `npm run build`, root `npx eslint` on `.mjs` tests, and `npm test`.
