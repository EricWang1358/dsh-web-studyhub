# StudyHub Desktop

English · [简体中文](desktop.zh-CN.md)

**StudyHub Desktop** is the standalone Windows desktop edition of StudyHub. It ships with its own portable Node.js runtime and local backend, so you do **not** need DeepSeek Harness (DSH) and do **not** need to install Node.js separately. Your slides, decks, review books, Interactive Companions, and FSRS-6 review history stay in a local folder on your computer in the exact same format as the DSH plugin.

## Choose a package

Each release on the [GitHub release page](https://github.com/EricWang1358/dsh-web-studyhub/releases/latest) provides three Windows x64 packages plus `SHA256SUMS-Desktop-<version>.txt` and the signed updater manifest `latest.json`:

| Package | Best for | Notes |
| --- | --- | --- |
| `StudyHub-Desktop-<version>-win-x64-setup.exe` | **Recommended** (most Windows 10 / 11 users) | Per-user (`currentUser`) NSIS installer with **zero UAC prompts**, **one-click in-app auto-update** (Ed25519 signature verification + automatic restart), and a WebView2 bootstrapper for Windows 10. |
| `StudyHub-Desktop-<version>-win-x64.msi` | Traditional MSI deployments | Standard Windows Installer (`.msi`) with Start Menu shortcut, clean uninstall, and a WebView2 bootstrapper for Windows 10. |
| `StudyHub-Desktop-<version>-win-x64.zip` | Portable / no-installer use | Extract to any writable folder and run `StudyHub.exe`. Does **not** install WebView2 automatically. |
| `StudyHub-Desktop-Retrieval-<version>-win-x64.zip` | Optional large-document search extension | Prebuilt Windows x64 search server bundle (with `SHA256SUMS-Desktop-Retrieval-<version>.txt`). Installed automatically in-app from **Settings › Search extension**; you do not need to extract it by hand. |

### Option 1: Install with `Setup.exe` (recommended, one-click auto-update)

1. Download `StudyHub-Desktop-<version>-win-x64-setup.exe` and `SHA256SUMS-Desktop-<version>.txt` from the release page.
2. Verify the SHA-256 checksum (see [SmartScreen and checksum verification](#windows-smartscreen-unsigned-executable-warning) below).
3. Double-click `Setup.exe` and follow the wizard (installs per-user with no UAC prompt).
4. Launch **StudyHub** from the Start Menu. Future releases can be installed in one click directly from the in-app update dialog (verifies the Ed25519 signature, updates passively, and restarts automatically).

> If you previously installed an older per-machine `.msi`, uninstall the old `.msi` once before installing `Setup.exe`. Your library folder, model configuration, and settings are stored separately and remain untouched. If the installer reports a file-write or permission error (for example on a custom drive or under security software), right-click `Setup.exe` and choose **Run as administrator** to retry.

### Option 2: Install with `.msi`

1. Download `StudyHub-Desktop-<version>-win-x64.msi` and `SHA256SUMS-Desktop-<version>.txt` from the release page.
2. Verify the SHA-256 checksum.
3. Double-click the `.msi` file and follow the wizard.
4. Launch **StudyHub** from the Start Menu.

### Option 3: Run the portable `.zip`

1. Download `StudyHub-Desktop-<version>-win-x64.zip` and `SHA256SUMS-Desktop-<version>.txt` from the release page.
2. Verify the SHA-256 checksum, then extract the archive to a permanent writable folder (for example `D:\Apps\StudyHub-Desktop`). Do not extract it under `C:\Program Files`.
3. Keep `StudyHub.exe` and the `resources\runtime\` folder together in the same extracted directory.
4. Double-click `StudyHub.exe`.

## Windows 10 WebView2 requirement

StudyHub Desktop uses the system **Microsoft Edge WebView2 Runtime** to render its interface:

- **Windows 11**: WebView2 is pre-installed. `Setup.exe`, `.msi`, and `.zip` all work out of the box.
- **Windows 10 with `Setup.exe` or `.msi`**: Both installers bundle the official Microsoft WebView2 bootstrapper (`downloadBootstrapper`). If WebView2 is missing on your PC, the installer downloads and installs it during setup (internet access required once).
- **Windows 10 with portable `.zip`**: The portable archive does **not** install WebView2. If StudyHub fails to open with a WebView2 error, install the [Microsoft Edge WebView2 Evergreen Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) first, then launch `StudyHub.exe` again.

## Windows SmartScreen unsigned executable warning

Current StudyHub Desktop builds are **not signed with a paid Windows Authenticode code-signing certificate**. Because of this, Windows Defender SmartScreen will usually show a blue **"Windows protected your PC"** prompt the first time you run the `.msi` installer or `StudyHub.exe`.

Do **not** click through a warning blindly. Verify that your download matches the official release first:

1. Open PowerShell in your Downloads folder and compute the SHA-256 hash:

   ```powershell
   Get-FileHash .\StudyHub-Desktop-<version>-win-x64.msi -Algorithm SHA256
   ```

2. Compare the printed hash against the matching line in `SHA256SUMS-Desktop-<version>.txt` from the GitHub release page.
3. Only after the hashes match, click **More info** in the SmartScreen dialog, then click **Run anyway**.

If you prefer not to run unsigned desktop binaries, you can build StudyHub Desktop from source in this repository or use the StudyHub DSH plugin.

## Configure a model

Browsing sources, loading the sample tour, and reviewing existing flashcards work completely offline without any AI model. Question generation, explanations, review books, proofreading, and translation require a model.

StudyHub Desktop supports two ways to connect a model in **Settings › Library & model**:

### 1. OpenAI-compatible API Key (recommended for batch generation)

1. Open **Settings › Library & model** (or use the setup form shown whenever a feature needs a model).
2. Pick a built-in provider preset — **DeepSeek**, **Zhipu GLM**, or **SiliconFlow** — or choose **Custom** to enter OpenAI or any other OpenAI-compatible base URL and model ID.
3. Paste your API key and click **Save and test**.

Your API key is stored locally in your StudyHub Desktop configuration directory and is never written into your study library, backups, or exports.

### 2. Automatic local CLI detection (`agy` & `codex`)

If you already have **Google Antigravity CLI (`agy`)** or **OpenAI Codex CLI (`codex`)** installed and signed in on your computer, StudyHub Desktop automatically probes and detects them at startup. In **Settings › Library & model**, you can switch between ready local CLIs, optionally configure a model and reasoning effort (`low` / `medium` / `high` in the UI; the config file also accepts `xhigh` for `codex` and `xhigh` / `max` for `agy`), and enable or test them without pasting an API key.

Good to know about CLI backends:
- Because each request runs an isolated CLI process, both `agy` and `codex` use a lower concurrency cap (default `1`, maximum `2`) than direct HTTP API keys.
- If a CLI is not installed or signed out, StudyHub Desktop reports the status honestly and lets you switch to another ready CLI or an API key at any time.
- **Note on Claude Code CLI (`claude`)**: Anthropic's consumer Terms of Service forbid third-party desktop apps from wrapping consumer subscription OAuth logins, so StudyHub Desktop does not wrap consumer `claude` OAuth.

#### Start agy ahead of time (pre-warm): how to choose

`agy` takes a few seconds to start every time. StudyHub Desktop can start the **next** `agy` ahead of time and use it for your next request. The setting is on the local CLI card in **Settings › Library & model** (shown when `agy` is selected); select **Save agy settings** after changing it.

| Choice | Time saved | Memory | Suits |
| --- | --- | --- | --- |
| Off | None: every call starts agy | Nothing extra | Little free memory, many programs open, or you rarely use the AI features |
| After use (default) | The first call waits as usual; the next one within 10 minutes waits a few seconds less | About 200 MB while one waits; it exits after 10 idle minutes | Choose it when unsure: follow-ups, tutoring and question generation get faster |
| Always | The first call waits less too | About 200 MB for as long as the app is open (an idle one is replaced after about 30 minutes) | You often ask a question or two with long gaps between, and have memory to spare |

- What is saved is start-up time; the model still takes as long to think and write. Measured a few times on one computer with a one-word reply (`agy` 1.5.18): about 11 to 20 seconds when started on demand, about 5 to 10 with one already waiting. The longer the answer, the smaller the share saved; how much you gain depends on your computer and the plugins `agy` has.
- Pre-warming only starts the program; StudyHub sends it nothing before you ask. Each waiting process answers once and is replaced: a second question to the same process would continue the first conversation, so it is never reused.
- While an answer is being written, one `agy` is answering and one is waiting, so count the memory twice.
- The first call after you change the model or reasoning effort starts on demand. **Test connection** always starts on demand. If the waiting process had already exited, the call starts a new one instead; a call is never sent again once the model has started answering, or after you cancel it or it times out. After a failed call, the next one starts on demand.
- If one call takes more than half a minute, pre-warming cannot help the first one: a plugin with an MCP server inside `agy` is usually slow to connect. Run `agy plugin list` in a terminal and disable the ones you do not use.
- This applies to `agy` only; `codex` and API-key mode are unchanged.

### Open a local CLI in the library to chat while you study

StudyHub Desktop has no DSH main chat. To talk to an AI, select **Open agy in the library** (or codex) on the local CLI card in **Settings › Library & model**: StudyHub first copies an opening note to the clipboard, then opens a command-line window of its own with the library folder you picked as the current folder and the CLI ready to chat. Paste the note into the new window and press Enter: the CLI then knows the library's path and reads and writes it only through the bundled `study-cli.mjs`, run with the bundled node; if the clipboard refuses, the card shows the note for you to copy. Snap it beside StudyHub with `Win + ←` / `Win + →`; what **Copy prompt** puts on the clipboard automatically appends the current library path and a command that runs StudyHub Desktop's bundled `study-cli.mjs` with the app's own portable node, no Node.js install needed (`resources\runtime\scripts\study-cli.mjs`), so you can paste it straight in and let the external CLI read and update the library through StudyHub's file locks without hand-editing `.dsh-study/`.

- Only a CLI detected as ready has this button; the program opened is the detected one, and the folder is always the current library.
- The CLI can read and change the files in your library directly, and StudyHub does not check those changes. Back up the library before you let it edit decks or materials.
- When the library is on a network drive, or a path contains any of `" % ^ ! & | < >`, the window is not opened; the interface tells you to open a command line yourself, go to the library folder and run the CLI there.

## Library folder and sharing with DSH

- **Default location**: `Documents\StudyHub` (created automatically on first launch).
- **Choosing another folder**: Open **Settings › Library & model → Library** and click **Change folder…** to use the native Windows folder picker.
- **Confirming where the library lives (first use)**: The first time you open StudyHub Desktop after this feature arrived (also after an update), the top of the home shows **Confirm where your library lives**. If you used StudyHub in DSH, pick that workspace folder and your decks and records appear. If the library is on the system drive (usually `C:`), the card says so and suggests another drive, because a library keeps growing. **Change folder…** is the same folder picker as in Settings; **Use this folder** accepts the place as it is. While the saved folder cannot be opened and StudyHub is using a fallback folder, the card stays hidden until the problem is gone. Choosing another folder does not move what is already in the library: to move it, quit StudyHub, move the whole folder to its new place, then pick it. The card goes away once you choose either, and stays away. When the variable `STUDYHUB_LIBRARY` decides the folder, there is nothing to choose and the card does not show.
- **Which model is in use**: The top bar of every page shows **Model: …** beside the library folder once a model is ready. Hover or focus it to see that questions, explanations and grading all call this model, and how it is billed: by usage to your API key, or against the quota of the account your local CLI is signed in to (by usage when that CLI is signed in with an API key); click it to open **Settings › Library & model**. In a narrow window it shrinks to an icon and in a narrower one it is hidden.
- **Sharing one library with DSH (or ZCode)**: You can point StudyHub Desktop and DSH at the exact same library folder. The DSH plugin keeps a workspace's library in the `.dsh-study` folder inside it; pick that **workspace folder** in StudyHub Desktop and it uses the `.dsh-study` inside, with your decks and records as they were. Every write takes an OS-level file lock (`proper-lockfile`), and StudyHub watches `.dsh-study` manifest revisions to push live UI refreshes automatically whenever DSH, another window, or an external CLI (`scripts/study-cli.mjs`) commits changes.
- **Background tasks caveat**: A running background job (question generation, review-book build, audio transcription) runs inside the app that started it. The other app can see the recorded job status, but cannot pause or cancel it. Closing StudyHub Desktop stops its active background tasks; completed items are preserved so you can resume later.

## Large-document search extension (Desktop Retrieval)

Large textbooks and course packets can be indexed locally for full-text and semantic retrieval in StudyHub Desktop — without installing DSH, Node.js, or `npm`.

StudyHub Desktop uses a hybrid setup that works smoothly both standalone and alongside DSH:

- **Automatic reuse of DSH's extension**: If you already installed the StudyHub search extension inside DSH on the same computer, StudyHub Desktop automatically detects and reuses it (read-only — StudyHub Desktop never modifies or deletes files inside DSH's profile directory). You can still click **Install standalone copy in Desktop** in **Settings › Search extension** if you want Desktop to run its own copy independently.
- **One-click standalone install**: Open **Settings › Search extension** and click **Install search extension**. StudyHub Desktop downloads the prebuilt `StudyHub-Desktop-Retrieval-<version>-win-x64.zip` asset from the matching GitHub release, verifies its SHA-256 digest against `SHA256SUMS-Desktop-Retrieval-<version>.txt`, extracts it into `%LOCALAPPDATA%\StudyHub\tools\retrieval`, and starts the local search service automatically.
- **Shared index and embedding model with DSH**: Both StudyHub Desktop and the DSH plugin store the LanceDB index and downloaded embedding model under `<DSH home>\study\retrieval` (default `%USERPROFILE%\.dsh\study\retrieval`). Indexes built in one app are immediately usable in the other, and cross-process file locking coordinates writes so concurrent indexing does not corrupt the index.
- **Hot-restart without restarting the app**: Installing, updating, uninstalling, changing the model download endpoint (`HF_ENDPOINT`), or running **Repair index** restarts only the background search subprocess — you never need to restart StudyHub Desktop.

## Differences from the DSH plugin

| Feature | DSH plugin | StudyHub Desktop |
| --- | --- | --- |
| Runtime prerequisites | Requires DSH desktop or web | Standalone `.msi` or `.zip` (bundles Node.js 22) |
| Model configuration | Uses DSH's configured models | Built-in API key presets + automatic `agy` & `codex` CLI detection |
| Large-document search extension | Installed via DSH plugin manager (requires restart) | Auto-reuses DSH extension or one-click standalone install in Settings (hot-restarts with no app restart) |
| Folder selection | DSH workspace / picker | Native Windows folder picker |
| "Send to main chat" / AI chat hand-off | Sends directly into DSH's chat input | Copies the structured prompt to your clipboard so you can paste it into any chat tool |
| Updates | DSH plugin manager | One-click in-app auto-update (Ed25519 signature verified, zero-UAC passive install & restart), plus manual downloads |

## Security and privacy

- **Local-first storage**: All documents, decks, notes, and review history stay on your computer. Only the text sent for AI generation, explanation, or audio transcription leaves your machine to the provider you configured.
- **Strict loopback isolation**: The desktop UI loads from static bundled assets (`tauri://localhost`), never from `127.0.0.1` HTML. On every launch, the Rust shell generates a fresh 256-bit random token and sends it to the local Node.js sidecar over `stdin` (never in command-line arguments, URLs, or HTML). The sidecar listens only on `127.0.0.1` and rejects requests without that token.
- **Minimal desktop permissions**: The Tauri shell exposes only seven commands to the main window (`get_bootstrap_info`, `get_sidecar_health`, `pick_directory`, `pick_file`, `open_external`, `desktop_check_update`, and `desktop_install_update`). External links are strictly validated to `http://` or `https://` before opening in your default browser, and in-app updates require a valid Ed25519 signature checked against the embedded public key before installation.
- **One program the app starts for you to see**: "Open agy / codex in the library" starts only the local CLI that detection found ready, only in the current library folder. The page sends the CLI's name and nothing else; paths with characters the Windows command line could read as syntax are refused, not escaped.
