# M0 Empirical Verification & Audit Report

> **Historical snapshot (M0 / StudyHub v4.14.0)**: Kept as the pre-Wave-2 audit record. Most Wave 2 items (including central `hasChatHost` copy-prompt degradation, `hostPart` registrations, Desktop Retrieval support, and `mapAgyUsageToBuckets`) have since landed; see current code for up-to-date line numbers and status.

> **Scope**: `studyhub-desktop` (branch `desktop`, based on StudyHub v4.14.0).
> **Deliverables**:
> 1. Real `agy` CLI empirical probe, sanitized fixtures (`packages/studyhub-desktop/fixtures/agy-real-output.json` & `packages/studyhub-desktop/fixtures/agy-stream-output.jsonl`), and Windows CLI shim discovery failure signatures (`claude` / `codex`).
> 2. Exhaustive `chat: false` / Main-Session Degradation & Copy Audit across v4.14.0 `ui/`.

---

## Part 1: Real `agy` CLI Probe & Windows Shim Discovery Signatures

### 1.1 `agy` Binary Discovery & Version

| Check | Result |
|---|---|
| `Get-Command agy` / `spawnSync("agy", ["--version"])` | **`ENOENT`** — `agy` is **NOT** in default `PATH` on Windows. (`%USERPROFILE%\.gemini\antigravity\bin` is in `PATH`, but contains only `agentapi.bat` and `webm_encoder.exe`.) |
| Actual executable path | `%USERPROFILE%\.gemini\bin\agy.exe` (~226 MB standalone native Go executable) |
| `agy.exe --version` | Exit `0`, stdout: `"1.5.5\n"`, stderr: `""` |
| `agy.exe --help` | Exit `0`, stdout: `""`, **stderr**: full flag & subcommand usage |
| `agy.exe acp --help` | Exit `0`, stdout: `""`, **stderr**: ACP stdio server flags (`--stdio`, `--sandbox`, `--agent`, `--add-dir`, `--dangerously-skip-permissions`, `--login`, etc.) |
| `agy.exe models` | Exit `0`, **stderr**: `"Fetching available models...\n"`, **stdout**: tab-separated `<model-id>\t<Display Name>\n` lines (26 models returned, e.g., `gemini-4-neon-high`, `gemini-3.8-flash-medium`, `claude-sonnet-5-5-medium`, `gpt-oss-120b-medium`) |

> **Discovery contract for `backend-desktop`**:
> Do NOT rely solely on `PATH`. Explicitly check candidate absolute paths in order:
> 1. User-configured override path (if set)
> 2. `%USERPROFILE%\.gemini\bin\agy.exe` (Windows) / `~/.gemini/bin/agy` (POSIX)
> 3. `PATH` lookup (`agy.exe` / `agy`)

### 1.2 Supported Flags (`agy` v1.5.5)

Relevant print-mode flags observed from `agy.exe --help`:

- `-p`, `--print`, `--prompt` — **STRING flag** (NOT boolean!): runs a single prompt non-interactively and prints the response.
- `--output-format` — `text` (default), `json`, `stream-json`.
- `--input-format` — `text` (default), `stream-json` (reads one NDJSON message per line from stdin; requires `--output-format stream-json`).
- `--json-schema` — optional JSON schema string or path to a schema file to enforce structured output.
- `--model` — model ID for the current CLI session.
- `--effort` — reasoning effort (`low|medium|high|xhigh|max`).
- `--print-timeout` — Go duration string (e.g. `120s`, default `0s` = wait until turn completes).
- `--disable-slash-commands` — disables slash command and skill expansion in print mode (**MUST always be passed** so study content beginning with `/` is never interpreted as a command).
- `--sandbox` — runs in a sandbox with terminal restrictions enabled.
- `--mode` — `accept-edits`, `auto`, `plan`.
- `--settings` — session-only JSON object or file path of `settings.json` keys (never persisted).
- `--dangerously-skip-permissions` — **NEVER pass** (auto-approves tool execution).

**Flags `agy` v1.5.5 does NOT have**:
- No `--system-prompt` / `--append-system-prompt`
- No `--disable-tools` / `--allowedTools`
- No `--no-session-persistence`

### 1.3 Empirical Invocation Constraints & Real JSON Schema

#### A. Flag Ordering & Stdin Piping Behavior
1. **`-p` is a string flag**:
   - Invoking `agy -p --output-format json` fails immediately (**exit `2`**, 289 ms) with stderr:
     ```text
     Error: -p took "--output-format" as its prompt, so the intended prompt was left as an argument and ignored.
     Attach the prompt to the flag (-p='your prompt') and move --output-format elsewhere on the command line.
     ```
   - **Rule**: Always place flags BEFORE `-p`, e.g. `['--output-format', 'json', '--disable-slash-commands', '--print-timeout', '120s', '-p', prompt]`.
2. **Stdin piping in `text` mode is NOT supported with empty `-p=`**:
   - Invoking `agy --output-format json --disable-slash-commands --print-timeout 60s -p=` with prompt piped on `stdin` fails immediately (**exit `1`**, 593 ms):
     - **stdout**:
       ```json
       {"conversation_id":"","status":"ERROR","response":"","error":"Error: empty prompt. Usage: agy --print \"your prompt here\"","duration_seconds":0.0002896,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0},"finished_reason":"error"}
       ```
     - **stderr**:
       ```text
       error: Error: empty prompt. Usage: agy --print "your prompt here"
       ```
3. **SOLVED — Large Prompts (>32 KB Windows `CreateProcess` argv limit) via `stream-json` Stdin (RECOMMENDED PRIMARY TRANSPORT)**:
   - Because `-p <prompt>` passes the prompt in CLI `argv`, Windows `CreateProcessW` (32,767 UTF-16 char limit) breaks large StudyHub generation/companion prompts if `-p` is used.
   - **Verified working invocation (zero argv limit)**:
     ```text
     agy.exe --input-format stream-json --output-format stream-json --disable-slash-commands --print-timeout <sec>s [--model <id>] [--effort <level>] [--json-schema <schema>]
     ```
     Write ONE NDJSON line to `stdin` and close `stdin` (`stdin.end()`):
     ```json
     {"event":"user","message":{"content":"<full prompt of any length>"}}\n
     ```
   - **Empirical >37 KB round-trip test** (sanitized fixture: `fixtures/agy-stream-output.jsonl`):
     - Input: `37,691` bytes prompt (`38,171` bytes NDJSON line) with a verification token (`STREAM_OK_37KB`) placed at the very end (past the 32 KB Windows argv boundary).
     - Result: Exit **`0`**, elapsed `6,557 ms` (`duration_seconds`: `4.0221902`), `stderr: ""` (empty), clean process exit on stdin EOF.
     - Output: **4 NDJSON lines** on `stdout`:
       1. `{"event":"init","conversation_id":"...","init":{"cwd":"...","tools":[...60 tools...],"permission_mode":"request-review"}}`
       2. `{"event":"step_update","step_update":{"conversation_id":"...","step_index":0,"state":"DONE","step_type":"user_input"}}`
       3. `{"event":"step_update","step_update":{"conversation_id":"...","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"STREAM_OK_37KB\n","duration_seconds":3.6900981,"usage":{...}}}`
       4. `{"event":"result","result":{"conversation_id":"...","status":"SUCCESS","response":"STREAM_OK_37KB\n","duration_seconds":4.0221902,"num_turns":1,"usage":{"input_tokens":17806,"output_tokens":80,"thinking_tokens":72,"cache_read_tokens":0,"total_tokens":17886}}}`
     - The end-of-prompt marker echoed verbatim (`"STREAM_OK_37KB\n"`), proving zero truncation past 32 KB.
   - **Stdin line-buffer ceiling test (0 LLM cost)**:
     - Probing `stream-json` stdin with single NDJSON lines of `100 KB` (`102,436` bytes), `500 KB` (`512,036` bytes), and **`2,048 KB` (`2,097,188` bytes)** all parsed cleanly (`exit 0`, zero `bufio.Scanner: token too long` error).
   - **Unified parser contract**:
     - The terminal `event === "result"` line's `.result` object has the **exact same JSON schema** as `--output-format json` (both on `SUCCESS` and on `ERROR`). Using `stream-json` for **all** calls (small and large) eliminates the Windows 32 KB argv bug, avoids CLI quoting edge cases, and leaves only one code path to maintain.

#### B. Real Isolated Call Result (Sanitized Fixture: `fixtures/agy-real-output.json`)
- **Command**: `agy.exe --output-format json --disable-slash-commands --print-timeout 60s -p <wrapped prompt>`
- **Working directory**: fresh empty temp dir (`os.tmpdir()/agy-probe-*`)
- **Exit code**: `0`
- **Elapsed wall time**: `6,539 ms` (`duration_seconds`: `3.8048947`)
- **stderr**: `""` (empty on success)
- **stdout** (exact single-line JSON terminated by `\n`; `conversation_id` sanitized in `fixtures/agy-real-output.json`):
  ```json
  {
    "conversation_id": "00000000-0000-4000-8000-000000000001",
    "status": "SUCCESS",
    "response": "PONG\n",
    "duration_seconds": 3.8048947,
    "num_turns": 1,
    "usage": {
      "input_tokens": 8306,
      "output_tokens": 45,
      "thinking_tokens": 42,
      "cache_read_tokens": 0,
      "total_tokens": 8351
    }
  }
  ```

#### C. Key Schema & Behavioral Constraints for `backend-desktop`
1. **Success vs Error fields**:
   - Success: `status === "SUCCESS"`, `response` is a string (usually ends with `\n`), `error` and `finished_reason` are omitted.
   - Error: `status === "ERROR"`, `error` (string) and `finished_reason` (`"error"`) are present, exit code is `1` (or `2` for Go flag parse errors where stdout is empty and stderr has the message).
2. **Usage accounting**:
   - `usage` provides `{ input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens }`.
   - Note that `total_tokens === input_tokens + output_tokens` (`8306 + 45 = 8351`), so `thinking_tokens` (`42`) is **already counted inside `output_tokens`**. Do not double-add `thinking_tokens` when summing tokens.
   - Map to StudyHub's standard usage format: `{ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens, reasoningTokens: usage.thinking_tokens, cacheReadTokens: usage.cache_read_tokens }`.
3. **System Prompt Wrapping & Tool Safety**:
   - Because `agy` has no `--system-prompt` or `--disable-tools` flag, wrap system + user messages into one prompt:
     ```text
     [System Instruction]
     <systemPrompt>
     Do not call any tools, do not read or write any files, and respond with the final answer directly.

     [User]
     <userPrompt>
     ```
   - Always spawn in a **fresh empty temp directory** (`cwd: tmpDir`), pass `--disable-slash-commands`, and **never** pass `--dangerously-skip-permissions` (`permission_mode` stays `"request-review"`).
   - Expect ~8,300 input tokens baseline overhead per `agy` invocation (all 60 agent tools are declared in the session). Keep `maxConcurrency` capped at `1` (max `2`) in CLI mode.

---

### 1.4 Windows CLI Shim Discovery Failure Signatures (`claude` / `codex` in `D:\Program Files\nodejs\node_global\`)

Because M0 security guardrails strictly forbid `shell: true`, `exec`, and `execSync` in `packages/studyhub-desktop/**`, **every CLI discovery & runner call MUST use `spawn` / `spawnSync` with `shell: false`**.

Empirical probe on Node.js `v22.22.3` (Windows) against `D:\Program Files\nodejs\node_global\`:

| Invoked Target (`shell: false`) | Exit `status` | `error.code` | `error.message` / Stdout | Root Cause |
|---|---|---|---|---|
| `"claude"` (bare name) | `null` | `ENOENT` | `spawnSync claude ENOENT` | Win32 `CreateProcess` does not resolve `.cmd` shims on `PATH` when `shell: false`; extensionless `claude` is a POSIX `#!/bin/sh` script. |
| `"D:\Program Files\nodejs\node_global\claude"` | `null` | `ENOENT` | `spawnSync ...\claude ENOENT` | Extensionless npm shim is a POSIX shell script (`#!/bin/sh`). |
| `"D:\Program Files\nodejs\node_global\claude.cmd"` | `null` | **`EINVAL`** | `spawnSync ...\claude.cmd EINVAL` | **Node.js CVE-2024-27980 protection**: spawning `.cmd`/`.bat` with `shell: false` unconditionally throws `EINVAL`. |
| `"D:\Program Files\nodejs\node_global\node_modules\@anthropic-ai\claude-code\bin\claude.exe"` | `0` | `null` | `stdout: "2.1.327 (Claude Code)"` | Real Win32 PE executable works cleanly with `shell: false`. |
| `"codex"` (bare name) | `null` | `ENOENT` | `spawnSync codex ENOENT` | Same as `claude`. |
| `"D:\Program Files\nodejs\node_global\codex"` | `null` | `ENOENT` | `spawnSync ...\codex ENOENT` | Extensionless npm POSIX shim (`#!/bin/sh`). |
| `"D:\Program Files\nodejs\node_global\codex.cmd"` | `null` | **`EINVAL`** | `spawnSync ...\codex.cmd EINVAL` | Same Node.js `.cmd` + `shell: false` rejection (`EINVAL`). |
| `"D:\Program Files\nodejs\node_global\node_modules\@openai\codex\bin\codex.js"` (spawned directly) | `null` | **`EFTYPE`** | `spawnSync ...\codex.js EFTYPE` | `.js` file is not a Win32 executable; must be launched via Node. |
| `process.execPath` + `["...\@openai\codex\bin\codex.js", "--version"]` | `0` | `null` | `stdout: "codex-cli 0.170.0"` | Launching JS entry via `process.execPath` (`node.exe`) works cleanly with `shell: false`! |
| `"agy"` (bare name) | `null` | `ENOENT` | `spawnSync agy ENOENT` | Not on `PATH`. |
| `"%USERPROFILE%\.gemini\bin\agy.exe"` | `0` | `null` | `stdout: "1.5.5"` | Real Win32 PE executable works cleanly with `shell: false`. |

**Observed `.cmd` shim contents (for safe unwrapping without `shell: true`)**:
- `claude.cmd`: `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*` -> native `.exe` target.
- `codex.cmd`: `"%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*` -> Node JS entry target (`process.execPath` + script).

**Failure signatures to cover in discovery unit tests**:
1. `ENOENT`: missing executable, missing target behind a broken `.cmd` shim, or extensionless POSIX shim on Windows.
2. `EINVAL`: direct spawn of `.cmd`/`.bat` with `shell: false` (must unwrap `.cmd` to target `.exe` or `[node, script.js]`, never enable `shell: true`).
3. `EFTYPE` / `EACCES`: non-executable script invoked directly without interpreter.
4. Non-zero exit code (`status !== 0`) or empty/unparseable `--version` output (e.g., broken npm shim whose target package was uninstalled, or auth/runtime crash on startup).
5. Timeout (`signal: "SIGTERM"` / `ETIMEDOUT`): hanging CLI during version probe (keep discovery probe timeout <= 5,000 ms).

---

## Part 2: Full `chat: false` / Main-Session Degradation Audit (v4.14.0 `ui/`)

### 2.1 Executive Summary

When running StudyHub Desktop with:
```js
host.capabilities = { edition: 'desktop', chat: false, agentTasks: false, landing: false }
```
(and omitting DSH-only callbacks `askInChat`, `showChat`, `attachToChat`, `noteInChat`, `chatTakesPictures`, `openInSidebar`, `openAgent`, `openPluginManager`, `openWorkspaceNotebook`, while providing `pickDirectory` and optionally `openModelSettings` / `openExternal`):

1. **Capability flag adoption in v4.14.0 is minimal**:
   - `ui/App.jsx:132` computes `canChat = host.capabilities?.chat ?? !!host.askInChat`, **but `canChat` is ONLY consumed in ONE place**: `ui/Generate.jsx:171` (hiding the `在主会话里录题` tab).
   - **Zero** files in `ui/` currently read `host.capabilities?.edition`, `host.capabilities?.agentTasks`, or `host.capabilities?.landing`.
2. **Mechanical crash safety is high — UX & copy honesty is NOT**:
   - Every `<HandOff>`, `<HandOffButton>`, `<HandOffForm>`, and `useHandOff()` call routes through `ui/app/use-app-core.js:42` -> `deliverToChat()` (`ui/hand-off/use-hand-off.js:80`).
   - With `host.askInChat` absent, `deliverToChat` **does not crash**: it copies the formatted prompt to clipboard and displays the receipt (`已复制到剪贴板 · 没找到主会话，粘贴到任意对话` + `看看内容` -> `HandOffSheet`), or opens `HandOffSheet` immediately if clipboard access is denied.
   - **However**, every single one of the **27 registered hand-off IDs** across **40+ UI call sites** still renders labels like `发给主会话`, `请主会话起草`, `带着错题回主会话`, `在主会话里检查`, `交给主会话细化`, tooltips mentioning `主会话的输入框`, and receipts saying `没找到主会话`!
3. **Standalone bypass outside `deliverToChat`**:
   - `ui/guided-study/GuidedStudyWorkbench.jsx:185-230` (`handleAskTutor`) calls `applyAskTutorMessage()` (`ui/agent-prompts/guided-study.js:35`), which bypasses `deliverToChat` / `HandOffSheet` and hardcodes `'已复制请教内容到剪贴板，请在主会话中粘贴发送'`.
4. **DSH-specific host assumptions**:
   - 5 core extension points are already slated for PR #1 (`ui/host-parts.js`): `ui/ModelSetupGate.jsx`, `ui/settings/ModelPane.jsx`, `ui/app/WorkspaceBindingPanel.jsx`, `ui/app/AppTopbar.jsx`, `ui/UpdateCenter.jsx`.
   - Beyond those 5 files, DSH-specific wording still leaks in `settings-groups.js`, `settings/ModelStatus.jsx`, `settings/GuidancePane.jsx`, `settings/WebGeminiSection.jsx`, `ExtensionPanel.jsx`, `ExtensionNotStarted.jsx`, `ExtensionsSettings.jsx`, `AudioSettings.jsx`, `ArchifyCard.jsx`, `LargeDocumentCard.jsx`, `mastery-terms.js`, `tour/steps.js`, `finder/entries.js`, `diagnostics.js`, `transport.js`, `tasks/OutputPanel.jsx`, `tasks/output-wait.js`, `tasks/call-model.js`, `tasks/task-facts.js`, `generation-status.js`, and `token-usage.js`.

---

### 2.2 Complete Feature & Call-Site Classification Table

#### Category A — Already Degrades Cleanly (No Crash, Correct Functional Behavior)

| Feature / Call Site | File & Lines | Runtime Behavior when `chat: false` (Desktop Host) |
|---|---|---|
| **Generate: 「在主会话里录题」 tab** | `ui/App.jsx:132`, `ui/app/page-views.jsx:399-403`, `ui/Generate.jsx:67,171` | `canChat` is `false`; the `chat` (`在主会话里录题`) tab is cleanly omitted from `tabs` and falls back to `files`. |
| **Review: 「在右栏打开」 button** | `ui/Review.jsx:121,223-227` | Gated on `host.openInSidebar`; hidden cleanly when absent. |
| **Tasks / Sources / Audio / StudyMap: Open background agent link** | `ui/AgentLink.jsx:27`, `ui/tasks/OutputPanel.jsx:113`, `ui/StudyMap.jsx:162,172`, `ui/app/page-views.jsx:253,277`, `ui/app/modals/AddSourceDialog.jsx:44` | `AgentLink` returns `null` when `host.openAgent` is absent. |
| **HandOff Receipt: 「去主会话」 button** | `ui/hand-off/use-hand-off.js:93` | Gated on `typeof host?.showChat === 'function'`; omitted cleanly when absent. |
| **PageAsk: Chat image attachment probe** | `ui/document-preview/PageAsk.jsx:86-94,119-122` | Checks `typeof host?.chatTakesPictures === 'function'`; sets `picture = false` and skips image attachment cleanly. |
| **FocusIntakeDialog: Vision / image staging** | `ui/FocusIntakeDialog.jsx:355-365,466-486` | `takesPictures` resolves without crashing; still offers 「合成 PDF 用本机解析」 local path. (Copy in L358-361,445,471 still mentions `主会话` — see Category D.) |
| **DisabledPage / AddSourceDialog / UpdateCenter: 「打开插件管理」 buttons** | `ui/app/page-views.jsx:656-661`, `ui/app/modals/AddSourceDialog.jsx:14`, `ui/UpdateCenter.jsx:186,205` | Button itself is gated on `host?.openPluginManager` and hidden when absent. (Surrounding description still says `DSH 插件管理器` — see Category D.) |
| **Board / Notebooks: Cross-workspace open** | `ui/App.jsx:164`, `ui/app/use-notebooks.js:34` | Uses optional `host.openWorkspaceNotebook?.(...)`; no-op / hidden when absent. |
| **Settings: Model settings navigation** | `ui/app/use-settings-entry.js:15`, `ui/ModelErrorNote.jsx:13`, `ui/settings/ModelStatus.jsx:35`, `ui/app/modals/ReaderRun.jsx:68`, `ui/app/modals/source-reader.jsx:37` | When `host.openModelSettings` is absent, automatically navigates to internal `Settings › 学习库与模型` (`settings-model`) with label `前往设置` (and `ModelStatus` hides redundant button). |
| **Directory Picker (`pickDirectory`)** | `ui/app/WorkspaceBindingPanel.jsx:31-38`, `ui/install/LocationChooser.jsx:10-18`, `ui/LiveLocalCard.jsx:32-36`, `ui/LiveLoopbackCard.jsx:27-31`, `ui/MarkerInstall.jsx:99-101`, `ui/MineruInstallCard.jsx:48-52`, `ui/MineruSettings.jsx:8-12` | If Desktop provides `host.pickDirectory` (backed by Tauri `pick_directory`), native OS folder picker works everywhere; if absent or failing, cleanly falls back to inline text input. |
| **Ingest Banner (`录题中`)** | `ui/app/AppBanners.jsx:11-22` | Only renders when `data?.ingest` is active; never triggered in Desktop when `chat: false` (unless opening a shared library with an active DSH ingest session). |
| **HandOffSheet full-text fallback** | `ui/App.jsx:202`, `ui/hand-off/HandOffSheet.jsx:39-104` | Cleanly renders selectable prompt with `复制全文` / `再复制一次` / `全选` fallback whenever clipboard fails or `看看内容` is clicked. |

---

#### Category B — Needs Explicit Hide or Copy-Prompt Degradation in Desktop (`chat: false`)

These UI surfaces currently ALWAYS render `发给主会话` / `AI 带学` controls because they do not check `canChat` (`host.capabilities?.chat`). In Desktop edition (`chat: false`), they should either be **hidden** (for DSH-exclusive agent workflows) or **explicitly relabeled as "复制提示词"** (copy-prompt degradation via `use-hand-off.js` when `canChat === false`).

| Feature / Call Site | File & Lines | Hand-Off ID / Mechanism | Current Behavior (`chat: false`) | Recommended Desktop Action |
|---|---|---|---|---|
| **Global Hand-Off Engine (`useHandOff` / `HandOff` / `HandOffButton` / `HandOffForm`)** | `ui/hand-off/use-hand-off.js:14-31,44,80-111,122-146`, `ui/hand-off/HandOff.jsx:22-95` | All 27 registered IDs | Always shows `发给主会话` + `只填进主会话的输入框…`; clicking copies to clipboard with receipt `没找到主会话，粘贴到任意对话`. | **Copy-prompt degradation**: When `!canChat`, default label -> `复制提示词` (icon `copy` instead of `external`), tooltip -> `复制提示词到剪贴板，可粘贴到外部 AI 对话使用`, menu hint -> `复制提示词到剪贴板`, receipt `copied` line -> `已复制提示词，可粘贴到任意 AI 对话`. (Fixes 80% of all hand-off sites in one central place!) |
| **Settings › 引导 › 「AI 带学」 section** | `ui/settings/GuidancePane.jsx:96-99`, `ui/guided-study/GuidedStudyStart.jsx:9-25`, `ui/settings-groups.js:49` | `guided.start` | Shows full `AI 带学` section telling user "在主会话里说想学什么…" with 3 `发给主会话` buttons. | **Hide** `<SettingsSection data-guidance="guided-study">` when `!canChat` (AI 带学 requires a live multi-turn host agent calling `study.session.start` + sidebar panel bridge). |
| **Guided Study Workbench (`带学工作台`)** | `ui/guided-study/GuidedStudyWorkbench.jsx:185-230,393-420,430-433`, `ui/agent-prompts/guided-study.js:35-62`, `ui/app/page-views.jsx:549-630` | `applyAskTutorMessage` + `method.missed` + `GuidedStudyStart` | Empty state shows `GuidedStudyStart`; card shows `请教主会话` (bypasses `deliverToChat`!) and `带着错题回主会话`. | **Hide** `guided` discovery entries (`finder/entries.js:451`, `tour/steps.js:78-80`) when `!canChat`; if user opens an existing shared library with an active session, degrade `请教主会话` to `复制请教提示词` (via `deliverToChat` or neutral copy) and hide `GuidedStudyStart`. |
| **Course Method 「也可以 · AI 带学」 alternative** | `ui/method-alternatives.js:284-293` | `method.explain` (navigates to `guided` + sends hand-off) | Clicking `AI 带学` navigates to empty `guided` page and copies `method.explain` prompt. | **Hide or mark unavailable** (`explain` activity) when `!canChat` (or label as desktop-unavailable). |
| **Study Map: Empty-state & NextStep 「不知道从哪开始」 / 「用工作区里的文件出题」** | `ui/study-map/DeskIntro.jsx:82,85`, `ui/study-map/NextStepCard.jsx:33`, `ui/study-map/home-plan.js:108-109,172` | `guide.start`, `import.file` | Shows `发给主会话` links referencing DSH `@` file picker and chat guidance. | **Hide** `guide.start` & `import.file` hand-off links on Home when `!canChat` (Desktop already has native `添加资料` / `pickDirectory` + `ModelSetup`). |
| **Study Map: Deck menu `deck.ask` & Topic row icon `topic.explain`** | `ui/study-map/DeckRow.jsx:44,95-96` | `deck.ask`, `topic.explain` | Menu item says `发给主会话`; every topic row shows a chat icon button (`shape="icon"`). | Degrade via central `useHandOff` (`复制提问提示词` / copy icon) OR hide `topic.explain` icon when `!canChat`. |
| **Study Map & Skeleton: Topic grouping (`topics.group`)** | `ui/study-map/TopicGroupReminder.jsx:30`, `ui/Skeleton.jsx:286-292` | `topics.group` | Prompts user to send topics to main chat to group them (requires MCP tool writeback). | **Hide** `TopicGroupReminder` and `topics.group` hand-offs when `!canChat` (or copy-prompt with note that external AI cannot write back directly). |
| **Skeleton: Design / Archify / Extend** | `ui/Skeleton.jsx:381-388,435,462-464,489-490`, `ui/SkeletonCanvas.jsx:97-98`, `ui/ArchifyCard.jsx:36,41` | `skeleton.design`, `skeleton.archify`, `skeleton.extend` | Primary empty-state button says `在主会话里生成骨架`! `HandOffForm` says `告诉主会话怎么扩展`. `ArchifyCard` shows `安装到 DSH` CLI command. | **Copy-prompt degradation** (or hide `ArchifyCard` DSH install snippet when `edition === 'desktop'`); relabel `在主会话里生成骨架` -> `复制骨架生成提示词` (or note built-in generation). |
| **Review Book: Ask / SelectBar / More / PlanSection** | `ui/book/BookAsk.jsx:21,55`, `ui/book/BookSelectBar.jsx:77,81`, `ui/book/more-actions.js:47-48`, `ui/book/BookMore.jsx:10,42,44`, `ui/book/PlanSection.jsx:24-38,117` | `book.edit`, `custom.start`, `course.plan` | `BookAsk` has BOTH `写进这个知识点` (built-in AI!) AND `发给主会话`. `PlanSection` relies entirely on `course.plan` hand-off (`和主会话一起定`). `BookMore` has `发给主会话` and `深度定制`. | `BookAsk` & `BookSelectBar`: keep built-in `写进这个知识点` / `弄懂` primary; degrade `HandOffButton` to `复制提示词` (or hide when `!canChat`). `PlanSection` & `custom.start`: copy-prompt or hide DSH-only MCP writeback workflow. |
| **Reader: PageAsk & MindMapPanel** | `ui/document-preview/PageAsk.jsx:146-168`, `ui/document-preview/reader/MindMapPanel.jsx:39` | `reader.page`, `reader.map` | `PageAsk` already has built-in `依据这一页回答` (uses `complete`!) plus a secondary `发给主会话` for scanned pages/figures (`canHandOff = !!services && !!handOff`, does NOT check `canChat`!). `MindMapPanel` has `交给主会话细化`. | Check `canChat` in `PageAsk`: when `!canChat`, either use copy-prompt wording ("复制这一页提问内容，可附截图粘贴到外部 AI") or use the existing `!canHandOff` branch (L148: `换一页再问，或在「阅读」里点「看原页」看这一页的图`). Relabel `MindMapPanel` `交给主会话细化` -> `复制细化提示词` or hide. |
| **Companions: BuildDialog & Viewer** | `ui/companions/CompanionBuildDialog.jsx:351-366`, `ui/companions/CompanionViewer.jsx:47,855` | `companion.ask` | Both already have **built-in AI** (`开始生成 HTML 伴学课` and `当场讲透` via `complete`), plus secondary `想让主会话直接编排` / `发给主会话深挖`. | Built-in AI works directly in Desktop! Hide or relabel secondary `发给主会话深挖` -> `复制提问提示词` when `!canChat`. |
| **CourseMethodCard & CourseSettings** | `ui/CourseMethodCard.jsx:339-340,368-373,400-405,429-439`, `ui/CourseSettings.jsx:179-180` | `method.draftMaterial`, `method.missed`, `method.edit`, `self.start` | Renders `请主会话起草`, `带着错题回主会话`, `和主会话改学法`, `自学目标` hand-offs (all expect MCP tool writeback). Note: manual `改学法` (`MethodForm`) works locally! | Degrade to copy-prompt (with neutral labels) or hide `method.draftMaterial` / `method.edit` / `self.start` when `!canChat`, keeping manual `改学法` + `导入` prominent. |
| **Review Result & ChapterHint & WrongBook** | `ui/Review.jsx:364-368,393-395`, `ui/review/ChapterHint.jsx:61-62,79`, `ui/WrongBook.jsx:108` | `method.missed`, `review.weakTopics`, `question.basics`, `question.stubborn` | Renders `带着错题回主会话`, `讲解薄弱点`, `发给主会话讲`, and stubborn-question `发给主会话`. | Degrade via central `useHandOff` to `复制讲解提示词` (or hide when `!canChat`). |
| **Hands-on Task Card (`TaskCardRun`)** | `ui/TaskCardRun.jsx:255-287,368-407` | `task.check` | Primary button is `在主会话里检查` (expects host agent to read local files and call `card.grade`). Secondary actions (`看参考实现`, `写完了（自报）`) work locally! | When `!canChat`, demote/relabel `在主会话里检查` -> `复制检查提示词` (secondary) and promote `写完了（自报）` / `看参考实现`, updating hint copy so it does not claim `主会话只读你指定的文件`. |
| **Import / Ingest / Audio / JSON / PDF / LargeDoc / CustomPlan / CourseOutline / GenerationPath** | `ui/ImportHub.jsx:575,583`, `ui/Ingest.jsx:86,90`, `ui/AudioImport.jsx:272,305`, `ui/JsonImport.jsx:54,74,89`, `ui/LargeDocumentCard.jsx:90-91,109`, `ui/PdfConvertJob.jsx:142,339`, `ui/Sources.jsx:386`, `ui/CustomPlanCard.jsx:39`, `ui/outline/CourseOutline.jsx:214-215`, `ui/outline/CustomGate.jsx:60,67`, `ui/GenerationPath.jsx:68` | `import.file`, `job.failed`, `custom.start`, `path.brief` | All offer secondary `发给主会话` escape hatches mentioning `@` file picker or main-chat interview. | Degrade via central `useHandOff` to `复制提示词` (and hide `custom.start` / `CustomGate` main-chat interview option or relabel cleanly when `!canChat`). |
| **Setup / Install Failure Diagnostics** | `ui/install/DiagnosticActions.jsx:8-20`, `ui/install/install-diagnostics.js:76`, `ui/ExtensionNotStarted.jsx:57`, `ui/ExtensionPanel.jsx:21`, `ui/LiveLocalCard.jsx:169,188`, `ui/LiveLoopbackCard.jsx:139,156`, `ui/MarkerInstall.jsx:160`, `ui/MarkerSettings.jsx:61`, `ui/MineruInstallCard.jsx:309,376` | `setup.failed` | Shows `发给主会话` + `PERMISSION_HINT` ("发送前，把主会话权限（输入框左下角）换成「完全权限」")! | Hide `PERMISSION_HINT` when `!canChat`; degrade `setup.failed` to `复制诊断提示词` (user can paste into external AI or bug report). |
| **Failed Job Hand-Off** | `ui/tasks/CompactJobCard.jsx:147`, `ui/tasks/RunLine.jsx:30`, `ui/tasks/failed-hand-off.js:29` | `job.failed` | Shows `发给主会话` next to failed background job. | Degrade via central `useHandOff` to `复制排障提示词` (or hide when `!canChat`). |
| **Tour & Finder (Command Palette)** | `ui/tour/steps.js:42,78-80,103-104,111`, `ui/finder/entries.js:85,116,273-275,302,385,421-429,451-454,486-488,531,615,635-657` | Tour step `guided-study`, Finder entries `guided-study`, `hand-off`, `repair-local-tool` | Tour step 7 teaches `AI 带学` in `主会话`; step 9 says "密钥在 DSH 的设置 › 模型里填". Finder indexes `AI 带学`, `发给主会话`, `让主会话修复本地工具`. | Filter out `guided-study` tour step and finder entry when `!canChat`; adjust model-setup tour step text for Desktop. |

---

#### Category C — Needs Routing to `complete` or Desktop Native Action

| Feature / Call Site | File & Lines | Current Mechanism | Desktop Routing Required |
|---|---|---|---|
| **Model Configuration & Connection Gate** | `ui/ModelSetupGate.jsx:27-59,136-143,263-276`, `ui/settings/ModelPane.jsx:10-19`, `ui/app/WorkspaceBindingPanel.jsx:21-93`, `ui/first-run/FirstRunLine.jsx:131-163` | Assumes DSH holds API keys and model picker (`Settings › Models` in DSH + `跟随当前会话`). | **Route via PR #1 `hostPart` hooks** (`ModelSetup`, `ModelGateForm`, `modelSetupSteps`): render Desktop's own provider/API-key/CLI (`agy` / OpenAI-compatible presets) configuration UI directly inside `Settings › 学习库与模型` and `ModelSetupGate`, backed by `desktop.config.*` / `desktop.cli.*` IPC actions. Remove `跟随当前会话` option in Desktop binding panel. |
| **Library Folder Binding & Default Root** | `ui/app/WorkspaceBindingPanel.jsx:30-57`, `ui/app/AppTopbar.jsx:13-35` | Assumes DSH workspace root (`当前工作区`) and `host.pickDirectory`. | **Wire `host.pickDirectory`** to Tauri `pick_directory` command; handle `rootSource === 'default'` + `binding.defaultRoot` (`LibraryNotice` via PR #1 `hostPart`) with honest Desktop copy (`默认学习库目录`, `恢复默认目录`) and shared-library lock notice if co-used with DSH. |
| **Desktop Upgrade / Release Flow** | `ui/UpdateCenter.jsx:95-299,320-362` | Assumes DSH plugin manager one-click install (`update.install`) or 4-step DSH plugin uninstall/reinstall. | **Route via PR #1 `hostPart('UpgradeGuide')`**: show Desktop release download instructions (`.msi` / `.zip` on GitHub Releases via `open_external`) and disable DSH plugin-manager upgrade paths (`update.install.available: false`). |
| **External Links (`target="_blank"`)** | `ui/ModelSetupGate.jsx:42`, `ui/UpdateCenter.jsx:263,329`, `ui/components/SetupRequired.jsx` | Standard `<a href="https://..." target="_blank">` (inside Tauri WebView2, `target="_blank"` may open a raw WebView popup or be blocked unless intercepted). | Intercept external `http(s)://` link clicks in Desktop shell (`ui/desktop.jsx`) or provide `host.openExternal(url)` wired to Tauri's validated `open_external` command. |
| **In-App AI Features (Already Routed to `complete`!)** | `Generate.jsx`, `CaseCreate.jsx`, `Review.jsx` (grading/followup/explain), `BookAsk.jsx` (`写进这个知识点`), `PageAsk.jsx` (`依据这一页回答`), `CompanionBuildDialog.jsx` (`开始生成 HTML 伴学课`), `CompanionViewer.jsx` (`当场讲透`), `CourseOutline.jsx`, `ExamPrep`, `ExamCoach`, `BlogNotes.jsx` (`AI 起草解析`), `DailyPlan.jsx` | All call backend StudyHub actions which invoke `host.complete(...)` (direct model call!). | **Already routed to `complete`!** They work out-of-the-box in Desktop once `backend-desktop` implements `complete` (via OpenAI-compatible HTTP or `agy` CLI adapter) and sets `data.model = { ready: true, reason: 'ok', label }` + `data.modelReady = true`. |
| **Concurrency Cap for CLI Mode** | `ui/settings/GenerationPane.jsx`, `ui/GenerationSettings.jsx`, `lib/generation-settings.js` | Allows high batch concurrency suited for cloud APIs. | **PR #1 concurrency cap hook**: clamp concurrency to host's `maxConcurrency` (default `1`, max `2` when `agy` CLI backend is active) so local CLI processes don't stampede CPU/quota. |
| **Topbar Running Note** | `ui/app/AppTopbar.jsx:52-59` | Generic `有后台任务在进行`. | **PR #1 `hostPart('runningNote')`**: surface desktop-specific running note (e.g., sidecar/CLI concurrency status) without touching core topbar logic. |

---

#### Category D — Broken / Misleading Copy ("DSH" / "主会话" / "插件管理器" in Desktop Edition)

##### D.1 High-Visibility (Users hit these on first launch or everyday flows)
| File & Lines | Misleading Copy | Coverage / Fix Strategy |
|---|---|---|
| `ui/ModelSetupGate.jsx:28-31,51,54,58,139,164-173,204-207` | `"但 DSH 里还没有它的 API Key"`, `"在 DSH 打开「设置 › 模型」"`, `"用主会话输入框里的模型选择器"`, `"也可以请主会话..."` | **Covered by PR #1 `hostPart`** (`modelSetupSteps`, `ModelGateForm`) for setup steps; `modelFact` and feature `why/line/note` for `lesson`/`skeleton`/`bookAi` still mention DSH/主会话 if model is unconfigured. |
| `ui/app/WorkspaceBindingPanel.jsx:40-43,55,73` | `"与主会话输入框里选的模型一致"`, `"不改变主会话的模型"`, `"改回当前工作区"`, `"跟随当前会话"` | **Covered by PR #1 `hostPart`** (`ModelSetup`, `LibraryNotice`, `rootSource === 'default'`). |
| `ui/settings/ModelStatus.jsx:32` | `"这个 DSH 没有告诉 StudyHub 密钥是否已配置"` | Desktop backend should ALWAYS report explicit `reason: 'ok'` or `'no-credential'` (never `'unknown'`), so L32 is never reached. |
| `ui/settings-groups.js:37,49` | `"模型的密钥在 DSH 的「设置 › 模型」里填"`; `"以及 AI 带学的默认设置"` | Needs desktop-aware copy or neutral wording when `edition === 'desktop'` / `!canChat`. |
| `ui/UpdateCenter.jsx:98,111,138-139,146,149,178-184,201-202,275-289,321-322,345,359` | `"DSH 插件不会自动更新"`, `"打开 DSH 的「插件」管理"`, `"重启 DSH 完成升级"`, `"DSH 版本请自己补上"` | **Covered by PR #1 `hostPart('UpgradeGuide')`** for upgrade instructions; Desktop `update.check` must set `install: { available: false }` and never set `pendingRestart`/`restartFailed` so DSH restart strings stay dormant. |
| `ui/hand-off/use-hand-off.js:14,16,27-29,37,44` | `"发给主会话"`, `"只填进主会话的输入框..."`, `"没找到主会话，粘贴到任意对话"` | Central fix in `useHandOff()` / `deliverToChat()` reading `canChat` (`host.capabilities?.chat`). |
| `ui/first-run/recheck.js:14` | `"在 DSH 里配好后，再点一次「重新检查」"` | Shown if user clicks `重新检查` before configuring model in Desktop. |
| `ui/mastery-terms.js:31` | Glossary defines `主会话 — DSH 里和你对话的那个窗口` | Shown in Sidebar `帮助 › 名词解释`. Hide `mainChat` term when `!canChat`. |
| `ui/diagnostics.js:107` | `"DSH version: (fill in by hand)"` | Included in copied diagnostics text; should say `Host: desktop` when `edition === 'desktop'`. |

##### D.2 Secondary / Edge-Case Pages (Seen in Settings, Tasks, Errors, or Optional Modules)
| File & Lines | Misleading Copy | Notes |
|---|---|---|
| `ui/settings/WebGeminiSection.jsx:119,131,138,212` | `"在 DSH 配置并启用 ask-gemini-mcp"` | Desktop has no DSH MCP server; `WebGeminiSection` should be hidden or disabled cleanly when `edition === 'desktop'` (or gated via `ModelPane` / backend `webGemini.available === false`). |
| `ui/ExtensionPanel.jsx:45-46,74,103-136,221,264-288`, `ui/ExtensionNotStarted.jsx:33-63`, `ui/ExtensionsSettings.jsx:26-31,71,94-95`, `ui/LargeDocumentCard.jsx:30,128` | `"重启 DSH"`, `"由 DSH 自己安装并运行"`, `"加到 DSH 主目录的 cordis.patch.yml"` | Retrieval extension is a DSH plugin; Desktop backend should report `extension: { canInstall: false, installed: false }` or omit retrieval-extension install UI. |
| `ui/AudioSettings.jsx:28,179,196,208`, `ui/AudioDashboard.jsx:94` | `"校对和翻译仍由 DSH 的模型完成"`, `"~/.dsh/study/audio.json"`, `"默认跟随主会话"`, `"DSH Token 不计入"` | Visible in `Settings › 音频转写` and Audio Dashboard footer. |
| `ui/tasks/call-model.js:57`, `ui/GenerationTrace.jsx:75`, `ui/tasks/OutputPanel.jsx:79-81,113`, `ui/tasks/output-wait.js:22`, `ui/tasks/task-facts.js:290,302`, `ui/coverage/copy.js:92`, `ui/draft-shortfall.js:121`, `ui/generation-status.js:380-382` | `"DSH 子代理"`, `"完整回复读取自 DSH 会话"`, `"文字处理由 DSH 模型完成"`, `"DSH 没能启动出题用的子代理"` | Desktop always runs with `runtime: 'direct'` (never `'subagent'`), so subagent/session error strings are rarely triggered; `task-facts.js:290,302` (`由 DSH 模型完成`) IS visible on audio/text jobs. |
| `ui/token-usage.js:175` | `"下限按 DSH 的固定估算"` | Visible in token-estimate tooltip. |
| `ui/app/page-views.jsx:659`, `ui/app/modals/AddSourceDialog.jsx:15`, `ui/ImportHub.jsx:602`, `ui/PdfConversion.jsx:132`, `ui/finder/availability.js:15,17`, `ui/finder/entries.js:721`, `ui/settings/ExamPrepPane.jsx:19` | `"在 DSH 插件管理器里启用..."`, `"这个 DSH 里没有开启..."` | Only reached if a backend context/feature flag is disabled; Desktop should publish all supported contexts (`bank`, `study`, `materials`, `authoring`, `generation`, `notes`, `skeleton`, `audio`, `system`, `workflows`) so `DisabledPage` is never hit for standard pages. |
| `ui/transport.js:10,47` | `"StudyHub 只对这台电脑上的 DSH 主人开放"`, `"DSH 可能刚重启"` | Only used by `createStudyCall` (DSH Fetch RPC); Desktop uses its own HTTP + `X-Study-Token` transport (`ui/desktop/ipc.js`, mounted by `ui/desktop.jsx`), so these strings are **NOT executed** in Desktop! |
| `ui/GenerationSettings.jsx:13,132`, `ui/settings/CoachSection.jsx:67,73`, `ui/settings/PracticePane.jsx:172`, `ui/review/QuestionRun.jsx:633`, `ui/Workflows.jsx:68`, `ui/WorkflowPortal.jsx:34,186,212`, `ui/WorkflowScope.jsx:89,91`, `ui/Dashboard.jsx:274`, `ui/study-map/BookBackupHint.jsx:25`, `ui/JevSettings.jsx:184`, `ui/jev-flow.js:95` | Minor mentions of `主会话` / `DSH` in hints, legacy workflow retirement notes, backup tooltip, and experimental JEV settings | Non-blocking; safe to clean up opportunistically or leave for post-v1 copy polish. |

---

## Part 3: Actionable Recommendations for Wave 2 (`backend-desktop` & `ui-desktop`)

### For `backend-desktop`
1. **`agy` Adapter (`adapters/cli/agy-adapter.mjs` + `process-runner.mjs`)**:
   - Discover `agy.exe` explicitly at `%USERPROFILE%\.gemini\bin\agy.exe` (and `~/.gemini/bin/agy`) in addition to `PATH`.
   - **Use `stream-json` stdin as the primary unified transport** (eliminates the Windows 32 KB `CreateProcess` argv limit; verified up to 2 MB single-line NDJSON):
     - Spawn with `shell: false`, `windowsHide: true`, fresh empty temp `cwd`, and args:
       `['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--print-timeout', '<sec>s', ...modelArgs]`
     - Write `JSON.stringify({ event: 'user', message: { content: wrappedPrompt } }) + '\n'` to child `stdin`, then call `stdin.end()`.
     - Parse NDJSON lines from `stdout`, find the terminal `event === 'result'` line, and read `.result` using the shared JSON result parser (`fixtures/agy-stream-output.jsonl` & `fixtures/agy-real-output.json`: `status === 'SUCCESS'`, `response`, `usage.{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`). Do NOT double-count `thinking_tokens` into `total_tokens`.
   - For `claude` / `codex` discovery on Windows: NEVER spawn `.cmd` with `shell: false` (throws `EINVAL`) and NEVER spawn `.js` directly (throws `EFTYPE`). Unwrap `.cmd` targets to `.exe` or `[process.execPath, scriptPath]`.
2. **Snapshot / Model Status**:
   - Always emit explicit `data.model = { ready: true, reason: 'ok', label }` or `{ ready: false, reason: 'no-credential', label }` (never `'unknown'`) so `ModelStatus.jsx:32` ("这个 DSH 没有告诉 StudyHub…") never appears.
   - Always report `update.install = { available: false }` and never set `pendingRestart`/`restartFailed`.
   - Publish full desktop contexts list so `DisabledPage` ("在 DSH 插件管理器里启用") is never reached.
   - Set `maxConcurrency` cap to `1` (max `2`) when active backend is CLI (`agy`).

### For `ui-desktop`
1. **Desktop Host Contract (`ui/desktop.jsx`)**:
   - Provide `host.capabilities = { edition: 'desktop', chat: false, agentTasks: false, landing: false }`.
   - Wire `host.pickDirectory` -> Tauri `pick_directory`.
   - Omit `askInChat`, `showChat`, `attachToChat`, `noteInChat`, `chatTakesPictures`, `openInSidebar`, `openAgent`, `openPluginManager`, `openWorkspaceNotebook`, `openModelSettings` (so `openModelSettings` cleanly routes to `Settings › 学习库与模型`).
   - Intercept external `<a target="_blank" href="https://...">` clicks in WebView2 and forward to Tauri `open_external`.
2. **PR #1 `hostPart` Registrations (`ui/desktop/`)**:
   - Register desktop parts for `ModelSetup`, `ModelGateForm`, `modelSetupSteps`, `LibraryNotice`, `runningNote`, and `UpgradeGuide` to replace all high-visibility DSH setup/upgrade/binding copy cleanly.
3. **High-Leverage `chat: false` Cleanups**:
   - Central copy-prompt degradation in `ui/hand-off/use-hand-off.js` (checking `host.capabilities?.chat`) immediately fixes button labels, tooltips, and receipts across all 27 hand-off IDs / 40+ call sites without touching individual pages.
   - Hide `AI 带学` section in `GuidancePane.jsx` and `guided-study` tour/finder entries when `!canChat`.
   - Hide `WebGeminiSection` when Desktop has no DSH MCP server (or when `edition === 'desktop'`).
