# TUI E2E Flake Triage & Quarantine Register

This document records the audit, root-cause triage, deterministic fixes, and quarantine/isolation policy for the StudyHub TUI (`packages/studyhub-tui`) PTY/`@xterm/headless` E2E test suites.

---

## 1. Audit Scope & Executive Summary

- **Baseline Command**: `node packages/studyhub-tui/scripts/run-tests.mjs --e2e --timing`
- **Coverage**: All **45** PTY/`@xterm/headless` E2E test suites (`--e2e`, LPT-scheduled).
- **CI Execution Context**: `.github/workflows/verify.yml` runs `node packages/studyhub-tui/scripts/run-tests.mjs --shard=${{ matrix.tui_shard }}/3` across 3 parallel Ubuntu shards plus `tui-windows-smoke` on Windows.
- **Baseline Result**: seven findings, listed in section 2: six timeout/race failures seen under parallel CPU & disk I/O contention, plus **1 latent race** (`round-94-ux.test.mjs`) using a bespoke 20 ms polling harness. The baseline run's pass/fail totals and wall-clock time were not kept in a reproducible form (no logs or commit), so this document does not claim them; the per-row evidence below is the failure text as it was reported at triage time, not something re-run on the head.
- **Disposition Verdict**: **0 suites require permanent quarantine.** Every observed failure and latent harness risk had a concrete, deterministic root cause (including a real production duplicate-snapshot race in `createDefaultShellActions` + `App.tsx`, now covered by `packages/studyhub-tui/tests/shell-actions-single-flight.test.mjs`) and was fixed cleanly without weakening assertions or adding arbitrary `sleep()` padding.

---

## 2. Flake Classification & Before/After Triage Matrix

Categories:
- **超时类 (Timeout)**: Legitimate async cold-start/RPC/fsync latency under parallel E2E contention exceeded a rigid sub-budget test deadline.
- **竞态类 (Race)**: Ordering or intermediate-frame race between UI commit, async disk persistence, duplicate snapshot RPCs, or uncoordinated polling loops.

| # | Suite (`File:Line`) | Category | Observed Baseline Evidence | Disposition | Root Cause | Concrete Deterministic Fix (Before -> After) |
|---|---|---|---|---|---|---|
| 1 | `packages/studyhub-tui/tests/packaging-smoke.test.mjs:193,278` | 超时类 (Timeout) | `Timed out waiting for initial library mount after 8000ms` (active spinner `⠴ 正在加载页面…`), plus `npm pack --dry-run --json` `SIGTERM` at `20_000ms` under extreme host CPU load | **可修 (Fixed)** | Initial lazy `LibraryView` chunk import + host `refreshSnapshot()` exceeds 8 s under parallel E2E contention; `npm pack` subprocess exceeded 20 s under heavy host oversubscription. | Raised initial lazy mount deadline `8_000ms -> 25_000ms`, soak view transitions `8_000ms -> 15_000ms`, and `npm pack` / bin smoke subprocess timeouts (`20_000ms -> 45_000ms` / `10_000ms -> 20_000ms`) while keeping strict `isViewReady` + `assertSoakHealthyScreen` + heap/handle assertions intact. |
| 2 | `packages/studyhub-tui/tests/responsive-audit.test.mjs:308` (`:454,:538,:613`), `ascii-full-sweep.test.mjs:293`, `legacy-rounds-16-22.test.mjs:1649` | 超时类 (Timeout) | `Timed out waiting for library @ Pass 1: 80x24 zh Unicode after 8000ms` (`⠧ 正在加载页面…`); identical `8_000ms` lazy-mount ceiling hit in `ascii-full-sweep.test.mjs:293` and `legacy-rounds-16-22.test.mjs:1649` (`ExamSetup rendered`, `⠙ 正在加载页面…`) under extreme host CPU load | **可修 (Fixed)** | Lazy view chunk hydration + `snapshot` RPC exceeds 8 s under contention across the responsive, `--ascii` purity, and Round-16+ `ExamView` passes. | Raised view readiness `waitFor` timeout `8_000ms -> 20_000ms` (`30_000ms` for initial `tsx`-intercepted `library` chunk in `ascii-full-sweep`) while preserving `useTuiStore.getState().page === step.id && expectedRe.test(s) && !STILL_LOADING_RE.test(s)` and full layout/CJK/ASCII/ExamSetup assertions. |
| 3 | `packages/studyhub-tui/tests/xterm-e2e.test.mjs:741-746` (and `:530`) | 超时类 / 竞态类 (Timeout & Race) | `AssertionError: asciiMode persisted to tui.json, false !== true` (at `:751` on origin/main, before the fix) | **可修 (Fixed)** | `AppearanceTab.persistPatch` updates Zustand synchronously (`asciiMode: true`) while `saveTuiPreferences` runs atomic `open + write + fsync + rename` asynchronously; test's `waitFor` resolved on the immediate in-memory render before `saveTuiPreferences` finished, and its ad-hoc `2_000ms` poll expired while `fsync` was still in flight under parallel I/O. | 1) Added cursor readiness anchor (`/[❯>]\s*ASCII/`) before toggling `'l'`; 2) Waited for a settled `AppearanceTab` screen (`!保存中`/`!Saving` plus the success toast or the `实时生效`/`Live` subtitle). This anchor is **not** proof that the file was written: the `实时生效`/`Live` subtitle (`src/views/settings/AppearanceTab.tsx:279`) is also shown before saving starts, so the screen can match before `saveTuiPreferences` has run. The proof of persistence is step 3; 3) Replaced ad-hoc `2_000ms` loops (`tui.json` & `tui-board.json`) with shared `waitForJsonFile(..., { timeoutMs: 10_000 })` in `packages/studyhub-tui/tests/helpers/virtual-tty.mjs`, which polls `tui.json` itself (`xterm-e2e.test.mjs:741-746`) and `tui-board.json` (`:530`) until the parsed content has the expected value. That file check is what proves persistence. |
| 4 | `packages/studyhub-tui/tests/core-views-e2e.test.mjs:243` | 竞态类 / 超时类 (Race & Timeout) | `Timed out waiting for Library after sample load after 12000ms` (screen remained on Launchpad) | **可修 (Fixed)** | **Production race**: `createDefaultShellActions` closed over its own private `refresh()` (`host.call('snapshot')`) even though `App.tsx` overrode `shellActions.refresh` with single-flight `syncFromHost`. During `sample.load`, the fs-watcher triggered `syncFromHost(true)` while `loadSample` simultaneously launched a duplicate `host.call('snapshot')`, doubling CPU/IO contention past `12_000ms`; `loadSample` also lacked an in-flight deduplication guard, and tests sent `'s'` without flushing passive React effects (`useInput`). | 1) **Production fix** (`src/shell/actions.ts`, `src/App.tsx`, `src/shell/AppShell.tsx`): wired `refreshOverride` so `loadSample`/`setCourse`/`createCourse` coalesce with `App.tsx`'s single-flight `syncFromHost`, and added `sampleLoadInFlight` re-entrancy guard; 2) Added `await tty.flush()` (`setImmediate`) after Launchpad renders before `tty.send('s')` and raised sample-load library mount timeout `12_000ms -> 25_000ms`. |
| 5 | `packages/studyhub-tui/tests/legacy-rounds-8-15.test.mjs:375` (and `:1759-1766` toast occlusion) | 竞态类 / 超时类 (Race & Timeout) | `Timed out waiting for Library after sample load after 12000ms` (screen remained on Launchpad); plus `AnswerCardModal closed via Esc` at `:1759-1766` where the bottom-right warning toast overlapped the `卡` glyph of `[A]答题卡` | **可修 (Fixed)** | Identical duplicate-snapshot + Launchpad passive-effect/contention root cause as #4; at `:1759-1766`, `ToastStack` floats over row `height - 2` and can occlude `[A]答题卡` while `ReviewView` is already restored. | Fixed by the production `syncFromHost` coalescing + `sampleLoadInFlight` guard, `await tty.flush()` before `tty.send('s')`, `timeoutMs: 25_000` (`20_000` in `mountSuiteApp`), and toast-proof footer/body anchors (`翻看答案`/`flip card`) at `:1759-1766` and `:1769-1776`. |
| 6 | `packages/studyhub-tui/tests/domain-notes-board.test.mjs:1184-1188,1196-1207` | 竞态类 (Race) | `AssertionError: NotesView must reappear after HelpOverlay Esc (default zh)` (at `:1200` on origin/main) | **可修 (Fixed)** | After pressing `j` at `:1153`, the selected note is `pass.emptyTitle` (`R52 Empty Note`, shown in the right detail pane), while the 17-col `pass.noteTitle` (`R52 Markdown 笔记`) is truncated to `R52 Markdow…` in the 36-col left pane at `120x36`. The origin/main checks at `:1184` and `:1196-1200` only matched `pass.noteTitle` when the 4 s duplicate-import toast (`笔记「R52 Markdown 笔记」已在资料库中`) had not yet auto-dismissed; under contention (> 4 s elapsed), the toast expired before `HelpOverlay` closed, causing a false failure even though `NotesView` was healthy. | Replaced the toast-dependent `pass.noteTitle` checks at `120x36` (`:1184-1188`, `:1196-1207`) with deterministic checks on the actually selected note (`pass.emptyTitle`) plus the `NotesView` header (`学习笔记`/`Notes`) and `!s.includes(helpTitle)`, while keeping both `pass.emptyTitle` and `pass.noteTitle` verified in the full-width `80x24` single-pane view (`:1176`). |
| 7 | `packages/studyhub-tui/tests/round-94-ux.test.mjs:72-80` (origin/main; the head uses `createVirtualTty` at `:132`) + shared `packages/studyhub-tui/tests/helpers/virtual-tty.mjs:35-42,402-408` | 竞态类 / 潜在风险 (Latent Race) | Bespoke `createTtyHarness` with raw `PassThrough`, 20 ms `setTimeout` polling loop, tight `2_000ms` timeout, and missing `finally` unmount/dispose; legacy suites also copied `6_000–10_000ms` `waitFor` overrides that timed out mid-spinner under `STUDYHUB_E2E_CONCURRENCY=4` | **可修 (Fixed)** | Uncoordinated raw-stream polling loop and leaked handles on assertion failure; tight per-call `waitFor` overrides starved active lazy imports and host RPCs under 4-way parallel E2E load. | Migrated `round-94-ux.test.mjs` to shared event-driven `createVirtualTty` + `disposeTerminalPool` with `try { ... } finally { inst?.unmount(); tty.dispose(); }` cleanup; centralized a `20_000ms` contention-safe floor (`WAIT_FOR_FLOOR_MS`) for standard UI/RPC `waitFor` calls (`timeoutMs >= 2_000`, honoring short `< 2_000ms` timeouts verbatim, adding 0 ms to passing frames; see section 2.1) plus shared `waitForJsonFile` helper in `virtual-tty.mjs`. |

### 2.1 `waitFor` deadline floor (read this before writing a timeout)

`createVirtualTty().waitFor` does not use the `timeoutMs` you pass when it is 2_000 or more. It raises it to `WAIT_FOR_FLOOR_MS` (20_000 ms, `packages/studyhub-tui/tests/helpers/virtual-tty.mjs`), via `effectiveWaitTimeoutMs()`:

| You pass `timeoutMs` | The wait really lasts |
|---|---|
| `< 2_000` (for example `1_500`) | exactly that, kept verbatim for deliberate short checks |
| `2_000` to `19_999` (for example `8_000`) | **20_000 ms** |
| `>= 20_000` (for example `30_000`) | exactly that |

- **Why it exists**: lazy ESM chunk imports and host snapshot / atomic-write RPCs can exceed 8 s on a contended runner (`--shard`, `STUDYHUB_E2E_CONCURRENCY=4`) while the UI is still progressing. Hand-tuned per-call numbers of 6 to 12 s kept timing out mid-spinner there, so one floor replaces them. It is deliberate and is not to be removed.
- **What it means for callers**: an explicit `8_000` is a request, not a limit, and the error message reports `after 20000ms`. It only slows **failing** waits. A passing wait resolves on the first frame that satisfies the predicate, so the floor adds 0 ms to green runs.
- **Not a latency assertion**: do not use `waitFor` to prove something is fast. Latency budgets live in the bench tier (`perf-budget.test.mjs`, `scale-nfr.test.mjs`, run isolated with `concurrency=1`).
- Pinned by `packages/studyhub-tui/tests/virtual-tty-wait-floor.test.mjs`.

---

## 3. Active Quarantine Register

| File | Header Marker | Category | Owner | Tracking Issue | Quarantined On | Exit Criteria |
|---|---|---|---|---|---|---|
| *(none)* | — | — | — | — | — | All 45 TUI E2E suites are active and passing. |

---

## 4. Quarantine Policy & Isolation Mechanism

### When Quarantine Is Allowed
Quarantine is a **last resort**, strictly limited to genuinely unfixable, host/OS-coupled flakes (for example, an upstream terminal emulator or OS PTY driver bug that cannot be fixed in repository code).

**Strictly forbidden**:
- Quarantining a test to mask a real product regression or broken assertion.
- Using `test.skip` / `test.todo` (which silently inflates pass counts and is flagged by `scripts/test-audit.mjs`).
- Adding arbitrary `sleep()` / `setTimeout()` padding or weakening behavioral assertions to make a flaky test pass.

Every quarantined suite **must**:
1. Carry a valid leading header marker with a concrete reason and tracking issue reference.
2. Be registered in the **Active Quarantine Register** table above with an owner and explicit exit criteria.
3. Graduate back to the active suite once fixed and proven stable across **3 consecutive contention runs** (`STUDYHUB_E2E_CONCURRENCY=4`).

### Header Marker Syntax
Place a single-line comment in the leading header block of any `packages/studyhub-tui/tests/*.test.mjs` file (contiguous leading `//` comment lines after an optional shebang/blank lines, before any code statements):

```js
// @quarantine: <concrete reason and tracking issue, e.g. Windows ConPTY focus race (#12345)>
```

`// @flaky: <reason>` is also accepted as an alias.

**Guardrails enforced by `packages/studyhub-tui/scripts/run-tests.mjs`**:
- **Fail-fast on malformed markers**: A bare `// @quarantine`, `// @quarantine:`, `// @flaky`, or `// @flaky:` without a non-empty reason immediately aborts the runner with **exit code 2** so no test can ever be silently quarantined without documentation.
- **Header-only parsing**: `@quarantine` / `@flaky` mentions inside test code bodies or string literals below the leading comment header are ignored.
- **No silent skipping**: Whenever default runs isolate one or more quarantined suites, the runner explicitly logs `[tier:quarantine] Isolated N quarantined suite(s)` along with each file path and its recorded reason.
- **Visible on the PR**: when `GITHUB_ACTIONS=true`, the runner also prints one `::warning title=Quarantined TUI test suite::<file> is quarantined (@tag: reason)...` annotation per quarantined suite (isolated or run), so it shows in the Checks summary and not only in the job log. Locally and with `--list` nothing extra is printed (`quarantineWarningAnnotations` in `run-tests.mjs`).
- **A quarantined suite that fails still fails its own run**: `--quarantine` and `--include-quarantined` exit non-zero when a quarantined suite fails; only the default run isolates it (and exits 0 without running it).

### Runner CLI Usage & CI Compatibility
`packages/studyhub-tui/scripts/run-tests.mjs` supports:

| Command | Behavior |
|---|---|
| `node packages/studyhub-tui/scripts/run-tests.mjs` | Runs active `unit`, `bench` (`concurrency=1`), and `e2e` tiers; isolates quarantined suites and prints them explicitly if any exist. |
| `node packages/studyhub-tui/scripts/run-tests.mjs --shard=i/n` | LPT-balanced sharding across active suites (100% compatible with `.github/workflows/verify.yml` `tui-test` 3-shard matrix). |
| `node packages/studyhub-tui/scripts/run-tests.mjs --unit` / `--e2e` | Filters to the unit (+bench) or PTY/xterm E2E tier. |
| `node packages/studyhub-tui/scripts/run-tests.mjs --quarantine` | Runs **only** quarantined suites in `[tier:quarantine]` (isolated, `concurrency=1`). Combinable with `--e2e`, `--unit`, `--shard=i/n`, `--list`, `--timing`. |
| `node packages/studyhub-tui/scripts/run-tests.mjs --include-quarantined` | Runs all active tiers **plus** `[tier:quarantine]` (`concurrency=1`). Combinable with `--e2e`, `--unit`, `--shard=i/n`, `--list`, `--timing`. |
| `node packages/studyhub-tui/scripts/run-tests.mjs tests/<file>.test.mjs` | Always runs explicitly named files directly. |

Conflicting flag combinations (`--unit --e2e` or `--quarantine --include-quarantined`) and invalid `--shard` specs fail fast with **exit code 2**.

Unit & CLI integration coverage for the marker parser, malformed-marker rejection, flag validation, sharding, `[tier:quarantine]` isolation, the GitHub Actions annotation, and the non-zero exit of a failing quarantined suite lives in `packages/studyhub-tui/tests/run-tests-quarantine.test.mjs`.

---

## 5. Verification Evidence

All verification gates passed after the final edits:

1. **Build, Typecheck, Lint & Audit Gate**:
   - `cd packages/studyhub-tui && npm run build && npx tsc --noEmit` -> **exit 0**
   - `npx eslint --max-warnings=0` across all 15 touched JS/TS/MJS files -> **exit 0** (0 errors, 0 warnings)
   - `node scripts/test-audit.mjs --gate-from=$(git merge-base origin/main HEAD)` -> **exit 0** (`0 new blocking assertion(s) in 10 changed test file(s) checked`)
   - `git diff --check` -> **exit 0**
2. **Quarantine Runner Unit & CLI Integration Suite**:
   - `node --test packages/studyhub-tui/tests/run-tests-quarantine.test.mjs` -> **10/10 PASS** (valid `@quarantine`/`@flaky` headers, malformed bare-marker exit code 2, non-header ignore, flag conflict exit code 2, `--list`/`--shard`/`--quarantine`/`--include-quarantined` isolation, GitHub Actions `::warning::` annotation, failing quarantined suite exits non-zero).
   - `node --test packages/studyhub-tui/tests/shell-actions-single-flight.test.mjs` -> proves the production race fix: with `refreshOverride`, `loadSample` / `setCourse` / `createCourse` send 0 `snapshot` RPCs; concurrent `loadSample()` sends one `sample.load`; the guard clears after a thrown host call and after `ok:false`. It fails when `actions.ts`, `App.tsx` and `AppShell.tsx` are reverted to origin/main.
3. **3x Contention Repeat (`STUDYHUB_UNIT_CONCURRENCY=4 STUDYHUB_E2E_CONCURRENCY=4`) on All 9 Fixed E2E Suites**:
   - Suites: `packaging-smoke`, `responsive-audit`, `ascii-full-sweep`, `xterm-e2e`, `core-views-e2e`, `legacy-rounds-8-15`, `legacy-rounds-16-22`, `domain-notes-board`, `round-94-ux`.
   - Run 1/3: **92/92 PASS (0 fail)**
   - Run 2/3: **92/92 PASS (0 fail)**
   - Run 3/3: **92/92 PASS (0 fail)**
   - Total: **276/276 PASS, 0 FAIL, 0 SKIPPED**.
4. **Full 45-Suite TUI E2E Timing Run**:
   - `node packages/studyhub-tui/scripts/run-tests.mjs --e2e --timing` -> **`[e2e:PASS(45)]` in `431.29s`** (45/45 PASS, 0 FAIL; wall time measured on the author's machine, not comparable to any other run).
   - CI shard & list compatibility verified: `--shard=1/3` (48), `--shard=2/3` (48), `--shard=3/3` (49), 145 files in all, after the review follow-up, `--e2e --list` (45), `--unit --list` (100, after the two tests added in the review follow-up), `--quarantine --list` (0).

---

# Root-Repo `npm test` Flake Triage & Quarantine Register

This section records the audit, root-cause fixes, and quarantine/isolation mechanism for the root repository test suite (`npm test`, driven by `scripts/test.mjs`, `scripts/qa/run-tests.mjs`, `scripts/qa/test-schedule.mjs`, and `scripts/qa/test-phases.mjs`).

---

## 6. Root Audit Scope & Executive Summary

- **CI Execution Context**: `.github/workflows/verify.yml` runs `node scripts/test.mjs --shard=${{ matrix.shard }}/${{ matrix.shards }}` across 12 Ubuntu shards and 16 Windows shards.
- **Evidence Cross-Referenced**:
  - Recent failed `main` and PR CI runs on Ubuntu and Windows shards (`ubuntu-2/12`, `ubuntu-6/12`, `ubuntu-10/12`, `windows-2/16`, `windows-6/16`, `windows-7/16`, `windows-8/16`, `windows-10/16`, `windows-16/16`).
  - Local fast-tier (`node scripts/test.mjs --fast --test-concurrency=2`) and sharded contention runs.
- **Disposition Verdict**: **0 root suites require permanent quarantine.** All 8 concrete, reproducible flakes (7 test/harness races or wall-clock timing assertions + 1 production TOCTOU bug in `ui/components/ErrorState.jsx` and timer-injection support in `lib/assist.js`) were fixed at their root cause without adding arbitrary `sleep()` padding, relaxing thresholds, or weakening assertions. Two heavy browser suites observed in Windows/Ubuntu CI (`tests/reader-one-chapter-browser.test.mjs`, `tests/reader-formula-scroll-browser.test.mjs`) remain active with their full regression assertions intact (`tests/reader-formula-scroll-browser.test.mjs` already runs isolated in phase 1 via `runWithTimingFiles` in `scripts/qa/run-tests.mjs`).

---

## 7. Root Flake Classification & Before/After Triage Matrix

| # | Suite (`File:Line`) | Category | Observed Baseline Evidence | Disposition | Root Cause | Concrete Deterministic Fix (Before -> After) |
|---|---|---|---|---|---|---|
| 1 | `tests/passage-links.test.mjs:124-135` | 超时类 (Timeout) | Local fast-tier run: `AssertionError: took 2278 ms` against `< 1000` ms | **可修 (Fixed)** | Single-shot wall-clock `performance.now()` assertion (`elapsed < 1000`) measures OS scheduling preemption under parallel test contention (~60 ms CPU inflated past 2 s wall time), violating `docs/performance.md` rule 2. | Replaced single-shot `performance.now()` with `assertCpuBudget` from `tests/helpers/perf-gate.mjs` (`maxMedianMs: 1000`, `warmup: 1, samples: 3, batch: 1`), preserving the exact `< 1000 ms` budget and `entries.length === 400` / `dom.stats.walks === 1` assertions. |
| 2 | `tests/assist-host.test.mjs:224,402,580` (and `tests/assist-host.runtime.test.mjs`) + `lib/assist.js:75,209,296` | 竞态类 (Race) | CI `ubuntu-6/12`: `native timeout discards output and disposes even a child admitted after timeout` failed with `Error: Task did not settle`; local `--test-concurrency=4` also hit `Task did not settle` in `timed-out reused children` (`:224`) | **可修 (Fixed)** | Hardcoded `timeoutMs: 10` / `15` armed `setTimeout` inside `startAssist` (`lib/assist.js:209`) before async `context.jobs.submit` / `withAssistChild` entered `subagents.start()` or `child.whenIdle()`. When I/O or CPU contention exceeded 10–15 ms, `signal.throwIfAborted()` fired before admission, leaving `disposed === 0` forever. | Added optional `setTimer` / `clearTimer` dependency injection to `createAssistService` in `lib/assist.js` (defaulting to global `setTimeout` / `clearTimeout`, matching `ui/use-copy-feedback.js`). Reconciled with `#1809`: `timed-out reused children` (`:224`) verifies the 15 ms timer is armed and asserts `whenIdle` (`waiting`) is reached before firing the injected callback (avoiding global `t.mock.timers`), while `:402` and `:580` wait on deterministic `entered` / `resultRead` gates before triggering the timeout callback. |
| 3 | `tests/page-boundary-browser.test.mjs:62-69` + `ui/components/ErrorState.jsx:37-41` + `tests/setup-diagnostics.test.mjs:141-155` | 竞态类 (Race) | CI `windows-2/16`: `AssertionError` comparing multiline `text` vs `shown` (`what is copied is what was shown`) | **可修 (Fixed)** | `CopyDiagnosticsButton` called `describe()` once when opening `看看会复制什么` (`<textarea>`) and a second time when clicking `复制诊断信息`. On slow Windows runners, a buffered `PerformanceObserver` `longtask` entry could arrive between the two calls, changing the `Long tasks` count between preview and clipboard. | **Production fix** (`ui/components/ErrorState.jsx`): when the preview fold is open (`open && field.current`), `CopyDiagnosticsButton` copies `field.current.value` directly so copied text matches the inspected preview verbatim; closed-fold copies still call `describe()` freshly. Pinned by a new assertion in `tests/setup-diagnostics.test.mjs`. |
| 4 | `tests/follow-label-fit-browser.test.mjs:124-131` | 竞态类 (Race) | CI `windows-6/16`: `Timed out waiting for the select to follow the session again` | **可修 (Fixed)** | Reopening `effortPlanning` clicked `.sh-opt` option 0 immediately after `data-starting-style` cleared without verifying the select was enabled (`!disabled` after `ControlRow`'s `working` lock) or waiting for the popup CSS transition (`settleAnimations`) and option visibility. | Waited for `!(await planning.isDisabled())`, ran `settleAnimations(page)`, and awaited `followOption.waitFor({ state: 'visible' })` before clicking option 0; full layout, tooltip, and follow-session assertions unchanged. |
| 5 | `tests/question-chapter-hint-browser.test.mjs:508-520` | 竞态类 (Race) | CI `windows-10/16`: `page.waitForFunction: Timeout 15000ms exceeded.` on Round 2 card navigation | **可修 (Fixed)** | Called non-waiting `topicTicks.count()` before `.review-tick` mounted and iterated after `tick.click()` without waiting for the async `review.move` RPC to set `aria-current="step"` on the clicked tick. | Added `await topicTicks.first().waitFor({ timeout: 15000 })` and waited deterministically for `aria-current === 'step'` after each `tick.click()`. |
| 6 | `tests/course-book-structure-browser.test.mjs:160-163` | 竞态类 (Race) | CI `windows-8/16`: `TimeoutError` during stale-version retry at 420 px | **可修 (Fixed)** | After releasing the held `course.book.open` refresh, `width === 1280` waited for `.book-toc__go` (which implies refresh finished), whereas `width === 420` skipped that wait and pressed `Enter` while `保存` was still disabled (`retry waits for the current version`). | Added explicit `until(async () => !(await stale.getByRole('button', { name: '保存' }).isDisabled()), ...)` before pressing `Enter` at both 1280 px and 420 px. |
| 7 | `tests/question-term-marks-browser.test.mjs:171-180,264-295,1493-1575` | 竞态类 (Race) | Local full run (`#1192`: `zh@1280: clicked word appears in chip bar`, `[]` vs `['权衡']`) and repeat verification (`#1214`: `term B added while task A is running`, `['idempotency']` vs `['idempotency', 'snapshotting']`) | **可修 (Fixed)** | `#1192` clicked `termsBtn` without waiting for marking-mode bar layout settlement before measuring word click coordinates, and both `#1192` and `#1214` called non-waiting `locator.allTextContents()` (`chipTexts`) immediately after `page.mouse.click` / drag before React committed the chip DOM. | Used `enterMarkingMode` + `settleAnimations` before word coordinate lookup in `#1192`, added `waitForChipTexts(page, expected)` and `waitForChipStripGone` around mouse-driven term toggles while keeping exact `assert.deepEqual` checks intact. |
| 8 | `tests/practice-round-controls-browser.test.mjs:100-104` | 竞态类 (Race) | CI `ubuntu-2/12`: `locator.click: Timeout 120000ms exceeded` waiting for `getByRole('button', { name: '继续 Round controls 3' }).first()` | **可修 (Fixed)** | Called non-waiting `showAll.count()` immediately after `page.goto(server.url)` before `ui/StudyMap.jsx` hydrated `snapshot` and mounted `ui/study-map/DeckTree.jsx` (`.map-tree`), returning `0` and leaving the 4th deck (`Round controls 3`) collapsed behind `.show-other-courses[aria-expanded="false"]`. | Awaited `page.locator('.map-tree').waitFor({ timeout: 30000 })` before checking `showAll.count()`, ensuring `DeckTree` and its `show-other-courses` toggle have committed before deciding whether to expand. |
| 9 | `tests/first-run-tour-browser.test.mjs:211-224` | 竞态类 / 已修复 (Already fixed on `main`) | Earlier CI `windows-7/16` (before commit `738aa1c64`): `420px: 「设置：学习库与 AI 模型」's spotlight ends above the docked card` | **无需再改 (Fixed in `738aa1c64`)** | Prior to `738aa1c64`, narrow-docked spotlight boxes were not clipped to `floor` above the docked popover (`ui/tour/geometry.js`). | Already resolved on `origin/main` in `738aa1c64` (`dock()` clips `spot.height` above `floor`). |
| 10 | `tests/reader-formula-scroll-browser.test.mjs:238-248` & `tests/reader-one-chapter-browser.test.mjs:112` | 环境依赖类 (Shared VM Jitter) | CI `ubuntu-10/12` (`longest 140` vs `100 ms` on 1 of 20 scroll steps) and `windows-16/16` (`TimeoutError` on 500-page book) | **保持激活 (Keep active)** | Transient shared-CI VM CPU spikes on heavy Chromium scroll/500-page chapter suites. Both guard high-value rendering regressions and `tests/reader-formula-scroll-browser.test.mjs` already runs alone in phase 1 (`scripts/qa/run-tests.mjs`). | Kept active without relaxing assertions or quarantining healthy suites; tracked here for future monitoring. |

---

## 8. Root Active Quarantine Register

| File | Header Marker | Category | Owner | Tracking Issue | Quarantined On | Exit Criteria |
|---|---|---|---|---|---|---|
| *(none)* | — | — | — | — | — | All root suites are active. |

---

## 9. Root Quarantine Policy & Isolation Mechanism

The root test runner (`scripts/test.mjs`, `scripts/qa/run-tests.mjs`, `scripts/qa/test-schedule.mjs`, `scripts/qa/test-phases.mjs`) mirrors the exact marker convention and guardrails established for `packages/studyhub-tui`:

### Header Marker Syntax
Place a single-line comment in the contiguous leading `//` header comment block of any `tests/*.test.mjs` file (after an optional shebang or blank lines, before any code statements):

```js
// @quarantine: <concrete reason and tracking issue, e.g. Windows Chromium IPC stall (#1763)>
```

`// @flaky: <reason>` is accepted as an alias.

**Guardrails enforced by `scripts/qa/test-schedule.mjs` + `scripts/qa/run-tests.mjs` + `scripts/test.mjs`**:
- **Fail-fast on malformed markers**: Any bare `// @quarantine`, `// @quarantine:`, `// @flaky`, or `// @flaky:` without a non-empty reason aborts immediately with **exit code 2** (including under `--list`).
- **Header-only parsing**: `@quarantine` / `@flaky` strings or comments below the leading comment header are ignored.
- **No silent skipping**: Whenever default runs isolate quarantined suites, `scripts/qa/run-tests.mjs` logs `[quarantine] Isolated N quarantined suite(s)` with each file path and reason to `stderr`, and emits GitHub Actions `::warning title=Quarantined test suite::...` annotations when `GITHUB_ACTIONS=true` (never locally and never on `--list`).
- **Isolated execution**: Quarantined suites run unbatched in their own sequential `concurrency=1` phase (`scripts/qa/test-phases.mjs`), and failing quarantined suites exit non-zero under `--quarantine` and `--include-quarantined`.

### Root Runner CLI Usage & CI Compatibility

| Command | Behavior |
|---|---|
| `node scripts/test.mjs` / `node scripts/qa/run-tests.mjs` | Runs active suites (timing phase -> parallel batched/unbatched workers); isolates quarantined suites and logs `[quarantine] Isolated N quarantined suite(s)` explicitly if any exist. |
| `node scripts/test.mjs --shard=1/12` | Deterministic weight-balanced sharding across active suites (100% compatible with `.github/workflows/verify.yml` `--shard=I/N`, `--fast`, `--list`, `--core`, `--smart`). |
| `node scripts/test.mjs --quarantine` | Runs **only** quarantined suites, unbatched and isolated at `concurrency=1`. Combinable with `--fast`, `--shard=I/N`, `--list`, `--core`, `--smart`. |
| `node scripts/test.mjs --include-quarantined` | Runs all active suites **plus** quarantined suites (isolated at `concurrency=1`). Combinable with `--fast`, `--shard=I/N`, `--list`, `--core`, `--smart`. |
| `node scripts/test.mjs tests/run-tests-quarantine.test.mjs` | Always runs explicitly named files directly via `node --test`. |

Conflicting flag combinations (`--quarantine --include-quarantined`) and invalid `--shard` specs fail fast with **exit code 2**.

Unit & subprocess CLI coverage lives in `tests/run-tests-quarantine.test.mjs` (registered in `tests/slow-tests.json` under `cli`).

---

## 10. Root Verification Evidence

1. **Lint, Test-Audit, Docs & Workflow Gates**:
   - `npx eslint --max-warnings=0` on all 15 touched JS/MJS/JSX files -> **exit 0** (0 errors, 0 warnings).
   - `node scripts/test-audit.mjs --gate-from=$(git merge-base origin/main HEAD)` -> **exit 0** (`0 new blocking assertion(s)`).
   - `node --test tests/run-tests-quarantine.test.mjs tests/docs-paths-and-commands-audit.test.mjs tests/docs-links.test.mjs tests/ci-workflow-gates.test.mjs tests/slow-tests-list.test.mjs tests/test-runner-schedule.test.mjs tests/test-runner-shards.test.mjs tests/test-runner-batch.test.mjs` -> **all PASS**.
   - `git diff --check` -> **exit 0**.
2. **3x Back-to-Back Verification on Fixed Pure-Node & Quarantine Suites (`--test-concurrency=4`)**:
   - Suites: `tests/passage-links.test.mjs`, `tests/assist-host.test.mjs`, `tests/assist-host.runtime.test.mjs`, `tests/setup-diagnostics.test.mjs`, `tests/run-tests-quarantine.test.mjs`.
   - Run 1/3: **99/99 PASS (0 fail)**
   - Run 2/3: **99/99 PASS (0 fail)**
   - Run 3/3: **99/99 PASS (0 fail)**
   - Total: **297/297 PASS, 0 FAIL, 0 SKIPPED**.
3. **Browser Suite Verification (`STUDY_QA_REQUIRE_BROWSER=1`, `--test-concurrency=1`)**:
   - `tests/page-boundary-browser.test.mjs`: **3/3 runs PASS (3/3 tests, 0 fail)**.
   - `tests/follow-label-fit-browser.test.mjs`: **3/3 runs PASS (6/6 tests, 0 fail)**.
   - `tests/question-chapter-hint-browser.test.mjs`: **3/3 runs PASS (3/3 tests, 0 fail)**.
   - `tests/course-book-structure-browser.test.mjs`: **3/3 runs PASS (9/9 tests, 0 fail)**.
   - `tests/question-term-marks-browser.test.mjs`: `#1192` **3/3 runs PASS (0 fail)** and `#1214` **3/3 runs PASS (0 fail)**.
   - `tests/practice-round-controls-browser.test.mjs`: **4/4 tests PASS (0 fail)**.
4. **Root Runner `--list` & `--shard` Compatibility**:
   - Verified `node scripts/qa/run-tests.mjs --quarantine --list` (0 files, exit 0), `--shard=1/12 --list` .. `--shard=12/12 --list`, and `--quarantine --include-quarantined --list` (exit 2).
