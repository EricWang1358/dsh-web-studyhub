# StudyHub Desktop

English · [简体中文](desktop.zh-CN.md)

**StudyHub Desktop** is the standalone Windows desktop edition of StudyHub. It ships with its own portable Node.js runtime and local backend, so you do **not** need DeepSeek Harness (DSH) and do **not** need to install Node.js separately. Your slides, decks, review books, Interactive Companions, and FSRS-6 review history stay in a local folder on your computer in the exact same format as the DSH plugin.

## Choose a package

Each release on the [GitHub release page](https://github.com/EricWang1358/dsh-web-studyhub/releases/latest) provides two Windows x64 packages plus `SHA256SUMS-Desktop-<version>.txt`:

| Package | Best for | Notes |
| --- | --- | --- |
| `StudyHub-Desktop-<version>-win-x64.msi` | Most Windows 10 / 11 users | Standard installer with Start Menu shortcut, clean uninstall, and a WebView2 bootstrapper for Windows 10. |
| `StudyHub-Desktop-<version>-win-x64.zip` | Portable / no-installer use | Extract to any writable folder and run `StudyHub.exe`. Does **not** install WebView2 automatically. |

### Option 1: Install with `.msi` (recommended)

1. Download `StudyHub-Desktop-<version>-win-x64.msi` and `SHA256SUMS-Desktop-<version>.txt` from the release page.
2. Verify the SHA-256 checksum (see [SmartScreen and checksum verification](#windows-smartscreen-unsigned-executable-warning) below).
3. Double-click the `.msi` file and follow the wizard.
4. Launch **StudyHub** from the Start Menu.

### Option 2: Run the portable `.zip`

1. Download `StudyHub-Desktop-<version>-win-x64.zip` and `SHA256SUMS-Desktop-<version>.txt` from the release page.
2. Verify the SHA-256 checksum, then extract the archive to a permanent writable folder (for example `D:\Apps\StudyHub-Desktop`). Do not extract it under `C:\Program Files`.
3. Keep `StudyHub.exe` and the `resources\runtime\` folder together in the same extracted directory.
4. Double-click `StudyHub.exe`.

## Windows 10 WebView2 requirement

StudyHub Desktop uses the system **Microsoft Edge WebView2 Runtime** to render its interface:

- **Windows 11**: WebView2 is pre-installed. Both `.msi` and `.zip` work out of the box.
- **Windows 10 with `.msi`**: The `.msi` installer bundles the official Microsoft WebView2 bootstrapper (`downloadBootstrapper`). If WebView2 is missing on your PC, the installer downloads and installs it during setup (internet access required once).
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
2. Pick a built-in provider preset — **DeepSeek**, **Zhipu GLM**, **SiliconFlow**, or **OpenAI** — or choose **Custom** to enter any OpenAI-compatible base URL and model ID.
3. Paste your API key and click **Save and test**.

Your API key is stored locally in your StudyHub Desktop configuration directory and is never written into your study library, backups, or exports.

### 2. Automatic local CLI detection (`agy` & `codex`)

If you already have **Google Antigravity CLI (`agy`)** or **OpenAI Codex CLI (`codex`)** installed and signed in on your computer, StudyHub Desktop automatically probes and detects them at startup. In **Settings › Library & model**, you can switch between ready local CLIs, optionally configure a model and reasoning effort (`low` / `medium` / `high`), and enable or test them without pasting an API key.

Good to know about CLI backends:
- Because each request runs an isolated CLI process, both `agy` and `codex` use a lower concurrency cap (default `1`, maximum `2`) than direct HTTP API keys.
- If a CLI is not installed or signed out, StudyHub Desktop reports the status honestly and lets you switch to another ready CLI or an API key at any time.
- **Note on Claude Code CLI (`claude`)**: Anthropic's consumer Terms of Service forbid third-party desktop apps from wrapping consumer subscription OAuth logins, so StudyHub Desktop does not wrap consumer `claude` OAuth.

### Open a local CLI in the library to chat while you study

StudyHub Desktop has no DSH main chat. To talk to an AI, select **Open agy in the library** (or codex) on the local CLI card in **Settings › Library & model**: StudyHub opens a command-line window of its own with the library folder you picked as the current folder and the CLI ready to chat. Snap it beside StudyHub with `Win + ←` / `Win + →`; what **Copy prompt** puts on the clipboard can be pasted straight into it.

- Only a CLI detected as ready has this button; the program opened is the detected one, and the folder is always the current library.
- The CLI can read and change the files in your library directly, and StudyHub does not check those changes. Back up the library before you let it edit decks or materials.
- When the library is on a network drive, or a path contains any of `" % ^ ! & | < >`, the window is not opened; the interface tells you to open a command line yourself, go to the library folder and run the CLI there.

## Library folder and sharing with DSH

- **Default location**: `Documents\StudyHub` (created automatically on first launch).
- **Choosing another folder**: Open **Settings › Library & model → Library** and click **Change folder…** to use the native Windows folder picker.
- **Sharing one library with DSH (or ZCode)**: You can point StudyHub Desktop and DSH at the exact same library folder. The DSH plugin keeps a workspace's library in the `.dsh-study` folder inside it; pick that **workspace folder** in StudyHub Desktop and it uses the `.dsh-study` inside, with your decks and records as they were. Every write takes an OS-level file lock (`proper-lockfile`), so changes written by one app are visible to the other without corrupting files.
- **Background tasks caveat**: A running background job (question generation, review-book build, audio transcription) runs inside the app that started it. The other app can see the recorded job status, but cannot pause or cancel it. Closing StudyHub Desktop stops its active background tasks; completed items are preserved so you can resume later.

## Differences from the DSH plugin

| Feature | DSH plugin | StudyHub Desktop |
| --- | --- | --- |
| Runtime prerequisites | Requires DSH desktop or web | Standalone `.msi` or `.zip` (bundles Node.js 22) |
| Model configuration | Uses DSH's configured models | Built-in API key presets + automatic `agy` & `codex` CLI detection |
| Folder selection | DSH workspace / picker | Native Windows folder picker |
| "Send to main chat" / AI chat hand-off | Sends directly into DSH's chat input | Copies the structured prompt to your clipboard so you can paste it into any chat tool |
| Updates | DSH plugin manager | Download the new `.msi` or `.zip` from GitHub Releases |

## Security and privacy

- **Local-first storage**: All documents, decks, notes, and review history stay on your computer. Only the text sent for AI generation, explanation, or audio transcription leaves your machine to the provider you configured.
- **Strict loopback isolation**: The desktop UI loads from static bundled assets (`tauri://localhost`), never from `127.0.0.1` HTML. On every launch, the Rust shell generates a fresh 256-bit random token and sends it to the local Node.js sidecar over `stdin` (never in command-line arguments, URLs, or HTML). The sidecar listens only on `127.0.0.1` and rejects requests without that token.
- **Minimal desktop permissions**: The Tauri shell exposes only three commands to the main window (`get_bootstrap_info`, `pick_directory`, and `open_external`). External links are strictly validated to `http://` or `https://` before opening in your default browser.
- **One program the app starts for you to see**: "Open agy / codex in the library" starts only the local CLI that detection found ready, only in the current library folder. The page sends the CLI's name and nothing else; paths with characters the Windows command line could read as syntax are refused, not escaped.
