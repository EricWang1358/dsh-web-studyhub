# StudyHub TUI Architecture & Engineering Spec

## Core Principles & NFRs
1. **Tech Stack (aligned with `dsh-TUI`)**: React 19.3 + Ink 8 + TypeScript + Chalk 6 + Marked 18 + cli-highlight + cli-boxes + figures + wrap-ansi + strip-ansi + get-east-asian-width + Zustand 5 + Zod 4 + esbuild bundle + `@xterm/headless` E2E verification.
2. **Model Provider Policy**:
   - **Primary**: Local `agy` CLI (`mode: 'agy'`). On first launch without existing config, auto-probe `agy` and select it as default with smart model pick.
   - **Secondary**: OpenAI-compatible HTTP endpoints (`mode: 'openai'`), with DSH-TUI style quick presets (DeepSeek, OpenAI, SiliconFlow, Zhipu GLM, OpenRouter, Custom Base URL), env var detection (`DEEPSEEK_API_KEY` / `OPENAI_API_KEY`), reasoning effort, and one-key connection test.
3. **Performance & Memory NFRs**:
   - Cold start to first interactive frame `< 350ms` (esbuild bundled entry, lazy view loading).
   - Lean RSS memory: never hold full document bodies in global store; cap chat/trace/toast buffers; virtualize lists > viewport height; memoize Markdown/Math rendering by content hash/key.
   - CJK-perfect alignment using `get-east-asian-width` + `strip-ansi` so Chinese/English mixed columns, borders, and tables never break at `80x24`, `100x30`, or `120x36`.
   - Zero-flicker alternate screen buffer with guaranteed TTY restore via `signal-exit`.
4. **Zero Invasive Changes to Upstream**: All new code lives under `packages/studyhub-tui/` (plus optional root `tui` npm script). Reuses `lib/` and `packages/studyhub-desktop/` directly!

## Strict Module Ownership (Zero Merge Conflicts)
- `src/types/contracts.ts`, `src/state/store.ts` -> Coordinator (shared contract)
- `src/host/**` -> `host-eng`
- `src/theme/**`, `src/render/**`, `src/components/**`, `src/shell/**` -> `design-eng`
- `src/views/library/**`, `src/views/review/**`, `src/views/wrongbook/**` -> `core-study-eng`
- `src/views/sources/**`, `src/views/generate/**`, `src/views/tasks/**`, `src/views/audio/**` -> `material-gen-eng`
- `src/views/exam/**`, `src/views/dashboard/**`, `src/views/book/**`, `src/views/skeleton/**`, `src/views/examcoach/**`, `src/views/examprep/**`, `src/views/notes/**`, `src/views/board/**`, `src/views/settings/**` -> `exam-tools-eng`
- `src/App.tsx`, `src/cli.tsx`, `bin/studyhub-tui.mjs`, `scripts/build.mjs` -> Coordinator
- `tests/**` -> `qa-verifier`
