# StudyHub for ZCode

[简体中文](zcode.zh-CN.md)

StudyHub also runs inside [ZCode](https://zcode.z.ai), the Windows desktop AI assistant: the full StudyHub panel sits in the right side pane, and the AI in your chats can use StudyHub's tools to import material, make questions and edit the review book. It is built from the same StudyHub code as the DSH plugin, and every release comes with a ZCode package.

The idea and the first port come from community member BAXUIE's StudyHub for ZCode. Thank you!

## What you need

| Need | Notes |
|---|---|
| Windows 10 / 11 | The installer is a Windows `install.bat` |
| ZCode desktop | Installed on any drive (for example `E:\Program Files\ZCode`) |
| Node.js 22 or newer | Get the LTS from [nodejs.org](https://nodejs.org) if you have none |
| An API key for a model | Zhipu, SiliconFlow and DeepSeek are reachable from mainland China; any OpenAI-compatible endpoint works |

The package carries all its dependencies and the built panel: your computer needs **no npm and no network to fetch dependencies**.

## Install

1. Download `StudyHub-ZCode-<version>.zip` from the [GitHub release page](https://github.com/EricWang1358/dsh-web-studyhub/releases/latest).
2. Right-click the zip → Properties → tick Unblock → OK. Without this, Windows may stop `install.bat`.
3. Extract it to a folder that stays put, for example `D:\Apps\StudyHub-ZCode`. Not under Program Files; do not move it afterwards, ZCode remembers this location.
4. Double-click `install.bat` in that folder. It finds ZCode by itself (in order: the running ZCode, the install location in the registry, the usual install folders on every drive), checks Node, registers the folder as a local ZCode plugin marketplace and installs StudyHub.
   If it cannot find ZCode, tell it ZCode's install folder: open a command prompt in this folder and run
   ```
   install.bat "E:\Program Files\ZCode"
   ```
5. Quit ZCode completely (including the tray icon) and open it again. Start a new chat and type `/studyhub`: the panel opens in the right side pane. It is also in the side pane's add-tab menu as StudyHub; `Ctrl+Shift+F` shows the side pane in the main area.

Each new chat starts with StudyHub telling the AI how many cards are due for review today (the same number as Due for review on the panel's Stats page).

## Connect a model

ZCode lends a plugin no model, so StudyHub's background work (questions, explanations, grading, the review book) uses one OpenAI-compatible endpoint you fill in. No files to edit:

1. In the panel open Settings › Library & model (the same form also appears next to any button that needs a model).
2. Under Provider choose Zhipu GLM, SiliconFlow or DeepSeek (all reachable from mainland China), or Other to enter an address yourself.
3. Follow the two steps on the card to sign up and copy an API key, paste it and select Save and test. "Works: the address, the model and the key all answered" means you are done.

You can change the model name to the one you want; the provider's page is the authority. A saved key only ever shows its last four characters. When the environment variable `STUDYHUB_API_KEY` is set, it wins over the key saved here.

## Where the library is

- By default, `StudyHub` in your Documents folder (where Windows really keeps Documents, also when it moved to another drive or OneDrive). It is created on first start.
- To move it: Settings › Library & model → Library → Change folder…, enter a full path; Back to the default location returns to the default.
- When the environment variable `STUDYHUB_LIBRARY` is set, that folder is used.
- Coming from BAXUIE's 0.4.8 package: your library is still where it was; enter that folder under Change folder….

StudyHub's own settings (the task board, audio transcription, update checks, the ZCode model configuration) live in the StudyHub home: `%USERPROFILE%\.dsh` when DSH is installed (shared with DSH), otherwise `%USERPROFILE%\.zcode\studyhub`, or `DSH_HOME` when it is set. The model configuration is `study\zcode.json` in that home.

### DSH and ZCode on the same library at once

That works. Every write to the library takes a file lock that holds between the two programs; once one has written, the other reads the new content next time, and neither overwrites the other. One thing to know: a background task runs only in the program that started it. The other program's Tasks page shows its record but cannot control it.

## What differs from the DSH plugin

| | DSH plugin | ZCode edition |
|---|---|---|
| Model | The models set up in DSH, optionally following the current chat | The address, model and key you fill in in the panel |
| Background tasks | Run by DSH | Run while ZCode is open; **quitting ZCode ends them**. Finished parts are kept; after reopening, select Continue in Tasks |
| Send to the main chat | Fills DSH's chat box | Copies to the clipboard (or shows the full text to copy) for you to paste into the ZCode chat |
| Upgrade | One click in the app | Download the new ZCode package and run `install.bat` again (the panel's upgrade window gives the address and the steps) |
| Choosing a folder | The system folder picker | Enter a full path |
| The chat opening a question (`panel.open`) | Yes | No; open it in the panel |

## Privacy

- The library, your review history and the ZCode model configuration stay on this computer. The API key is stored as plain text in `study\zcode.json` (like the audio transcription keys); it never goes into the library, a backup or a snapshot, and the panel only shows its last four characters.
- When making questions, explaining or grading, the selected material is sent to the endpoint you entered; reviewing calls no model. Audio transcription sends recordings to the transcription service you configured.
- Update checks read the version from GitHub's release page (no study data is sent); turn automatic checks off in Settings › About & updates.
- Outside links in the panel open in your system browser. Only a plain http(s) address is opened, and no command line interprets it.

## Upgrade and uninstall

- **Upgrade**: download the new `StudyHub-ZCode-<version>.zip` from the panel's upgrade window (or the release page), unblock and extract it (over the old folder is fine), double-click `install.bat`, then quit and reopen ZCode. Your library, model and settings stay.
- **Uninstall**: run these two lines in a command prompt (`install.bat` also prints them at the end, with ZCode's real path on your computer):
  ```
  node "E:\Program Files\ZCode\resources\glm\zcode.cjs" plugins uninstall studyhub --force
  node "E:\Program Files\ZCode\resources\glm\zcode.cjs" plugins marketplace remove studyhub-bundle
  ```
  The library and the StudyHub home are not deleted; remove those two folders yourself if you no longer need them.

## For maintainers

- The ZCode edition lives on the long-lived branch `zcode`, which merges `main` regularly to pick up every StudyHub change. ZCode-only code stays in `packages/studyhub-zcode/`, `ui/zcode.jsx` and `ui/zcode/`; shared files carry one-line hooks only (`ui/host-parts.js`).
- `npm run build:zcode` builds the panel (`packages/studyhub-zcode/dist/ui`, chunked, every resource within ZCode's 8 MiB); `node scripts/build-zcode.mjs --test` also writes a browser test page that `packages/studyhub-zcode/scripts/test-panel-server.mjs` serves, so a real browser runs the production panel.
- Releasing: after `main` releases, `zcode` merges that release commit, then `npm run release:zcode` and `npm run release:zcode:check`, and `StudyHub-ZCode-<version>.zip` plus `SHA256SUMS-ZCode-<version>.txt` are uploaded to the same GitHub release `v<version>`. The plugin's version is StudyHub's.
