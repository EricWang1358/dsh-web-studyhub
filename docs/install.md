# Install StudyHub and configure a model

English · [简体中文](install.zh-CN.md)

StudyHub is a plugin for DeepSeek Harness (DSH). Download the [English browser setup guide](https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.5.8/StudyHub-2.5.8-Setup.html), or follow the steps below.

## Already using DSH: install only the plugins

These steps work in your existing **desktop or web** DSH installation. Web users do not need a desktop client or a new configuration.

1. Open DSH’s **Plugins → Add plugin**.
2. Paste the complete package URL below. Confirm the name `@ericwang1358/dsh-daily-flashcard` and version **2.5.8** after installation.
3. Enable the workbench and desired components. If reloading is requested, finish or cancel background tasks first.
4. StudyHub opens by itself after enabling. Later, open **StudyHub** from DSH’s left sidebar; no session or chat message is needed first. On an empty library, **Load the sample and start the tour** shows every key feature in about three minutes without a model.

```text
https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.5.8/ericwang1358-dsh-daily-flashcard-2.5.8.tgz
```

**Updating.** DSH plugins do not update themselves, and restarting DSH alone keeps the installed version. From 2.1.2, StudyHub asks GitHub for a newer release (at most every 12 hours; switch it off in **Settings › About & updates**) and shows a chip in its sidebar. **Upgrade** downloads the release package, checks its SHA-256 against the release's `SHA256SUMS` file and installs it through DSH's plugin manager. On older versions, or a host without in-app installs, open **Plugins**, uninstall StudyHub, then **Add plugin** with the new release's package address. Either way, finish or cancel background tasks first and restart DSH afterwards: quit desktop DSH fully and reopen it, or restart your web service with its original profile. A browser refresh alone does not load new plugin code. Your library and settings are kept.

If GitHub URL installation is unavailable, download the `.tgz` from the [release page](https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v2.5.8) and supply its absolute path. The file must be on the **computer or server running DSH**. Your laptop’s download path is not a remote web server’s path; prefer the HTTPS URL above.

### Advanced installation and component switches

The complete package installs the workbench, runtime, materials, bank, learning, generation and audio. Use **DSH’s own plugin manager** to enable or disable individual components and to add standalone component packages later.

- Generation needs materials, bank and generation; practice, mistakes and exams need bank and learning. Unavailable capabilities hide their UI entries or show a disabled message.
- Enable bank and learning before deleting a material, so saved questions, drafts and learning records can be checked for citations.
- Finish related tasks before disabling a component. Saved sources, decks and progress remain; enabling the component restores access.
- If several installations provide the same capability, disable all providers to turn it off. An old complete workbench still provides all capabilities; update before customizing.

If managing an existing web profile by CLI, keep that profile name:

```sh
dsh plugin --profile web add <package-URL-or-absolute-path>
```

Replace `web` with your existing custom profile if applicable. Prefer the bundled plugin manager for desktop DSH.

## Install DSH

| Platform | Official route |
| --- | --- |
| Windows x64 | [Download the .exe installer](https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe), install and open DeepSeek Harness. |
| macOS Apple silicon | [Download the .dmg installer](https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg), copy DSH into Applications as prompted and open it. |
| Linux, or browser-only on any platform | Install Node.js **22.19 or later**, then start the official npm web version below. |

Desktop installers include their runtime. For Intel Macs or Windows ARM, check the [official DSH site](https://www.deepseek.com/en/harness/) for current support or use the web route.

```sh
npx @deepseek-ai/dsh web
```

Keep the process running. The default local address is `http://127.0.0.1:3080`. Install StudyHub through that web page’s plugin manager. Existing web users skip this first-time startup step. Linux uses the official npm route; this release does not supply an unverified Linux desktop installer.

## Configure a model provider

Question generation, explanations, proofreading and translation need a usable model provider. Installation, material browsing and review of existing decks do not. DSH manages models and credentials.

**For everyday use, start with the official DeepSeek API.** Create a key at the [DeepSeek platform](https://platform.deepseek.com/) and ensure the account can call models. Open **DSH Settings → Models**, save the key on the DeepSeek provider card, then choose a model in your session. Built-in DeepSeek configuration does not require a manually entered endpoint. For custom integration, use `https://api.deepseek.com` and supported model IDs from the [official API documentation](https://api-docs.deepseek.com/).

**For high usage, consider a compatible Coding Plan.** It must provide an API key and allow DSH and the intended study workload. Before purchasing, check supported tools and uses, dedicated base URL, model IDs, concurrency and quota resets. A key alone does not make a plan compatible with arbitrary applications. Some plans restrict tools or coding workloads; StudyHub does not promise that any particular plan permits learning, batch generation or audio proofreading.

Configure an eligible third-party provider under **Add model provider**. For custom endpoints, select **Custom model API** and supply the provider’s endpoint, protocol, key and model ID. Use a protocol the endpoint actually supports. A plan’s dedicated endpoint and its ordinary API may bill different quotas.

**Claude/Codex subscriptions are not providers in this setup.** DSH’s current model configuration does not accept Codex-style OAuth subscriptions. Claude Pro/Max and ChatGPT/Codex subscription allowances are not a general API key to paste into DSH. Separately paid Anthropic and OpenAI APIs can be configured as third-party providers; their billing is separate. See [Claude’s subscription/API billing explanation](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console) and [OpenAI’s separate API billing explanation](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform).

Save API keys only in DSH’s model settings, never in a setup guide, source material or deck. Original audio transcription separately needs a transcription provider in **Study Settings → Audio transcription** (SiliconFlow SenseVoice is free and reachable from mainland China; Gemini and Groq are also supported); the model provider handles subsequent proofreading, translation and learning help.

## Interface language and original content

The workbench chooses English for first-time browsers whose preferred language is not Chinese. Use its language switch to select English or Chinese; the saved choice takes priority. Changing the interface does not rewrite saved sources, questions, notes or filenames. Select the desired generation language or explicitly request question translation when needed.

Official routes and provider rules were checked on **2026-10-01**; their current official documentation governs future changes.
